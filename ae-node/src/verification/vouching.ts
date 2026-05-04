// Vouching business logic. A vouch is a peer staking points to attest to
// another account's humanity. Stakes are locked, can be withdrawn (returned)
// or burned (lost) depending on how the vouch resolves.
//
// All vouch table operations go through IVerificationStore. Account balance
// changes (locking/unlocking) go through IAccountStore via updateBalance.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { addToFeePool } from '../core/fee-pool.js';
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

export function createVouch(
  db: DatabaseSync,
  voucherId: string,
  vouchedId: string,
  stakeAmount: bigint,
): Vouch {
  const voucher = getAccount(db, voucherId);
  if (!voucher) throw new Error(`Voucher account not found: ${voucherId}`);
  if (!voucher.isActive) throw new Error('Voucher account is inactive');

  const vouched = getAccount(db, vouchedId);
  if (!vouched) throw new Error(`Vouched account not found: ${vouchedId}`);

  if (voucherId === vouchedId) throw new Error('Cannot vouch for yourself');

  // Check minimum stake (white paper: 5% of voucher's earned, by default).
  const policy = getPolicy(db);
  const vouchType = policy.evidenceTypes.find((t) => t.id === 'vouch');
  const minStakePercent = vouchType?.minStakePercent ?? 5;
  const minStake = (voucher.earnedBalance * BigInt(minStakePercent)) / 100n;

  if (stakeAmount < minStake) {
    throw new Error(`Stake ${stakeAmount} below minimum ${minStake} (${minStakePercent}% of earned balance)`);
  }
  if (stakeAmount > voucher.earnedBalance) {
    throw new Error(`Insufficient earned balance to stake: has ${voucher.earnedBalance}, needs ${stakeAmount}`);
  }

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  const totalBefore = voucher.earnedBalance + voucher.lockedBalance;
  const stakedPercentage = Number(stakeAmount) / Number(totalBefore) * 100;

  runTransaction(db, () => {
    // Lock stake: move points from earned to locked.
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
      stakedPercentage,
      createdAt: now,
    });
  });

  return {
    id, voucherId, vouchedId, stakeAmount, stakedPercentage, isActive: true, createdAt: now, withdrawnAt: null,
  };
}

export function withdrawVouch(db: DatabaseSync, vouchId: string): void {
  const verif = verificationStore(db);
  const vouch = verif.findActiveVouchById(vouchId);
  if (!vouch) throw new Error(`Active vouch not found: ${vouchId}`);

  const voucher = getAccount(db, vouch.voucherId);
  if (!voucher) throw new Error(`Voucher account not found`);

  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    // Unlock stake: move from locked back to earned.
    const newEarned = voucher.earnedBalance + vouch.stakeAmount;
    const newLocked = voucher.lockedBalance - vouch.stakeAmount;
    updateBalance(db, vouch.voucherId, 'earned_balance', newEarned);
    updateBalance(db, vouch.voucherId, 'locked_balance', newLocked);
    recordLog(db, vouch.voucherId, 'vouch_unlock', 'earned', vouch.stakeAmount, voucher.earnedBalance, newEarned, vouchId, now);

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

  runTransaction(db, () => {
    // Burn stake: remove from locked, route to fee pool. The voucher loses
    // the stake either way; routing it to the fee pool keeps total supply
    // conserved instead of vaporizing it on every guilty verdict.
    const newLocked = voucher.lockedBalance - vouch.stakeAmount;
    updateBalance(db, vouch.voucherId, 'locked_balance', newLocked);
    recordLog(db, vouch.voucherId, 'vouch_burn', 'earned', vouch.stakeAmount, voucher.lockedBalance, newLocked, vouchId, now);
    if (vouch.stakeAmount > 0n) {
      addToFeePool(db, vouch.stakeAmount);
    }

    verif.markVouchInactive(vouchId, now);
  });
}

export function burnAllVouchesOnAccount(db: DatabaseSync, accountId: string): void {
  const vouches = getActiveVouchesForAccount(db, accountId);
  for (const vouch of vouches) {
    burnVouch(db, vouch.id);
  }
}
