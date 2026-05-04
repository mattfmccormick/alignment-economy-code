// BFT driver — the runtime glue between the pure RoundController and the
// real world (timers + network). It manages the round lifecycle:
//
//   - On 'start', builds the first RoundController and fires 'start' on it.
//   - Subscribes to the transport for incoming proposals and votes,
//     routes them as events into the controller.
//   - For each action the controller emits:
//       broadcast-proposal → transport.broadcastProposal
//       broadcast-vote     → transport.broadcastVote
//       set-timeout        → clock.setTimeout, fires *-timeout event
//       commit-block       → onCommit callback, then build round 0 of
//                            height+1
//       advance-round      → build same height, round+1
//
// Tested against injectable IBftTransport + IBftClock so the lifecycle
// logic can be exercised without WebSocket / real setTimeout. Wiring to
// the actual PeerManager is a thin adapter step that doesn't add new
// state-machine code.

import type { IValidatorSet } from './IValidatorSet.js';
import type { Vote } from './votes.js';
import type { Proposal } from './proposal.js';
import type { CommitCertificate } from './commit-certificate.js';
import {
  RoundController,
  type LocalValidator,
  type LockState,
  type Phase,
  type PolkaState,
  type RoundAction,
  type TimeoutConfig,
  type TimeoutScaling,
} from './round-controller.js';

const DEFAULT_TIMEOUT_SCALING: TimeoutScaling = {
  proposeStep: 1000,
  prevoteStep: 500,
  precommitStep: 500,
};

const DEFAULT_BASE_TIMEOUTS: TimeoutConfig = {
  propose: 3000,
  prevote: 1000,
  precommit: 1000,
};

/**
 * Transport abstraction. The driver doesn't know whether it's talking
 * to PeerManager, an in-memory test bus, or a tracing harness. The
 * adapter that wires it to the real wire layer is a separate session.
 */
export interface IBftTransport {
  /** Broadcast a proposal to peers. */
  broadcastProposal(p: Proposal): void;
  /** Broadcast a (signed) prevote or precommit to peers. */
  broadcastVote(v: Vote): void;
  /** Register a handler called whenever a proposal arrives. */
  onProposal(handler: (p: Proposal) => void): void;
  /** Register a handler called whenever a vote arrives. */
  onVote(handler: (v: Vote) => void): void;
}

/** Opaque token returned by the clock for cancellation. */
export type TimerId = number | object;

/**
 * Clock abstraction. Tests pass a manual clock; production passes a
 * thin wrapper over Node's setTimeout/clearTimeout.
 */
export interface IBftClock {
  setTimeout(callback: () => void, durationMs: number): TimerId;
  clearTimeout(id: TimerId): void;
}

/** Concrete IBftClock backed by real setTimeout/clearTimeout. */
export class RealClock implements IBftClock {
  setTimeout(callback: () => void, durationMs: number): TimerId {
    return setTimeout(callback, durationMs);
  }
  clearTimeout(id: TimerId): void {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  }
}

export interface BftDriverConfig {
  transport: IBftTransport;
  clock: IBftClock;
  validatorSet: IValidatorSet;
  /**
   * Height the driver tries to commit FIRST when started. Typically
   * (chain head + 1).
   */
  initialHeight: number;
  /**
   * Per-height seed for proposer selection. Updated on each commit
   * via the onCommit callback's return-value flow (driver re-reads
   * config.proposerSeedFor(height)).
   */
  proposerSeedFor: (height: number) => string;
  /**
   * Local validator credentials. Omit for follower-only mode (track
   * commits, never propose or vote).
   */
  localValidator?: LocalValidator;
  /**
   * When this node is the proposer at a given height, returns the
   * blockHash to put up for vote. The driver invokes this on every
   * round where local is selected as proposer.
   */
  blockProviderFor?: (height: number, round: number) => string;
  /**
   * Optional content-validation gate (Session 45). Forwarded to each
   * round's RoundController. When set, validators downgrade to NIL on
   * any prevote/precommit whose blockHash can't be content-validated
   * locally — closes the Session 44 gap where RoundController votes
   * blind on hashes without inspecting content.
   */
  validateBlockContent?: (blockHash: string) => { valid: boolean; error?: string };
  /**
   * Session 54: delay first round start by this many ms after start().
   * Why this exists: when two validators boot at slightly different
   * times, the one that starts first races through round 0 alone
   * (broadcasts to zero peers, prevote-timeout, NIL precommit, advance
   * to round 1) before the other is connected. The other validator
   * then enters round 0 LATE, propose-timeouts at 3s, advances. The
   * two are now permanently out of sync because RoundController
   * drops votes/proposals from non-current rounds. Without
   * fast-forward, they never converge.
   *
   * The delay gives peers time to connect before round 0 fires.
   * Default 0 (no delay) preserves existing test behavior; production
   * runners should set ~2000ms.
   */
  startupDelayMs?: number;
  /**
   * Base per-phase timeout durations (applied at round 0 of each height).
   * Subsequent rounds at the same height add `timeoutScaling.*Step *
   * round` to each phase, growing the budget after every NIL-advance.
   */
  timeouts?: Partial<TimeoutConfig>;
  /**
   * How much each round's timeouts grow vs. round 0 of the same height.
   * Defaults: propose +1000ms/round, prevote +500ms/round, precommit
   * +500ms/round. Pass {0,0,0} to disable scaling entirely.
   */
  timeoutScaling?: Partial<TimeoutScaling>;
  /**
   * Called when consensus commits a block. The driver advances to
   * height+1 right after; persistence and chain-head update happen
   * in the callback (or whatever wraps the driver).
   */
  onCommit: (
    height: number,
    blockHash: string,
    certificate: CommitCertificate,
  ) => void;
  /**
   * Called when a round fails (advance-round). Default behavior is
   * just to bump the round; this hook lets the wrapper log / metrics.
   */
  onRoundFailed?: (height: number, round: number) => void;
  /** Injectable wallclock-seconds for the controllers (replay window). */
  nowSec?: () => number;
}

/**
 * Drives the BFT consensus loop. Construct, call start(), let it run.
 * Stop with stop() — cancels pending timers and unsubscribes.
 */
export class BftDriver {
  private readonly config: BftDriverConfig;
  private readonly proposalHandler: (p: Proposal) => void;
  private readonly voteHandler: (v: Vote) => void;

  private currentHeight: number;
  private currentRound = 0;
  private controller: RoundController | null = null;
  private pendingTimers = new Map<'propose' | 'prevote' | 'precommit', TimerId>();
  private running = false;
  /**
   * Lock that carries across rounds at the CURRENT height. Set when the
   * round controller emits a 'set-lock' action (after precommitting a
   * real block). Cleared when the chain commits and advances to the
   * next height. Tendermint locking-on-precommit safety property.
   */
  private currentLock: LockState | null = null;
  /**
   * Highest-round polka (real-block prevote quorum) observed at the
   * CURRENT height. Set when the round controller emits an
   * 'observed-polka' action. Cleared on chain advance. When a later
   * round starts with priorLock + priorPolka where polka.round >
   * lock.round and different hash, the controller "unlocks" — follows
   * the polka instead of the stale lock. Tendermint liveness recovery.
   */
  private latestPolka: PolkaState | null = null;
  /**
   * Session 54: messages received BEFORE the first startRound() fires
   * are buffered here so the controller can process them once it
   * exists. Without this, two validators booting at slightly different
   * wall-clock times can have one runner's startup-delay fire AFTER
   * the other has already broadcast its proposal — the receiver's
   * controller doesn't exist yet, routeProposal/routeVote drop the
   * message, and the validators stay permanently desynced.
   *
   * Cleared on first startRound() invocation. Capped to prevent OOM
   * on a sustained pre-startup flood (which shouldn't happen in
   * practice — we drop the delay quickly).
   */
  private preStartupProposals: Proposal[] = [];
  private preStartupVotes: Vote[] = [];
  private static readonly MAX_PRESTARTUP_BUFFER = 256;

  constructor(config: BftDriverConfig) {
    this.config = config;
    this.currentHeight = config.initialHeight;
    this.proposalHandler = (p) => this.routeProposal(p);
    this.voteHandler = (v) => this.routeVote(v);
  }

  /**
   * Begin the consensus loop at the configured initial height.
   *
   * Session 54: respect `startupDelayMs` if configured. The transport
   * handlers register IMMEDIATELY so any votes/proposals already in
   * flight when this runner came online are buffered into the round
   * once it starts. Only `startRound()` is delayed.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.config.transport.onProposal(this.proposalHandler);
    this.config.transport.onVote(this.voteHandler);
    const delay = this.config.startupDelayMs ?? 0;
    if (delay > 0) {
      this.config.clock.setTimeout(() => {
        if (this.running) this.startRound();
      }, delay);
    } else {
      this.startRound();
    }
  }

  /** Stop. Cancels timers, leaves transport handlers registered (transport owns its own teardown). */
  stop(): void {
    this.running = false;
    this.cancelAllTimers();
  }

  getCurrentHeight(): number {
    return this.currentHeight;
  }

  getCurrentRound(): number {
    return this.currentRound;
  }

  getCurrentPhase(): Phase | null {
    return this.controller?.getPhase() ?? null;
  }

  /**
   * Current lock state at this height (null if we haven't precommitted
   * a real block yet at this height, or if we just advanced height).
   * Test/observability hook.
   */
  getCurrentLock(): LockState | null {
    return this.currentLock;
  }

  /**
   * Highest-round polka observed at the current height. Test hook —
   * used to verify the polka-unlock data flow.
   */
  getLatestPolka(): PolkaState | null {
    return this.latestPolka;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private startRound(): void {
    this.cancelAllTimers();
    this.controller = new RoundController({
      validatorSet: this.config.validatorSet,
      height: this.currentHeight,
      round: this.currentRound,
      proposerSeed: this.config.proposerSeedFor(this.currentHeight),
      localValidator: this.config.localValidator,
      blockProvider: this.config.blockProviderFor
        ? () => this.config.blockProviderFor!(this.currentHeight, this.currentRound)
        : undefined,
      timeouts: this.computeRoundTimeouts(),
      nowSec: this.config.nowSec,
      // Carry the lock from prior rounds at this height. Cleared when
      // chain advances to the next height (see onCommit below).
      priorLock: this.currentLock ?? undefined,
      // Carry the latest polka — used for polka-unlock when this round
      // is locked on an older hash than the polka.
      priorPolka: this.latestPolka ?? undefined,
      // Content-validation gate (Session 45) — forwarded as-is.
      validateBlockContent: this.config.validateBlockContent,
    });
    const actions = this.controller.handle({ type: 'start' });
    this.executeActions(actions);

    // Session 54: drain pre-startup buffers. Messages received before
    // startRound() fires (during the startup-delay window) are
    // replayed here. Each message goes through the same height/round
    // check inside the controller's onReceivedProposal/onReceivedVote
    // — wrong-height/wrong-round messages are silently dropped, which
    // is the correct behavior for buffered messages whose round has
    // since advanced.
    const bufferedProposals = this.preStartupProposals;
    const bufferedVotes = this.preStartupVotes;
    this.preStartupProposals = [];
    this.preStartupVotes = [];
    for (const p of bufferedProposals) {
      if (this.controller && p.height === this.currentHeight && p.round === this.currentRound) {
        this.executeActions(this.controller.handle({ type: 'received-proposal', proposal: p }));
      }
    }
    for (const v of bufferedVotes) {
      if (this.controller && v.height === this.currentHeight && v.round === this.currentRound) {
        this.executeActions(this.controller.handle({ type: 'received-vote', vote: v }));
      }
    }
  }

  /**
   * Compute the timeouts for the current round. Round 0 uses base
   * timeouts; later rounds at the same height grow each phase by
   * `step * round` ms. Reset on commit (height advance) via the
   * fact that this.currentRound resets to 0 in onCommit.
   */
  private computeRoundTimeouts(): TimeoutConfig {
    const base = { ...DEFAULT_BASE_TIMEOUTS, ...this.config.timeouts };
    const scaling = { ...DEFAULT_TIMEOUT_SCALING, ...this.config.timeoutScaling };
    return {
      propose: base.propose + scaling.proposeStep * this.currentRound,
      prevote: base.prevote + scaling.prevoteStep * this.currentRound,
      precommit: base.precommit + scaling.precommitStep * this.currentRound,
    };
  }

  private routeProposal(p: Proposal): void {
    if (!this.running) return;
    // Session 54: buffer messages that arrive between BFT.start() and
    // startRound() (during the startup delay window). Without this,
    // a runner whose startup-delay fires later than its peer's loses
    // the peer's pre-startup proposals/votes and the BFT loop never
    // converges. See preStartupProposals comment for rationale.
    if (!this.controller) {
      if (this.preStartupProposals.length < BftDriver.MAX_PRESTARTUP_BUFFER) {
        this.preStartupProposals.push(p);
      }
      return;
    }
    if (p.height !== this.currentHeight || p.round !== this.currentRound) return;
    const actions = this.controller.handle({ type: 'received-proposal', proposal: p });
    this.executeActions(actions);
  }

  private routeVote(v: Vote): void {
    if (!this.running) return;
    if (!this.controller) {
      if (this.preStartupVotes.length < BftDriver.MAX_PRESTARTUP_BUFFER) {
        this.preStartupVotes.push(v);
      }
      return;
    }
    if (v.height !== this.currentHeight || v.round !== this.currentRound) return;
    const actions = this.controller.handle({ type: 'received-vote', vote: v });
    this.executeActions(actions);
  }

  private executeActions(actions: RoundAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case 'broadcast-proposal':
          this.config.transport.broadcastProposal(action.proposal);
          break;
        case 'broadcast-vote':
          this.config.transport.broadcastVote(action.vote);
          break;
        case 'set-timeout':
          this.scheduleTimeout(action.phase, action.durationMs);
          break;
        case 'set-lock':
          // Record the lock so it carries into round+1 of the same
          // height. Cleared in onCommit when we move to height+1.
          this.currentLock = action.lockState;
          break;
        case 'observed-polka':
          // Track the highest-round polka. Multiple rounds at this
          // height may emit polkas; we keep the most recent so the
          // lock-bypass condition (polka.round > lock.round) uses
          // the freshest data.
          if (
            !this.latestPolka ||
            action.round > this.latestPolka.round
          ) {
            this.latestPolka = { round: action.round, blockHash: action.blockHash };
          }
          break;
        case 'commit-block':
          this.onCommit(action.blockHash, action.certificate);
          break;
        case 'advance-round':
          this.onAdvance();
          break;
      }
    }
  }

  private scheduleTimeout(phase: 'propose' | 'prevote' | 'precommit', ms: number): void {
    // Cancel any previous timer for this phase (defensive — controller
    // shouldn't ask twice per phase, but explicit cancel is safer).
    const existing = this.pendingTimers.get(phase);
    if (existing !== undefined) this.config.clock.clearTimeout(existing);

    const id = this.config.clock.setTimeout(() => {
      this.pendingTimers.delete(phase);
      this.fireTimeout(phase);
    }, ms);
    this.pendingTimers.set(phase, id);
  }

  private fireTimeout(phase: 'propose' | 'prevote' | 'precommit'): void {
    if (!this.running || !this.controller) return;
    const eventType =
      phase === 'propose'
        ? 'propose-timeout'
        : phase === 'prevote'
          ? 'prevote-timeout'
          : 'precommit-timeout';
    const actions = this.controller.handle({ type: eventType } as Parameters<RoundController['handle']>[0]);
    this.executeActions(actions);
  }

  private cancelAllTimers(): void {
    for (const id of this.pendingTimers.values()) {
      this.config.clock.clearTimeout(id);
    }
    this.pendingTimers.clear();
  }

  private onCommit(blockHash: string, cert: CommitCertificate): void {
    this.config.onCommit(this.currentHeight, blockHash, cert);
    if (!this.running) return; // onCommit may have called stop()
    // Advance to height+1, round 0. Clear the lock AND the polka — both
    // are scoped to the height we just left.
    this.currentHeight += 1;
    this.currentRound = 0;
    this.currentLock = null;
    this.latestPolka = null;
    this.startRound();
  }

  private onAdvance(): void {
    this.config.onRoundFailed?.(this.currentHeight, this.currentRound);
    if (!this.running) return;
    // Same height, round+1
    this.currentRound += 1;
    this.startRound();
  }
}
