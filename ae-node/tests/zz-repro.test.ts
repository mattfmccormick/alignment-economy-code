// TEMPORARY repro harness — delete after review.
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { PRECISION } from '../src/core/constants.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, resolveVerdict,
} from '../src/court/court.js';
import { rebase } from '../src/core/day-cycle.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}
function pts(n: number): bigint { return BigInt(Math.round(n * Number(PRECISION))); }

function createMinerAccount(db: DatabaseSync, tier: 1 | 2, earnedPts: number) {
  const r = createAccount(db, 'individual', 1, 100);
  updateBalance(db, r.account.id, 'earned_balance', pts(earnedPts));
  const m = registerMiner(db, r.account.id);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { accountId: r.account.id, minerId: m.id };
}

describe('REPRO', () => {
  it('A: rebase between jury selection and verdict — DOWN multiplier', () => {
    const db = freshDb();
    // Everyone holds MORE than TARGET_EARNED_PER_PERSON (525,600) so the
    // rebase multiplier is < 1 and locked balances shrink.
    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(2_000_000));
    const challenger = createMinerAccount(db, 1, 2_000_000);
    for (let i = 0; i < 13; i++) createMinerAccount(db, 2, 2_000_000);

    const c = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 10);
    console.log('challenger stake (nominal):', c.challengerStake.toString());
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'bh');
    console.log('jury size:', jurors.length);

    const jrow = db.prepare('SELECT juror_account_id, stake_amount FROM court_jury WHERE case_id = ? LIMIT 1').get(c.id) as any;
    console.log('juror stake stored:', jrow.stake_amount);
    console.log('juror locked before rebase:', getAccount(db, jrow.juror_account_id)!.lockedBalance.toString());
    console.log('challenger locked before rebase:', getAccount(db, challenger.accountId)!.lockedBalance.toString());

    // One daily rebase happens while the case is open (voting window is 7 days).
    rebase(db);

    console.log('juror locked AFTER rebase:', getAccount(db, jrow.juror_account_id)!.lockedBalance.toString());
    console.log('challenger locked AFTER rebase:', getAccount(db, challenger.accountId)!.lockedBalance.toString());

    for (const jid of jurors) submitVote(db, c.id, jid, 'not_human');
    const v = resolveVerdict(db, c.id);
    console.log('verdict:', v);

    const rows = db.prepare('SELECT id, earned_balance, locked_balance FROM accounts').all() as any[];
    let neg = 0;
    for (const r of rows) {
      if (BigInt(r.locked_balance) < 0n || BigInt(r.earned_balance) < 0n) {
        neg++;
        console.log('NEGATIVE BALANCE:', r.id.slice(0, 10), 'earned=', r.earned_balance, 'locked=', r.locked_balance);
      }
    }
    console.log('accounts with negative balances:', neg);
    db.close();
  });

  it('B: rebase between selection and verdict — UP multiplier strands locked value', () => {
    const db = freshDb();
    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);
    for (let i = 0; i < 13; i++) createMinerAccount(db, 2, 5000);

    const c = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'bh2');
    const jrow = db.prepare('SELECT juror_account_id, stake_amount FROM court_jury WHERE case_id = ? LIMIT 1').get(c.id) as any;
    console.log('juror stake stored:', jrow.stake_amount);
    console.log('juror locked before rebase:', getAccount(db, jrow.juror_account_id)!.lockedBalance.toString());
    rebase(db);
    console.log('juror locked AFTER rebase :', getAccount(db, jrow.juror_account_id)!.lockedBalance.toString());
    for (const jid of jurors) submitVote(db, c.id, jid, 'not_human');
    resolveVerdict(db, c.id);
    console.log('juror locked AFTER verdict:', getAccount(db, jrow.juror_account_id)!.lockedBalance.toString(),
      '(should be 0 — anything left is stranded forever)');
    db.close();
  });

  it('C: zero-balance miner files a free challenge that freezes the defendant', () => {
    const db = freshDb();
    const def = createAccount(db, 'individual', 1, 100);
    updateBalance(db, def.account.id, 'earned_balance', pts(50000));
    // Challenger with ZERO earned balance.
    const broke = createAccount(db, 'individual', 1, 100);
    registerMiner(db, broke.account.id);
    const c = fileChallenge(db, broke.account.id, def.account.id, 'not_human', 100);
    console.log('stake locked by broke challenger:', c.challengerStake.toString());
    console.log('defendant is_escrowed:', getAccount(db, def.account.id)!.isEscrowed);
    console.log('case status:', c.status, '| arbitration_deadline:', c.arbitrationDeadline);
    db.close();
  });

  it('D: defendant can be seated on their own jury', () => {
    const db = freshDb();
    // Defendant IS an active tier-2 miner.
    const defM = createMinerAccount(db, 2, 5000);
    const challenger = createMinerAccount(db, 1, 10000);
    for (let i = 0; i < 4; i++) createMinerAccount(db, 2, 5000);
    const c = fileChallenge(db, challenger.accountId, defM.accountId, 'not_human', 5);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'bh3');
    console.log('jurors:', jurors.length, '| defendant minerId in jury?', jurors.includes(defM.minerId));
    db.close();
  });

  it('E: jury pool < 3 leaves the case and the escrow stuck forever', () => {
    const db = freshDb();
    const def = createAccount(db, 'individual', 1, 100);
    updateBalance(db, def.account.id, 'earned_balance', pts(50000));
    const challenger = createMinerAccount(db, 1, 10000);
    createMinerAccount(db, 2, 5000); // only 1 tier-2 miner
    const c = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'bh4');
    console.log('jurors seated:', jurors.length);
    const row = db.prepare('SELECT status FROM court_cases WHERE id = ?').get(c.id) as any;
    console.log('case status:', row.status);
    console.log('defendant escrowed:', getAccount(db, def.account.id)!.isEscrowed);
    console.log('challenger locked:', getAccount(db, challenger.accountId)!.lockedBalance.toString());
    try {
      escalateToFull(db, c.id);
    } catch (e: any) {
      console.log('retry escalate ->', e.message, '(no other route re-runs selectJury)');
    }
    db.close();
  });

  it('F: tier-2 miner with zero earned is silently skipped -> tiny/even jury', () => {
    const db = freshDb();
    const def = createAccount(db, 'individual', 1, 100);
    updateBalance(db, def.account.id, 'earned_balance', pts(50000));
    const challenger = createMinerAccount(db, 1, 10000);
    createMinerAccount(db, 2, 5000);
    createMinerAccount(db, 2, 0); // zero earned
    createMinerAccount(db, 2, 0); // zero earned
    const c = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 10);
    escalateToFull(db, c.id);
    const jurors = selectJury(db, c.id, 'bh5');
    const row = db.prepare('SELECT status FROM court_cases WHERE id = ?').get(c.id) as any;
    console.log('pool was 3, jurors actually seated:', jurors.length, '| status:', row.status);
    db.close();
  });
});
