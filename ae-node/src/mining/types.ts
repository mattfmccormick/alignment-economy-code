export interface Miner {
  id: string;
  accountId: string;
  tier: 1 | 2;
  isActive: boolean;
  registeredAt: number;
  deactivatedAt: number | null;
  /**
   * Admitted below the percentHuman floor under the bootstrap exemption, and
   * has not yet reached that floor on their own.
   *
   * While this is true the tier evaluator will not deactivate them for a low
   * score. Without it, evaluation immediately revoked the exemption that
   * registration had just granted, and the miner app reported only "Not
   * registered as a miner" with no mention of a score or a way back.
   */
  bootstrapAdmitted?: boolean;
}

export interface MinerHeartbeat {
  minerId: string;
  timestamp: number;
  blockHeight: number;
}

export interface TierChange {
  id: string;
  minerId: string;
  fromTier: 1 | 2;
  toTier: 1 | 2;
  reason: string;
  timestamp: number;
}

export interface FeeDistribution {
  blockNumber: number;
  totalFees: bigint;
  tier1Pool: bigint;
  tier2Pool: bigint;
  tier2Lottery: bigint;
  tier2Baseline: bigint;
  lotteryWinnerId: string | null;
  tier1MinerCount: number;
  tier2MinerCount: number;
  perTier1Miner: bigint;
  perTier2MinerBaseline: bigint;
}
