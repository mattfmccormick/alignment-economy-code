// Phase 46: Chain-driven day cycle (BFT mode).
//
// In Authority mode the day cycle fires from the runner's wall-clock
// setTimeout. That doesn't work in BFT mode: every validator has its own
// setTimeout firing at slightly different times, so they'd each apply
// expire/rebase/mint to their local DB at different points relative to
// other transactions. State diverges and the chain falls apart.
//
// Fix: drive the cycle off block timestamps, not wall clocks. After each
// committed block, every validator runs the same predicate over
// (block.timestamp, cycleState, nextCycleAt) and applies the cycle
// deterministically. Identical inputs → identical state.
//
// Verified:
//   1. shouldTriggerExpireAndRebase: phase guard + threshold semantics
//   2. shouldTriggerMintAndAdvance: phase=between_cycles + 60s blackout
//   3. applyChainDayCycle first-call bootstrap: anchors nextCycleAt,
//      doesn't fire any phase
//   4. Pre-anchor block: predicates correctly say "not yet"
//   5. Single block crossing 08:59: expire+rebase fires; phase becomes
//      between_cycles; nextCycleAt is unchanged (the schedule advances
//      only on mint+advance)
//   6. Block timestamp past 08:59 + 60s: expire+rebase + mint+advance
//      both fire in one call, currentDay increments, nextCycleAt += 86400
//   7. Idempotent: applyChainDayCycle on the same timestamp twice
//      doesn't double-mint
//   8. Multi-day catch-up: a single block timestamp 3 days in the
//      future advances 3 full cycles
//   9. Determinism: two parallel DBs with identical starting state run
//      through identical block timestamps and end in identical state
//      (the property the entire BFT-mode design rests on)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import {
  applyChainDayCycle,
  shouldTriggerExpireAndRebase,
  shouldTriggerMintAndAdvance,
  getCycleState,
  getNextCycleAt,
  setNextCycleAt,
} from '../src/core/day-cycle.js';
import {
  DAILY_ACTIVE_POINTS,
  DAILY_SUPPORTIVE_POINTS,
  DAILY_AMBIENT_POINTS,
} from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

/**
 * Stand up a fresh DB with `n` verified individual accounts ready to
 * receive daily allocations. Each account starts at percentHuman=100
 * so they qualify as active participants for mint/rebase math.
 */
function freshDbWithVerified(n: number): DatabaseSync {
  const db = freshDb();
  for (let i = 0; i < n; i++) {
    createAccount(db, 'individual', 1, 100);
  }
  return db;
}

/** A picked unix-second timestamp at exactly 08:59:00 UTC on 2026-05-01. */
const ANCHOR = Math.floor(Date.UTC(2026, 4, 1, 8, 59, 0) / 1000); // 1761987540

describe('Phase 46: Chain-driven day cycle', () => {
  // ── Predicates ───────────────────────────────────────────────────────

  it('shouldTriggerExpireAndRebase: phase guard rejects expiring/rebasing/between/minting', () => {
    const ts = ANCHOR + 1;
    const at = ANCHOR;
    assert.equal(shouldTriggerExpireAndRebase(ts, 'active', at), true);
    assert.equal(shouldTriggerExpireAndRebase(ts, 'idle', at), true);
    assert.equal(shouldTriggerExpireAndRebase(ts, 'expiring', at), false);
    assert.equal(shouldTriggerExpireAndRebase(ts, 'rebasing', at), false);
    assert.equal(shouldTriggerExpireAndRebase(ts, 'between_cycles', at), false);
    assert.equal(shouldTriggerExpireAndRebase(ts, 'minting', at), false);
  });

  it('shouldTriggerExpireAndRebase: timestamp threshold is inclusive at the anchor', () => {
    assert.equal(shouldTriggerExpireAndRebase(ANCHOR - 1, 'active', ANCHOR), false);
    assert.equal(shouldTriggerExpireAndRebase(ANCHOR, 'active', ANCHOR), true);
    assert.equal(shouldTriggerExpireAndRebase(ANCHOR + 86400, 'active', ANCHOR), true);
  });

  it('shouldTriggerMintAndAdvance: only fires when phase=between_cycles AND ts >= anchor + 60s', () => {
    // before blackout window ends
    assert.equal(shouldTriggerMintAndAdvance(ANCHOR + 30, 'between_cycles', ANCHOR), false);
    // exactly at end of blackout
    assert.equal(shouldTriggerMintAndAdvance(ANCHOR + 60, 'between_cycles', ANCHOR), true);
    // way past
    assert.equal(shouldTriggerMintAndAdvance(ANCHOR + 86400, 'between_cycles', ANCHOR), true);
    // wrong phase
    assert.equal(shouldTriggerMintAndAdvance(ANCHOR + 60, 'active', ANCHOR), false);
    assert.equal(shouldTriggerMintAndAdvance(ANCHOR + 60, 'idle', ANCHOR), false);
  });

  // ── applyChainDayCycle: first-block bootstrap ───────────────────────

  it('first call (no nextCycleAt set) anchors the schedule and runs no phases', () => {
    const db = freshDbWithVerified(3);
    assert.equal(getNextCycleAt(db), null);

    // A timestamp at 03:00 UTC (before today's 08:59 anchor) should NOT
    // trigger anything; just anchor the schedule.
    const earlyTs = ANCHOR - 6 * 3600;
    const result = applyChainDayCycle(db, earlyTs);

    assert.equal(result.expirePhasesRan, 0);
    assert.equal(result.mintPhasesRan, 0);
    assert.notEqual(getNextCycleAt(db), null);

    // Nothing should have minted yet.
    const acct = db.prepare("SELECT active_balance FROM accounts WHERE type='individual' LIMIT 1").get() as { active_balance: string };
    assert.equal(acct.active_balance, '0');
  });

  // ── applyChainDayCycle: pre-anchor block ────────────────────────────

  it('block timestamp before anchor: predicates stay false, no phases fire', () => {
    const db = freshDbWithVerified(3);
    setNextCycleAt(db, ANCHOR);

    const result = applyChainDayCycle(db, ANCHOR - 60); // 1 minute before
    assert.equal(result.expirePhasesRan, 0);
    assert.equal(result.mintPhasesRan, 0);
    assert.equal(getCycleState(db).cyclePhase, 'idle'); // unchanged
  });

  // ── Single-phase fires ──────────────────────────────────────────────

  it('block timestamp >= anchor but < anchor+60s: only expire+rebase fires', () => {
    const db = freshDbWithVerified(3);
    setNextCycleAt(db, ANCHOR);

    // Mint a starting active balance so expire actually has work to do.
    db.prepare(
      "UPDATE accounts SET active_balance = ? WHERE type='individual'",
    ).run((DAILY_ACTIVE_POINTS).toString());

    const result = applyChainDayCycle(db, ANCHOR + 5);
    assert.equal(result.expirePhasesRan, 1);
    assert.equal(result.mintPhasesRan, 0);

    const state = getCycleState(db);
    assert.equal(state.cyclePhase, 'between_cycles');
    // Active balances zeroed by expire
    const balances = db
      .prepare("SELECT active_balance FROM accounts WHERE type='individual'")
      .all() as Array<{ active_balance: string }>;
    for (const b of balances) assert.equal(b.active_balance, '0');

    // nextCycleAt is unchanged on expire — only mint+advance bumps it.
    assert.equal(getNextCycleAt(db), ANCHOR);
  });

  // ── Both phases in one call ─────────────────────────────────────────

  it('block timestamp >= anchor + 60s: expire+rebase AND mint+advance both fire', () => {
    const db = freshDbWithVerified(3);
    setNextCycleAt(db, ANCHOR);
    const before = getCycleState(db);

    const result = applyChainDayCycle(db, ANCHOR + 90);
    assert.equal(result.expirePhasesRan, 1);
    assert.equal(result.mintPhasesRan, 1);

    const after = getCycleState(db);
    assert.equal(after.cyclePhase, 'active');
    assert.equal(after.currentDay, before.currentDay + 1);

    // Mint produced fresh allocations
    const balances = db
      .prepare("SELECT active_balance, supportive_balance, ambient_balance FROM accounts WHERE type='individual'")
      .all() as Array<{ active_balance: string; supportive_balance: string; ambient_balance: string }>;
    assert.equal(balances.length, 3);
    for (const b of balances) {
      assert.equal(b.active_balance, DAILY_ACTIVE_POINTS.toString());
      assert.equal(b.supportive_balance, DAILY_SUPPORTIVE_POINTS.toString());
      assert.equal(b.ambient_balance, DAILY_AMBIENT_POINTS.toString());
    }

    // Schedule advanced by 24h
    assert.equal(getNextCycleAt(db), ANCHOR + 86400);
  });

  // ── Idempotency ─────────────────────────────────────────────────────

  it('calling twice on the same timestamp does not double-mint', () => {
    const db = freshDbWithVerified(3);
    setNextCycleAt(db, ANCHOR);

    applyChainDayCycle(db, ANCHOR + 90);
    const balancesAfterFirst = db
      .prepare("SELECT active_balance FROM accounts WHERE type='individual' ORDER BY id")
      .all() as Array<{ active_balance: string }>;

    const result2 = applyChainDayCycle(db, ANCHOR + 90);
    // Same timestamp → predicates evaluate against the NEW state
    // (currentDay+1, schedule advanced by 86400) → neither predicate fires.
    assert.equal(result2.expirePhasesRan, 0);
    assert.equal(result2.mintPhasesRan, 0);

    const balancesAfterSecond = db
      .prepare("SELECT active_balance FROM accounts WHERE type='individual' ORDER BY id")
      .all() as Array<{ active_balance: string }>;
    assert.deepEqual(balancesAfterSecond, balancesAfterFirst, 'balances must be unchanged on the second call');
  });

  // ── Multi-day catch-up ──────────────────────────────────────────────

  it('a single block far in the future catches up every missed cycle', () => {
    const db = freshDbWithVerified(3);
    setNextCycleAt(db, ANCHOR);
    const startDay = getCycleState(db).currentDay;

    // Block timestamp lands 3 days + 90 seconds past the original anchor.
    // Anchors fall at ANCHOR + N*86400 for N = 0, 1, 2, 3. The block has
    // crossed all four — so four full cycles fire (each 60s past its own
    // anchor is plenty past the block timestamp).
    const result = applyChainDayCycle(db, ANCHOR + 3 * 86400 + 90);
    assert.equal(result.expirePhasesRan, 4, 'four expire phases for four crossed anchors');
    assert.equal(result.mintPhasesRan, 4, 'four mint phases for four crossed anchors');

    const after = getCycleState(db);
    assert.equal(after.currentDay, startDay + 4);
    assert.equal(after.cyclePhase, 'active');

    // Schedule should now be at original + 4*86400 (the next future anchor).
    assert.equal(getNextCycleAt(db), ANCHOR + 4 * 86400);
  });

  // ── Determinism: parallel DBs, identical timestamps → identical state

  it('two DBs with identical starting state and identical block timestamps end in identical state', () => {
    // This is the BFT-mode invariant. Validators must agree on the
    // post-block state. The cycle is deterministic over (block.timestamp,
    // cycleState) so two validators with identical pre-state must reach
    // identical post-state.
    function setup(): DatabaseSync {
      const db = freshDb();
      // Create three accounts with hardcoded ids so both DBs are byte-
      // identical. (createAccount uses random keys; we override the
      // generated id so the two DBs don't diverge on that.)
      for (let i = 0; i < 3; i++) {
        const a = createAccount(db, 'individual', 1, 100);
        db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(`acct-${i}`, a.account.id);
        db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run('1000', `acct-${i}`);
      }
      setNextCycleAt(db, ANCHOR);
      return db;
    }
    const db1 = setup();
    const db2 = setup();

    // Apply a sequence of block timestamps to both.
    const blockTimestamps = [
      ANCHOR - 100, // pre-anchor: nothing fires
      ANCHOR + 5,   // expire+rebase fires
      ANCHOR + 70,  // mint+advance fires
      ANCHOR + 86400 + 5, // next day's expire+rebase
    ];
    for (const ts of blockTimestamps) {
      applyChainDayCycle(db1, ts);
      applyChainDayCycle(db2, ts);
    }

    function snapshot(db: DatabaseSync): unknown {
      const accounts = db
        .prepare(
          "SELECT id, active_balance, supportive_balance, ambient_balance, earned_balance, locked_balance FROM accounts ORDER BY id",
        )
        .all();
      const cycle = db.prepare('SELECT current_day, cycle_phase FROM day_cycle_state WHERE id = 1').get();
      const nextAt = getNextCycleAt(db);
      const rebase = db.prepare('SELECT day, participant_count, pre_rebase_total, target_total, post_rebase_total FROM rebase_events ORDER BY day').all();
      return { accounts, cycle, nextAt, rebase };
    }

    const s1 = snapshot(db1);
    const s2 = snapshot(db2);
    assert.deepEqual(s1, s2, 'two validators must reach identical state');
  });

  // ── Schedule integrity across a real day boundary ───────────────────

  it('after one full cycle the schedule moves forward exactly 86400 seconds', () => {
    const db = freshDbWithVerified(2);
    setNextCycleAt(db, ANCHOR);

    applyChainDayCycle(db, ANCHOR + 120);
    assert.equal(getNextCycleAt(db), ANCHOR + 86400);

    // Block the next day, just past the new anchor + 60s — full cycle again.
    applyChainDayCycle(db, ANCHOR + 86400 + 90);
    assert.equal(getNextCycleAt(db), ANCHOR + 2 * 86400);
    assert.equal(getCycleState(db).currentDay, 3); // started day 1 → +2
  });
});
