// Commit-time execution: state as a function of the chain, not of arrival order.
//
// The bug this closes
// -------------------
// Under receipt-time execution, a transaction moved balances the instant the
// API or gossip accepted it. The block that later contained it merely recorded
// that it had happened.
//
// That is a double-spend vector, and not a subtle one. Submit two conflicting
// spends to two different validators at the same moment: each is individually
// valid against the state that node holds, so each node accepts the one it saw
// first. The two nodes now disagree about the sender's balance, and the first
// block containing both transactions is unappliable on both of them. The chain
// fail-stops, and the attacker has had two nodes acknowledge spends totalling
// twice the balance.
//
// It also made a state root impossible to enforce: honest nodes legitimately
// differ whenever messages arrive in different orders, so a mismatch could
// never be treated as a fault.
//
// Ordering is the one thing a blockchain is for. Doing the work before the
// ordering exists gives that away.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import {
  processTransaction,
  replayTransaction,
  acceptPendingTransaction,
  transactionStore,
} from '../src/core/transaction.js';
import { selectApplicableTransactions } from '../src/core/consensus/BftBlockProducer.js';
import { generateKeyPair, signPayload } from '../src/core/crypto.js';
import type { WireTransaction } from '../src/core/types.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const TS = 1786890000;

function sign(from: string, to: string, amount: bigint, privateKey: string): string {
  return signPayload(
    {
      from,
      to,
      amount: amount.toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    },
    TS,
    privateKey,
  );
}

describe('commit-time execution', () => {
  let db: DatabaseSync;
  let kp: ReturnType<typeof generateKeyPair>;
  let alice: string;
  let bob: string;
  let carol: string;

  beforeEach(() => {
    db = freshDb();
    kp = generateKeyPair();
    alice = createAccount(db, 'individual', 1, 100, kp.publicKey).account.id;
    bob = createAccount(db, 'individual', 1, 100).account.id;
    carol = createAccount(db, 'individual', 1, 100).account.id;
    updateBalance(db, alice, 'earned_balance', 100_00000000n);
  });

  function submit(to: string, amount: bigint, defer: boolean) {
    return processTransaction(
      db,
      {
        from: alice,
        to,
        amount,
        pointType: 'earned',
        isInPerson: false,
        recipientIsHuman: false,
        memo: '',
        timestamp: TS,
        signature: sign(alice, to, amount, kp.privateKey),
      },
      { defer },
    );
  }

  it('receipt mode moves balances immediately (the legacy behaviour)', () => {
    submit(bob, 10_00000000n, false);
    assert.equal(getAccount(db, alice)!.earnedBalance, 90_00000000n);
    assert.ok(getAccount(db, bob)!.earnedBalance > 0n);
  });

  it('commit mode moves nothing until the block applies it', () => {
    const res = submit(bob, 10_00000000n, true);

    assert.equal(getAccount(db, alice)!.earnedBalance, 100_00000000n, 'sender untouched');
    assert.equal(getAccount(db, bob)!.earnedBalance, 0n, 'recipient untouched');
    assert.equal(transactionStore(db).isApplied(res.transaction.id), false);

    // Now the block commits.
    replayTransaction(
      db,
      {
        id: res.transaction.id,
        from: alice,
        to: bob,
        amount: res.transaction.amount,
        fee: res.fee,
        netAmount: res.netAmount,
        pointType: 'earned',
        isInPerson: false,
        recipientIsHuman: false,
        memo: '',
        signature: res.transaction.signature,
        receiverSignature: null,
        timestamp: TS,
      },
      1,
    );

    assert.equal(getAccount(db, alice)!.earnedBalance, 90_00000000n);
    assert.equal(getAccount(db, bob)!.earnedBalance, res.netAmount);
    assert.equal(transactionStore(db).isApplied(res.transaction.id), true);
  });

  it('applying twice does not move money twice', () => {
    // Gossip is at-least-once and a block can be delivered by both the live
    // commit path and sync. Double-applying would mint value from nothing.
    const res = submit(bob, 10_00000000n, true);
    const wire = {
      id: res.transaction.id, from: alice, to: bob, amount: res.transaction.amount,
      fee: res.fee, netAmount: res.netAmount, pointType: 'earned' as const,
      isInPerson: false, recipientIsHuman: false, memo: '',
      signature: res.transaction.signature, receiverSignature: null, timestamp: TS,
    };

    replayTransaction(db, wire, 1);
    const after = getAccount(db, alice)!.earnedBalance;
    replayTransaction(db, wire, 1);
    replayTransaction(db, wire, 2);
    assert.equal(getAccount(db, alice)!.earnedBalance, after);
  });

  // ── the double-spend the old model allowed ───────────────────────────

  it('refuses a second spend that the first has already promised', () => {
    // Both are individually valid against the raw balance. Only netting off
    // what is already pending catches it — receipt-time execution got that
    // for free by mutating on the spot, and deferring has to do it explicitly.
    submit(bob, 60_00000000n, true);
    assert.throws(() => submit(carol, 60_00000000n, true), /Insufficient/);
  });

  it('names the pending amount in the error, not just the raw balance', () => {
    // Otherwise the message reads as a lie: "has 100, needs 60".
    submit(bob, 60_00000000n, true);
    assert.throws(
      () => submit(carol, 60_00000000n, true),
      /already pending in unconfirmed transactions/,
    );
  });

  it('a proposer never puts two conflicting spends in one block', () => {
    // The cross-node case: Alice sends the same points to Bob via one
    // validator and to Carol via another, so neither node saw the other's
    // transaction when it accepted. Both land in the pending set. A block
    // carrying both is unappliable on every node, so the proposer has to pick.
    const toBob = submit(bob, 60_00000000n, true);

    const conflicting: WireTransaction = {
      id: 'zzz-arrived-via-gossip',
      from: alice,
      to: carol,
      amount: '6000000000',
      fee: '0',
      netAmount: '6000000000',
      pointType: 'earned',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
      signature: sign(alice, carol, 60_00000000n, kp.privateKey),
      receiverSignature: null,
      timestamp: TS,
    } as unknown as WireTransaction;
    acceptPendingTransaction(db, {
      ...conflicting,
      amount: 60_00000000n,
      fee: 0n,
      netAmount: 60_00000000n,
    } as never);

    const pending = transactionStore(db).findUnblockedTransactions();
    assert.equal(pending.length, 2, 'both are candidates');

    const selected = selectApplicableTransactions(
      db,
      pending.map((r) => r as unknown as WireTransaction),
      1,
    );
    assert.equal(selected.length, 1, 'only one can be in the block');
    // Deterministic: ORDER BY id, so the lower id wins on every proposer.
    assert.equal(selected[0].id, [toBob.transaction.id, conflicting.id].sort()[0]);
  });

  it('selection leaves no trace on state', () => {
    // It is a rehearsal. If the rollback leaked, a proposer would credit
    // itself for blocks it merely considered.
    submit(bob, 10_00000000n, true);
    const before = getAccount(db, alice)!.earnedBalance;

    const pending = transactionStore(db).findUnblockedTransactions();
    selectApplicableTransactions(db, pending.map((r) => r as unknown as WireTransaction), 1);

    assert.equal(getAccount(db, alice)!.earnedBalance, before);
    assert.equal(transactionStore(db).isApplied(pending[0].id), false);
  });

  it('gossip files a transaction without applying it', () => {
    const other = freshDb();
    createAccount(other, 'individual', 1, 100, kp.publicKey);
    const bobOther = createAccount(other, 'individual', 1, 100).account.id;
    updateBalance(other, alice, 'earned_balance', 100_00000000n);

    acceptPendingTransaction(other, {
      id: 'gossiped-1', from: alice, to: bobOther, amount: 5_00000000n,
      fee: 0n, netAmount: 5_00000000n, pointType: 'earned',
      isInPerson: false, recipientIsHuman: false, memo: '',
      signature: sign(alice, bobOther, 5_00000000n, kp.privateKey),
      receiverSignature: null, timestamp: TS,
    });

    assert.equal(getAccount(other, alice)!.earnedBalance, 100_00000000n, 'nothing moved');
    assert.equal(transactionStore(other).hasTransaction('gossiped-1'), true, 'but it is known');
    assert.equal(transactionStore(other).isApplied('gossiped-1'), false);
  });

  it('gossip rejects a forged signature instead of filing it', () => {
    // Garbage must never reach the pending set: a proposer would put it in a
    // block that no honest node can apply.
    const wrong = generateKeyPair();
    assert.throws(
      () =>
        acceptPendingTransaction(db, {
          id: 'forged-1', from: alice, to: bob, amount: 1_00000000n,
          fee: 0n, netAmount: 1_00000000n, pointType: 'earned',
          isInPerson: false, recipientIsHuman: false, memo: '',
          signature: sign(alice, bob, 1_00000000n, wrong.privateKey),
          receiverSignature: null, timestamp: TS,
        }),
      /invalid signature/,
    );
    assert.equal(transactionStore(db).hasTransaction('forged-1'), false);
  });
});
