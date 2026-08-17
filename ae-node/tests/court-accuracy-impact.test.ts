// A guilty verdict must reflect on the miners who verified that account.
//
// applyAccuracyImpact existed, was correct, and had no production caller. So a
// court finding that an account was not human never touched the miners who had
// passed it. That is the accountability loop the whole proof-of-human model
// rests on — the white paper's "miners justify their percent-human scores and
// their accuracy is measured against court outcomes" — and without it a miner
// could wave through fraudulent accounts indefinitely at no cost to their tier.

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
  fileChallenge, escalateToFull, selectJury, submitVote, resolveCase,
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
  const at = Math.floor(Date.now() / 1000) - 100;
  verif.insertPanel({ id: panelId, accountId, status: 'pending', createdAt: at });
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

describe('court: a guilty verdict reaches the miners who verified the account', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('demotes a tier-2 miner who passed an account the court finds guilty', () => {
    // Any wrong call should be enough to cross the threshold in this test.
    setParam(db, 'mining.tier2_accuracy_threshold', 0.9, undefined, undefined, true);

    const fraud = createAccount(db, 'individual', 1, 95);
    updateBalance(db, fraud.account.id, 'earned_balance', pts(10_000));

    // The miner who vouched for this account's humanity, at tier 2.
    const sloppy = miner(db, 2);
    panelPassing(db, fraud.account.id, sloppy.minerId);
    assert.equal(getMiner(db, sloppy.minerId)!.tier, 2);

    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 13; i++) miner(db, 2);

    const c = fileChallenge(db, challenger.accountId, fraud.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'accuracy-guilty');
    for (const j of jurors) submitVote(db, c.id, j, 'not_human');

    assert.equal(resolveCase(db, c.id), 'guilty');

    assert.equal(
      getMiner(db, sloppy.minerId)!.tier,
      1,
      'a miner who passed an account the court found fraudulent must lose tier 2',
    );
    db.close();
  });

  it('leaves the verifying miner alone on an innocent verdict', () => {
    setParam(db, 'mining.tier2_accuracy_threshold', 0.9, undefined, undefined, true);

    const cleared = createAccount(db, 'individual', 1, 95);
    updateBalance(db, cleared.account.id, 'earned_balance', pts(10_000));

    const careful = miner(db, 2);
    panelPassing(db, cleared.account.id, careful.minerId);

    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 13; i++) miner(db, 2);

    const c = fileChallenge(db, challenger.accountId, cleared.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'accuracy-innocent');
    for (const j of jurors) submitVote(db, c.id, j, 'human');

    assert.equal(resolveCase(db, c.id), 'innocent');
    assert.equal(
      getMiner(db, careful.minerId)!.tier,
      2,
      'being right must not cost the miner anything',
    );
    db.close();
  });
});
