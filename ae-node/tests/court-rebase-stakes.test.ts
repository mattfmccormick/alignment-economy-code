// Court stakes must move with the daily rebase.
//
// The rebase multiplies every locked_balance by targetTotal/preRebaseTotal,
// but court stakes were recorded as a fixed nominal amount at filing/seating
// time and never moved with it. A case stays open for days, so a rebase
// between seating and verdict was the normal path, not an edge case.
//
// Both directions broke, and this file pins both:
//   - multiplier < 1: the recorded stake exceeds what is actually locked, and
//     the verdict subtracts the recorded figure anyway. The audit repro drove
//     12 accounts negative, one to -14744000000000. A negative balance is
//     supply corruption; every total derived from it is then wrong.
//   - multiplier > 1: the recorded stake is smaller than what is locked, the
//     verdict releases less than it locked, and the remainder is stranded with
//     nothing left to free it (observed: 2293823529411 still locked after the
//     case closed).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, getAllAccounts, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, resolveVerdict,
} from '../src/court/court.js';
import { rebase } from '../src/core/day-cycle.js';
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

function negativeBalances(db: DatabaseSync) {
  return getAllAccounts(db).filter((a) => a.earnedBalance < 0n || a.lockedBalance < 0n);
}

describe('court: stakes survive a rebase mid-case', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('no balance goes negative when the multiplier is below 1', () => {
    // Everyone holds far more than TARGET_EARNED_PER_PERSON, so the rebase
    // multiplier is < 1 and every locked balance shrinks.
    const defendant = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(2_000_000));
    const challenger = miner(db, 1, 2_000_000);
    for (let i = 0; i < 13; i++) miner(db, 2, 2_000_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'rebase-down');
    assert.ok(jurors.length >= 3);

    rebase(db); // the daily cycle, while the case is open

    for (const jid of jurors) submitVote(db, c.id, jid, 'not_human');
    assert.equal(resolveVerdict(db, c.id), 'guilty');

    const bad = negativeBalances(db);
    assert.deepEqual(
      bad.map((a) => `${a.id.slice(0, 10)} earned=${a.earnedBalance} locked=${a.lockedBalance}`),
      [],
      'no account may hold a negative balance after a verdict',
    );
    db.close();
  });

  it('a juror keeps nothing locked after the verdict when the multiplier is above 1', () => {
    const defendant = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 13; i++) miner(db, 2, 5_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'rebase-up');
    assert.ok(jurors.length >= 3);

    const jurorRow = db
      .prepare('SELECT juror_account_id FROM court_jury WHERE case_id = ? LIMIT 1')
      .get(c.id) as { juror_account_id: string };

    rebase(db);

    for (const jid of jurors) submitVote(db, c.id, jid, 'not_human');
    resolveVerdict(db, c.id);

    assert.equal(
      getAccount(db, jurorRow.juror_account_id)!.lockedBalance,
      0n,
      'anything still locked after the case closes is stranded forever',
    );
    assert.deepEqual(negativeBalances(db).length, 0);
    db.close();
  });

  it('survives several rebases across a long-running case', () => {
    const defendant = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(500_000));
    const challenger = miner(db, 1, 500_000);
    for (let i = 0; i < 13; i++) miner(db, 2, 500_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'rebase-many');

    // Advance the day between rebases. rebase() is resumable and idempotent
    // per day (it reuses the stored rebase_events snapshot), so calling it
    // repeatedly on the same day is a resume, not three separate cycles.
    for (let d = 0; d < 3; d++) {
      rebase(db);
      db.prepare('UPDATE day_cycle_state SET current_day = current_day + 1 WHERE id = 1').run();
    }

    for (const jid of jurors) submitVote(db, c.id, jid, 'not_human');
    resolveVerdict(db, c.id);

    assert.deepEqual(negativeBalances(db).length, 0, 'no negatives after repeated rebases');
    db.close();
  });
});
