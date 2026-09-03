// Transaction business logic.
//
// All persistence goes through ITransactionStore (./stores/ITransactionStore.ts).
// processTransaction is the main protocol entry point — it validates the
// signature, checks the sender's balance, computes the fee, and writes one
// `transactions` row + three `transaction_log` rows in one DB transaction.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { verifyPayload, sha256 } from './crypto.js';
import { TRANSACTION_FEE_RATE, FEE_DENOMINATOR } from './constants.js';
import { getAccount, updateBalance, accountStore } from './account.js';
import { addToFeePool } from './fee-pool.js';
import { runTransaction } from '../db/connection.js';
import { NotFoundError, ValidationError, ForbiddenError, InsufficientBalanceError } from './errors.js';
import { cycleStateStore } from './stores/SqliteCycleStateStore.js';
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
    /**
     * The transaction row is already on disk (accepted earlier, unapplied)
     * and only its balance effect is being made now. Inserting again would
     * violate the primary key.
     */
    skipInsert?: boolean;
  },
): void {
  const txStore = transactionStore(db);
  const sqliteTxStore = txStore as import('./stores/SqliteTransactionStore.js').SqliteTransactionStore;
  runTransaction(db, () => {
    updateBalance(db, opts.from, opts.senderField, opts.newSenderBalance);
    updateBalance(db, opts.to, 'earned_balance', opts.newRecipientEarned);
    addToFeePool(db, opts.fee);
    accountStore(db).setLastActivity(opts.from, opts.timestamp);

    if (!opts.skipInsert) {
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
    }

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

/**
 * Record a gossiped transaction as pending, without applying it.
 *
 * The commit-time counterpart of the gossip path. Under receipt-time execution
 * a peer applied a gossiped transaction on the spot; here it is only filed, so
 * that whichever validator becomes proposer can include it in a block and every
 * node applies it in the same order when that block commits.
 *
 * Signature and account existence are verified now rather than at apply time,
 * so garbage never reaches the pending set and cannot be proposed into a block
 * that no honest node can apply. The balance is deliberately NOT checked: at
 * this point it is a candidate, and whether it fits is a question about the
 * ordering that does not exist yet. Block building answers that.
 *
 * Idempotent — gossip is at-least-once and relayed.
 */
export function acceptPendingTransaction(db: DatabaseSync, input: ReplayInput): void {
  const txStore = transactionStore(db);
  if (txStore.hasTransaction(input.id)) return;

  const sender = getAccount(db, input.from);
  if (!sender) throw new Error(`Pending: sender account not found: ${input.from}`);
  const recipient = getAccount(db, input.to);
  if (!recipient) throw new Error(`Pending: recipient account not found: ${input.to}`);

  const payload = {
    from: input.from,
    to: input.to,
    amount: input.amount.toString(),
    pointType: input.pointType,
    isInPerson: input.isInPerson,
    recipientIsHuman: input.recipientIsHuman,
    memo: input.memo,
  };
  if (!verifyPayload(payload, input.timestamp, input.signature, sender.publicKey)) {
    throw new Error(`Pending: invalid signature on tx ${input.id}`);
  }
  if (input.isInPerson) {
    if (!input.receiverSignature) {
      throw new Error(`Pending: in-person tx ${input.id} missing receiver countersignature`);
    }
    if (!verifyPayload(payload, input.timestamp, input.receiverSignature, recipient.publicKey)) {
      throw new Error(`Pending: invalid receiver countersignature on tx ${input.id}`);
    }
  }
  if (input.amount - input.fee - input.netAmount < 0n) {
    throw new Error(`Pending: malformed tx ${input.id}: fee + netAmount > amount`);
  }

  txStore.insertTransaction(
    {
      id: input.id,
      from: input.from,
      to: input.to,
      amount: input.amount.toString(),
      fee: input.fee.toString(),
      netAmount: input.netAmount.toString(),
      pointType: input.pointType,
      isInPerson: input.isInPerson,
      recipientIsHuman: input.recipientIsHuman,
      memo: input.memo,
      signature: input.signature,
      receiverSignature: input.receiverSignature ?? null,
      timestamp: input.timestamp,
    },
    /* applied */ false,
  );
}

export function replayTransaction(
  db: DatabaseSync,
  input: ReplayInput,
  blockNumber: number | null = null,
): void {
  const txStore = transactionStore(db);
  if (txStore.isApplied(input.id)) {
    // Balance effect already made. Three cases:
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

  // Gate on `applied`, not on row existence. Under commit-time execution the
  // row is written the moment the transaction is accepted and sits there
  // unapplied until its block commits, so an existence check would skip the
  // very work this call exists to do and the money would never move.
  const alreadyKnown = txStore.hasTransaction(input.id);

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
    // The row may already be on disk in an unapplied state (commit-time
    // execution), in which case insert would violate the primary key.
    skipInsert: alreadyKnown,
  });
  if (alreadyKnown) {
    txStore.markApplied(input.id);
    if (blockNumber !== null) txStore.linkTransactionsToBlock(blockNumber, [input.id]);
  }
}

/**
 * Validate and accept a transaction.
 *
 * Two execution models, selected by `opts.defer`:
 *
 * RECEIPT-TIME (defer: false, the historical behaviour). Balances move here,
 * the instant the transaction is accepted. The block that later contains it
 * merely records that it happened.
 *
 * COMMIT-TIME (defer: true). The transaction is validated and persisted
 * unapplied; no balance moves until its block commits.
 *
 * Why the second mode exists: receipt-time execution makes state a function of
 * message ARRIVAL ORDER rather than of the chain, which is a double-spend
 * vector. Submit two conflicting spends to two different validators at the same
 * moment and each accepts the one it saw first — both are individually valid
 * against the state that node held. Now the two nodes hold different balances,
 * and the first block containing both is unappliable on both of them. Ordering
 * is exactly what a blockchain is for; doing the work before the ordering
 * exists gives it away.
 */
/**
 * Transaction id derived from the SENDER'S SIGNATURE.
 *
 * A replay resubmits the captured signature bytes verbatim, so hashing them
 * yields the same id and the duplicate is rejected. A genuinely re-issued
 * payment is signed afresh, and ML-DSA-65 signing is randomised (two signatures
 * over identical bytes differ), so it gets a different id and is allowed -
 * including two identical-amount payments to the same person in the same
 * second, which a payload+timestamp hash would have wrongly rejected as a
 * replay. This keys dedup on exactly the artifact a replay reuses.
 */
export function deriveTxId(signature: string): string {
  return sha256(`ae.txid.v1
${signature}`);
}

export function processTransaction(
  db: DatabaseSync,
  input: TransactionInput,
  opts: { defer?: boolean } = {},
): TransactionResult {
  const defer = opts.defer === true;
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
  if (input.pointType !== 'earned') {
    const phase = cycleStateStore(db).getCyclePhase() ?? 'idle';
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

  // Check balance.
  //
  // Under commit-time execution, previously accepted transactions have not
  // moved the balance yet, so the raw figure overstates what is actually
  // spendable. Netting off what is already in flight is what stops the same
  // points being promised twice — receipt-time execution got that for free by
  // mutating on the spot.
  const senderBalance = getBalanceForType(sender, input.pointType);
  const inFlight = defer
    ? transactionStore(db).pendingOutgoingTotal(input.from, input.pointType)
    : 0n;
  const spendable = senderBalance - inFlight;
  if (spendable < input.amount) {
    throw new InsufficientBalanceError(
      inFlight > 0n
        ? `Insufficient ${input.pointType} balance: has ${senderBalance}, ` +
          `${inFlight} already pending in unconfirmed transactions, ` +
          `${spendable} spendable, needs ${input.amount}`
        : `Insufficient ${input.pointType} balance: has ${senderBalance}, needs ${input.amount}`,
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

  // Deterministic id derived from the signed content, NOT a random uuid.
  //
  // Replay protection (audit #2). The signed message is
  // JSON.stringify(payload) + timestamp; hashing it (plus `from`, already in
  // payload but included explicitly for clarity) yields an id that is identical
  // for identical signed bytes. A replayed transaction therefore collides on
  // this id and is rejected below, rather than minting a second row under a
  // fresh uuid the way it used to. Two DISTINCT legitimate payments differ in
  // timestamp (seconds) or any field, so they still get distinct ids; the only
  // thing this rejects is a byte-identical resubmission. A per-account nonce
  // (documented as the deeper fix) would also separate two identical payments
  // within the same second, which this does not.
  const txId = deriveTxId(input.signature);
  if (transactionStore(db).hasTransaction(txId)) {
    throw new ValidationError(
      'Duplicate transaction: these exact signed bytes were already submitted',
      'DUPLICATE_TRANSACTION',
    );
  }
  const now = input.timestamp;
  const senderField = BALANCE_FIELD_MAP[input.pointType];
  const newSenderBalance = senderBalance - input.amount;
  const recipientEarnedBefore = recipient.earnedBalance;
  const newRecipientEarned = recipientEarnedBefore + netAmount;

  if (defer) {
    // Persist only. No balance moves, no fee-pool credit, no audit log — all
    // of that happens when the block carrying this transaction commits, on
    // every node, in the order the chain fixed.
    //
    // The fee/netAmount/burn computed above still ride the row and the wire,
    // because replayTransaction applies them verbatim so that every node
    // reaches identical numbers rather than each recomputing against its own
    // view of the sender's percentHuman.
    transactionStore(db).insertTransaction(
      {
        id: txId,
        from: input.from,
        to: input.to,
        amount: input.amount.toString(),
        fee: fee.toString(),
        netAmount: netAmount.toString(),
        pointType: input.pointType,
        isInPerson: input.isInPerson ?? false,
        recipientIsHuman: input.recipientIsHuman ?? false,
        memo: input.memo ?? '',
        signature: input.signature,
        receiverSignature: input.isInPerson ? (input.receiverSignature ?? null) : null,
        timestamp: now,
      },
      /* applied */ false,
    );
  } else {
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
  }

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
