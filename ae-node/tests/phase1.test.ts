import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { generateKeyPair, deriveAccountId, signPayload } from '../src/core/crypto.js';
import {
  createAccount,
  getAccount,
  updateBalance,
} from '../src/core/account.js';
import {
  processTransaction,
  calculateFee,
  getTransactionLogs,
} from '../src/core/transaction.js';
import { getFeePool } from '../src/core/fee-pool.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

// Helper: convert display points to base units (e.g., 1440.0 -> 144_000_000_000)
function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function signTx(
  fromId: string,
  toId: string,
  amount: bigint,
  pointType: string,
  privateKey: string,
  opts: { isInPerson?: boolean; memo?: string } = {},
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    from: fromId,
    to: toId,
    amount: amount.toString(),
    pointType,
    isInPerson: opts.isInPerson ?? false,
    memo: opts.memo ?? '',
  };
  const signature = signPayload(payload, timestamp, privateKey);
  return { timestamp, signature };
}

describe('Phase 1: Core Ledger Engine', () => {
  it('creates 5 individual accounts with unique IDs derived from public keys', () => {
    const db = freshDb();
    const accounts = [];
    const privateKeys: string[] = [];

    for (let i = 0; i < 5; i++) {
      const result = createAccount(db, 'individual', 1, 100);
      accounts.push(result.account);
      privateKeys.push(result.privateKey);
      assert.equal(result.account.id, deriveAccountId(result.publicKey));
    }

    assert.equal(new Set(accounts.map((a) => a.id)).size, 5);
    assert.ok(privateKeys[0].length > 0);
    assert.equal((getAccount(db, accounts[0].id) as any)['privateKey'], undefined);
    db.close();
  });

  it('processes transaction: A sends 1000 Active to B with correct fee and audit trail', () => {
    const db = freshDb();
    const a = createAccount(db, 'individual', 1, 100);
    const b = createAccount(db, 'individual', 1, 100);

    const balance = pts(1000); // 1000.00000000 points
    updateBalance(db, a.account.id, 'active_balance', balance);

    const { timestamp, signature } = signTx(a.account.id, b.account.id, balance, 'active', a.privateKey);

    const result = processTransaction(db, {
      from: a.account.id, to: b.account.id, amount: balance,
      pointType: 'active', isInPerson: false, memo: '', timestamp, signature,
    });

    // Fee = 1000 * 0.005 = 5.0 points
    assert.equal(result.fee, pts(5));
    // Net = 995.0
    assert.equal(result.netAmount, pts(995));

    assert.equal(getAccount(db, a.account.id)!.activeBalance, 0n);
    assert.equal(getAccount(db, b.account.id)!.earnedBalance, pts(995));
    assert.equal(getFeePool(db).currentBalance, pts(5));

    const aLogs = getTransactionLogs(db, a.account.id);
    const bLogs = getTransactionLogs(db, b.account.id);
    assert.equal(aLogs.length, 2); // tx_send + fee
    assert.equal(bLogs.length, 1); // tx_receive
    db.close();
  });

  it('rejects transaction with insufficient balance, no state changes', () => {
    const db = freshDb();
    const a = createAccount(db, 'individual', 1, 100);
    const b = createAccount(db, 'individual', 1, 100);

    const amount = pts(1000);
    const { timestamp, signature } = signTx(a.account.id, b.account.id, amount, 'active', a.privateKey);

    assert.throws(
      () => processTransaction(db, {
        from: a.account.id, to: b.account.id, amount, pointType: 'active', timestamp, signature,
      }),
      /Insufficient/,
    );

    assert.equal(getAccount(db, a.account.id)!.activeBalance, 0n);
    assert.equal(getAccount(db, b.account.id)!.earnedBalance, 0n);
    assert.equal(getFeePool(db).currentBalance, 0n);
    db.close();
  });

  it('rejects transaction with invalid signature', () => {
    const db = freshDb();
    const a = createAccount(db, 'individual', 1, 100);
    const b = createAccount(db, 'individual', 1, 100);
    updateBalance(db, a.account.id, 'active_balance', pts(1000));

    const wrongKey = generateKeyPair();
    const { timestamp, signature } = signTx(a.account.id, b.account.id, pts(1000), 'active', wrongKey.privateKey);

    assert.throws(
      () => processTransaction(db, {
        from: a.account.id, to: b.account.id, amount: pts(1000), pointType: 'active', timestamp, signature,
      }),
      /Invalid transaction signature/,
    );
    db.close();
  });

  it('company accounts can receive earned points', () => {
    const db = freshDb();
    const ind = createAccount(db, 'individual', 1, 100);
    const co = createAccount(db, 'company', 1, 0);
    assert.equal(co.account.type, 'company');

    updateBalance(db, ind.account.id, 'active_balance', pts(500));
    const { timestamp, signature } = signTx(ind.account.id, co.account.id, pts(500), 'active', ind.privateKey);

    const result = processTransaction(db, {
      from: ind.account.id, to: co.account.id, amount: pts(500), pointType: 'active', timestamp, signature,
    });

    assert.equal(getAccount(db, co.account.id)!.earnedBalance, result.netAmount);
    db.close();
  });

  it('maintains precision over 10,000 transactions with no drift', () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 100);
    const receiver = createAccount(db, 'individual', 1, 100);

    updateBalance(db, sender.account.id, 'earned_balance', pts(10_000_000));

    let totalSent = 0n;
    let totalFees = 0n;
    let totalReceived = 0n;

    // Send 10.0 points per tx (large enough for non-zero fees)
    const txAmount = pts(10);
    for (let i = 0; i < 10000; i++) {
      const timestamp = Math.floor(Date.now() / 1000) + i;
      const payload = {
        from: sender.account.id, to: receiver.account.id,
        amount: txAmount.toString(), pointType: 'earned', isInPerson: false, memo: '',
      };
      const sig = signPayload(payload, timestamp, sender.privateKey);

      const result = processTransaction(db, {
        from: sender.account.id, to: receiver.account.id,
        amount: txAmount, pointType: 'earned', timestamp, signature: sig,
      });

      totalSent += txAmount;
      totalFees += result.fee;
      totalReceived += result.netAmount;
    }

    const senderAfter = getAccount(db, sender.account.id)!;
    const receiverAfter = getAccount(db, receiver.account.id)!;
    const pool = getFeePool(db);

    // fee per 10pt tx = 10 * 0.005 = 0.05 pts = 5_000_000 base units
    assert.equal(calculateFee(txAmount), pts(0.05));
    assert.equal(totalFees, pts(0.05) * 10000n);

    assert.equal(senderAfter.earnedBalance, pts(10_000_000) - totalSent);
    assert.equal(receiverAfter.earnedBalance, totalReceived);
    assert.equal(pool.totalAccumulated, totalFees);

    // Conservation: sent = received + fees
    assert.equal(totalSent, totalReceived + totalFees);
    db.close();
  });
});
