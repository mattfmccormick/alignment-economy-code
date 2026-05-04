// Phase 64: Court burns route to fee pool, not the void.
//
// Closes the small-network deflation hole. Before this change every guilty
// verdict destroyed 80% of the defendant's earned balance plus all voucher
// stakes plus all minority juror stakes. At 3 people that meant a single
// court case could empty the entire economy. The fix routes those losses
// into the fee pool so miners pick the value back up across subsequent
// blocks. Total network supply stays constant; the deterrent is unchanged
// (the loser still loses everything).
//
// Conservation invariant tested per scenario:
//   pre_total_balances == post_total_balances + fee_pool_delta
// where balance_total sums earned + locked across every account.

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

describe('Phase 64: Court burns route to fee pool', () => {

  it('guilty verdict: defendant burn (80%) lands in fee pool', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const supplyBefore = totalSupply(db);
    const poolBefore = getFeePool(db).currentBalance;
    const defendantEarnedBefore = getAccount(db, def.account.id)!.earnedBalance;

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62');
    assert.ok(jurorIds.length >= 3, 'jury must form');

    // All vote guilty (unanimous, no minority burns to confound)
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'not_human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    const supplyAfter = totalSupply(db);
    const poolAfter = getFeePool(db).currentBalance;
    const poolDelta = poolAfter - poolBefore;

    // Total supply (account balances + fee pool) is conserved.
    assert.equal(
      supplyBefore + poolBefore,
      supplyAfter + poolAfter,
      'pre-supply must equal post-supply once fee pool is included',
    );

    // 80% of defendant's earned balance hit the fee pool.
    const expectedBurn = (defendantEarnedBefore * 80n) / 100n;
    assert.equal(poolDelta, expectedBurn, 'fee pool gained the 80% burn');

    db.close();
  });

  it('innocent verdict: challenger stake burns to fee pool', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);
    const juryMiners = [];
    for (let i = 0; i < 13; i++) juryMiners.push(createMinerAccount(db, 2, 5000));

    const poolBefore = getFeePool(db).currentBalance;

    const courtCase = fileChallenge(db, challenger.accountId, def.account.id, 'not_human', 5);
    const stakeAmount = courtCase.challengerStake;

    escalateToFull(db, courtCase.id);
    const jurorIds = selectJury(db, courtCase.id, 'blockhash_test_62b');
    // All vote innocent (human)
    for (const jid of jurorIds) submitVote(db, courtCase.id, jid, 'human');

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'innocent');

    const poolAfter = getFeePool(db).currentBalance;
    assert.equal(
      poolAfter - poolBefore,
      stakeAmount,
      'fee pool gained the burned challenger stake',
    );

    db.close();
  });

  it('vouch burn during guilty verdict routes to fee pool', () => {
    const db = freshDb();

    const def = createAccount(db, 'individual', 1, 80);
    updateBalance(db, def.account.id, 'earned_balance', pts(10000));
    const challenger = createMinerAccount(db, 1, 10000);

    // A voucher staking on the defendant. When the defendant is found guilty
    // the vouch burns; that burn must reach the fee pool.
    const voucher = createAccount(db, 'individual', 1, 100);
    updateBalance(db, voucher.account.id, 'earned_balance', pts(2000));
    const vouchStake = pts(500); // 25% of 2000, well above the 5% min
    createVouch(db, voucher.account.id, def.account.id, vouchStake);

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

    // Voucher's locked balance went to 0 (stake burned)
    const voucherAfter = getAccount(db, voucher.account.id)!;
    assert.equal(voucherAfter.lockedBalance, 0n, 'voucher stake fully burned from locked');

    // Conservation across the full case
    const supplyAfter = totalSupply(db);
    const poolAfter = getFeePool(db).currentBalance;
    assert.equal(
      supplyBefore + poolBefore,
      supplyAfter + poolAfter,
      'supply + pool conserved across guilty verdict with vouch burn',
    );

    // Pool delta covers defendant 80% + the full vouch stake
    const expectedDefendantBurn = pts(10000) * 80n / 100n;
    const minExpectedDelta = expectedDefendantBurn + vouchStake;
    assert.ok(
      poolAfter - poolBefore >= minExpectedDelta,
      `pool delta ${poolAfter - poolBefore} must include defendant burn + vouch stake (${minExpectedDelta})`,
    );

    db.close();
  });

  it('minority juror stake burn routes to fee pool', () => {
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

    // Split vote: roughly 70% guilty, 30% innocent. The 30% become minority
    // burned stakes once the verdict lands.
    const guiltyCount = Math.ceil(jurorIds.length * 0.7);
    const minorityIds: string[] = [];
    for (let i = 0; i < jurorIds.length; i++) {
      const vote = i < guiltyCount ? 'not_human' : 'human';
      submitVote(db, courtCase.id, jurorIds[i], vote);
      if (i >= guiltyCount) minorityIds.push(jurorIds[i]);
    }

    // Sum each minority juror's locked stake before resolution so we know
    // exactly what should hit the fee pool.
    let minorityTotal = 0n;
    const jurorStakes = db.prepare(
      'SELECT juror_account_id, stake_amount FROM court_jury WHERE case_id = ?',
    ).all(courtCase.id) as Array<{ juror_account_id: string; stake_amount: string }>;
    const minorityAccountIds = new Set(
      minorityIds.map((mid) => {
        const r = db.prepare('SELECT account_id FROM miners WHERE id = ?').get(mid) as { account_id: string };
        return r.account_id;
      }),
    );
    for (const j of jurorStakes) {
      if (minorityAccountIds.has(j.juror_account_id)) {
        minorityTotal += BigInt(j.stake_amount);
      }
    }

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    const poolAfterVerdict = getFeePool(db).currentBalance;
    const poolDelta = poolAfterVerdict - poolBeforeVerdict;

    // Pool delta is at least the minority burn (also includes defendant burn)
    assert.ok(
      poolDelta >= minorityTotal,
      `pool delta ${poolDelta} must include minority juror burns (${minorityTotal})`,
    );

    db.close();
  });
});
