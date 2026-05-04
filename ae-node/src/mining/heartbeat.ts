// Miner heartbeat tracking.
//
// All persistence goes through IMiningStore. The protocol records a heartbeat
// every block; uptime is computed as (received heartbeats / expected heartbeats)
// over a rolling window, with a benefit-of-the-doubt for brand-new miners.

import { DatabaseSync } from 'node:sqlite';
import { getParam } from '../config/params.js';
import { miningStore } from './registration.js';

export function recordHeartbeat(db: DatabaseSync, minerId: string, blockHeight: number): void {
  miningStore(db).insertHeartbeat(minerId, blockHeight, Math.floor(Date.now() / 1000));
}

export function calculateUptime(
  db: DatabaseSync,
  minerId: string,
  windowSeconds: number,
  networkStartTime?: number,
): number {
  const now = Math.floor(Date.now() / 1000);
  const heartbeatInterval = getParam<number>(db, 'mining.heartbeat_interval_seconds');

  // Use actual window or time since network start (whichever is shorter)
  const effectiveWindow = networkStartTime
    ? Math.min(windowSeconds, now - networkStartTime)
    : windowSeconds;

  if (effectiveWindow <= 0) return 100; // brand new, benefit of the doubt

  const windowStart = now - effectiveWindow;
  const seen = miningStore(db).countHeartbeatsSince(minerId, windowStart);

  const expected = Math.floor(effectiveWindow / heartbeatInterval);
  if (expected === 0) return 100;

  return Math.min(100, (seen / expected) * 100);
}

export function cleanOldHeartbeats(db: DatabaseSync, retainSeconds: number): void {
  miningStore(db).deleteHeartbeatsBefore(Math.floor(Date.now() / 1000) - retainSeconds);
}
