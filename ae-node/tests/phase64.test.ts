// Phase 64: Court burns are true burns (WP v2).
//
// Burns from guilty/innocent verdicts and voucher stakes destroy value
// permanently. The rebase re-inflates everyone proportionally so small
// networks don't deflate over time, but the burned points are gone from the
// economy. This aligns with the white paper v2 which says "burned" not
// "recycled."
//
// Juror stakes are the exception (October 2026 court rules): a juror who
// voted against the final verdict forfeits the stake to the jurors who
// matched it, so only the integer-division dust of that split is burned.
//
// Settlement is deferred: a verdict moves nothing until the 7-day appeal
// window closes and the day-cycle sweep (expireCourtDeadlines) settles it.
//
// Conservation invariant tested per scenario:
//   post_supply = pre_supply - (exactly what the rules burn)
//   fee_pool unchanged (burns don't route there)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { PRECISION } from '../src/core/constants.js';
import { registerMiner, setMinerTier, getMiner } from '../src/mining/registration.js';
import {
  fileChallenge,
  escalateToFull,
  selectJury,
  submitVote,
  resolveVerdict,
  getCase,
  expireCourtDeadlines,
} from '../src/court/court.js';
import { createVouch } from '../src/verification/vouching.js';
import { getFeePool } from '../src/core/fee-pool.js';

/** Day-cycle sweep after the appeal window: the moment a verdict settles. */
function settleAfterAppealWindow(db: DatabaseSync, caseId: string): void {
  const sweep = expireCourtDeadlines(db, Math.floor(Date.now() / 1000) + 8 * 86400);
  assert.deepEqual(sweep.settled, [caseId], 'the case settles once the appeal window closes');
}

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

function totalSupply(db: DatabaseSync): bigint {
  const { earned, locked } = supplyByColumn(db);
  return earned + locked;
}

/**
 * Supply split by column, because the summed figure hid a real defect.
 *
 * The audit found the guilty path over-crediting spendable `earned` while the
 * shortfall parked in negative `locked`. Every assertion in this file summed
 * the two, so those errors cancelled exactly and the suite stayed green over
 * genuinely minted value. `updateBalance` now refuses to write a negative,
 * which closes that specific hole — but the assertion *shape* is why it went
 * unseen, so these tests now check each column and check for negatives
 * directly rather than trusting a total.
 */
function supplyByColumn(db: DatabaseSync): { earned: bigint; locked: bigint } {
  const rows = db.prepare(
    'SELECT earned_balance, locked_balance FROM accounts',
  ).all() as Array<{ earned_balance: string; locked_balance: string }>;
  let earned = 0n;
  let locked = 0n;
  for (const r of rows) {
    earned += BigInt(r.earned_balance);
    locked += BigInt(r.locked_balance);
  }
  return { earned, locked };
}

/** Accounts holding a negative balance. Must always be empty. */
function negativeHolders(db: DatabaseSync): string[] {
  const rows = db.prepare(
    'SELECT id, earned_balance, locked_balance FROM accounts',
  ).all() as Array<{ id: string; earned_balance: string; locked_balance: string }>;
  return rows
    .filter((r) => BigInt(r.earned_balance) < 0n || BigInt(r.locked_balance) < 0n)
    .map((r) => `${r.id.slice(0, 10)} earned=${r.earned_balance} locked=${r.locked_balance}`);
}

function createMinerAccount(
  db: DatabaseSync,
  tier: 1 | 2,
  earnedPts: number,
): { accountId: string; minerId: string } {
  const result = createAccount(db, 'individual', 1, 100);
  updateBalance(db, result.account.id, 'earned_balance', pts(earnedPts));
  const miner = registerMiner(db, result.account.id);
  if (tier === 2) setMinerTier(db, miner.id, 2, 'test setup');
  return { accountId: result.account.id, minerId: miner.id };
}

describe('Phase 64: Court burns are true burns (WP v2)', () => {

  it('guilty verdict: defendant burn reduces total supply, fee pool unchanged', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 40000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const supplyBefore = totalSupply(db);
    const byColumnBefore = supplyByColumn(db);
    const poolBefore = getFeePool(db).currentBalance;

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62');
    assert.equal(jurorIds.length, 3, 'jury must form (13 eligible -> 3)');

    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    // Nothing burns until the verdict is final
    assert.equal(totalSupply(db), supplyBefore, 'a pending verdict burns nothing');
    settleAfterAppealWindow(db, courtCase.id);

    const supplyAfter = totalSupply(db);
    const byColumnAfter = supplyByColumn(db);
    const poolAfter = getFeePool(db).currentBalance;

    // The defendant's 10,000 earned leaves the economy except the 20% bounty
    // (2,000) paid to the challenger: exactly 8,000 burned.
    assert.equal(supplyAfter, supplyBefore - pts(8000), 'total supply drops by exactly the defendant burn');
    assert.equal(poolAfter, poolBefore, 'fee pool must not change from court burns');

    // Per-column, not just the total. The bug this guards against credited
    // spendable `earned` beyond what was burned while the shortfall sat in
    // negative `locked` — equal and opposite, so the summed assertion above
    // passed over genuinely minted value.
    assert.deepEqual(negativeHolders(db), [], 'no account may hold a negative balance');
    assert.ok(
      byColumnAfter.earned <= byColumnBefore.earned + courtCase.challengerStake,
      `spendable earned grew beyond what the settlement can justify: ` +
        `${byColumnBefore.earned} -> ${byColumnAfter.earned}`,
    );
    assert.ok(byColumnAfter.locked >= 0n, 'locked supply must never go negative');

    db.close();
  });

  it('innocent verdict: challenger stake splits 50% to defendant, 50% true-burned', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const defEarnedBefore = pts(10000);
    const challenger = createMinerAccount(db, 1, 40000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const poolBefore = getFeePool(db).currentBalance;
    const supplyBefore = totalSupply(db);

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    const stakeAmount = courtCase.challengerStake;
    assert.equal(stakeAmount, pts(2000), '5% of 40,000');
    const defendantHalf = stakeAmount / 2n;

    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62b');
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'innocent');

    // Deferred: no compensation and no burn until the appeal window closes
    assert.equal(getAccount(db, def.account.id)!.earnedBalance, defEarnedBefore);
    assert.equal(totalSupply(db), supplyBefore);
    settleAfterAppealWindow(db, courtCase.id);

    const poolAfter = getFeePool(db).currentBalance;
    assert.equal(poolAfter, poolBefore, 'fee pool must not change from court burns');

    const defAfter = getAccount(db, def.account.id)!;
    assert.equal(defAfter.earnedBalance, defEarnedBefore + defendantHalf,
      'defendant receives 50% of challenger stake as compensation');

    // The other half is a true burn
    assert.equal(totalSupply(db), supplyBefore - (stakeAmount - defendantHalf),
      'the challenger stake not paid to the defendant is destroyed');
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n);
    assert.deepEqual(negativeHolders(db), []);

    db.close();
  });

  it('vouch burn during guilty verdict is a true burn', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 40000);

    const voucher = createAccount(db, 'individual', 1, 100);
    updateBalance(db, voucher.account.id, 'earned_balance', pts(2000));
    const vouch = createVouch(db, voucher.account.id, def.account.id, 25);
    assert.equal(vouch.stakeAmount, pts(500));

    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const supplyBefore = totalSupply(db);
    const poolBefore = getFeePool(db).currentBalance;

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62c');
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    // The vouch is not burned while the verdict can still be appealed
    assert.equal(getAccount(db, voucher.account.id)!.lockedBalance, vouch.stakeAmount);
    settleAfterAppealWindow(db, courtCase.id);

    const voucherAfter = getAccount(db, voucher.account.id)!;
    assert.equal(voucherAfter.lockedBalance, 0n, 'voucher stake fully burned from locked');
    assert.equal(voucherAfter.earnedBalance, pts(1500), 'voucher earned untouched; only the stake is gone');

    const supplyAfter = totalSupply(db);
    const poolAfter = getFeePool(db).currentBalance;

    // Defendant burn (10,000 - 2,000 bounty) plus the 500-point vouch
    assert.equal(supplyAfter, supplyBefore - pts(8000) - vouch.stakeAmount, 'supply drops by defendant + vouch burns');
    assert.equal(poolAfter, poolBefore, 'fee pool unchanged');
    assert.deepEqual(negativeHolders(db), []);

    db.close();
  });

  it('minority juror stake goes to the majority jurors; only the split dust is truly burned', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 40000);
    // 20 extra base units make each 5% juror stake odd (250 points + 1 base
    // unit), so splitting one forfeited stake between two jurors leaves
    // exactly 1 base unit of dust.
    const jurorEarned = pts(5000) + 20n;
    const juryMiners = [];
    for (let i = 0; i < 13; i++) {
      const m = createMinerAccount(db, 2, 5000);
      updateBalance(db, m.accountId, 'earned_balance', jurorEarned);
      juryMiners.push(m);
    }
    const jurorStake = (jurorEarned * 5n) / 100n;
    assert.equal(jurorStake, pts(250) + 1n);

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62d');
    assert.equal(jurorIds.length, 3);
    const jurorAccounts = jurorIds.map((id) => getMiner(db, id)!.accountId);

    const poolBeforeVerdict = getFeePool(db).currentBalance;
    const supplyBeforeVerdict = totalSupply(db);
    const juryHoldings = (): bigint =>
      jurorAccounts.reduce((sum, id) => {
        const a = getAccount(db, id)!;
        return sum + a.earnedBalance + a.lockedBalance;
      }, 0n);
    const juryHoldingsBefore = juryHoldings();

    // Two of three vote guilty, one votes the other way
    const guiltyCount = 2;
    for (let i = 0; i < jurorIds.length; i++) {
      const vote = i < guiltyCount ? 'not_human' : 'human';
      submitVote(db, courtCase.id, jurorIds[i], vote);
    }

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');
    settleAfterAppealWindow(db, courtCase.id);
    assert.equal(getCase(db, courtCase.id)!.status, 'court_verdict');

    const poolAfterVerdict = getFeePool(db).currentBalance;
    const supplyAfterVerdict = totalSupply(db);

    assert.equal(poolAfterVerdict, poolBeforeVerdict, 'fee pool unchanged by juror settlement');

    // Minority juror forfeits the stake; each majority juror gets their own
    // stake back plus half of it, rounded down.
    const share = jurorStake / 2n;
    for (let i = 0; i < guiltyCount; i++) {
      const a = getAccount(db, jurorAccounts[i])!;
      assert.equal(a.lockedBalance, 0n);
      assert.equal(a.earnedBalance, jurorEarned + share, `majority juror ${i} receives a share of the forfeit`);
    }
    const minority = getAccount(db, jurorAccounts[2])!;
    assert.equal(minority.lockedBalance, 0n);
    assert.equal(minority.earnedBalance, jurorEarned - jurorStake, 'minority juror forfeits the stake');

    // The jury as a whole loses only the 1 base unit the split could not
    // divide, and that unit is destroyed, not pooled.
    const dust = jurorStake - share * 2n;
    assert.equal(dust, 1n);
    assert.equal(juryHoldings(), juryHoldingsBefore - dust, 'forfeited juror stake is redistributed, not burned');
    // Total burn: the defendant's 8,000 (10,000 less the 2,000 bounty) plus the dust
    assert.equal(supplyAfterVerdict, supplyBeforeVerdict - pts(8000) - dust);
    assert.deepEqual(negativeHolders(db), []);

    // The forfeit is logged as a jury reward, not as fee income
    const rewards = db
      .prepare("SELECT COUNT(*) AS cnt FROM transaction_log WHERE change_type = 'jury_reward' AND reference_id = ?")
      .get(courtCase.id) as { cnt: number };
    assert.equal(Number(rewards.cnt), guiltyCount);

    db.close();
  });
});
