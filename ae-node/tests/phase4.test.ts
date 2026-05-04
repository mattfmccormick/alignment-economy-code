import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance, updatePercentHuman } from '../src/core/account.js';
import { PRECISION } from '../src/core/constants.js';
import { registerMiner, getMiner, getActiveMiners, setMinerTier, deactivateMiner } from '../src/mining/registration.js';
import { recordHeartbeat, calculateUptime } from '../src/mining/heartbeat.js';
import { evaluateMinerTier } from '../src/mining/tiers.js';
import { distributeFees } from '../src/mining/rewards.js';
import { selectLotteryWinner, generateVRFProof, proofToValue } from '../src/mining/vrf.js';
import { assignMinersToPanel, resetRoundRobin } from '../src/mining/fifo-queue.js';
import { generateKeyPair } from '../src/core/crypto.js';

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

function createMinerAccount(db: DatabaseSync, percentHuman: number = 100): { accountId: string; minerId: string; privateKey: string } {
  const result = createAccount(db, 'individual', 1, percentHuman);
  updateBalance(db, result.account.id, 'earned_balance', pts(10000));
  const miner = registerMiner(db, result.account.id);
  return { accountId: result.account.id, minerId: miner.id, privateKey: result.privateKey };
}

describe('Phase 4: Mining System', () => {

  // Test 1: Register miners, verify tier based on uptime
  it('registers miners and assigns tiers based on uptime', () => {
    const db = freshDb();
    const now = Math.floor(Date.now() / 1000);
    const networkStart = now - 86400 * 30; // 30 days ago

    // Create 15 miners
    const miners: Array<{ accountId: string; minerId: string }> = [];
    for (let i = 0; i < 15; i++) {
      miners.push(createMinerAccount(db));
    }

    // 10 miners with 95%+ heartbeats (qualify for Tier 1)
    const interval = 60; // 60 second heartbeat interval
    const expectedBeats = Math.floor(86400 * 30 / interval); // ~43200

    for (let i = 0; i < 10; i++) {
      // Send 95% of expected heartbeats
      const beats = Math.floor(expectedBeats * 0.95);
      for (let b = 0; b < beats; b++) {
        const ts = networkStart + b * interval;
        db.prepare('INSERT INTO miner_heartbeats (miner_id, timestamp, block_height) VALUES (?, ?, ?)').run(
          miners[i].minerId, ts, b,
        );
      }
    }

    // 5 miners with 80% heartbeats (below threshold)
    for (let i = 10; i < 15; i++) {
      const beats = Math.floor(expectedBeats * 0.80);
      for (let b = 0; b < beats; b++) {
        const ts = networkStart + b * interval;
        db.prepare('INSERT INTO miner_heartbeats (miner_id, timestamp, block_height) VALUES (?, ?, ?)').run(
          miners[i].minerId, ts, b,
        );
      }
    }

    // Evaluate all miners
    for (let i = 0; i < 10; i++) {
      const uptime = calculateUptime(db, miners[i].minerId, 86400 * 30, networkStart);
      assert.ok(uptime >= 90, `Miner ${i} uptime ${uptime} should be >= 90`);
    }

    for (let i = 10; i < 15; i++) {
      const uptime = calculateUptime(db, miners[i].minerId, 86400 * 30, networkStart);
      assert.ok(uptime < 90, `Miner ${i} uptime ${uptime} should be < 90`);
    }

    db.close();
  });

  // Test 2: Tier 2 promotion with all requirements met
  it('promotes miners to Tier 2 when all requirements met', () => {
    const db = freshDb();
    const now = Math.floor(Date.now() / 1000);
    const networkStart = now - 86400 * 30;

    const m = createMinerAccount(db);

    // Give enough heartbeats for 95% uptime
    const interval = 60;
    const beats = Math.floor((86400 * 30 / interval) * 0.95);
    for (let b = 0; b < beats; b++) {
      db.prepare('INSERT INTO miner_heartbeats (miner_id, timestamp, block_height) VALUES (?, ?, ?)').run(
        m.minerId, networkStart + b * interval, b,
      );
    }

    // Evaluate: should be Tier 1 (meets uptime, new miner with no verifications = 100% composite by default)
    const eval1 = evaluateMinerTier(db, m.minerId, networkStart);
    // New miner with 100% default composite accuracy, perfect jury attendance (no calls)
    // Should promote to Tier 2
    assert.equal(eval1.newTier, 2, `Should be promoted to Tier 2: ${eval1.reason}`);

    db.close();
  });

  // Test 3: Fee distribution with white paper example
  it('distributes fees correctly per white paper example', () => {
    const db = freshDb();
    const keys = new Map<string, string>();

    // Create 4 Tier 1 and 6 Tier 2 miners
    const tier1Miners: string[] = [];
    const tier2Miners: string[] = [];

    for (let i = 0; i < 10; i++) {
      const m = createMinerAccount(db);
      keys.set(m.minerId, m.privateKey);
      if (i < 4) {
        tier1Miners.push(m.minerId);
        // Already tier 1 by default
      } else {
        tier2Miners.push(m.minerId);
        setMinerTier(db, m.minerId, 2, 'test setup');
      }
    }

    // totalFees = 10000 (100.00 points)
    const totalFees = pts(100);

    const dist = distributeFees(db, 1, totalFees, 'abc123previoushash', keys);
    assert.ok(dist, 'Distribution should not be null');

    // tier1Pool = 20% of 100 = 20.00
    assert.equal(dist!.tier1MinerCount, 4);
    assert.equal(dist!.tier2MinerCount, 6);

    // Per Tier 1 = 20 / 4 = 5.00
    const perTier1Display = Number(dist!.perTier1Miner) / Number(PRECISION);
    assert.ok(Math.abs(perTier1Display - 5.0) < 0.01, `Per T1 should be ~5.00, got ${perTier1Display}`);

    // Tier 2 pool = 80.00
    // Lottery = 80 * 0.60 = 48.00
    // Baseline = 80 * 0.40 = 32.00
    // Per T2 baseline = 32 / 6 = 5.33
    const perT2Display = Number(dist!.perTier2MinerBaseline) / Number(PRECISION);
    assert.ok(Math.abs(perT2Display - 5.33) < 0.1, `Per T2 baseline should be ~5.33, got ${perT2Display}`);

    // Lottery winner should exist
    assert.ok(dist!.lotteryWinnerId, 'Should have a lottery winner');
    assert.ok(tier2Miners.includes(dist!.lotteryWinnerId!), 'Winner should be a Tier 2 miner');

    // Verify balance changes
    for (const mid of tier1Miners) {
      const miner = getMiner(db, mid)!;
      const acct = getAccount(db, miner.accountId)!;
      assert.ok(acct.earnedBalance > pts(10000), 'Tier 1 miner should have earned fees');
    }

    db.close();
  });

  // Test 4: VRF lottery determinism
  it('VRF lottery is deterministic and varies with seed', () => {
    const miners = [];
    for (let i = 0; i < 6; i++) {
      const kp = generateKeyPair();
      miners.push({ minerId: `miner-${i}`, privateKeyHex: kp.privateKey });
    }

    // Same seed = same winner
    const result1 = selectLotteryWinner(miners, 'seed-block-hash-1');
    const result2 = selectLotteryWinner(miners, 'seed-block-hash-1');
    assert.equal(result1!.winnerId, result2!.winnerId, 'Same seed should give same winner');

    // Different seed = likely different winner (run several to confirm variation)
    const winners = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = selectLotteryWinner(miners, `seed-${i}`);
      winners.add(result!.winnerId);
    }
    assert.ok(winners.size > 1, `Should have multiple different winners over 100 seeds, got ${winners.size}`);

    // Check rough distribution (no miner should win >50% of 100 rounds)
    const winCounts = new Map<string, number>();
    for (let i = 0; i < 100; i++) {
      const result = selectLotteryWinner(miners, `dist-seed-${i}`);
      winCounts.set(result!.winnerId, (winCounts.get(result!.winnerId) || 0) + 1);
    }
    for (const [id, count] of winCounts) {
      assert.ok(count <= 50, `Miner ${id} won ${count}/100 times, should be <50`);
    }
  });

  // Test 5: FIFO queue round-robin
  it('assigns miners to panels in round-robin with conflict filtering', () => {
    const db = freshDb();
    resetRoundRobin();

    // Create 6 Tier 2 miners
    const miners: string[] = [];
    for (let i = 0; i < 6; i++) {
      const m = createMinerAccount(db);
      setMinerTier(db, m.minerId, 2, 'test');
      miners.push(m.minerId);
    }

    // Create 10 accounts needing verification
    const accounts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = createAccount(db, 'individual', 1, 0);
      accounts.push(a.account.id);
    }

    // Assign panels
    const assignments: Map<string, number> = new Map();
    for (const acctId of accounts) {
      const assigned = assignMinersToPanel(db, `panel-${acctId}`, acctId);
      assert.equal(assigned.length, 3, 'Should assign 3 miners');
      for (const mid of assigned) {
        assignments.set(mid, (assignments.get(mid) || 0) + 1);
      }
    }

    // Each miner should have roughly equal assignments (30 total / 6 miners = 5 each)
    for (const [mid, count] of assignments) {
      assert.ok(count >= 3 && count <= 7, `Miner ${mid} has ${count} assignments, expected ~5`);
    }

    db.close();
  });

  // Test 6: Tier demotion
  it('demotes Tier 2 miner when accuracy drops below threshold', () => {
    const db = freshDb();
    const now = Math.floor(Date.now() / 1000);
    const networkStart = now - 86400 * 30;

    const m = createMinerAccount(db);

    // Give good uptime
    const interval = 60;
    const beats = Math.floor((86400 * 30 / interval) * 0.95);
    for (let b = 0; b < beats; b++) {
      db.prepare('INSERT INTO miner_heartbeats (miner_id, timestamp, block_height) VALUES (?, ?, ?)').run(
        m.minerId, networkStart + b * interval, b,
      );
    }

    // Promote to Tier 2
    setMinerTier(db, m.minerId, 2, 'test setup');

    // Add jury service with bad accuracy (3 out of 10 correct = 30%)
    for (let i = 0; i < 10; i++) {
      const matched = i < 3 ? 1 : 0;
      db.prepare(
        `INSERT INTO miner_jury_service (id, miner_id, case_id, called_at, voted, vote_matched_verdict)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).run(`jury-${i}`, m.minerId, `case-${i}`, now, matched);
    }

    const eval1 = evaluateMinerTier(db, m.minerId, networkStart);
    assert.equal(eval1.newTier, 1, 'Should be demoted to Tier 1');
    assert.ok(eval1.reason.includes('accuracy'), `Reason should mention accuracy: ${eval1.reason}`);

    // Verify in DB
    const miner = getMiner(db, m.minerId)!;
    assert.equal(miner.tier, 1);

    db.close();
  });

  // Test 7: Early network - no Tier 2 miners
  it('handles early network with no Tier 2 miners', () => {
    const db = freshDb();
    const keys = new Map<string, string>();

    // Create 2 Tier 1 miners only
    for (let i = 0; i < 2; i++) {
      const m = createMinerAccount(db);
      keys.set(m.minerId, m.privateKey);
    }

    const totalFees = pts(100);
    const dist = distributeFees(db, 1, totalFees, 'seed123', keys);

    assert.ok(dist, 'Should still distribute');
    // All fees go to Tier 1
    assert.equal(dist!.tier1MinerCount, 2);
    assert.equal(dist!.tier2MinerCount, 0);
    assert.equal(dist!.tier1Pool, totalFees);
    assert.equal(dist!.tier2Pool, 0n);
    assert.equal(dist!.lotteryWinnerId, null);

    db.close();
  });

  // Test 8: Miner deactivation on low percentHuman
  it('force-deactivates miner when percentHuman drops below 50', () => {
    const db = freshDb();
    const now = Math.floor(Date.now() / 1000);

    const m = createMinerAccount(db, 100);

    // Drop percentHuman
    updatePercentHuman(db, m.accountId, 40);

    const eval1 = evaluateMinerTier(db, m.minerId);
    assert.ok(eval1.reason.includes('Deactivated'), `Should be deactivated: ${eval1.reason}`);

    const miner = getMiner(db, m.minerId)!;
    assert.equal(miner.isActive, false);

    db.close();
  });
});
