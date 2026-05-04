// FIFO miner-assignment queue.
//
// White paper 7.1: verifications are assigned via a FIFO queue rather than
// chosen by the miner. Two filters apply on top of FIFO:
//   - heartbeat liveness (skip miners who have gone offline)
//   - conflict-of-interest (skip miners with direct transaction history with
//     either party in the case)
// Both filters fall back gracefully on a small early network.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getActiveMiners, miningStore } from './registration.js';
import { transactionStore } from '../core/transaction.js';
import { getParam } from '../config/params.js';

export interface QueueEntry {
  panelId: string;
  accountId: string;
  assignedMiners: string[];
  createdAt: number;
}

// Round-robin index for FIFO assignment
let roundRobinIndex = 0;

export function assignMinersToPanel(
  db: DatabaseSync,
  panelId: string,
  accountId: string,
): string[] {
  const panelSize = getParam<number>(db, 'mining.panel_size');
  const deadlineHours = getParam<number>(db, 'mining.verification_deadline_hours');
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + deadlineHours * 3600;

  const mining = miningStore(db);

  // Get eligible miners: Tier 2 first, fall back to Tier 1
  let eligible = getActiveMiners(db, 2);
  if (eligible.length === 0) {
    eligible = getActiveMiners(db, 1);
  }
  if (eligible.length === 0) return []; // no miners available

  // Heartbeat liveness filter. A miner that hasn't sent a heartbeat in three
  // intervals is treated as offline and skipped. Bootstrap exception:
  // miners that have never sent ANY heartbeat are still eligible (this is
  // the very first miner before block production starts).
  const heartbeatInterval = getParam<number>(db, 'mining.heartbeat_interval_seconds');
  const stalenessThreshold = now - 3 * heartbeatInterval;
  eligible = eligible.filter((m) => {
    const last = mining.lastHeartbeatAt(m.id);
    if (last === null) return true; // never seen — bootstrap allowance
    return last >= stalenessThreshold;
  });

  // Filter out miners with transaction history with this account.
  // (Still inline — the conflict-of-interest query crosses tables in a way
  // ITransactionStore could grow to express, but a single dedicated method
  // is cleaner than overloading the contract here.)
  eligible = eligible.filter((m) => {
    const txCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM transactions
       WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
    ).get(m.accountId, accountId, accountId, m.accountId) as { cnt: number };
    return txCount.cnt === 0;
  });

  // Filter out miners already assigned to this panel
  const assignedIds = new Set(mining.findAssignmentMinerIds(panelId));
  eligible = eligible.filter((m) => !assignedIds.has(m.id));

  if (eligible.length === 0) return [];

  // Round-robin assignment
  const assignCount = Math.min(panelSize, eligible.length);
  const assigned: string[] = [];

  for (let i = 0; i < assignCount; i++) {
    const idx = (roundRobinIndex + i) % eligible.length;
    const miner = eligible[idx];
    assigned.push(miner.id);
    mining.insertAssignment({
      id: uuid(),
      minerId: miner.id,
      panelId,
      assignedAt: now,
      deadline,
    });
  }

  roundRobinIndex = (roundRobinIndex + assignCount) % Math.max(1, eligible.length);

  // Suppress unused-import warning: transactionStore stays imported for future
  // refactor where we'll add a conflict-of-interest helper to ITransactionStore.
  void transactionStore;

  return assigned;
}

export function markAssignmentComplete(db: DatabaseSync, minerId: string, panelId: string): void {
  miningStore(db).markAssignmentComplete(minerId, panelId);
}

export function markAssignmentMissed(db: DatabaseSync, minerId: string, panelId: string): void {
  miningStore(db).markAssignmentMissed(minerId, panelId);
}

export function resetRoundRobin(): void {
  roundRobinIndex = 0;
}
