import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance, updatePercentHuman } from '../src/core/account.js';
import { PRECISION } from '../src/core/constants.js';
import { registerMiner, getMiner, setMinerTier } from '../src/mining/registration.js';
import { evaluateMinerTier } from '../src/mining/tiers.js';
import { getJuryAttendanceRate } from '../src/mining/accuracy.js';
import {
  fileChallenge,
  escalateToFull,
  selectJury,
  submitVote,
  resolveVerdict,
  getCase,
  isInProtectionWindow,
  fileAppeal,
  resolveAppeal,
  applyAccuracyImpact,
  recordJuryService,
  expireCourtDeadlines,
} from '../src/court/court.js';
import { createVouch } from '../src/verification/vouching.js';
import type { Vote } from '../src/court/types.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  // day_cycle_state is already initialized by initializeSchema/seedParams
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function createMinerAccount(db: DatabaseSync, tier: 1 | 2 = 1, earnedPts: number = 10000): {
  accountId: string;
  minerId: string;
} {
  const result = createAccount(db, 'individual', 1, 100);
  updateBalance(db, result.account.id, 'earned_balance', pts(earnedPts));
  const miner = registerMiner(db, result.account.id);
  if (tier === 2) {
    setMinerTier(db, miner.id, 2, 'test setup');
  }
  return { accountId: result.account.id, minerId: miner.id };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Run the day-cycle court sweep after the 7-day appeal window has closed.
 * A verdict only records itself; this sweep is when it settles.
 */
function settleAfterAppealWindow(db: DatabaseSync) {
  return expireCourtDeadlines(db, nowSec() + 8 * 86400);
}

function setupCourtScenario(db: DatabaseSync, juryCount: number = 13) {
  // Defendant with 10000 earned
  const defResult = createAccount(db, 'individual', 1, 80);
  updateBalance(db, defResult.account.id, 'earned_balance', pts(10000));

  // Challenger miner. 40,000 earned so a 5% stake (2,000) clears the
  // 1,440-point filing floor and the chosen percentage decides the stake.
  const challenger = createMinerAccount(db, 1, 40000);

  // Miners for the jury pool. Any active miner at percentHuman >= 90 may sit:
  // 13 eligible seats a jury of 3, 21..32 eligible seats 7.
  const juryMiners: Array<{ accountId: string; minerId: string }> = [];
  for (let i = 0; i < juryCount; i++) {
    juryMiners.push(createMinerAccount(db, 2, 5000));
  }

  return { defendantId: defResult.account.id, challenger, juryMiners };
}

describe('Phase 5: Court and Enforcement System', () => {

  // Test 1: Full flow - Guilty
  it('full guilty flow: file, escalate, jury, vote, bounty, burn', () => {
    const db = freshDb();
    const { defendantId, challenger, juryMiners } = setupCourtScenario(db);

    // Add a vouch on defendant to test burn
    const voucherResult = createAccount(db, 'individual', 1, 100);
    updateBalance(db, voucherResult.account.id, 'earned_balance', pts(5000));
    const vouch = createVouch(db, voucherResult.account.id, defendantId, 10);

    const challengerBefore = getAccount(db, challenger.accountId)!;

    // File challenge, stake 5%
    const courtCase = fileChallenge(db, challenger.accountId, defendantId, 'not_human', 5);
    assert.equal(courtCase.status, 'arbitration_open');
    assert.equal(courtCase.level, 'arbitration');
    const stakeExpected = (challengerBefore.earnedBalance * 500n) / 10000n;
    assert.equal(courtCase.challengerStake, stakeExpected);

    // Challenger's earned balance reduced, locked increased
    const challengerAfterFile = getAccount(db, challenger.accountId)!;
    assert.equal(challengerAfterFile.earnedBalance, challengerBefore.earnedBalance - stakeExpected);
    assert.equal(challengerAfterFile.lockedBalance, challengerBefore.lockedBalance + stakeExpected);

    // Escalate
    const escalated = escalateToFull(db, courtCase.id);
    assert.equal(escalated.level, 'court');
    assert.equal(escalated.status, 'court_open');

    // Select jury: 13 eligible miners seat a jury of 3
    const jurorIds = selectJury(db, courtCase.id, 'blockhash123');
    assert.equal(jurorIds.length, 3, `13 eligible miners should seat 3 jurors, got ${jurorIds.length}`);

    // Vote: bare majority not_human (guilty), one juror in the minority
    const guiltyCount = Math.floor(jurorIds.length / 2) + 1;
    for (let i = 0; i < jurorIds.length; i++) {
      const vote: Vote = i < guiltyCount ? 'not_human' : 'human';
      submitVote(db, courtCase.id, jurorIds[i], vote);
    }

    // Resolve
    const defendant = getAccount(db, defendantId)!;
    const bountyExpected = (defendant.earnedBalance * 20n) / 100n;

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    // Deferred settlement: the verdict is recorded, nothing moves until the
    // appeal window closes.
    const pending = getCase(db, courtCase.id)!;
    assert.equal(pending.status, 'verdict_pending');
    const defPending = getAccount(db, defendantId)!;
    assert.equal(defPending.isActive, true, 'defendant stays open during the appeal window');
    assert.equal(defPending.isEscrowed, true, 'escrow stays on during the appeal window');
    assert.equal(defPending.earnedBalance, pts(10000), 'nothing burned before the verdict is final');
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, stakeExpected, 'challenger stake still locked');
    assert.equal(getAccount(db, voucherResult.account.id)!.lockedBalance, vouch.stakeAmount, 'voucher stake still locked');

    const sweep = settleAfterAppealWindow(db);
    assert.deepEqual(sweep.settled, [courtCase.id]);

    // Verify defendant closed
    const defAfter = getAccount(db, defendantId)!;
    assert.equal(defAfter.isActive, false);
    assert.equal(defAfter.earnedBalance, 0n);

    // Challenger got the bounty (20% of the defendant's earned) and the stake back
    const challengerFinal = getAccount(db, challenger.accountId)!;
    assert.equal(challengerFinal.earnedBalance, challengerBefore.earnedBalance + bountyExpected);
    assert.equal(challengerFinal.lockedBalance, 0n);

    // Juror stake is 5% of 5,000 = 250. The one minority stake is split
    // between the two majority jurors (125 each).
    const jurorStake = pts(250);
    for (let i = 0; i < guiltyCount; i++) {
      const miner = getMiner(db, jurorIds[i])!;
      const acct = getAccount(db, miner.accountId)!;
      assert.equal(acct.lockedBalance, 0n, `Majority juror ${i} locked should be 0`);
      assert.equal(acct.earnedBalance, pts(5000) + jurorStake / BigInt(guiltyCount), `Majority juror ${i} gets stake back plus a share`);
    }

    // Minority juror forfeits the stake
    for (let i = guiltyCount; i < jurorIds.length; i++) {
      const miner = getMiner(db, jurorIds[i])!;
      const acct = getAccount(db, miner.accountId)!;
      assert.equal(acct.lockedBalance, 0n, `Minority juror ${i} locked should be 0`);
      assert.equal(acct.earnedBalance, pts(5000) - jurorStake, `Minority juror ${i} should have lost stake`);
    }

    // Verify voucher's stake burned (10% of 5,000)
    const voucherAfter = getAccount(db, voucherResult.account.id)!;
    assert.equal(voucherAfter.lockedBalance, 0n, 'Voucher locked should be 0 (burned)');
    assert.equal(voucherAfter.earnedBalance, pts(5000) - vouch.stakeAmount, 'Voucher should have lost stake');

    // Verify case status
    const finalCase = getCase(db, courtCase.id)!;
    assert.equal(finalCase.verdict, 'guilty');
    assert.equal(finalCase.status, 'court_verdict');

    db.close();
  });

  // Test 2: Full flow - Innocent
  it('full innocent flow: challenger stake burned, protection window set', () => {
    const db = freshDb();
    const { defendantId, challenger, juryMiners } = setupCourtScenario(db);

    const challengerBefore = getAccount(db, challenger.accountId)!;

    // File and escalate
    const courtCase = fileChallenge(db, challenger.accountId, defendantId, 'not_human', 10);
    escalateToFull(db, courtCase.id);

    const jurorIds = selectJury(db, courtCase.id, 'blockhash456');
    assert.equal(jurorIds.length, 3);

    // Vote: majority human (innocent), one juror in the minority
    const innocentCount = Math.floor(jurorIds.length / 2) + 1;
    for (let i = 0; i < jurorIds.length; i++) {
      const vote: Vote = i < innocentCount ? 'human' : 'not_human';
      submitVote(db, courtCase.id, jurorIds[i], vote);
    }

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'innocent');

    // Deferred settlement: escrow and the challenger's stake stay put until
    // the appeal window closes.
    assert.equal(getCase(db, courtCase.id)!.status, 'verdict_pending');
    assert.equal(getAccount(db, defendantId)!.isEscrowed, true, 'escrow stays on during the appeal window');
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, courtCase.challengerStake);
    assert.equal(isInProtectionWindow(db, defendantId), false, 'no protection window until the verdict is final');

    settleAfterAppealWindow(db);
    assert.equal(getCase(db, courtCase.id)!.status, 'court_verdict');

    // Defendant still active, escrow lifted, and compensated with half the
    // forfeited stake (10% of 40,000 = 4,000 -> 2,000)
    const defAfter = getAccount(db, defendantId)!;
    assert.equal(defAfter.isActive, true);
    assert.equal(defAfter.isEscrowed, false);
    assert.equal(courtCase.challengerStake, pts(4000));
    assert.equal(defAfter.earnedBalance, pts(10000) + courtCase.challengerStake / 2n);

    // Challenger stake forfeited (locked cleared, NOT returned to earned)
    const challengerAfter = getAccount(db, challenger.accountId)!;
    assert.equal(challengerAfter.lockedBalance, 0n, 'Challenger locked should be 0 (forfeited)');
    assert.equal(challengerAfter.earnedBalance, challengerBefore.earnedBalance - courtCase.challengerStake, 'Challenger lost stake permanently');

    // Protection window set (180 days)
    assert.ok(isInProtectionWindow(db, defendantId), 'Defendant should be in protection window');
    const defWithWindow = getAccount(db, defendantId)!;
    assert.equal(defWithWindow.protectionWindowEnd, 1 + 180); // current_day(1) + 180

    db.close();
  });

  // Test 3: Appeal reversal (guilty → innocent on appeal)
  it('appeal reversal: guilty overturned leaves the defendant exactly whole, no bounty ever paid', () => {
    const db = freshDb();
    // 25 eligible miners: the first jury is 7, the appeal jury is 7 more
    // drawn from the 18 who did not sit (no overlap)
    const { defendantId, challenger, juryMiners } = setupCourtScenario(db, 25);
    const challengerBefore = getAccount(db, challenger.accountId)!;

    // File, escalate, select jury
    const courtCase = fileChallenge(db, challenger.accountId, defendantId, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds1 = selectJury(db, courtCase.id, 'blockhash_orig');
    assert.equal(jurorIds1.length, 7, '21..32 eligible miners seat 7 jurors');

    // Vote guilty
    for (const jid of jurorIds1) {
      submitVote(db, courtCase.id, jid, 'not_human');
    }
    const verdict1 = resolveVerdict(db, courtCase.id);
    assert.equal(verdict1, 'guilty');

    // Nothing irreversible before the final verdict: the defendant is still
    // open, still frozen, and still holds every point.
    const defPending = getAccount(db, defendantId)!;
    assert.equal(defPending.isActive, true, 'Defendant is not closed while the verdict can be appealed');
    assert.equal(defPending.isEscrowed, true);
    assert.equal(defPending.earnedBalance, pts(10000));

    // File appeal: no jury yet, it is drawn at the next sweep
    const appealCase = fileAppeal(db, courtCase.id);
    assert.equal(appealCase.level, 'appeal');
    assert.equal(appealCase.appealOf, courtCase.id);
    assert.equal(appealCase.status, 'appeal_open');
    const countAppealJurors = () =>
      (db.prepare('SELECT COUNT(*) AS cnt FROM court_jury WHERE case_id = ?').get(appealCase.id) as { cnt: number }).cnt;
    assert.equal(Number(countAppealJurors()), 0, 'filing an appeal does not seat a jury');

    const sweep = expireCourtDeadlines(db, nowSec() + 60);
    assert.deepEqual(sweep.seated, [appealCase.id]);
    assert.deepEqual(sweep.settled, [], 'the original case waits for its appeal');

    // Get appeal jurors: same size as the first jury
    const appealJurors = db.prepare('SELECT miner_id FROM court_jury WHERE case_id = ?').all(appealCase.id) as Array<{ miner_id: string }>;
    assert.equal(appealJurors.length, jurorIds1.length, 'appeal jury is the same size as the original');

    // Verify no overlap with original jurors
    const originalSet = new Set(jurorIds1);
    for (const aj of appealJurors) {
      assert.ok(!originalSet.has(aj.miner_id), 'Appeal juror should not overlap with original jury');
    }

    // Appeal jury votes innocent
    for (const aj of appealJurors) {
      submitVote(db, appealCase.id, aj.miner_id, 'human');
    }

    const verdict2 = resolveAppeal(db, appealCase.id);
    assert.equal(verdict2, 'innocent');
    assert.equal(getCase(db, appealCase.id)!.status, 'appeal_verdict');
    assert.equal(getCase(db, courtCase.id)!.status, 'court_verdict', 'the appeal verdict settles the case at once');

    // Defendant exactly whole: never closed, earned untouched, plus half the
    // challenger's forfeited stake (5% of 40,000 = 2,000 -> 1,000)
    const defAfter = getAccount(db, defendantId)!;
    assert.equal(defAfter.isActive, true);
    assert.equal(defAfter.isEscrowed, false);
    assert.equal(defAfter.earnedBalance, pts(10000) + courtCase.challengerStake / 2n);

    // Challenger: stake forfeited, no bounty was ever paid
    const challengerAfter = getAccount(db, challenger.accountId)!;
    assert.equal(challengerAfter.lockedBalance, 0n);
    assert.equal(challengerAfter.earnedBalance, challengerBefore.earnedBalance - courtCase.challengerStake);

    // Every juror judged against the FINAL verdict: the first jury (all
    // wrong) forfeits 250 each, split among the 7 appeal jurors (250 each).
    for (const jid of jurorIds1) {
      const acct = getAccount(db, getMiner(db, jid)!.accountId)!;
      assert.equal(acct.lockedBalance, 0n);
      assert.equal(acct.earnedBalance, pts(4750), 'original juror who voted against the final verdict loses the stake');
    }
    for (const aj of appealJurors) {
      const acct = getAccount(db, getMiner(db, aj.miner_id)!.accountId)!;
      assert.equal(acct.lockedBalance, 0n);
      assert.equal(acct.earnedBalance, pts(5250), 'appeal juror gets the stake back plus a share of the forfeits');
    }

    // Defendant should have protection window
    assert.ok(isInProtectionWindow(db, defendantId));

    db.close();
  });

  // Test 4: Protection window blocks new challenges
  it('protection window blocks new challenges', () => {
    const db = freshDb();
    const { defendantId, challenger, juryMiners } = setupCourtScenario(db);

    // File, escalate, vote innocent
    const courtCase = fileChallenge(db, challenger.accountId, defendantId, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash789');

    for (const jid of jurorIds) {
      submitVote(db, courtCase.id, jid, 'human');
    }
    resolveVerdict(db, courtCase.id);

    // During the appeal window the case is still open, so a second challenge
    // is refused for that reason, not yet for the protection window.
    const challenger2 = createMinerAccount(db, 1, 10000);
    assert.throws(
      () => fileChallenge(db, challenger2.accountId, defendantId, 'not_human', 5),
      /Active case already exists/,
    );

    // Settle: the innocent verdict is final and sets the protection window
    settleAfterAppealWindow(db);

    // Try to file new challenge (should fail - protection window)
    assert.throws(
      () => fileChallenge(db, challenger2.accountId, defendantId, 'not_human', 5),
      /protection window/i,
      'Should reject challenge during protection window',
    );

    // Advance past protection window
    db.prepare('UPDATE day_cycle_state SET current_day = ? WHERE id = 1').run(1 + 181);

    // Should now succeed
    const newCase = fileChallenge(db, challenger2.accountId, defendantId, 'not_human', 5);
    assert.ok(newCase.id, 'Challenge should succeed after protection window');

    db.close();
  });

  // Test 5: One active case at a time per defendant
  it('rejects second challenge against same defendant', () => {
    const db = freshDb();
    const { defendantId, challenger } = setupCourtScenario(db);

    // File first challenge
    fileChallenge(db, challenger.accountId, defendantId, 'not_human', 5);

    // Second challenger tries
    const challenger2 = createMinerAccount(db, 1, 10000);
    assert.throws(
      () => fileChallenge(db, challenger2.accountId, defendantId, 'not_human', 5),
      /Active case already exists/,
      'Should reject second challenge against same defendant',
    );

    db.close();
  });

  // Test 6: Accuracy retroactive impact
  it('retroactively updates miner accuracy when court finds defendant guilty', () => {
    const db = freshDb();
    const { defendantId, challenger, juryMiners } = setupCourtScenario(db);

    // Create a verification panel for the defendant with 3 panel miners
    const panelMiners: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = createMinerAccount(db, 2, 5000);
      panelMiners.push(m.minerId);
    }

    // Create panel
    const panelId = 'panel-' + defendantId;
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO verification_panels (id, account_id, status, created_at, completed_at) VALUES (?, ?, 'completed', ?, ?)"
    ).run(panelId, defendantId, now, now);

    // Panel miners scored defendant as human (score >= 50)
    for (const mid of panelMiners) {
      db.prepare(
        "INSERT INTO panel_reviews (id, panel_id, miner_id, score, evidence_hash_of_review, submitted_at) VALUES (?, ?, ?, 85, 'hash123', ?)"
      ).run(`review-${mid}`, panelId, mid, now);
    }

    // File, escalate, vote guilty
    const courtCase = fileChallenge(db, challenger.accountId, defendantId, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_acc');

    for (const jid of jurorIds) {
      submitVote(db, courtCase.id, jid, 'not_human');
    }
    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    // Apply accuracy impact
    const resolvedCase = getCase(db, courtCase.id)!;
    applyAccuracyImpact(db, resolvedCase);

    // Panel miners who scored 85 (>= 50) should have a verification miss recorded
    // Check that they now have a "missed" assignment
    for (const mid of panelMiners) {
      const assignments = db.prepare(
        'SELECT * FROM miner_verification_assignments WHERE miner_id = ? AND panel_id = ?'
      ).all(mid, panelId) as Array<Record<string, unknown>>;
      assert.ok(assignments.length > 0, `Miner ${mid} should have accuracy impact recorded`);
      // The assignment should be marked as missed (they judged wrong)
      const missed = assignments.find((a) => (a.missed as number) === 1);
      assert.ok(missed, `Miner ${mid} should have a missed verification (scored 85, defendant was guilty)`);
    }

    db.close();
  });

  // Test 7: Jury attendance tracking
  it('tracks jury attendance and impacts tier evaluation', () => {
    const db = freshDb();
    const now = Math.floor(Date.now() / 1000);
    const networkStart = now - 86400 * 30;

    // Create a T2 miner with good uptime
    const m = createMinerAccount(db, 2, 10000);

    // Give them enough heartbeats for 95% uptime
    const interval = 60;
    const beats = Math.floor((86400 * 30 / interval) * 0.95);
    for (let b = 0; b < beats; b++) {
      db.prepare('INSERT INTO miner_heartbeats (miner_id, timestamp, block_height) VALUES (?, ?, ?)').run(
        m.minerId, networkStart + b * interval, b,
      );
    }

    // Record jury service where miner was called but did NOT vote
    db.prepare(
      `INSERT INTO miner_jury_service (id, miner_id, case_id, called_at, voted, vote_matched_verdict)
       VALUES (?, ?, ?, ?, 0, 0)`
    ).run('jury-missed-1', m.minerId, 'case-1', now);

    // Jury attendance should be 0% (1 call, 0 votes)
    const attendance = getJuryAttendanceRate(db, m.minerId);
    assert.equal(attendance, 0, 'Attendance should be 0 (missed duty)');

    // Evaluate tier - should be demoted since jury attendance < 100%
    const eval1 = evaluateMinerTier(db, m.minerId, networkStart);
    assert.equal(eval1.newTier, 1, 'Should be demoted to Tier 1 for missed jury duty');
    assert.ok(eval1.reason.includes('jury'), `Reason should mention jury: ${eval1.reason}`);

    db.close();
  });

  // Test 8: Insufficient jury (fewer than 11 T2 miners)
  it('handles insufficient jury pool with reduced jury size', () => {
    const db = freshDb();

    // Only create 5 T2 miners (below default jury size of 11)
    const defResult = createAccount(db, 'individual', 1, 80);
    updateBalance(db, defResult.account.id, 'earned_balance', pts(10000));

    const challenger = createMinerAccount(db, 1, 10000);

    const juryMiners: Array<{ accountId: string; minerId: string }> = [];
    for (let i = 0; i < 5; i++) {
      juryMiners.push(createMinerAccount(db, 2, 5000));
    }

    // File and escalate
    const courtCase = fileChallenge(db, challenger.accountId, defResult.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);

    // Select jury
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_small');

    // 3..20 eligible miners seat a jury of 3
    assert.equal(jurorIds.length, 3, `5 eligible miners should seat 3 jurors, got ${jurorIds.length}`);

    // Case should proceed (status = court_voting)
    const updatedCase = getCase(db, courtCase.id)!;
    assert.equal(updatedCase.status, 'court_voting', 'Case should proceed with reduced jury');

    // Voting should work with reduced jury
    for (const jid of jurorIds) {
      submitVote(db, courtCase.id, jid, 'not_human');
    }
    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    db.close();
  });
});
