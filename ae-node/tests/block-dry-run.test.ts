// Pre-vote dry run: a validator must not vote for a block it cannot apply.
//
// Why this exists
// ---------------
// Content validation used to be stash-presence plus a timestamp check. The
// comment in BftBlockProducer conceded it outright: "a stash-presence check IS
// the content check for now". So a follower would prevote and precommit a block
// that was guaranteed to throw on its own apply — an unknown sender, a balance
// its local state said was too low — and only discover the problem after a
// commit certificate already existed for it.
//
// That is the worst possible ordering. The network produces a certificate for a
// block half the validators cannot apply, and every one of them then has to
// fail-stop. Catching it at vote time instead makes the round fail cleanly and
// retry, and no certificate is ever produced.
//
// The dry run must also leave NO trace. It replays real transactions against
// real state; if the rollback ever leaked, a validator would silently credit
// itself balances for blocks it merely considered.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { dryRunBlockTransactions } from '../src/core/consensus/BftBlockProducer.js';
import { generateKeyPair, signPayload } from '../src/core/crypto.js';
import type { WireTransaction } from '../src/core/types.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const TS = 1786890000;

function makeTx(
  from: string,
  to: string,
  amount: bigint,
  privateKey: string,
  id = 'tx-1',
): WireTransaction {
  const payload = {
    from,
    to,
    amount: amount.toString(),
    pointType: 'earned' as const,
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
  };
  return {
    id,
    from,
    to,
    amount,
    fee: 0n,
    netAmount: amount,
    pointType: 'earned',
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
    signature: signPayload(payload, TS, privateKey),
    receiverSignature: null,
    timestamp: TS,
  } as unknown as WireTransaction;
}

describe('pre-vote block dry run', () => {
  let db: DatabaseSync;
  let senderKp: ReturnType<typeof generateKeyPair>;
  let sender: string;
  let recipient: string;

  beforeEach(() => {
    db = freshDb();
    senderKp = generateKeyPair();
    sender = createAccount(db, 'individual', 1, 100, senderKp.publicKey).account.id;
    recipient = createAccount(db, 'individual', 1, 100).account.id;
    updateBalance(db, sender, 'earned_balance', 500_00000000n);
  });

  it('accepts an empty block', () => {
    assert.deepEqual(dryRunBlockTransactions(db, [], 1), { valid: true });
  });

  it('accepts a block this node can apply', () => {
    const tx = makeTx(sender, recipient, 12_00000000n, senderKp.privateKey);
    assert.equal(dryRunBlockTransactions(db, [tx], 1).valid, true);
  });

  it('leaves no trace: balances are unchanged after a successful dry run', () => {
    // The whole design rests on this. A leaked rollback would let a validator
    // credit itself for blocks it only considered voting on.
    const before = {
      sender: getAccount(db, sender)!.earnedBalance,
      recipient: getAccount(db, recipient)!.earnedBalance,
    };

    const tx = makeTx(sender, recipient, 12_00000000n, senderKp.privateKey);
    assert.equal(dryRunBlockTransactions(db, [tx], 1).valid, true);

    assert.equal(getAccount(db, sender)!.earnedBalance, before.sender);
    assert.equal(getAccount(db, recipient)!.earnedBalance, before.recipient);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    assert.equal(rows.c, 0, 'the dry run must not persist the transaction');
  });

  it('rejects a block whose sender this node has never heard of', () => {
    // The exact shape of the account-replication failure: a wallet account
    // created on the proposer, gossip not yet arrived here.
    const strangerKp = generateKeyPair();
    const strangerId = 'ab'.repeat(20);
    const tx = makeTx(strangerId, recipient, 5_00000000n, strangerKp.privateKey);

    const result = dryRunBlockTransactions(db, [tx], 1);
    assert.equal(result.valid, false);
    assert.match(result.error!, /sender account not found/);
  });

  it('rejects a block that overdraws against local state', () => {
    const tx = makeTx(sender, recipient, 900_00000000n, senderKp.privateKey);
    const result = dryRunBlockTransactions(db, [tx], 1);
    assert.equal(result.valid, false);
    assert.match(result.error!, /insufficient/i);
  });

  it('rejects the whole block when any single transaction fails', () => {
    // Blocks apply atomically, so validity is all-or-nothing. A block that is
    // 90% fine is still a block this node cannot apply.
    const good = makeTx(sender, recipient, 1_00000000n, senderKp.privateKey, 'tx-good');
    const bad = makeTx('cd'.repeat(20), recipient, 1_00000000n, senderKp.privateKey, 'tx-bad');

    assert.equal(dryRunBlockTransactions(db, [good, bad], 1).valid, false);
    // And the good one did not sneak through.
    const rows = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    assert.equal(rows.c, 0);
  });

  it('leaves no trace after a rejected block either', () => {
    const before = getAccount(db, sender)!.earnedBalance;
    const good = makeTx(sender, recipient, 1_00000000n, senderKp.privateKey, 'tx-good');
    const bad = makeTx('cd'.repeat(20), recipient, 1_00000000n, senderKp.privateKey, 'tx-bad');

    dryRunBlockTransactions(db, [good, bad], 1);

    assert.equal(getAccount(db, sender)!.earnedBalance, before);
  });

  it('is repeatable: the same block dry-runs the same way twice', () => {
    // The controller validates once before prevote and again before precommit.
    // If the first run mutated anything, the second would disagree.
    const tx = makeTx(sender, recipient, 12_00000000n, senderKp.privateKey);
    const first = dryRunBlockTransactions(db, [tx], 1);
    const second = dryRunBlockTransactions(db, [tx], 1);
    assert.deepEqual(first, second);
    assert.equal(second.valid, true);
  });
});
