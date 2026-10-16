// WP §9.3: duplicate-account guilty verdict.
//
// A duplicate_account challenge names a COUNTERPART — the earlier account the
// defendant duplicates. On a final guilty verdict the defendant (the later
// duplicate) closes like any non-human account. The white paper's counterpart
// penalty (twice the overlap allocations) is withheld while the counterpart is
// not a real party to the case, so the counterpart is left untouched. This
// suite pins that behaviour and the filing validation that makes it well-formed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { createGenesisBlock } from '../src/core/block.js';
import { registerMiner } from '../src/mining/registration.js';
import {
  fileChallenge,
  escalateToFull,
  selectJury,
  submitVote,
  resolveVerdict,
  expireCourtDeadlines,
} from '../src/court/court.js';
import { PRECISION } from '../src/core/constants.js';

/** Day-cycle sweep after the 7-day appeal window: when a verdict settles. */
function settleAfterAppealWindow(db: DatabaseSync, caseId: string): void {
  const sweep = expireCourtDeadlines(db, Math.floor(Date.now() / 1000) + 8 * 86400);
  assert.deepEqual(sweep.settled, [caseId]);
}

// 40,000 earned so a 5% filing stake clears the 1,440-point floor
const CHALLENGER_EARNED = 40_000;

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

// Seat `count` juror miners (percentHuman 100) with spendable Earned. Returns their account ids.
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
  it('closes the defendant and does NOT debit the counterpart, who was never a party', () => {
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
    updateBalance(db, challenger.account.id, 'earned_balance', pts(CHALLENGER_EARNED));
    registerMiner(db, challenger.account.id);

    seatJurors(db, 5);

    const courtCase = fileChallenge(
      db, challenger.account.id, defendant.account.id, 'duplicate_account', 5,
      'two accounts, same person', counterpart.account.id,
    );
    assert.equal(courtCase.counterpartId, counterpart.account.id);

    escalateToFull(db, courtCase.id);
    const jury = selectJury(db, courtCase.id, 'block-hash-dup');
    assert.equal(jury.length, 3);
    for (const minerId of jury) submitVote(db, courtCase.id, minerId, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    // Nothing settles until the appeal window closes
    assert.equal(getAccount(db, defendant.account.id)!.isActive, true);
    settleAfterAppealWindow(db, courtCase.id);

    // Defendant closes and its Earned is zeroed (bounty + burn).
    assert.equal(getAccount(db, defendant.account.id)!.isActive, false);
    assert.equal(getAccount(db, defendant.account.id)!.earnedBalance, 0n);

    // The counterpart is whoever the challenger named. It was never served,
    // could not respond and could not appeal, and the jury was only asked
    // about the defendant. The white paper's 2 × overlap penalty is withheld
    // until a counterpart is a real party: with it, a truthful conviction of
    // a throwaway account burned any stranger's savings.
    const cp = getAccount(db, counterpart.account.id)!;
    assert.equal(cp.isActive, true);
    assert.equal(cp.earnedBalance, pts(100_000), 'not one point taken from a non-party');
  });

  it('leaves a small counterpart balance alone too', () => {
    const db = freshDb();
    createGenesisBlock(db);
    setCurrentDay(db, 10);

    // Counterpart holds less than the old raw penalty (2×5×1,440 = 14,400),
    // which used to drain it to zero.
    const counterpart = createAccount(db, 'individual', 1, 100);
    updateBalance(db, counterpart.account.id, 'earned_balance', pts(1000));

    const defendant = createAccount(db, 'individual', 5, 60);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(500));

    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(CHALLENGER_EARNED));
    registerMiner(db, challenger.account.id);
    seatJurors(db, 5);

    const courtCase = fileChallenge(
      db, challenger.account.id, defendant.account.id, 'duplicate_account', 5,
      undefined, counterpart.account.id,
    );
    escalateToFull(db, courtCase.id);
    const jury = selectJury(db, courtCase.id, 'block-hash-cap');
    assert.equal(jury.length, 3);
    for (const minerId of jury) submitVote(db, courtCase.id, minerId, 'not_human');
    assert.equal(resolveVerdict(db, courtCase.id), 'guilty');
    settleAfterAppealWindow(db, courtCase.id);

    assert.equal(getAccount(db, defendant.account.id)!.isActive, false, 'the verdict did settle');
    assert.equal(getAccount(db, counterpart.account.id)!.earnedBalance, pts(1000));
  });

  it('rejects a duplicate challenge with no counterpart named', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const defendant = createAccount(db, 'individual', 5, 60);
    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(CHALLENGER_EARNED));
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
    updateBalance(db, challenger.account.id, 'earned_balance', pts(CHALLENGER_EARNED));
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
