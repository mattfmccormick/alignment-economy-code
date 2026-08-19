import { DatabaseSync } from 'node:sqlite';
import { getParam } from '../config/params.js';
import { getAccount } from '../core/account.js';
import { NotFoundError } from '../core/errors.js';
import { getMiner, setMinerTier, deactivateMiner, getActiveMiners, miningStore } from './registration.js';
import { calculateUptime, cleanOldHeartbeats } from './heartbeat.js';
import { getCompositeAccuracy, getJuryAttendanceRate, getCompletedAssignments } from './accuracy.js';
import { logger } from '../node/logger.js';

export interface TierEvaluation {
  minerId: string;
  currentTier: 1 | 2;
  newTier: 1 | 2;
  changed: boolean;
  reason: string;
  metrics: {
    uptime: number;
    compositeAccuracy: number;
    juryAttendance: number;
    allAssignmentsComplete: boolean;
    percentHuman: number;
  };
}

export function evaluateMinerTier(
  db: DatabaseSync,
  minerId: string,
  networkStartTime?: number,
): TierEvaluation {
  const miner = getMiner(db, minerId);
  if (!miner || !miner.isActive) {
    throw new NotFoundError(`Active miner not found: ${minerId}`);
  }

  const acct = getAccount(db, miner.accountId);
  if (!acct) throw new NotFoundError(`Miner account not found: ${miner.accountId}`);

  // A miner who has reached the floor under their own steam has graduated:
  // clear the bootstrap flag so the exemption cannot shield them later if their
  // score falls again. The grace period ends at real verification, not never.
  if (miner.bootstrapAdmitted && acct.percentHuman >= 50) {
    miningStore(db).clearBootstrapAdmitted(minerId);
  }

  // Force-deactivate if percentHuman is below 50 — unless this miner was
  // ADMITTED below it under the bootstrap exemption and has not graduated yet.
  //
  // registerMiner lets the first `mining.bootstrap_miner_count` miners join
  // below the floor, because a new network cannot raise a score without a
  // panel, run a panel without a miner, or have a miner without a score. This
  // function did not know that exemption existed and revoked it the moment it
  // ran: a bootstrap miner registered at percentHuman 0 was deactivated on the
  // next evaluation, and the miner app said only "Not registered as a miner" —
  // no mention of a score, a threshold, or a route back. Latent until
  // evaluateMinerTier was given a production caller; the two rules had never
  // both run before.
  //
  // The check is on the RECORDED admission reason, not on how many miners
  // happen to be active now. Counting the window instead would also exempt a
  // miner who cleared the floor long ago and has since fallen below it — the
  // opposite of what should happen — and that is precisely the case phase4's
  // "force-deactivates miner when percentHuman drops below 50" pins.
  if (acct.percentHuman < 50 && !miner.bootstrapAdmitted) {
    deactivateMiner(db, minerId, `percentHuman dropped to ${acct.percentHuman}`);
    return {
      minerId, currentTier: miner.tier, newTier: miner.tier,
      changed: false, reason: 'Deactivated: percentHuman below 50',
      metrics: { uptime: 0, compositeAccuracy: 0, juryAttendance: 0, allAssignmentsComplete: false, percentHuman: acct.percentHuman },
    };
  }

  const windowDays = getParam<number>(db, 'mining.rolling_window_days');
  const windowSeconds = windowDays * 86400;
  const tier1UptimeThreshold = getParam<number>(db, 'mining.tier1_uptime_threshold') * 100;
  const tier2AccuracyThreshold = getParam<number>(db, 'mining.tier2_accuracy_threshold') * 100;

  const uptime = calculateUptime(db, minerId, windowSeconds, networkStartTime);
  const compositeAccuracy = getCompositeAccuracy(db, minerId);
  const juryAttendance = getJuryAttendanceRate(db, minerId);
  const assignments = getCompletedAssignments(db, minerId);
  const allAssignmentsComplete = assignments.total === 0 || assignments.completed === assignments.total;

  const metrics = {
    uptime,
    compositeAccuracy,
    juryAttendance,
    allAssignmentsComplete,
    percentHuman: acct.percentHuman,
  };

  // Tier 1 requirements
  const meetsTier1 = uptime >= tier1UptimeThreshold;

  // Tier 2 requirements (all of Tier 1 plus...)
  const meetsTier2 = meetsTier1
    && juryAttendance >= 1.0
    && allAssignmentsComplete
    && compositeAccuracy >= tier2AccuracyThreshold;

  let newTier: 1 | 2 = miner.tier;
  let reason = 'No change';

  if (miner.tier === 2 && !meetsTier2) {
    newTier = 1;
    if (!meetsTier1) reason = `Demoted: uptime ${uptime.toFixed(1)}% below threshold`;
    else if (juryAttendance < 1.0) reason = `Demoted: missed jury duty`;
    else if (!allAssignmentsComplete) reason = `Demoted: incomplete FIFO assignments`;
    else reason = `Demoted: accuracy ${compositeAccuracy.toFixed(1)}% below threshold`;
  } else if (miner.tier === 1 && meetsTier2) {
    newTier = 2;
    reason = 'Promoted: meets all Tier 2 requirements';
  } else if (miner.tier === 1 && !meetsTier1) {
    // Below Tier 1 threshold but still active
    reason = `Warning: uptime ${uptime.toFixed(1)}% below Tier 1 threshold`;
  }

  const changed = newTier !== miner.tier;
  if (changed) {
    setMinerTier(db, minerId, newTier, reason);
  }

  return { minerId, currentTier: miner.tier, newTier, changed, reason, metrics };
}

/**
 * Re-evaluate every active miner's tier, and drop heartbeats past the window.
 *
 * `evaluateMinerTier` had no production caller, so a miner's tier was whatever
 * it was at registration, permanently. Nobody was ever promoted for doing the
 * work well and nobody was demoted for going dark â€” the entire tier mechanism
 * was inert, which matters because tier 2 is who gets seated on juries.
 *
 * Runs once per day cycle. A single miner's evaluation throwing must not stop
 * the rest of the network's rollover, so failures are contained and logged;
 * that miner keeps its current tier until tomorrow.
 *
 * `cleanOldHeartbeats` runs alongside because heartbeats are append-only at
 * one row per minute per miner. Nothing pruned them, so the table grew without
 * bound: ~525k rows per miner per year, all of it outside the rolling window
 * and useless to `calculateUptime`. Retention is twice the window so a
 * boundary evaluation always has full history.
 */
export function runMinerTierEvaluation(
  db: DatabaseSync,
  networkStartTime?: number,
): { evaluated: number; changed: TierEvaluation[]; failed: number } {
  const windowDays = getParam<number>(db, 'mining.rolling_window_days');
  cleanOldHeartbeats(db, windowDays * 2 * 86400);

  const changed: TierEvaluation[] = [];
  let evaluated = 0;
  let failed = 0;

  for (const miner of getActiveMiners(db)) {
    try {
      const result = evaluateMinerTier(db, miner.id, networkStartTime);
      evaluated++;
      if (result.changed) changed.push(result);
    } catch (err) {
      failed++;
      logger.error(
        'mining',
        `Tier evaluation failed for miner ${miner.id}; it keeps tier ${miner.tier} for now. ` +
          `${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  if (changed.length > 0 || failed > 0) {
    logger.info(
      'mining',
      `Tier evaluation: ${evaluated} miner(s) checked, ${changed.length} changed` +
        (failed > 0 ? `, ${failed} failed` : ''),
    );
  }

  return { evaluated, changed, failed };
}
