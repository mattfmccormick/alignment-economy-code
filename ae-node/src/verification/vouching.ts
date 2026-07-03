// Vouching business logic (WP v2: percentage-based).
//
// A vouch locks a percentage of the voucher's total holdings (earned + locked),
// not a fixed amount. The locked amount scales dynamically: if the voucher's
// balance grows, the lock grows proportionally. rebalanceVouchLocks() is called
// during the daily cycle to recalculate all active locks.
//
// All vouch table operations go through IVerificationStore. Account balance
// changes (locking/unlocking) go through IAccountStore via updateBalance.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { runTransaction } from '../db/connection.js';
import { getPolicy } from './policy.js';
import { verificationStore } from './panel.js';
import type { Vouch } from './types.js';

export function getActiveVouchesForAccount(db: DatabaseSync, accountId: string): Vouch[] {
  return verificationStore(db).findActiveVouchesForAccount(accountId);
}

export function getVouchesGivenBy(db: DatabaseSync, accountId: string): Vouch[] {
  return verificationStore(db).findActiveVouchesGivenBy(accountId);
}

function computeStakeFromPercent(totalHoldings: bigint, percent: number): bigint {
  return (totalHoldings * BigInt(Math.round(percent * 100))) / 10000n;
}

export function createVouch(
  db: DatabaseSync,
  voucherId: string,
  vouchedId: string,
  stakePercent: number,
): Vouch {
  const voucher = getAccount(db, voucherId);
  if (!voucher) throw new Error(`Voucher account not found: ${voucherId}`);
  if (!voucher.isActive) throw new Error('Voucher account is inactive');

  const vouched = getAccount(db, vouchedId);
  if (!vouched) throw new Error(`Vouched account not found: ${vouchedId}`);

  if (voucherId === vouchedId) throw new Error('Cannot vouch for yourself');
  if (voucher.isEscrowed) throw new Error('Cannot create vouches while account is escrowed');

  if (stakePercent <= 0 || stakePercent > 100) {
    throw new Error(`stakePercent must be between 0 (exclusive) and 100 (inclusive), got ${stakePercent}`);
  }

  const policy = getPolicy(db);
  const vouchType = policy.evidenceTypes.find((t) => t.id === 'vouch');
  const minStakePercent = vouchType?.minStakePercent ?? 5;

  if (stakePercent < minStakePercent) {
    throw new Error(`stakePercent ${stakePercent}% below minimum ${minStakePercent}%`);
  }

  const totalHoldings = voucher.earnedBalance + voucher.lockedBalance;
  const stakeAmount = computeStakeFromPercent(totalHoldings, stakePercent);

  if (stakeAmount > voucher.earnedBalance) {
    throw new Error(`Insufficient earned balance to stake ${stakePercent}%: needs ${stakeAmount}, has ${voucher.earnedBalance}`);
  }
  if (stakeAmount === 0n) {
    throw new Error('Stake amount rounds to zero — balance too small');
  }

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    const newEarned = voucher.earnedBalance - stakeAmount;
    const newLocked = voucher.lockedBalance + stakeAmount;
    updateBalance(db, voucherId, 'earned_balance', newEarned);
    updateBalance(db, voucherId, 'locked_balance', newLocked);
    recordLog(db, voucherId, 'vouch_lock', 'earned', stakeAmount, voucher.earnedBalance, newEarned, id, now);

    verificationStore(db).insertVouch({
      id,
      voucherId,
      vouchedId,
      stakeAmount,
      stakedPercentage: stakePercent,
      createdAt: now,
    });
  });

  return {
    id, voucherId, vouchedId, stakeAmount, stakedPercentage: stakePercent,
    isActive: true, createdAt: now, withdrawnAt: null,
  };
}

export function withdrawVouch(db: DatabaseSync, vouchId: string): void {
  const verif = verificationStore(db);
  const vouch = verif.findActiveVouchById(vouchId);
  if (!vouch) throw new Error(`Active vouch not found: ${vouchId}`);

  const voucher = getAccount(db, vouch.voucherId);
  if (!voucher) throw new Error(`Voucher account not found`);

  const now = Math.floor(Date.now() / 1000);

  // Use the current stakeAmount (which may have been rebalanced)
  const unlockAmount = vouch.stakeAmount;

  runTransaction(db, () => {
    const newEarned = voucher.earnedBalance + unlockAmount;
    const newLocked = voucher.lockedBalance - unlockAmount;
    updateBalance(db, vouch.voucherId, 'earned_balance', newEarned);
    updateBalance(db, vouch.voucherId, 'locked_balance', newLocked);
    recordLog(db, vouch.voucherId, 'vouch_unlock', 'earned', unlockAmount, voucher.earnedBalance, newEarned, vouchId, now);

    verif.markVouchInactive(vouchId, now);
  });
}

export function burnVouch(db: DatabaseSync, vouchId: string): void {
  const verif = verificationStore(db);
  const vouch = verif.findActiveVouchById(vouchId);
  if (!vouch) throw new Error(`Active vouch not found: ${vouchId}`);

  const voucher = getAccount(db, vouch.voucherId);
  if (!voucher) throw new Error(`Voucher account not found`);

  const now = Math.floor(Date.now() / 1000);
  const burnAmount = vouch.stakeAmount;

  runTransaction(db, () => {
    const newLocked = voucher.lockedBalance - burnAmount;
    updateBalance(db, vouch.voucherId, 'locked_balance', newLocked);
    recordLog(db, vouch.voucherId, 'vouch_burn', 'earned', burnAmount, voucher.lockedBalance, newLocked, vouchId, now);

    verif.markVouchInactive(vouchId, now);
  });
}

export function burnAllVouchesOnAccount(db: DatabaseSync, accountId: string): void {
  const vouches = getActiveVouchesForAccount(db, accountId);
  for (const vouch of vouches) {
    burnVouch(db, vouch.id);
  }
}

// WP v2: percentage-based locks scale with balance. After rebase or at the
// start of each daily cycle, recalculate every active vouch's locked amount
// to match its stored stakedPercentage against the voucher's current total
// holdings. This keeps the lock proportional as balances grow or shrink.
export function rebalanceVouchLocks(db: DatabaseSync): void {
  const verif = verificationStore(db);

  // Group all active vouches by voucher
  const allVouches = verif.findAllActiveVouches();
  const byVoucher = new Map<string, Vouch[]>();
  for (const v of allVouches) {
    const list = byVoucher.get(v.voucherId) || [];
    list.push(v);
    byVoucher.set(v.voucherId, list);
  }

  runTransaction(db, () => {
    for (const [voucherId, vouches] of byVoucher) {
      const voucher = getAccount(db, voucherId);
      if (!voucher) continue;

      const totalHoldings = voucher.earnedBalance + voucher.lockedBalance;
      if (totalHoldings === 0n) continue;

      // Calculate the new target lock for each vouch
      let newTotalLocked = 0n;
      const updates: Array<{ vouchId: string; newAmount: bigint }> = [];
      for (const v of vouches) {
        const target = computeStakeFromPercent(totalHoldings, v.stakedPercentage);
        updates.push({ vouchId: v.id, newAmount: target });
        newTotalLocked += target;
      }

      // Safety: can't lock more than total holdings
      if (newTotalLocked > totalHoldings) continue;

      // Apply the changes
      const oldLocked = voucher.lockedBalance;
      const delta = newTotalLocked - oldLocked;
      if (delta === 0n) continue;

      updateBalance(db, voucherId, 'locked_balance', newTotalLocked);
      updateBalance(db, voucherId, 'earned_balance', voucher.earnedBalance - delta);

      // Update each vouch's stakeAmount in the store
      for (const u of updates) {
        verif.updateVouchStakeAmount(u.vouchId, u.newAmount);
      }
    }
  });
}
