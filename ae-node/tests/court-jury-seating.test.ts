// Jury seating must produce a jury that can actually decide, or no jury at all.
//
// Three defects found by running an audit agent's repro harness, all in
// selectJury, all with the same shape: the function reported success without
// checking what it had actually seated.
//
//   - The defendant was never excluded from the pool, so a defendant who was
//     an active miner could sit on their own jury and vote.
//   - Miners who could not post the stake were skipped with a bare `continue`
//     AFTER the jury size had been fixed, so a pool of three where two held
//     nothing seated one juror, and the case still advanced to voting. One
//     person then decides a verdict that closes an account.
//   - A pool too small parked the case in court_waiting_jury with the
//     defendant escrowed and the challenger's stake locked, and nothing could
//     ever re-run selection. Permanent.
//
// Now: the day-cycle sweep retries seating on every waiting case, and
// dismisses it neutrally once its seat-by deadline (escalation +
// court.jury_wait_days) passes. A seat belongs to any active miner whose
// account is an active individual at court.juror_min_percent_human or more,
// whatever the miner's tier. The jury is 3, 7 or 11 depending on the pool.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, getCase, expireCourtDeadlines, jurySizeFor,
} from '../src/court/court.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const DAY = 86400;
const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));
const now = () => Math.floor(Date.now() / 1000);

function miner(db: DatabaseSync, tier: 1 | 2, earned: number, percentHuman = 100) {
  const r = createAccount(db, 'individual', 1, percentHuman);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

/** A defendant, a challenger, and a case escalated to court with no jury yet. */
function courtCaseWithPool(db: DatabaseSync, escalatedAt = now()) {
  const defendant = createAccount(db, 'individual', 1, 100);
  updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
  const challenger = miner(db, 1, 10_000);
  const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
  const challengerEarnedAfterFiling = getAccount(db, challenger.accountId)!.earnedBalance;
  escalateToFull(db, c.id, escalatedAt);
  return { c, defendantId: defendant.account.id, challenger, challengerEarnedAfterFiling };
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
    assert.equal(jurors.includes(challenger.minerId), false, 'nor the challenger');
    db.close();
  });

  it('any miner at 90%+ human can sit, whatever its tier; under 90% cannot', () => {
    // Old rule: only tier-2 miners were drawn. New rule: tier is irrelevant;
    // the percent-human score of the account decides.
    const tier1 = [miner(db, 1, 5_000), miner(db, 1, 5_000), miner(db, 1, 5_000, 90)];
    const unverified = miner(db, 2, 5_000, 89);
    const { c } = courtCaseWithPool(db);

    const jurors = selectJury(db, c.id, 'seed-tier');
    assert.deepEqual(
      [...jurors].sort(),
      tier1.map((m) => m.minerId).sort(),
      'the three tier-1 miners at 90%+ are the jury',
    );
    assert.equal(jurors.includes(unverified.minerId), false, 'an 89% account cannot hold a seat');
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
    db.close();
  });

  it('jury size steps up with the eligible pool: 3, then 7, then 11', () => {
    assert.equal(jurySizeFor(0, 11), 0);
    assert.equal(jurySizeFor(2, 11), 0, 'under three eligible: no trial yet');
    assert.equal(jurySizeFor(3, 11), 3);
    assert.equal(jurySizeFor(20, 11), 3);
    assert.equal(jurySizeFor(21, 11), 7);
    assert.equal(jurySizeFor(32, 11), 7);
    assert.equal(jurySizeFor(33, 11), 11);
    assert.equal(jurySizeFor(10_000, 11), 11, 'never above court.jury_size');
  });

  it('refuses to open voting with a jury of one', () => {
    miner(db, 2, 5_000);  // can stake
    miner(db, 2, 0);      // cannot
    miner(db, 2, 0);      // cannot
    const { c } = courtCaseWithPool(db);

    const jurors = selectJury(db, c.id, 'seed-tiny');

    assert.equal(jurors.length, 0, 'no jury rather than a jury of one');
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
    db.close();
  });

  it('leaves no stake locked when seating fails', () => {
    const lonely = miner(db, 2, 5_000);
    const before = getAccount(db, lonely.accountId)!.lockedBalance;
    const { c } = courtCaseWithPool(db);

    selectJury(db, c.id, 'seed-rollback');

    assert.equal(
      getAccount(db, lonely.accountId)!.lockedBalance,
      before,
      'a juror must not be left staked against a case that never opened',
    );
    db.close();
  });

  it('a waiting case is seated by a later sweep once enough jurors exist', () => {
    // The old bug: nothing ever re-ran selection on a waiting case.
    miner(db, 2, 5_000);
    const { c } = courtCaseWithPool(db);
    assert.deepEqual(selectJury(db, c.id, 'seed-wait'), []);
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');

    miner(db, 1, 5_000);
    miner(db, 1, 5_000);

    const out = expireCourtDeadlines(db, now() + DAY);
    assert.deepEqual(out.seated, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
    db.close();
  });

  it('a stalled case is dismissed at its seat-by deadline, releasing the escrow and the stake', () => {
    // Replaces the old manual dismissStalledCase: the sweep does it.
    miner(db, 2, 5_000); // only one eligible juror: seating will fail
    const { c, defendantId, challenger, challengerEarnedAfterFiling } = courtCaseWithPool(db);
    const stake = c.challengerStake;

    selectJury(db, c.id, 'seed-stalled');
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, true);

    const out = expireCourtDeadlines(db, now() + 7 * DAY + 60);
    assert.deepEqual(out.dismissed, [c.id]);

    const after = getAccount(db, challenger.accountId)!;
    assert.equal(getCase(db, c.id)!.status, 'dismissed');
    assert.equal(getCase(db, c.id)!.verdict, null, 'dismissal is neutral, not a verdict');
    assert.equal(
      getAccount(db, defendantId)!.isEscrowed,
      false,
      'the defendant must not stay frozen because the network had no jurors',
    );
    assert.equal(after.lockedBalance, 0n, 'challenger stake released');
    assert.equal(
      after.earnedBalance,
      challengerEarnedAfterFiling + stake,
      'stake returned in full: neither party is at fault for an empty pool',
    );
    db.close();
  });

  it('will not dismiss a healthy case: once seated, the seat-by deadline no longer applies', () => {
    for (let i = 0; i < 6; i++) miner(db, 2, 5_000);
    const t0 = now();
    const { c } = courtCaseWithPool(db, t0); // seat-by: t0 + 7 days

    // Seated on day 3, so voting runs to day 10.
    const jurors = selectJury(db, c.id, 'seed-healthy', t0 + 3 * DAY);
    assert.ok(jurors.length >= 3);

    // Day 8: past the seat-by deadline, inside the voting window.
    const out = expireCourtDeadlines(db, t0 + 8 * DAY);
    assert.deepEqual(out.dismissed, []);
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
    db.close();
  });
});
