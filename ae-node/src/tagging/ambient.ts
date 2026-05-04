import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { DAILY_AMBIENT_POINTS, TRANSACTION_FEE_RATE, FEE_DENOMINATOR } from '../core/constants.js';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { addToFeePool } from '../core/fee-pool.js';
import { runTransaction } from '../db/connection.js';
import { getSpace, getSpaceAncestors } from './spaces.js';
import type { AmbientTag } from './types.js';

function rowToTag(row: Record<string, unknown>): AmbientTag {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    day: row.day as number,
    spaceId: row.space_id as string,
    minutesOccupied: row.minutes_occupied as number,
    pointsAllocated: BigInt(row.points_allocated as string),
    status: row.status as 'active' | 'finalized',
  };
}

export interface AmbientTagInput {
  spaceId: string;
  minutesOccupied: number;
}

export function submitAmbientTags(
  db: DatabaseSync,
  accountId: string,
  day: number,
  tags: AmbientTagInput[],
): AmbientTag[] {
  if (tags.length === 0) return [];

  const acct = getAccount(db, accountId);
  if (!acct) throw new Error('Account not found');

  for (const tag of tags) {
    if (!getSpace(db, tag.spaceId)) throw new Error(`Space not found: ${tag.spaceId}`);
    if (tag.minutesOccupied <= 0) throw new Error('minutesOccupied must be positive');
  }

  const totalMinutes = tags.reduce((sum, t) => sum + t.minutesOccupied, 0);

  // A day has 1,440 minutes. The combined ambient occupancy can't exceed it
  // — you can only be in one place at a time. Tracked separately from the
  // supportive cap because a person can simultaneously occupy a space and
  // use a durable good.
  if (totalMinutes > 1440) {
    throw new Error(`Total ambient minutes ${totalMinutes} exceeds the 1,440-minute daily cap`);
  }

  // Delete existing active tags for re-submission
  db.prepare("DELETE FROM ambient_tags WHERE account_id = ? AND day = ? AND status = 'active'").run(accountId, day);

  const result: AmbientTag[] = [];

  for (const tag of tags) {
    const share = BigInt(tag.minutesOccupied) * DAILY_AMBIENT_POINTS / BigInt(totalMinutes);
    const id = uuid();

    db.prepare(
      `INSERT INTO ambient_tags (id, account_id, day, space_id, minutes_occupied, points_allocated, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).run(id, accountId, day, tag.spaceId, tag.minutesOccupied, share.toString());

    result.push({
      id, accountId, day, spaceId: tag.spaceId,
      minutesOccupied: tag.minutesOccupied, pointsAllocated: share, status: 'active',
    });
  }

  return result;
}

export function getAmbientTags(db: DatabaseSync, accountId: string, day: number): AmbientTag[] {
  const rows = db.prepare(
    'SELECT * FROM ambient_tags WHERE account_id = ? AND day = ?'
  ).all(accountId, day) as Array<Record<string, unknown>>;
  return rows.map(rowToTag);
}

export interface HierarchyDistribution {
  spaceId: string;
  spaceName: string;
  entityId: string | null;
  amount: bigint;
  fee: bigint;
}

export function distributeAmbientThroughHierarchy(
  db: DatabaseSync,
  spaceId: string,
  totalPoints: bigint,
): HierarchyDistribution[] {
  const space = getSpace(db, spaceId);
  if (!space) throw new Error('Space not found');

  const distributions: HierarchyDistribution[] = [];
  const ancestors = getSpaceAncestors(db, spaceId);

  // Leaf space gets the full amount first
  let amountAtCurrentLevel = totalPoints;

  // The leaf space entity gets points, then each parent takes its collection rate
  // from what flows through
  distributions.push({
    spaceId: space.id,
    spaceName: space.name,
    entityId: space.entityId,
    amount: amountAtCurrentLevel,
    fee: 0n,
  });

  // Walk up the hierarchy: each parent takes collectionRate% from what the child received
  for (const ancestor of ancestors) {
    if (ancestor.collectionRate <= 0) continue;

    const collection = (amountAtCurrentLevel * BigInt(Math.round(ancestor.collectionRate * 100))) / 10000n;
    if (collection === 0n) continue;

    const fee = (collection * TRANSACTION_FEE_RATE) / FEE_DENOMINATOR;

    distributions.push({
      spaceId: ancestor.id,
      spaceName: ancestor.name,
      entityId: ancestor.entityId,
      amount: collection,
      fee,
    });

    // The amount passing up to the next level is what this level collected
    amountAtCurrentLevel = collection;
  }

  return distributions;
}

export function finalizeAmbientTags(db: DatabaseSync, accountId: string, day: number): {
  transferred: bigint;
  burned: bigint;
  fees: bigint;
  distributions: HierarchyDistribution[];
} {
  const tags = db.prepare(
    "SELECT * FROM ambient_tags WHERE account_id = ? AND day = ? AND status = 'active'"
  ).all(accountId, day) as Array<Record<string, unknown>>;

  const acct = getAccount(db, accountId)!;
  const now = Math.floor(Date.now() / 1000);
  let totalTransferred = 0n;
  let totalBurned = 0n;
  let totalFees = 0n;
  const allDistributions: HierarchyDistribution[] = [];

  runTransaction(db, () => {
    for (const row of tags) {
      const tag = rowToTag(row);

      // percentHuman multiplier applies before the hierarchy distribution: only
      // (pointsAllocated * pH/100) flows into the space + its ancestors. The
      // rest burns as unverified-spend slippage. Same sybil-prevention logic
      // as the supportive path.
      const effective = (tag.pointsAllocated * BigInt(acct.percentHuman)) / 100n;
      const burnedUnverified = tag.pointsAllocated - effective;

      const distributions = distributeAmbientThroughHierarchy(db, tag.spaceId, effective);
      allDistributions.push(...distributions);

      for (const dist of distributions) {
        if (dist.entityId) {
          const entity = getAccount(db, dist.entityId);
          if (entity && entity.isActive) {
            const fee = (dist.amount * TRANSACTION_FEE_RATE) / FEE_DENOMINATOR;
            const net = dist.amount - fee;
            const before = entity.earnedBalance;
            const after = before + net;
            updateBalance(db, dist.entityId, 'earned_balance', after);
            addToFeePool(db, fee);
            recordLog(db, dist.entityId, 'tx_receive', 'earned', net, before, after, tag.id, now);
            totalTransferred += dist.amount;
            totalFees += fee;
          } else {
            totalBurned += dist.amount;
          }
        }
        // No entity: points at this level are unclaimed (burned for now)
      }

      if (burnedUnverified > 0n) {
        totalBurned += burnedUnverified;
      }

      db.prepare("UPDATE ambient_tags SET status = 'finalized' WHERE id = ?").run(tag.id);
    }

    // Debit ambient balance
    const totalAllocated = totalTransferred + totalBurned;
    if (totalAllocated > 0n) {
      const newAmb = acct.ambientBalance - totalAllocated;
      updateBalance(db, accountId, 'ambient_balance', newAmb < 0n ? 0n : newAmb);
    }

    // Burn remaining unallocated ambient
    const afterAlloc = getAccount(db, accountId)!;
    if (afterAlloc.ambientBalance > 0n) {
      const remaining = afterAlloc.ambientBalance;
      updateBalance(db, accountId, 'ambient_balance', 0n);
      recordLog(db, accountId, 'burn_expire', 'ambient', remaining, remaining, 0n, 'ambient_expire', now);
      totalBurned += remaining;
    }
  });

  return { transferred: totalTransferred, burned: totalBurned, fees: totalFees, distributions: allDistributions };
}
