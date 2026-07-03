// Transaction business logic.
//
// All persistence goes through ITransactionStore (./stores/ITransactionStore.ts).
// processTransaction is the main protocol entry point — it validates the
// signature, checks the sender's balance, computes the fee, and writes one
// `transactions` row + three `transaction_log` rows in one DB transaction.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { verifyPayload } from './crypto.js';
import { TRANSACTION_FEE_RATE, FEE_DENOMINATOR } from './constants.js';
import { getAccount, updateBalance, accountStore } from './account.js';
import { addToFeePool } from './fee-pool.js';
import { runTransaction } from '../db/connection.js';
import { NotFoundError, ValidationError, ForbiddenError, InsufficientBalanceError } from './errors.js';
import { SqliteTransactionStore } from './stores/SqliteTransactionStore.js';
import type { ITransactionStore } from './stores/ITransactionStore.js';
import type { Transaction, PointType, ChangeType } from './types.js';

export function transactionStore(db: DatabaseSync): ITransactionStore {
  return new SqliteTransactionStore(db);
}

const BALANCE_FIELD_MAP: Record<PointType, Parameters<typeof updateBalance>[2]> = {
  active: 'active_balance',
  supportive: 'supportive_balance',
  ambient: 'ambient_balance',
  earned: 'earned_balance',
};

function getBalanceForType(
  account: NonNullable<ReturnType<typeof getAccount>>,
  pointType: PointType,
): bigint {
  switch (pointType) {
    case 'active': return account.activeBalance;
    case 'supportive': return account.supportiveBalance;
    case 'ambient': return account.ambientBalance;
    case 'earned': return account.earnedBalance;
  }
}

export function calculateFee(amount: bigint): bigint {
  return (amount * TRANSACTION_FEE_RATE) / FEE_DENOMINATOR;
}

export interface TransactionInput {
  from: string;
  to: string;
  amount: bigint;
  pointType: PointType;
  isInPerson?: boolean;
  recipientIsHuman?: boolean;
  memo?: string;
  timestamp: number;
  signature: string;
  /**
   * Receiver's countersignature, signed by the recipient over the same
   * canonical payload + timestamp the sender signed. Required when
   * isInPerson is true; ignored otherwise. Without this, processTransaction
   * rejects in-person flagged transactions to prevent score inflation
   * via unilateral attestations.
   */
  receiverSignature?: string;
}

export interface TransactionResult {
  transaction: Transaction;
  fee: bigint;
  netAmount: bigint;
}

/** Append a single audit-log row. Used by every state-changing protocol step. */
export function recordLog(
  db: DatabaseSync,
  accountId: string,
  changeType: ChangeType,
  pointType: PointType,
  amount: bigint,
  balanceBefore: bigint,
  balanceAfter: bigint,
  referenceId: string,
  timestamp: number,
): void {
  transactionStore(db).insertLog({
    id: uuid(),
    accountId,
    changeType,
    pointType,
    amount,
    balanceBefore,
    balanceAfter,
    referenceId,
    timestamp,
  });
}

/**
 * Apply a transaction's full set of state effects (balances, fee pool, tx row,
 * audit log) inside a single DB transaction. Both processTransaction (the
 * authoring path) and replayTransaction (the follower-replay path) share this
 * implementation; they differ only in whether the txId is freshly generated or
 * preserved from the wire, and whether the tx row already has a block number.
 *
 * Validation that's specific to the authoring path (cycle-phase guard, "cannot
 * send to self", etc.) lives in processTransaction itself. The replay path
 * skips those because the authority already enforced them.
 */
function applyTransactionInternal(
  db: DatabaseSync,
  opts: {
    txId: string;
    from: string;
    to: string;
    amount: bigint;
    pointType: PointType;
    isInPerson: boolean;
    recipientIsHuman: boolean;
    memo: string;
    signature: string;
    receiverSignature: string | null;
    timestamp: number;
    blockNumber: number | null;
    senderBalance: bigint;
    newSenderBalance: bigint;
    senderField: Parameters<typeof updateBalance>[2];
    recipientEarnedBefore: bigint;
    newRecipientEarned: bigint;
    fee: bigint;
    netAmount: bigint;
    burnedUnverified: bigint;
    senderPercentHuman: number;
  },
): void {
  const txStore = transactionStore(db);
  const sqliteTxStore = txStore as import('./stores/SqliteTransactionStore.js').SqliteTransactionStore;
  runTransaction(db, () => {
    updateBalance(db, opts.from, opts.senderField, opts.newSenderBalance);
    updateBalance(db, opts.to, 'earned_balance', opts.newRecipientEarned);
    addToFeePool(db, opts.fee);
    accountStore(db).setLastActivity(opts.from, opts.timestamp);

    txStore.insertTransaction({
      id: opts.txId,
      from: opts.from,
      to: opts.to,
      amount: opts.amount.toString(),
      fee: opts.fee.toString(),
      netAmount: opts.netAmount.toString(),
      pointType: opts.pointType,
      isInPerson: opts.isInPerson,
      recipientIsHuman: opts.recipientIsHuman,
      memo: opts.memo,
      signature: opts.signature,
      receiverSignature: opts.receiverSignature,
      timestamp: opts.timestamp,
    });

    if (opts.recipientIsHuman) {
      const credit = 2.5 * (opts.senderPercentHuman / 100);
      sqliteTxStore.insertHumanTag(
        uuid(), opts.to, opts.from, opts.senderPercentHuman,
        credit, opts.txId, opts.timestamp,
      );
    }

    if (opts.blockNumber !== null) {
      txStore.linkTransactionsToBlock(opts.blockNumber, [opts.txId]);
    }

    recordLog(db, opts.from, 'tx_send', opts.pointType, opts.amount, opts.senderBalance, opts.newSenderBalance, opts.txId, opts.timestamp);
    recordLog(db, opts.to, 'tx_receive', 'earned', opts.netAmount, opts.recipientEarnedBefore, opts.newRecipientEarned, opts.txId, opts.timestamp);
    recordLog(db, opts.from, 'fee', opts.pointType, opts.fee, opts.senderBalance, opts.newSenderBalance, opts.txId, opts.timestamp);
    if (opts.burnedUnverified > 0n) {
      recordLog(db, opts.from, 'burn_unverified', opts.pointType, opts.burnedUnverified, opts.senderBalance, opts.newSenderBalance, opts.txId, opts.timestamp);
    }
  });
}

/**
 * Re-apply a transaction received over the wire to bring follower state in
 * line with the authority. Verifies the signature against the embedded
 * publicKey of the sender, checks the balance, and runs the same atomic
 * effects processTransaction does — preserving the wire's original tx id.
 *
 * Idempotent: if a transaction with this id already exists locally, the
 * function returns silently. (It's possible a follower received the tx via
 * gossip before the block arrived; in that case state effects already ran.)
 *
 * Skips the cycle-phase guard intentionally — the authority already ran it
 * at authoring time, and a follower replaying historical blocks will often
 * be in a different cycle phase than when the tx was originally accepted.
 */
export interface ReplayInput {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  fee: bigint;
  netAmount: bigint;
  pointType: PointType;
  isInPerson: boolean;
  recipientIsHuman: boolean;
  memo: string;
  signature: string;
  receiverSignature: string | null;
  timestamp: number;
}

export function replayTransaction(
  db: DatabaseSync,
  input: ReplayInput,
  blockNumber: number | null = null,
): void {
  const txStore = transactionStore(db);
  if (txStore.hasTransaction(input.id)) {
    // Already applied locally. Three cases:
    //   - block-replay arriving after gossip already applied state →
    //     link to the block so historical sync stays correct
    //   - gossip arriving twice (echo, retry, multi-path) → no-op
    //   - block-replay arriving after a different block already linked
    //     this tx → idempotent UPDATE, same block_number wins
    if (blockNumber !== null) {
      txStore.linkTransactionsToBlock(blockNumber, [input.id]);
    }
    return;
  }

  const sender = getAccount(db, input.from);
  if (!sender) throw new Error(`Replay: sender account not found: ${input.from}`);
  const recipient = getAccount(db, input.to);
  if (!recipient) throw new Error(`Replay: recipient account not found: ${input.to}`);

  // Verify the signature the authority accepted. If our local payload-
  // canonicalization disagrees with theirs we'd diverge on every replay.
  const payload = {
    from: input.from,
    to: input.to,
    amount: input.amount.toString(),
    pointType: input.pointType,
    isInPerson: input.isInPerson,
    recipientIsHuman: input.recipientIsHuman,
    memo: input.memo,
  };
  const validSig = verifyPayload(payload, input.timestamp, input.signature, sender.publicKey);
  if (!validSig) throw new Error(`Replay: invalid signature on tx ${input.id}`);

  if (input.isInPerson) {
    if (!input.receiverSignature) {
      throw new Error(`Replay: in-person tx ${input.id} missing receiver countersignature`);
    }
    const validCounter = verifyPayload(payload, input.timestamp, input.receiverSignature, recipient.publicKey);
    if (!validCounter) throw new Error(`Replay: invalid receiver countersignature on tx ${input.id}`);
  }

  const senderField = BALANCE_FIELD_MAP[input.pointType];
  const senderBalance = getBalanceForType(sender, input.pointType);
  if (senderBalance < input.amount) {
    throw new Error(
      `Replay: insufficient ${input.pointType} balance for tx ${input.id}: has ${senderBalance}, needs ${input.amount}`,
    );
  }

  const burnedUnverified = input.amount - input.fee - input.netAmount;
  if (burnedUnverified < 0n) {
    throw new Error(`Replay: malformed tx ${input.id}: fee + netAmount > amount`);
  }

  applyTransactionInternal(db, {
    txId: input.id,
    from: input.from,
    to: input.to,
    amount: input.amount,
    pointType: input.pointType,
    isInPerson: input.isInPerson,
    recipientIsHuman: input.recipientIsHuman,
    memo: input.memo,
    signature: input.signature,
    receiverSignature: input.receiverSignature ?? null,
    timestamp: input.timestamp,
    blockNumber,
    senderBalance,
    newSenderBalance: senderBalance - input.amount,
    senderField,
    recipientEarnedBefore: recipient.earnedBalance,
    newRecipientEarned: recipient.earnedBalance + input.netAmount,
    fee: input.fee,
    netAmount: input.netAmount,
    burnedUnverified,
    senderPercentHuman: sender.percentHuman,
  });
}

export function processTransaction(
  db: DatabaseSync,
  input: TransactionInput,
): TransactionResult {
  const sender = getAccount(db, input.from);
  if (!sender) throw new NotFoundError(`Sender account not found: ${input.from}`);
  if (!sender.isActive) throw new ValidationError(`Sender account is inactive: ${input.from}`, 'ACCOUNT_INACTIVE');

  const recipient = getAccount(db, input.to);
  if (!recipient) throw new NotFoundError(`Recipient account not found: ${input.to}`);
  if (!recipient.isActive) throw new ValidationError(`Recipient account is inactive: ${input.to}`, 'ACCOUNT_INACTIVE');

  if (input.from === input.to) throw new ValidationError('Cannot send to self', 'SELF_TRANSFER');

  // WP v2 §9.3: escrowed accounts cannot send earned points. Daily
  // allocations (active/supportive/ambient) remain spendable.
  if (sender.isEscrowed && input.pointType === 'earned') {
    throw new ForbiddenError('Account is escrowed: earned-point transfers are frozen during court proceedings', 'ACCOUNT_ESCROWED');
  }

  // Cycle phase guard: during the white paper's "blackout minute" (08:59-09:00 UTC,
  // i.e. between expire+rebase and advance+mint), no daily-point transactions can
  // settle because every account's daily balance is 0. Earned-point transactions
  // are unaffected — saved value keeps moving regardless of the cycle.
  // (This still touches day_cycle_state directly. ICycleStateStore extraction
  // is a follow-up session.)
  if (input.pointType !== 'earned') {
    const phaseRow = db.prepare('SELECT cycle_phase FROM day_cycle_state WHERE id = 1').get() as { cycle_phase: string } | undefined;
    const phase = phaseRow?.cycle_phase ?? 'idle';
    if (phase !== 'idle' && phase !== 'active') {
      throw new ValidationError(`Daily-point transactions are paused during the ${phase} cycle phase`, 'CYCLE_PHASE_BLOCKED');
    }
  }

  // Verify signature
  const payload = {
    from: input.from,
    to: input.to,
    amount: input.amount.toString(),
    pointType: input.pointType,
    isInPerson: input.isInPerson ?? false,
    recipientIsHuman: input.recipientIsHuman ?? false,
    memo: input.memo ?? '',
  };
  const validSig = verifyPayload(payload, input.timestamp, input.signature, sender.publicKey);
  if (!validSig) throw new ValidationError('Invalid transaction signature', 'INVALID_SIGNATURE');

  // In-person attestation requires the receiver's countersignature over the
  // same payload bytes. Without it, the sender alone could mark any
  // transaction as in-person and inflate both parties' decay-offset counter,
  // which the whitepaper specifically guards against (§6.3 / Vegas Guy gap
  // 2.6 — counterparty consent is the whole point of the in-person attestation).
  if (input.isInPerson === true) {
    if (!input.receiverSignature) {
      throw new ValidationError('In-person transactions require the receiver countersignature', 'MISSING_COUNTERSIGNATURE');
    }
    const validCounter = verifyPayload(payload, input.timestamp, input.receiverSignature, recipient.publicKey);
    if (!validCounter) throw new ValidationError('Invalid receiver countersignature on in-person transaction', 'INVALID_COUNTERSIGNATURE');
  }

  // Check balance
  const senderBalance = getBalanceForType(sender, input.pointType);
  if (senderBalance < input.amount) {
    throw new InsufficientBalanceError(
      `Insufficient ${input.pointType} balance: has ${senderBalance}, needs ${input.amount}`,
    );
  }

  // WP v2: percentHuman discount applies only to daily-point spends
  // (active/supportive/ambient). Earned-point transactions pass through at
  // full value. Non-individual accounts (company/government) also spend
  // without discount since they don't receive daily allocations.
  const isDailyPointType = input.pointType !== 'earned';
  const isIndividual = sender.type === 'individual';
  const applyDiscount = isDailyPointType && isIndividual;
  const effectiveAmount = applyDiscount
    ? (input.amount * BigInt(sender.percentHuman)) / 100n
    : input.amount;
  const fee = calculateFee(effectiveAmount);
  const netAmount = effectiveAmount - fee;
  const burnedUnverified = input.amount - effectiveAmount;

  const txId = uuid();
  const now = input.timestamp;
  const senderField = BALANCE_FIELD_MAP[input.pointType];
  const newSenderBalance = senderBalance - input.amount;
  const recipientEarnedBefore = recipient.earnedBalance;
  const newRecipientEarned = recipientEarnedBefore + netAmount;

  applyTransactionInternal(db, {
    txId,
    from: input.from,
    to: input.to,
    amount: input.amount,
    pointType: input.pointType,
    isInPerson: input.isInPerson ?? false,
    recipientIsHuman: input.recipientIsHuman ?? false,
    memo: input.memo ?? '',
    signature: input.signature,
    receiverSignature: input.isInPerson ? (input.receiverSignature ?? null) : null,
    timestamp: now,
    blockNumber: null,
    senderBalance,
    newSenderBalance,
    senderField,
    recipientEarnedBefore,
    newRecipientEarned,
    fee,
    netAmount,
    burnedUnverified,
    senderPercentHuman: sender.percentHuman,
  });

  const transaction: Transaction = {
    id: txId,
    from: input.from,
    to: input.to,
    amount: input.amount,
    fee,
    netAmount,
    pointType: input.pointType,
    isInPerson: input.isInPerson ?? false,
    recipientIsHuman: input.recipientIsHuman ?? false,
    memo: input.memo ?? '',
    signature: input.signature,
    receiverSignature: input.isInPerson ? (input.receiverSignature ?? null) : null,
    timestamp: now,
    blockNumber: null,
  };

  return { transaction, fee, netAmount };
}

/**
 * Read raw transaction-log rows for an account. Used by API routes that
 * surface the audit trail and by the verification system. Returns the
 * legacy snake_case shape for back-compat with existing callers.
 */
export function getTransactionLogs(
  db: DatabaseSync,
  accountId: string,
  changeType?: ChangeType,
): Array<{
  id: string;
  account_id: string;
  change_type: string;
  point_type: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  reference_id: string;
  timestamp: number;
}> {
  return transactionStore(db).findLogsByAccount(accountId, changeType);
}
