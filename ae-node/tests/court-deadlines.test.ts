// Court deadlines are enforced.
//
// arbitration_deadline and voting_deadline were written at filing and seating,
// returned by the API and rendered in both apps — and no code anywhere
// compared them to a clock. Nothing ever expired.
//
// The consequence was not a cosmetic one. A single juror who never voted froze
// the case, the defendant's escrowed earned balance, and every juror's stake,
// permanently: resolveVerdict throws NO_VOTES with zero votes, and with a
// partial set nothing called it at all. One unresponsive miner could deny
// someone their savings indefinitely.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, getCase, expireCourtDeadlines,
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
const LATER = Math.floor(Date.now() / 1000) + 365 * 86400;

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

describe('court: deadlines actually expire', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a voting deadline with some votes cast resolves on those votes', () => {
    const { c, defendantId } = stagedCase(db);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'deadline-partial');
    assert.ok(jurors.length >= 3);

    // Only one juror bothers to vote. Everyone else goes silent.
    submitVote(db, c.id, jurors[0], 'not_human');

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.resolved, [c.id]);
    const settled = getCase(db, c.id)!;
    assert.equal(settled.verdict, 'guilty', 'decided on the one vote actually cast');
    // A guilty verdict closes the account outright (deactivateAccount), so the
    // escrow flag is moot from there — an inactive account cannot transact
    // either way. The innocent path is the one that lifts escrow.
    assert.equal(
      getAccount(db, defendantId)!.isActive,
      false,
      'a guilty verdict closes the defendant account',
    );
    db.close();
  });

  it('an innocent outcome at the deadline lifts the escrow', () => {
    const { c, defendantId } = stagedCase(db);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'deadline-innocent');
    submitVote(db, c.id, jurors[0], 'human');

    expireCourtDeadlines(db, LATER);

    assert.equal(getCase(db, c.id)!.verdict, 'innocent');
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

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.dismissed, [c.id]);
    const settled = getCase(db, c.id)!;
    assert.equal(settled.status, 'withdrawn');
    assert.equal(settled.verdict, null, 'nobody proved anything, so no verdict');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, false);
    assert.equal(
      getAccount(db, challengerId)!.earnedBalance,
      stakedEarned + stake,
      'stake returned in full — the jury failed to show, not the challenger',
    );
    db.close();
  });

  it('a case stuck waiting for a jury is released once arbitration expires', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));
    const challenger = miner(db, 1, 10_000);
    miner(db, 2, 5_000); // only one eligible juror, so seating fails

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'deadline-nojury');
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
    assert.equal(getAccount(db, defendant.account.id)!.isEscrowed, true);

    expireCourtDeadlines(db, LATER);

    assert.equal(getCase(db, c.id)!.status, 'withdrawn');
    assert.equal(
      getAccount(db, defendant.account.id)!.isEscrowed,
      false,
      'the defendant must not stay frozen because no jury existed',
    );
    db.close();
  });

  it('leaves a live case alone', () => {
    const { c, defendantId } = stagedCase(db);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'deadline-live');

    // Reference time BEFORE any deadline.
    const out = expireCourtDeadlines(db, Math.floor(Date.now() / 1000) - 10);

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
