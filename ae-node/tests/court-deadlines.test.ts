// Court deadlines are enforced.
//
// arbitration_deadline and voting_deadline were written at filing and seating,
// returned by the API and rendered in both apps, and no code anywhere
// compared them to a clock. Nothing ever expired.
//
// The consequence was not a cosmetic one. A single juror who never voted froze
// the case, the defendant's escrowed earned balance, and every juror's stake,
// permanently: resolveVerdict throws NO_VOTES with zero votes, and with a
// partial set nothing called it at all. One unresponsive miner could deny
// someone their savings indefinitely.
//
// The day-cycle sweep (expireCourtDeadlines) now moves every case along:
//   - arbitration window closed: the case moves to court and a jury is drawn;
//   - no jury by the seat-by deadline: dismissed, every stake returned;
//   - voting deadline: a majority of the SEATED jury decides (verdict_pending),
//     otherwise dismissed, and the no-shows pay for it;
//   - verdict pending past the appeal window: settled once.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, getCase, expireCourtDeadlines, courtStore,
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
const LATER = now() + 365 * DAY;
/** Past the 7-day appeal window of a verdict recorded at LATER. */
const AFTER_APPEAL = LATER + 7 * DAY + 60;

function miner(db: DatabaseSync, tier: 1 | 2, earned: number) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

function stagedCase(db: DatabaseSync) {
  const defendant = createAccount(db, 'individual', 1, 80);
  updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));
  const challenger = miner(db, 1, 10_000);
  for (let i = 0; i < 13; i++) miner(db, 2, 5_000);
  const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
  return { c, defendantId: defendant.account.id, challengerId: challenger.accountId };
}

function jurorAccounts(db: DatabaseSync, caseId: string) {
  return new Map(courtStore(db).findJurorsByCase(caseId).map((j) => [j.minerId, j]));
}

describe('court: deadlines actually expire', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('the arbitration deadline moves the case to court and the sweep draws the jury', () => {
    // Old rule: an expired arbitration window dismissed the case. New rule:
    // it escalates, and the jury is drawn at that same sweep.
    const { c, defendantId } = stagedCase(db);

    const early = expireCourtDeadlines(db, now() + 6 * DAY);
    assert.deepEqual(early.escalated, [], 'still inside the arbitration window');
    assert.equal(getCase(db, c.id)!.status, 'arbitration_open');

    const out = expireCourtDeadlines(db, now() + 7 * DAY + 60);
    assert.deepEqual(out.escalated, [c.id]);
    assert.deepEqual(out.seated, [c.id]);
    assert.deepEqual(out.dismissed, []);
    const moved = getCase(db, c.id)!;
    assert.equal(moved.level, 'court');
    assert.equal(moved.status, 'court_voting');
    assert.equal(courtStore(db).findJurorsByCase(c.id).length, 3, '13 eligible jurors seat a jury of 3');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, true);
    db.close();
  });

  it('a voting deadline with a majority of the seated jury decides; it settles after the appeal window', () => {
    const { c, defendantId } = stagedCase(db);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'deadline-partial');
    assert.equal(jurors.length, 3);
    const rows = jurorAccounts(db, c.id);

    // Just over half the seats vote. The rest go silent.
    const majority = Math.floor(jurors.length / 2) + 1;
    const voters = jurors.slice(0, majority);
    const silent = jurors.slice(majority);
    for (const j of voters) submitVote(db, c.id, j, 'not_human');

    const out = expireCourtDeadlines(db, LATER);
    assert.deepEqual(out.resolved, [c.id]);
    assert.deepEqual(out.settled, []);
    const decided = getCase(db, c.id)!;
    assert.equal(decided.verdict, 'guilty', 'a majority of the seats is a verdict');
    assert.equal(decided.status, 'verdict_pending');
    // Nothing irreversible before the verdict is final.
    let defendant = getAccount(db, defendantId)!;
    assert.equal(defendant.isActive, true);
    assert.equal(defendant.isEscrowed, true);
    assert.equal(defendant.earnedBalance, pts(10_000));

    const final = expireCourtDeadlines(db, AFTER_APPEAL);
    assert.deepEqual(final.settled, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'court_verdict');
    defendant = getAccount(db, defendantId)!;
    assert.equal(defendant.isActive, false, 'a final guilty verdict closes the defendant account');
    assert.equal(defendant.earnedBalance, 0n);

    // Silent jurors forfeit to the jurors who matched the final verdict.
    const pot = silent.reduce((sum, m) => sum + rows.get(m)!.stakeAmount, 0n);
    for (const m of silent) {
      const a = getAccount(db, rows.get(m)!.jurorAccountId)!;
      assert.equal(a.earnedBalance, pts(5_000) - rows.get(m)!.stakeAmount, 'a no-show forfeits');
    }
    for (const m of voters) {
      const a = getAccount(db, rows.get(m)!.jurorAccountId)!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) + pot / BigInt(voters.length), 'a matching voter is refunded plus a share');
    }

    // And it settles exactly once.
    const snapshot = getAccount(db, rows.get(voters[0])!.jurorAccountId)!.earnedBalance;
    assert.deepEqual(expireCourtDeadlines(db, AFTER_APPEAL + DAY).settled, []);
    assert.equal(getAccount(db, rows.get(voters[0])!.jurorAccountId)!.earnedBalance, snapshot);
    db.close();
  });

  it('one vote out of a full jury is NOT a verdict: the case is dismissed and nobody is convicted', () => {
    const { c, defendantId, challengerId } = stagedCase(db);
    const challengerEarnedAfterFiling = getAccount(db, challengerId)!.earnedBalance;
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'deadline-one-vote');
    assert.ok(jurors.length >= 3);
    const rows = jurorAccounts(db, c.id);

    // This used to convict: one juror votes, the rest stay silent, and at
    // the deadline that single vote closed the account and burned 80% of it.
    submitVote(db, c.id, jurors[0], 'not_human');

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.resolved, []);
    assert.deepEqual(out.dismissed, [c.id]);
    const settled = getCase(db, c.id)!;
    assert.equal(settled.verdict, null);
    assert.equal(settled.status, 'dismissed');
    const defendant = getAccount(db, defendantId)!;
    assert.equal(defendant.isActive, true, 'not closed');
    assert.equal(defendant.isEscrowed, false, 'and no longer frozen');
    assert.equal(defendant.earnedBalance, pts(10_000), 'balance untouched');
    assert.equal(
      getAccount(db, challengerId)!.earnedBalance,
      challengerEarnedAfterFiling + c.challengerStake,
      'no decision, so the stake comes back',
    );

    // The no-shows caused the dismissal, so they pay the juror who showed up.
    const pot = jurors.slice(1).reduce((sum, m) => sum + rows.get(m)!.stakeAmount, 0n);
    assert.equal(getAccount(db, rows.get(jurors[0])!.jurorAccountId)!.earnedBalance, pts(5_000) + pot);
    for (const m of jurors.slice(1)) {
      assert.equal(
        getAccount(db, rows.get(m)!.jurorAccountId)!.earnedBalance,
        pts(5_000) - rows.get(m)!.stakeAmount,
      );
    }
    db.close();
  });

  it('a final innocent verdict lifts the escrow', () => {
    const { c, defendantId } = stagedCase(db);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'deadline-innocent');
    const majority = Math.floor(jurors.length / 2) + 1;
    for (const j of jurors.slice(0, majority)) submitVote(db, c.id, j, 'human');

    expireCourtDeadlines(db, LATER);
    assert.equal(getCase(db, c.id)!.verdict, 'innocent');
    assert.equal(getCase(db, c.id)!.status, 'verdict_pending');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, true, 'still frozen through the appeal window');

    expireCourtDeadlines(db, AFTER_APPEAL);
    assert.equal(getCase(db, c.id)!.status, 'court_verdict');
    assert.equal(
      getAccount(db, defendantId)!.isEscrowed,
      false,
      'a cleared defendant must get their earned balance back',
    );
    assert.equal(getAccount(db, defendantId)!.isActive, true);
    db.close();
  });

  it('a voting deadline with no votes at all dismisses neutrally', () => {
    const { c, defendantId, challengerId } = stagedCase(db);
    const stakedEarned = getAccount(db, challengerId)!.earnedBalance;
    const stake = c.challengerStake;

    escalateToFull(db, c.id);
    selectJury(db, c.id, 'deadline-silent');
    const rows = [...jurorAccounts(db, c.id).values()];

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.dismissed, [c.id]);
    const settled = getCase(db, c.id)!;
    assert.equal(settled.status, 'dismissed');
    assert.equal(settled.verdict, null, 'nobody proved anything, so no verdict');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, false);
    assert.equal(
      getAccount(db, challengerId)!.earnedBalance,
      stakedEarned + stake,
      'stake returned in full: the jury failed to show, not the challenger',
    );
    for (const j of rows) {
      const a = getAccount(db, j.jurorAccountId)!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) - j.stakeAmount, 'every no-show forfeits (burned, nobody voted)');
    }
    db.close();
  });

  it('a case stuck waiting for a jury is dismissed at its seat-by deadline', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
    const challenger = miner(db, 1, 10_000);
    miner(db, 2, 5_000); // only one eligible juror, so seating fails

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    const challengerEarnedAfterFiling = getAccount(db, challenger.accountId)!.earnedBalance;
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'deadline-nojury');
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
    assert.equal(getAccount(db, defendant.account.id)!.isEscrowed, true);

    // Inside the 7-day seat-by window the sweep retries and keeps waiting.
    const early = expireCourtDeadlines(db, now() + 3 * DAY);
    assert.deepEqual(early.dismissed, []);
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');

    const out = expireCourtDeadlines(db, LATER);
    assert.deepEqual(out.dismissed, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'dismissed');
    assert.equal(
      getAccount(db, defendant.account.id)!.isEscrowed,
      false,
      'the defendant must not stay frozen because no jury existed',
    );
    assert.equal(
      getAccount(db, challenger.accountId)!.earnedBalance,
      challengerEarnedAfterFiling + c.challengerStake,
      'neither party is at fault for an empty pool',
    );
    db.close();
  });

  it('leaves a live case alone', () => {
    const { c, defendantId } = stagedCase(db);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'deadline-live');

    // Reference time BEFORE any deadline.
    const out = expireCourtDeadlines(db, now() - 10);

    assert.deepEqual(out.resolved, []);
    assert.deepEqual(out.dismissed, []);
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, true);
    db.close();
  });

  it('is safe to run twice', () => {
    const { c, challengerId } = stagedCase(db);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'deadline-twice');

    expireCourtDeadlines(db, LATER);
    const after = getAccount(db, challengerId)!.earnedBalance;

    const second = expireCourtDeadlines(db, LATER);
    assert.deepEqual(second.dismissed, [], 'a settled case is not re-settled');
    assert.equal(
      getAccount(db, challengerId)!.earnedBalance,
      after,
      'a second sweep must not release the stake again',
    );
    db.close();
  });
});
