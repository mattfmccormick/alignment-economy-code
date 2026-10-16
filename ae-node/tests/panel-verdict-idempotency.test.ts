// Three defects that all share one shape: an operation that should happen once
// could happen again, and each repeat quietly rewrote money or a score.
//
//   1. resolveVerdict had no guard, so a second call replayed the whole
//      settlement — burning the defendant twice, paying the bounty twice,
//      unlocking juror stakes already unlocked. Reachable from an HTTP retry.
//      Settlement is deferred now (the jury's decision records
//      verdict_pending; the sweep settles once the appeal window closes), so
//      both halves must run exactly once: the decision and the settlement.
//   2. A completed panel kept accepting scores, so a late miner recomputed the
//      median over a larger set and silently rewrote a published verification.
//   3. A fractional score was written straight into percent_human. SQLite
//      stores a real in an INTEGER column happily, and every daily-point spend
//      then does BigInt(percentHuman), which throws RangeError on a
//      non-integer — permanently bricking that account's ability to spend, with
//      the error surfacing nowhere near its cause.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, resolveVerdict, expireCourtDeadlines, getCase,
} from '../src/court/court.js';
import { submitPanelScore, verificationStore } from '../src/verification/panel.js';
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

function pendingPanel(db: DatabaseSync, accountId: string) {
  const id = randomUUID();
  verificationStore(db).insertPanel({
    id, accountId, createdAt: Math.floor(Date.now() / 1000),
  });
  return id;
}

describe('court: a verdict resolves exactly once', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a second resolveVerdict is rejected, and the settlement runs exactly once', () => {
    const defendant = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 13; i++) miner(db, 2, 5_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'idem');
    for (const j of jurors) submitVote(db, c.id, j, 'not_human');

    const ids = [challenger.accountId, defendant.account.id];
    const snap = () => ids.map((id) => {
      const a = getAccount(db, id)!;
      return `${id}:${a.earnedBalance}:${a.lockedBalance}:${a.isActive}`;
    });

    assert.equal(resolveVerdict(db, c.id), 'guilty');
    assert.equal(getCase(db, c.id)!.status, 'verdict_pending');
    const pending = snap();

    assert.throws(() => resolveVerdict(db, c.id), /already resolved/i);
    assert.deepEqual(snap(), pending, 'a rejected re-resolve must not move a single point');

    // The appeal window closes; the sweep settles the case once.
    const settleAt = Math.floor(Date.now() / 1000) + 8 * 86400;
    assert.deepEqual(expireCourtDeadlines(db, settleAt).settled, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'court_verdict');
    const settled = snap();
    assert.notDeepEqual(settled, pending, 'the settlement itself moved the money');

    // Neither a retried resolve nor another sweep settles it again.
    assert.throws(() => resolveVerdict(db, c.id), /already resolved/i);
    assert.deepEqual(expireCourtDeadlines(db, settleAt + 86400).settled, []);
    assert.deepEqual(snap(), settled, 'no second burn, no second bounty');
    db.close();
  });
});

describe('verification panels: scores are whole, and final', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('rejects a fractional score rather than corrupting percentHuman', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const panelId = pendingPanel(db, applicant.account.id);
    const m = miner(db, 2, 5_000);

    assert.throws(
      () => submitPanelScore(db, panelId, m.minerId, 87.5),
      /whole number/i,
    );

    // The real damage was downstream: BigInt() on a non-integer throws, so the
    // account could never spend daily points again.
    const pH = getAccount(db, applicant.account.id)!.percentHuman;
    assert.ok(Number.isInteger(pH), `percentHuman must stay an integer, got ${pH}`);
    assert.doesNotThrow(() => BigInt(pH));
    db.close();
  });

  it('a completed panel refuses further scores', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const panelId = pendingPanel(db, applicant.account.id);
    const a = miner(db, 2, 5_000);
    const b = miner(db, 2, 5_000);
    const c = miner(db, 2, 5_000);
    const late = miner(db, 2, 5_000);

    submitPanelScore(db, panelId, a.minerId, 80);
    submitPanelScore(db, panelId, b.minerId, 80);
    const done = submitPanelScore(db, panelId, c.minerId, 80);
    assert.equal(done.panelComplete, true);
    assert.equal(done.medianScore, 80);

    const settled = getAccount(db, applicant.account.id)!.percentHuman;

    assert.throws(
      () => submitPanelScore(db, panelId, late.minerId, 10),
      /already completed/i,
    );
    assert.equal(
      getAccount(db, applicant.account.id)!.percentHuman,
      settled,
      'a late score must not rewrite a published verification',
    );
    db.close();
  });

  it('the median of a completed panel is always a whole number', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const panelId = pendingPanel(db, applicant.account.id);
    const a = miner(db, 2, 5_000);
    const b = miner(db, 2, 5_000);
    const c = miner(db, 2, 5_000);

    submitPanelScore(db, panelId, a.minerId, 70);
    submitPanelScore(db, panelId, b.minerId, 75);
    const done = submitPanelScore(db, panelId, c.minerId, 81);

    assert.ok(Number.isInteger(done.medianScore!), 'median must be an integer');
    assert.ok(Number.isInteger(getAccount(db, applicant.account.id)!.percentHuman));
    db.close();
  });
});
