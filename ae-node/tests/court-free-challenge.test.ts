// A challenge must cost the challenger something.
//
// Found by running an audit agent's repro harness. The court stake used to be
// a percentage of the challenger's OWN earned balance and nothing else, so a
// challenger holding zero staked zero, and the guard above it
// (`stakeAmount > earnedBalance`) passed, because 0 > 0 is false. Filing then
// escrowed the defendant anyway.
//
// That is a zero-cost griefing vector against any account: register as a miner
// (the first miner on a fresh network needs no percentHuman at all), hold
// nothing, and freeze anybody's earned balance for free. Escrow lifts only when
// the case resolves, so it is also repeatable and effectively a denial of
// service on someone else's money.
//
// The stake is now the larger of the chosen percentage and a fixed floor
// (`court.min_challenge_stake_points`, 1,440 points). A challenger who cannot
// cover the floor cannot file. If governance sets the floor to zero, the old
// "rounds to zero" guard is still there underneath it.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { fileChallenge } from '../src/court/court.js';
import { InsufficientBalanceError } from '../src/core/errors.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

function defendantWithSavings(db: DatabaseSync) {
  const defendant = createAccount(db, 'individual', 1, 100);
  updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
  return defendant.account.id;
}

function challengerWith(db: DatabaseSync, earned: bigint) {
  const r = createAccount(db, 'individual', 1, 100);
  if (earned > 0n) updateBalance(db, r.account.id, 'earned_balance', earned);
  registerMiner(db, r.account.id);
  return r.account.id;
}

/** InsufficientBalanceError whose message matches `pattern`. */
function insufficient(pattern: RegExp) {
  return (err: unknown) =>
    err instanceof InsufficientBalanceError && pattern.test(err.message);
}

describe('court: filing a challenge must cost the challenger', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('rejects a challenger with no earned balance, and leaves the defendant free', () => {
    const defendantId = defendantWithSavings(db);
    const broke = challengerWith(db, 0n);
    assert.equal(getAccount(db, broke)!.earnedBalance, 0n);

    assert.throws(
      () => fileChallenge(db, broke, defendantId, 'not_human', 100),
      insufficient(/needs at least 1440 points/),
    );

    // The part that actually mattered: the defendant's money must not be
    // frozen by a challenge that cost nothing to file.
    assert.equal(
      getAccount(db, defendantId)!.isEscrowed,
      false,
      'a rejected challenge must not escrow the defendant',
    );
    db.close();
  });

  it('rejects a tiny balance that cannot cover the 1,440-point floor', () => {
    // Old rule: 1% of 50 base units truncated to 0 and was rejected as
    // "rounds to zero". New rule: the stake is at least the floor, and 50
    // base units cannot pay it, at any percentage.
    const defendantId = defendantWithSavings(db);
    const nearlyBroke = challengerWith(db, 50n);

    for (const percent of [1, 100]) {
      assert.throws(
        () => fileChallenge(db, nearlyBroke, defendantId, 'not_human', percent),
        insufficient(/needs at least 1440 points/),
      );
    }
    // One base unit short of the floor is still short.
    const almost = challengerWith(db, pts(1440) - 1n);
    assert.throws(
      () => fileChallenge(db, almost, defendantId, 'not_human', 100),
      insufficient(/needs at least 1440 points/),
    );

    assert.equal(getAccount(db, defendantId)!.isEscrowed, false);
    assert.equal(getAccount(db, nearlyBroke)!.lockedBalance, 0n, 'nothing locked on a refused filing');
    db.close();
  });

  it('with the floor governed to zero, a zero stake is still refused', () => {
    setParam(db, 'court.min_challenge_stake_points', 0, undefined, undefined, true);
    const defendantId = defendantWithSavings(db);

    // Zero balance: the stake is zero whatever the percentage.
    const broke = challengerWith(db, 0n);
    assert.throws(
      () => fileChallenge(db, broke, defendantId, 'not_human', 100),
      insufficient(/rounds to zero/),
    );

    // 1% of 50 base units truncates to 0 under integer division.
    const nearlyBroke = challengerWith(db, 50n);
    assert.throws(
      () => fileChallenge(db, nearlyBroke, defendantId, 'not_human', 1),
      insufficient(/rounds to zero/),
    );

    assert.equal(getAccount(db, defendantId)!.isEscrowed, false);
    db.close();
  });

  it('still allows a funded challenger, staking the floor, and escrows the defendant', () => {
    const defendantId = defendantWithSavings(db);
    const funded = challengerWith(db, pts(10_000));

    // 10% of 10,000 is 1,000, under the floor, so the floor is what locks.
    const c = fileChallenge(db, funded, defendantId, 'not_human', 10);
    assert.equal(c.challengerStake, pts(1440), 'a stake below the floor is raised to it');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, true);
    assert.equal(getAccount(db, funded)!.lockedBalance, c.challengerStake);
    assert.equal(getAccount(db, funded)!.earnedBalance, pts(10_000) - pts(1440));
    db.close();
  });

  it('a chosen percentage above the floor stakes the percentage', () => {
    const defendantId = defendantWithSavings(db);
    const funded = challengerWith(db, pts(10_000));

    const c = fileChallenge(db, funded, defendantId, 'not_human', 50);
    assert.equal(c.challengerStake, pts(5_000), 'max(50% of 10,000, 1,440) is 5,000');
    assert.equal(getAccount(db, funded)!.lockedBalance, pts(5_000));
    db.close();
  });
});
