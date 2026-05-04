// Phase 61: percentHuman as a spend multiplier (Option B semantics).
//
// Locks in the design decision that percentHuman gates SPENDING, not MINTING:
//   - Every active individual receives the full daily mint regardless of pH.
//   - When they spend (transactions, supportive tag finalization, ambient tag
//     finalization), the value the recipient receives is multiplied by pH/100.
//   - The remainder burns as `burn_unverified` so the ledger conserves:
//       tx_send.amount == tx_receive.netAmount + fee + burn_unverified.
//
// Why this matters:
//   - Visible carrot: new joiners see their allocation accumulating, which
//     drives them to seek verification.
//   - Sybil resistance: 100 fake accounts can mint daily but their spends all
//     evaporate to zero, so duplicates gain no economic leverage.
//   - Old code gated *minting* (pH > 0 required) which left new accounts
//     visibly empty and made onboarding feel like rejection.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { signPayload } from '../src/core/crypto.js';
import {
  createAccount,
  getAccount,
  updateBalance,
  updatePercentHuman,
  countActiveParticipants,
} from '../src/core/account.js';
import { mintDaily } from '../src/core/day-cycle.js';
import { processTransaction, calculateFee } from '../src/core/transaction.js';
import { registerProduct } from '../src/tagging/products.js';
import { submitSupportiveTags, finalizeSupportiveTags } from '../src/tagging/supportive.js';
import { registerSpace } from '../src/tagging/spaces.js';
import { submitAmbientTags, finalizeAmbientTags } from '../src/tagging/ambient.js';
import {
  PRECISION,
  DAILY_ACTIVE_POINTS,
  DAILY_SUPPORTIVE_POINTS,
  DAILY_AMBIENT_POINTS,
} from '../src/core/constants.js';

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

function signTx(
  fromId: string,
  toId: string,
  amount: bigint,
  pointType: string,
  privateKey: string,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    from: fromId, to: toId, amount: amount.toString(),
    pointType, isInPerson: false, memo: '',
  };
  return { timestamp, signature: signPayload(payload, timestamp, privateKey) };
}

describe('Phase 61: percentHuman as spend multiplier (Option B)', () => {
  it('mints to every active individual regardless of percentHuman', () => {
    const db = freshDb();
    const verified = createAccount(db, 'individual', 1, 100);
    const partial = createAccount(db, 'individual', 1, 50);
    const unverified = createAccount(db, 'individual', 1, 0);

    mintDaily(db);

    // All three receive the full daily mint, including the unverified one.
    // Old behavior would have minted 0 to the unverified account.
    for (const acct of [verified, partial, unverified]) {
      const a = getAccount(db, acct.account.id)!;
      assert.equal(a.activeBalance, DAILY_ACTIVE_POINTS, `${acct.account.id} active`);
      assert.equal(a.supportiveBalance, DAILY_SUPPORTIVE_POINTS, `${acct.account.id} supportive`);
      assert.equal(a.ambientBalance, DAILY_AMBIENT_POINTS, `${acct.account.id} ambient`);
    }

    // Rebase math now counts everyone, verified or not.
    assert.equal(countActiveParticipants(db), 3);

    db.close();
  });

  it('100% sender: full value reaches recipient (identical to legacy behavior)', () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 100);
    const recipient = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', pts(1000));

    const amount = pts(100);
    const { timestamp, signature } = signTx(
      sender.account.id, recipient.account.id, amount, 'active', sender.privateKey,
    );
    const result = processTransaction(db, {
      from: sender.account.id, to: recipient.account.id, amount,
      pointType: 'active', timestamp, signature,
    });

    const expectedFee = calculateFee(amount);
    assert.equal(result.fee, expectedFee);
    assert.equal(result.netAmount, amount - expectedFee);

    const senderAfter = getAccount(db, sender.account.id)!;
    const recipientAfter = getAccount(db, recipient.account.id)!;
    assert.equal(senderAfter.activeBalance, pts(1000) - amount);
    assert.equal(recipientAfter.earnedBalance, amount - expectedFee);

    // No burn_unverified log at 100%.
    const burnLogs = db.prepare(
      "SELECT * FROM transaction_log WHERE account_id = ? AND change_type = 'burn_unverified'",
    ).all(sender.account.id) as any[];
    assert.equal(burnLogs.length, 0);

    db.close();
  });

  it('0% sender: full deduction, recipient gets nothing, full amount burns', () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 0);
    const recipient = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', pts(1000));

    const amount = pts(100);
    const { timestamp, signature } = signTx(
      sender.account.id, recipient.account.id, amount, 'active', sender.privateKey,
    );
    const result = processTransaction(db, {
      from: sender.account.id, to: recipient.account.id, amount,
      pointType: 'active', timestamp, signature,
    });

    // Effective amount = 0. No fee. No netAmount.
    assert.equal(result.fee, 0n);
    assert.equal(result.netAmount, 0n);

    const senderAfter = getAccount(db, sender.account.id)!;
    const recipientAfter = getAccount(db, recipient.account.id)!;
    assert.equal(senderAfter.activeBalance, pts(1000) - amount, 'sender deducted full intent');
    assert.equal(recipientAfter.earnedBalance, 0n, 'recipient receives zero');

    // burn_unverified log records the full burn.
    const burnLogs = db.prepare(
      "SELECT amount FROM transaction_log WHERE account_id = ? AND change_type = 'burn_unverified'",
    ).all(sender.account.id) as Array<{ amount: string }>;
    assert.equal(burnLogs.length, 1);
    assert.equal(BigInt(burnLogs[0].amount), amount);

    db.close();
  });

  it('50% sender: half reaches recipient, half burns as unverified slippage', () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 50);
    const recipient = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', pts(1000));

    const amount = pts(100);
    const effective = amount * 50n / 100n;
    const expectedFee = calculateFee(effective);
    const expectedNet = effective - expectedFee;
    const expectedBurn = amount - effective;

    const { timestamp, signature } = signTx(
      sender.account.id, recipient.account.id, amount, 'active', sender.privateKey,
    );
    const result = processTransaction(db, {
      from: sender.account.id, to: recipient.account.id, amount,
      pointType: 'active', timestamp, signature,
    });

    assert.equal(result.fee, expectedFee);
    assert.equal(result.netAmount, expectedNet);

    const senderAfter = getAccount(db, sender.account.id)!;
    const recipientAfter = getAccount(db, recipient.account.id)!;
    assert.equal(senderAfter.activeBalance, pts(1000) - amount);
    assert.equal(recipientAfter.earnedBalance, expectedNet);

    const burnLogs = db.prepare(
      "SELECT amount FROM transaction_log WHERE account_id = ? AND change_type = 'burn_unverified'",
    ).all(sender.account.id) as Array<{ amount: string }>;
    assert.equal(burnLogs.length, 1);
    assert.equal(BigInt(burnLogs[0].amount), expectedBurn);

    // Conservation: tx_send amount == tx_receive net + fee + burn_unverified
    assert.equal(expectedNet + expectedFee + expectedBurn, amount);

    db.close();
  });

  it('supportive tag finalization: 0% user produces no manufacturer flow', () => {
    const db = freshDb();
    const user = createAccount(db, 'individual', 1, 0);
    const mfg = createAccount(db, 'company', 1, 0);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);

    const product = registerProduct(db, 'Chair', 'furniture', user.account.id, mfg.account.id);
    submitSupportiveTags(db, user.account.id, 1, [
      { productId: product.id, minutesUsed: 480 },
    ]);

    const result = finalizeSupportiveTags(db, user.account.id, 1);

    // At 0%, the manufacturer gets nothing — every allocated point burns.
    assert.equal(result.transferred, 0n);
    assert.equal(result.fees, 0n);
    assert.ok(result.burned > 0n);

    const mfgAfter = getAccount(db, mfg.account.id)!;
    assert.equal(mfgAfter.earnedBalance, 0n, 'unverified user moves no value to manufacturer');

    db.close();
  });

  it('supportive tag finalization: 50% user moves half to manufacturer', () => {
    const db = freshDb();
    const user = createAccount(db, 'individual', 1, 50);
    const mfg = createAccount(db, 'company', 1, 0);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);

    const product = registerProduct(db, 'Chair', 'furniture', user.account.id, mfg.account.id);
    const tags = submitSupportiveTags(db, user.account.id, 1, [
      { productId: product.id, minutesUsed: 480 },
    ]);

    const allocated = tags[0].pointsAllocated;
    const expectedEffective = allocated * 50n / 100n;
    const expectedFee = (expectedEffective * 50n) / 10000n;
    const expectedMfgGain = expectedEffective - expectedFee;

    finalizeSupportiveTags(db, user.account.id, 1);

    const mfgAfter = getAccount(db, mfg.account.id)!;
    assert.equal(mfgAfter.earnedBalance, expectedMfgGain);

    db.close();
  });

  it('ambient tag finalization: 0% user produces no space-entity flow', () => {
    const db = freshDb();
    const user = createAccount(db, 'individual', 1, 0);
    const cityEntity = createAccount(db, 'government', 1, 0);
    updateBalance(db, user.account.id, 'ambient_balance', DAILY_AMBIENT_POINTS);

    const space = registerSpace(db, 'City Park', 'park', undefined, cityEntity.account.id, 0);
    submitAmbientTags(db, user.account.id, 1, [
      { spaceId: space.id, minutesOccupied: 60 },
    ]);

    const result = finalizeAmbientTags(db, user.account.id, 1);

    assert.equal(result.transferred, 0n);
    assert.equal(result.fees, 0n);

    const entityAfter = getAccount(db, cityEntity.account.id)!;
    assert.equal(entityAfter.earnedBalance, 0n);

    db.close();
  });

  it('verification unlocks spending: 0% then bumped to 100% transfers normally', () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 0);
    const recipient = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', pts(2000));

    // First spend at 0% — burns entirely.
    const tx1 = signTx(sender.account.id, recipient.account.id, pts(500), 'active', sender.privateKey);
    processTransaction(db, {
      from: sender.account.id, to: recipient.account.id, amount: pts(500),
      pointType: 'active', timestamp: tx1.timestamp, signature: tx1.signature,
    });
    assert.equal(getAccount(db, recipient.account.id)!.earnedBalance, 0n);

    // Miner verifies the sender to 100%.
    updatePercentHuman(db, sender.account.id, 100);

    // Second spend at 100% — full transfer.
    const amount2 = pts(500);
    const tx2 = signTx(sender.account.id, recipient.account.id, amount2, 'active', sender.privateKey);
    processTransaction(db, {
      from: sender.account.id, to: recipient.account.id, amount: amount2,
      pointType: 'active', timestamp: tx2.timestamp, signature: tx2.signature,
    });
    assert.equal(
      getAccount(db, recipient.account.id)!.earnedBalance,
      amount2 - calculateFee(amount2),
    );

    db.close();
  });
});
