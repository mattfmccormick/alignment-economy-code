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
import { logger } from '../../node/logger.js';
import { computeStateRoot, recordStateRoot } from '../state-root.js';
import {
  applyAccountRegistration,
  computeAccountRegistrationsHash,
  type AccountRegistration,
} from '../account-registration.js';

/**
 * Sentinel thrown to unwind a successful dry run so runTransaction rolls it
 * back. A unique object rather than an Error subclass so it can never be
 * confused with a genuine replay failure, however that failure is constructed.
 */
const DRY_RUN_ROLLBACK = Symbol('bft.dryRunRollback');

/**
 * Replay a candidate block's transactions against local state, then roll the
 * whole thing back. Returns whether this node could actually apply the block.
 *
 * Exported so it can be tested directly: the interesting cases (a sender with
 * no local account row, a balance local state says is too low) are cheap to
 * construct against a bare DB and expensive to stage through a whole consensus
 * round.
 *
 * Rollback works by throwing a sentinel once the replays succeed, which makes
 * `runTransaction` unwind everything. That helper is depth-aware, so this must
 * NOT be called from inside an existing DB transaction — otherwise the rollback
 * is deferred to the outer scope and dry-run state leaks into it. The consensus
 * caller satisfies this: validation runs from message handling, not from within
 * an apply.
 */
/**
 * Filter a candidate transaction set down to the ones that actually apply, in
 * order, against current state — then roll the rehearsal back.
 *
 * Under commit-time execution nothing has moved balances yet, so the pending
 * set can legitimately contain transactions that conflict with each other: the
 * same account spending the same points twice, submitted to two validators at
 * once. That is not misbehaviour, it is the ordering question the chain exists
 * to answer.
 *
 * A proposer must answer it here rather than ship both. A block containing two
 * conflicting spends is unappliable on every node including its author, so it
 * would either be voted down or, worse, commit and fail-stop the network. First
 * in deterministic order wins; the loser stays pending and gets rejected on its
 * own merits next round.
 *
 * Iteration order comes from findUnblockedTransactions (ORDER BY id), so every
 * proposer would make the same selection from the same pending set.
 */
export function selectApplicableTransactions(
  db: DatabaseSync,
  txs: WireTransaction[],
  height: number,
): WireTransaction[] {
  if (txs.length === 0) return [];
  const kept: WireTransaction[] = [];

  try {
    runTransaction(db, () => {
      for (const wireTx of txs) {
        try {
          replayTransaction(
            db,
            {
              id: wireTx.id,
              from: wireTx.from,
              to: wireTx.to,
              amount: BigInt(wireTx.amount),
              fee: BigInt(wireTx.fee),
              netAmount: BigInt(wireTx.netAmount),
              pointType: wireTx.pointType,
              isInPerson: wireTx.isInPerson,
              recipientIsHuman: wireTx.recipientIsHuman ?? false,
              memo: wireTx.memo,
              signature: wireTx.signature,
              receiverSignature: wireTx.receiverSignature ?? null,
              timestamp: wireTx.timestamp,
            },
            height,
          );
          kept.push(wireTx);
        } catch {
          // Does not fit after its predecessors. Leave it pending; it is a
          // candidate for a later block, or it is a double-spend that will
          // never fit and will age out.
        }
      }
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }

  return kept;
}

export function dryRunBlockTransactions(
  db: DatabaseSync,
  txs: WireTransaction[],
  height: number,
): { valid: boolean; error?: string } {
  if (txs.length === 0) return { valid: true };

  try {
    runTransaction(db, () => {
      for (const wireTx of txs) {
        replayTransaction(
          db,
          {
            id: wireTx.id,
            from: wireTx.from,
            to: wireTx.to,
            amount: BigInt(wireTx.amount),
            fee: BigInt(wireTx.fee),
            netAmount: BigInt(wireTx.netAmount),
            pointType: wireTx.pointType,
            isInPerson: wireTx.isInPerson,
            recipientIsHuman: wireTx.recipientIsHuman ?? false,
            memo: wireTx.memo,
            signature: wireTx.signature,
            receiverSignature: wireTx.receiverSignature ?? null,
            timestamp: wireTx.timestamp,
          },
          height,
        );
      }
      // Everything applied cleanly. Throw to roll it all back — this is a
      // rehearsal, not the performance.
      throw DRY_RUN_ROLLBACK;
    });
    /* c8 ignore next */
    return { valid: true }; // unreachable: the sentinel always throws
  } catch (err) {
    if (err === DRY_RUN_ROLLBACK) return { valid: true };
    return {
      valid: false,
      error: `does not apply against local state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
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
    recipientIsHuman: tx.recipientIsHuman,
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
   * Pull account registrations to include in the next block this node
   * proposes. Same contract as pendingValidatorChanges: the proposer reads its
   * own local queue; receivers take whatever arrives in the payload.
   */
  pendingAccountRegistrations?: () => AccountRegistration[];
  /**
   * Fired after a block's account registrations have been applied locally.
   * Used to drain the proposer's queue. Every node calls this, including ones
   * that never queued the entries, so implementations must be idempotent.
   */
  onAccountRegistrationsApplied?: (regs: AccountRegistration[]) => void;
  /**
   * Fired after a block's transactions have been applied to balances.
   *
   * Under commit-time execution this is the moment money actually moves, so it
   * is the only correct moment to tell a connected wallet its balance changed.
   * The API-time event fires before anything has moved and would show the user
   * their old balance.
   */
  onTransactionsApplied?: (txs: WireTransaction[]) => void;
  /**
   * Fired when a committed block cannot be applied locally. Consensus has
   * already fail-stopped at the previous height by the time this runs, so an
   * implementation should treat it as "this node is out of the network until
   * an operator intervenes" — surface it, don't try to continue. See
   * BftDriverConfig.onApplyFailed.
   */
  onApplyFailed?: (height: number, blockHash: string, err: unknown) => void;
  /**
   * Session 54: forwarded to BftRuntime. Delays first round start by
   * this many ms so peer mesh has time to establish before round 0
   * fires. See BftDriverConfig.startupDelayMs for full rationale.
   */
  startupDelayMs?: number;
  /**
   * Minimum gap between committing a block and starting the next round.
   * Forwarded to BftDriver. Must be identical on every validator.
   */
  blockIntervalMs?: number;
}

export class BftBlockProducer {
  private readonly db: DatabaseSync;
  private readonly peerManager: PeerManager;
  private readonly stash = new Map<string, IncomingBlockPayload>();
  /**
   * Memoised dry-run verdicts, keyed by block hash. The round controller
   * validates a candidate twice per round (once before prevote, once before
   * precommit) and replaying a whole block for each is pure waste. Cleared
   * with the stash.
   */
  private readonly dryRunCache = new Map<string, { valid: boolean; error?: string }>();
  private readonly runtime: BftRuntime;
  private readonly onBlockCommitted: ((block: Block, cert: CommitCertificate) => void) | undefined;
  private readonly day: number;
  private readonly validatorSet: IValidatorSet;
  private readonly pendingValidatorChanges: (() => ValidatorChange[]) | undefined;
  private readonly onValidatorChangesApplied:
    | ((changes: ValidatorChange[]) => void)
    | undefined;
  private readonly pendingAccountRegistrations: (() => AccountRegistration[]) | undefined;
  private readonly onAccountRegistrationsApplied:
    | ((regs: AccountRegistration[]) => void)
    | undefined;
  private readonly onTransactionsApplied: ((txs: WireTransaction[]) => void) | undefined;
  private incomingBlockHandler: ((data: unknown) => void) | null = null;

  constructor(config: BftBlockProducerConfig) {
    this.db = config.db;
    this.peerManager = config.peerManager;
    this.day = config.day;
    this.onBlockCommitted = config.onBlockCommitted;
    this.validatorSet = config.validatorSet;
    this.pendingValidatorChanges = config.pendingValidatorChanges;
    this.onValidatorChangesApplied = config.onValidatorChangesApplied;
    this.pendingAccountRegistrations = config.pendingAccountRegistrations;
    this.onAccountRegistrationsApplied = config.onAccountRegistrationsApplied;
    this.onTransactionsApplied = config.onTransactionsApplied;

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
      blockProviderFor: (h, r, lockedHash) => this.provideBlock(h, r, lockedHash),
      // Content-validation gate (Session 45). The stash holds the only
      // local view of a candidate block's content (timestamp, txs, etc).
      // If a hash isn't in the stash the controller votes NIL — same
      // behavior as if validation actively failed. Once Session 44's
      // timestamp pre-filter ran, only timestamp-valid blocks made it
      // into the stash, so a stash-presence check IS the content check
      // for now. Future content invariants would extend this.
      validateBlockContent: (hash) => this.validateStashedBlock(hash),
      onCommit: (h, hash, cert) => this.onCommit(h, hash, cert),
      onApplyFailed: config.onApplyFailed,
      timeouts: config.timeouts,
      clock: config.clock,
      startupDelayMs: config.startupDelayMs,
      blockIntervalMs: config.blockIntervalMs,
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
    this.dryRunCache.clear();
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
    const timestampCheck = validateBlockTimestamp(
      payload.timestamp,
      Math.floor(Date.now() / 1000),
      DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
    );
    if (!timestampCheck.valid) return timestampCheck;

    // State-root agreement. DIAGNOSTIC ONLY — this deliberately does not
    // affect the vote.
    //
    // It is tempting to vote NIL on a mismatch, and the first version of this
    // did. That is a liveness bug, and a nasty one. Account rows legitimately
    // appear on different nodes at different moments: gossip delivers a new
    // account to peers that are online, and the on-chain registration reaches
    // everyone else only when a block carrying it commits. So a node that
    // missed the gossip has a genuinely different parent state root through no
    // fault of anyone's — and if it voted NIL on that basis it would reject
    // every block, including the very block carrying the registration that
    // would fix it. The chain deadlocks precisely in the situation the
    // replication work exists to handle.
    //
    // Enforcement belongs to the dry run below, which asks the only question
    // that actually matters: can this node apply this block? A block whose
    // transactions reference an account we have never heard of fails there and
    // gets a NIL, while a harmless "we have not caught up on registrations
    // yet" difference does not.
    //
    // So the root's job is to make silent drift audible. Balance drift used to
    // surface only as an incidental replay throw; percentHuman drift produced
    // no signal at any point, ever. Now it produces a log line naming the
    // likely cause, which is what an operator needs and what nothing else
    // provides.
    if (typeof payload.parentStateRoot === 'string') {
      const localRoot = computeStateRoot(this.db);
      if (localRoot !== payload.parentStateRoot) {
        logger.warn(
          'bft',
          `State root differs from the proposer at height ${payload.number}: theirs ` +
            `${payload.parentStateRoot.slice(0, 16)}…, ours ${localRoot.slice(0, 16)}…. ` +
            `Expected transiently while a new account propagates. If it persists across ` +
            `many blocks this node has drifted — the usual causes are a direct SQL write ` +
            `such as scripts/dev-bump-ph.mjs run on some nodes but not all, or an account ` +
            `whose registration never reached a block. Not blocking the vote; the dry run ` +
            `below decides whether this block is actually applicable here.`,
        );
      }
    }

    return this.dryRunTransactions(blockHash, payload);
  }

  /**
   * Replay a candidate block's transactions against local state and roll the
   * whole thing back, so a validator only ever votes for a block it could
   * actually apply.
   *
   * Until this existed, content validation was stash-presence plus timestamp —
   * the old comment here conceded "a stash-presence check IS the content check
   * for now". That meant a follower would happily prevote and precommit a block
   * guaranteed to throw on its own apply (a sender it has no account row for, a
   * balance its local state says is too low). The block then reached a valid
   * commit certificate and blew up at apply time, which is precisely the
   * situation the fail-stop in BftDriver now contains. Voting NIL up front is
   * better: the round fails cleanly, the network retries, and no certificate is
   * ever produced for a block that half the validators cannot apply.
   *
   * Rolled back via runTransaction, which is depth-aware, by throwing a
   * sentinel after the replays succeed. That forces ROLLBACK of everything the
   * dry run touched while still using the same nesting-safe helper the real
   * apply path uses. This requires that validation is NOT already inside a DB
   * transaction — it isn't; the round controller calls it from message
   * handling — because runTransaction would then defer the rollback to the
   * outer scope and leak dry-run state.
   *
   * Cached per block hash: the controller validates once before prevoting and
   * again before precommitting, and re-running a whole block twice per round is
   * wasted work. The cache is cleared with the stash.
   */
  private dryRunTransactions(
    blockHash: string,
    payload: IncomingBlockPayload,
  ): { valid: boolean; error?: string } {
    const cached = this.dryRunCache.get(blockHash);
    if (cached) return cached;

    const height = typeof payload.number === 'number' ? payload.number : 0;
    const outcome = dryRunBlockTransactions(this.db, payload.transactions ?? [], height);
    const result = outcome.valid
      ? outcome
      : { valid: false, error: `block ${blockHash.slice(0, 12)}… ${outcome.error}` };

    if (!result.valid) {
      logger.warn('bft', `Voting NIL: ${result.error}`);
    }
    this.dryRunCache.set(blockHash, result);
    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Called when this node is the proposer for the next round. Pulls
   * pending transactions, builds the block, stashes + broadcasts the
   * content, returns the hash to the round controller for inclusion
   * in the proposal.
   */
  /**
   * Choose what block to propose for (height, round): the value this node is
   * LOCKED on if it holds a lock, otherwise a fresh candidate.
   *
   * This is the missing half of Tendermint's locking rule (audit #1). The vote
   * side already downgrades a prevote/precommit to NIL whenever the proposed
   * hash differs from the lock, but the PROPOSE side ignored the lock and always
   * built a fresh block - and buildCandidateBlock stamps a new Date.now()
   * timestamp, so every round produced a different hash. A locked validator then
   * voted NIL on every proposal forever, no prevote quorum could form on any
   * value, the sole unlock path (a polka at a higher round) was unreachable, and
   * the height deadlocked in silence. That is the 3-node LAN "all nodes quiet for
   * 90s" flake.
   *
   * Re-proposing the locked value is always safe: a lock is only ever taken on a
   * value that already saw a prevote quorum (a polka), i.e. a value 2/3 of the
   * set found valid. Re-serving it can only help THAT value commit; it can never
   * cause a different value to commit, so it cannot fork. Worst case (two nodes
   * locked on different values across rounds) it does not resolve on its own -
   * that needs the full valid-value / POL-round rule, which is a wire-format
   * change tracked separately - but it strictly improves liveness and never
   * risks safety.
   */
  private provideBlock(height: number, _round: number, lockedHash?: string): string {
    if (lockedHash) {
      const payload = this.stash.get(lockedHash);
      if (payload) {
        // Re-broadcast the stashed content so any peer that evicted it can
        // still validate and prevote, then propose the same hash. Same
        // broadcast shape buildCandidateBlock uses.
        this.peerManager.broadcast(
          'new_block',
          { ...serializeBlock(payload as unknown as Record<string, unknown>) } as Record<
            string,
            unknown
          >,
        );
        logger.info(
          'bft',
          `re-proposing locked block ${lockedHash.slice(0, 10)}… at height ${height} instead of a fresh candidate`,
        );
        return lockedHash;
      }
      // Locked on a hash we cannot serve (should not happen - we stash every
      // candidate we see). Building fresh is safer than proposing a hash no
      // peer can validate from us.
      logger.warn(
        'bft',
        `locked on ${lockedHash.slice(0, 10)}… but its payload is not stashed; building a fresh candidate`,
      );
    }
    return this.buildCandidateBlock(height);
  }

  private buildCandidateBlock(height: number): string {
    const latest = getLatestBlock(this.db);
    const previousHash = latest?.hash ?? '0'.repeat(64);
    // Drop transactions that cannot apply after the ones ahead of them. Under
    // commit-time execution the pending set can hold genuine conflicts (the
    // same points promised twice, submitted to two validators at once), and
    // shipping both would produce a block that no node — including this one —
    // can apply.
    const txs = selectApplicableTransactions(
      this.db,
      transactionStore(this.db).findUnblockedTransactions().map(txRowToWire),
      height,
    );
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

    // Accounts created locally since the last block we proposed. Same shape as
    // the validator-change queue: only our own queue feeds a block, but every
    // node applies the result from the payload, so all nodes converge without
    // reading anyone else's queue.
    const accountRegistrations: AccountRegistration[] = this.pendingAccountRegistrations
      ? this.pendingAccountRegistrations()
      : [];
    const accountRegistrationsHash =
      accountRegistrations.length > 0
        ? computeAccountRegistrationsHash(accountRegistrations)
        : null;

    const hash = computeBlockHash(
      height,
      previousHash,
      timestamp,
      merkleRoot,
      this.day,
      prevCommitCertHash,
      validatorChangesHash,
      accountRegistrationsHash,
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
      transactions: txs,
      // State as of the END of the parent block, i.e. before this block's
      // transactions apply. Deliberately the parent's rather than this
      // block's: every receiver already holds that state, so the check needs
      // no prediction of post-apply side effects (fee distribution, day
      // cycle, validator changes) and stays a pure comparison. Divergence is
      // caught one block later than a post-state root would catch it, which
      // costs nothing when the alternative was never catching it at all.
      parentStateRoot: computeStateRoot(this.db),
      ...(accountRegistrations.length > 0 ? { accountRegistrations } : {}),
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

    // Everything below is one DB transaction, so a throw anywhere rolls the
    // whole block back — the node keeps a consistent view of height N-1 rather
    // than a half-applied N. The catch re-throws after logging: BftDriver
    // treats a throw here as fail-stop, halting consensus at this height
    // instead of advancing past a block it could not apply. See
    // BftDriverConfig.onApplyFailed for why halting beats both alternatives.
    const accountRegistrations: AccountRegistration[] = payload.accountRegistrations ?? [];

    try {
      runTransaction(this.db, () => {
        // Registrations FIRST. An account registered in this block starts
        // empty, so within this block it can only receive — and receiving
        // requires its row to exist before the transaction replays. Applying
        // these after the transactions would make a block that legitimately
        // onboards someone and pays them in one go fail on every node.
        for (const reg of accountRegistrations) {
          applyAccountRegistration(this.db, reg, block.timestamp);
        }
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
              recipientIsHuman: wireTx.recipientIsHuman ?? false,
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
    } catch (err) {
      logger.error(
        'bft',
        `FATAL: could not apply committed block ${height} (${hash.slice(0, 12)}…, ` +
          `${txs.length} tx): ${err instanceof Error ? err.message : String(err)}. ` +
          `Consensus is halting at height ${height - 1} rather than diverging. ` +
          `This node's local state disagrees with the proposer's — the usual causes ` +
          `are an account that exists only on the node that created it (accounts are ` +
          `not replicated) or a direct SQL write such as scripts/dev-bump-ph.mjs run ` +
          `on some nodes but not all.`,
        err,
      );
      throw err;
    }

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

    // Same for account registrations: drain the proposer's queue now the
    // entries are on-chain. Queue bookkeeping, never consensus-critical, so a
    // failure here must not disturb the chain.
    if (accountRegistrations.length > 0 && this.onAccountRegistrationsApplied) {
      try {
        this.onAccountRegistrationsApplied(accountRegistrations);
      } catch (err) {
        void err;
      }
    }

    // Money has now actually moved. Under commit-time execution this is the
    // only point at which that is true, so it is the only honest moment to
    // tell a connected wallet to refresh. Notification only — never let it
    // disturb consensus.
    if (txs.length > 0 && this.onTransactionsApplied) {
      try {
        this.onTransactionsApplied(txs);
      } catch (err) {
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

    // Fingerprint the resulting state. Deliberately AFTER the day cycle: a
    // block that crosses 08:59 UTC expires, rebases and mints, and a root
    // taken before that describes state no node ever settles on. Every node
    // records at this same point from the same inputs, so honest nodes agree.
    recordStateRoot(this.db, block.number);

    this.onBlockCommitted?.(block, cert);
  }
}
