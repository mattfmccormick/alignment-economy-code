// Court hardening (October 2026 audit).
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
//   3. Stranded stakes. A juror who did not vote, or whose case was dismissed,
//      never got their stake back.
//   4. Zombie cases. A dismissed case could still be escalated and voted on.
//   5. Wrong defendants. Companies could be convicted of "not human"; an
//      account under challenge could file its own challenge to move its
//      balance out of reach of the verdict.
//   6. A bystander pays. A duplicate-account verdict burned the savings of
//      whoever the challenger named as the counterpart.
//   7. Appeals with no window and no way to settle a reversal.
//   8. One bad case stops the day. A settlement that threw aborted the whole
//      daily cycle on that node, every day.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, getCase,
  expireCourtDeadlines, resolveCase, fileAppeal, courtStore, tallyVotes,
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
const LATER = NOW + 365 * 86400;

interface MinerHandle { accountId: string; minerId: string }

function miner(db: DatabaseSync, tier: 1 | 2, earned: number): MinerHandle {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
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

describe('court hardening: the jury cannot be packed by a party', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('dust sent BY a party to every juror disqualifies nobody', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    const pool: MinerHandle[] = [];
    for (let i = 0; i < 11; i++) pool.push(miner(db, 2, 5_000));

    // The attack: challenger and defendant each send something to every juror.
    for (const m of pool) {
      recordTransfer(db, challenger.accountId, m.accountId);
      recordTransfer(db, defendant, m.accountId);
    }

    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'packing');

    assert.equal(jurors.length, 11, 'the whole honest pool is still eligible');
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
  });

  it('a juror who PAID a party, vouched for one, or reviewed the defendant is excluded', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    const pool: MinerHandle[] = [];
    for (let i = 0; i < 14; i++) pool.push(miner(db, 2, 5_000));
    const [paid, vouched, reviewed, pendingOnly] = pool;

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

    assert.equal(jurors.size, 11);
    assert.equal(jurors.has(paid.minerId), false, 'paid the defendant');
    assert.equal(jurors.has(vouched.minerId), false, 'has stake riding on the defendant');
    assert.equal(jurors.has(reviewed.minerId), false, 'own accuracy record rides on the verdict');
    // 14 in the pool, 3 conflicted, 11 seats: the pending-only miner must be among them.
    assert.equal(jurors.has(pendingOnly.minerId), true, 'an unapplied transfer is not a conflict');
  });

  it('a case is seated once', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 26; i++) miner(db, 2, 5_000);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'first');

    assert.throws(() => selectJury(db, c.id, 'second'), /already has a jury/);
    assert.equal(seatedMinerIds(db, c.id).length, 11, 'no second batch was seated');
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
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 11; i++) miner(db, 2, 5_000);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'lone');
    submitVote(db, c.id, jurors[0], 'not_human');

    assert.throws(() => resolveCase(db, c.id), /No majority of the seated jury/);
    assert.equal(getAccount(db, defendant)!.isActive, true);
    assert.equal(getAccount(db, defendant)!.earnedBalance, pts(10_000));
  });
});

describe('court hardening: juror stakes always come back or are burned, never stranded', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  function lockedTotal(ids: string[]): bigint {
    return ids.reduce((sum, id) => sum + getAccount(db, id)!.lockedBalance, 0n);
  }

  it('jurors who did not vote get their stake back when the verdict lands', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    const pool: MinerHandle[] = [];
    for (let i = 0; i < 11; i++) pool.push(miner(db, 2, 5_000));
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'abstain');
    assert.ok(lockedTotal(pool.map((m) => m.accountId)) > 0n, 'stakes are locked while the case is open');

    // Six of eleven vote (a majority of the seats). Five stay silent.
    for (const j of jurors.slice(0, 6)) submitVote(db, c.id, j, 'human');
    expireCourtDeadlines(db, LATER);

    assert.equal(getCase(db, c.id)!.verdict, 'innocent');
    for (const m of pool) {
      const a = getAccount(db, m.accountId)!;
      assert.equal(a.lockedBalance, 0n, 'nothing left locked');
      assert.equal(a.earnedBalance, pts(5_000), 'majority and silent jurors are both made whole');
    }
  });

  it('every juror is released when a case is dismissed', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    const pool: MinerHandle[] = [];
    for (let i = 0; i < 11; i++) pool.push(miner(db, 2, 5_000));
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    selectJury(db, c.id, 'silent');

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.dismissed, [c.id]);
    for (const m of pool) {
      const a = getAccount(db, m.accountId)!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, pts(5_000));
    }
  });
});

describe('court hardening: a closed case stays closed', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a dismissed case cannot be escalated', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 11; i++) miner(db, 2, 5_000);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);

    // Never escalated: dismissed at the arbitration deadline, stake refunded.
    assert.deepEqual(expireCourtDeadlines(db, LATER).dismissed, [c.id]);
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n);

    assert.throws(() => escalateToFull(db, c.id), /cannot be escalated/);
    assert.throws(() => selectJury(db, c.id, 'zombie'), /already has a jury or a verdict/);
    assert.equal(getCase(db, c.id)!.status, 'withdrawn');
  });

  it('nobody can vote on a dismissed case, or after the deadline', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 11; i++) miner(db, 2, 5_000);
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
    const challenger = miner(db, 1, 10_000);

    assert.throws(
      () => fileChallenge(db, challenger.accountId, company, 'not_human', 10),
      /Only individual accounts/,
    );
    assert.equal(getAccount(db, company)!.isEscrowed, false);
  });

  it('an account under challenge cannot file one of its own', () => {
    const defendant = miner(db, 1, 10_000); // a miner, so otherwise allowed to file
    const challenger = miner(db, 1, 10_000);
    const bystander = person(db, 500);
    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);

    // The dodge: lock 100% of earned as a challenge stake so a guilty verdict,
    // which burns earned only, finds nothing to burn.
    assert.throws(
      () => fileChallenge(db, defendant.accountId, bystander, 'not_human', 100),
      /under challenge cannot file/,
    );
    assert.equal(getAccount(db, defendant.accountId)!.lockedBalance, 0n);
    assert.equal(getAccount(db, bystander)!.isEscrowed, false);
  });
});

describe('court hardening: appeals', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  function decidedCase(firstVote: 'human' | 'not_human') {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    for (let i = 0; i < 26; i++) miner(db, 2, 5_000);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'original')) submitVote(db, c.id, j, firstVote);
    resolveCase(db, c.id);
    return { c, defendant, challenger };
  }

  it('an appeal filed after the window is refused', () => {
    const { c } = decidedCase('not_human');
    // Age the verdict past the 7-day window.
    db.prepare('UPDATE court_cases SET resolved_at = ? WHERE id = ?').run(NOW - 8 * 86400, c.id);

    assert.throws(() => fileAppeal(db, c.id, 'late'), /appeal window has closed/);
    assert.equal(courtStore(db).countAppealsOf(c.id), 0);
  });

  it('an innocent verdict reversed to guilty on appeal settles instead of throwing', () => {
    const { c, defendant, challenger } = decidedCase('human');
    assert.equal(getCase(db, c.id)!.verdict, 'innocent');
    // The innocent verdict consumed the challenger's stake.
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n);

    const appeal = fileAppeal(db, c.id, 'appeal');
    for (const j of seatedMinerIds(db, appeal.id)) submitVote(db, appeal.id, j, 'not_human');

    assert.equal(resolveCase(db, appeal.id), 'guilty');
    assert.equal(getAccount(db, defendant)!.isActive, false);
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n, 'no phantom stake released, nothing negative');
  });

  it('an appeal that cannot seat a jury is swept, and takes nothing from the challenger', () => {
    const defendant = person(db, 10_000);
    const challenger = miner(db, 1, 10_000);
    // Exactly enough tier-2 miners for the first jury and none left for a second.
    for (let i = 0; i < 11; i++) miner(db, 2, 5_000);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'original')) submitVote(db, c.id, j, 'not_human');
    resolveCase(db, c.id);

    const appeal = fileAppeal(db, c.id, 'starved');
    assert.equal(getCase(db, appeal.id)!.status, 'court_waiting_jury');
    // Something else the challenger has locked (a vouch, say). The old dismissal
    // "returned" the appeal's copied stake figure out of exactly this.
    const before = getAccount(db, challenger.accountId)!;
    updateBalance(db, challenger.accountId, 'locked_balance', before.lockedBalance + pts(300));
    const withOtherLock = getAccount(db, challenger.accountId)!;

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.dismissed, [appeal.id]);
    assert.equal(getCase(db, appeal.id)!.status, 'withdrawn');
    const after = getAccount(db, challenger.accountId)!;
    assert.equal(after.lockedBalance, withOtherLock.lockedBalance, 'unrelated locks untouched');
    assert.equal(after.earnedBalance, withOtherLock.earnedBalance);
    assert.equal(getAccount(db, defendant)!.isActive, false, 'the original verdict stands');
  });
});

describe('court hardening: one bad case does not stop the sweep', () => {
  it('a settlement that throws is skipped and reported; the next case is still processed', () => {
    const db = freshDb();
    const challenger = miner(db, 1, 10_000);
    const otherChallenger = miner(db, 1, 10_000);
    for (let i = 0; i < 26; i++) miner(db, 2, 5_000);

    // Case A: will reach a guilty majority, then fail to settle.
    const defendantA = person(db, 10_000);
    const a = fileChallenge(db, challenger.accountId, defendantA, 'not_human', 10);
    escalateToFull(db, a.id);
    for (const j of selectJury(db, a.id, 'a')) submitVote(db, a.id, j, 'not_human');
    // Break A's accounting the way a rebase or a second lock once could: the
    // stake the verdict must release is no longer there.
    updateBalance(db, challenger.accountId, 'locked_balance', 0n);

    // Case B: nothing wrong with it, filed later, simply never escalated.
    const defendantB = person(db, 10_000);
    db.prepare('UPDATE court_cases SET created_at = created_at - 10 WHERE id = ?').run(a.id);
    const b = fileChallenge(db, otherChallenger.accountId, defendantB, 'not_human', 10);

    const out = expireCourtDeadlines(db, LATER);

    assert.deepEqual(out.failed, [a.id], 'the broken case is reported, not swallowed');
    assert.deepEqual(out.dismissed, [b.id], 'and the case behind it was still handled');
    assert.equal(getCase(db, a.id)!.verdict, null, 'the failed settlement rolled back whole');
    assert.equal(getAccount(db, defendantA)!.isActive, true);
    assert.equal(getAccount(db, defendantB)!.isEscrowed, false);
  });
});
