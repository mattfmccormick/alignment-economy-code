// Consensus protocol interface.
//
// The consensus engine answers three questions for the block producer:
//   1. May I produce the next block? (canProduceBlock)
//   2. Is a block I received from a peer signed by a valid producer? (validateBlockProducer)
//   3. When two chains diverge, which one wins? (resolveConflict)
// Plus three observability questions for clients and validators:
//   4. What height is finalized (irreversible)?
//   5. Who is in the validator set right now?
//   6. What's the minimum vote count for a block to be considered finalized?
//
// Two implementations live behind this interface:
//   - AuthorityConsensus (Phase 1, present): exactly one authority node may
//     produce blocks. Validator set has one member. Quorum is 1. Every block
//     is final the moment the authority signs it. Conflict resolution: the
//     authority's chain always wins.
//   - BFTConsensus (Phase 3, future): N validators with stake-weighted
//     voting. Quorum is 2/3+. Finality requires a quorum of signed precommits.
//     Conflict resolution follows the longest finalized chain.
//
// Adding the Phase-3 methods now (finalizedHeight, validatorSet, quorumSize)
// gives us a stable shape so the eventual BFTConsensus drops in without
// changing call sites in the runner, sync, or API layers.

export interface IConsensusEngine {
  /** Can this local node produce the next block right now? */
  canProduceBlock(): boolean;

  /**
   * Validate that the producer of a received block is allowed under current consensus.
   *
   * @param blockProducerId  the friendly nodeId claimed in the block's transport envelope
   * @param producerPublicKey  the cryptographic publicKey that signed the transport
   *                           envelope. When the engine has been configured with the
   *                           expected authority publicKey, this binding is enforced —
   *                           defeating "spoof the nodeId string" attacks.
   *
   * Implementations should accept a missing publicKey only in test/legacy mode.
   */
  validateBlockProducer(blockProducerId: string, producerPublicKey?: string): boolean;

  /** When two chains have diverged, return which side wins ('A' or 'B'). */
  resolveConflict(heightA: number, heightB: number): 'A' | 'B';

  /**
   * The latest block height that consensus considers final (cannot be reverted).
   * - Authority: equals chain head (every block is instantly final).
   * - BFT: lags the head by however long it takes for 2/3+ precommits to land.
   */
  finalizedHeight(): number;

  /**
   * The current validator set, as account / node identifiers.
   * - Authority: a single-member set [authorityNodeId].
   * - BFT: every account that has staked and met the validator threshold.
   */
  validatorSet(): string[];

  /**
   * Minimum number of validator signatures for a block to be considered
   * committed. For authority that's 1; for BFT it's ceil(2/3 * |validatorSet|).
   */
  quorumSize(): number;

  // ── Convenience methods preserved from AuthorityConsensus's public surface
  //     so existing callers (runner.ts, etc.) don't have to change. ──

  /** True iff this local node is currently authorized to produce blocks. */
  isAuthority(): boolean;

  /** The single authority's id. For BFT, returns the current proposer (rotating). */
  getAuthorityId(): string;
}
