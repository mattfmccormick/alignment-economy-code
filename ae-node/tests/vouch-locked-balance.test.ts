// Vouching invariants.
//
// 1. locked_balance is shared by four subsystems (vouching, court, validator
//    registration, slashing). rebalanceVouchLocks used to write a vouch-only
//    total over the WHOLE column, silently releasing everyone else's stake
//    into spendable earned_balance once per day cycle.
//
// 2. Withdrawal drops the vouched account's percentHuman by the vouch weight,
//    per WP §7.2. Before this, withdrawing was free for the voucher and
//    costless to the vouched account.
//
// 3. A vouch burn is a TRUE burn. This one is a guard against re-introducing a
//    "fix": an audit flagged the missing addToFeePool as a supply leak and it
//    was changed, which broke phase64. WP v2 made every court burn destroy
//    supply on purpose, so the assertion here is that the fee pool does NOT
//    move.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { createAccount, getAccount, updateBalance, updatePercentHuman } from '../src/core/account.js';
import { createVouch, burnVouch, withdrawVouch, rebalanceVouchLocks } from '../src/verification/vouching.js';
import { getFeePool } from '../src/core/fee-pool.js';
import { generateKeyPair } from '../src/core/crypto.js';

let db: DatabaseSync;

function makeAccount(): string {
  const { publicKey } = generateKeyPair();
  return createAccount(db, 'individual', publicKey, 1).account.id;
}

describe('vouching: locked_balance is shared, not owned', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeSchema(db);
  });
  afterEach(() => db.close());

  test('rebalance preserves stake parked in locked_balance by other subsystems', () => {
    const voucher = makeAccount();
    const vouched = makeAccount();

    // 10,000 spendable.
    updateBalance(db, voucher, 'earned_balance', 10_000n);
    createVouch(db, voucher, vouched, 10); // locks 10% of holdings

    const afterVouch = getAccount(db, voucher)!;
    const vouchStake = afterVouch.lockedBalance;
    assert.ok(vouchStake > 0n, 'vouch should have locked something');

    // Now a DIFFERENT subsystem parks stake in the same column, exactly as
    // registerValidator and the court challenger stake both do.
    const validatorStake = 2_000n;
    updateBalance(db, voucher, 'locked_balance', vouchStake + validatorStake);
    updateBalance(db, voucher, 'earned_balance', afterVouch.earnedBalance - validatorStake);

    const beforeRebalance = getAccount(db, voucher)!;

    rebalanceVouchLocks(db);

    const after = getAccount(db, voucher)!;

    // The validator's stake must still be locked. Before the fix this test
    // failed with locked_balance collapsing to the vouch-only total and the
    // 2,000 reappearing as spendable earned_balance.
    assert.ok(
      after.lockedBalance >= validatorStake,
      `validator stake was released: locked went ${beforeRebalance.lockedBalance} -> ${after.lockedBalance}`,
    );

    // And nothing was conjured or destroyed across the rebalance.
    assert.strictEqual(
      after.earnedBalance + after.lockedBalance,
      beforeRebalance.earnedBalance + beforeRebalance.lockedBalance,
      'rebalance must move value between columns, never change the total',
    );
  });

  test('repeated rebalances are stable once stakes match their percentages', () => {
    const voucher = makeAccount();
    const vouched = makeAccount();
    updateBalance(db, voucher, 'earned_balance', 10_000n);
    createVouch(db, voucher, vouched, 10);

    rebalanceVouchLocks(db);
    const first = getAccount(db, voucher)!;
    rebalanceVouchLocks(db);
    const second = getAccount(db, voucher)!;

    // A delta-based rebalance converges. An absolute write oscillated, because
    // each pass recomputed the target off a total it had just overwritten.
    assert.strictEqual(second.lockedBalance, first.lockedBalance);
    assert.strictEqual(second.earnedBalance, first.earnedBalance);
  });
});

describe('vouching: withdrawal costs the vouched account its score', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeSchema(db);
  });
  afterEach(() => db.close());

  // WP §7.2: "Vouchers may withdraw at any time, but doing so immediately
  // reduces the vouched account's percent-human score by the corresponding
  // amount." Without this, a ring could park a stake just long enough to get
  // someone verified, then reclaim it with the score left standing.
  test('withdrawing returns the stake and drops percentHuman by the vouch weight', () => {
    const voucher = makeAccount();
    const vouched = makeAccount();
    updateBalance(db, voucher, 'earned_balance', 10_000n);
    updatePercentHuman(db, vouched, 40);

    const vouch = createVouch(db, voucher, vouched, 10);
    const staked = getAccount(db, voucher)!.lockedBalance;
    const voucherEarnedWhileStaked = getAccount(db, voucher)!.earnedBalance;

    withdrawVouch(db, vouch.id);

    const voucherAfter = getAccount(db, voucher)!;
    const vouchedAfter = getAccount(db, vouched)!;

    assert.strictEqual(voucherAfter.lockedBalance, 0n, 'stake unlocked');
    assert.strictEqual(
      voucherAfter.earnedBalance,
      voucherEarnedWhileStaked + staked,
      'stake returned to spendable balance',
    );
    assert.strictEqual(vouchedAfter.percentHuman, 30, '40 - 10 (the staked percentage)');
  });

  test('percentHuman floors at zero rather than going negative', () => {
    const voucher = makeAccount();
    const vouched = makeAccount();
    updateBalance(db, voucher, 'earned_balance', 10_000n);
    updatePercentHuman(db, vouched, 5);

    const vouch = createVouch(db, voucher, vouched, 25);
    withdrawVouch(db, vouch.id);

    assert.strictEqual(getAccount(db, vouched)!.percentHuman, 0);
  });
});

describe('vouching: a burn is a true burn', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeSchema(db);
  });
  afterEach(() => db.close());

  // WP v2 makes every court burn a TRUE burn — the value is destroyed, not
  // recycled through the fee pool. phase64.test.ts pins the same rule from the
  // court side; this pins it at the vouching function itself so the two cannot
  // drift apart. Backing a fraudulent account has to cost the voucher
  // something the network does not hand straight back to them.
  test('a burned vouch stake is destroyed, not routed to the fee pool', () => {
    const voucher = makeAccount();
    const vouched = makeAccount();
    updateBalance(db, voucher, 'earned_balance', 10_000n);

    const vouch = createVouch(db, voucher, vouched, 10);
    const staked = getAccount(db, voucher)!.lockedBalance;
    assert.ok(staked > 0n);

    const before = getAccount(db, voucher)!;
    const supplyBefore = before.earnedBalance + before.lockedBalance;
    const poolBefore = getFeePool(db).currentBalance;

    burnVouch(db, vouch.id);

    const after = getAccount(db, voucher)!;
    const supplyAfter = after.earnedBalance + after.lockedBalance;

    assert.strictEqual(after.lockedBalance, 0n, 'stake leaves the voucher');
    assert.strictEqual(
      getFeePool(db).currentBalance,
      poolBefore,
      'fee pool must NOT change: this is a true burn, not a redistribution',
    );
    assert.strictEqual(
      supplyAfter,
      supplyBefore - staked,
      'the staked amount is destroyed',
    );
  });
});
