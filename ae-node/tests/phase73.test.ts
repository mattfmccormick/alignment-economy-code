// Phase 73: WP v2 court escrow.
//
// When a challenge is filed, the defendant's earned balance is escrowed:
//   - Earned-point outbound transfers are blocked
//   - Daily allocations (active/supportive/ambient) still mint and are spendable
//   - Incoming earned transfers land normally (frozen by escrow)
//   - New vouch creation from the escrowed account is blocked
//   - Escrow releases on innocent verdict
//   - On guilty verdict, bounty is calculated from escrowed earned balance
//   - Appeal reversal (guilty→innocent) releases escrow

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { processTransaction } from '../src/core/transaction.js';
import { signPayload } from '../src/core/crypto.js';
import { PRECISION } from '../src/core/constants.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import { createVouch } from '../src/verification/vouching.js';
import { runDayCycle } from '../src/core/day-cycle.js';
import {
  fileChallenge,
  escalateToFull,
  selectJury,
  submitVote,
  resolveVerdict,
  fileAppeal,
  resolveAppeal,
} from '../src/court/court.js';

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

function createMinerAccount(
  db: DatabaseSync,
  tier: 1 | 2,
  earnedPts: number,
): { accountId: string; minerId: string; privateKey: string } {
  const result = createAccount(db, 'individual', 1, 100);
  updateBalance(db, result.account.id, 'earned_balance', pts(earnedPts));
  const miner = registerMiner(db, result.account.id);
  if (tier === 2) setMinerTier(db, miner.id, 2, 'test setup');
  return { accountId: result.account.id, minerId: miner.id, privateKey: result.privateKey };
}

function setupCourt(db: DatabaseSync): {
  defendant: { accountId: string; privateKey: string };
  challenger: { accountId: string; minerId: string; privateKey: string };
  juryMiners: Array<{ accountId: string; minerId: string }>;
} {
  const def = createAccount(db, 'individual', 1, 100);
  updateBalance(db, def.account.id, 'earned_balance', pts(10000));
  const challenger = createMinerAccount(db, 1, 10000);
  const juryMiners = [];
  for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));
  return {
    defendant: { accountId: def.account.id, privateKey: def.privateKey },
    challenger,
    juryMiners,
  };
}

describe('Phase 73: Court escrow (WP v2 §9.3)', () => {

  it('fileChallenge sets is_escrowed on defendant', () => {
    const db = freshDb();
    const { defendant, challenger } = setupCourt(db);

    const defBefore = getAccount(db, defendant.accountId)!;
    assert.equal(defBefore.isEscrowed, false);

    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);

    const defAfter = getAccount(db, defendant.accountId)!;
    assert.equal(defAfter.isEscrowed, true);
    db.close();
  });

  it('escrowed account cannot send earned points', () => {
    const db = freshDb();
    const { defendant, challenger } = setupCourt(db);
    const recipient = createAccount(db, 'individual', 1, 100);

    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);

    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      from: defendant.accountId,
      to: recipient.account.id,
      amount: pts(100).toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const signature = signPayload(payload, timestamp, defendant.privateKey);

    assert.throws(
      () => processTransaction(db, {
        from: defendant.accountId,
        to: recipient.account.id,
        amount: pts(100),
        pointType: 'earned',
        isInPerson: false,
        recipientIsHuman: false,
        memo: '',
        signature,
        timestamp,
      }),
      /escrowed/,
    );
    db.close();
  });

  it('escrowed account can still send daily points (active)', () => {
    const db = freshDb();
    const { defendant, challenger } = setupCourt(db);
    const recipient = createAccount(db, 'individual', 1, 100);

    // Give defendant active balance via day cycle
    runDayCycle(db);

    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);

    const defAcct = getAccount(db, defendant.accountId)!;
    assert.ok(defAcct.activeBalance > 0n, 'defendant should have active balance from mint');

    const timestamp = Math.floor(Date.now() / 1000);
    const txAmount = pts(10);
    const payload = {
      from: defendant.accountId,
      to: recipient.account.id,
      amount: txAmount.toString(),
      pointType: 'active' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const signature = signPayload(payload, timestamp, defendant.privateKey);

    const result = processTransaction(db, {
      from: defendant.accountId,
      to: recipient.account.id,
      amount: txAmount,
      pointType: 'active',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
      signature,
      timestamp,
    });

    assert.ok(result.transaction.id, 'active tx should succeed while escrowed');
    db.close();
  });

  it('incoming earned transfers land normally on escrowed account', () => {
    const db = freshDb();
    const { defendant, challenger } = setupCourt(db);

    // Create a sender with earned balance
    const sender = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'earned_balance', pts(5000));

    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);

    const defBefore = getAccount(db, defendant.accountId)!;
    const timestamp = Math.floor(Date.now() / 1000);
    const txAmount = pts(100);
    const payload = {
      from: sender.account.id,
      to: defendant.accountId,
      amount: txAmount.toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const signature = signPayload(payload, timestamp, sender.privateKey);

    processTransaction(db, {
      from: sender.account.id,
      to: defendant.accountId,
      amount: txAmount,
      pointType: 'earned',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
      signature,
      timestamp,
    });

    const defAfter = getAccount(db, defendant.accountId)!;
    assert.ok(defAfter.earnedBalance > defBefore.earnedBalance,
      'incoming earned tx should increase escrowed defendant balance');
    assert.equal(defAfter.isEscrowed, true, 'should still be escrowed');
    db.close();
  });

  it('escrowed account cannot create new vouches', () => {
    const db = freshDb();
    const { defendant, challenger } = setupCourt(db);
    const target = createAccount(db, 'individual', 1, 0);

    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);

    assert.throws(
      () => createVouch(db, defendant.accountId, target.account.id, 10),
      /escrowed/,
    );
    db.close();
  });

  it('innocent verdict releases escrow', () => {
    const db = freshDb();
    const { defendant, challenger, juryMiners } = setupCourt(db);

    const courtCase = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);
    assert.equal(getAccount(db, defendant.accountId)!.isEscrowed, true);

    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_escrow_innocent');
    assert.ok(jurorIds.length >= 3);

    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'innocent');

    const defAfter = getAccount(db, defendant.accountId)!;
    assert.equal(defAfter.isEscrowed, false, 'escrow should be released on innocent');
    assert.equal(defAfter.isActive, true, 'defendant should remain active');
    db.close();
  });

  it('guilty verdict: bounty uses defendant earned balance, account deactivated', () => {
    const db = freshDb();
    const { defendant, challenger, juryMiners } = setupCourt(db);

    const defEarnedBefore = getAccount(db, defendant.accountId)!.earnedBalance;
    const courtCase = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);

    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_escrow_guilty');
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    const defAfter = getAccount(db, defendant.accountId)!;
    assert.equal(defAfter.isActive, false, 'defendant deactivated on guilty');
    assert.equal(defAfter.earnedBalance, 0n, 'earned balance burned');

    // Challenger got bounty (20% of defendant earned)
    const challengerAfter = getAccount(db, challenger.accountId)!;
    const bountyExpected = (defEarnedBefore * 20n) / 100n;
    assert.ok(challengerAfter.earnedBalance > 0n);
    db.close();
  });

  it('appeal reversal (guilty→innocent) releases escrow and reactivates', () => {
    const db = freshDb();
    const def = createAccount(db, 'individual', 1, 100);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);
    // Need enough T2 miners for both original jury and appeal jury
    for (let i = 0; i < 26; i++) createMinerAccount(db, 2, 5000);

    // First trial: guilty
    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_appeal_a');
    assert.ok(jurorIds.length >= 3);
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'not_human');
    resolveVerdict(db, courtCase.id);

    assert.equal(getAccount(db, def.account.id)!.isActive, false);

    // Appeal: innocent
    const appealCase = fileAppeal(db, courtCase.id, 'blockhash_appeal_b');
    const appealJurors = db.prepare(
      'SELECT miner_id FROM court_jury WHERE case_id = ?'
    ).all(appealCase.id) as Array<{ miner_id: string }>;
    assert.ok(appealJurors.length >= 3, 'appeal jury must form');

    for (const j of appealJurors) {
      submitVote(db, appealCase.id, j.miner_id, 'human');
    }

    const appealVerdict = resolveAppeal(db, appealCase.id);
    assert.equal(appealVerdict, 'innocent');

    const defAfter = getAccount(db, def.account.id)!;
    assert.equal(defAfter.isActive, true, 'reactivated on appeal reversal');
    assert.equal(defAfter.isEscrowed, false, 'escrow released on appeal reversal');
    db.close();
  });

  it('after escrow release, defendant can send earned points again', () => {
    const db = freshDb();
    const { defendant, challenger, juryMiners } = setupCourt(db);
    const recipient = createAccount(db, 'individual', 1, 100);

    const courtCase = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_release');
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'human');
    resolveVerdict(db, courtCase.id);

    // Escrow released, should be able to send earned
    const defAfter = getAccount(db, defendant.accountId)!;
    assert.equal(defAfter.isEscrowed, false);
    assert.ok(defAfter.earnedBalance > 0n);

    const timestamp = Math.floor(Date.now() / 1000);
    const txAmount = pts(50);
    const payload = {
      from: defendant.accountId,
      to: recipient.account.id,
      amount: txAmount.toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const signature = signPayload(payload, timestamp, defendant.privateKey);

    const result = processTransaction(db, {
      from: defendant.accountId,
      to: recipient.account.id,
      amount: txAmount,
      pointType: 'earned',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
      signature,
      timestamp,
    });

    assert.ok(result.transaction.id, 'earned tx should succeed after escrow release');
    db.close();
  });
});
