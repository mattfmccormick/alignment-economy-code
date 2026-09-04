// Audit #4: a spend's value is re-derived from local chain state, never trusted
// off the wire.
//
// A daily-point spend is worth amount * percentHuman / 100. The ORIGIN computes
// that and puts fee/netAmount on the wire; replayTransaction / acceptPending-
// Transaction (the paths every OTHER node runs) used to apply those wire numbers
// verbatim. A malicious node could then hand a follower a block whose netAmount
// was computed as if a 0% sybil were 100% and the follower would credit the
// inflated value. percentHuman is now pure chain state, so every node re-derives
// the value itself and the wire numbers are inert.
//
// These tests pin: (1) an inflated wire value is OVERRIDDEN, not applied, and not
// rejected; (2) acceptPendingTransaction stores the derived value, not the wire's;
// (3) two nodes replaying the same honest wire converge on the same state root;
// (4) the liveness case that dictates override-not-reject — when the sender's
// LOCAL percentHuman legitimately differs from the wire's frozen value (a vouch/
// panel change landed between receipt and inclusion), replay must NOT throw.

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
  deriveSpendValue,
  deriveTxId,
} from '../src/core/transaction.js';
import { computeStateRoot } from '../src/core/state-root.js';

function node(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

interface Party {
  id: string;
  pub: string;
  priv: string;
}
function party(): Party {
  const kp = generateKeyPair();
  return { id: deriveAccountId(kp.publicKey), pub: kp.publicKey, priv: kp.privateKey };
}

// Build a signed, wire-shaped active-point transfer. `wireFee`/`wireNet` are what
// travels on the wire — deliberately settable so a test can lie about them.
function wireTx(
  sender: Party,
  recipient: Party,
  amount: bigint,
  wireFee: bigint,
  wireNet: bigint,
) {
  const timestamp = 1_700_000_000;
  const payload = {
    from: sender.id,
    to: recipient.id,
    amount: amount.toString(),
    pointType: 'active' as const,
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
  };
  const signature = signPayload(payload, timestamp, sender.priv);
  return {
    id: deriveTxId(signature),
    from: sender.id,
    to: recipient.id,
    amount,
    fee: wireFee,
    netAmount: wireNet,
    pointType: 'active' as const,
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
    signature,
    receiverSignature: null,
    timestamp,
  };
}

const AMOUNT = 100_00000000n;

describe('audit #4: transaction value is re-derived, not trusted off the wire', () => {
  it('overrides an inflated wire netAmount with the value derived from local percentHuman', () => {
    const sender = party();
    const recipient = party();
    const db = node();
    createAccount(db, 'individual', 1, 50, sender.pub); // percentHuman 50
    createAccount(db, 'individual', 1, 100, recipient.pub);
    updateBalance(db, sender.id, 'active_balance', 500_00000000n);

    // Honest value at pH 50, and the inflated value an attacker would ship (pH 100).
    const honest = deriveSpendValue(AMOUNT, 'active', 'individual', 50);
    const inflated = deriveSpendValue(AMOUNT, 'active', 'individual', 100);
    assert.notEqual(honest.netAmount, inflated.netAmount); // the attack has teeth

    const tx = wireTx(sender, recipient, AMOUNT, inflated.fee, inflated.netAmount);

    // Does NOT throw (override, not reject) and credits the DERIVED value.
    replayTransaction(db, tx, 1);
    assert.equal(getAccount(db, recipient.id)!.earnedBalance, honest.netAmount);
    // Sender is always debited the FULL amount; the discounted remainder burns.
    assert.equal(getAccount(db, sender.id)!.activeBalance, 500_00000000n - AMOUNT);
    const burnRow = db
      .prepare(
        "SELECT amount FROM transaction_log WHERE account_id = ? AND change_type = 'burn_unverified'",
      )
      .get(sender.id) as { amount: string } | undefined;
    assert.equal(BigInt(burnRow!.amount), honest.burnedUnverified);
    db.close();
  });

  it('acceptPendingTransaction stores the derived fee/net, not the wire values', () => {
    const sender = party();
    const recipient = party();
    const db = node();
    createAccount(db, 'individual', 1, 50, sender.pub);
    createAccount(db, 'individual', 1, 100, recipient.pub);
    updateBalance(db, sender.id, 'active_balance', 500_00000000n);

    const honest = deriveSpendValue(AMOUNT, 'active', 'individual', 50);
    const inflated = deriveSpendValue(AMOUNT, 'active', 'individual', 100);
    const tx = wireTx(sender, recipient, AMOUNT, inflated.fee, inflated.netAmount);

    acceptPendingTransaction(db, tx); // files as pending, no balance move
    const row = db
      .prepare('SELECT fee, net_amount, applied FROM transactions WHERE id = ?')
      .get(tx.id) as { fee: string; net_amount: string; applied: number };
    assert.equal(BigInt(row.fee), honest.fee);
    assert.equal(BigInt(row.net_amount), honest.netAmount);
    // Filed, not rejected; not yet applied.
    assert.equal(row.applied, 0);
    // Balances untouched until the block commits.
    assert.equal(getAccount(db, recipient.id)!.earnedBalance, 0n);
    db.close();
  });

  it('two nodes replaying the same honest wire converge on the same state root', () => {
    const sender = party();
    const recipient = party();
    const a = node();
    const b = node();
    for (const db of [a, b]) {
      createAccount(db, 'individual', 1, 50, sender.pub);
      createAccount(db, 'individual', 1, 100, recipient.pub);
      updateBalance(db, sender.id, 'active_balance', 500_00000000n);
    }
    const honest = deriveSpendValue(AMOUNT, 'active', 'individual', 50);
    const tx = wireTx(sender, recipient, AMOUNT, honest.fee, honest.netAmount);

    replayTransaction(a, tx, 1);
    replayTransaction(b, tx, 1);
    assert.equal(getAccount(a, recipient.id)!.earnedBalance, honest.netAmount);
    assert.equal(computeStateRoot(a), computeStateRoot(b));
    a.close();
    b.close();
  });

  it('does NOT reject when the local percentHuman legitimately differs from the wire (liveness)', () => {
    // The scenario that dictates override over reject: the wire value was frozen
    // at receipt against pH 50, but a vouch/panel op raised the sender to pH 100
    // in a block that committed before this tx's block. The follower re-derives
    // against the CURRENT (local, chain-state) pH 100. A reject-on-mismatch rule
    // would fail-stop the chain here on an entirely honest transaction.
    const sender = party();
    const recipient = party();
    const db = node();
    createAccount(db, 'individual', 1, 100, sender.pub); // local pH is now 100
    createAccount(db, 'individual', 1, 100, recipient.pub);
    updateBalance(db, sender.id, 'active_balance', 500_00000000n);

    const frozenAtReceipt = deriveSpendValue(AMOUNT, 'active', 'individual', 50); // wire
    const derivedNow = deriveSpendValue(AMOUNT, 'active', 'individual', 100); // local
    const tx = wireTx(sender, recipient, AMOUNT, frozenAtReceipt.fee, frozenAtReceipt.netAmount);

    assert.doesNotThrow(() => replayTransaction(db, tx, 1));
    // Applied the value derived from local chain state, not the stale wire value.
    assert.equal(getAccount(db, recipient.id)!.earnedBalance, derivedNow.netAmount);
    db.close();
  });

  it('earned-point transfers and non-individual senders take no discount but still pay the fee', () => {
    const derivedEarned = deriveSpendValue(AMOUNT, 'earned', 'individual', 50);
    assert.equal(derivedEarned.effectiveAmount, AMOUNT); // no discount on earned
    assert.equal(derivedEarned.burnedUnverified, 0n);
    const derivedCompany = deriveSpendValue(AMOUNT, 'active', 'company', 50);
    assert.equal(derivedCompany.effectiveAmount, AMOUNT); // no discount for non-individuals
  });
});
