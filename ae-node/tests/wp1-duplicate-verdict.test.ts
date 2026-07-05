// WP §9.3: duplicate-account guilty verdict.
//
// A duplicate_account challenge names a COUNTERPART — the earlier account the
// defendant duplicates. On a guilty verdict the defendant (the later duplicate)
// closes like any non-human account, AND the surviving counterpart disgorges a
// penalty of twice the harvested allocations (overlap days × 1,440), burned
// from its Earned balance. This suite pins that behaviour and the filing
// validation that makes it well-formed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { createGenesisBlock } from '../src/core/block.js';
import { registerMiner } from '../src/mining/registration.js';
import { fileChallenge, selectJury, submitVote, resolveVerdict } from '../src/court/court.js';
import { PRECISION, DAILY_ACTIVE_POINTS } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function setCurrentDay(db: DatabaseSync, day: number): void {
  db.prepare(
    `INSERT INTO day_cycle_state (id, current_day, cycle_phase, phase_started_at)
     VALUES (1, ?, 'idle', 0)
     ON CONFLICT(id) DO UPDATE SET current_day = excluded.current_day`,
  ).run(day);
}

// Seat `count` Tier-2 juror miners with spendable Earned. Returns their ids.
function seatJurors(db: DatabaseSync, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const acct = createAccount(db, 'individual', 1, 100);
    updateBalance(db, acct.account.id, 'earned_balance', pts(500));
    const miner = registerMiner(db, acct.account.id);
    db.prepare('UPDATE miners SET tier = 2 WHERE id = ?').run(miner.id);
    ids.push(acct.account.id);
  }
  return ids;
}

describe('WP §9.3: duplicate-account verdict', () => {
  it('closes the defendant and burns a 2x overlap penalty from the counterpart', () => {
    const db = freshDb();
    createGenesisBlock(db);
    setCurrentDay(db, 10);

    // Counterpart: the earlier, surviving account. Large balance so the penalty
    // does not cap.
    const counterpart = createAccount(db, 'individual', 1, 100);
    updateBalance(db, counterpart.account.id, 'earned_balance', pts(100_000));

    // Defendant: the later duplicate (joined day 5).
    const defendant = createAccount(db, 'individual', 5, 60);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(500));

    // Challenger is a miner.
    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(1000));
    registerMiner(db, challenger.account.id);

    seatJurors(db, 5);

    const courtCase = fileChallenge(
      db, challenger.account.id, defendant.account.id, 'duplicate_account', 5,
      'two accounts, same person', counterpart.account.id,
    );
    assert.equal(courtCase.counterpartId, counterpart.account.id);

    const jury = selectJury(db, courtCase.id, 'block-hash-dup');
    for (const minerId of jury) submitVote(db, courtCase.id, minerId, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    // Defendant closes and its Earned is zeroed (bounty + burn).
    assert.equal(getAccount(db, defendant.account.id)!.isActive, false);
    assert.equal(getAccount(db, defendant.account.id)!.earnedBalance, 0n);

    // Counterpart survives (still active) but pays 2 × overlap × 1,440.
    // overlap = currentDay(10) - defendant.joinedDay(5) = 5 days.
    const expectedPenalty = 2n * 5n * DAILY_ACTIVE_POINTS;
    const cp = getAccount(db, counterpart.account.id)!;
    assert.equal(cp.isActive, true);
    assert.equal(cp.earnedBalance, pts(100_000) - expectedPenalty);
  });

  it('caps the overlap penalty at the counterpart Earned balance', () => {
    const db = freshDb();
    createGenesisBlock(db);
    setCurrentDay(db, 10);

    // Counterpart holds less than the raw penalty (2×5×1,440 = 14,400).
    const counterpart = createAccount(db, 'individual', 1, 100);
    updateBalance(db, counterpart.account.id, 'earned_balance', pts(1000));

    const defendant = createAccount(db, 'individual', 5, 60);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(500));

    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(1000));
    registerMiner(db, challenger.account.id);
    seatJurors(db, 5);

    const courtCase = fileChallenge(
      db, challenger.account.id, defendant.account.id, 'duplicate_account', 5,
      undefined, counterpart.account.id,
    );
    const jury = selectJury(db, courtCase.id, 'block-hash-cap');
    for (const minerId of jury) submitVote(db, courtCase.id, minerId, 'not_human');
    resolveVerdict(db, courtCase.id);

    // Penalty capped: counterpart drained to zero, never negative.
    assert.equal(getAccount(db, counterpart.account.id)!.earnedBalance, 0n);
  });

  it('rejects a duplicate challenge with no counterpart named', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const defendant = createAccount(db, 'individual', 5, 60);
    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(1000));
    registerMiner(db, challenger.account.id);

    assert.throws(
      () => fileChallenge(db, challenger.account.id, defendant.account.id, 'duplicate_account', 5),
      /counterpart/i,
    );
  });

  it('rejects a counterpart that is not older than the defendant', () => {
    const db = freshDb();
    createGenesisBlock(db);
    // Counterpart joined the SAME day as the defendant — not strictly earlier.
    const counterpart = createAccount(db, 'individual', 5, 100);
    const defendant = createAccount(db, 'individual', 5, 60);
    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(1000));
    registerMiner(db, challenger.account.id);

    assert.throws(
      () => fileChallenge(
        db, challenger.account.id, defendant.account.id, 'duplicate_account', 5,
        undefined, counterpart.account.id,
      ),
      /joined before|COUNTERPART_NOT_OLDER/,
    );
  });
});
