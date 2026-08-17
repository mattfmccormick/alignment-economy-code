// An appeal must settle through the appeal path.
//
// The vote route called resolveVerdict for every case, so an appeal never ran
// its own settlement — resolveAppeal had ZERO production callers, verified by
// grep. A reversal therefore never reopened the defendant's account and never
// clawed back the bounty; it just ran the ordinary verdict settlement a second
// time on top of whatever the original case had already done.
//
// resolveCase now dispatches on level, so no call site has to remember.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote,
  resolveCase, fileAppeal, getCase,
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

describe('court: appeals settle through the appeal path', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a reversed guilty verdict reopens the defendant account', () => {
    const defendant = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 26; i++) miner(db, 2, 5_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'appeal-original');
    for (const j of jurors) submitVote(db, c.id, j, 'not_human');
    assert.equal(resolveCase(db, c.id), 'guilty');
    assert.equal(
      getAccount(db, defendant.account.id)!.isActive,
      false,
      'guilty closes the account',
    );

    // Defendant appeals and wins.
    const appeal = fileAppeal(db, c.id, defendant.account.id);
    const appealJurors = selectJury(db, appeal.id, 'appeal-second');
    assert.ok(appealJurors.length >= 3, 'appeal needs its own jury');
    for (const j of appealJurors) submitVote(db, appeal.id, j, 'human');

    const verdict = resolveCase(db, appeal.id);

    assert.equal(verdict, 'innocent');
    assert.equal(getCase(db, appeal.id)!.status, 'appeal_verdict');
    // The whole point of the appeal path: this is what resolveVerdict never did.
    assert.equal(
      getAccount(db, defendant.account.id)!.isActive,
      true,
      'a reversed guilty verdict must reopen the account',
    );
    assert.equal(getAccount(db, defendant.account.id)!.isEscrowed, false);
    db.close();
  });

  it('an appeal cannot be resolved twice', () => {
    const defendant = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(10_000));
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 26; i++) miner(db, 2, 5_000);

    const c = fileChallenge(db, challenger.accountId, defendant.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'appeal-idem-1');
    for (const j of jurors) submitVote(db, c.id, j, 'not_human');
    resolveCase(db, c.id);

    const appeal = fileAppeal(db, c.id, defendant.account.id);
    const appealJurors = selectJury(db, appeal.id, 'appeal-idem-2');
    for (const j of appealJurors) submitVote(db, appeal.id, j, 'human');
    resolveCase(db, appeal.id);

    const snapshot = getAccount(db, challenger.accountId)!.earnedBalance;
    assert.throws(() => resolveCase(db, appeal.id), /already resolved/i);
    assert.equal(
      getAccount(db, challenger.accountId)!.earnedBalance,
      snapshot,
      'a rejected re-resolve must not claw back the bounty a second time',
    );
    db.close();
  });
});
