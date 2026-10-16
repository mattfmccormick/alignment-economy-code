// A guilty verdict must reflect on the miners who verified that account.
//
// applyAccuracyImpact existed, was correct, and had no production caller. So a
// court finding that an account was not human never touched the miners who had
// passed it. That is the accountability loop the whole proof-of-human model
// rests on (the white paper's "miners justify their percent-human scores and
// their accuracy is measured against court outcomes") and without it a miner
// could wave through fraudulent accounts indefinitely at no cost to their tier.
//
// The impact lands at FINAL settlement, not when the first jury votes: the
// verdict sits in `verdict_pending` through the appeal window, and an appeal
// can overturn it. Demoting a miner on a verdict that is later reversed would
// punish them for being right.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier, getMiner } from '../src/mining/registration.js';
import { verificationStore } from '../src/verification/panel.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, resolveCase, fileAppeal,
  expireCourtDeadlines, getCase, courtStore,
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
/** Past the 7-day appeal window of a verdict recorded "now". */
const AFTER_APPEAL_WINDOW = () => now() + 8 * 86400;

function miner(db: DatabaseSync, tier: 1 | 2, earned = 5_000) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

/** A completed panel where `scorer` passed the account as human. */
function panelPassing(db: DatabaseSync, accountId: string, scorerMinerId: string) {
  const verif = verificationStore(db);
  const panelId = randomUUID();
  const at = now() - 100;
  verif.insertPanel({ id: panelId, accountId, createdAt: at });
  verif.insertReview({
    id: randomUUID(),
    panelId,
    minerId: scorerMinerId,
    score: 95, // "definitely human"
    evidenceHashOfReview: 'h',
    submittedAt: at,
  });
  verif.completePanel(panelId, at + 1, 95);
  return panelId;
}

/** A defendant passed by a tier-2 miner, a challenger, and a jury pool. */
function stage(db: DatabaseSync) {
  // Any wrong call should be enough to cross the threshold in this test.
  setParam(db, 'mining.tier2_accuracy_threshold', 0.9, undefined, undefined, true);

  const defendant = createAccount(db, 'individual', 1, 95);
  updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));

  // The miner who passed this account's humanity, at tier 2.
  const verifier = miner(db, 2);
  panelPassing(db, defendant.account.id, verifier.minerId);
  assert.equal(getMiner(db, verifier.minerId)!.tier, 2);

  const challenger = miner(db, 1, 10_000);
  for (let i = 0; i < 13; i++) miner(db, 2);

  const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
  escalateToFull(db, c.id);
  return { caseId: c.id, verifier };
}

describe('court: a guilty verdict reaches the miners who verified the account', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('demotes a tier-2 miner who passed an account, once the guilty verdict is final', () => {
    const { caseId, verifier } = stage(db);
    const jurors = selectJury(db, caseId, 'accuracy-guilty');
    assert.ok(!jurors.includes(verifier.minerId), 'the verifier has a stake in the outcome and cannot sit');
    for (const j of jurors) submitVote(db, caseId, j, 'not_human');

    assert.equal(resolveCase(db, caseId), 'guilty');
    assert.equal(getCase(db, caseId)!.status, 'verdict_pending');
    assert.equal(
      getMiner(db, verifier.minerId)!.tier,
      2,
      'nothing touches the verifier while the verdict can still be appealed',
    );

    const out = expireCourtDeadlines(db, AFTER_APPEAL_WINDOW());
    assert.deepEqual(out.settled, [caseId]);
    assert.equal(getCase(db, caseId)!.status, 'court_verdict');
    assert.equal(
      getMiner(db, verifier.minerId)!.tier,
      1,
      'a miner who passed an account the court found fraudulent must lose tier 2',
    );
    db.close();
  });

  it('leaves the verifying miner alone when a guilty verdict is overturned on appeal', () => {
    const { caseId, verifier } = stage(db);
    const jurors = selectJury(db, caseId, 'accuracy-overturned');
    for (const j of jurors) submitVote(db, caseId, j, 'not_human');
    assert.equal(resolveCase(db, caseId), 'guilty');

    // The defendant appeals; the next sweep seats a fresh jury that clears them.
    const appeal = fileAppeal(db, caseId);
    const sweep = expireCourtDeadlines(db, now() + 60);
    assert.deepEqual(sweep.seated, [appeal.id]);
    const appealJurors = courtStore(db).findJurorsByCase(appeal.id).map((j) => j.minerId);
    for (const j of appealJurors) submitVote(db, appeal.id, j, 'human');
    assert.equal(resolveCase(db, appeal.id), 'innocent');

    assert.equal(getCase(db, caseId)!.status, 'court_verdict', 'the appeal verdict settles the case');
    assert.equal(
      getMiner(db, verifier.minerId)!.tier,
      2,
      'a first verdict that was reversed must never reach the verifier',
    );
    db.close();
  });

  it('leaves the verifying miner alone on an innocent verdict', () => {
    const { caseId, verifier } = stage(db);
    const jurors = selectJury(db, caseId, 'accuracy-innocent');
    for (const j of jurors) submitVote(db, caseId, j, 'human');

    assert.equal(resolveCase(db, caseId), 'innocent');
    assert.deepEqual(expireCourtDeadlines(db, AFTER_APPEAL_WINDOW()).settled, [caseId]);
    assert.equal(
      getMiner(db, verifier.minerId)!.tier,
      2,
      'being right must not cost the miner anything',
    );
    db.close();
  });
});
