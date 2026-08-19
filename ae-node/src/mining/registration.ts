// Miner registration business logic.
//
// All persistence goes through IMiningStore (../core/stores/IMiningStore.ts).
// The functions here keep their existing (db, ...) signatures so callers don't
// have to migrate; internally each one constructs the store from the db handle.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount } from '../core/account.js';
import { NotFoundError, ValidationError, ConflictError } from '../core/errors.js';
import { getParam } from '../config/params.js';
import { SqliteMiningStore } from '../core/stores/SqliteMiningStore.js';
import type { IMiningStore } from '../core/stores/IMiningStore.js';
import type { Miner } from './types.js';

export function miningStore(db: DatabaseSync): IMiningStore {
  return new SqliteMiningStore(db);
}

export function registerMiner(db: DatabaseSync, accountId: string): Miner {
  const acct = getAccount(db, accountId);
  if (!acct) throw new NotFoundError(`Account not found: ${accountId}`);
  if (acct.type !== 'individual') throw new ValidationError('Only individual accounts can become miners', 'NOT_INDIVIDUAL');

  const store = miningStore(db);

  // Bootstrap window: the first `mining.bootstrap_miner_count` miners bypass
  // the percentHuman floor.
  //
  // This used to exempt only the very first miner, which left the network with
  // no way to grow: raising a score requires a completed verification panel, a
  // panel requires an assigned miner, and a miner required a score. Person two
  // onward was permanently locked out, so a real network could never have more
  // than one verifier and every applicant after the first had nobody
  // independent to review them.
  //
  // Exempting a small window instead lets a network seat enough reviewers to
  // run its first genuine panel, after which the floor applies normally. The
  // count is a governed parameter so an operator can tighten it.
  const bootstrapCount = getParam<number>(db, 'mining.bootstrap_miner_count');
  if (store.countActiveMiners() >= bootstrapCount && acct.percentHuman < 50) {
    throw new ValidationError(
      `percentHuman ${acct.percentHuman} is below the minimum of 50. ` +
        `This network already has ${store.countActiveMiners()} miner(s), so the ` +
        `bootstrap exemption no longer applies. Request a verification panel and ` +
        `get reviewed before registering as a miner.`,
      'PERCENT_HUMAN_TOO_LOW',
    );
  }

  // Check not already registered
  if (store.findMinerByAccountId(accountId)) {
    throw new ConflictError('Account already has an active miner', 'MINER_EXISTS');
  }

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);

  // Record WHETHER the exemption was actually used, not merely that it existed.
  // The tier evaluator needs to tell "admitted below the floor on purpose" from
  // "cleared the floor once and has since fallen below it" — the first should
  // keep mining, the second should be deactivated. Inferring it later is
  // impossible, so it is written down here.
  const bootstrapAdmitted = acct.percentHuman < 50;

  store.insertMiner({ id, accountId, tier: 1, registeredAt: now, bootstrapAdmitted });

  return {
    id,
    accountId,
    tier: 1,
    isActive: true,
    registeredAt: now,
    deactivatedAt: null,
    bootstrapAdmitted,
  };
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
  if (!miner) throw new NotFoundError(`Miner not found: ${minerId}`);
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
