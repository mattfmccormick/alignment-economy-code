import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount, updateBalance } from '../core/account.js';
import { recordLog, calculateFee } from '../core/transaction.js';
import { addToFeePool } from '../core/fee-pool.js';
import { runTransaction } from '../db/connection.js';
import { submitSupportiveTags } from './supportive.js';
import { submitAmbientTags } from './ambient.js';
import type { SmartContract, ContractType } from './types.js';

function rowToContract(row: Record<string, unknown>): SmartContract {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    type: row.type as ContractType,
    targetId: row.target_id as string,
    schedule: row.schedule as SmartContract['schedule'],
    startMinute: row.start_minute as number | null,
    endMinute: row.end_minute as number | null,
    daysOfWeek: row.days_of_week ? JSON.parse(row.days_of_week as string) : null,
    allocationPercent: row.allocation_percent as number,
    isActive: (row.is_active as number) === 1,
    overriddenToday: (row.overridden_today as number) === 1,
    createdAt: row.created_at as number,
  };
}

export function createSmartContract(
  db: DatabaseSync,
  accountId: string,
  type: ContractType,
  targetId: string,
  allocationPercent: number,
  schedule: SmartContract['schedule'] = 'daily',
  startMinute?: number,
  endMinute?: number,
  daysOfWeek?: number[],
): SmartContract {
  // For most types, allocationPercent is a percentage (1..100). For
  // earned_recurring it's repurposed as a fixed display-unit amount of
  // earned points (1..unbounded), so the validator branches on type.
  if (type === 'earned_recurring') {
    if (allocationPercent <= 0) throw new Error('earned_recurring requires a positive amount');
  } else {
    if (allocationPercent <= 0 || allocationPercent > 100) throw new Error('allocationPercent must be 1-100');
  }

  const acct = getAccount(db, accountId);
  if (!acct) throw new Error('Account not found');

  // For account-targeted contracts the recipient must exist + be active
  // at creation time. (We don't re-check on every execution; if the
  // recipient is later deactivated, executeContracts catches that and
  // skips the run with reason='recipient inactive'.)
  if (type === 'active_standing' || type === 'earned_recurring') {
    const recipient = getAccount(db, targetId);
    if (!recipient) throw new Error(`Target account not found: ${targetId}`);
    if (!recipient.isActive) throw new Error(`Target account is inactive: ${targetId}`);
    if (targetId === accountId) throw new Error('Cannot target your own account');
  }

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO smart_contracts (id, account_id, type, target_id, schedule, start_minute, end_minute, days_of_week, allocation_percent, is_active, overridden_today, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
  ).run(
    id, accountId, type, targetId, schedule,
    startMinute ?? null, endMinute ?? null,
    daysOfWeek ? JSON.stringify(daysOfWeek) : null,
    allocationPercent, now,
  );

  return getSmartContract(db, id)!;
}

export function getSmartContract(db: DatabaseSync, contractId: string): SmartContract | null {
  const row = db.prepare('SELECT * FROM smart_contracts WHERE id = ?').get(contractId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToContract(row);
}

export function getAccountContracts(db: DatabaseSync, accountId: string): SmartContract[] {
  const rows = db.prepare(
    'SELECT * FROM smart_contracts WHERE account_id = ? AND is_active = 1'
  ).all(accountId) as Array<Record<string, unknown>>;
  return rows.map(rowToContract);
}

export function overrideContract(db: DatabaseSync, contractId: string): void {
  db.prepare('UPDATE smart_contracts SET overridden_today = 1 WHERE id = ?').run(contractId);
}

export function resetDailyOverrides(db: DatabaseSync): void {
  db.prepare('UPDATE smart_contracts SET overridden_today = 0 WHERE is_active = 1').run();
}

function isScheduleActive(contract: SmartContract, dayOfWeek: number): boolean {
  switch (contract.schedule) {
    case 'daily': return true;
    case 'weekday': return dayOfWeek >= 1 && dayOfWeek <= 5;
    case 'weekend': return dayOfWeek === 0 || dayOfWeek === 6;
    case 'custom':
      if (!contract.daysOfWeek) return true;
      return contract.daysOfWeek.includes(dayOfWeek);
  }
}

export interface ContractExecution {
  contractId: string;
  type: ContractType;
  executed: boolean;
  reason?: string;
}

export function executeContracts(
  db: DatabaseSync,
  accountId: string,
  day: number,
  dayOfWeek: number,
): ContractExecution[] {
  const contracts = getAccountContracts(db, accountId);
  const results: ContractExecution[] = [];

  for (const contract of contracts) {
    if (contract.overriddenToday) {
      results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'overridden' });
      continue;
    }

    if (!isScheduleActive(contract, dayOfWeek)) {
      results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'not scheduled' });
      continue;
    }

    if (contract.type === 'supportive_auto') {
      // Calculate minutes based on schedule (startMinute/endMinute or full day)
      const minutes = contract.startMinute != null && contract.endMinute != null
        ? contract.endMinute - contract.startMinute
        : 1440;

      submitSupportiveTags(db, accountId, day, [{ productId: contract.targetId, minutesUsed: minutes }]);
      results.push({ contractId: contract.id, type: contract.type, executed: true });
    } else if (contract.type === 'ambient_auto') {
      const minutes = contract.startMinute != null && contract.endMinute != null
        ? contract.endMinute - contract.startMinute
        : 1440;

      submitAmbientTags(db, accountId, day, [{ spaceId: contract.targetId, minutesOccupied: minutes }]);
      results.push({ contractId: contract.id, type: contract.type, executed: true });
    } else if (contract.type === 'earned_recurring') {
      // Fixed display-unit amount stored in allocationPercent (legacy
      // column reuse to avoid a schema bump). Convert to base units and
      // attempt the transfer. Skip silently if the sender is short —
      // recurring transfers don't accumulate IOUs.
      const acct = getAccount(db, accountId)!;
      const PRECISION = 100_000_000n;
      const amount = BigInt(Math.round(contract.allocationPercent)) * PRECISION;
      if (amount <= 0n) {
        results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'zero amount' });
      } else if (acct.earnedBalance < amount) {
        results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'insufficient earned balance' });
      } else {
        const recipient = getAccount(db, contract.targetId);
        if (!recipient || !recipient.isActive) {
          results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'recipient inactive' });
        } else {
          // percentHuman applies to recurring earned transfers too —
          // unverified accounts can't move value via standing contracts
          // either, otherwise sybil setups would route around the spend
          // multiplier just by configuring an active_standing.
          const effective = (amount * BigInt(acct.percentHuman)) / 100n;
          const burned = amount - effective;
          const fee = calculateFee(effective);
          const net = effective - fee;
          const now = Math.floor(Date.now() / 1000);

          runTransaction(db, () => {
            const newEarned = acct.earnedBalance - amount;
            updateBalance(db, accountId, 'earned_balance', newEarned);
            recordLog(db, accountId, 'tx_send', 'earned', amount, acct.earnedBalance, newEarned, contract.id, now);

            const recipBefore = recipient.earnedBalance;
            const recipAfter = recipBefore + net;
            updateBalance(db, contract.targetId, 'earned_balance', recipAfter);
            recordLog(db, contract.targetId, 'tx_receive', 'earned', net, recipBefore, recipAfter, contract.id, now);

            addToFeePool(db, fee);
            if (burned > 0n) {
              recordLog(db, accountId, 'burn_unverified', 'earned', burned, acct.earnedBalance, newEarned, contract.id, now);
            }
          });
          results.push({ contractId: contract.id, type: contract.type, executed: true });
        }
      }
    } else if (contract.type === 'active_standing') {
      // Send active points to target account
      const acct = getAccount(db, accountId)!;
      const amount = (acct.activeBalance * BigInt(Math.round(contract.allocationPercent * 100))) / 10000n;

      if (amount > 0n) {
        const recipient = getAccount(db, contract.targetId);
        if (recipient && recipient.isActive) {
          const now = Math.floor(Date.now() / 1000);
          const fee = calculateFee(amount);
          const net = amount - fee;

          runTransaction(db, () => {
            const newActive = acct.activeBalance - amount;
            updateBalance(db, accountId, 'active_balance', newActive);
            recordLog(db, accountId, 'tx_send', 'active', amount, acct.activeBalance, newActive, contract.id, now);

            const recipBefore = recipient.earnedBalance;
            const recipAfter = recipBefore + net;
            updateBalance(db, contract.targetId, 'earned_balance', recipAfter);
            recordLog(db, contract.targetId, 'tx_receive', 'earned', net, recipBefore, recipAfter, contract.id, now);

            addToFeePool(db, fee);
          });

          results.push({ contractId: contract.id, type: contract.type, executed: true });
        } else {
          results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'recipient inactive' });
        }
      } else {
        results.push({ contractId: contract.id, type: contract.type, executed: false, reason: 'zero balance' });
      }
    }
  }

  return results;
}
