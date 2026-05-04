import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import {
  DAILY_ACTIVE_POINTS,
  DAILY_SUPPORTIVE_POINTS,
  DAILY_AMBIENT_POINTS,
  TARGET_EARNED_PER_PERSON,
} from './constants.js';
import {
  getAllAccounts,
  getActiveIndividuals,
  countActiveParticipants,
  getTotalEarnedPool,
  updateBalance,
} from './account.js';
import { recordLog, transactionStore } from './transaction.js';
import { runTransaction } from '../db/connection.js';
import type { CyclePhase, RebaseEvent } from './types.js';

// --------------- Day cycle state ---------------

export function getDayCycleState(db: DatabaseSync): { currentDay: number; cyclePhase: CyclePhase; phaseStartedAt: number } {
  return db.prepare('SELECT current_day, cycle_phase, phase_started_at FROM day_cycle_state WHERE id = 1').get() as {
    current_day: number;
    cycle_phase: CyclePhase;
    phase_started_at: number;
  } & { currentDay?: number } |
  any;
}

export function getCycleState(db: DatabaseSync): { currentDay: number; cyclePhase: CyclePhase; phaseStartedAt: number } {
  const row = db.prepare('SELECT current_day, cycle_phase, phase_started_at FROM day_cycle_state WHERE id = 1').get() as {
    current_day: number;
    cycle_phase: string;
    phase_started_at: number;
  };
  return {
    currentDay: row.current_day,
    cyclePhase: row.cycle_phase as CyclePhase,
    phaseStartedAt: row.phase_started_at,
  };
}

function setPhase(db: DatabaseSync, phase: CyclePhase): void {
  db.prepare('UPDATE day_cycle_state SET cycle_phase = ?, phase_started_at = ? WHERE id = 1').run(
    phase,
    Math.floor(Date.now() / 1000),
  );
}

function advanceDay(db: DatabaseSync): void {
  db.prepare('UPDATE day_cycle_state SET current_day = current_day + 1 WHERE id = 1').run();
}

// --------------- STEP 1: Expire unspent daily allocations ---------------
//
// Only individual accounts ever receive daily allocations (active/supportive/
// ambient). Companies, governments, and ai_bot accounts always have zero in
// those buckets — iterating over them and zeroing-zero is wasted work that
// scales with account count. We pre-filter at the SQL level to only touch
// rows that actually have non-zero daily balances.

export function expireDaily(db: DatabaseSync): void {
  setPhase(db, 'expiring');
  const now = Math.floor(Date.now() / 1000);
  const refId = `expire-day-${getCycleState(db).currentDay}`;

  // Pull only accounts with at least one non-zero daily balance. This skips
  // the entire company/government/bot population plus inactive individuals
  // who haven't been minted yet today, e.g., 0%-human accounts.
  const rows = db
    .prepare(
      `SELECT id, active_balance, supportive_balance, ambient_balance FROM accounts
       WHERE active_balance != '0' OR supportive_balance != '0' OR ambient_balance != '0'`,
    )
    .all() as Array<{
      id: string;
      active_balance: string;
      supportive_balance: string;
      ambient_balance: string;
    }>;

  runTransaction(db, () => {
    for (const row of rows) {
      const active = BigInt(row.active_balance);
      const supportive = BigInt(row.supportive_balance);
      const ambient = BigInt(row.ambient_balance);
      if (active > 0n) {
        recordLog(db, row.id, 'burn_expire', 'active', active, active, 0n, refId, now);
        updateBalance(db, row.id, 'active_balance', 0n);
      }
      if (supportive > 0n) {
        recordLog(db, row.id, 'burn_expire', 'supportive', supportive, supportive, 0n, refId, now);
        updateBalance(db, row.id, 'supportive_balance', 0n);
      }
      if (ambient > 0n) {
        recordLog(db, row.id, 'burn_expire', 'ambient', ambient, ambient, 0n, refId, now);
        updateBalance(db, row.id, 'ambient_balance', 0n);
      }
    }
  });
}

// --------------- STEP 2: Mint daily allocations ---------------
//
// IDEMPOTENT: If the node crashes mid-mint, resumeCycle() re-invokes mintDaily.
// We check the transaction_log per account for an existing mint entry on this
// day's reference_id and skip accounts already credited. This is the safety
// guarantee that prevents double-allocation, which would otherwise debase
// every account in the network.

export function mintDaily(db: DatabaseSync): void {
  setPhase(db, 'minting');
  const now = Math.floor(Date.now() / 1000);
  const eligible = getActiveIndividuals(db);
  const state = getCycleState(db);
  const refId = `mint-day-${state.currentDay}`;

  // Pre-fetch the set of accounts that have already received THIS day's mint.
  // Single query, faster than per-account lookups, and idempotent on resume.
  const alreadyMinted = transactionStore(db).findLogAccountIds(refId, 'mint');

  runTransaction(db, () => {
    for (const acct of eligible) {
      if (alreadyMinted.has(acct.id)) continue; // resumed: skip, already credited

      updateBalance(db, acct.id, 'active_balance', DAILY_ACTIVE_POINTS);
      recordLog(db, acct.id, 'mint', 'active', DAILY_ACTIVE_POINTS, 0n, DAILY_ACTIVE_POINTS, refId, now);

      updateBalance(db, acct.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);
      recordLog(db, acct.id, 'mint', 'supportive', DAILY_SUPPORTIVE_POINTS, 0n, DAILY_SUPPORTIVE_POINTS, refId, now);

      updateBalance(db, acct.id, 'ambient_balance', DAILY_AMBIENT_POINTS);
      recordLog(db, acct.id, 'mint', 'ambient', DAILY_AMBIENT_POINTS, 0n, DAILY_AMBIENT_POINTS, refId, now);
    }
  });

  setPhase(db, 'active');
}

// --------------- STEP 4: Rebase ---------------
//
// IDEMPOTENT: If the node crashes mid-rebase, resumeCycle() re-invokes rebase().
// Two challenges to handle correctly:
//   1) The multiplier is derived from preRebaseTotal. On resume, some accounts
//      have already had their balances multiplied, so recalculating from the
//      current pool would give the WRONG multiplier and silently corrupt every
//      remaining account's share. Fix: persist preRebaseTotal/targetTotal in
//      rebase_events and look them up on resume instead of recomputing.
//   2) Accounts that already have a rebase log entry for this day must be
//      skipped on resume to avoid being multiplied twice.
//
// PRECISION: We use direct rational arithmetic — newBalance = (oldBalance *
// targetTotal) / preRebaseTotal — instead of a scaled fixed-point multiplier.
// This loses at most 1 storage unit per account to integer truncation. We
// then run a dust-distribution pass that hands each lost unit back to a
// participant (sorted by account_id for determinism), restoring exact
// conservation: sum(post-rebase earned + locked) == targetTotal.
//
// All updates plus the rebase_events row commit in ONE transaction so either
// the whole rebase lands or none of it does.

export function rebase(db: DatabaseSync): RebaseEvent | null {
  setPhase(db, 'rebasing');
  const state = getCycleState(db);
  const now = Math.floor(Date.now() / 1000);
  const refId = `rebase-day-${state.currentDay}`;

  // Did we already start rebasing this day? If so, reuse the stored snapshot.
  const existing = db.prepare(
    `SELECT participant_count, pre_rebase_total, target_total, rebase_multiplier, post_rebase_total
     FROM rebase_events WHERE day = ?`
  ).get(state.currentDay) as
    | { participant_count: number; pre_rebase_total: string; target_total: string; rebase_multiplier: number; post_rebase_total: string }
    | undefined;

  let participantCount: number;
  let preRebaseTotal: bigint;
  let targetTotal: bigint;

  if (existing) {
    // Resume path. Trust the stored snapshot — current pool has been partly
    // mutated and would give a wrong multiplier if recomputed.
    participantCount = existing.participant_count;
    preRebaseTotal = BigInt(existing.pre_rebase_total);
    targetTotal = BigInt(existing.target_total);
  } else {
    // First run. Compute fresh.
    preRebaseTotal = getTotalEarnedPool(db);
    participantCount = countActiveParticipants(db);

    if (preRebaseTotal === 0n || participantCount === 0) {
      setPhase(db, 'idle');
      return null;
    }

    targetTotal = TARGET_EARNED_PER_PERSON * BigInt(participantCount);
  }

  // Set of accounts already rebased this day, so we skip them on resume.
  const alreadyRebased = transactionStore(db).findLogAccountIds(refId, 'rebase');

  // Rebase ALL accounts in a deterministic order (account_id ASC) so the dust
  // distribution can be computed identically by every node and on every resume.
  const accounts = getAllAccounts(db).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  runTransaction(db, () => {
    let postRebaseSum = 0n;
    const rebasedRows: Array<{ id: string; newEarned: bigint; newLocked: bigint }> = [];

    for (const acct of accounts) {
      if (alreadyRebased.has(acct.id)) {
        // For accounts already rebased on resume, read their current balances
        // back so the conservation accounting stays consistent.
        const fresh = getAllAccounts(db).find((x) => x.id === acct.id)!;
        postRebaseSum += fresh.earnedBalance + fresh.lockedBalance;
        continue;
      }

      // Direct rational rebase. Loses at most 1 storage unit per balance to
      // integer division — recovered below in the dust pass.
      const newEarned = preRebaseTotal === 0n ? 0n : (acct.earnedBalance * targetTotal) / preRebaseTotal;
      const newLocked = preRebaseTotal === 0n ? 0n : (acct.lockedBalance * targetTotal) / preRebaseTotal;

      if (acct.earnedBalance > 0n || newEarned !== acct.earnedBalance) {
        recordLog(db, acct.id, 'rebase', 'earned', newEarned - acct.earnedBalance, acct.earnedBalance, newEarned, refId, now);
        updateBalance(db, acct.id, 'earned_balance', newEarned);
      }
      if (acct.lockedBalance > 0n || newLocked !== acct.lockedBalance) {
        updateBalance(db, acct.id, 'locked_balance', newLocked);
      }

      rebasedRows.push({ id: acct.id, newEarned, newLocked });
      postRebaseSum += newEarned + newLocked;
    }

    // Dust pass. Conservation requires sum == targetTotal. Distribute any
    // missing units one-at-a-time to accounts in the deterministic order,
    // preferring accounts with non-zero earned balance so we don't materialize
    // earned-out-of-thin-air for accounts that had nothing.
    let dust = targetTotal - postRebaseSum;
    if (dust > 0n) {
      for (const row of rebasedRows) {
        if (dust === 0n) break;
        if (row.newEarned === 0n) continue;
        const adjusted = row.newEarned + 1n;
        updateBalance(db, row.id, 'earned_balance', adjusted);
        recordLog(db, row.id, 'rebase', 'earned', 1n, row.newEarned, adjusted, `${refId}-dust`, now);
        row.newEarned = adjusted;
        dust -= 1n;
      }
    }
    // If we still have dust (e.g., zero non-zero earned holders), drop it. The
    // total stays internally consistent — only TARGET drift, no balance loss.

    // Snapshot for resume + audit. Inside the same transaction so either both
    // the balance updates and this row commit, or neither does.
    if (!existing) {
      db.prepare(
        `INSERT INTO rebase_events (day, participant_count, pre_rebase_total, target_total, rebase_multiplier, post_rebase_total)
         VALUES (?, ?, ?, ?, ?, '0')`
      ).run(
        state.currentDay,
        participantCount,
        preRebaseTotal.toString(),
        targetTotal.toString(),
        Number(targetTotal) / Number(preRebaseTotal),
      );
    }
  });

  // Update postRebaseTotal after commit (informational, not used by resume).
  const postRebaseTotal = getTotalEarnedPool(db);
  db.prepare(
    `UPDATE rebase_events SET post_rebase_total = ? WHERE day = ?`
  ).run(postRebaseTotal.toString(), state.currentDay);

  const multiplierFloat = preRebaseTotal === 0n ? 1 : Number(targetTotal) / Number(preRebaseTotal);

  const event: RebaseEvent = {
    day: state.currentDay,
    participantCount,
    preRebaseTotal,
    targetTotal,
    rebaseMultiplier: multiplierFloat,
    postRebaseTotal,
  };

  setPhase(db, 'idle');
  return event;
}

// --------------- Day-cycle schedule (UTC-anchored) ---------------
//
// White paper schedule (and CLAUDE.md known-issue #23):
//   08:59 UTC (3:59 AM EST): runExpireAndRebase()
//     - Expires every account's unspent daily allocation.
//     - Applies the daily rebase to every Earned/Locked balance.
//     - Sets phase = 'between_cycles' (the "blackout minute").
//   09:00 UTC (4:00 AM EST): runMintAndAdvance()
//     - Advances currentDay (N -> N+1).
//     - Mints fresh allocations on the new day's refId.
//     - Sets phase = 'active'.
//
// Splitting these two operations is what gives us the blackout minute the
// white paper defines: a brief window where daily-point txs cannot land
// because every account's daily balances are zero. The phase guard in
// processTransaction enforces this.

export function runExpireAndRebase(db: DatabaseSync): RebaseEvent | null {
  expireDaily(db);                  // phase: expiring
  const event = rebase(db);         // phase: rebasing
  setPhase(db, 'between_cycles');   // blackout: daily-point txs blocked
  return event;
}

export function runMintAndAdvance(db: DatabaseSync): void {
  advanceDay(db);                   // currentDay++ inside same intent group
  mintDaily(db);                    // phase: minting → active
}

// Combined: run the full cycle in one shot. Used by tests and by the
// catch-up path. In production runtime, use the two phased calls scheduled
// at 08:59 UTC and 09:00 UTC respectively.
export function runDayCycle(db: DatabaseSync): RebaseEvent | null {
  const event = runExpireAndRebase(db);
  runMintAndAdvance(db);
  return event;
}

// Resume from crash: every step is idempotent on its refId, so we can re-run
// from the last incomplete phase without double-allocating or double-rebasing.
export function resumeCycle(db: DatabaseSync): RebaseEvent | null {
  const state = getCycleState(db);

  switch (state.cyclePhase) {
    case 'idle':
    case 'active':
      return null; // cycle previously completed cleanly

    case 'expiring': {
      const e = runExpireAndRebase(db);
      runMintAndAdvance(db);
      return e;
    }

    case 'rebasing': {
      // Rebase is idempotent (uses stored multiplier on resume); safe to call.
      const e = rebase(db);
      setPhase(db, 'between_cycles');
      runMintAndAdvance(db);
      return e;
    }

    case 'between_cycles': {
      // Expire + rebase committed; mint pending.
      runMintAndAdvance(db);
      return null;
    }

    case 'minting': {
      // Day was already advanced; mintDaily skips already-credited accounts.
      mintDaily(db);
      return null;
    }

    default:
      return null;
  }
}

// --------------- UTC scheduling helpers ---------------
//
// The cycle is anchored to a fixed global UTC clock (UTC-5, no DST shift).
// 3:59 AM EST = 08:59 UTC year-round. This is a protocol decision: every
// node, in every timezone, fires the cycle at the same instant.

const CYCLE_HOUR_UTC = 8;
const CYCLE_MINUTE_UTC = 59;

/** Returns the next 08:59 UTC strictly in the future, in unix seconds. */
export function nextCycleAtUtc(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  // Build a candidate at 08:59:00 UTC of today.
  d.setUTCHours(CYCLE_HOUR_UTC, CYCLE_MINUTE_UTC, 0, 0);
  // If we've already passed today's window, jump to tomorrow.
  if (d.getTime() <= nowMs) d.setUTCDate(d.getUTCDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

const NEXT_CYCLE_KEY = 'cycle.next_cycle_at_utc';

/** Persisted "when should the next runExpireAndRebase fire (unix sec UTC)." */
export function getNextCycleAt(db: DatabaseSync): number | null {
  const row = db.prepare(
    'SELECT value FROM protocol_params WHERE key = ?'
  ).get(NEXT_CYCLE_KEY) as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function setNextCycleAt(db: DatabaseSync, ts: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO protocol_params (key, value, updated_at, updated_by, signature)
     VALUES (?, ?, ?, NULL, NULL)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(NEXT_CYCLE_KEY, String(ts), now);
}

// --------------- Chain-driven day cycle (BFT mode) ---------------
//
// In Authority mode, the runner's wall-clock setTimeout fires the cycle
// at 08:59 / 09:00 UTC. That doesn't work in BFT mode: every validator
// has its own setTimeout, and they'd each apply the cycle to their local
// DB at slightly different points relative to other transactions, causing
// state divergence between validators.
//
// The fix is to drive the cycle off block timestamps instead of wall
// clocks. Every validator, after committing a block, runs the same pure
// predicate over (block.timestamp, cycleState, nextCycleAt) and applies
// the same cycle phase if it fires. Identical inputs → identical
// post-state → no divergence.
//
// The block timestamp is set by the proposer. Clock skew between
// validators is bounded by BFT consensus rules (proposers from divergent
// clocks would have their proposals rejected on timestamp grounds in a
// future hardening session); for now we trust block.timestamp as the
// canonical "time when this block landed."
//
// Predicates are split per phase so the catch-up logic naturally handles
// "blockchain was offline for 3 days" — each block whose timestamp
// crosses a UTC anchor advances the cycle by one phase, and the next
// block picks up the next phase. Eventually the chain catches up.

/**
 * Returns true iff a block with this timestamp should trigger the
 * 08:59 UTC expire+rebase phase: the cycle is currently in 'active' or
 * 'idle' (i.e. nothing is in flight) AND the block's timestamp has
 * reached or passed the scheduled anchor.
 */
export function shouldTriggerExpireAndRebase(
  blockTimestampSec: number,
  cyclePhase: CyclePhase,
  nextCycleAt: number,
): boolean {
  if (cyclePhase !== 'active' && cyclePhase !== 'idle') return false;
  return blockTimestampSec >= nextCycleAt;
}

/**
 * Returns true iff a block with this timestamp should trigger the
 * 09:00 UTC mint+advance phase: the cycle is currently parked in the
 * 'between_cycles' blackout AND the block's timestamp is at least 60
 * seconds past the original 08:59 anchor.
 *
 * Why 60s: the white paper's blackout minute. Daily-point txs are
 * blocked between expire+rebase and mint+advance.
 */
export function shouldTriggerMintAndAdvance(
  blockTimestampSec: number,
  cyclePhase: CyclePhase,
  nextCycleAt: number,
): boolean {
  if (cyclePhase !== 'between_cycles') return false;
  return blockTimestampSec >= nextCycleAt + 60;
}

/**
 * Apply the chain-driven day cycle for a freshly-committed block.
 *
 * Called from BftBlockProducer.onCommit after the block + cert have
 * landed. Reads the current cycle state, evaluates both predicates, and
 * fires whichever phases the block's timestamp has crossed.
 *
 * LOOPS until the predicates stop firing. This is what makes catch-up
 * work: if the chain was offline for 3 days, the first block back has
 * a timestamp far in the future of the stored nextCycleAt. The loop
 * applies expire+rebase for day N, mint+advance into day N+1, sets
 * nextCycleAt += 86400, then re-checks — and the predicate fires again
 * for day N+1. Eventually the chain has applied every missed day and
 * the loop exits.
 *
 * Each iteration is bounded by the existing pure cycle functions, all
 * of which are idempotent on their daily refIds. Returns the count of
 * phases fired, for telemetry.
 */
export function applyChainDayCycle(
  db: DatabaseSync,
  blockTimestampSec: number,
): { expirePhasesRan: number; mintPhasesRan: number } {
  const initialNextAt = getNextCycleAt(db);

  // First-block bootstrap: anchor the schedule on the very first chain
  // tick rather than running the cycle immediately. This matches the
  // Authority-mode behavior where catchUpCycles() initializes nextAt
  // and then waits.
  if (initialNextAt === null) {
    setNextCycleAt(db, nextCycleAtUtc(blockTimestampSec * 1000));
    return { expirePhasesRan: 0, mintPhasesRan: 0 };
  }

  let expirePhasesRan = 0;
  let mintPhasesRan = 0;

  // Bound the loop defensively. In normal operation it iterates once or
  // twice per block; even a 30-day downtime catch-up only takes 30
  // iterations. 1000 is "no-runaway" insurance against an unforeseen
  // bug that fails to advance the schedule.
  for (let guard = 0; guard < 1000; guard++) {
    const cycleState = getCycleState(db);
    const nextAt = getNextCycleAt(db);
    if (nextAt === null) break;

    if (shouldTriggerExpireAndRebase(blockTimestampSec, cycleState.cyclePhase, nextAt)) {
      runExpireAndRebase(db);
      expirePhasesRan++;
      continue;
    }

    if (shouldTriggerMintAndAdvance(blockTimestampSec, cycleState.cyclePhase, nextAt)) {
      runMintAndAdvance(db);
      // Advance the schedule by 24h. The Authority-mode wall-clock
      // timer does this exact thing in runner.ts; the chain-driven
      // path mirrors it so the predicate fires correctly for the
      // next day.
      setNextCycleAt(db, nextAt + 86400);
      mintPhasesRan++;
      continue;
    }

    // Neither predicate fires — caught up.
    break;
  }

  return { expirePhasesRan, mintPhasesRan };
}

/**
 * Run any cycles whose UTC trigger time has already passed. Returns the
 * count of cycles caught up. The caller schedules the next one at the
 * returned next_cycle_at value.
 */
export function catchUpCycles(db: DatabaseSync): { ranCount: number; nextCycleAt: number } {
  const now = Math.floor(Date.now() / 1000);
  let nextAt = getNextCycleAt(db);

  // First-ever startup: anchor to the next 08:59 UTC.
  if (nextAt === null) {
    nextAt = nextCycleAtUtc();
    setNextCycleAt(db, nextAt);
    return { ranCount: 0, nextCycleAt: nextAt };
  }

  let ran = 0;
  while (nextAt <= now) {
    runDayCycle(db);
    nextAt = nextAt + 86400; // exactly 24 hours later
    ran += 1;
  }
  setNextCycleAt(db, nextAt);
  return { ranCount: ran, nextCycleAt: nextAt };
}
