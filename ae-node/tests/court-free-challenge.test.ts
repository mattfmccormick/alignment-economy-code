// A challenge must cost the challenger something.
//
// Found by running an audit agent's repro harness. The court stake is a
// percentage of the challenger's OWN earned balance, so a challenger holding
// zero staked zero — and the guard above it (`stakeAmount > earnedBalance`)
// passed, because 0 > 0 is false. Filing then escrowed the defendant anyway.
//
// That is a zero-cost griefing vector against any account: register as a miner
// (the first miner on a fresh network needs no percentHuman at all), hold
// nothing, and freeze anybody's earned balance for free. Escrow lifts only when
// the case resolves, so it is also repeatable and effectively a denial of
// service on someone else's money.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { fileChallenge } from '../src/court/court.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

describe('court: filing a challenge must cost the challenger', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('rejects a challenger with no earned balance, and leaves the defendant free', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));

    const broke = createAccount(db, 'individual', 1, 100);
    registerMiner(db, broke.account.id); // zero earned balance
    assert.equal(getAccount(db, broke.account.id)!.earnedBalance, 0n);

    assert.throws(
      () => fileChallenge(db, broke.account.id, defendant.account.id, 'not_human', 100),
      /rounds to zero|Insufficient/i,
    );

    // The part that actually mattered: the defendant's money must not be
    // frozen by a challenge that cost nothing to file.
    assert.equal(
      getAccount(db, defendant.account.id)!.isEscrowed,
      false,
      'a rejected challenge must not escrow the defendant',
    );
    db.close();
  });

  it('rejects a stake that rounds to zero on a tiny balance', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));

    // 1% of 50 base units truncates to 0 under integer division.
    const nearlyBroke = createAccount(db, 'individual', 1, 100);
    updateBalance(db, nearlyBroke.account.id, 'earned_balance', 50n);
    registerMiner(db, nearlyBroke.account.id);

    assert.throws(
      () => fileChallenge(db, nearlyBroke.account.id, defendant.account.id, 'not_human', 1),
      /rounds to zero/i,
    );
    assert.equal(getAccount(db, defendant.account.id)!.isEscrowed, false);
    db.close();
  });

  it('still allows a funded challenger, and escrows the defendant', () => {
    const defendant = createAccount(db, 'individual', 1, 100);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(50_000));

    const funded = createAccount(db, 'individual', 1, 100);
    updateBalance(db, funded.account.id, 'earned_balance', pts(10_000));
    registerMiner(db, funded.account.id);

    const c = fileChallenge(db, funded.account.id, defendant.account.id, 'not_human', 10);
    assert.ok(c.challengerStake > 0n, 'a real challenge locks real points');
    assert.equal(getAccount(db, defendant.account.id)!.isEscrowed, true);
    assert.equal(getAccount(db, funded.account.id)!.lockedBalance, c.challengerStake);
    db.close();
  });
});
