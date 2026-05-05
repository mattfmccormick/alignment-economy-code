// Phase 70: smart contract — earned_recurring + validation guards.
//
// Whitepaper §5 calls for "smart contracts between participants and
// entities." Pre-Phase-70, three types existed: supportive_auto and
// ambient_auto (auto-tagging) and active_standing (% of daily active
// to one recipient). Phase 70 adds:
//
//   earned_recurring: send a FIXED display-unit amount of earned points
//                     to targetId on schedule. Skipped if balance is
//                     short — recurring transfers don't accumulate IOUs.
//                     percentHuman still gates value transfer.
//
// Plus stronger validation in createSmartContract:
//   - active_standing / earned_recurring contracts now require a real,
//     active recipient at creation time.
//   - Self-targeting is rejected (was previously allowed; harmless but
//     pointless).
//
// What this phase locks in:
//   - earned_recurring sends a fixed amount through fee + percentHuman
//     paths exactly like a normal tx.
//   - Insufficient balance -> skip with reason, no partial state change.
//   - Inactive recipient -> skip.
//   - Validation on creation: bad recipient, self-target, zero/negative
//     amount.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance, deactivateAccount } from '../src/core/account.js';
import { createSmartContract, executeContracts } from '../src/tagging/smart-contracts.js';
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

function makeAccount(db: DatabaseSync, earnedDisplay = 0, percentHuman = 100) {
  const r = createAccount(db, 'individual', 1, percentHuman);
  if (earnedDisplay > 0) updateBalance(db, r.account.id, 'earned_balance', pts(earnedDisplay));
  return r.account;
}

describe('Phase 70: earned_recurring smart contracts + validation guards', () => {

  it('creates an earned_recurring contract with a positive amount', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000);
    const recipient = makeAccount(db);

    const contract = createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'daily');
    assert.equal(contract.type, 'earned_recurring');
    assert.equal(contract.targetId, recipient.id);
    assert.equal(contract.allocationPercent, 50); // re-used as fixed amount
    db.close();
  });

  it('rejects earned_recurring with zero or negative amount', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000);
    const recipient = makeAccount(db);

    assert.throws(
      () => createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 0, 'daily'),
      /positive amount/,
    );
    assert.throws(
      () => createSmartContract(db, sender.id, 'earned_recurring', recipient.id, -10, 'daily'),
      /positive amount/,
    );
    db.close();
  });

  it('rejects creation when target account is missing or inactive or self', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000);
    const recipient = makeAccount(db);

    assert.throws(
      () => createSmartContract(db, sender.id, 'earned_recurring', 'no-such-account', 50, 'daily'),
      /Target account not found/,
    );
    assert.throws(
      () => createSmartContract(db, sender.id, 'earned_recurring', sender.id, 50, 'daily'),
      /Cannot target your own account/,
    );

    deactivateAccount(db, recipient.id);
    assert.throws(
      () => createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'daily'),
      /Target account is inactive/,
    );
    db.close();
  });

  it('executes earned_recurring: sender debited full amount, recipient credited net (after fee)', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000);
    const recipient = makeAccount(db);

    createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'daily');

    // dayOfWeek = 3 (Wednesday) — daily schedule fires regardless.
    const results = executeContracts(db, sender.id, 1, 3);
    const r = results.find((x) => x.type === 'earned_recurring');
    assert.ok(r);
    assert.equal(r.executed, true);

    const senderAfter = getAccount(db, sender.id)!;
    const recipientAfter = getAccount(db, recipient.id)!;

    // Sender debited the full 50 pts in display units.
    assert.equal(senderAfter.earnedBalance, pts(1000) - pts(50));

    // Recipient gets net = effective - fee. With percentHuman=100 there's
    // no slippage; effective = 50, fee = 50 * 0.005 = 0.25, net = 49.75.
    const expectedFee = pts(50) * 5n / 1000n; // 0.5% fee
    const expectedNet = pts(50) - expectedFee;
    assert.equal(recipientAfter.earnedBalance, expectedNet);
    db.close();
  });

  it('skips earned_recurring when balance is short (no IOU accumulation)', () => {
    const db = freshDb();
    const sender = makeAccount(db, 10);
    const recipient = makeAccount(db);

    createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'daily');
    const results = executeContracts(db, sender.id, 1, 3);
    const r = results.find((x) => x.type === 'earned_recurring');
    assert.ok(r);
    assert.equal(r.executed, false);
    assert.match(r.reason ?? '', /insufficient/i);

    const senderAfter = getAccount(db, sender.id)!;
    assert.equal(senderAfter.earnedBalance, pts(10), 'no debit on skip');
    db.close();
  });

  it('skips earned_recurring when recipient becomes inactive after creation', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000);
    const recipient = makeAccount(db);

    createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'daily');
    deactivateAccount(db, recipient.id);

    const results = executeContracts(db, sender.id, 1, 3);
    const r = results.find((x) => x.type === 'earned_recurring');
    assert.ok(r);
    assert.equal(r.executed, false);
    assert.equal(r.reason, 'recipient inactive');

    const senderAfter = getAccount(db, sender.id)!;
    assert.equal(senderAfter.earnedBalance, pts(1000), 'no debit on skip');
    db.close();
  });

  it('earned_recurring honors percentHuman: 0% sender drains earned, recipient gets nothing', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000, 0); // 0% verified
    const recipient = makeAccount(db);

    createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'daily');
    const results = executeContracts(db, sender.id, 1, 3);
    const r = results.find((x) => x.type === 'earned_recurring');
    assert.equal(r?.executed, true);

    const senderAfter = getAccount(db, sender.id)!;
    const recipientAfter = getAccount(db, recipient.id)!;
    // Sender lost the full intent (50 pts).
    assert.equal(senderAfter.earnedBalance, pts(1000) - pts(50));
    // Effective = 50 * 0/100 = 0. Recipient got 0.
    assert.equal(recipientAfter.earnedBalance, 0n);
    db.close();
  });

  it('respects schedule + override flags just like other contract types', () => {
    const db = freshDb();
    const sender = makeAccount(db, 1000);
    const recipient = makeAccount(db);

    // weekend-only contract; running on a weekday (3 = Wednesday) should skip.
    createSmartContract(db, sender.id, 'earned_recurring', recipient.id, 50, 'weekend');
    const wedResults = executeContracts(db, sender.id, 1, 3);
    const wedRow = wedResults.find((x) => x.type === 'earned_recurring');
    assert.equal(wedRow?.executed, false);
    assert.equal(wedRow?.reason, 'not scheduled');

    // Saturday (6) should fire.
    const satResults = executeContracts(db, sender.id, 1, 6);
    const satRow = satResults.find((x) => x.type === 'earned_recurring');
    assert.equal(satRow?.executed, true);
    db.close();
  });
});
