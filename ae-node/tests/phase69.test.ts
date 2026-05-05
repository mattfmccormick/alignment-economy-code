// Phase 69: inheritance + dead-man-switch.
//
// Whitepaper §10. An account holder configures M-of-N beneficiaries plus
// an inactivity threshold. After the account has been silent past the
// threshold, beneficiaries can co-sign a claim that drains the dead
// account's earned balance into theirs. Solves the "lost-key pollution"
// problem — without inheritance, an abandoned account holds value forever
// and dilutes everyone else through the rebase target.
//
// What this phase locks in:
//   - setInheritance validates the config (existence, threshold range,
//     min days, no-self-beneficiary).
//   - The dead-man-switch is armed by `lastActivityAt + deadManSwitchDays`
//     (in days * 86,400 sec). Brand-new accounts that never sent can't
//     be claimed.
//   - claimInheritance verifies enough beneficiary signatures to meet
//     the threshold; signatures from outsiders or non-existent
//     accounts don't count.
//   - On success, earned balance distributes evenly to the actual
//     signers (not all listed beneficiaries) and the deceased account
//     is deactivated.
//   - Insufficient signatures fail loudly without partial state changes.
//
// processTransaction is implicitly tested via the lastActivityAt bump:
// after a successful tx, the sender's clock starts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { signPayload } from '../src/core/crypto.js';
import { processTransaction } from '../src/core/transaction.js';
import { setInheritance, claimInheritance, InheritanceError } from '../src/core/inheritance.js';
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

interface Party {
  accountId: string;
  publicKey: string;
  privateKey: string;
}

function makeParty(db: DatabaseSync, earnedDisplay: number = 0): Party {
  const r = createAccount(db, 'individual', 1, 100);
  if (earnedDisplay > 0) updateBalance(db, r.account.id, 'earned_balance', pts(earnedDisplay));
  return { accountId: r.account.id, publicKey: r.publicKey, privateKey: r.privateKey };
}

function signClaim(deceasedId: string, timestamp: number, beneficiary: Party): { beneficiaryId: string; signature: string } {
  const sig = signPayload({ action: 'claim_inheritance', deceasedId }, timestamp, beneficiary.privateKey);
  return { beneficiaryId: beneficiary.accountId, signature: sig };
}

describe('Phase 69: inheritance + dead-man-switch', () => {

  it('setInheritance accepts a valid 2-of-3 plan', () => {
    const db = freshDb();
    const owner = makeParty(db, 1000);
    const a = makeParty(db, 0);
    const b = makeParty(db, 0);
    const c = makeParty(db, 0);

    setInheritance(db, owner.accountId, {
      beneficiaries: [a.accountId, b.accountId, c.accountId],
      threshold: 2,
      deadManSwitchDays: 365,
    }, 1_000_000);

    const ownerAcct = getAccount(db, owner.accountId)!;
    assert.ok(ownerAcct.inheritance);
    assert.equal(ownerAcct.inheritance.beneficiaries.length, 3);
    assert.equal(ownerAcct.inheritance.threshold, 2);
    assert.equal(ownerAcct.inheritance.deadManSwitchDays, 365);
    db.close();
  });

  it('setInheritance rejects self-beneficiary', () => {
    const db = freshDb();
    const owner = makeParty(db);
    assert.throws(
      () => setInheritance(db, owner.accountId, {
        beneficiaries: [owner.accountId],
        threshold: 1,
        deadManSwitchDays: 90,
      }),
      (err: unknown) => err instanceof InheritanceError && err.code === 'SELF_BENEFICIARY',
    );
    db.close();
  });

  it('setInheritance rejects threshold > beneficiaries.length', () => {
    const db = freshDb();
    const owner = makeParty(db);
    const a = makeParty(db);
    assert.throws(
      () => setInheritance(db, owner.accountId, {
        beneficiaries: [a.accountId],
        threshold: 5,
        deadManSwitchDays: 90,
      }),
      (err: unknown) => err instanceof InheritanceError && err.code === 'BAD_THRESHOLD',
    );
    db.close();
  });

  it('setInheritance rejects deadManSwitchDays below the minimum', () => {
    const db = freshDb();
    const owner = makeParty(db);
    const a = makeParty(db);
    assert.throws(
      () => setInheritance(db, owner.accountId, {
        beneficiaries: [a.accountId],
        threshold: 1,
        deadManSwitchDays: 5,
      }),
      (err: unknown) => err instanceof InheritanceError && err.code === 'DAYS_TOO_LOW',
    );
    db.close();
  });

  it('processTransaction stamps lastActivityAt on the sender', () => {
    const db = freshDb();
    const sender = makeParty(db, 1000);
    const recipient = makeParty(db);
    const ts = 1_700_000_000;
    const payload = { from: sender.accountId, to: recipient.accountId, amount: pts(50).toString(), pointType: 'earned', isInPerson: false, memo: '' };
    const sig = signPayload(payload, ts, sender.privateKey);
    processTransaction(db, {
      from: sender.accountId,
      to: recipient.accountId,
      amount: pts(50),
      pointType: 'earned',
      isInPerson: false,
      memo: '',
      timestamp: ts,
      signature: sig,
    });
    const senderAcct = getAccount(db, sender.accountId)!;
    assert.equal(senderAcct.lastActivityAt, ts);
    // Recipient's clock should NOT advance — receiving doesn't prove key
    // possession.
    const recipientAcct = getAccount(db, recipient.accountId)!;
    assert.equal(recipientAcct.lastActivityAt, null);
    db.close();
  });

  it('claimInheritance fails when the dead-man-switch is not yet armed', () => {
    const db = freshDb();
    const owner = makeParty(db, 1000);
    const a = makeParty(db);
    const b = makeParty(db);
    const ts0 = 1_700_000_000;

    // Owner sends, starting the clock.
    const payload = { from: owner.accountId, to: a.accountId, amount: pts(1).toString(), pointType: 'earned', isInPerson: false, memo: '' };
    const sig = signPayload(payload, ts0, owner.privateKey);
    processTransaction(db, {
      from: owner.accountId, to: a.accountId, amount: pts(1), pointType: 'earned',
      isInPerson: false, memo: '', timestamp: ts0, signature: sig,
    });

    setInheritance(db, owner.accountId, {
      beneficiaries: [a.accountId, b.accountId],
      threshold: 2,
      deadManSwitchDays: 30,
    }, ts0);

    // 10 days later — switch not armed yet.
    const claimTs = ts0 + 10 * 86_400;
    const sigs = [signClaim(owner.accountId, claimTs, a), signClaim(owner.accountId, claimTs, b)];
    assert.throws(
      () => claimInheritance(db, owner.accountId, claimTs, sigs, claimTs),
      (err: unknown) => err instanceof InheritanceError && err.code === 'DEAD_MAN_SWITCH_NOT_ARMED',
    );
    db.close();
  });

  it('claimInheritance fails when only 1 of 2 beneficiaries signs (threshold=2)', () => {
    const db = freshDb();
    const owner = makeParty(db, 1000);
    const a = makeParty(db);
    const b = makeParty(db);
    const ts0 = 1_700_000_000;

    const payload = { from: owner.accountId, to: a.accountId, amount: pts(1).toString(), pointType: 'earned', isInPerson: false, memo: '' };
    const sig = signPayload(payload, ts0, owner.privateKey);
    processTransaction(db, {
      from: owner.accountId, to: a.accountId, amount: pts(1), pointType: 'earned',
      isInPerson: false, memo: '', timestamp: ts0, signature: sig,
    });

    setInheritance(db, owner.accountId, {
      beneficiaries: [a.accountId, b.accountId],
      threshold: 2,
      deadManSwitchDays: 30,
    }, ts0);

    const claimTs = ts0 + 31 * 86_400;
    // Only a signs.
    const sigs = [signClaim(owner.accountId, claimTs, a)];
    assert.throws(
      () => claimInheritance(db, owner.accountId, claimTs, sigs, claimTs),
      (err: unknown) => err instanceof InheritanceError && err.code === 'INSUFFICIENT_SIGNATURES',
    );

    // Owner's account is untouched.
    const ownerAcct = getAccount(db, owner.accountId)!;
    assert.equal(ownerAcct.isActive, true);
    assert.ok(ownerAcct.earnedBalance > 0n, 'owner balance unchanged on failed claim');
    db.close();
  });

  it('claimInheritance succeeds when threshold is met; balance splits to signers; deceased is deactivated', () => {
    const db = freshDb();
    const owner = makeParty(db, 1000);
    const a = makeParty(db);
    const b = makeParty(db);
    const c = makeParty(db);
    const ts0 = 1_700_000_000;

    // Arm the switch.
    const payload = { from: owner.accountId, to: a.accountId, amount: pts(1).toString(), pointType: 'earned', isInPerson: false, memo: '' };
    const sig = signPayload(payload, ts0, owner.privateKey);
    processTransaction(db, {
      from: owner.accountId, to: a.accountId, amount: pts(1), pointType: 'earned',
      isInPerson: false, memo: '', timestamp: ts0, signature: sig,
    });

    setInheritance(db, owner.accountId, {
      beneficiaries: [a.accountId, b.accountId, c.accountId],
      threshold: 2,
      deadManSwitchDays: 30,
    }, ts0);

    const claimTs = ts0 + 31 * 86_400;
    const ownerBalance = getAccount(db, owner.accountId)!.earnedBalance;

    // a + b sign; c does not.
    const sigs = [signClaim(owner.accountId, claimTs, a), signClaim(owner.accountId, claimTs, b)];
    const result = claimInheritance(db, owner.accountId, claimTs, sigs, claimTs);

    assert.equal(result.signers.length, 2);
    assert.equal(result.totalDistributed, ownerBalance);
    // Per-signer slice = total / 2 (no remainder for an even split here).
    assert.equal(result.perSigner, ownerBalance / 2n);

    // Deceased is drained + deactivated.
    const ownerAfter = getAccount(db, owner.accountId)!;
    assert.equal(ownerAfter.earnedBalance, 0n);
    assert.equal(ownerAfter.isActive, false);

    // a got their slice + the original 1pt (a was the recipient of the
    // owner's pre-arm tx, less its fee/pH slippage). Just check >= slice.
    const aAfter = getAccount(db, a.accountId)!;
    const bAfter = getAccount(db, b.accountId)!;
    const cAfter = getAccount(db, c.accountId)!;
    assert.ok(aAfter.earnedBalance >= result.perSigner);
    assert.ok(bAfter.earnedBalance >= result.perSigner);
    // c didn't sign, so c gets 0 from the inheritance.
    assert.equal(cAfter.earnedBalance, 0n);
    db.close();
  });

  it('claimInheritance ignores signatures from accounts not on the beneficiaries list', () => {
    const db = freshDb();
    const owner = makeParty(db, 1000);
    const a = makeParty(db);
    const stranger = makeParty(db);
    const ts0 = 1_700_000_000;

    const payload = { from: owner.accountId, to: a.accountId, amount: pts(1).toString(), pointType: 'earned', isInPerson: false, memo: '' };
    const sig = signPayload(payload, ts0, owner.privateKey);
    processTransaction(db, {
      from: owner.accountId, to: a.accountId, amount: pts(1), pointType: 'earned',
      isInPerson: false, memo: '', timestamp: ts0, signature: sig,
    });

    setInheritance(db, owner.accountId, {
      beneficiaries: [a.accountId],
      threshold: 1,
      deadManSwitchDays: 30,
    }, ts0);

    const claimTs = ts0 + 31 * 86_400;
    // Only stranger signs (with a valid signature, but they're not a beneficiary).
    const sigs = [signClaim(owner.accountId, claimTs, stranger)];
    assert.throws(
      () => claimInheritance(db, owner.accountId, claimTs, sigs, claimTs),
      (err: unknown) => err instanceof InheritanceError && err.code === 'INSUFFICIENT_SIGNATURES',
    );
    db.close();
  });

  it('claimInheritance rejects forged signature (signed by a different key)', () => {
    const db = freshDb();
    const owner = makeParty(db, 1000);
    const a = makeParty(db);
    const eve = makeParty(db);
    const ts0 = 1_700_000_000;

    const payload = { from: owner.accountId, to: a.accountId, amount: pts(1).toString(), pointType: 'earned', isInPerson: false, memo: '' };
    const sig = signPayload(payload, ts0, owner.privateKey);
    processTransaction(db, {
      from: owner.accountId, to: a.accountId, amount: pts(1), pointType: 'earned',
      isInPerson: false, memo: '', timestamp: ts0, signature: sig,
    });

    setInheritance(db, owner.accountId, {
      beneficiaries: [a.accountId],
      threshold: 1,
      deadManSwitchDays: 30,
    }, ts0);

    const claimTs = ts0 + 31 * 86_400;
    // Eve forges a signature claiming to be `a`, signing with her own key.
    const forged = {
      beneficiaryId: a.accountId,
      signature: signPayload({ action: 'claim_inheritance', deceasedId: owner.accountId }, claimTs, eve.privateKey),
    };
    assert.throws(
      () => claimInheritance(db, owner.accountId, claimTs, [forged], claimTs),
      (err: unknown) => err instanceof InheritanceError && err.code === 'INSUFFICIENT_SIGNATURES',
    );
    db.close();
  });
});
