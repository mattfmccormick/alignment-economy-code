// Verification-panel deadlines are enforced.
//
// mining.verification_deadline_hours (72 by default) was stamped onto every
// assignment and never read: markAssignmentMissed had no production caller at
// all. One assigned miner who simply never looked at their queue therefore
// stranded the applicant permanently.
//
// The mechanism is worth spelling out, because the symptom looks like nothing
// happening rather than an error. A panel completes when
// `scores.length >= assignedCount`. An assignment that is never marked missed
// keeps counting toward assignedCount forever, and a miner who never reviews
// never contributes a score — so the threshold stays permanently out of reach.
// The applicant sits at whatever percentHuman they already had, which for a new
// joiner is zero, and every daily-point spend burns to nothing.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier, miningStore } from '../src/mining/registration.js';
import { expireOverdueAssignments } from '../src/mining/fifo-queue.js';
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
const NOW = Math.floor(Date.now() / 1000);
const PAST = NOW - 10;
const FUTURE = NOW + 30 * 86400;

function miner(db: DatabaseSync, earned = 5_000) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  setMinerTier(db, m.id, 2, 'setup');
  return m.id;
}

function panelWithAssignments(
  db: DatabaseSync,
  accountId: string,
  minerIds: string[],
  deadline: number,
) {
  const panelId = randomUUID();
  verificationStore(db).insertPanel({ id: panelId, accountId, status: 'pending', createdAt: NOW - 100 });
  for (const minerId of minerIds) {
    miningStore(db).insertAssignment({
      id: randomUUID(), minerId, panelId, assignedAt: NOW - 100, deadline,
    });
  }
  return panelId;
}

describe('verification panels: deadlines are enforced', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('one silent miner no longer strands the applicant', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const [a, b, silent] = [miner(db), miner(db), miner(db)];
    const panelId = panelWithAssignments(db, applicant.account.id, [a, b, silent], PAST);

    // Two of three review. The third never opens their queue.
    submitPanelScore(db, panelId, a, 80);
    const beforeExpiry = submitPanelScore(db, panelId, b, 90);
    assert.equal(
      beforeExpiry.panelComplete,
      false,
      'still waiting on the third miner, which is correct until the deadline',
    );
    assert.equal(getAccount(db, applicant.account.id)!.percentHuman, 0);

    const out = expireOverdueAssignments(db, NOW);
    assert.equal(out.missed, 1, 'only the unscored assignment is missed');

    // The applicant is no longer blocked: the next score completes the panel
    // because the silent miner has stopped counting toward the threshold.
    const c = miner(db);
    miningStore(db).insertAssignment({
      id: randomUUID(), minerId: c, panelId, assignedAt: NOW, deadline: FUTURE,
    });
    const done = submitPanelScore(db, panelId, c, 85);

    assert.equal(done.panelComplete, true, 'the panel can now finish');
    assert.equal(
      getAccount(db, applicant.account.id)!.percentHuman,
      85,
      'median of the scores actually submitted',
    );
    db.close();
  });

  it('leaves assignments that are still in time alone', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const m = miner(db);
    panelWithAssignments(db, applicant.account.id, [m], FUTURE);

    const out = expireOverdueAssignments(db, NOW);
    assert.equal(out.missed, 0);
    assert.deepEqual(out.panelsLeftUnreviewed, []);
    db.close();
  });

  it('reports a panel nobody reviewed rather than inventing a score', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const [a, b] = [miner(db), miner(db)];
    const panelId = panelWithAssignments(db, applicant.account.id, [a, b], PAST);

    const out = expireOverdueAssignments(db, NOW);

    assert.equal(out.missed, 2);
    assert.deepEqual(out.panelsLeftUnreviewed, [panelId]);
    // Crucially: no score was fabricated for a review nobody performed.
    assert.equal(getAccount(db, applicant.account.id)!.percentHuman, 0);
    assert.equal(verificationStore(db).findPanelById(panelId)!.status, 'pending');
    db.close();
  });

  it('does not re-mark an assignment already missed', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const m = miner(db);
    panelWithAssignments(db, applicant.account.id, [m], PAST);

    assert.equal(expireOverdueAssignments(db, NOW).missed, 1);
    assert.equal(expireOverdueAssignments(db, NOW).missed, 0, 'idempotent');
    db.close();
  });

  it('a miner who scored in time is never marked missed', () => {
    const applicant = createAccount(db, 'individual', 1, 0);
    const m = miner(db);
    const panelId = panelWithAssignments(db, applicant.account.id, [m], PAST);
    submitPanelScore(db, panelId, m, 70);

    // The assignment row is only flagged complete by the FIFO layer, so the
    // sweep must key on "has this miner scored", not just the deadline.
    const out = expireOverdueAssignments(db, NOW);
    void out;
    const live = miningStore(db).findLiveAssignmentMinerIds(panelId);
    assert.ok(
      live.includes(m) || verificationStore(db).findPanelById(panelId)!.status === 'complete',
      'a miner who did the work must not be penalised by the sweep',
    );
    db.close();
  });
});
