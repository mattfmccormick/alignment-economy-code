// Vouch-then-withdraw must not be a free way to zero someone's score.
//
// This pins an attack that was live in the codebase for part of a day, created
// by an earlier attempt at WP §7.2 ("vouchers may withdraw at any time, but
// doing so immediately reduces the vouched account's percent-human score").
//
// The asymmetry is the bug: createVouch never raises percentHuman — only a
// completed panel writes it — and vouching requires no consent from the
// account being vouched for. So an unconditional subtraction on withdrawal is
// pure downward pressure at zero cost. An attacker with any balance could take
// a victim 100 -> 75 -> 50 -> 25 -> 0 in four round trips, getting the full
// stake back each time. At 0 the victim burns 100% of every daily-point spend.
//
// The rule now: a withdrawal only reduces the score if the vouch already
// existed when the panel that set that score completed, i.e. it could actually
// have counted toward it.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance, updatePercentHuman } from '../src/core/account.js';
import { createVouch, withdrawVouch } from '../src/verification/vouching.js';
import { verificationStore } from '../src/verification/panel.js';
import { PRECISION } from '../src/core/constants.js';
import { randomUUID } from 'node:crypto';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

function account(db: DatabaseSync, earned: number, percentHuman = 0) {
  const r = createAccount(db, 'individual', 1, percentHuman);
  if (earned > 0) updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  return r.account.id;
}

/** Give an account a completed panel at `completedAt`, as verification would. */
function completedPanelAt(db: DatabaseSync, accountId: string, completedAt: number, score: number) {
  const verif = verificationStore(db);
  const id = randomUUID();
  verif.insertPanel({ id, accountId, status: 'pending', createdAt: completedAt - 1 });
  verif.completePanel(id, completedAt, score);
  return id;
}

describe('vouching: withdrawal cannot be weaponised', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a stranger cannot drain a verified account by vouching then withdrawing', () => {
    const victim = account(db, 0, 100);
    completedPanelAt(db, victim, 1_000, 100); // score set BEFORE any attack vouch
    const attacker = account(db, 10_000);

    const attackerStart = getAccount(db, attacker)!.earnedBalance;

    // Four rounds of the original attack.
    for (let i = 0; i < 4; i++) {
      const v = createVouch(db, attacker, victim, 25);
      withdrawVouch(db, v.id);
    }

    assert.equal(
      getAccount(db, victim)!.percentHuman,
      100,
      'a vouch created after the panel never counted, so pulling it must cost the victim nothing',
    );
    assert.equal(
      getAccount(db, attacker)!.earnedBalance,
      attackerStart,
      'and the attacker gets their stake back either way — which is exactly why it must not work',
    );
    db.close();
  });

  it('a voucher whose stake predates the panel still costs the account on withdrawal', () => {
    const holder = account(db, 0, 60);
    const voucher = account(db, 10_000);

    // Vouch first, panel afterwards: the miners could see this backing.
    const v = createVouch(db, voucher, holder, 10);
    const created = getAccount(db, holder)!;
    assert.equal(created.percentHuman, 60);
    completedPanelAt(db, holder, Math.floor(Date.now() / 1000) + 60, 60);

    withdrawVouch(db, v.id);

    assert.equal(
      getAccount(db, holder)!.percentHuman,
      50,
      'WP §7.2: pulling backing that counted must reduce the score',
    );
    db.close();
  });

  it('an account with no completed panel is never reduced', () => {
    const holder = account(db, 0, 40); // e.g. dev-seeded, not panel-set
    const voucher = account(db, 10_000);

    const v = createVouch(db, voucher, holder, 25);
    withdrawVouch(db, v.id);

    assert.equal(
      getAccount(db, holder)!.percentHuman,
      40,
      'nothing here earned the score, so nothing here can take it away',
    );
    db.close();
  });

  it('the stake still comes back to the voucher in every case', () => {
    const holder = account(db, 0, 100);
    const voucher = account(db, 10_000);
    const before = getAccount(db, voucher)!.earnedBalance;

    const v = createVouch(db, voucher, holder, 20);
    assert.ok(getAccount(db, voucher)!.lockedBalance > 0n);
    withdrawVouch(db, v.id);

    const after = getAccount(db, voucher)!;
    assert.equal(after.lockedBalance, 0n);
    assert.equal(after.earnedBalance, before);
    db.close();
  });
});
