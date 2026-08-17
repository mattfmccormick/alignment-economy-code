// Jury seating must produce a jury that can actually decide, or no jury at all.
//
// Three defects found by running an audit agent's repro harness, all in
// selectJury, all with the same shape: the function reported success without
// checking what it had actually seated.
//
//   - The defendant was never excluded from the pool, so a defendant who was
//     an active tier-2 miner could sit on their own jury and vote.
//   - Miners who could not post the stake were skipped with a bare `continue`
//     AFTER the jury size had been fixed, so a pool of three where two held
//     nothing seated one juror — and the case still advanced to voting. One
//     person then decides a verdict that burns 80% of a balance.
//   - A pool too small parked the case in court_waiting_jury with the
//     defendant escrowed and the challenger's stake locked, and nothing could
//     ever re-run selection. Permanent.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, dismissStalledCase, getCase,
} from '../src/court/court.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

function miner(db: DatabaseSync, tier: 1 | 2, earned: number) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

describe('court: jury seating', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('never seats the defendant on their own jury', () => {
    const defendant = miner(db, 2, 5_000);
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 6; i++) miner(db, 2, 5_000);

    const c = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'seed-defendant');

    assert.ok(jurors.length >= 3, 'should still seat a real jury from the others');
    assert.equal(
      jurors.includes(defendant.minerId),
      false,
      'the defendant must not decide their own case',
    );
    db.close();
  });

  it('refuses to open voting with a jury of one', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
    const challenger = miner(db, 1, 10_000);
    miner(db, 2, 5_000);  // can stake
    miner(db, 2, 0);      // cannot
    miner(db, 2, 0);      // cannot

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'seed-tiny');

    assert.equal(jurors.length, 0, 'no jury rather than a jury of one');
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
    db.close();
  });

  it('leaves no stake locked when seating fails', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
    const challenger = miner(db, 1, 10_000);
    const lonely = miner(db, 2, 5_000);
    const before = getAccount(db, lonely.accountId)!.lockedBalance;

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'seed-rollback');

    assert.equal(
      getAccount(db, lonely.accountId)!.lockedBalance,
      before,
      'a juror must not be left staked against a case that never opened',
    );
    db.close();
  });

  it('a stalled case can be dismissed, releasing the escrow and the stake', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
    const challenger = miner(db, 1, 10_000);
    miner(db, 2, 5_000); // only one eligible juror: seating will fail

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    const stake = c.challengerStake;
    const challengerEarnedAfterFiling = getAccount(db, challenger.accountId)!.earnedBalance;

    escalateToFull(db, c.id);
    selectJury(db, c.id, 'seed-stalled');
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
    assert.equal(getAccount(db, defendant.account.id)!.isEscrowed, true);

    dismissStalledCase(db, c.id);

    const after = getAccount(db, challenger.accountId)!;
    assert.equal(getCase(db, c.id)!.status, 'withdrawn');
    assert.equal(getCase(db, c.id)!.verdict, null, 'dismissal is neutral, not a verdict');
    assert.equal(
      getAccount(db, defendant.account.id)!.isEscrowed,
      false,
      'the defendant must not stay frozen because the network had no jurors',
    );
    assert.equal(after.lockedBalance, 0n, 'challenger stake released');
    assert.equal(
      after.earnedBalance,
      challengerEarnedAfterFiling + stake,
      'stake returned in full — neither party is at fault for an empty pool',
    );
    db.close();
  });

  it('will not dismiss a healthy case', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 6; i++) miner(db, 2, 5_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'seed-healthy');
    assert.ok(jurors.length >= 3);

    assert.throws(() => dismissStalledCase(db, c.id), /Only a case stuck waiting/i);
    db.close();
  });
});
