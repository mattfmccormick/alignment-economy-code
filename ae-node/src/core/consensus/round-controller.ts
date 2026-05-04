// Round controller — the BFT state machine for one (height, round) tuple.
//
// Pure, event-driven. The controller takes events as input (received
// proposals, received votes, timeouts) and emits a list of actions for
// the driver to execute (broadcast a vote, schedule a timer, commit a
// block, advance the round). It owns no timers and no network. That
// keeps the safety logic testable without I/O plumbing — Sessions 20+
// will wrap it with the actual P2P transport and a timer scheduler.
//
// Phase progression for the happy path:
//
//   start
//     → propose phase. If we're the proposer, emit broadcast-proposal
//       and set a propose-timeout. Otherwise wait for the proposer's
//       proposal.
//
//   received-proposal (or seeing 2/3+ prevotes for a hash without
//   having received the proposal — the "polka without proposal"
//   tendermint rule)
//     → cast prevote on the agreed hash, transition to prevote phase,
//       set a prevote-timeout.
//
//   propose-timeout while in propose
//     → cast prevote NIL, transition to prevote phase, set a
//       prevote-timeout.
//
//   2/3+ prevotes for the same hash while in prevote
//     → cast precommit on that hash, transition to precommit phase,
//       set a precommit-timeout.
//
//   2/3+ prevotes for NIL while in prevote, OR prevote-timeout
//     → cast precommit NIL, transition to precommit phase, set a
//       precommit-timeout.
//
//   2/3+ precommits for the same hash while in precommit
//     → build a CommitCertificate, emit commit-block, transition to
//       'committed'. We're done; the driver advances chain head.
//
//   2/3+ precommits for NIL OR precommit-timeout
//     → emit advance-round, transition to 'failed'. The driver builds
//       a new RoundController for round+1 with a fresh proposer.
//
// What's intentionally NOT here yet (call-out comments mark each):
//
//   - Locking. After a validator precommits a real block, Tendermint
//     locks them on it for future rounds — they can't switch to
//     prevoting a different block at this height unless they see a new
//     polka for it. That safety property prevents fork-creation by a
//     Byzantine majority. Adding it is a separate session.
//   - Dynamic timeouts. Real Tendermint scales each phase's timeout
//     after every NIL round to escape adversarial network conditions.
//     Here timeouts are fixed per controller; the driver can vary
//     them across rounds.
//   - Slashing-evidence emission. The VoteSet already records
//     equivocation; this controller doesn't yet hoist that into an
//     emit-evidence action.

import type { Vote, VoteKind } from './votes.js';
import { signVote } from './votes.js';
import type { Proposal } from './proposal.js';
import { signProposal, verifyProposal } from './proposal.js';
import type { IValidatorSet, ValidatorInfo } from './IValidatorSet.js';
import { selectProposer } from './proposer-selection.js';
import { VoteSet } from './vote-aggregator.js';
import {
  buildCommitCertificate,
  type CommitCertificate,
} from './commit-certificate.js';

export type Phase = 'propose' | 'prevote' | 'precommit' | 'committed' | 'failed';

export type RoundEvent =
  /** Driver fires this once after building the controller to kick things off. */
  | { type: 'start' }
  /** A proposal arrived over the wire (signature already verified at the transport layer is fine, controller re-verifies anyway). */
  | { type: 'received-proposal'; proposal: Proposal }
  /** A signed prevote or precommit arrived. */
  | { type: 'received-vote'; vote: Vote }
  /** Driver fires these when the timer scheduled by set-timeout expires. */
  | { type: 'propose-timeout' }
  | { type: 'prevote-timeout' }
  | { type: 'precommit-timeout' };

export type RoundAction =
  | { type: 'broadcast-proposal'; proposal: Proposal }
  | { type: 'broadcast-vote'; vote: Vote }
  /** Ask the driver to schedule a timer that fires the corresponding *-timeout event. */
  | { type: 'set-timeout'; phase: 'propose' | 'prevote' | 'precommit'; durationMs: number }
  /** A block has reached commit. The driver applies it and advances chain head. */
  | { type: 'commit-block'; blockHash: string; certificate: CommitCertificate }
  /** This round is done without a commit. The driver builds round+1. */
  | { type: 'advance-round' }
  /**
   * The local validator just precommitted a real (non-NIL) block; the
   * driver should record this lock and pass it into every subsequent
   * round at the same height. The lock clears when chain head advances.
   */
  | { type: 'set-lock'; lockState: LockState }
  /**
   * 2/3+ prevotes for a real block were observed in the local prevote
   * VoteSet for this round. The driver should record (round, blockHash)
   * — if the local node ever ends up locked on a DIFFERENT hash from a
   * lower round, this polka enables Tendermint's "polka unlock":
   * unlock + follow the network's newer consensus.
   */
  | { type: 'observed-polka'; round: number; blockHash: string };

/**
 * Tendermint-style lock state. A validator who has precommitted a real
 * block at (height H, round R) is locked on it: they will refuse to
 * prevote a different block in any later round at height H, until the
 * chain advances to H+1 and the lock clears.
 *
 * Why: this is the safety property that prevents 1/3+ Byzantine
 * validators from forking the chain. Once an honest validator
 * precommits A, no Byzantine plurality can convince them to prevote a
 * different B at this height.
 */
export interface LockState {
  blockHash: string;
  round: number;
}

/**
 * Observed prevote-quorum (polka) on a real block at a specific round.
 * Tracked across rounds at the same height so locked validators can
 * "polka unlock" when the network has moved past their lock.
 */
export interface PolkaState {
  blockHash: string;
  round: number;
}

export interface LocalValidator {
  accountId: string;
  /** Hex Ed25519 public key, must equal the validator's registered nodePublicKey. */
  publicKey: string;
  /** Hex Ed25519 secret key (32 bytes). */
  secretKey: string;
}

export interface TimeoutConfig {
  /** Time we wait for a proposal before voting NIL. Default 3s. */
  propose: number;
  /** Time we wait for prevote quorum before precommitting NIL. Default 1s. */
  prevote: number;
  /** Time we wait for precommit quorum before advancing round. Default 1s. */
  precommit: number;
}

/**
 * Scaling policy for timeouts across rounds at the same height.
 *
 * On each NIL-advance, BftDriver computes
 *   effectiveTimeout = baseTimeout + step * round
 * and passes the result into the next RoundController. Reset to base
 * timeouts on commit (height advance).
 *
 * Defaults give a gentle ramp:
 *   propose:   3000 + 1000 * round    (3s, 4s, 5s, ...)
 *   prevote:   1000 + 500  * round    (1s, 1.5s, 2s, ...)
 *   precommit: 1000 + 500  * round    (1s, 1.5s, 2s, ...)
 *
 * Real Tendermint uses similar additive ramping. Multiplicative ramping
 * would scale faster but risks DoS if a Byzantine validator can force
 * many NIL rounds.
 */
export interface TimeoutScaling {
  /** Added to propose timeout per NIL-advance. */
  proposeStep: number;
  /** Added to prevote timeout per NIL-advance. */
  prevoteStep: number;
  /** Added to precommit timeout per NIL-advance. */
  precommitStep: number;
}

export interface RoundControllerConfig {
  /** The validator set as of this round. Captured at construction. */
  validatorSet: IValidatorSet;
  /** Block height we're trying to commit. */
  height: number;
  /** Round number within the height. 0 = first attempt. */
  round: number;
  /**
   * Per-height seed for proposer selection. Typically the previous block
   * hash. Same value used by every node so they all agree on the proposer.
   */
  proposerSeed: string;
  /**
   * Local validator credentials. Omit to run in follower mode (track
   * votes + commit when we see quorum, but never emit broadcast-vote /
   * broadcast-proposal).
   */
  localValidator?: LocalValidator;
  /**
   * Called when local node is the proposer for this round. Returns the
   * blockHash this controller should put up for vote. Required if you want
   * the controller to emit broadcast-proposal — without it, even a
   * proposing validator just waits for the propose-timeout to fire NIL.
   */
  blockProvider?: () => string;
  /** Timeout durations in ms. */
  timeouts?: Partial<TimeoutConfig>;
  /** Injectable clock (seconds) for deterministic tests. */
  nowSec?: () => number;
  /**
   * Lock carried over from a prior round at this height. When set, the
   * local validator refuses to prevote any block whose hash differs
   * from priorLock.blockHash — defends the safety property that we
   * never flip our vote after precommitting.
   *
   * Polka unlock (Session 38): if priorPolka is also set with a round
   * higher than priorLock.round AND a different blockHash, the lock
   * is bypassed for this round's prevote and precommit — the validator
   * follows the polka. This is Tendermint's liveness recovery for
   * partition heals where a locked-minority needs to catch up to the
   * majority's new lock target.
   */
  priorLock?: LockState;

  /**
   * Highest-round real-block prevote-quorum (polka) observed at this
   * height in any prior round. The driver collects polka observations
   * via the 'observed-polka' action and threads the latest into each
   * new round.
   *
   * When priorLock and priorPolka coexist with priorPolka.round >
   * priorLock.round AND priorPolka.blockHash !== priorLock.blockHash,
   * the controller "unlocks" — castPrevote + castPrecommit allow the
   * polka's hash through. If the round commits a real block, the new
   * set-lock event will replace priorLock; if the round NIL-times-out,
   * the existing priorLock survives.
   */
  priorPolka?: PolkaState;

  /**
   * Optional content-level validation gate (Session 45). Called inside
   * castPrevote and castPrecommit just before the controller signs a
   * vote for a real (non-NIL) block hash. If the callback returns
   * {valid: false}, the controller downgrades the vote to NIL.
   *
   * Why this matters: RoundController votes on hashes without ever
   * inspecting the underlying block content. Without this gate, a
   * Byzantine majority can form a cert over a block whose content
   * violates application invariants (e.g., timestamp drift from
   * Session 44). Honest validators wouldn't apply the block locally
   * at onCommit, but they'd still have voted for it and watched the
   * cert form — they then have to recover via sync.
   *
   * With this gate: any local validator who can't validate the content
   * prevotes NIL. If at least floor(N/3)+1 honest validators have the
   * same view, no quorum forms on the bad block; the round NIL-times-out
   * and round 1 picks up. The same standard Byzantine tolerance bound
   * applies (1/3 max malicious).
   *
   * Typical implementation: the BFT block producer provides this from
   * its stash — look up payload by hash, run validateBlockTimestamp
   * (and any future content checks) on it, return invalid if missing
   * or timestamp out of window.
   *
   * Returns invalid for missing content too — without content we can't
   * validate, so safer to vote NIL than to vote blind.
   */
  validateBlockContent?: (blockHash: string) => { valid: boolean; error?: string };
}

const DEFAULT_TIMEOUTS: TimeoutConfig = {
  propose: 3000,
  prevote: 1000,
  precommit: 1000,
};

/**
 * State machine for one (height, round). One instance per round; once we
 * hit 'committed' or 'failed' it's done — the driver builds the next
 * round's controller from scratch.
 */
export class RoundController {
  readonly height: number;
  readonly round: number;

  private readonly validators: IValidatorSet;
  private readonly proposerSeed: string;
  private readonly localValidator: LocalValidator | undefined;
  private readonly blockProvider: (() => string) | undefined;
  private readonly timeouts: TimeoutConfig;
  private readonly nowSec: () => number;

  private phase: Phase = 'propose';
  private proposal: Proposal | null = null;
  private prevotes: VoteSet;
  private precommits: VoteSet;
  /** Captured the moment we transition to 'committed'. */
  private commitCert: CommitCertificate | null = null;
  /** Lock carried over from a prior round at this height. */
  private readonly priorLock: LockState | undefined;
  /** Highest-round polka observed at this height in prior rounds. */
  private readonly priorPolka: PolkaState | undefined;
  /** Content-level validation gate (Session 45). Optional. */
  private readonly validateBlockContent:
    | ((blockHash: string) => { valid: boolean; error?: string })
    | undefined;

  constructor(config: RoundControllerConfig) {
    this.height = config.height;
    this.round = config.round;
    this.validators = config.validatorSet;
    this.proposerSeed = config.proposerSeed;
    this.localValidator = config.localValidator;
    this.blockProvider = config.blockProvider;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.nowSec = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.priorLock = config.priorLock;
    this.priorPolka = config.priorPolka;
    this.validateBlockContent = config.validateBlockContent;

    this.prevotes = new VoteSet('prevote', this.height, this.round, this.validators, {
      nowSec: this.nowSec,
    });
    this.precommits = new VoteSet(
      'precommit',
      this.height,
      this.round,
      this.validators,
      { nowSec: this.nowSec },
    );
  }

  /** Current phase. Driver inspects this for logging / UI. */
  getPhase(): Phase {
    return this.phase;
  }

  /** The committed cert, only set after transition to 'committed'. */
  getCommitCertificate(): CommitCertificate | null {
    return this.commitCert;
  }

  /**
   * True when our priorLock is overridden by a more recent polka:
   *   priorLock exists, priorPolka exists,
   *   priorPolka.round > priorLock.round,
   *   priorPolka.blockHash !== priorLock.blockHash
   *
   * In that state, this round's votes are NOT constrained by the lock —
   * we follow the polka. If this round commits, we'll re-lock at the
   * polka's hash via the new set-lock action.
   */
  private lockBypassedByPolka(): boolean {
    if (!this.priorLock || !this.priorPolka) return false;
    if (this.priorPolka.round <= this.priorLock.round) return false;
    if (this.priorPolka.blockHash === this.priorLock.blockHash) return false;
    return true;
  }

  /** Current proposer for this (height, round). */
  getExpectedProposer(): ValidatorInfo | null {
    return selectProposer(
      this.validators.listActive(),
      this.height,
      this.proposerSeed,
      this.round,
    );
  }

  /** Process one event. Returns the actions the driver should take. */
  handle(event: RoundEvent): RoundAction[] {
    if (this.phase === 'committed' || this.phase === 'failed') {
      // Round is done; ignore further events.
      return [];
    }

    switch (event.type) {
      case 'start':
        return this.onStart();
      case 'received-proposal':
        return this.onReceivedProposal(event.proposal);
      case 'received-vote':
        return this.onReceivedVote(event.vote);
      case 'propose-timeout':
        return this.onProposeTimeout();
      case 'prevote-timeout':
        return this.onPrevoteTimeout();
      case 'precommit-timeout':
        return this.onPrecommitTimeout();
    }
  }

  // ── Event handlers ───────────────────────────────────────────────────

  private onStart(): RoundAction[] {
    if (this.phase !== 'propose') return [];
    const actions: RoundAction[] = [];

    const proposer = this.getExpectedProposer();
    if (
      proposer &&
      this.localValidator &&
      proposer.accountId === this.localValidator.accountId &&
      proposer.nodePublicKey === this.localValidator.publicKey &&
      this.blockProvider
    ) {
      // We're the proposer for this round — build, sign, broadcast.
      const blockHash = this.blockProvider();
      const proposal = signProposal({
        height: this.height,
        round: this.round,
        blockHash,
        proposerAccountId: this.localValidator.accountId,
        proposerPublicKey: this.localValidator.publicKey,
        proposerSecretKey: this.localValidator.secretKey,
        now: this.nowSec(),
      });
      this.proposal = proposal;
      actions.push({ type: 'broadcast-proposal', proposal });
      // Drop straight into our own prevote on the proposal we just minted.
      actions.push(...this.castPrevote(blockHash));
      this.transitionToPrevote(actions);
    } else {
      // Wait for the real proposer's broadcast or for the timeout.
      actions.push({
        type: 'set-timeout',
        phase: 'propose',
        durationMs: this.timeouts.propose,
      });
    }
    return actions;
  }

  private onReceivedProposal(proposal: Proposal): RoundAction[] {
    // Bucket sanity
    if (proposal.height !== this.height || proposal.round !== this.round) return [];
    if (this.phase !== 'propose') {
      // We've already moved on. Ignore; we already prevoted what we know.
      return [];
    }

    // Validate: signature + replay window
    if (
      !verifyProposal(proposal, {
        nowSec: this.nowSec(),
      })
    ) {
      return []; // bad signature or stale; just ignore
    }

    // Validate: it actually came from the validator we expect to be proposer
    const expected = this.getExpectedProposer();
    if (!expected) return [];
    if (
      proposal.proposerAccountId !== expected.accountId ||
      proposal.proposerPublicKey !== expected.nodePublicKey
    ) {
      // Wrong proposer for this round — ignore. The real proposer's
      // proposal may still arrive, or we'll time out and NIL-prevote.
      return [];
    }

    this.proposal = proposal;
    const actions = this.castPrevote(proposal.blockHash);
    this.transitionToPrevote(actions);
    return actions;
  }

  private onReceivedVote(vote: Vote): RoundAction[] {
    if (vote.height !== this.height || vote.round !== this.round) return [];
    const actions: RoundAction[] = [];

    const target = vote.kind === 'prevote' ? this.prevotes : this.precommits;
    const result = target.addVote(vote);
    if (result.status !== 'added') {
      // duplicate, equivocation, or rejected — nothing to act on here.
      // Equivocation evidence is captured inside the VoteSet for slashing.
      return [];
    }

    // After adding, check whether this vote pushes us over a quorum we
    // care about for the current phase.
    if (vote.kind === 'prevote' && this.phase === 'prevote') {
      const committed = this.prevotes.committedBlockHash();
      if (committed) {
        // 2/3+ prevotes for a real block → polka observation + precommit
        actions.push({
          type: 'observed-polka',
          round: this.round,
          blockHash: committed,
        });
        actions.push(...this.castPrecommit(committed));
        this.transitionToPrecommit(actions);
      } else if (this.prevotes.hasQuorum(null)) {
        // 2/3+ prevotes for NIL → precommit NIL (no polka — polka is
        // by definition a real-block quorum, not NIL)
        actions.push(...this.castPrecommit(null));
        this.transitionToPrecommit(actions);
      }
    } else if (vote.kind === 'prevote' && this.phase === 'propose') {
      // "Polka without proposal": we never saw the proposal but the
      // network already has 2/3+ agreement. Skip ahead to precommit.
      const committed = this.prevotes.committedBlockHash();
      if (committed) {
        actions.push({
          type: 'observed-polka',
          round: this.round,
          blockHash: committed,
        });
        actions.push(...this.castPrevote(committed));
        actions.push(...this.castPrecommit(committed));
        this.transitionToPrecommit(actions);
      }
    } else if (vote.kind === 'precommit' && this.phase === 'precommit') {
      const committed = this.precommits.committedBlockHash();
      if (committed) {
        // 2/3+ precommits → build the certificate and commit
        const cert = buildCommitCertificate(this.precommits);
        if (cert) {
          this.commitCert = cert;
          actions.push({ type: 'commit-block', blockHash: committed, certificate: cert });
          this.phase = 'committed';
        }
      } else if (this.precommits.hasQuorum(null)) {
        // 2/3+ NIL precommits → round failed, advance
        actions.push({ type: 'advance-round' });
        this.phase = 'failed';
      }
    }
    return actions;
  }

  private onProposeTimeout(): RoundAction[] {
    if (this.phase !== 'propose') return [];
    // No valid proposal arrived in time — vote NIL.
    const actions = this.castPrevote(null);
    this.transitionToPrevote(actions);
    return actions;
  }

  private onPrevoteTimeout(): RoundAction[] {
    if (this.phase !== 'prevote') return [];
    // No prevote quorum yet. Precommit NIL and move on.
    const actions = this.castPrecommit(null);
    this.transitionToPrecommit(actions);
    return actions;
  }

  private onPrecommitTimeout(): RoundAction[] {
    if (this.phase !== 'precommit') return [];
    // No precommit quorum. Round failed — driver builds round+1.
    this.phase = 'failed';
    return [{ type: 'advance-round' }];
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Build + record the local validator's prevote and return the
   * broadcast-vote action(s). In follower mode (no localValidator),
   * returns []. The caller is responsible for transitionToPrevote.
   *
   * Locking: if we have a priorLock from an earlier round at this
   * height, we MUST NOT prevote a different block. The locking rule
   * downgrades any non-matching prevote to NIL. Lock matches when
   * blockHash === priorLock.blockHash, OR when blockHash is null
   * (NIL prevotes are always allowed regardless of lock).
   *
   * NOTE: This intentionally also feeds the vote into our own VoteSet so
   * a single-validator network commits its own blocks correctly. The
   * tally update is what matters; addVote dedupes on the wire when the
   * same vote echoes back from gossip.
   */
  private castPrevote(blockHash: string | null): RoundAction[] {
    if (!this.localValidator) return [];

    // Locking-on-precommit safety: if we have a prior lock and the caller
    // wants us to prevote a different block, downgrade to NIL.
    //
    // Polka unlock: if priorPolka exists with a higher round than
    // priorLock and a different hash, the lock is bypassed — we
    // follow the polka. This is the liveness recovery rule.
    let effectiveHash = blockHash;
    if (
      this.priorLock &&
      blockHash !== null &&
      blockHash !== this.priorLock.blockHash &&
      !this.lockBypassedByPolka()
    ) {
      effectiveHash = null;
    }

    // Content-validation gate (Session 45). If we're about to prevote a
    // real block, give the application a chance to reject it on content
    // grounds (e.g., timestamp drift). Failed validation downgrades to
    // NIL. Missing validator → no gate, behave as before.
    if (effectiveHash !== null && this.validateBlockContent) {
      const r = this.validateBlockContent(effectiveHash);
      if (!r.valid) effectiveHash = null;
    }

    const vote = signVote({
      kind: 'prevote',
      height: this.height,
      round: this.round,
      blockHash: effectiveHash,
      validatorAccountId: this.localValidator.accountId,
      validatorPublicKey: this.localValidator.publicKey,
      validatorSecretKey: this.localValidator.secretKey,
      now: this.nowSec(),
    });
    this.prevotes.addVote(vote);
    return [{ type: 'broadcast-vote', vote }];
  }

  /**
   * Build + record the local validator's precommit. When precommitting
   * a real (non-NIL) block, also emits a set-lock action so the driver
   * can carry the lock across to subsequent rounds at this height.
   *
   * Locking applies symmetrically to prevote AND precommit: a validator
   * locked on H1 must NEVER precommit a different block H2, even if
   * 2/3+ prevotes for H2 hit the quorum line in a later round. Without
   * this check, a Byzantine majority could observe an honest validator's
   * lock from round 0 and then propose a different block in round 1
   * that the locked validator would precommit too — flipping their
   * precommit and breaking the safety property locking is supposed to
   * provide. castPrecommit downgrades any non-matching precommit to NIL,
   * mirroring castPrevote's behavior from Session 31.
   *
   * NIL precommits don't form a lock — only real blocks lock. So a
   * locked validator who downgrades to NIL keeps their EXISTING lock
   * (carried through priorLock); they don't lose it.
   */
  private castPrecommit(blockHash: string | null): RoundAction[] {
    if (!this.localValidator) return [];

    // Lock-or-NIL: if locked on a different real block, downgrade.
    // Polka unlock applies symmetrically here (same rule as prevote).
    let effectiveHash = blockHash;
    if (
      this.priorLock &&
      blockHash !== null &&
      blockHash !== this.priorLock.blockHash &&
      !this.lockBypassedByPolka()
    ) {
      effectiveHash = null;
    }

    // Content-validation gate (Session 45). Mirror the prevote gate so
    // a Byzantine majority can't observe our prevote-quorum reaction
    // and force us to precommit (and lock onto) a hash whose content
    // we can't validate. NIL precommits don't form locks, so a locked
    // validator who downgrades here keeps their existing priorLock.
    if (effectiveHash !== null && this.validateBlockContent) {
      const r = this.validateBlockContent(effectiveHash);
      if (!r.valid) effectiveHash = null;
    }

    const vote = signVote({
      kind: 'precommit',
      height: this.height,
      round: this.round,
      blockHash: effectiveHash,
      validatorAccountId: this.localValidator.accountId,
      validatorPublicKey: this.localValidator.publicKey,
      validatorSecretKey: this.localValidator.secretKey,
      now: this.nowSec(),
    });
    this.precommits.addVote(vote);
    const actions: RoundAction[] = [{ type: 'broadcast-vote', vote }];
    if (effectiveHash !== null) {
      actions.push({
        type: 'set-lock',
        lockState: { blockHash: effectiveHash, round: this.round },
      });
    }
    return actions;
  }

  private transitionToPrevote(actions: RoundAction[]): void {
    this.phase = 'prevote';
    actions.push({
      type: 'set-timeout',
      phase: 'prevote',
      durationMs: this.timeouts.prevote,
    });
  }

  private transitionToPrecommit(actions: RoundAction[]): void {
    this.phase = 'precommit';
    actions.push({
      type: 'set-timeout',
      phase: 'precommit',
      durationMs: this.timeouts.precommit,
    });
  }
}

/** Re-export so callers can identify vote kinds without importing from votes.js. */
export type { VoteKind };
