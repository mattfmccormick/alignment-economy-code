// Verification score decay.
//
// WP v2: percentHuman erodes monthly without verification activity.
// Human-tags (recipientIsHuman on transactions) offset the decay,
// replacing the legacy in-person transaction counter.

import { DatabaseSync } from 'node:sqlite';
import { getAccount, updatePercentHuman } from '../core/account.js';
import { getActiveIndividuals } from '../core/account.js';
import { transactionStore } from '../core/transaction.js';
import { getPolicy } from './policy.js';
import type { SqliteTransactionStore } from '../core/stores/SqliteTransactionStore.js';

export function applyDecay(
  db: DatabaseSync,
  accountId: string,
  daysSinceActivity: number,
  humanTagCredits: number,
): number {
  const acct = getAccount(db, accountId);
  if (!acct) throw new Error(`Account not found: ${accountId}`);

  const policy = getPolicy(db);
  const decay = policy.decay;

  let score = acct.percentHuman;

  if (daysSinceActivity >= decay.windowDays) {
    const periods = Math.floor(daysSinceActivity / decay.windowDays);
    for (let i = 0; i < periods; i++) {
      score = Math.round(score * (1 - decay.monthlyRate / 100));
    }
  }

  // WP v2: offset comes from summed human-tag credits in the window,
  // capped at maxOffsetPerWindow.
  const offset = Math.min(humanTagCredits, decay.maxOffsetPerWindow);
  score = Math.min(100, score + offset);
  score = Math.round(score);
  score = Math.max(0, score);

  updatePercentHuman(db, accountId, score);
  return score;
}

export function runDecayForAll(db: DatabaseSync, currentDay: number): void {
  const individuals = getActiveIndividuals(db);
  const policy = getPolicy(db);
  const txStore = transactionStore(db) as SqliteTransactionStore;

  for (const acct of individuals) {
    if (acct.percentHuman <= 0) continue;

    const daysSinceJoin = currentDay - acct.joinedDay;
    if (daysSinceJoin >= policy.decay.windowDays) {
      const windowStart = Math.floor(Date.now() / 1000) - policy.decay.windowDays * 86400;
      const humanTagCredits = txStore.sumHumanTagCreditsSince(acct.id, windowStart);
      applyDecay(db, acct.id, daysSinceJoin, humanTagCredits);
    }
  }
}
