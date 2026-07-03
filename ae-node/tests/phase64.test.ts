// Phase 64: Court burns are true burns (WP v2).
//
// Burns from guilty/innocent verdicts, voucher stakes, and minority juror
// stakes destroy value permanently. The rebase re-inflates everyone
// proportionally so small networks don't deflate over time, but the burned
// points are gone from the economy. This aligns with the white paper v2
// which says "burned" not "recycled."
//
// Conservation invariant tested per scenario:
//   post_supply < pre_supply (burns actually reduce supply)
//   fee_pool unchanged (burns don't route there)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { PRECISION } from '../src/core/constants.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge,
  escalateToFull,
  selectJury,
  submitVote,
  resolveVerdict,
} from '../src/court/court.js';
import { createVouch } from '../src/verification/vouching.js';
import { getFeePool } from '../src/core/fee-pool.js';

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
  const rows = db.prepare(
    'SELECT earned_balance, locked_balance FROM accounts',
  ).all() as Array<{ earned_balance: string; locked_balance: string }>;
  let total = 0n;
  for (const r of rows) {
    total += BigInt(r.earned_balance) + BigInt(r.locked_balance);
  }
  return total;
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
    const challenger = createMinerAccount(db, 1, 10000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const supplyBefore = totalSupply(db);
    const poolBefore = getFeePool(db).currentBalance;

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62');
    assert.ok(jurorIds.length >= 3, 'jury must form');

    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    const supplyAfter = totalSupply(db);
    const poolAfter = getFeePool(db).currentBalance;

    assert.ok(supplyAfter < supplyBefore, 'total supply must decrease after guilty verdict burns');
    assert.equal(poolAfter, poolBefore, 'fee pool must not change from court burns');

    db.close();
  });

  it('innocent verdict: challenger stake splits 50% to defendant, 50% true-burned', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const defEarnedBefore = pts(10000);
    const challenger = createMinerAccount(db, 1, 10000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const poolBefore = getFeePool(db).currentBalance;

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    const stakeAmount = courtCase.challengerStake;
    const defendantHalf = stakeAmount / 2n;

    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62b');
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'innocent');

    const poolAfter = getFeePool(db).currentBalance;
    assert.equal(poolAfter, poolBefore, 'fee pool must not change from court burns');

    const defAfter = getAccount(db, def.account.id)!;
    assert.equal(defAfter.earnedBalance, defEarnedBefore + defendantHalf,
      'defendant receives 50% of challenger stake as compensation');

    db.close();
  });

  it('vouch burn during guilty verdict is a true burn', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);

    const voucher = createAccount(db, 'individual', 1, 100);
    updateBalance(db, voucher.account.id, 'earned_balance', pts(2000));
    createVouch(db, voucher.account.id, def.account.id, 25);

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

    const voucherAfter = getAccount(db, voucher.account.id)!;
    assert.equal(voucherAfter.lockedBalance, 0n, 'voucher stake fully burned from locked');

    const supplyAfter = totalSupply(db);
    const poolAfter = getFeePool(db).currentBalance;

    assert.ok(supplyAfter < supplyBefore, 'supply decreases from defendant + vouch burns');
    assert.equal(poolAfter, poolBefore, 'fee pool unchanged');

    db.close();
  });

  it('minority juror stake burn is a true burn', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62d');

    const poolBeforeVerdict = getFeePool(db).currentBalance;
    const supplyBeforeVerdict = totalSupply(db);

    const guiltyCount = Math.ceil(jurorIds.length * 0.7);
    for (let i = 0; i < jurorIds.length; i++) {
      const vote = i < guiltyCount ? 'not_human' : 'human';
      submitVote(db, courtCase.id, jurorIds[i], vote);
    }

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    const poolAfterVerdict = getFeePool(db).currentBalance;
    const supplyAfterVerdict = totalSupply(db);

    assert.equal(poolAfterVerdict, poolBeforeVerdict, 'fee pool unchanged from minority burns');
    assert.ok(supplyAfterVerdict < supplyBeforeVerdict, 'supply decreases from burns');

    db.close();
  });
});
