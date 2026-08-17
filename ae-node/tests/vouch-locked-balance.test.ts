// Regression tests for two vouching bugs found by the state-mutation audit.
//
// 1. locked_balance is shared by four subsystems (vouching, court, validator
//    registration, slashing). rebalanceVouchLocks used to write a vouch-only
//    total over the WHOLE column, silently releasing everyone else's stake
//    into spendable earned_balance once per day cycle.
//
// 2. burnVouch decremented the voucher and stopped there, destroying supply
//    instead of routing it to the fee pool the way the court burn path does.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { createVouch, burnVouch, rebalanceVouchLocks } from '../src/verification/vouching.js';
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

describe('vouching: burns conserve supply', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeSchema(db);
  });
  afterEach(() => db.close());

  test('a burned vouch stake lands in the fee pool instead of vanishing', () => {
    const voucher = makeAccount();
    const vouched = makeAccount();
    updateBalance(db, voucher, 'earned_balance', 10_000n);

    const vouch = createVouch(db, voucher, vouched, 10);
    const staked = getAccount(db, voucher)!.lockedBalance;
    assert.ok(staked > 0n);

    const supplyBefore = getAccount(db, voucher)!.earnedBalance + staked;
    const poolBefore = getFeePool(db).currentBalance;

    burnVouch(db, vouch.id);

    const after = getAccount(db, voucher)!;
    const poolAfter = getFeePool(db).currentBalance;

    assert.strictEqual(after.lockedBalance, 0n, 'stake should be unlocked out of the voucher');
    assert.strictEqual(poolAfter - poolBefore, staked, 'the burn should land in the fee pool');

    // Conservation: what left the account equals what entered the pool.
    const supplyAfter = after.earnedBalance + after.lockedBalance;
    assert.strictEqual(
      supplyAfter + (poolAfter - poolBefore),
      supplyBefore,
      'total value must be conserved across a vouch burn',
    );
  });
});
