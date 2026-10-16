// Court hardening (October 2026 audit, updated for the October 16 rules).
//
// Each test is a way the court could be turned against an honest account, or
// made to break the node it runs on. All of them were possible with nothing
// more than ordinary API calls.
//
//   1. Jury packing. Any miner with ANY transaction to or from a party was
//      excluded from the jury, and a transfer needs no consent, so one base
//      unit sent to each honest juror removed them all.
//   2. One vote convicts. A verdict was a majority of votes CAST, with no
//      quorum, so a single juror out of eleven could close an account.
//   3. Stranded stakes. A juror whose case ended kept stake locked for good.
//      Under the October 16 rules no-shows forfeit instead, to the jurors who
//      did their job, but nothing is ever left locked.
//   4. Zombie cases. A dismissed case could still be escalated and voted on.
//   5. Wrong defendants. Companies could be convicted of "not human"; an
//      account under challenge could file its own challenge to move its
//      balance out of reach of the verdict.
//   6. Punishment before the appeal. A guilty verdict burned and paid out at
//      once, so winning the appeal left the victim at zero.
//   7. One bad case stops the day. A settlement that threw aborted the whole
//      daily cycle on that node, every day.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, getCase,
  expireCourtDeadlines, resolveCase, fileAppeal, courtStore, tallyVotes,
  withdrawChallenge,
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
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const LATER = NOW + 365 * DAY;
// Juror stake is 5% of 5,000 earned.
const JUROR_STAKE = pts(250);
// 10% of 10,000 is under the 1,440-point floor, so the floor is the stake.
const CHALLENGER_STAKE = pts(1_440);

interface MinerHandle { accountId: string; minerId: string }

function miner(db: DatabaseSync, earned: number): MinerHandle {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  return { accountId: r.account.id, minerId: m.id };
}

function minerPool(db: DatabaseSync, n: number): MinerHandle[] {
  const pool: MinerHandle[] = [];
  for (let i = 0; i < n; i++) pool.push(miner(db, 5_000));
  return pool;
}

function person(db: DatabaseSync, earned: number): string {
  const r = createAccount(db, 'individual', 1, 80);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  return r.account.id;
}

/** A row in `transactions`, as if `from` had paid `to`. Only the columns the jury filter reads matter. */
function recordTransfer(db: DatabaseSync, from: string, to: string, applied = 1): void {
  db.prepare(
    `INSERT INTO transactions (id, "from", "to", amount, fee, net_amount, point_type, is_in_person, memo, signature, timestamp, applied)
     VALUES (?, ?, ?, '1', '0', '1', 'earned', 0, '', ?, ?, ?)`,
  ).run(randomUUID(), from, to, randomUUID(), NOW, applied);
}

function seatedMinerIds(db: DatabaseSync, caseId: string): string[] {
  return courtStore(db).findJurorsByCase(caseId).map((j) => j.minerId);
}

function accountOfMiner(pool: MinerHandle[], minerId: string): string {
  return pool.find((m) => m.minerId === minerId)!.accountId;
}

describe('court hardening: the jury cannot be packed by a party', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('dust sent BY a party to every juror disqualifies nobody', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    // 21 eligible jurors seat a jury of 7; 20 would seat only 3. So a jury of 7
    // proves every one of them survived the conflict filter.
    const pool = minerPool(db, 21);

    // The attack: challenger and defendant each send something to every juror.
    for (const m of pool) {
      recordTransfer(db, challenger.accountId, m.accountId);
      recordTransfer(db, defendant, m.accountId);
    }

    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'packing');

    assert.equal(jurors.length, 7, 'the whole honest pool is still eligible');
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
  });

  it('a juror who PAID a party, vouched for one, or reviewed the defendant is excluded', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    const [paid, vouched, reviewed, pendingOnly, other1, other2] = minerPool(db, 6);

    recordTransfer(db, paid.accountId, defendant);
    // An unapplied (pending) transfer is not a relationship yet.
    recordTransfer(db, pendingOnly.accountId, defendant, 0);
    db.prepare(
      `INSERT INTO vouches (id, voucher_id, vouched_id, stake_amount, staked_percentage, is_active, created_at)
       VALUES (?, ?, ?, '1', 5, 1, ?)`,
    ).run(randomUUID(), vouched.accountId, defendant, NOW);
    const panelId = randomUUID();
    db.prepare(
      `INSERT INTO verification_panels (id, account_id, status, created_at) VALUES (?, ?, 'complete', ?)`,
    ).run(panelId, defendant, NOW);
    db.prepare(
      `INSERT INTO panel_reviews (id, panel_id, miner_id, score, evidence_hash_of_review, submitted_at)
       VALUES (?, ?, ?, 90, ?, ?)`,
    ).run(randomUUID(), panelId, reviewed.minerId, 'aa'.repeat(32), NOW);

    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = new Set(selectJury(db, c.id, 'conflicts'));

    // Six in the pool, three conflicted: the three left are exactly the jury.
    assert.deepEqual(
      [...jurors].sort(),
      [pendingOnly.minerId, other1.minerId, other2.minerId].sort(),
      'an unapplied transfer is not a conflict; paying, vouching and reviewing are',
    );
  });

  it('a case is seated once', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    minerPool(db, 26);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'first');

    assert.throws(() => selectJury(db, c.id, 'second'), /already has a jury/);
    assert.equal(seatedMinerIds(db, c.id).length, 7, 'no second batch was seated');
  });
});

describe('court hardening: a verdict needs a majority of the seats', () => {
  it('tallyVotes', () => {
    const j = (...v: Array<'human' | 'not_human' | null>) => v.map((vote) => ({ vote }));
    assert.equal(tallyVotes(j('not_human', null, null, null, null)).verdict, null, '1 of 5 decides nothing');
    assert.equal(tallyVotes(j('not_human', 'not_human', null, null, null)).verdict, null, '2 of 5 decides nothing');
    assert.equal(tallyVotes(j('not_human', 'not_human', 'not_human', null, null)).verdict, 'guilty');
    assert.equal(tallyVotes(j('human', 'human', 'human', null, null)).verdict, 'innocent');
    assert.equal(tallyVotes(j('human', 'human', 'not_human', 'not_human')).verdict, 'innocent', 'a tie goes to the defendant');
    assert.equal(tallyVotes([]).verdict, null);
  });

  it('a lone vote cannot be resolved into a verdict directly either', () => {
    const db = freshDb();
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    minerPool(db, 11);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'lone');
    submitVote(db, c.id, jurors[0], 'not_human');

    assert.throws(() => resolveCase(db, c.id), /No majority of the seated jury/);
    assert.equal(getAccount(db, defendant)!.isActive, true);
    assert.equal(getAccount(db, defendant)!.earnedBalance, pts(10_000));
  });
});

describe('court hardening: juror stakes are never stranded, and no-shows pay', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('jurors who matched the verdict are made whole and split what the no-shows forfeit', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    const pool = minerPool(db, 21);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'abstain');
    assert.equal(jurors.length, 7);

    // Four of seven vote (a majority of the seats). Three stay silent.
    const voters = jurors.slice(0, 4);
    const silent = jurors.slice(4);
    for (const j of voters) submitVote(db, c.id, j, 'human');

    const decided = expireCourtDeadlines(db, LATER);
    assert.deepEqual(decided.resolved, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'verdict_pending');
    for (const j of jurors) {
      assert.equal(getAccount(db, accountOfMiner(pool, j))!.lockedBalance, JUROR_STAKE, 'nothing moves before the appeal window closes');
    }

    const settled = expireCourtDeadlines(db, LATER + 8 * DAY);
    assert.deepEqual(settled.settled, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'court_verdict');

    const share = (JUROR_STAKE * 3n) / 4n;
    for (const j of voters) {
      const a = getAccount(db, accountOfMiner(pool, j))!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) + share, 'stake back plus a share of the no-shows');
    }
    for (const j of silent) {
      const a = getAccount(db, accountOfMiner(pool, j))!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) - JUROR_STAKE, 'a no-show forfeits the case stake');
    }
  });

  it('a dismissal returns the voters their stakes, paid for by the no-shows', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    const pool = minerPool(db, 11);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const [voter, ...silent] = selectJury(db, c.id, 'silent');
    submitVote(db, c.id, voter, 'human');

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.dismissed, [c.id], 'one vote of three is no majority');
    assert.equal(getCase(db, c.id)!.status, 'dismissed');
    const v = getAccount(db, accountOfMiner(pool, voter))!;
    assert.equal(v.lockedBalance, 0n);
    assert.equal(v.earnedBalance, pts(5_000) + JUROR_STAKE * BigInt(silent.length));
    for (const j of silent) {
      const a = getAccount(db, accountOfMiner(pool, j))!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) - JUROR_STAKE);
    }
    // A dismissal is no one's fault but the jury's: the parties are made whole.
    assert.equal(getAccount(db, challenger.accountId)!.earnedBalance, pts(10_000));
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n);
    assert.equal(getAccount(db, defendant)!.isEscrowed, false);
  });

  it('when nobody votes, every juror forfeits and nothing stays locked', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    const pool = minerPool(db, 11);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'nobody');

    assert.deepEqual(expireCourtDeadlines(db, LATER).dismissed, [c.id]);
    for (const j of jurors) {
      const a = getAccount(db, accountOfMiner(pool, j))!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000) - JUROR_STAKE);
    }
  });
});

describe('court hardening: a closed case stays closed', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a case dismissed for want of a jury cannot be escalated or seated again', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000); // the only miner, and a party

    // Arbitration closes: the case moves to court on its own, but nobody can sit.
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    const first = expireCourtDeadlines(db, LATER);
    assert.deepEqual(first.escalated, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');

    // Past the seat-by deadline: dismissed, stake refunded.
    assert.deepEqual(expireCourtDeadlines(db, LATER + 8 * DAY).dismissed, [c.id]);
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n);
    assert.equal(getAccount(db, challenger.accountId)!.earnedBalance, pts(10_000));

    assert.throws(() => escalateToFull(db, c.id), /Can only escalate from arbitration/);
    assert.throws(() => selectJury(db, c.id, 'zombie'), /already has a jury or a verdict/);
    assert.equal(getCase(db, c.id)!.status, 'dismissed');
  });

  it('a withdrawn case cannot be escalated or seated', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    minerPool(db, 11);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    withdrawChallenge(db, c.id, challenger.accountId);

    assert.throws(() => escalateToFull(db, c.id), /cannot be escalated/);
    assert.throws(() => selectJury(db, c.id, 'zombie'), /already has a jury or a verdict/);
    assert.deepEqual(expireCourtDeadlines(db, LATER).escalated, [], 'the sweep leaves it alone');
  });

  it('nobody can vote on a dismissed case, or after the deadline', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    minerPool(db, 11);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'late');

    assert.throws(() => submitVote(db, c.id, jurors[0], 'not_human', LATER), /deadline has passed/);

    expireCourtDeadlines(db, LATER); // no votes: dismissed
    for (const j of jurors) {
      assert.throws(() => submitVote(db, c.id, j, 'not_human'), /Voting is not open/);
    }
    assert.throws(() => resolveCase(db, c.id), /not in voting/);
    assert.equal(getAccount(db, defendant)!.isActive, true, 'a dismissed defendant cannot be convicted afterwards');
  });
});

describe('court hardening: who can file, and against whom', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a company account cannot be challenged as "not human"', () => {
    const company = createAccount(db, 'company', 1, 0).account.id;
    updateBalance(db, company, 'earned_balance', pts(1_000_000));
    const challenger = miner(db, 10_000);

    assert.throws(
      () => fileChallenge(db, challenger.accountId, company, 'not_human', 10),
      /Only individual accounts/,
    );
    assert.equal(getAccount(db, company)!.isEscrowed, false);
  });

  it('an account under challenge cannot file one of its own', () => {
    const defendant = miner(db, 10_000); // a miner, so otherwise allowed to file
    const challenger = miner(db, 10_000);
    const bystander = person(db, 500);
    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);

    // The dodge: lock 100% of earned as a challenge stake so a guilty verdict
    // finds nothing in earned to burn.
    assert.throws(
      () => fileChallenge(db, defendant.accountId, bystander, 'not_human', 100),
      /under challenge cannot file/,
    );
    assert.equal(getAccount(db, defendant.accountId)!.lockedBalance, 0n);
    assert.equal(getAccount(db, bystander)!.isEscrowed, false);
  });
});

describe('court hardening: nothing is taken before the appeal window closes', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  function decidedCase(firstVote: 'human' | 'not_human') {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    const pool = minerPool(db, 26); // a jury of 7, and 19 left for a second jury of 7
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const firstJury = selectJury(db, c.id, 'original');
    for (const j of firstJury) submitVote(db, c.id, j, firstVote);
    resolveCase(db, c.id);
    return { c, defendant, challenger, pool, firstJury };
  }

  /** File the appeal and let the next sweep draw its jury. */
  function appealWithJury(caseId: string) {
    const appeal = fileAppeal(db, caseId);
    assert.equal(getCase(db, appeal.id)!.status, 'appeal_open');
    assert.equal(seatedMinerIds(db, appeal.id).length, 0, 'filing an appeal does not draw its jury');
    assert.deepEqual(expireCourtDeadlines(db, NOW + 60).seated, [appeal.id]);
    return { appeal, appealJury: seatedMinerIds(db, appeal.id) };
  }

  it('a guilty verdict moves nothing until the window closes', () => {
    const { c, defendant, challenger } = decidedCase('not_human');

    assert.equal(getCase(db, c.id)!.status, 'verdict_pending');
    const d = getAccount(db, defendant)!;
    assert.equal(d.isActive, true);
    assert.equal(d.isEscrowed, true, 'still frozen');
    assert.equal(d.earnedBalance, pts(10_000), 'nothing burned yet');
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, CHALLENGER_STAKE, 'no bounty, no release yet');

    assert.deepEqual(expireCourtDeadlines(db, NOW + 6 * DAY).settled, [], 'still inside the window');
    assert.deepEqual(expireCourtDeadlines(db, NOW + 8 * DAY).settled, [c.id]);
    assert.equal(getAccount(db, defendant)!.isActive, false);
    assert.equal(getAccount(db, defendant)!.earnedBalance, 0n);
  });

  it('an appeal filed after the window is refused', () => {
    const { c } = decidedCase('not_human');
    // Age the verdict past the 7-day window.
    db.prepare('UPDATE court_cases SET resolved_at = ? WHERE id = ?').run(NOW - 8 * DAY, c.id);

    assert.throws(() => fileAppeal(db, c.id), /appeal window has closed/);
    assert.equal(courtStore(db).countAppealsOf(c.id), 0);
  });

  it('a settled verdict cannot be appealed', () => {
    const { c } = decidedCase('not_human');
    expireCourtDeadlines(db, NOW + 8 * DAY);
    assert.throws(() => fileAppeal(db, c.id), /final and settled/);
  });

  it('a guilty verdict overturned on appeal leaves the defendant exactly whole', () => {
    const { c, defendant, challenger, pool, firstJury } = decidedCase('not_human');
    const { appeal, appealJury } = appealWithJury(c.id);
    assert.equal(appealJury.length, 7, 'same size as the first jury');
    assert.equal(appealJury.some((m) => firstJury.includes(m)), false, 'nobody from the first jury');
    for (const j of appealJury) submitVote(db, appeal.id, j, 'human');

    assert.equal(resolveCase(db, appeal.id), 'innocent');

    const d = getAccount(db, defendant)!;
    assert.equal(d.isActive, true, 'never closed');
    assert.equal(d.isEscrowed, false);
    assert.equal(d.earnedBalance, pts(10_000) + CHALLENGER_STAKE / 2n, 'nothing lost, plus compensation for the freeze');
    const ch = getAccount(db, challenger.accountId)!;
    assert.equal(ch.lockedBalance, 0n);
    assert.equal(ch.earnedBalance, pts(10_000) - CHALLENGER_STAKE, 'the challenger, not the victim, pays');

    // Both juries are judged against the FINAL verdict.
    for (const j of firstJury) {
      assert.equal(getAccount(db, accountOfMiner(pool, j))!.earnedBalance, pts(5_000) - JUROR_STAKE);
    }
    for (const j of appealJury) {
      assert.equal(getAccount(db, accountOfMiner(pool, j))!.earnedBalance, pts(5_000) + JUROR_STAKE);
    }
    assert.equal(getCase(db, c.id)!.status, 'court_verdict');
    assert.equal(getCase(db, c.id)!.verdict, 'innocent', 'the case shows the final verdict, not the overturned one');
    assert.equal(getCase(db, appeal.id)!.status, 'appeal_verdict');
  });

  it('an innocent verdict overturned to guilty pays the challenger in full', () => {
    const { c, defendant, challenger } = decidedCase('human');
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, CHALLENGER_STAKE, 'the stake is still riding');
    assert.equal(getAccount(db, defendant)!.isEscrowed, true, 'still frozen through the window');

    const { appeal, appealJury } = appealWithJury(c.id);
    for (const j of appealJury) submitVote(db, appeal.id, j, 'not_human');

    assert.equal(resolveCase(db, appeal.id), 'guilty');
    assert.equal(getAccount(db, defendant)!.isActive, false);
    const ch = getAccount(db, challenger.accountId)!;
    assert.equal(ch.lockedBalance, 0n);
    assert.equal(ch.earnedBalance, pts(10_000) + pts(2_000), 'stake back plus 20% of 10,000');
  });

  it('an appeal that cannot seat a jury is dismissed, and the first verdict stands', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 10_000);
    minerPool(db, 3); // exactly one jury's worth
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'original')) submitVote(db, c.id, j, 'not_human');
    resolveCase(db, c.id);

    const appeal = fileAppeal(db, c.id);
    expireCourtDeadlines(db, NOW + 60);
    assert.equal(getCase(db, appeal.id)!.status, 'court_waiting_jury');
    // Something else the challenger has locked (a vouch, say). Settling must
    // release the case stake, not this.
    const before = getAccount(db, challenger.accountId)!;
    updateBalance(db, challenger.accountId, 'locked_balance', before.lockedBalance + pts(300));

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.dismissed, [appeal.id]);
    assert.equal(getCase(db, appeal.id)!.status, 'dismissed');
    assert.equal(getCase(db, c.id)!.status, 'court_verdict', 'the first verdict settles once the appeal is gone');
    assert.equal(getAccount(db, defendant)!.isActive, false, 'the original verdict stands');
    const after = getAccount(db, challenger.accountId)!;
    assert.equal(after.lockedBalance, pts(300), 'unrelated locks untouched');
    assert.equal(after.earnedBalance, pts(10_000) + pts(2_000), 'stake back plus the bounty');
  });
});

describe('court hardening: one bad case does not stop the sweep', () => {
  it('a case that throws is skipped and reported; the next case is still processed', () => {
    const db = freshDb();
    const challenger = miner(db, 10_000);
    const otherChallenger = miner(db, 10_000);
    minerPool(db, 26);

    // Case A: decided, then its row is corrupted so reading it throws.
    const defendantA = person(db, 10_000);
    const a = fileChallenge(db, challenger.accountId, defendantA, 'not_human', 10);
    escalateToFull(db, a.id);
    for (const j of selectJury(db, a.id, 'a')) submitVote(db, a.id, j, 'not_human');
    db.prepare("UPDATE court_cases SET challenger_stake = 'corrupt', created_at = created_at - 10 WHERE id = ?").run(a.id);

    // Case B: nothing wrong with it, filed later, still in arbitration.
    const defendantB = person(db, 10_000);
    const b = fileChallenge(db, otherChallenger.accountId, defendantB, 'not_human', 10);

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.failed, [a.id], 'the broken case is reported, not swallowed');
    assert.deepEqual(out.escalated, [b.id], 'and the case behind it was still handled');
    const rowA = db.prepare('SELECT verdict FROM court_cases WHERE id = ?').get(a.id) as { verdict: string | null };
    assert.equal(rowA.verdict, null, 'nothing was half-applied to the broken case');
    assert.equal(getAccount(db, defendantA)!.isActive, true);
  });
});
