// BftRuntime — single-node BFT consensus runtime.
//
// Wraps Session 20's BftDriver with Session 21's PeerManagerBftTransport
// + a real-setTimeout clock to give one node everything it needs to
// participate in consensus rounds. Construct one per AENode in BFT mode,
// call start(), let it run.
//
// What this class is intentionally NOT: it doesn't yet drive block
// production end-to-end (proposer builds + broadcasts the block content)
// or persist blocks on commit. Those wiring concerns live one layer up
// in the runner. This class delivers the consensus loop itself —
// proposals, votes, commits — running on a real network.
//
// What this enables: the multi-node end-to-end test (phase30) where 4
// instances of BftRuntime running in-process across 4 PeerManagers
// converge on the same onCommit event. That convergence is the core
// proof that BFT works.

import { BftDriver, RealClock, type IBftClock } from './bft-driver.js';
import { PeerManagerBftTransport } from './PeerManagerBftTransport.js';
import type { IValidatorSet } from './IValidatorSet.js';
import type { LocalValidator, TimeoutConfig } from './round-controller.js';
import type { CommitCertificate } from './commit-certificate.js';
import type { PeerManager } from '../../network/peer.js';

export interface BftRuntimeConfig {
  peerManager: PeerManager;
  validatorSet: IValidatorSet;
  /** This node's validator credentials. Required: the runtime always votes. */
  localValidator: LocalValidator;
  /** Height the runtime tries to commit FIRST. Typically chain head + 1. */
  initialHeight: number;
  /** Per-height seed for proposer selection (typically previous block hash). */
  proposerSeedFor: (height: number) => string;
  /** When local is the proposer, returns the blockHash to put up for vote. */
  blockProviderFor: (height: number, round: number) => string;
  /**
   * Optional content-validation gate (Session 45). Forwarded to the
   * driver and on to each round's RoundController. Without it the
   * controller votes blind on hashes; with it, validators downgrade
   * to NIL whenever the local view of a hash's content fails to
   * validate.
   */
  validateBlockContent?: (blockHash: string) => { valid: boolean; error?: string };
  /** Called when consensus commits a block. */
  onCommit: (
    height: number,
    blockHash: string,
    certificate: CommitCertificate,
  ) => void;
  /** Optional callback fired on every NIL round. Useful for tests / metrics. */
  onRoundFailed?: (height: number, round: number) => void;
  /** Per-phase timeouts. Defaults to BftDriver's defaults. */
  timeouts?: Partial<TimeoutConfig>;
  /** Inject a clock for deterministic tests. Defaults to RealClock. */
  clock?: IBftClock;
  /**
   * Session 54: delay first round start by this many ms. Lets peer
   * mesh establish before round 0 fires, avoiding the early-startup
   * desync that left validators permanently out of sync (since
   * RoundController drops messages from non-current rounds).
   */
  startupDelayMs?: number;
}

export class BftRuntime {
  private readonly driver: BftDriver;

  constructor(config: BftRuntimeConfig) {
    const transport = new PeerManagerBftTransport(config.peerManager);
    const clock = config.clock ?? new RealClock();

    this.driver = new BftDriver({
      transport,
      clock,
      validatorSet: config.validatorSet,
      initialHeight: config.initialHeight,
      proposerSeedFor: config.proposerSeedFor,
      localValidator: config.localValidator,
      blockProviderFor: config.blockProviderFor,
      validateBlockContent: config.validateBlockContent,
      onCommit: config.onCommit,
      onRoundFailed: config.onRoundFailed,
      timeouts: config.timeouts,
      startupDelayMs: config.startupDelayMs,
    });
  }

  start(): void {
    this.driver.start();
  }

  stop(): void {
    this.driver.stop();
  }

  getCurrentHeight(): number {
    return this.driver.getCurrentHeight();
  }

  getCurrentRound(): number {
    return this.driver.getCurrentRound();
  }
}
