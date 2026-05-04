// Verification score decay.
//
// The protocol erodes percentHuman over time without verification activity,
// nudging accounts to re-engage. In-person transactions count toward an
// offset that protects the score against decay.

import { DatabaseSync } from 'node:sqlite';
import { getAccount, updatePercentHuman } from '../core/account.js';
import { getActiveIndividuals } from '../core/account.js';
import { transactionStore } from '../core/transaction.js';
import { getPolicy } from './policy.js';

export function applyDecay(
  db: DatabaseSync,
  accountId: string,
  daysSinceActivity: number,
  inPersonTxCount: number,
): number {
  const acct = getAccount(db, accountId);
  if (!acct) throw new Error(`Account not found: ${accountId}`);

  const policy = getPolicy(db);
  const decay = policy.decay;

  let score = acct.percentHuman;

  // Apply decay: one application per 30-day window without activity
  if (daysSinceActivity >= decay.windowDays) {
    const periods = Math.floor(daysSinceActivity / decay.windowDays);
    for (let i = 0; i < periods; i++) {
      score = Math.round(score * (1 - decay.monthlyRate / 100));
    }
  }

  // Apply in-person offset
  const offset = Math.min(inPersonTxCount * decay.inPersonOffset, decay.maxOffsetPerWindow);
  score = Math.min(100, score + offset);
  score = Math.round(score);
  score = Math.max(0, score);

  updatePercentHuman(db, accountId, score);
  return score;
}

export function runDecayForAll(db: DatabaseSync, currentDay: number): void {
  const individuals = getActiveIndividuals(db);
  const policy = getPolicy(db);
  const txStore = transactionStore(db);

  for (const acct of individuals) {
    if (acct.percentHuman <= 0) continue;

    // Check last verification activity (simplified: use joined_day as proxy).
    // Production tracks a real "last activity" timestamp.
    const daysSinceJoin = currentDay - acct.joinedDay;
    if (daysSinceJoin >= policy.decay.windowDays) {
      const windowStart = Math.floor(Date.now() / 1000) - policy.decay.windowDays * 86400;
      const inPersonCount = txStore.countInPersonTransactionsSince(acct.id, windowStart);
      applyDecay(db, acct.id, daysSinceJoin, inPersonCount);
    }
  }
}
