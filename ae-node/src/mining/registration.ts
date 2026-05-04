// Miner registration business logic.
//
// All persistence goes through IMiningStore (../core/stores/IMiningStore.ts).
// The functions here keep their existing (db, ...) signatures so callers don't
// have to migrate; internally each one constructs the store from the db handle.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount } from '../core/account.js';
import { SqliteMiningStore } from '../core/stores/SqliteMiningStore.js';
import type { IMiningStore } from '../core/stores/IMiningStore.js';
import type { Miner } from './types.js';

export function miningStore(db: DatabaseSync): IMiningStore {
  return new SqliteMiningStore(db);
}

export function registerMiner(db: DatabaseSync, accountId: string): Miner {
  const acct = getAccount(db, accountId);
  if (!acct) throw new Error(`Account not found: ${accountId}`);
  if (acct.type !== 'individual') throw new Error('Only individual accounts can become miners');

  const store = miningStore(db);

  // Bootstrap exemption: if no miners exist yet, the first one bypasses the
  // percentHuman floor. Without this, a fresh network is impossible — every
  // miner needs to be verified by another miner.
  if (store.countActiveMiners() > 0 && acct.percentHuman < 50) {
    throw new Error(`percentHuman ${acct.percentHuman} below minimum 50`);
  }

  // Check not already registered
  if (store.findMinerByAccountId(accountId)) {
    throw new Error('Account already has an active miner');
  }

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  store.insertMiner({ id, accountId, tier: 1, registeredAt: now });

  return { id, accountId, tier: 1, isActive: true, registeredAt: now, deactivatedAt: null };
}

export function getMiner(db: DatabaseSync, minerId: string): Miner | null {
  return miningStore(db).findMinerById(minerId);
}

export function getMinerByAccount(db: DatabaseSync, accountId: string): Miner | null {
  return miningStore(db).findMinerByAccountId(accountId);
}

export function getActiveMiners(db: DatabaseSync, tier?: 1 | 2): Miner[] {
  return miningStore(db).findActiveMiners(tier);
}

export function deactivateMiner(db: DatabaseSync, minerId: string, _reason: string): void {
  miningStore(db).deactivateMiner(minerId, Math.floor(Date.now() / 1000));
}

export function setMinerTier(
  db: DatabaseSync,
  minerId: string,
  newTier: 1 | 2,
  reason: string,
): void {
  const store = miningStore(db);
  const miner = store.findMinerById(minerId);
  if (!miner) throw new Error(`Miner not found: ${minerId}`);
  if (miner.tier === newTier) return;

  const now = Math.floor(Date.now() / 1000);
  store.setMinerTier(minerId, newTier);
  store.recordTierChange({
    id: uuid(),
    minerId,
    fromTier: miner.tier,
    toTier: newTier,
    reason,
    timestamp: now,
  });
}
