// Phase 63: validator economics — per-block fee distribution.
//
// White paper, section 7.5: "The 0.5% transaction fee collected on every
// block is split between the two tiers: 20% to Tier 1 (Node Operators) and
// 80% to Tier 2 (Validators). Within Tier 2: 60% lottery winner, 40% baseline
// divided equally."
//
// This phase tests `distributeFeesPublicLottery` (the production hook), the
// `commitBlockSideEffects` helper that wraps it, and the public-input
// lottery's determinism + idempotency.
//
// The lottery uses `sha256(blockHash || accountId)` to rank miners, lowest
// hash wins. Public-input means every node arrives at the same winner with
// no private-key coordination — required for a multi-node deployment.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import { distributeFeesPublicLottery, commitBlockSideEffects } from '../src/mining/rewards.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function makeMiner(db: DatabaseSync, tier: 1 | 2) {
  const acct = createAccount(db, 'individual', 1, 100);
  // Make sure we have enough earned for any post-distribution checks.
  updateBalance(db, acct.account.id, 'earned_balance', pts(1000));
  const miner = registerMiner(db, acct.account.id);
  if (tier === 2) setMinerTier(db, miner.id, 2, 'test promotion');
  return { accountId: acct.account.id, minerId: miner.id };
}

describe('Phase 63: per-block fee distribution (WP economics)', () => {
  it('distributes 18/72 between Tier 1 and Tier 2 with 10% to treasury (post-Phase 68 defaults)', () => {
    const db = freshDb();
    const t1 = makeMiner(db, 1);
    const t2 = makeMiner(db, 2);
    const totalFees = pts(100);

    const dist = distributeFeesPublicLottery(db, 1, 'block-hash-1', totalFees);
    assert.ok(dist);
    // 18% of 100 to tier 1 = 18 (Phase 68 redirected 2 percentage points to treasury)
    assert.equal(dist!.tier1Pool, pts(18));
    // 72% of 100 to tier 2 = 72 (was 80 before treasury slice)
    assert.equal(dist!.tier2Pool, pts(72));
    // Tier 1 has 1 miner → all 18 pts goes to them on top of starting 1000.
    const t1Acct = getAccount(db, t1.accountId)!;
    assert.equal(t1Acct.earnedBalance, pts(1000) + pts(18));
    // Tier 2 has 1 miner → they win the lottery (only entry) AND get baseline.
    // = full 72 pts on top of 1000.
    const t2Acct = getAccount(db, t2.accountId)!;
    assert.equal(t2Acct.earnedBalance, pts(1000) + pts(72));
    assert.equal(dist!.lotteryWinnerId, t2.minerId);
    db.close();
  });

  it('Tier 2 split: 60% lottery winner, 40% baseline (after treasury slice)', () => {
    const db = freshDb();
    const t2a = makeMiner(db, 2);
    const t2b = makeMiner(db, 2);
    const t2c = makeMiner(db, 2);
    const totalFees = pts(100);

    // No tier 1 miners → all of the miner pool (90 = 100 - 10 treasury) goes
    // to tier 2. Within tier 2: 60% lottery (54), 40% baseline (36) split
    // across 3 miners (~12 each).
    const dist = distributeFeesPublicLottery(db, 1, 'fixed-block-hash', totalFees);
    assert.ok(dist);
    assert.equal(dist!.tier1Pool, 0n);
    assert.equal(dist!.tier2Pool, pts(90));
    assert.equal(dist!.tier2Lottery, pts(54));
    assert.equal(dist!.tier2Baseline, pts(36));

    // Verify the winner got lottery + baseline, others got just baseline.
    const winnerId = dist!.lotteryWinnerId!;
    const baselinePerMiner = pts(36) / 3n; // integer truncation
    const winningPayout = baselinePerMiner + pts(54);
    for (const m of [t2a, t2b, t2c]) {
      const acct = getAccount(db, m.accountId)!;
      const expected = pts(1000) + (m.minerId === winnerId ? winningPayout : baselinePerMiner);
      assert.equal(acct.earnedBalance, expected, `miner ${m.minerId} payout`);
    }
    db.close();
  });

  it('lottery winner is deterministic across calls with the same block hash', () => {
    const db1 = freshDb();
    const db2 = freshDb();
    // Same accountIds in both DBs (deterministic creation order in tests would
    // not produce equal IDs since createAccount generates random keys; we
    // simulate determinism by using the SAME db twice with reset state).
    // Easier: run the lottery twice on the same db (idempotent makes the
    // second a no-op, so use a fresh DB seeded identically by hand).
    for (const db of [db1, db2]) {
      const m1 = makeMiner(db, 2); m1; // for clarity
      const m2 = makeMiner(db, 2); m2;
      const m3 = makeMiner(db, 2); m3;
    }
    // With distinct accountIds in each DB the absolute winner won't match,
    // but for a single DB the lottery must always pick the same miner for
    // a given (blockHash, miner-set) pair — that's the core determinism
    // guarantee. Test that here using a fresh fee_distributions row per
    // blockNumber.
    const a = distributeFeesPublicLottery(db1, 1, 'h-A', pts(100));
    const b = distributeFeesPublicLottery(db1, 2, 'h-A', pts(100));
    assert.equal(a!.lotteryWinnerId, b!.lotteryWinnerId);
    db1.close(); db2.close();
  });

  it('different block hashes can produce different winners', () => {
    const db = freshDb();
    const m1 = makeMiner(db, 2);
    const m2 = makeMiner(db, 2);
    const m3 = makeMiner(db, 2);
    void m1; void m2; void m3;
    // Try several block hashes; at least one pair should pick different
    // winners (probabilistically near-certain with 3 miners and varied
    // hashes).
    const winners = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const dist = distributeFeesPublicLottery(db, i + 1, `h-${i}`, pts(100));
      if (dist?.lotteryWinnerId) winners.add(dist.lotteryWinnerId);
    }
    assert.ok(winners.size >= 2, 'lottery should produce different winners across varied block hashes');
    db.close();
  });

  it('is idempotent: second call on the same blockNumber is a no-op', () => {
    const db = freshDb();
    const t1 = makeMiner(db, 1);
    const t2 = makeMiner(db, 2);
    const totalFees = pts(100);

    distributeFeesPublicLottery(db, 1, 'block-hash', totalFees);
    const t1After = getAccount(db, t1.accountId)!.earnedBalance;
    const t2After = getAccount(db, t2.accountId)!.earnedBalance;

    // Second call MUST not pay out again (every node calls this on commit).
    const second = distributeFeesPublicLottery(db, 1, 'block-hash', totalFees);
    assert.equal(second, null);
    assert.equal(getAccount(db, t1.accountId)!.earnedBalance, t1After);
    assert.equal(getAccount(db, t2.accountId)!.earnedBalance, t2After);
    db.close();
  });

  it('zero fees → no distribution row, no payouts', () => {
    const db = freshDb();
    const t = makeMiner(db, 2);
    const before = getAccount(db, t.accountId)!.earnedBalance;
    const dist = distributeFeesPublicLottery(db, 1, 'h', 0n);
    assert.equal(dist, null);
    assert.equal(getAccount(db, t.accountId)!.earnedBalance, before);
    db.close();
  });

  it('no miners → fees stay in the void (returns null)', () => {
    const db = freshDb();
    const dist = distributeFeesPublicLottery(db, 1, 'h', pts(100));
    assert.equal(dist, null);
    db.close();
  });

  it('only Tier 1 (no Tier 2 yet) → miner pool flows to Tier 1; treasury still gets its slice', () => {
    const db = freshDb();
    const t1a = makeMiner(db, 1);
    const t1b = makeMiner(db, 1);
    const dist = distributeFeesPublicLottery(db, 1, 'h', pts(100));
    assert.ok(dist);
    // Treasury takes 10 off the top, leaving 90 for the miner pool.
    assert.equal(dist!.tier1Pool, pts(90));
    assert.equal(dist!.tier2Pool, 0n);
    // Each Tier 1 miner gets 45 (90 split 2 ways).
    assert.equal(getAccount(db, t1a.accountId)!.earnedBalance, pts(1000) + pts(45));
    assert.equal(getAccount(db, t1b.accountId)!.earnedBalance, pts(1000) + pts(45));
    db.close();
  });

  it('commitBlockSideEffects(genesis) is a no-op', () => {
    const db = freshDb();
    makeMiner(db, 2);
    // Block 0 (genesis) — must skip distribution even if fees would compute.
    commitBlockSideEffects(db, 0, 'genesis-hash');
    const row = db.prepare('SELECT block_number FROM fee_distributions WHERE block_number = 0').get();
    assert.equal(row, undefined);
    db.close();
  });
});
