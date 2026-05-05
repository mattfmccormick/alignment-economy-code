import { DatabaseSync } from 'node:sqlite';
import { getParam } from '../config/params.js';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { runTransaction } from '../db/connection.js';
import { sha256 } from '../core/crypto.js';
import { getActiveMiners } from './registration.js';
import { selectLotteryWinner } from './vrf.js';
import { ensureTreasuryAccount } from '../core/treasury.js';
import type { FeeDistribution } from './types.js';

export function distributeFees(
  db: DatabaseSync,
  blockNumber: number,
  totalFees: bigint,
  blockPreviousHash: string,
  minerKeys: Map<string, string>, // minerId -> privateKeyHex (for VRF)
): FeeDistribution | null {
  if (totalFees === 0n) return null;

  const tier1FeeShare = getParam<number>(db, 'mining.tier1_fee_share');
  const tier2FeeShare = getParam<number>(db, 'mining.tier2_fee_share');
  const tier2LotteryShare = getParam<number>(db, 'mining.tier2_lottery_share');
  const tier2BaselineShare = getParam<number>(db, 'mining.tier2_baseline_share');

  const tier1Miners = getActiveMiners(db, 1);
  const tier2Miners = getActiveMiners(db, 2);

  const tier1Count = tier1Miners.length;
  const tier2Count = tier2Miners.length;

  // If no miners at all, fees stay in pool
  if (tier1Count === 0 && tier2Count === 0) return null;

  let tier1Pool: bigint;
  let tier2Pool: bigint;

  if (tier2Count === 0) {
    // All fees to tier 1
    tier1Pool = totalFees;
    tier2Pool = 0n;
  } else if (tier1Count === 0) {
    // All fees to tier 2
    tier1Pool = 0n;
    tier2Pool = totalFees;
  } else {
    tier1Pool = BigInt(Math.floor(Number(totalFees) * tier1FeeShare));
    tier2Pool = totalFees - tier1Pool;
  }

  let tier2Lottery = 0n;
  let tier2Baseline = 0n;
  let perTier1 = 0n;
  let perTier2Baseline = 0n;
  let lotteryWinnerId: string | null = null;

  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    // Tier 1 distribution (equal split)
    if (tier1Count > 0 && tier1Pool > 0n) {
      perTier1 = tier1Pool / BigInt(tier1Count);
      for (const miner of tier1Miners) {
        const acct = getAccount(db, miner.accountId)!;
        const newEarned = acct.earnedBalance + perTier1;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        recordLog(db, miner.accountId, 'fee_distribution', 'earned', perTier1, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
      }
    }

    // Tier 2 distribution (lottery + baseline)
    if (tier2Count > 0 && tier2Pool > 0n) {
      tier2Lottery = BigInt(Math.floor(Number(tier2Pool) * tier2LotteryShare));
      tier2Baseline = tier2Pool - tier2Lottery;
      perTier2Baseline = tier2Baseline / BigInt(tier2Count);

      // VRF lottery
      const vrfEntries = tier2Miners
        .filter((m) => minerKeys.has(m.id))
        .map((m) => ({ minerId: m.id, privateKeyHex: minerKeys.get(m.id)! }));

      const winner = selectLotteryWinner(vrfEntries, blockPreviousHash);
      lotteryWinnerId = winner?.winnerId ?? null;

      for (const miner of tier2Miners) {
        const acct = getAccount(db, miner.accountId)!;
        let payout = perTier2Baseline;
        if (miner.id === lotteryWinnerId) {
          payout += tier2Lottery;
        }
        const newEarned = acct.earnedBalance + payout;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        recordLog(db, miner.accountId, 'fee_distribution', 'earned', payout, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
      }
    }
  });

  const dist: FeeDistribution = {
    blockNumber, totalFees, tier1Pool, tier2Pool, tier2Lottery, tier2Baseline,
    lotteryWinnerId, tier1MinerCount: tier1Count, tier2MinerCount: tier2Count,
    perTier1Miner: perTier1, perTier2MinerBaseline: perTier2Baseline,
  };

  // Store distribution record
  db.prepare(
    `INSERT INTO fee_distributions (block_number, total_fees, tier1_pool, tier2_pool, tier2_lottery, tier2_baseline,
     lottery_winner_id, tier1_miner_count, tier2_miner_count, per_tier1_miner, per_tier2_miner_baseline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    blockNumber, totalFees.toString(), tier1Pool.toString(), tier2Pool.toString(),
    tier2Lottery.toString(), tier2Baseline.toString(), lotteryWinnerId,
    tier1Count, tier2Count, perTier1.toString(), perTier2Baseline.toString(),
  );

  return dist;
}

/**
 * Production fee-distribution path used at block-commit time.
 *
 * Distributes the fees collected on a single block to all active miners using
 * the white-paper split:
 *   - 20% Tier 1 (operators), divided equally among all Tier 1 miners
 *   - 80% Tier 2 (validators), of which:
 *     - 60% to a single deterministic lottery winner
 *     - 40% baseline, divided equally among all Tier 2 miners
 *
 * Differs from `distributeFees` above in that it does NOT need each miner's
 * private VRF key. Instead the lottery winner is chosen by ranking miners by
 * `sha256(blockHash || minerAccountId)` and picking the LOWEST hash. This is
 * publicly verifiable (anyone with the block hash can reproduce the rank), so
 * every node arrives at the same winner without coordinating private inputs.
 *
 * Trade-off: a miner with influence over the block hash (e.g. the proposer)
 * has slight grinding influence over who wins. The proposer can re-roll their
 * own block content to bias outcomes. Acceptable in the short term — the
 * Phase 3 ECVRF roadmap replaces this with on-chain VRF proofs that close
 * the grinding window. Until then, this function is the WP-spec
 * implementation that actually works in a multi-node deployment.
 *
 * Idempotent: if a fee_distributions row already exists for this block, the
 * function returns the existing record without re-paying. This is essential
 * because every node (producer + followers) calls this on block commit, and
 * the followers must reach the same balances as the producer.
 */
export function distributeFeesPublicLottery(
  db: DatabaseSync,
  blockNumber: number,
  blockHash: string,
  totalFees: bigint,
): FeeDistribution | null {
  if (totalFees === 0n) return null;

  // Idempotency check.
  const existing = db.prepare(
    'SELECT block_number FROM fee_distributions WHERE block_number = ?',
  ).get(blockNumber) as { block_number: number } | undefined;
  if (existing) return null;

  const tier1FeeShare = getParam<number>(db, 'mining.tier1_fee_share');
  const tier2LotteryShare = getParam<number>(db, 'mining.tier2_lottery_share');
  const treasuryFeeShare = getParam<number>(db, 'treasury.fee_share');

  // Treasury cut comes off the top regardless of miner counts. If
  // treasuryFeeShare is 0 the treasury account isn't even created and
  // this slice falls through to the existing tier1/tier2 path. A genuine
  // misconfiguration (negative share, > 1, etc.) downgrades to 0 so
  // a bad governance change can't burn the whole fee pool.
  let treasuryPool = 0n;
  let treasuryAccountId: string | null = null;
  if (treasuryFeeShare > 0 && treasuryFeeShare < 1) {
    treasuryPool = BigInt(Math.floor(Number(totalFees) * treasuryFeeShare));
    if (treasuryPool > 0n) {
      treasuryAccountId = ensureTreasuryAccount(db);
    }
  }
  const minerPool = totalFees - treasuryPool;

  const tier1Miners = getActiveMiners(db, 1);
  const tier2Miners = getActiveMiners(db, 2);
  const tier1Count = tier1Miners.length;
  const tier2Count = tier2Miners.length;

  if (tier1Count === 0 && tier2Count === 0) {
    // No miners. The miner pool would burn; treasury still receives
    // its slice if configured. Insert the distribution row so we can
    // see exactly what happened post-block.
    if (treasuryPool > 0n && treasuryAccountId) {
      runTransaction(db, () => {
        const acct = getAccount(db, treasuryAccountId)!;
        const newEarned = acct.earnedBalance + treasuryPool;
        updateBalance(db, treasuryAccountId, 'earned_balance', newEarned);
        recordLog(db, treasuryAccountId, 'fee_distribution', 'earned', treasuryPool, acct.earnedBalance, newEarned, `block-${blockNumber}`, Math.floor(Date.now() / 1000));
      });
    }
    return null;
  }

  let tier1Pool: bigint;
  let tier2Pool: bigint;
  if (tier2Count === 0) {
    // No tier 2 yet — bootstrap phase. Everything (after treasury) to tier 1.
    tier1Pool = minerPool;
    tier2Pool = 0n;
  } else if (tier1Count === 0) {
    tier1Pool = 0n;
    tier2Pool = minerPool;
  } else {
    // tier1FeeShare is expressed as a fraction of TOTAL fees in the
    // params, but the treasury slice already came out, so re-scale to
    // make the tier1 share land on the same total fraction the operator
    // expects (params describe the global split, not the post-treasury
    // remainder). Concretely: tier1=0.18, treasury=0.10, tier2=0.72;
    // tier1Pool/totalFees == 0.18 still holds.
    tier1Pool = BigInt(Math.floor(Number(totalFees) * tier1FeeShare));
    if (tier1Pool > minerPool) tier1Pool = minerPool;
    tier2Pool = minerPool - tier1Pool;
  }

  let tier2Lottery = 0n;
  let tier2Baseline = 0n;
  let perTier1 = 0n;
  let perTier2Baseline = 0n;
  let lotteryWinnerId: string | null = null;

  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    // Treasury credit first. Recorded with change_type 'fee_distribution'
    // and reference 'block-N' so historical sync replays it consistently.
    if (treasuryPool > 0n && treasuryAccountId) {
      const acct = getAccount(db, treasuryAccountId)!;
      const newEarned = acct.earnedBalance + treasuryPool;
      updateBalance(db, treasuryAccountId, 'earned_balance', newEarned);
      recordLog(db, treasuryAccountId, 'fee_distribution', 'earned', treasuryPool, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
    }

    if (tier1Count > 0 && tier1Pool > 0n) {
      perTier1 = tier1Pool / BigInt(tier1Count);
      for (const miner of tier1Miners) {
        const acct = getAccount(db, miner.accountId)!;
        const newEarned = acct.earnedBalance + perTier1;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        recordLog(db, miner.accountId, 'fee_distribution', 'earned', perTier1, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
      }
    }

    if (tier2Count > 0 && tier2Pool > 0n) {
      tier2Lottery = BigInt(Math.floor(Number(tier2Pool) * tier2LotteryShare));
      tier2Baseline = tier2Pool - tier2Lottery;
      perTier2Baseline = tier2Baseline / BigInt(tier2Count);

      // Public-input lottery: rank miners by sha256(blockHash || accountId),
      // lowest hash wins. Deterministic across every node that processes this
      // block — no private keys needed.
      let winningHash = '';
      for (const miner of tier2Miners) {
        const h = sha256(`${blockHash}|${miner.accountId}`);
        if (winningHash === '' || h < winningHash) {
          winningHash = h;
          lotteryWinnerId = miner.id;
        }
      }

      for (const miner of tier2Miners) {
        const acct = getAccount(db, miner.accountId)!;
        let payout = perTier2Baseline;
        if (miner.id === lotteryWinnerId) payout += tier2Lottery;
        const newEarned = acct.earnedBalance + payout;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        recordLog(db, miner.accountId, 'fee_distribution', 'earned', payout, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
      }
    }

    db.prepare(
      `INSERT INTO fee_distributions (block_number, total_fees, tier1_pool, tier2_pool, tier2_lottery, tier2_baseline,
       lottery_winner_id, tier1_miner_count, tier2_miner_count, per_tier1_miner, per_tier2_miner_baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      blockNumber, totalFees.toString(), tier1Pool.toString(), tier2Pool.toString(),
      tier2Lottery.toString(), tier2Baseline.toString(), lotteryWinnerId,
      tier1Count, tier2Count, perTier1.toString(), perTier2Baseline.toString(),
    );
  });

  return {
    blockNumber, totalFees, tier1Pool, tier2Pool, tier2Lottery, tier2Baseline,
    lotteryWinnerId, tier1MinerCount: tier1Count, tier2MinerCount: tier2Count,
    perTier1Miner: perTier1, perTier2MinerBaseline: perTier2Baseline,
  };
}

/**
 * Sum the fees collected on every transaction in a given block. Reads from
 * the transaction_log table where change_type='fee'. Returns 0n if the block
 * had no fee-bearing transactions (genesis, empty blocks, all-zero spends
 * from 0%-verified accounts under Option B).
 */
export function getBlockTotalFees(db: DatabaseSync, blockNumber: number): bigint {
  const rows = db.prepare(
    `SELECT tl.amount
     FROM transaction_log tl
     JOIN transactions t ON t.id = tl.reference_id
     WHERE t.block_number = ? AND tl.change_type = 'fee'`,
  ).all(blockNumber) as Array<{ amount: string }>;
  let total = 0n;
  for (const r of rows) total += BigInt(r.amount);
  return total;
}

/**
 * Run all post-commit side effects for a freshly committed block. Today this
 * is just fee distribution; future side effects (e.g., evidence-decay tick,
 * scheduled smart-contract executions) plug in here.
 *
 * MUST be called by every node — producer and follower — right after the
 * block is inserted into the local store, so all nodes derive byte-identical
 * post-block state. Idempotent: distributeFeesPublicLottery short-circuits
 * if a fee_distributions row already exists for this block.
 *
 * Skips the genesis block (block 0 has no fees and the call paths that build
 * genesis don't go through this helper anyway).
 */
export function commitBlockSideEffects(
  db: DatabaseSync,
  blockNumber: number,
  blockHash: string,
): void {
  if (blockNumber === 0) return;
  const totalFees = getBlockTotalFees(db, blockNumber);
  if (totalFees > 0n) {
    distributeFeesPublicLottery(db, blockNumber, blockHash, totalFees);
  }
}
