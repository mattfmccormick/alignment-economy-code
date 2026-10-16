// An appeal must settle through the appeal path.
//
// The vote route called resolveVerdict for every case, so an appeal never ran
// its own settlement. resolveAppeal had ZERO production callers, verified by
// grep. resolveCase now dispatches on level, so no call site has to remember.
//
// Settlement is also deferred now. The first jury's verdict only records
// `verdict_pending`: nothing burns, no bounty is paid, the defendant stays
// open and frozen. An appeal verdict then settles the WHOLE case once, against
// itself. So an overturned guilty verdict leaves the defendant exactly whole,
// with nothing to reopen and no bounty to claw back (the old court burned and
// paid out at the first verdict and could never fully undo it).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import { createVouch, getActiveVouchesForAccount } from '../src/verification/vouching.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote,
  resolveCase, fileAppeal, getCase, courtStore, expireCourtDeadlines,
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
const now = () => Math.floor(Date.now() / 1000);

function miner(db: DatabaseSync, tier: 1 | 2, earned: number) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

/** A pending guilty verdict with an appeal filed and its jury seated by the sweep. */
function guiltyThenAppealSeated(db: DatabaseSync) {
  const defendant = createAccount(db, 'individual', 1, 80);
  updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));
  const voucher = createAccount(db, 'individual', 1, 100);
  updateBalance(db, voucher.account.id, 'earned_balance', pts(5_000));
  const vouch = createVouch(db, voucher.account.id, defendant.account.id, 10);
  const challenger = miner(db, 1, 10_000);
  for (let i = 0; i < 26; i++) miner(db, 2, 5_000);

  const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
  const challengerEarnedAfterFiling = getAccount(db, challenger.accountId)!.earnedBalance;
  escalateToFull(db, c.id);
  const jurors = selectJury(db, c.id, 'appeal-original');
  for (const j of jurors) submitVote(db, c.id, j, 'not_human');
  assert.equal(resolveCase(db, c.id), 'guilty');

  const appeal = fileAppeal(db, c.id);
  assert.equal(appeal.status, 'appeal_open');
  assert.equal(courtStore(db).findJurorsByCase(appeal.id).length, 0, 'filing seats no jury');
  assert.deepEqual(expireCourtDeadlines(db, now() + 60).seated, [appeal.id]);
  const appealJurors = courtStore(db).findJurorsByCase(appeal.id).map((j) => j.minerId);

  return {
    caseId: c.id,
    stake: c.challengerStake,
    appealId: appeal.id,
    jurors,
    appealJurors,
    defendantId: defendant.account.id,
    voucherId: voucher.account.id,
    vouch,
    challengerId: challenger.accountId,
    challengerEarnedAfterFiling,
  };
}

describe('court: appeals settle through the appeal path', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('an overturned guilty verdict leaves the defendant exactly whole', () => {
    const s = guiltyThenAppealSeated(db);

    // While the first verdict is pending, nothing has moved.
    const pending = getAccount(db, s.defendantId)!;
    assert.equal(getCase(db, s.caseId)!.status, 'verdict_pending');
    assert.equal(pending.isActive, true, 'a pending guilty verdict does not close the account');
    assert.equal(pending.isEscrowed, true, 'but the savings stay frozen');
    assert.equal(pending.earnedBalance, pts(10_000), 'and nothing is burned');

    assert.ok(s.appealJurors.length >= 3, 'appeal needs its own jury');
    assert.equal(s.appealJurors.length, s.jurors.length, 'same size as the first jury');
    assert.throws(() => selectJury(db, s.appealId, 'again'), /already has a jury/);
    for (const j of s.appealJurors) submitVote(db, s.appealId, j, 'human');

    assert.equal(resolveCase(db, s.appealId), 'innocent');
    assert.equal(getCase(db, s.appealId)!.status, 'appeal_verdict');
    assert.equal(getCase(db, s.caseId)!.status, 'court_verdict', 'the appeal settles the original case');

    const defendant = getAccount(db, s.defendantId)!;
    assert.equal(defendant.isActive, true, 'never closed');
    assert.equal(defendant.isEscrowed, false, 'freeze lifted');
    assert.equal(
      defendant.earnedBalance,
      pts(10_000) + s.stake / 2n,
      'savings untouched, plus half the forfeited challenger stake for the freeze',
    );
    assert.deepEqual(
      getActiveVouchesForAccount(db, s.defendantId).map((v) => v.id),
      [s.vouch.id],
      'the vouch on the defendant is not burned',
    );
    assert.equal(getAccount(db, s.voucherId)!.lockedBalance, s.vouch.stakeAmount);

    const challenger = getAccount(db, s.challengerId)!;
    assert.equal(challenger.lockedBalance, 0n);
    assert.equal(
      challenger.earnedBalance,
      s.challengerEarnedAfterFiling,
      'the challenger lost the stake and never received a bounty',
    );

    // Every juror on both rounds is judged against the FINAL verdict. The
    // first jury got it wrong and forfeits; the appeal jury splits that pot.
    // Both juries are the same size and every juror held 5,000, so the split
    // is exactly one stake each.
    const store = courtStore(db);
    for (const j of store.findJurorsByCase(s.caseId)) {
      const a = getAccount(db, j.jurorAccountId)!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) - j.stakeAmount, 'first-round juror forfeits');
    }
    for (const j of store.findJurorsByCase(s.appealId)) {
      const a = getAccount(db, j.jurorAccountId)!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) + j.stakeAmount, 'appeal juror refunded plus a share');
    }
    db.close();
  });

  it('an appeal cannot be resolved twice', () => {
    const s = guiltyThenAppealSeated(db);
    for (const j of s.appealJurors) submitVote(db, s.appealId, j, 'human');
    resolveCase(db, s.appealId);

    const ids = [s.challengerId, s.defendantId, s.voucherId];
    const snap = () => ids.map((id) => {
      const a = getAccount(db, id)!;
      return `${id}:${a.earnedBalance}:${a.lockedBalance}:${a.isActive}`;
    });
    const snapshot = snap();

    assert.throws(() => resolveCase(db, s.appealId), /already resolved/i);
    assert.throws(() => resolveCase(db, s.caseId), /already resolved/i);
    const sweep = expireCourtDeadlines(db, now() + 30 * 86400);
    assert.deepEqual(sweep.settled, [], 'a settled case is not settled again');
    assert.deepEqual(sweep.resolved, []);
    assert.deepEqual(snap(), snapshot, 'a rejected re-resolve must not settle the case a second time');
    db.close();
  });
});
