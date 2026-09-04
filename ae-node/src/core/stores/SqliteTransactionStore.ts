// SQLite implementation of ITransactionStore.
//
// All SQL against `transactions` and `transaction_log` lives here.

import { DatabaseSync } from 'node:sqlite';
import type { ChangeType, PointType } from '../types.js';
import type {
  ITransactionStore,
  TransactionLogEntry,
  TransactionLogRow,
  TransactionRow,
} from './ITransactionStore.js';

function rowToTransaction(row: Record<string, unknown>): TransactionRow {
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    amount: row.amount as string,
    fee: row.fee as string,
    netAmount: row.net_amount as string,
    pointType: row.point_type as PointType,
    isInPerson: (row.is_in_person as number) === 1,
    recipientIsHuman: (row.recipient_is_human as number) === 1,
    memo: (row.memo as string) ?? '',
    signature: row.signature as string,
    receiverSignature: (row.receiver_signature as string | null) ?? null,
    timestamp: row.timestamp as number,
    blockNumber: row.block_number === null ? null : (row.block_number as number),
  };
}

export class SqliteTransactionStore implements ITransactionStore {
  constructor(private readonly db: DatabaseSync) {}

  // ── transactions table ──────────────────────────────────────────

  insertTransaction(tx: Omit<TransactionRow, 'blockNumber'>, applied: boolean = true): void {
    this.db
      .prepare(
        `INSERT INTO transactions (id, "from", "to", amount, fee, net_amount, point_type, is_in_person, recipient_is_human, receiver_signature, memo, signature, timestamp, block_number, applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        tx.id,
        tx.from,
        tx.to,
        tx.amount,
        tx.fee,
        tx.netAmount,
        tx.pointType,
        tx.isInPerson ? 1 : 0,
        tx.recipientIsHuman ? 1 : 0,
        tx.receiverSignature,
        tx.memo,
        tx.signature,
        tx.timestamp,
        applied ? 1 : 0,
      );
  }

  /**
   * Has this transaction's balance effect been applied?
   *
   * Deliberately distinct from hasTransaction, which only asks whether the row
   * exists. Under commit-time execution a row exists from the moment the
   * transaction is accepted but moves no balances until its block commits, so
   * "known" and "applied" become different questions — and replayTransaction
   * has to ask the second one or it will skip work it still needs to do.
   */
  isApplied(id: string): boolean {
    const row = this.db
      .prepare('SELECT applied FROM transactions WHERE id = ? LIMIT 1')
      .get(id) as { applied: number } | undefined;
    return row?.applied === 1;
  }

  markApplied(id: string): void {
    this.db.prepare('UPDATE transactions SET applied = 1 WHERE id = ?').run(id);
  }

  updateAppliedValues(id: string, fee: bigint, netAmount: bigint): void {
    this.db
      .prepare('UPDATE transactions SET fee = ?, net_amount = ? WHERE id = ?')
      .run(fee.toString(), netAmount.toString(), id);
  }

  /**
   * Total still-unapplied outgoing amount for a sender in one point type.
   *
   * Under commit-time execution a pending transaction has not touched the
   * balance yet, so validating a new one against the raw balance would happily
   * accept the same points twice. Receipt-time execution got this for free by
   * mutating immediately; deferring means the check has to net off what is
   * already in flight.
   */
  pendingOutgoingTotal(from: string, pointType: string): bigint {
    const rows = this.db
      .prepare(
        `SELECT amount FROM transactions
          WHERE applied = 0 AND "from" = ? AND point_type = ?`,
      )
      .all(from, pointType) as Array<{ amount: string }>;
    return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  }

  findTransactionById(id: string): TransactionRow | null {
    const row = this.db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToTransaction(row) : null;
  }

  findTransactionsByAccount(
    accountId: string,
    opts: { limit: number; offset: number },
  ): TransactionRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM transactions WHERE "from" = ? OR "to" = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      )
      .all(accountId, accountId, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return rows.map(rowToTransaction);
  }

  countTransactionsByAccount(accountId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM transactions WHERE "from" = ? OR "to" = ?')
      .get(accountId, accountId) as { cnt: number };
    return row.cnt;
  }

  countInPersonTransactionsSince(accountId: string, sinceTimestamp: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM transactions
         WHERE ("from" = ? OR "to" = ?) AND is_in_person = 1 AND timestamp > ?`,
      )
      .get(accountId, accountId, sinceTimestamp) as { cnt: number };
    return row.cnt;
  }

  sumHumanTagCreditsSince(recipientId: string, sinceTimestamp: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(credit), 0) as total FROM human_tags
         WHERE recipient_id = ? AND created_at > ?`,
      )
      .get(recipientId, sinceTimestamp) as { total: number };
    return row.total;
  }

  insertHumanTag(
    id: string,
    recipientId: string,
    taggerId: string,
    taggerPercentHuman: number,
    credit: number,
    transactionId: string,
    createdAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO human_tags (id, recipient_id, tagger_id, tagger_percent_human, credit, transaction_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, recipientId, taggerId, taggerPercentHuman, credit, transactionId, createdAt);
  }

  linkTransactionsToBlock(blockNumber: number, txIds: string[]): void {
    if (txIds.length === 0) return;
    // SQLite's bound IN-list trick: build "?, ?, ?" placeholders.
    const placeholders = txIds.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE transactions SET block_number = ? WHERE id IN (${placeholders})`)
      .run(blockNumber, ...txIds);
  }

  findTransactionIdsByBlock(blockNumber: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM transactions WHERE block_number = ? ORDER BY id`)
      .all(blockNumber) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  findTransactionsByBlock(blockNumber: number): TransactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM transactions WHERE block_number = ? ORDER BY id`)
      .all(blockNumber) as Array<Record<string, unknown>>;
    return rows.map(rowToTransaction);
  }

  findUnblockedTransactions(): TransactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM transactions WHERE block_number IS NULL ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToTransaction);
  }

  hasTransaction(id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM transactions WHERE id = ? LIMIT 1`)
      .get(id) as { 1: number } | undefined;
    return row !== undefined;
  }

  // ── transaction_log table ───────────────────────────────────────

  insertLog(entry: TransactionLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO transaction_log (id, account_id, change_type, point_type, amount, balance_before, balance_after, reference_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.accountId,
        entry.changeType,
        entry.pointType,
        entry.amount.toString(),
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.referenceId,
        entry.timestamp,
      );
  }

  findLogsByAccount(accountId: string, changeType?: ChangeType): TransactionLogRow[] {
    if (changeType) {
      return this.db
        .prepare('SELECT * FROM transaction_log WHERE account_id = ? AND change_type = ? ORDER BY timestamp')
        .all(accountId, changeType) as unknown as TransactionLogRow[];
    }
    return this.db
      .prepare('SELECT * FROM transaction_log WHERE account_id = ? ORDER BY timestamp')
      .all(accountId) as unknown as TransactionLogRow[];
  }

  findLogAccountIds(referenceId: string, changeType: ChangeType): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT account_id FROM transaction_log WHERE reference_id = ? AND change_type = ?',
      )
      .all(referenceId, changeType) as Array<{ account_id: string }>;
    return new Set(rows.map((r) => r.account_id));
  }
}
