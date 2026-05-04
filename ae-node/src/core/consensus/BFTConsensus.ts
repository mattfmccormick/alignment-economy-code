// BFTConsensus — IConsensusEngine implementation for Phase-3 multi-
// validator consensus.
//
// What this class does today (Session 17):
//   - Plugs into the existing IConsensusEngine surface so runner.ts,
//     block-validator.ts, and sync.ts all work without changes when an
//     operator swaps AuthorityConsensus for BFTConsensus.
//   - Answers the consensus questions using IValidatorSet (Session 12)
//     and proposer-selection (Session 13).
//
// What it does NOT do yet (later sessions):
//   - Run the round state machine (propose → prevote → precommit). That
//     lives behind a separate RoundController so the state-machine logic
//     can be tested without timers, then wired in by Session 18.
//   - Drive the network gossip of votes / proposals. Wire-protocol
//     integration is Session 18.
//   - Verify CommitCertificates on incoming blocks. Block-validator
//     integration is Session 19.
//
// Composition over inheritance: BFTConsensus does NOT extend
// AuthorityConsensus. They're two siblings of IConsensusEngine that
// callers can swap behind the interface. AuthorityConsensus stays
// untouched.

import type { IConsensusEngine } from './IConsensusEngine.js';
import type { IValidatorSet, ValidatorInfo } from './IValidatorSet.js';
import { selectProposer } from './proposer-selection.js';

export interface BFTConsensusConfig {
  /** Live validator-set view (typically backed by SqliteValidatorSet). */
  validatorSet: IValidatorSet;
  /** This node's account id (used to ask "am I a validator? am I the proposer?"). */
  localAccountId: string;
  /**
   * This node's Ed25519 P2P / node-identity publicKey. Used by canProduceBlock
   * to confirm the registered validator's nodePublicKey matches our own —
   * defeats the case where an account id was registered but the keypair
   * was rotated and the current node holds the new key.
   */
  localNodePublicKey: string;
  /** Initial chain head. Defaults to 0 (genesis). */
  initialHeight?: number;
  /**
   * Per-height seed for proposer selection — typically the previous block
   * hash. Defaults to '' (empty string) for genesis. The runner updates this
   * via notifyHeightAdvanced(height, seed).
   */
  initialSeed?: string;
  /**
   * Initial finalized height. Lags `latestHeight` until commit certificates
   * land. For Phase-3 prep we initialize equal to latestHeight; CommitCert
   * integration will start gating finality in Session 19.
   */
  initialFinalizedHeight?: number;
}

export class BFTConsensus implements IConsensusEngine {
  private readonly validators: IValidatorSet;
  private readonly localAccountId: string;
  private readonly localNodePublicKey: string;
  private latestHeight: number;
  private latestSeed: string;
  private finalized: number;

  constructor(config: BFTConsensusConfig) {
    this.validators = config.validatorSet;
    this.localAccountId = config.localAccountId;
    this.localNodePublicKey = config.localNodePublicKey;
    this.latestHeight = config.initialHeight ?? 0;
    this.latestSeed = config.initialSeed ?? '';
    this.finalized = config.initialFinalizedHeight ?? this.latestHeight;
  }

  // ── Block production ────────────────────────────────────────────────

  /**
   * True iff selectProposer for height `latestHeight + 1` lands on this
   * local validator AND the registered nodePublicKey matches our own
   * (catches the rotated-key case).
   *
   * Returns false when:
   *   - the active validator set is empty
   *   - the proposer is a different validator
   *   - we're not in the active set at all
   *   - our registered nodePublicKey doesn't match localNodePublicKey
   */
  canProduceBlock(): boolean {
    const proposer = this.getNextProposer();
    if (!proposer) return false;
    if (proposer.accountId !== this.localAccountId) return false;
    if (proposer.nodePublicKey !== this.localNodePublicKey) return false;
    return true;
  }

  /**
   * Validate that the producer of a received block is allowed.
   *
   * For BFT: the producer must be in the active validator set AND their
   * wire publicKey must match the publicKey they registered. We do NOT
   * enforce proposer-for-this-specific-height here because the existing
   * IConsensusEngine signature doesn't carry the block height. Block-
   * validator integration (Session 19) adds the height-aware check via
   * a more complete validation pipeline.
   *
   * `producerPublicKey` is required for BFT — passing undefined fails.
   */
  validateBlockProducer(blockProducerId: string, producerPublicKey?: string): boolean {
    if (!producerPublicKey) return false;
    const validator = this.validators.findByAccountId(blockProducerId);
    if (!validator) return false;
    if (!validator.isActive) return false;
    if (validator.nodePublicKey !== producerPublicKey) return false;
    return true;
  }

  // ── Conflict resolution ─────────────────────────────────────────────

  /**
   * Phase-3 fork-choice (interim): higher height wins. The full BFT rule
   * is "longest chain whose tip carries a valid commit certificate"; since
   * commit-cert integration ships in Session 19, this interim rule keeps
   * the surface stable. For equal heights, A wins by convention so the
   * runner never tiebreaks via random behavior.
   */
  resolveConflict(heightA: number, heightB: number): 'A' | 'B' {
    return heightA >= heightB ? 'A' : 'B';
  }

  // ── Observability ───────────────────────────────────────────────────

  /**
   * The highest block height with a known commit certificate.
   * - Authority: equals chain head.
   * - BFT: lags chain head until precommits land. For Session 17 we don't
   *   yet wire commit-cert tracking, so callers can advance this via
   *   notifyFinalized() once the pipeline is connected.
   */
  finalizedHeight(): number {
    return this.finalized;
  }

  /**
   * Current validator set as nodeIds (using accountId as the canonical
   * id, matching the AuthorityConsensus contract). Sorted ascending so
   * the result is deterministic across nodes.
   */
  /** The active validator set with full records (not just nodeIds). */
  listValidators(): ValidatorInfo[] {
    return this.validators.listActive();
  }

  validatorSet(): string[] {
    return this.validators.listActive().map((v) => v.accountId);
  }

  /** Floor(2N/3) + 1 over the active set. */
  quorumSize(): number {
    return this.validators.quorumCount();
  }

  /** True iff this node is in the active validator set. */
  isAuthority(): boolean {
    const me = this.validators.findByAccountId(this.localAccountId);
    if (!me) return false;
    if (!me.isActive) return false;
    return me.nodePublicKey === this.localNodePublicKey;
  }

  /**
   * The proposer for the NEXT block height. Returns the proposer's
   * accountId, or empty string when the validator set is empty.
   */
  getAuthorityId(): string {
    return this.getNextProposer()?.accountId ?? '';
  }

  // ── BFT-specific helpers ─────────────────────────────────────────────

  /**
   * The full validator record for whoever should propose at height
   * `latestHeight + 1`. Useful to the runner / round controller — they
   * need the publicKey + vrfPublicKey, not just the accountId.
   */
  getNextProposer(): ValidatorInfo | null {
    const active = this.validators.listActive();
    return selectProposer(active, this.latestHeight + 1, this.latestSeed);
  }

  /**
   * Called by the runner once a block has committed locally (chain head
   * advances). Updates the height + seed used for proposer selection of
   * the NEXT block.
   *
   * Idempotent and monotonic — earlier heights are silently ignored so
   * out-of-order events don't reset state.
   */
  notifyHeightAdvanced(newHeight: number, newSeed?: string): void {
    if (newHeight <= this.latestHeight) return;
    this.latestHeight = newHeight;
    if (newSeed !== undefined) this.latestSeed = newSeed;
  }

  /**
   * Called when a commit certificate finalizes a height. Idempotent and
   * monotonic. Future block-validator integration (Session 19) will wire
   * this; for now exposed for tests + early callers.
   */
  notifyFinalized(height: number): void {
    if (height > this.finalized) this.finalized = height;
  }

  /** Currently-known chain head (latest committed locally, regardless of finality). */
  getLatestHeight(): number {
    return this.latestHeight;
  }

  /** Currently-known per-height seed. */
  getLatestSeed(): string {
    return this.latestSeed;
  }
}
