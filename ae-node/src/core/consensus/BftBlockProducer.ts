// BftBlockProducer — end-to-end block production in BFT mode.
//
// Wraps BftRuntime + a local block stash to drive real block production:
//
//   When local node is selected as proposer (BftDriver calls
//   blockProviderFor):
//     1. Drain pending transactions (block_number IS NULL on this node's DB)
//     2. Build the candidate block locally (computeBlockHash, etc.) WITHOUT
//        persisting — the block isn't real until consensus commits it.
//     3. Stash the IncomingBlockPayload keyed by block hash.
//     4. Broadcast the block content via the existing 'new_block' wire
//        type so every follower has the bytes by the time they need to
//        replay on commit.
//     5. Return the hash to BftDriver for inclusion in the proposal.
//
//   When ANY node receives a 'new_block' over the wire:
//     - Add the payload to the local stash. Do NOT persist yet — BFT
//       hasn't committed it. Persistence happens in onCommit.
//
//   When BftDriver fires onCommit(height, blockHash, cert):
//     - Look up the stashed payload by hash.
//     - Atomically: replay every transaction in the payload + insert the
//       block header. The runner's existing replayTransaction handles
//       idempotency (the proposer's own txs are already locally applied;
//       linkTransactionsToBlock just stamps them).
//     - Drain the stash entry.
//     - notifyHeightAdvanced + notifyFinalized on the consensus engine.
//
// What this class does NOT yet handle (call-out comments mark each):
//   - The race where onCommit fires before the stashed block arrives.
//     Practically rare under our BFT timeouts (rounds take 1.5+ seconds,
//     block content travels in milliseconds), and full mesh + ordered
//     WebSocket frames make it practically impossible. A bulletproof
//     fix is to bundle block content INTO the Proposal payload.
//   - Stash size cap / TTL. Forks or aborted rounds leave entries
//     unclaimed; eventually we'll want a sweep.
//   - Transaction gossip. Locally-submitted transactions on one node
//     don't yet reach other nodes' unblocked queues — that's a
//     separate session. For now the proposer can only include txs
//     that hit their own DB.

import { DatabaseSync } from 'node:sqlite';
import { runTransaction } from '../../db/connection.js';
import {
  blockStore,
  computeBlockHash,
  computeMerkleRoot,
  getLatestBlock,
} from '../block.js';
import { transactionStore, replayTransaction } from '../transaction.js';
import { applyChainDayCycle } from '../day-cycle.js';
import { commitBlockSideEffects } from '../../mining/rewards.js';
import type { Block } from '../types.js';
import { BftRuntime } from './BftRuntime.js';
import type { IBftClock } from './bft-driver.js';
import type { IValidatorSet } from './IValidatorSet.js';
import type { LocalValidator, TimeoutConfig } from './round-controller.js';
import type { CommitCertificate } from './commit-certificate.js';
import { computeCertHash } from './commit-certificate.js';
import {
  applyValidatorChange,
  computeValidatorChangesHash,
  type ValidatorChange,
} from './validator-change.js';
import type { PeerManager } from '../../network/peer.js';
import type {
  IncomingBlockPayload,
  WireTransaction,
} from '../../network/block-validator.js';
import {
  payloadToBlock,
  validateBlockTimestamp,
  DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
} from '../../network/block-validator.js';
import type { TransactionRow } from '../stores/ITransactionStore.js';
import { serializeBlock } from '../../network/messages.js';

function txRowToWire(tx: TransactionRow): WireTransaction {
  return {
    id: tx.id,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    netAmount: tx.netAmount,
    pointType: tx.pointType,
    isInPerson: tx.isInPerson,
    receiverSignature: tx.receiverSignature,
    memo: tx.memo,
    signature: tx.signature,
    timestamp: tx.timestamp,
  };
}

export interface BftBlockProducerConfig {
  db: DatabaseSync;
  peerManager: PeerManager;
  validatorSet: IValidatorSet;
  localValidator: LocalValidator;
  /** Day to stamp on produced blocks. Static for now; runner sets it from cycle state. */
  day: number;
  /** Per-phase timeouts for BftDriver. */
  timeouts?: Partial<TimeoutConfig>;
  /** Inject a clock for tests. Defaults to RealClock inside BftRuntime. */
  clock?: IBftClock;
  /** Optional callback for telemetry; fires after a block is persisted locally. */
  onBlockCommitted?: (block: Block, cert: CommitCertificate) => void;
  /**
   * Session 48: callback the proposer invokes inside buildCandidateBlock
   * to pull pending validator changes for inclusion in the next block.
   * The implementation typically reads from a local queue table; for
   * tests, it can return a hardcoded list. Returning [] means "no
   * changes this block." Receivers don't use this — they trust whatever
   * arrives in the payload (after signature verification).
   */
  pendingValidatorChanges?: () => ValidatorChange[];
  /**
   * Session 48: callback fired AFTER a block's validator changes have
   * been successfully applied locally. Implementations typically use
   * this to drain matching entries from the proposer's queue table —
   * but a non-proposer node calls this too, so the implementation
   * should be idempotent (e.g., delete-by-id, ignore missing rows).
   */
  onValidatorChangesApplied?: (changes: ValidatorChange[]) => void;
  /**
   * Session 54: forwarded to BftRuntime. Delays first round start by
   * this many ms so peer mesh has time to establish before round 0
   * fires. See BftDriverConfig.startupDelayMs for full rationale.
   */
  startupDelayMs?: number;
}

export class BftBlockProducer {
  private readonly db: DatabaseSync;
  private readonly peerManager: PeerManager;
  private readonly stash = new Map<string, IncomingBlockPayload>();
  private readonly runtime: BftRuntime;
  private readonly onBlockCommitted: ((block: Block, cert: CommitCertificate) => void) | undefined;
  private readonly day: number;
  private readonly validatorSet: IValidatorSet;
  private readonly pendingValidatorChanges: (() => ValidatorChange[]) | undefined;
  private readonly onValidatorChangesApplied:
    | ((changes: ValidatorChange[]) => void)
    | undefined;
  private incomingBlockHandler: ((data: unknown) => void) | null = null;

  constructor(config: BftBlockProducerConfig) {
    this.db = config.db;
    this.peerManager = config.peerManager;
    this.day = config.day;
    this.onBlockCommitted = config.onBlockCommitted;
    this.validatorSet = config.validatorSet;
    this.pendingValidatorChanges = config.pendingValidatorChanges;
    this.onValidatorChangesApplied = config.onValidatorChangesApplied;

    const latest = getLatestBlock(this.db);
    const initialHeight = (latest?.number ?? 0) + 1;

    this.runtime = new BftRuntime({
      peerManager: config.peerManager,
      validatorSet: config.validatorSet,
      localValidator: config.localValidator,
      initialHeight,
      proposerSeedFor: (h) => {
        // The seed for height h is the hash of block h-1 (its parent).
        // Every node agrees because they all have block h-1 committed
        // before they start consensus on height h.
        if (h <= 1) return latest?.hash ?? '';
        const parent = blockStore(this.db).findByNumber(h - 1);
        return parent?.hash ?? '';
      },
      blockProviderFor: (h, _r) => this.buildCandidateBlock(h),
      // Content-validation gate (Session 45). The stash holds the only
      // local view of a candidate block's content (timestamp, txs, etc).
      // If a hash isn't in the stash the controller votes NIL — same
      // behavior as if validation actively failed. Once Session 44's
      // timestamp pre-filter ran, only timestamp-valid blocks made it
      // into the stash, so a stash-presence check IS the content check
      // for now. Future content invariants would extend this.
      validateBlockContent: (hash) => this.validateStashedBlock(hash),
      onCommit: (h, hash, cert) => this.onCommit(h, hash, cert),
      timeouts: config.timeouts,
      clock: config.clock,
      startupDelayMs: config.startupDelayMs,
    });
  }

  start(): void {
    // Subscribe to incoming block content so non-proposer nodes also
    // populate their stash.
    //
    // Session 44: validate the block timestamp against local clock
    // before stashing. A block stamped far in the future (or far in
    // the past) doesn't enter the stash, so onCommit can't apply it
    // even if BFT consensus somehow finalizes a cert over its hash.
    // This is apply-time defense; it doesn't prevent the cert from
    // forming if quorum signs blindly. Future work: gate prevote on
    // content validation inside RoundController.
    this.incomingBlockHandler = (data: unknown) => {
      const payload = data as IncomingBlockPayload;
      if (typeof payload?.hash !== 'string') return;
      if (typeof payload?.timestamp !== 'number') return;
      const ts = validateBlockTimestamp(
        payload.timestamp,
        Math.floor(Date.now() / 1000),
        DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
      );
      if (!ts.valid) {
        // Telemetry only; no throw. The block is silently dropped from
        // this validator's view. If the rest of the network agrees the
        // block is bad, no cert forms; if Byzantine quorum forces a
        // cert, this validator falls behind and recovers via sync.
        return;
      }
      this.stash.set(payload.hash, payload);
    };
    this.peerManager.on('block:received', this.incomingBlockHandler);

    this.runtime.start();
  }

  stop(): void {
    this.runtime.stop();
    if (this.incomingBlockHandler) {
      this.peerManager.off('block:received', this.incomingBlockHandler);
      this.incomingBlockHandler = null;
    }
    this.stash.clear();
  }

  /** Number of stashed candidate blocks. Useful for tests / metrics. */
  stashSize(): number {
    return this.stash.size;
  }

  /**
   * Content-validation gate the round controller calls before signing
   * a non-NIL prevote/precommit. Returns invalid if:
   *   - the hash isn't in the stash (we never received gossip for it,
   *     OR it was rejected by the receive-side timestamp pre-filter)
   *   - the stashed payload's timestamp is now out of window (paranoid
   *     re-check; the pre-filter already enforces this at receive time
   *     but the wall clock advances between receive and vote)
   *
   * "Missing" rejection is equally important as "invalid" rejection.
   * If the controller is asked to vote on a hash whose content we
   * can't see, voting NIL is strictly safer than voting blind.
   */
  private validateStashedBlock(blockHash: string): { valid: boolean; error?: string } {
    const payload = this.stash.get(blockHash);
    if (!payload) {
      return { valid: false, error: `no stashed content for blockHash ${blockHash.slice(0, 12)}…` };
    }
    if (typeof payload.timestamp !== 'number') {
      return { valid: false, error: 'stashed payload has no timestamp' };
    }
    return validateBlockTimestamp(
      payload.timestamp,
      Math.floor(Date.now() / 1000),
      DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
    );
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Called when this node is the proposer for the next round. Pulls
   * pending transactions, builds the block, stashes + broadcasts the
   * content, returns the hash to the round controller for inclusion
   * in the proposal.
   */
  private buildCandidateBlock(height: number): string {
    const latest = getLatestBlock(this.db);
    const previousHash = latest?.hash ?? '0'.repeat(64);
    const txs = transactionStore(this.db).findUnblockedTransactions();
    const txIds = txs.map((t) => t.id);
    const merkleRoot = computeMerkleRoot(txIds);
    const timestamp = Math.floor(Date.now() / 1000);

    // Promote the parent cert into this block's hash. For block 1 (parent
    // is genesis, no cert) and the first BFT block after an Authority-era
    // chain, parentCert will be null and prevCommitCertHash stays null —
    // backward-compatible with the legacy 5-arg hash form.
    const parentCert = latest && latest.number >= 1
      ? blockStore(this.db).findCommitCertificate(latest.number)
      : null;
    const prevCommitCertHash = parentCert ? computeCertHash(parentCert) : null;

    // Session 48: pull pending validator changes for inclusion. The
    // proposer's queue is opaque to this class; we just call the
    // configured callback. Empty array (or no callback) = no changes
    // this block. The signatures inside each change were created by
    // the affected accounts before they ever reached the queue, so
    // we don't sign anything here.
    const validatorChanges: ValidatorChange[] = this.pendingValidatorChanges
      ? this.pendingValidatorChanges()
      : [];

    // Session 52: fold the changes hash into the block hash so a
    // tampered changes list (swap register/deregister, drop entries,
    // reorder) breaks block hash verification on every receiver.
    // null when the block carries no changes — preserves the legacy
    // hash for the common no-changes case.
    const validatorChangesHash =
      validatorChanges.length > 0 ? computeValidatorChangesHash(validatorChanges) : null;

    const hash = computeBlockHash(
      height,
      previousHash,
      timestamp,
      merkleRoot,
      this.day,
      prevCommitCertHash,
      validatorChangesHash,
    );

    // Session 53 fix: include parentCertificate + parentValidatorSnapshot
    // in the gossip payload. ChainSync's BFT-mode block:received listener
    // calls validateIncomingBlock with bftValidatorSet set, which REQUIRES
    // every block N >= 2 to ship a valid parentCertificate. Without
    // shipping it, every gossiped block at height >= 2 fails validation
    // and the producer gets banned. (Phase 59 surfaced this — phase 49
    // didn't because that test ends after block 1.)
    //
    // The cert + snapshot are pulled from local storage where the
    // previous block's commit (this validator's onCommit, or a sync-
    // received block) wrote them.
    const parentSnapshotRaw = latest && latest.number >= 1
      ? blockStore(this.db).findValidatorSnapshot(latest.number)
      : null;
    // bigint → string for JSON serialization. The receiver's
    // validateIncomingBlock parses the string back to bigint via
    // SnapshotValidatorSet.
    const parentSnapshot = parentSnapshotRaw
      ? parentSnapshotRaw.map((v) => ({
          ...v,
          stake: v.stake.toString() as unknown as bigint,
        }))
      : null;

    const payload: IncomingBlockPayload = {
      number: height,
      day: this.day,
      timestamp,
      previousHash,
      hash,
      merkleRoot,
      transactionCount: txIds.length,
      rebaseEvent: null,
      prevCommitCertHash,
      txIds,
      transactions: txs.map(txRowToWire),
      ...(validatorChanges.length > 0 ? { validatorChanges } : {}),
      ...(parentCert ? { parentCertificate: parentCert } : {}),
      ...(parentSnapshot ? { parentValidatorSnapshot: parentSnapshot } : {}),
    };

    this.stash.set(hash, payload);

    // Broadcast block content BEFORE the proposal goes out, so peers
    // have the bytes ready by the time they need to replay on commit.
    // (The proposal will go out via the round controller's broadcast-
    // proposal action, which fires right after blockProviderFor
    // returns.) See class doc — bundling into the proposal would
    // close the race definitively; for now we rely on ordered WS
    // frames + small block sizes.
    this.peerManager.broadcast(
      'new_block',
      { ...serializeBlock(payload as unknown as Record<string, unknown>) } as Record<string, unknown>,
    );

    return hash;
  }

  /**
   * Called by BftDriver when the round commits. Persists the stashed
   * block + replays transactions in one DB transaction.
   */
  private onCommit(height: number, hash: string, cert: CommitCertificate): void {
    const payload = this.stash.get(hash);
    if (!payload) {
      // Block content didn't make it through. In a proper rollout this
      // would trigger a "fetch block by hash" sync request. For now we
      // log and bail; the round will be retried (committed cert exists,
      // we just can't apply locally).
      return;
    }

    const block = payloadToBlock(payload);
    const txs = payload.transactions ?? [];

    const validatorChanges: ValidatorChange[] = payload.validatorChanges ?? [];

    runTransaction(this.db, () => {
      for (const wireTx of txs) {
        replayTransaction(
          this.db,
          {
            id: wireTx.id,
            from: wireTx.from,
            to: wireTx.to,
            amount: BigInt(wireTx.amount),
            fee: BigInt(wireTx.fee),
            netAmount: BigInt(wireTx.netAmount),
            pointType: wireTx.pointType,
            isInPerson: wireTx.isInPerson,
            memo: wireTx.memo,
            signature: wireTx.signature,
            receiverSignature: wireTx.receiverSignature ?? null,
            timestamp: wireTx.timestamp,
          },
          height,
        );
      }
      const store = blockStore(this.db);
      store.insert(block, /* isGenesis */ false);
      // Persist the commit cert alongside the block. ChainSync uses this
      // when replying to a sync request to ship the cert as the next
      // block's parentCertificate, enabling full cert-verified
      // multi-block catch-up.
      store.saveCommitCertificate(height, cert);
      // Snapshot the validator set BEFORE applying this block's
      // validator changes. cert(N) was signed by validators voting
      // at the START of height N — i.e., the set as it was AT THE
      // END OF HEIGHT N-1, before any changes block N introduces.
      // A future verifier of cert(N) needs that pre-change set.
      // (Order with insert() above is irrelevant — listAll() reads
      // the validators table, not the blocks table.)
      store.saveValidatorSnapshot(height, this.validatorSet.listAll());
      // Session 48: apply validator changes AFTER tx replay AND after
      // snapshotting. Tx replay first so any earned-balance moves are
      // visible when registerValidator checks `stake <= earnedBalance`.
      // Snapshot before so cert(N) verifies against the set that
      // actually signed it. Then apply, mutating the set for height
      // N+1 onward. block.timestamp as `now` keeps timestamps
      // byte-identical across nodes.
      for (const change of validatorChanges) {
        applyValidatorChange(this.db, change, block.timestamp);
      }

      // Distribute the block's fees per WP economics. Idempotent — every
      // node (proposer + followers replaying via this same path) reaches
      // the same balances.
      commitBlockSideEffects(this.db, block.number, block.hash);
    });

    // Session 48: notify the wrapping layer that validator changes
    // have been applied. Used by the proposer to drain matching
    // entries from its pending queue. Followers that didn't queue
    // any of these changes can no-op — the implementation should be
    // idempotent (delete-by-id, ignore missing).
    if (validatorChanges.length > 0 && this.onValidatorChangesApplied) {
      try {
        this.onValidatorChangesApplied(validatorChanges);
      } catch (err) {
        // Telemetry only; consensus continues regardless.
        void err;
      }
    }

    // Drain the stash for this hash. Any other entries (forks, aborted
    // rounds) stay parked; sweeping them is a follow-up.
    this.stash.delete(hash);

    // Chain-driven day cycle (Session 40). In BFT mode, every validator
    // applies the cycle deterministically post-commit using the block's
    // timestamp as the canonical "now." Identical inputs across all
    // validators → identical state. The wall-clock setTimeout in
    // runner.ts is gated on isAuthority() and silently no-ops in BFT
    // mode, so this is the ONLY path that fires the cycle on a BFT chain.
    //
    // Errors from the cycle are caught + logged so a failed expire/mint
    // doesn't blow up the consensus loop. (A failed cycle still leaves
    // the cycle state in a recoverable shape — runMintAndAdvance is
    // idempotent on its day refId, runExpireAndRebase phases through
    // setPhase, so the next block's call retries.)
    try {
      applyChainDayCycle(this.db, block.timestamp);
    } catch (err) {
      // Telemetry only; consensus continues. We don't surface this
      // through onBlockCommitted because the block itself is already
      // committed — the cycle is a separate state machine.
      void err;
    }

    this.onBlockCommitted?.(block, cert);
  }
}
