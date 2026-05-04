import { DatabaseSync } from 'node:sqlite';
import { getParam } from '../config/params.js';
import { getAccount } from '../core/account.js';
import { getMiner, setMinerTier, deactivateMiner, getActiveMiners } from './registration.js';
import { calculateUptime } from './heartbeat.js';
import { getCompositeAccuracy, getJuryAttendanceRate, getCompletedAssignments } from './accuracy.js';

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
    throw new Error(`Active miner not found: ${minerId}`);
  }

  const acct = getAccount(db, miner.accountId);
  if (!acct) throw new Error(`Miner account not found: ${miner.accountId}`);

  // Force-deactivate if percentHuman dropped below 50
  if (acct.percentHuman < 50) {
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

export function evaluateAllMiners(db: DatabaseSync, networkStartTime?: number): TierEvaluation[] {
  const miners = getActiveMiners(db);
  return miners.map((m) => evaluateMinerTier(db, m.id, networkStartTime));
}
