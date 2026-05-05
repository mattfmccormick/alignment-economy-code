// Phase 67: in-person transactions require the receiver's countersignature.
//
// Whitepaper §6.3 / Vegas Guy gap 2.6. An in-person attestation gives both
// parties a +2.5% percent-human offset on the next decay run, so a
// malicious sender could spam isInPerson=true txs to inflate scores —
// theirs and the recipient's — without consent. The fix per the whitepaper:
// dual-sign the canonical payload. The recipient's countersignature over
// the same bytes proves consent.
//
// What this phase locks in:
//   - processTransaction rejects isInPerson=true txs without a receiver
//     signature.
//   - processTransaction rejects isInPerson=true txs whose receiver
//     signature was forged or signed with the wrong key.
//   - A correctly counter-signed isInPerson tx is accepted, persists with
//     a non-null receiver_signature, and counts toward
//     countInPersonTransactionsSince for both parties.
//   - Regular (non-in-person) transactions still work without a receiver
//     signature — backwards compat.
//
// Replay path is exercised indirectly: applyTransactionInternal stores the
// receiverSignature; once a block ships, replayTransaction re-verifies it
// against the recipient's publicKey before applying. A dedicated replay
// test would duplicate phase 16/17 plumbing; the live-path checks here
// plus the schema migration test cover the persistence side.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { generateKeyPair, signPayload } from '../src/core/crypto.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { processTransaction } from '../src/core/transaction.js';
import { transactionStore } from '../src/core/transaction.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

interface TestParty {
  accountId: string;
  publicKey: string;
  privateKey: string;
}

function makeParty(db: DatabaseSync, earnedDisplay: number, percentHuman: number): TestParty {
  const kp = generateKeyPair();
  const result = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  updateBalance(db, result.account.id, 'earned_balance', pts(earnedDisplay));
  return {
    accountId: result.account.id,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  };
}

function buildPayload(opts: {
  from: string;
  to: string;
  amount: bigint;
  pointType: 'earned';
  isInPerson: boolean;
  memo?: string;
}) {
  return {
    from: opts.from,
    to: opts.to,
    amount: opts.amount.toString(),
    pointType: opts.pointType,
    isInPerson: opts.isInPerson,
    memo: opts.memo ?? '',
  };
}

describe('Phase 67: in-person transactions require receiver countersignature', () => {

  it('rejects isInPerson=true with no receiverSignature', () => {
    const db = freshDb();
    const sender = makeParty(db, 1000, 100);
    const recipient = makeParty(db, 0, 100);
    const ts = Math.floor(Date.now() / 1000);
    const payload = buildPayload({ from: sender.accountId, to: recipient.accountId, amount: pts(50), pointType: 'earned', isInPerson: true });
    const sig = signPayload(payload, ts, sender.privateKey);

    assert.throws(
      () => processTransaction(db, {
        from: sender.accountId,
        to: recipient.accountId,
        amount: pts(50),
        pointType: 'earned',
        isInPerson: true,
        memo: '',
        timestamp: ts,
        signature: sig,
      }),
      /receiver countersignature/i,
    );

    db.close();
  });

  it('rejects isInPerson=true with a forged receiverSignature (signed by sender, not recipient)', () => {
    const db = freshDb();
    const sender = makeParty(db, 1000, 100);
    const recipient = makeParty(db, 0, 100);
    const ts = Math.floor(Date.now() / 1000);
    const payload = buildPayload({ from: sender.accountId, to: recipient.accountId, amount: pts(50), pointType: 'earned', isInPerson: true });
    const sig = signPayload(payload, ts, sender.privateKey);
    const forgedCounter = signPayload(payload, ts, sender.privateKey); // same key, not recipient's

    assert.throws(
      () => processTransaction(db, {
        from: sender.accountId,
        to: recipient.accountId,
        amount: pts(50),
        pointType: 'earned',
        isInPerson: true,
        memo: '',
        timestamp: ts,
        signature: sig,
        receiverSignature: forgedCounter,
      }),
      /Invalid receiver countersignature/i,
    );

    db.close();
  });

  it('accepts isInPerson=true with a valid receiverSignature; counts for both parties', () => {
    const db = freshDb();
    const sender = makeParty(db, 1000, 100);
    const recipient = makeParty(db, 0, 100);
    const ts = Math.floor(Date.now() / 1000);
    const payload = buildPayload({ from: sender.accountId, to: recipient.accountId, amount: pts(50), pointType: 'earned', isInPerson: true });
    const sig = signPayload(payload, ts, sender.privateKey);
    const counter = signPayload(payload, ts, recipient.privateKey);

    const result = processTransaction(db, {
      from: sender.accountId,
      to: recipient.accountId,
      amount: pts(50),
      pointType: 'earned',
      isInPerson: true,
      memo: '',
      timestamp: ts,
      signature: sig,
      receiverSignature: counter,
    });

    assert.equal(result.transaction.isInPerson, true);
    assert.equal(result.transaction.receiverSignature, counter);

    // Persisted row carries the countersignature.
    const stored = transactionStore(db).findTransactionById(result.transaction.id);
    assert.ok(stored);
    assert.equal(stored.receiverSignature, counter);
    assert.equal(stored.isInPerson, true);

    // Both sides counted as in-person participants for the decay window.
    const since = ts - 1;
    const senderCount = transactionStore(db).countInPersonTransactionsSince(sender.accountId, since);
    const recipientCount = transactionStore(db).countInPersonTransactionsSince(recipient.accountId, since);
    assert.equal(senderCount, 1);
    assert.equal(recipientCount, 1);

    db.close();
  });

  it('still accepts a regular (non-in-person) transaction without a receiverSignature', () => {
    const db = freshDb();
    const sender = makeParty(db, 1000, 100);
    const recipient = makeParty(db, 0, 100);
    const ts = Math.floor(Date.now() / 1000);
    const payload = buildPayload({ from: sender.accountId, to: recipient.accountId, amount: pts(25), pointType: 'earned', isInPerson: false });
    const sig = signPayload(payload, ts, sender.privateKey);

    const result = processTransaction(db, {
      from: sender.accountId,
      to: recipient.accountId,
      amount: pts(25),
      pointType: 'earned',
      isInPerson: false,
      memo: '',
      timestamp: ts,
      signature: sig,
    });

    assert.equal(result.transaction.isInPerson, false);
    assert.equal(result.transaction.receiverSignature, null);

    // No in-person count change for either side.
    const since = ts - 1;
    assert.equal(transactionStore(db).countInPersonTransactionsSince(sender.accountId, since), 0);
    assert.equal(transactionStore(db).countInPersonTransactionsSince(recipient.accountId, since), 0);

    db.close();
  });

  it('rejects isInPerson=true even when receiverSignature is signed by a third party', () => {
    const db = freshDb();
    const sender = makeParty(db, 1000, 100);
    const recipient = makeParty(db, 0, 100);
    const eve = makeParty(db, 0, 100); // attacker holding her own key
    const ts = Math.floor(Date.now() / 1000);
    const payload = buildPayload({ from: sender.accountId, to: recipient.accountId, amount: pts(10), pointType: 'earned', isInPerson: true });
    const sig = signPayload(payload, ts, sender.privateKey);
    const eveCounter = signPayload(payload, ts, eve.privateKey);

    assert.throws(
      () => processTransaction(db, {
        from: sender.accountId,
        to: recipient.accountId,
        amount: pts(10),
        pointType: 'earned',
        isInPerson: true,
        memo: '',
        timestamp: ts,
        signature: sig,
        receiverSignature: eveCounter,
      }),
      /Invalid receiver countersignature/i,
    );

    db.close();
  });
});
