// Independent block validation for incoming gossip + sync.
//
// Followers must NOT trust whatever block bytes a peer sends them. They
// re-derive everything that's derivable and only accept blocks that pass:
//
//   1. Producer authentication
//      - Transport envelope's senderId AND publicKey must match what the
//        consensus engine considers a valid block producer. (For Phase-1
//        AuthorityConsensus that's the configured authority. For Phase-3
//        BFT, that's any current validator.)
//   2. Height contiguity
//      - block.number must equal localPrev.number + 1. We don't accept
//        gaps (sync handles missing-history fill); we don't accept rewrites
//        of history (consensus.resolveConflict gates fork choice).
//   3. PrevHash chain
//      - block.previousHash must equal our local latest block's hash.
//   4. Hash integrity
//      - block.hash must equal computeBlockHash(...) over the claimed fields.
//        This catches tampering with any of (number, previousHash, timestamp,
//        merkleRoot, day) after the producer set the hash.
//   5. Merkle integrity
//      - The transport payload carries the txIds the producer claims went
//        into the block. computeMerkleRoot(txIds) must equal block.merkleRoot.
//        This catches "I claim merkleRoot X but the txIds I'm shipping
//        actually hash to Y." It is the difference between "trust the
//        merkleRoot field" and "verify the merkleRoot field."
//   6. Transaction count consistency
//      - block.transactionCount must equal txIds.length.
//
// Note on what this does NOT do:
//
//   - It does NOT replay each transaction. Re-executing transactions to
//     verify the post-block state is the job of full state sync, which is
//     a later session. This validator stops at "is the block structurally
//     and authoritatively well-formed?"
//   - It does NOT enforce a per-block producer signature separate from the
//     transport envelope signature. The transport envelope (Session 8) is
//     already authenticated end-to-end with the producer's Ed25519 key, so
//     in the single-authority Phase-1 model that's sufficient. In Phase-3
//     BFT we'll need detached block signatures + quorum precommits — but
//     that's a different consensus engine and a different validator path.

import { DatabaseSync } from 'node:sqlite';
import type { Block } from '../core/types.js';
import { getLatestBlock, computeBlockHash, computeMerkleRoot } from '../core/block.js';
import type { IConsensusEngine } from '../core/consensus/IConsensusEngine.js';
import type { IValidatorSet, ValidatorInfo } from '../core/consensus/IValidatorSet.js';
import { SnapshotValidatorSet } from '../core/consensus/SnapshotValidatorSet.js';
import {
  verifyCommitCertificate,
  computeCertHash,
  type CommitCertificate,
} from '../core/consensus/commit-certificate.js';
import {
  verifyValidatorChange,
  computeValidatorChangesHash,
  type ValidatorChange,
} from '../core/consensus/validator-change.js';
import { accountStore } from '../core/account.js';

/**
 * Wire shape of a single transaction inside a block payload. bigint fields
 * arrive as strings so JSON can carry them; the replay path parses them
 * back to bigint before applying.
 */
export interface WireTransaction {
  id: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  netAmount: string;
  pointType: 'active' | 'supportive' | 'ambient' | 'earned';
  isInPerson: boolean;
  /**
   * Receiver's countersignature (hex). Required (non-null) on isInPerson
   * transactions so a follower can re-verify dual consent before applying
   * the tx — without it the protocol rejects in-person attestations as
   * forgeable. Null on regular non-in-person txs.
   */
  receiverSignature: string | null;
  memo: string;
  signature: string;
  timestamp: number;
}

export interface IncomingBlockPayload {
  /** Serialized block. Same shape as core Block; bigint fields arrive as strings. */
  number: number;
  day: number;
  timestamp: number;
  previousHash: string;
  hash: string;
  merkleRoot: string;
  transactionCount: number;
  rebaseEvent: unknown;
  /**
   * The transaction IDs the producer claims are committed by this block.
   * Used to re-derive merkleRoot. Optional only for back-compat with legacy
   * tests that broadcast bare blocks; production gossip MUST include them.
   */
  txIds?: string[];
  /**
   * Full transaction data needed for follower replay. When present, every
   * id in `txIds` must have exactly one matching entry here, and vice versa.
   * Optional during back-compat / pure-header tests; production gossip and
   * sync replies MUST include this.
   */
  transactions?: WireTransaction[];
  /**
   * BFT commit certificate proving this block's PARENT (block N-1) was
   * committed by 2/3+ of the validator set. Required for blocks N >= 2
   * under BFT consensus; omitted under AuthorityConsensus and for block 1
   * (whose parent is genesis). validateIncomingBlock cross-checks:
   *   - cert.height === block.number - 1
   *   - cert.blockHash === block.previousHash
   *   - verifyCommitCertificate succeeds against the supplied validator set
   */
  parentCertificate?: CommitCertificate;
  /**
   * Snapshot of the validator set as it was at block N-1 (when the
   * parentCertificate was signed). When present, validateIncomingBlock
   * verifies the parentCertificate against THIS snapshot rather than the
   * current bftValidatorSet — necessary once validators get slashed
   * or deregister, since the cert was signed by validators who may no
   * longer be active. When absent, falls back to bftValidatorSet (the
   * less-safe path; works only if the validator set hasn't changed
   * since the cert was signed).
   */
  parentValidatorSnapshot?: ValidatorInfo[];
  /**
   * Hash of the parent block's commit certificate (computeCertHash).
   * Folded into this block's canonical hash. Required for BFT blocks
   * N >= 2 with a parentCertificate; null/omitted for block 1, genesis,
   * and AuthorityConsensus blocks. validateIncomingBlock cross-checks
   * computeCertHash(parentCertificate) against this field, so a tampered
   * cert can't ride alongside a valid block.
   */
  prevCommitCertHash?: string | null;
  /**
   * Validator-set changes carried by this block (Session 48). Each
   * change is signed by the affected account's ML-DSA key. Validation
   * verifies signatures + that each named account exists locally;
   * application happens in BftBlockProducer.onCommit after transaction
   * replay, deterministically using `now = block.timestamp`.
   *
   * Empty array OR omitted means the block carries no changes — same
   * effect either way.
   */
  validatorChanges?: ValidatorChange[];
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Default timestamp drift window. Blocks whose timestamp is more than
 * this many seconds away from the validator's local clock are rejected.
 *
 * Why this exists (Session 44): Session 40 promoted the day cycle to a
 * deterministic chain event keyed off block.timestamp. A malicious or
 * clock-broken proposer could otherwise stamp a block with timestamp =
 * year 2099, and the cycle loop would advance every honest validator's
 * cycle state thousands of days forward in a single onCommit. The
 * 1000-iteration safety bound (also Session 40) caps the damage but
 * doesn't prevent it. Rejecting out-of-window blocks at validation
 * time closes the surface.
 *
 * 300s = 5 minutes. Generous enough that ordinary clock skew between
 * laptops doesn't cause false rejections, tight enough that a
 * compromised proposer can't shift the chain meaningfully.
 */
export const DEFAULT_MAX_TIMESTAMP_DRIFT_SEC = 300;

/**
 * Pure check: is `blockTimestampSec` within `maxDriftSec` of `nowSec`?
 *
 * Returns `{valid: true}` when the absolute difference is within the
 * window, otherwise `{valid: false, error: '<message>'}` with a
 * specific reason (too far in the past or future). Used by
 * validateIncomingBlock and BftBlockProducer's live-gossip path.
 */
export function validateBlockTimestamp(
  blockTimestampSec: number,
  nowSec: number,
  maxDriftSec: number = DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
): ValidationResult {
  if (typeof blockTimestampSec !== 'number' || !Number.isFinite(blockTimestampSec)) {
    return { valid: false, error: 'block timestamp must be a finite number' };
  }
  const drift = blockTimestampSec - nowSec;
  if (drift > maxDriftSec) {
    return {
      valid: false,
      error: `block timestamp ${blockTimestampSec} is ${drift}s in the future, exceeds drift window ${maxDriftSec}s`,
    };
  }
  if (drift < -maxDriftSec) {
    return {
      valid: false,
      error: `block timestamp ${blockTimestampSec} is ${-drift}s in the past, exceeds drift window ${maxDriftSec}s`,
    };
  }
  return { valid: true };
}

/**
 * Validate a block received over the wire. Returns {valid, error} so callers
 * can log + ban without throwing through the network handler.
 */
export function validateIncomingBlock(
  db: DatabaseSync,
  consensus: IConsensusEngine,
  payload: IncomingBlockPayload,
  senderId: string,
  senderPublicKey: string,
  opts: {
    allowMissingTxIds?: boolean;
    allowMissingTransactions?: boolean;
    /**
     * BFT validator set used to verify payload.parentCertificate. When
     * omitted, the cert check is skipped — that's the AuthorityConsensus
     * path (no certs in Phase 1). When provided, every block N >= 2 MUST
     * carry a valid parentCertificate or it's rejected.
     */
    bftValidatorSet?: IValidatorSet;
    /** Forwarded to verifyCommitCertificate. */
    skipCertTimestampWindow?: boolean;
    /**
     * Override the drift window. Default is DEFAULT_MAX_TIMESTAMP_DRIFT_SEC
     * (300s / 5 min). Tests pin this; production callers leave it default.
     */
    maxTimestampDriftSec?: number;
    /**
     * Skip the block-timestamp drift check. Required for catch-up sync,
     * since historical blocks legitimately have old timestamps. Live
     * gossip MUST leave this false to enforce the bound.
     */
    skipBlockTimestampWindow?: boolean;
    /** Override "now" for deterministic tests. */
    nowSec?: number;
  } = {},
): ValidationResult {
  // 1. Producer authentication
  if (!consensus.validateBlockProducer(senderId, senderPublicKey)) {
    return {
      valid: false,
      error: `Block producer ${senderId} (${senderPublicKey.slice(0, 16)}…) is not an accepted block producer`,
    };
  }

  // 2. Height contiguity
  const prev = getLatestBlock(db);
  if (!prev) {
    return { valid: false, error: 'No local genesis block — cannot validate against empty chain' };
  }
  if (typeof payload.number !== 'number') {
    return { valid: false, error: 'Block number missing or not a number' };
  }
  if (payload.number !== prev.number + 1) {
    return {
      valid: false,
      error: `Height gap: expected ${prev.number + 1}, got ${payload.number}`,
    };
  }

  // 3. PrevHash chain
  if (payload.previousHash !== prev.hash) {
    return {
      valid: false,
      error: `Previous hash mismatch: local=${prev.hash.slice(0, 12)}, payload=${(payload.previousHash ?? '').slice(0, 12)}`,
    };
  }

  // 3b. Timestamp drift (Session 44). Reject blocks whose timestamp is
  //     more than `maxTimestampDriftSec` (default 300s) away from the
  //     local clock. Closes the year-2099 attack surface opened by the
  //     chain-driven day cycle (Session 40): a malicious proposer could
  //     otherwise stamp a block far in the future and force the cycle
  //     loop to advance honest validators' state by thousands of days
  //     in a single onCommit. Catch-up sync MUST pass
  //     skipBlockTimestampWindow because historical blocks legitimately
  //     have old timestamps.
  if (!opts.skipBlockTimestampWindow) {
    if (typeof payload.timestamp !== 'number') {
      return { valid: false, error: 'Block timestamp missing or not a number' };
    }
    const tsCheck = validateBlockTimestamp(
      payload.timestamp,
      opts.nowSec ?? Math.floor(Date.now() / 1000),
      opts.maxTimestampDriftSec ?? DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
    );
    if (!tsCheck.valid) {
      return tsCheck;
    }
  }

  // 4. Hash integrity. prevCommitCertHash (Session 39, cert-in-block-hash
  // promotion) folds the parent commit cert into the block hash. For
  // back-compat with Authority/legacy blocks the field is treated as null
  // when missing — empty-string concatenation produces the same hash as
  // the legacy form. Cert/hash cross-check happens in step 8 below.
  //
  // validatorChangesHash (Session 52) folds THIS block's validator
  // changes into the hash. We re-derive it from payload.validatorChanges
  // so the producer can't lie about which changes were committed —
  // any swap, drop, or reorder breaks the hash and rejects the block.
  const claimedCertHash = payload.prevCommitCertHash ?? null;
  const validatorChangesHash =
    payload.validatorChanges && payload.validatorChanges.length > 0
      ? computeValidatorChangesHash(payload.validatorChanges)
      : null;
  const expectedHash = computeBlockHash(
    payload.number,
    payload.previousHash,
    payload.timestamp,
    payload.merkleRoot,
    payload.day,
    claimedCertHash,
    validatorChangesHash,
  );
  if (payload.hash !== expectedHash) {
    return {
      valid: false,
      error: `Block hash mismatch: expected ${expectedHash.slice(0, 12)}, got ${(payload.hash ?? '').slice(0, 12)}`,
    };
  }

  // 5 & 6. Merkle integrity + transaction count consistency
  if (payload.txIds === undefined) {
    if (!opts.allowMissingTxIds) {
      return { valid: false, error: 'Block payload missing txIds (cannot verify merkleRoot)' };
    }
    // back-compat path: trust merkleRoot since we can't re-derive
  } else {
    if (!Array.isArray(payload.txIds)) {
      return { valid: false, error: 'Block payload txIds is not an array' };
    }
    if (payload.txIds.length !== payload.transactionCount) {
      return {
        valid: false,
        error: `Transaction count mismatch: txIds.length=${payload.txIds.length}, transactionCount=${payload.transactionCount}`,
      };
    }
    const expectedMerkle = computeMerkleRoot(payload.txIds);
    if (expectedMerkle !== payload.merkleRoot) {
      return {
        valid: false,
        error: `Merkle root mismatch: expected ${expectedMerkle.slice(0, 12)}, got ${payload.merkleRoot.slice(0, 12)}`,
      };
    }
  }

  // 7. Transaction-data consistency. When the payload ships full transactions
  //    for replay, every id in txIds must have exactly one matching entry.
  //    A producer claiming "block contains tx X" but shipping different tx
  //    bodies is rejected.
  if (payload.transactions === undefined) {
    if (!opts.allowMissingTransactions && payload.transactionCount > 0) {
      return {
        valid: false,
        error: 'Block payload missing transactions (cannot replay state)',
      };
    }
  } else {
    if (!Array.isArray(payload.transactions)) {
      return { valid: false, error: 'Block payload transactions is not an array' };
    }
    if (payload.transactions.length !== payload.transactionCount) {
      return {
        valid: false,
        error: `transactions.length=${payload.transactions.length} != transactionCount=${payload.transactionCount}`,
      };
    }
    if (payload.txIds !== undefined) {
      const txIdSet = new Set(payload.txIds);
      const dataIdSet = new Set<string>();
      for (const t of payload.transactions) {
        if (typeof t?.id !== 'string') {
          return { valid: false, error: 'transaction entry missing id' };
        }
        if (dataIdSet.has(t.id)) {
          return { valid: false, error: `duplicate transaction id ${t.id} in payload` };
        }
        dataIdSet.add(t.id);
        if (!txIdSet.has(t.id)) {
          return {
            valid: false,
            error: `transaction id ${t.id} not in txIds list`,
          };
        }
      }
      for (const id of txIdSet) {
        if (!dataIdSet.has(id)) {
          return { valid: false, error: `txId ${id} has no transaction data` };
        }
      }
    }
  }

  // 8. BFT commit-certificate verification (Session 22).
  //    Skipped entirely when bftValidatorSet is not supplied — that's the
  //    AuthorityConsensus path. Skipped for block 1, whose parent is
  //    genesis (which doesn't have a BFT cert because it predates the
  //    validator set). Required for every later block.
  if (opts.bftValidatorSet) {
    if (payload.number === 1) {
      // Block 1 chains to genesis; no parent cert required. If a cert is
      // present we silently ignore it.
    } else if (payload.parentCertificate === undefined) {
      return {
        valid: false,
        error: `Block ${payload.number} missing parentCertificate (BFT consensus requires proof that block ${payload.number - 1} was committed)`,
      };
    } else {
      const cert = payload.parentCertificate;
      if (cert.height !== payload.number - 1) {
        return {
          valid: false,
          error: `parentCertificate.height ${cert.height} != block.number - 1 (${payload.number - 1})`,
        };
      }
      if (cert.blockHash !== payload.previousHash) {
        return {
          valid: false,
          error: `parentCertificate.blockHash does not match block.previousHash`,
        };
      }
      // Cert-in-block-hash promotion: the cert hash committed in the
      // block header must match the actual parentCertificate. This is
      // the cryptographic seal — once verified, a tampered cert can't
      // ride alongside a valid block, because the block hash already
      // committed to the unmodified cert at production time.
      const actualCertHash = computeCertHash(cert);
      const claimedCertHash = payload.prevCommitCertHash ?? null;
      if (claimedCertHash === null) {
        return {
          valid: false,
          error: `Block ${payload.number} has parentCertificate but no prevCommitCertHash committed in the header`,
        };
      }
      if (claimedCertHash !== actualCertHash) {
        return {
          valid: false,
          error: `prevCommitCertHash mismatch: header committed ${claimedCertHash.slice(0, 12)}…, parentCertificate hashes to ${actualCertHash.slice(0, 12)}…`,
        };
      }
      // Prefer the per-height snapshot when it's shipped with the
      // payload — it represents the validator set that signed the cert,
      // which may differ from the current set after slashing or
      // deregistration. Fall back to the live bftValidatorSet only
      // when no snapshot is available.
      const certVerifierSet =
        payload.parentValidatorSnapshot && payload.parentValidatorSnapshot.length > 0
          ? new SnapshotValidatorSet(
              payload.parentValidatorSnapshot.map((v) => ({
                ...v,
                stake: typeof v.stake === 'string' ? BigInt(v.stake) : v.stake,
              })),
            )
          : opts.bftValidatorSet;
      const certResult = verifyCommitCertificate(cert, certVerifierSet, {
        skipTimestampWindow: opts.skipCertTimestampWindow,
      });
      if (!certResult.valid) {
        return {
          valid: false,
          error: `parentCertificate verification failed: ${certResult.error}`,
        };
      }
    }
  }

  // 9. Validator-change signatures (Session 48). Each change in the
  //    payload is signed by the affected account's ML-DSA key. Verify
  //    every signature here so the apply step in onCommit can trust
  //    the changes wholesale. Skipped when validatorChanges is empty
  //    or absent. We deliberately do NOT check protocol-level
  //    preconditions like "is this account already a validator" —
  //    those are the apply step's concern (it'll throw, and the
  //    block won't apply locally).
  if (payload.validatorChanges && payload.validatorChanges.length > 0) {
    if (!Array.isArray(payload.validatorChanges)) {
      return { valid: false, error: 'validatorChanges must be an array' };
    }
    const aStore = accountStore(db);
    for (let i = 0; i < payload.validatorChanges.length; i++) {
      const change = payload.validatorChanges[i];
      if (typeof change?.accountId !== 'string') {
        return { valid: false, error: `validatorChanges[${i}] missing accountId` };
      }
      const account = aStore.findById(change.accountId);
      if (!account) {
        return {
          valid: false,
          error: `validatorChanges[${i}].accountId ${change.accountId} not found locally`,
        };
      }
      if (!verifyValidatorChange(change, account.publicKey)) {
        return {
          valid: false,
          error: `validatorChanges[${i}] signature does not verify against ${change.accountId}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Convert a validated IncomingBlockPayload into a core Block ready to insert.
 * Drops the txIds field (it's not part of the persisted block) and parses the
 * rebaseEvent if present.
 */
export function payloadToBlock(payload: IncomingBlockPayload): Block {
  return {
    number: payload.number,
    day: payload.day,
    timestamp: payload.timestamp,
    previousHash: payload.previousHash,
    hash: payload.hash,
    merkleRoot: payload.merkleRoot,
    transactionCount: payload.transactionCount,
    rebaseEvent: payload.rebaseEvent as Block['rebaseEvent'],
    prevCommitCertHash: payload.prevCommitCertHash ?? null,
    // Session 51: persist validatorChanges so sync replies can ship
    // them. Empty array (no changes this block) is normalized to null
    // for storage efficiency and parity with other "absent" fields.
    validatorChanges:
      payload.validatorChanges && payload.validatorChanges.length > 0
        ? payload.validatorChanges
        : null,
  };
}
