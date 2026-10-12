// Transfers that arrive from a PEER obey the same rules as transfers that
// arrive over HTTP.
//
// processTransaction (HTTP) refused self-transfers, and the request schema
// refused non-positive amounts before it was ever called. The two paths a peer
// controls had neither check: gossip (acceptPendingTransaction) and block
// contents (replayTransaction). Each case below is a transaction an attacker
// can sign entirely with their own key and that honest nodes used to apply:
//
//   1. negative amount to a victim  -> the victim is debited, the attacker
//      credited, and the victim signed nothing (theft)
//   2. earned-point self-transfer   -> credit overwrites debit on one row, the
//      balance grows by the net amount (minting)
//   3. captured signature, fresh id -> dedup is by id, so an old payment
//      applies a second time (replay)
//
// Every test asserts the rejection AND that no balance moved, because a throw
// after a partial write would be its own bug.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { generateKeyPair, deriveAccountId, signPayload } from '../src/core/crypto.js';
import {
  replayTransaction,
  acceptPendingTransaction,
  processTransaction,
  deriveTxId,
  type ReplayInput,
} from '../src/core/transaction.js';
import { getFeePool } from '../src/core/fee-pool.js';
import { transactionStore } from '../src/core/transaction.js';

const PTS = 100_000_000n; // one point, base units
const TS = 1_700_000_000;

function node(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

interface Party { id: string; pub: string; priv: string }
function party(): Party {
  const kp = generateKeyPair();
  return { id: deriveAccountId(kp.publicKey), pub: kp.publicKey, priv: kp.privateKey };
}

/** A wire-shaped earned-point transfer signed by `signer`. `id` defaults to the derived one. */
function wireTx(signer: Party, from: string, to: string, amount: bigint, id?: string): ReplayInput {
  const payload = {
    from,
    to,
    amount: amount.toString(),
    pointType: 'earned' as const,
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
  };
  const signature = signPayload(payload, TS, signer.priv);
  return {
    id: id ?? deriveTxId(signature),
    from,
    to,
    amount,
    // What a lying peer would put on the wire so the fee + net <= amount
    // admission check passes. These are discarded and re-derived anyway.
    fee: 0n,
    netAmount: amount,
    pointType: 'earned',
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
    signature,
    receiverSignature: null,
    timestamp: TS,
  };
}

function setup() {
  const db = node();
  const attacker = party();
  const victim = party();
  createAccount(db, 'individual', 1, 100, attacker.pub);
  createAccount(db, 'individual', 1, 100, victim.pub);
  updateBalance(db, attacker.id, 'earned_balance', 50n * PTS);
  updateBalance(db, victim.id, 'earned_balance', 1_000n * PTS);
  // Give the fee pool a balance so a negative fee would have had something to take.
  db.prepare('UPDATE fee_pool SET total_accumulated = ?, current_balance = ? WHERE id = 1')
    .run((10n * PTS).toString(), (10n * PTS).toString());
  return { db, attacker, victim };
}

function snapshot(db: DatabaseSync, ...ids: string[]) {
  return {
    earned: ids.map((id) => getAccount(db, id)!.earnedBalance),
    pool: getFeePool(db).currentBalance,
  };
}

describe('peer-supplied transfers: negative amount (theft)', () => {
  it('gossip admission rejects it and stores nothing', () => {
    const { db, attacker, victim } = setup();
    const tx = wireTx(attacker, attacker.id, victim.id, -500n * PTS);
    const before = snapshot(db, attacker.id, victim.id);

    assert.throws(() => acceptPendingTransaction(db, tx), /non-positive amount/);

    assert.equal(transactionStore(db).hasTransaction(tx.id), false, 'never entered the pending set');
    assert.deepEqual(snapshot(db, attacker.id, victim.id), before);
  });

  it('block replay rejects it and moves no balance', () => {
    const { db, attacker, victim } = setup();
    const tx = wireTx(attacker, attacker.id, victim.id, -500n * PTS);
    const before = snapshot(db, attacker.id, victim.id);

    assert.throws(() => replayTransaction(db, tx, 1), /non-positive amount/);

    assert.deepEqual(snapshot(db, attacker.id, victim.id), before, 'victim not debited, attacker not credited, pool untouched');
  });

  it('a zero amount is rejected too', () => {
    const { db, attacker, victim } = setup();
    assert.throws(() => replayTransaction(db, wireTx(attacker, attacker.id, victim.id, 0n), 1), /non-positive amount/);
    assert.throws(() => acceptPendingTransaction(db, wireTx(attacker, attacker.id, victim.id, 0n)), /non-positive amount/);
  });

  it('the HTTP entry point enforces the same rule itself, not only through the request schema', () => {
    const { db, attacker, victim } = setup();
    const tx = wireTx(attacker, attacker.id, victim.id, -500n * PTS);
    const before = snapshot(db, attacker.id, victim.id);

    assert.throws(
      () => processTransaction(db, {
        from: tx.from, to: tx.to, amount: tx.amount, pointType: 'earned',
        timestamp: tx.timestamp, signature: tx.signature,
      }),
      /greater than zero/,
    );
    assert.deepEqual(snapshot(db, attacker.id, victim.id), before);
  });
});

describe('peer-supplied transfers: self-transfer (minting)', () => {
  it('gossip admission rejects it', () => {
    const { db, attacker } = setup();
    const tx = wireTx(attacker, attacker.id, attacker.id, 40n * PTS);

    assert.throws(() => acceptPendingTransaction(db, tx), /self-transfer/);
    assert.equal(transactionStore(db).hasTransaction(tx.id), false);
  });

  it('block replay rejects it and the balance does not grow', () => {
    const { db, attacker } = setup();
    const tx = wireTx(attacker, attacker.id, attacker.id, 40n * PTS);
    const before = snapshot(db, attacker.id);

    assert.throws(() => replayTransaction(db, tx, 1), /self-transfer/);

    assert.deepEqual(snapshot(db, attacker.id), before);
  });
});

describe('peer-supplied transfers: replay under a fresh id', () => {
  it('an honest transfer applies once, and the same signature under another id is refused', () => {
    const { db, attacker, victim } = setup();
    // An ordinary payment from the victim to the attacker. It applies normally.
    const honest = wireTx(victim, victim.id, attacker.id, 100n * PTS);
    replayTransaction(db, honest, 1);
    const afterFirst = snapshot(db, attacker.id, victim.id);
    assert.equal(afterFirst.earned[1], 900n * PTS, 'victim paid 100 once');

    // The attacker saw that signature on the wire and resubmits the identical
    // signed bytes under an id of their choosing.
    const replayed: ReplayInput = { ...honest, id: 'a-fresh-id-the-attacker-made-up' };

    assert.throws(() => acceptPendingTransaction(db, replayed), /not derived from its signature/);
    assert.throws(() => replayTransaction(db, replayed, 2), /not derived from its signature/);
    assert.deepEqual(snapshot(db, attacker.id, victim.id), afterFirst, 'victim was not charged a second time');
  });

  it('re-delivery of the same transfer under its real id stays an idempotent no-op', () => {
    const { db, attacker, victim } = setup();
    const honest = wireTx(victim, victim.id, attacker.id, 100n * PTS);
    replayTransaction(db, honest, 1);
    const afterFirst = snapshot(db, attacker.id, victim.id);

    replayTransaction(db, honest, 1);
    acceptPendingTransaction(db, honest);

    assert.deepEqual(snapshot(db, attacker.id, victim.id), afterFirst);
  });
});
