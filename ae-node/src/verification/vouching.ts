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
import { getAccount, updateBalance, updatePercentHuman } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { runTransaction } from '../db/connection.js';
import { NotFoundError, ValidationError, InsufficientBalanceError } from '../core/errors.js';
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
  if (!voucher) throw new NotFoundError(`Voucher account not found: ${voucherId}`);
  if (!voucher.isActive) throw new ValidationError('Voucher account is inactive', 'ACCOUNT_INACTIVE');

  const vouched = getAccount(db, vouchedId);
  if (!vouched) throw new NotFoundError(`Vouched account not found: ${vouchedId}`);

  if (voucherId === vouchedId) throw new ValidationError('Cannot vouch for yourself', 'SELF_VOUCH');
  if (voucher.isEscrowed) throw new ValidationError('Cannot create vouches while account is escrowed', 'ACCOUNT_ESCROWED');

  if (stakePercent <= 0 || stakePercent > 100) {
    throw new ValidationError(`stakePercent must be between 0 (exclusive) and 100 (inclusive), got ${stakePercent}`, 'INVALID_STAKE_PERCENT');
  }

  const policy = getPolicy(db);
  const vouchType = policy.evidenceTypes.find((t) => t.id === 'vouch');
  const minStakePercent = vouchType?.minStakePercent ?? 5;

  if (stakePercent < minStakePercent) {
    throw new ValidationError(`stakePercent ${stakePercent}% below minimum ${minStakePercent}%`, 'STAKE_TOO_SMALL');
  }

  const totalHoldings = voucher.earnedBalance + voucher.lockedBalance;
  const stakeAmount = computeStakeFromPercent(totalHoldings, stakePercent);

  if (stakeAmount > voucher.earnedBalance) {
    throw new InsufficientBalanceError(`Insufficient earned balance to stake ${stakePercent}%: needs ${stakeAmount}, has ${voucher.earnedBalance}`);
  }
  if (stakeAmount === 0n) {
    throw new ValidationError('Stake amount rounds to zero — balance too small', 'STAKE_ROUNDS_TO_ZERO');
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
  if (!vouch) throw new NotFoundError(`Active vouch not found: ${vouchId}`);

  const voucher = getAccount(db, vouch.voucherId);
  if (!voucher) throw new NotFoundError(`Voucher account not found`);

  const now = Math.floor(Date.now() / 1000);

  // Use the current stakeAmount (which may have been rebalanced)
  const unlockAmount = vouch.stakeAmount;

  // WP §7.2: "Vouchers may withdraw at any time, but doing so immediately
  // reduces the vouched account's percent-human score by the corresponding
  // amount."
  //
  // "The corresponding amount" is this vouch's own contribution to the score.
  // calculateScore credits vouches at their stakedPercentage (tier C), so
  // pulling one back removes exactly that many points. Without this, withdrawal
  // would be free for the voucher and costless to the vouched account, and a
  // ring could park a stake just long enough to get someone verified and then
  // reclaim it with the score left standing.
  const vouched = getAccount(db, vouch.vouchedId);
  const scoreDrop = Math.round(vouch.stakedPercentage);
  const newPercentHuman = vouched ? Math.max(0, vouched.percentHuman - scoreDrop) : 0;

  runTransaction(db, () => {
    const newEarned = voucher.earnedBalance + unlockAmount;
    const newLocked = voucher.lockedBalance - unlockAmount;
    updateBalance(db, vouch.voucherId, 'earned_balance', newEarned);
    updateBalance(db, vouch.voucherId, 'locked_balance', newLocked);
    recordLog(db, vouch.voucherId, 'vouch_unlock', 'earned', unlockAmount, voucher.earnedBalance, newEarned, vouchId, now);

    // Clamped at 0 rather than allowed to go negative: percentHuman is a
    // 0-100 multiplier on spending, and a negative one has no meaning.
    if (vouched && scoreDrop > 0) {
      updatePercentHuman(db, vouch.vouchedId, newPercentHuman);
    }

    verif.markVouchInactive(vouchId, now);
  });
}

export function burnVouch(db: DatabaseSync, vouchId: string): void {
  const verif = verificationStore(db);
  const vouch = verif.findActiveVouchById(vouchId);
  if (!vouch) throw new NotFoundError(`Active vouch not found: ${vouchId}`);

  const voucher = getAccount(db, vouch.voucherId);
  if (!voucher) throw new NotFoundError(`Voucher account not found`);

  const now = Math.floor(Date.now() / 1000);
  const burnAmount = vouch.stakeAmount;

  runTransaction(db, () => {
    const newLocked = voucher.lockedBalance - burnAmount;
    updateBalance(db, vouch.voucherId, 'locked_balance', newLocked);
    recordLog(db, vouch.voucherId, 'vouch_burn', 'earned', burnAmount, voucher.lockedBalance, newLocked, vouchId, now);

    // Deliberately a TRUE burn: the stake leaves the voucher and is destroyed,
    // not routed to the fee pool. WP v2 made every court burn a true burn, and
    // phase64.test.ts pins it ("fee pool unchanged", "supply decreases").
    //
    // Do not "fix" this into addToFeePool. An earlier note in the legacy
    // folder's CLAUDE.md describes Phase 62 routing voucher stakes into the
    // pool; Phase 64 superseded that. Backing a fraudulent account has to cost
    // the voucher something the network does not hand straight back.
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

      // Apply the changes as a DELTA against the portion of locked_balance
      // that vouching actually owns — never as an absolute write over the
      // column.
      //
      // locked_balance is shared. Validator stake (consensus/registration.ts),
      // court challenger and juror stakes (court/court.ts), and slashing all
      // park value in the same column. Writing newTotalLocked (a vouch-only
      // figure) over the whole column silently released every other
      // subsystem's stake back into spendable earned_balance, once per day
      // cycle. A validator who also vouched would keep their validators-table
      // stake while the points backing it quietly returned to their wallet,
      // and deregisterValidator would then underflow trying to unlock stake
      // that was no longer there.
      const vouchLockedBefore = vouches.reduce((sum, v) => sum + v.stakeAmount, 0n);
      const delta = newTotalLocked - vouchLockedBefore;
      if (delta === 0n) continue;

      // Locking more than the voucher can cover would push earned negative.
      // Skip rather than clamp: the stored percentages stay authoritative and
      // the next cycle retries once the balance supports it.
      if (delta > voucher.earnedBalance) continue;

      updateBalance(db, voucherId, 'locked_balance', voucher.lockedBalance + delta);
      updateBalance(db, voucherId, 'earned_balance', voucher.earnedBalance - delta);

      // Update each vouch's stakeAmount in the store
      for (const u of updates) {
        verif.updateVouchStakeAmount(u.vouchId, u.newAmount);
      }
    }
  });
}
