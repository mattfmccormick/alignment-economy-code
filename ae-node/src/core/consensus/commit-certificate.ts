// Commit certificates — the cryptographic finality proof for a block.
//
// In Tendermint-style BFT, a block isn't truly committed until 2/3+ of the
// validator set has precommitted on its hash. A CommitCertificate bundles
// those precommit signatures so anyone — even a node that wasn't online
// during the voting round — can independently verify "yes, this block
// was finalized by the validator set we expect."
//
// Wire usage (Session 17+): every block ships a CommitCertificate proving
// the PREVIOUS block was finalized. That's what keeps chain history
// verifiable from any starting point: each block's certificate proves
// its parent is final, transitively all the way back to genesis.
//
// What this file gives you:
//
//   - CommitCertificate type
//   - buildCommitCertificate(voteSet) extracts the precommits that hit
//     quorum on a real (non-NIL) block
//   - verifyCommitCertificate(cert, validatorSet, opts) runs every
//     verification rule independently of the voting round that produced
//     the cert. This is the part a follower runs.
//
// Verification rules in order:
//   1. blockHash is non-empty (NIL doesn't get a cert)
//   2. precommits is non-empty
//   3. Every precommit has kind === 'precommit'
//   4. Every precommit's height/round/blockHash matches the cert's
//   5. Every precommit's signature verifies (cryptographically)
//   6. Every precommit's validatorAccountId is in the active set
//   7. Every precommit's validatorPublicKey matches the validator's
//      registered nodePublicKey (no impersonation)
//   8. No duplicate validators in the bundle (one vote per validator)
//   9. Distinct-validator count >= validatorSet.quorumCount()
//
// Failure on any rule returns { valid: false, error: '...' } so callers
// can log the specific reason instead of guessing.

import type { Vote } from './votes.js';
import { verifyVote } from './votes.js';
import type { IValidatorSet } from './IValidatorSet.js';
import { VoteSet } from './vote-aggregator.js';
import { sha256 } from '../crypto.js';

export interface CommitCertificate {
  height: number;
  round: number;
  blockHash: string;
  /** Precommit votes from distinct validators that together meet quorum. */
  precommits: Vote[];
}

export interface VerifyCertOpts {
  /** Replay window passed to verifyVote on each precommit. Default 600s. */
  replayWindowSec?: number;
  /** Override "now" for deterministic tests. */
  nowSec?: number;
  /**
   * Skip the per-vote replay window check. Useful when verifying
   * certificates attached to historical blocks during catch-up sync —
   * those votes are necessarily older than the window.
   */
  skipTimestampWindow?: boolean;
}

export interface CertVerifyResult {
  valid: boolean;
  error?: string;
  /** Distinct validators counted toward quorum (only when valid). */
  signers?: string[];
}

/**
 * Construct a CommitCertificate from a VoteSet that has reached quorum on
 * a real block. Returns null if the VoteSet is the wrong kind, has no
 * committed block (only NIL or no quorum), or otherwise can't be turned
 * into a cert.
 */
export function buildCommitCertificate(voteSet: VoteSet): CommitCertificate | null {
  if (voteSet.kind !== 'precommit') return null;
  const blockHash = voteSet.committedBlockHash();
  if (blockHash === null) return null;

  // Pull only the precommits that voted for the committed hash. Non-
  // matching votes (NIL, or precommits on a different hash) don't go in.
  const matching = voteSet.allVotes().filter((v) => v.blockHash === blockHash);
  if (matching.length === 0) return null;

  return {
    height: voteSet.height,
    round: voteSet.round,
    blockHash,
    precommits: matching,
  };
}

/**
 * Deterministic hash of a CommitCertificate.
 *
 * Used by computeBlockHash (via the parent block's prevCommitCertHash field)
 * to fold the cert into chain history. Once promoted, an attacker cannot
 * swap the cert on a stored block without invalidating every descendant
 * block's hash.
 *
 * Determinism rules:
 *   - Precommits are sorted by validatorAccountId before encoding, since
 *     different observers may receive votes in different orders.
 *   - Each precommit contributes "validatorAccountId:signature" to the
 *     payload. height/round/blockHash are not included per-vote because
 *     they're already pinned by the cert's own fields (and verified at
 *     ingestion).
 *   - Pipe-separated, single-line, ASCII-only — survives JSON round-trips.
 *
 * The output is a 64-char hex SHA-256 digest, same shape as a block hash.
 */
export function computeCertHash(cert: CommitCertificate): string {
  const sorted = [...cert.precommits].sort((a, b) =>
    a.validatorAccountId < b.validatorAccountId
      ? -1
      : a.validatorAccountId > b.validatorAccountId
        ? 1
        : 0,
  );
  const voteString = sorted
    .map((v) => `${v.validatorAccountId}:${v.signature}`)
    .join('|');
  return sha256(`${cert.height}|${cert.round}|${cert.blockHash}|${voteString}`);
}

/**
 * Verify a CommitCertificate against a validator set. Each precommit is
 * checked independently; an invalid one is enough to fail the whole cert.
 */
export function verifyCommitCertificate(
  cert: CommitCertificate,
  validatorSet: IValidatorSet,
  opts: VerifyCertOpts = {},
): CertVerifyResult {
  // Shape checks
  if (!cert || typeof cert !== 'object') {
    return { valid: false, error: 'cert is not an object' };
  }
  if (typeof cert.blockHash !== 'string' || cert.blockHash.length === 0) {
    return { valid: false, error: 'cert blockHash must be a non-empty string' };
  }
  if (typeof cert.height !== 'number' || cert.height < 0) {
    return { valid: false, error: 'cert height must be a non-negative number' };
  }
  if (typeof cert.round !== 'number' || cert.round < 0) {
    return { valid: false, error: 'cert round must be a non-negative number' };
  }
  if (!Array.isArray(cert.precommits) || cert.precommits.length === 0) {
    return { valid: false, error: 'cert precommits must be a non-empty array' };
  }

  const seenValidators = new Set<string>();
  const replayWindowSec = opts.replayWindowSec ?? 600;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  for (const v of cert.precommits) {
    if (v.kind !== 'precommit') {
      return { valid: false, error: `vote kind ${v.kind} is not 'precommit'` };
    }
    if (v.height !== cert.height) {
      return {
        valid: false,
        error: `vote height ${v.height} != cert height ${cert.height}`,
      };
    }
    if (v.round !== cert.round) {
      return {
        valid: false,
        error: `vote round ${v.round} != cert round ${cert.round}`,
      };
    }
    if (v.blockHash !== cert.blockHash) {
      return {
        valid: false,
        error: `vote blockHash mismatch (precommit on different block or NIL)`,
      };
    }

    // Validator membership + key binding
    const validator = validatorSet.findByAccountId(v.validatorAccountId);
    if (!validator) {
      return {
        valid: false,
        error: `validator ${v.validatorAccountId} is not in the active set`,
      };
    }
    if (!validator.isActive) {
      return {
        valid: false,
        error: `validator ${v.validatorAccountId} is inactive`,
      };
    }
    if (validator.nodePublicKey !== v.validatorPublicKey) {
      return {
        valid: false,
        error: `vote publicKey does not match registered nodePublicKey for ${v.validatorAccountId}`,
      };
    }

    // Cryptographic signature check
    const sigOpts: Parameters<typeof verifyVote>[1] = opts.skipTimestampWindow
      ? // Pass a window of effectively-infinity by setting nowSec = vote.timestamp
        { replayWindowSec: 0, nowSec: v.timestamp, expectedPublicKey: validator.nodePublicKey }
      : { replayWindowSec, nowSec, expectedPublicKey: validator.nodePublicKey };
    if (!verifyVote(v, sigOpts)) {
      return { valid: false, error: `precommit signature/replay check failed for ${v.validatorAccountId}` };
    }

    // No duplicate validators
    if (seenValidators.has(v.validatorAccountId)) {
      return {
        valid: false,
        error: `duplicate precommit from validator ${v.validatorAccountId}`,
      };
    }
    seenValidators.add(v.validatorAccountId);
  }

  // Quorum
  const quorum = validatorSet.quorumCount();
  if (seenValidators.size < quorum) {
    return {
      valid: false,
      error: `cert has ${seenValidators.size} signatures, quorum is ${quorum}`,
    };
  }

  return { valid: true, signers: Array.from(seenValidators).sort() };
}
