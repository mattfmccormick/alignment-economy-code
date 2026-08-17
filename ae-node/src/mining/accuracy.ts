// Miner accuracy and attendance metrics.
//
// All persistence goes through IMiningStore. Composite accuracy is the
// average of verification accuracy and jury accuracy; new miners with no
// data get the benefit of the doubt (100%).

import { DatabaseSync } from 'node:sqlite';
import { miningStore } from './registration.js';

export function getVerificationAccuracy(db: DatabaseSync, minerId: string): number {
  const store = miningStore(db);
  const completed = store.countMinerAssignmentsCompleted(minerId);
  if (completed === 0) return -1; // no data

  // Count the verifications a court has NOT since contradicted.
  //
  // This used to read `const correct = completed`, i.e. it returned 100% for
  // every miner unconditionally, with a comment saying the court would
  // "retroactively decrement this when fraud is found." Nothing did.
  // applyAccuracyImpact writes a contradicted verification back with
  // `missed = 1`, and that flag was never read, so a miner who waved through
  // fraudulent accounts kept a perfect record and could never be demoted no
  // matter how many of their calls the court overturned.
  const correct = store.countMinerAssignmentsCorrect(minerId);
  return (correct / completed) * 100;
}

export function getJuryAccuracy(db: DatabaseSync, minerId: string): number {
  const store = miningStore(db);
  const voted = store.countJuryServicesVoted(minerId);
  if (voted === 0) return -1;
  const correct = store.countJuryServicesCorrect(minerId);
  return (correct / voted) * 100;
}

export function getCompositeAccuracy(db: DatabaseSync, minerId: string): number {
  const verif = getVerificationAccuracy(db, minerId);
  const jury = getJuryAccuracy(db, minerId);

  if (verif === -1 && jury === -1) return 100; // new miner, benefit of doubt
  if (verif === -1) return jury;
  if (jury === -1) return verif;
  return (verif + jury) / 2;
}

export function getJuryAttendanceRate(db: DatabaseSync, minerId: string): number {
  const store = miningStore(db);
  const total = store.countJuryServices(minerId);
  if (total === 0) return 1.0; // no calls yet, perfect attendance
  const attended = store.countJuryServicesVoted(minerId);
  return attended / total;
}

export function getCompletedAssignments(
  db: DatabaseSync,
  minerId: string,
): { completed: number; total: number } {
  const store = miningStore(db);
  return {
    completed: store.countMinerAssignmentsCompleted(minerId),
    total: store.countMinerAssignments(minerId),
  };
}
