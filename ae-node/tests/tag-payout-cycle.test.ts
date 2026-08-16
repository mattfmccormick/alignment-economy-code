// Supportive and ambient points actually reaching people.
//
// Why this exists
// ---------------
// `finalizeSupportiveTags` and `finalizeAmbientTags` were correct and covered
// by unit tests, but nothing in ae-node/src ever called them. Their only
// callers were the tests. On a live network that meant a user could tag the
// chair they sat in and the building they worked in all day, and at 03:59 the
// points expired along with everything else. Two of the white paper's four
// point types never reached a single balance.
//
// The unit tests could not catch it, because they called the functions
// directly. The gap was that the day cycle never did. So these tests drive the
// CYCLE, not the finalizers, and assert that value lands on the recipient.
//
// Ordering matters and is the easiest thing to get wrong: finalization debits
// the same supportive/ambient balances that expiry zeroes, so it has to run
// first. Reverse them and every one of these assertions reads zero.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import {
  finalizeDailyTags,
  runExpireAndRebase,
  getCycleState,
  mintDaily,
} from '../src/core/day-cycle.js';
import { registerProduct } from '../src/tagging/products.js';
import { registerSpace } from '../src/tagging/spaces.js';
import { submitSupportiveTags } from '../src/tagging/supportive.js';
import { submitAmbientTags } from '../src/tagging/ambient.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('supportive + ambient payout runs as part of the day cycle', () => {
  let db: DatabaseSync;
  let user: string;
  let maker: string;

  beforeEach(() => {
    db = freshDb();
    // A verified user, so the percentHuman spend multiplier is 100% and the
    // arithmetic below is about tagging rather than verification slippage.
    user = createAccount(db, 'individual', 1, 100).account.id;
    maker = createAccount(db, 'individual', 1, 100).account.id;
    mintDaily(db);
  });

  it('pays a product manufacturer when the day rolls over', () => {
    const day = getCycleState(db).currentDay;
    const product = registerProduct(db, 'Standing desk', 'furniture', user, maker);
    submitSupportiveTags(db, user, day, [{ productId: product.id, minutesUsed: 480 }]);

    const makerBefore = getAccount(db, maker)!.earnedBalance;
    assert.equal(makerBefore, 0n, 'precondition: maker has earned nothing yet');
    assert.ok(getAccount(db, user)!.supportiveBalance > 0n, 'precondition: user has supportive points');

    runExpireAndRebase(db);

    const makerAfter = getAccount(db, maker)!.earnedBalance;
    assert.ok(
      makerAfter > makerBefore,
      'the manufacturer must be paid for the hours their product was in use',
    );
    // And the user's supportive balance is gone either way — spent, not expired.
    assert.equal(getAccount(db, user)!.supportiveBalance, 0n);
  });

  it('pays a space owner when the day rolls over', () => {
    const day = getCycleState(db).currentDay;
    const space = registerSpace(db, 'Corner cafe', 'venue', user, maker);
    submitAmbientTags(db, user, day, [{ spaceId: space.id, minutesOccupied: 240 }]);

    const ownerBefore = getAccount(db, maker)!.earnedBalance;
    runExpireAndRebase(db);
    const ownerAfter = getAccount(db, maker)!.earnedBalance;

    assert.ok(ownerAfter > ownerBefore, 'the space owner must be paid for time spent there');
    assert.equal(getAccount(db, user)!.ambientBalance, 0n);
  });

  it('is a no-op when nobody tagged anything', () => {
    const result = finalizeDailyTags(db);
    assert.equal(result.accounts, 0);
    assert.equal(result.transferred, 0n);
    assert.equal(result.failed, 0);
  });

  it('is idempotent: a second run pays nothing extra', () => {
    // resumeCycle can re-enter runExpireAndRebase after a crash, so paying
    // twice would mint value out of nothing.
    const day = getCycleState(db).currentDay;
    const product = registerProduct(db, 'Chair', 'furniture', user, maker);
    submitSupportiveTags(db, user, day, [{ productId: product.id, minutesUsed: 600 }]);

    const first = finalizeDailyTags(db);
    const afterFirst = getAccount(db, maker)!.earnedBalance;
    assert.ok(first.transferred > 0n);

    const second = finalizeDailyTags(db);
    assert.equal(second.accounts, 0, 'tags are marked finalized, so nothing is left to pay');
    assert.equal(second.transferred, 0n);
    assert.equal(getAccount(db, maker)!.earnedBalance, afterFirst);
  });

  it('an unverified user pays nothing through: it burns instead', () => {
    // The percentHuman multiplier applies to tag finalization exactly as it
    // applies to a transfer. A 0%-human account accrues its daily supportive
    // mint but cannot move value with it, which is what closes the sybil
    // vector where a fake account pumps a colluding "manufacturer".
    const sybil = createAccount(db, 'individual', 1, 0).account.id;
    updateBalance(db, sybil, 'supportive_balance', 144_00000000n);

    const day = getCycleState(db).currentDay;
    const product = registerProduct(db, 'Shell product', 'misc', sybil, maker);
    submitSupportiveTags(db, sybil, day, [{ productId: product.id, minutesUsed: 1440 }]);

    const makerBefore = getAccount(db, maker)!.earnedBalance;
    const result = finalizeDailyTags(db);

    assert.equal(getAccount(db, maker)!.earnedBalance, makerBefore, 'no value may reach the maker');
    assert.equal(result.transferred, 0n);
    assert.ok(result.burned > 0n, 'the allocation burns instead of transferring');
  });

  it('one broken account does not stop the network rolling over', () => {
    // A per-account throw must not take the whole cycle down with it: everyone
    // else's day still has to advance.
    const day = getCycleState(db).currentDay;
    const good = registerProduct(db, 'Lamp', 'lighting', user, maker);
    submitSupportiveTags(db, user, day, [{ productId: good.id, minutesUsed: 300 }]);

    // Manufacture a corrupt row: a tag whose owning account is gone. Foreign
    // keys normally make this impossible, which is the point — we are
    // simulating damage, not a reachable state, to prove the loop contains it.
    const orphanUser = createAccount(db, 'individual', 1, 100).account.id;
    updateBalance(db, orphanUser, 'supportive_balance', 144_00000000n);
    const doomed = registerProduct(db, 'Ghost', 'misc', orphanUser, maker);
    submitSupportiveTags(db, orphanUser, day, [{ productId: doomed.id, minutesUsed: 300 }]);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM accounts WHERE id = ?').run(orphanUser);
    db.exec('PRAGMA foreign_keys = ON');

    const result = finalizeDailyTags(db);

    // The healthy account was still paid.
    assert.ok(getAccount(db, maker)!.earnedBalance > 0n);
    assert.equal(result.failed, 1, 'the broken account is counted, not swallowed silently');
  });
});
