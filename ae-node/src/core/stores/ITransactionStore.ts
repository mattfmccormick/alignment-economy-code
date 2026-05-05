// Repository interface for transaction storage.
//
// Two tables live behind this interface:
//   - `transactions`     — one row per signed point-transfer
//   - `transaction_log`  — append-only audit trail of every balance change
//                          (mints, expirations, rebases, sends, receives, fees,
//                          court verdict applications). The log is what gives
//                          the protocol its "block replay" property: given the
//                          log, every account's current state is reproducible.
//
// Why combine them in one interface: they always travel together. processTransaction
// inserts into `transactions` and writes 3 log entries in the same SQL transaction.
// The day cycle reads `transaction_log` to test idempotency before re-running
// mint or rebase steps. Splitting them into two stores would force every caller
// to thread two dependencies through.

import type { ChangeType, PointType } from '../types.js';

export interface TransactionRow {
  id: string;
  from: string;
  to: string;
  amount: string;       // bigint serialized as text in storage
  fee: string;
  netAmount: string;
  pointType: PointType;
  isInPerson: boolean;
  memo: string;
  signature: string;
  /**
   * Receiver's countersignature (hex). Required (non-null) on
   * isInPerson rows since schema v8 — the protocol rejects in-person
   * txs without one. Null on regular non-in-person rows.
   */
  receiverSignature: string | null;
  timestamp: number;
  blockNumber: number | null;
}

export interface TransactionLogEntry {
  id: string;
  accountId: string;
  changeType: ChangeType;
  pointType: PointType | 'n/a';
  amount: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  referenceId: string;
  timestamp: number;
}

export interface TransactionLogRow {
  id: string;
  account_id: string;
  change_type: string;
  point_type: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  reference_id: string;
  timestamp: number;
}

export interface ITransactionStore {
  // ── transactions table ─────────────────────────────────────────

  /** Persist a signed transaction. Idempotent on id (PK). */
  insertTransaction(tx: Omit<TransactionRow, 'blockNumber'>): void;

  /** Look up a single transaction by id. */
  findTransactionById(id: string): TransactionRow | null;

  /** All transactions involving an account (sender or receiver). Newest first. Paged. */
  findTransactionsByAccount(
    accountId: string,
    opts: { limit: number; offset: number },
  ): TransactionRow[];

  /** Total transactions involving an account. Used for pagination meta. */
  countTransactionsByAccount(accountId: string): number;

  /**
   * Count of in-person transactions involving the account at or after the
   * given timestamp. Used by the decay engine to compute activity offsets
   * against percentHuman erosion.
   */
  countInPersonTransactionsSince(accountId: string, sinceTimestamp: number): number;

  /**
   * Stamp a list of transactions with the block number that committed them.
   * Called atomically as part of createBlock, so that on follower-side sync
   * the receiver can fetch txIds for any historical block and re-derive the
   * merkleRoot from them.
   *
   * Idempotent in two senses:
   *   - txIds that don't exist in the table are silently ignored (the SQL
   *     UPDATE just affects zero rows). This keeps tests that pass synthetic
   *     id strings (e.g. "tx1", "tx2") from breaking.
   *   - re-running the same (blockNumber, txIds) pair is safe.
   */
  linkTransactionsToBlock(blockNumber: number, txIds: string[]): void;

  /**
   * The list of transaction ids committed by a given block, sorted by the
   * order they were inserted (their original block-construction order, which
   * is what the merkleRoot was computed over). Empty list if the block has
   * no committed transactions or none were ever linked.
   */
  findTransactionIdsByBlock(blockNumber: number): string[];

  /**
   * Full transaction rows committed by a given block. Used by sync replies
   * to ship enough data for a follower to replay the block and reproduce
   * the authority's state byte-for-byte.
   */
  findTransactionsByBlock(blockNumber: number): TransactionRow[];

  /**
   * Transactions that have been committed locally but not yet included in
   * a block. The authority drains this list every block-production tick.
   * Sorted by id ASCII-ascending to match the merkleRoot computation
   * (computeMerkleRoot is set-based / sort-before-hash).
   */
  findUnblockedTransactions(): TransactionRow[];

  /**
   * Whether a transaction with this id already exists in storage. Used by
   * the follower-side replay path: if we already have the tx (e.g. from a
   * gossip-then-block-receive race), skip re-applying state effects but
   * still link it to the block.
   */
  hasTransaction(id: string): boolean;

  // ── transaction_log table ──────────────────────────────────────

  /** Append a single audit-log row. Used by every state-changing action. */
  insertLog(entry: TransactionLogEntry): void;

  /** All log rows for an account, optionally filtered by change type. Oldest first. */
  findLogsByAccount(accountId: string, changeType?: ChangeType): TransactionLogRow[];

  /**
   * Set of distinct account_ids that have a log entry with the given
   * (referenceId, changeType). Used by mint and rebase for idempotency:
   * "which accounts have I already credited on this day's reference id?"
   */
  findLogAccountIds(referenceId: string, changeType: ChangeType): Set<string>;
}
