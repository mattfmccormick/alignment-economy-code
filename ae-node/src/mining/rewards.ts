import { DatabaseSync } from 'node:sqlite';
import { getParam } from '../config/params.js';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { runTransaction } from '../db/connection.js';
import { getFeePool, distributeFromFeePool } from '../core/fee-pool.js';
import { sha256 } from '../core/crypto.js';
import { getActiveMiners } from './registration.js';
import { selectLotteryWinner } from './vrf.js';
import type { FeeDistribution } from './types.js';

const SHARE_SCALE = 10000n;

function scaledShare(total: bigint, share: number): bigint {
  return (total * BigInt(Math.round(share * Number(SHARE_SCALE)))) / SHARE_SCALE;
}

export function distributeFees(
  db: DatabaseSync,
  blockNumber: number,
  totalFees: bigint,
  blockPreviousHash: string,
  minerKeys: Map<string, string>, // minerId -> privateKeyHex (for VRF)
): FeeDistribution | null {
  if (totalFees === 0n) return null;

  // tier2 pool and baseline are derived by subtraction below (tier2Pool =
  // totalFees - tier1Pool; tier2Baseline = tier2Pool - lottery), so only the
  // tier1 and lottery shares need to be read from params.
  const tier1FeeShare = getParam<number>(db, 'mining.tier1_fee_share');
  const tier2LotteryShare = getParam<number>(db, 'mining.tier2_lottery_share');

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
    tier1Pool = scaledShare(totalFees, tier1FeeShare);
    tier2Pool = totalFees - tier1Pool;
  }

  let tier2Lottery = 0n;
  let tier2Baseline = 0n;
  let perTier1 = 0n;
  let perTier2Baseline = 0n;
  let lotteryWinnerId: string | null = null;

  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    // Tier 1 distribution (equal split, remainder to first miner)
    if (tier1Count > 0 && tier1Pool > 0n) {
      perTier1 = tier1Pool / BigInt(tier1Count);
      const tier1Remainder = tier1Pool - perTier1 * BigInt(tier1Count);
      for (let i = 0; i < tier1Miners.length; i++) {
        const miner = tier1Miners[i];
        const payout = perTier1 + (i === 0 ? tier1Remainder : 0n);
        const acct = getAccount(db, miner.accountId)!;
        const newEarned = acct.earnedBalance + payout;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        recordLog(db, miner.accountId, 'fee_distribution', 'earned', payout, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
      }
    }

    // Tier 2 distribution (lottery + baseline)
    if (tier2Count > 0 && tier2Pool > 0n) {
      tier2Lottery = scaledShare(tier2Pool, tier2LotteryShare);
      tier2Baseline = tier2Pool - tier2Lottery;
      perTier2Baseline = tier2Baseline / BigInt(tier2Count);
      const tier2Remainder = tier2Baseline - perTier2Baseline * BigInt(tier2Count);

      // VRF lottery
      const vrfEntries = tier2Miners
        .filter((m) => minerKeys.has(m.id))
        .map((m) => ({ minerId: m.id, privateKeyHex: minerKeys.get(m.id)! }));

      const winner = selectLotteryWinner(vrfEntries, blockPreviousHash);
      lotteryWinnerId = winner?.winnerId ?? null;

      for (let i = 0; i < tier2Miners.length; i++) {
        const miner = tier2Miners[i];
        const acct = getAccount(db, miner.accountId)!;
        let payout = perTier2Baseline + (i === 0 ? tier2Remainder : 0n);
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
 * White paper v2 split: 20% Tier 1, 80% Tier 2.
 * Within Tier 2: 60% lottery winner, 40% baseline split equally.
 *
 * Lottery winner chosen by sha256(blockHash || accountId), lowest hash wins.
 * Idempotent: skips if a fee_distributions row already exists for this block.
 */
export function distributeFeesPublicLottery(
  db: DatabaseSync,
  blockNumber: number,
  blockHash: string,
  totalFees: bigint,
): FeeDistribution | null {
  if (totalFees === 0n) return null;

  const existing = db.prepare(
    'SELECT block_number FROM fee_distributions WHERE block_number = ?',
  ).get(blockNumber) as { block_number: number } | undefined;
  if (existing) return null;

  const tier1FeeShare = getParam<number>(db, 'mining.tier1_fee_share');
  const tier2LotteryShare = getParam<number>(db, 'mining.tier2_lottery_share');

  const tier1Miners = getActiveMiners(db, 1);
  const tier2Miners = getActiveMiners(db, 2);
  const tier1Count = tier1Miners.length;
  const tier2Count = tier2Miners.length;

  if (tier1Count === 0 && tier2Count === 0) return null;

  let tier1Pool: bigint;
  let tier2Pool: bigint;
  if (tier2Count === 0) {
    tier1Pool = totalFees;
    tier2Pool = 0n;
  } else if (tier1Count === 0) {
    tier1Pool = 0n;
    tier2Pool = totalFees;
  } else {
    tier1Pool = scaledShare(totalFees, tier1FeeShare);
    tier2Pool = totalFees - tier1Pool;
  }

  let tier2Lottery = 0n;
  let tier2Baseline = 0n;
  let perTier1 = 0n;
  let perTier2Baseline = 0n;
  let lotteryWinnerId: string | null = null;

  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    if (tier1Count > 0 && tier1Pool > 0n) {
      perTier1 = tier1Pool / BigInt(tier1Count);
      const tier1Remainder = tier1Pool - perTier1 * BigInt(tier1Count);
      for (let i = 0; i < tier1Miners.length; i++) {
        const miner = tier1Miners[i];
        const payout = perTier1 + (i === 0 ? tier1Remainder : 0n);
        const acct = getAccount(db, miner.accountId)!;
        const newEarned = acct.earnedBalance + payout;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        recordLog(db, miner.accountId, 'fee_distribution', 'earned', payout, acct.earnedBalance, newEarned, `block-${blockNumber}`, now);
      }
    }

    if (tier2Count > 0 && tier2Pool > 0n) {
      tier2Lottery = scaledShare(tier2Pool, tier2LotteryShare);
      tier2Baseline = tier2Pool - tier2Lottery;
      perTier2Baseline = tier2Baseline / BigInt(tier2Count);
      const tier2Remainder = tier2Baseline - perTier2Baseline * BigInt(tier2Count);

      let winningHash = '';
      for (const miner of tier2Miners) {
        const h = sha256(`${blockHash}|${miner.accountId}`);
        if (winningHash === '' || h < winningHash) {
          winningHash = h;
          lotteryWinnerId = miner.id;
        }
      }

      for (let i = 0; i < tier2Miners.length; i++) {
        const miner = tier2Miners[i];
        const acct = getAccount(db, miner.accountId)!;
        let payout = perTier2Baseline + (i === 0 ? tier2Remainder : 0n);
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

  // Distribute the whole undistributed pool, not just this block's fees.
  //
  // Using getBlockTotalFees alone stranded money permanently. A block whose
  // fees arrive when no miner is active pays nobody — distributeFeesPublicLottery
  // returns null at the `tier1Count === 0 && tier2Count === 0` guard — and
  // because the amount was scoped to that one block, nothing ever revisited it.
  // The fee had already been taken from the sender by addToFeePool, so those
  // points were removed from circulation and delivered to no one.
  //
  // Observed on the live two-laptop network: 4.75 points collected across four
  // transactions, total_distributed still 0, because the only miner had been
  // deactivated by the bootstrap/tier contradiction fixed alongside this.
  //
  // The pool balance already includes this block's fees (addToFeePool runs
  // during transaction application, before this), so paying out the balance
  // covers the current block and anything previously stranded.
  const pool = getFeePool(db);
  if (pool.currentBalance === 0n) return;

  const paid = distributeFeesPublicLottery(db, blockNumber, blockHash, pool.currentBalance);

  // Draw the pool down by exactly what was paid, and only if a payout happened.
  //
  // The decrement belongs here rather than inside distributeFeesPublicLottery:
  // that function is a pure "pay these miners this amount" and is called
  // directly by tests with amounts no pool backs. Putting the decrement inside
  // it made those calls throw on the balance check.
  //
  // It also has to be conditional. distributeFeesPublicLottery returns null
  // when there is no one to pay (no active miners) or when this block was
  // already distributed — in both cases nothing left any account, so
  // decrementing would destroy the fees a second time, which is the exact bug
  // being fixed.
  //
  // Without the decrement the pool would re-pay the same fees on every
  // subsequent block, turning a stranded-money bug into a money-printing one.
  if (paid !== null) {
    distributeFromFeePool(db, pool.currentBalance);
  }
}
