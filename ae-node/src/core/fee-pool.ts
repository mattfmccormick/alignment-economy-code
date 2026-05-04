import { DatabaseSync } from 'node:sqlite';
import type { FeePool } from './types.js';

export function getFeePool(db: DatabaseSync): FeePool {
  const row = db.prepare('SELECT * FROM fee_pool WHERE id = 1').get() as Record<string, unknown>;
  return {
    totalAccumulated: BigInt(row.total_accumulated as string),
    totalDistributed: BigInt(row.total_distributed as string),
    currentBalance: BigInt(row.current_balance as string),
  };
}

export function addToFeePool(db: DatabaseSync, amount: bigint): void {
  const pool = getFeePool(db);
  const newAccum = pool.totalAccumulated + amount;
  const newBalance = pool.currentBalance + amount;
  db.prepare(
    'UPDATE fee_pool SET total_accumulated = ?, current_balance = ? WHERE id = 1'
  ).run(newAccum.toString(), newBalance.toString());
}

export function distributeFromFeePool(db: DatabaseSync, amount: bigint): void {
  const pool = getFeePool(db);
  if (amount > pool.currentBalance) {
    throw new Error(`Cannot distribute ${amount} from fee pool with balance ${pool.currentBalance}`);
  }
  const newDistributed = pool.totalDistributed + amount;
  const newBalance = pool.currentBalance - amount;
  db.prepare(
    'UPDATE fee_pool SET total_distributed = ?, current_balance = ? WHERE id = 1'
  ).run(newDistributed.toString(), newBalance.toString());
}
