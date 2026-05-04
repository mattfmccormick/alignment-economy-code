import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { DAILY_SUPPORTIVE_POINTS, TRANSACTION_FEE_RATE, FEE_DENOMINATOR } from '../core/constants.js';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { addToFeePool } from '../core/fee-pool.js';
import { runTransaction } from '../db/connection.js';
import { getProduct } from './products.js';
import type { SupportiveTag } from './types.js';

function rowToTag(row: Record<string, unknown>): SupportiveTag {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    day: row.day as number,
    productId: row.product_id as string,
    minutesUsed: row.minutes_used as number,
    pointsAllocated: BigInt(row.points_allocated as string),
    status: row.status as 'active' | 'finalized',
  };
}

export interface TagInput {
  productId: string;
  minutesUsed: number;
}

export function submitSupportiveTags(
  db: DatabaseSync,
  accountId: string,
  day: number,
  tags: TagInput[],
): SupportiveTag[] {
  if (tags.length === 0) return [];

  const acct = getAccount(db, accountId);
  if (!acct) throw new Error('Account not found');

  // Validate all products exist
  for (const tag of tags) {
    if (!getProduct(db, tag.productId)) throw new Error(`Product not found: ${tag.productId}`);
    if (tag.minutesUsed <= 0) throw new Error('minutesUsed must be positive');
  }

  const totalMinutes = tags.reduce((sum, t) => sum + t.minutesUsed, 0);

  // A day has 1,440 minutes. Cap the combined tagged time so a user can't claim
  // 10,000 minutes of supportive activity on a single day. The same user can
  // also have ambient tags up to 1,440 minutes — these two pools are tracked
  // separately because a person can simultaneously occupy a space (ambient)
  // and use durable goods (supportive).
  if (totalMinutes > 1440) {
    throw new Error(`Total supportive minutes ${totalMinutes} exceeds the 1,440-minute daily cap`);
  }

  // Delete existing active tags for this account+day (re-submission replaces)
  db.prepare("DELETE FROM supportive_tags WHERE account_id = ? AND day = ? AND status = 'active'").run(accountId, day);

  const result: SupportiveTag[] = [];

  for (const tag of tags) {
    const share = BigInt(tag.minutesUsed) * DAILY_SUPPORTIVE_POINTS / BigInt(totalMinutes);
    const id = uuid();

    db.prepare(
      `INSERT INTO supportive_tags (id, account_id, day, product_id, minutes_used, points_allocated, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).run(id, accountId, day, tag.productId, tag.minutesUsed, share.toString());

    result.push({
      id, accountId, day, productId: tag.productId,
      minutesUsed: tag.minutesUsed, pointsAllocated: share, status: 'active',
    });
  }

  return result;
}

export function getSupportiveTags(db: DatabaseSync, accountId: string, day: number): SupportiveTag[] {
  const rows = db.prepare(
    'SELECT * FROM supportive_tags WHERE account_id = ? AND day = ?'
  ).all(accountId, day) as Array<Record<string, unknown>>;
  return rows.map(rowToTag);
}

export function finalizeSupportiveTags(db: DatabaseSync, accountId: string, day: number): {
  transferred: bigint;
  burned: bigint;
  fees: bigint;
} {
  const tags = db.prepare(
    "SELECT * FROM supportive_tags WHERE account_id = ? AND day = ? AND status = 'active'"
  ).all(accountId, day) as Array<Record<string, unknown>>;

  const acct = getAccount(db, accountId)!;
  const now = Math.floor(Date.now() / 1000);
  let totalTransferred = 0n;
  let totalBurned = 0n;
  let totalFees = 0n;

  runTransaction(db, () => {
    for (const row of tags) {
      const tag = rowToTag(row);
      const product = getProduct(db, tag.productId);

      // percentHuman multiplier applies to tag finalization the same way it
      // applies to transactions: only (pointsAllocated * pH/100) reaches the
      // manufacturer + fee pool, the rest burns as unverified-spend slippage.
      // Without this, an unverified user's daily supportive mint could pump
      // value to a colluding "manufacturer" account — the multiplier closes
      // that sybil vector while still letting the mint accumulate visibly.
      const effective = (tag.pointsAllocated * BigInt(acct.percentHuman)) / 100n;
      const burnedUnverified = tag.pointsAllocated - effective;

      if (product && product.manufacturerId) {
        const manufacturer = getAccount(db, product.manufacturerId);
        if (manufacturer && manufacturer.isActive) {
          // Transfer: effective supportive points -> manufacturer earned (with fee)
          const fee = (effective * TRANSACTION_FEE_RATE) / FEE_DENOMINATOR;
          const net = effective - fee;

          const mfgBefore = manufacturer.earnedBalance;
          const mfgAfter = mfgBefore + net;
          updateBalance(db, product.manufacturerId, 'earned_balance', mfgAfter);
          addToFeePool(db, fee);

          recordLog(db, product.manufacturerId, 'tx_receive', 'earned', net, mfgBefore, mfgAfter, tag.id, now);
          totalTransferred += effective;
          totalFees += fee;
          if (burnedUnverified > 0n) {
            totalBurned += burnedUnverified;
          }
        } else {
          // Manufacturer inactive: all of pointsAllocated burns (the multiplier
          // is moot — nothing reaches anyone either way).
          totalBurned += tag.pointsAllocated;
        }
      } else {
        // No manufacturer linked: points expire
        totalBurned += tag.pointsAllocated;
      }

      db.prepare("UPDATE supportive_tags SET status = 'finalized' WHERE id = ?").run(tag.id);
    }

    // Debit sender's supportive balance for everything allocated
    const totalAllocated = totalTransferred + totalBurned;
    if (totalAllocated > 0n) {
      const newSupp = acct.supportiveBalance - totalAllocated;
      updateBalance(db, accountId, 'supportive_balance', newSupp < 0n ? 0n : newSupp);
      recordLog(db, accountId, 'tx_send', 'supportive', totalAllocated, acct.supportiveBalance, newSupp < 0n ? 0n : newSupp, 'supportive_finalize', now);
    }

    // Burn any remaining unallocated supportive balance
    const afterAlloc = getAccount(db, accountId)!;
    if (afterAlloc.supportiveBalance > 0n) {
      const remaining = afterAlloc.supportiveBalance;
      updateBalance(db, accountId, 'supportive_balance', 0n);
      recordLog(db, accountId, 'burn_expire', 'supportive', remaining, remaining, 0n, 'supportive_expire', now);
      totalBurned += remaining;
    }
  });

  return { transferred: totalTransferred, burned: totalBurned, fees: totalFees };
}
