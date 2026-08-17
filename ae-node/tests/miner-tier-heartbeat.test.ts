// Miner uptime is measured, and tiers actually move.
//
// Two orphans, one broken mechanism. recordHeartbeat carried a comment saying
// "the protocol records a heartbeat every block" and nothing called it, so
// countHeartbeatsSince always returned 0 and calculateUptime always returned
// 0%. Uptime was not a low number, it was an unmeasured one. evaluateMinerTier
// then had no production caller either, so a miner's tier stayed whatever it
// was at registration forever — nobody promoted for doing the work well,
// nobody demoted for going dark.
//
// That matters beyond bookkeeping: tier 2 is who gets seated on juries, so an
// inert tier system means jury composition never reflects conduct.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier, getMiner, miningStore } from '../src/mining/registration.js';
import { recordHeartbeat, calculateUptime } from '../src/mining/heartbeat.js';
import { runMinerTierEvaluation } from '../src/mining/tiers.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

function miner(db: DatabaseSync, tier: 1 | 2 = 1) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(5_000));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

/** Backfill `count` heartbeats one interval apart, ending now. */
function heartbeatHistory(db: DatabaseSync, minerId: string, count: number, intervalSec = 60) {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    miningStore(db).insertHeartbeat(minerId, 0, now - i * intervalSec);
  }
}

describe('miner uptime is actually measured', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a heartbeat is recorded and counted', () => {
    const m = miner(db);
    // Window of one hour: 60 heartbeats expected at the 60s default interval.
    assert.equal(calculateUptime(db, m.minerId, 3600), 0, 'no pings yet');

    recordHeartbeat(db, m.minerId, 1);
    const after = calculateUptime(db, m.minerId, 3600);
    assert.ok(after > 0, `one ping must register, got ${after}%`);
    db.close();
  });

  it('a miner pinging on schedule reaches full uptime', () => {
    const m = miner(db);
    heartbeatHistory(db, m.minerId, 60); // a full hour of minute pings
    assert.equal(calculateUptime(db, m.minerId, 3600), 100);
    db.close();
  });
});

describe('miner tiers move on the rolling window', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('demotes a tier-2 miner who has gone dark', () => {
    setParam(db, 'mining.rolling_window_days', 1, undefined, undefined, true);
    const dark = miner(db, 2);
    // No heartbeats at all: uptime 0%, well under the 90% tier-1 threshold.

    const out = runMinerTierEvaluation(db);

    assert.equal(getMiner(db, dark.minerId)!.tier, 1, 'going dark must cost tier 2');
    assert.ok(out.changed.some((c) => c.minerId === dark.minerId));
    assert.match(out.changed[0].reason, /uptime/i);
    db.close();
  });

  it('promotes a tier-1 miner who meets every requirement', () => {
    setParam(db, 'mining.rolling_window_days', 1, undefined, undefined, true);
    const good = miner(db, 1);
    // A full day of minute-interval pings => 100% uptime. No assignments and
    // no jury calls yet, which both count as clean rather than as failures.
    heartbeatHistory(db, good.minerId, 1440);

    runMinerTierEvaluation(db);

    assert.equal(
      getMiner(db, good.minerId)!.tier,
      2,
      'a miner meeting every tier-2 requirement must actually be promoted',
    );
    db.close();
  });

  it('one miner failing does not stop the rest of the network', () => {
    setParam(db, 'mining.rolling_window_days', 1, undefined, undefined, true);
    const a = miner(db, 2);
    const b = miner(db, 2);

    const out = runMinerTierEvaluation(db);

    assert.equal(out.failed, 0);
    assert.equal(out.evaluated, 2, 'every active miner is evaluated');
    assert.equal(getMiner(db, a.minerId)!.tier, 1);
    assert.equal(getMiner(db, b.minerId)!.tier, 1);
    db.close();
  });

  it('prunes heartbeats that have fallen out of the retention window', () => {
    setParam(db, 'mining.rolling_window_days', 1, undefined, undefined, true);
    const m = miner(db);
    const now = Math.floor(Date.now() / 1000);
    // One recent, one far outside 2x the window.
    miningStore(db).insertHeartbeat(m.minerId, 0, now - 60);
    miningStore(db).insertHeartbeat(m.minerId, 0, now - 10 * 86400);

    runMinerTierEvaluation(db);

    const kept = miningStore(db).countHeartbeatsSince(m.minerId, 0);
    assert.equal(kept, 1, 'heartbeats are append-only; without pruning the table grows forever');
    db.close();
  });
});
