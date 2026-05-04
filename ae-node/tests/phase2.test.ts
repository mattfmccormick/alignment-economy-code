import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { signPayload } from '../src/core/crypto.js';
import { createAccount, getAccount, updateBalance, getAllAccounts } from '../src/core/account.js';
import { processTransaction } from '../src/core/transaction.js';
import {
  expireDaily, mintDaily, rebase, runDayCycle, getCycleState,
} from '../src/core/day-cycle.js';
import {
  createGenesisBlock, createBlock, getLatestBlock, validateBlock, validateChain,
} from '../src/core/block.js';
import {
  DAILY_ACTIVE_POINTS, DAILY_SUPPORTIVE_POINTS, DAILY_AMBIENT_POINTS,
  TARGET_EARNED_PER_PERSON, PRECISION,
} from '../src/core/constants.js';

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

function toDisplay(base: bigint): number {
  return Number(base) / Number(PRECISION);
}

function sendActive(
  db: DatabaseSync,
  from: { id: string; privateKey: string },
  to: { id: string },
  amount: bigint,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    from: from.id, to: to.id, amount: amount.toString(),
    pointType: 'active', isInPerson: false, memo: '',
  };
  const signature = signPayload(payload, timestamp, from.privateKey);
  return processTransaction(db, {
    from: from.id, to: to.id, amount, pointType: 'active',
    isInPerson: false, memo: '', timestamp, signature,
  });
}

describe('Phase 2: Daily Cycle', () => {

  // Test 1: WHITE PAPER VALIDATION - 12 participant simulation
  it('matches the white paper 12-participant simulation', () => {
    const db = freshDb();
    createGenesisBlock(db);

    // We'll track accounts as they join
    const people: Array<{ id: string; privateKey: string; joinDay: number }> = [];

    function addPerson(day: number) {
      const result = createAccount(db, 'individual', day, 100);
      people.push({ id: result.account.id, privateKey: result.privateKey, joinDay: day });
      return result;
    }

    // Simulate 15 days with people joining per the white paper schedule:
    // Day 1: A, B join
    // Day 2: C joins
    // Day 3: D joins
    // Day 4: E, F join
    // Day 5: G joins
    // Day 6: H, I, J join (10 total)
    // Day 7: K joins (11 total)
    // Day 8: L joins (12 total)

    const joinSchedule: Record<number, number> = {
      1: 2, 2: 1, 3: 1, 4: 2, 5: 1, 6: 3, 7: 1, 8: 1,
    };

    for (let day = 1; day <= 15; day++) {
      // New people join
      const joinCount = joinSchedule[day] || 0;
      for (let j = 0; j < joinCount; j++) {
        addPerson(day);
      }

      // Step 1: Expire previous day's unspent
      expireDaily(db);

      // Step 2: Mint
      mintDaily(db);

      // Step 3: Everyone sends all their Active points to someone else
      // Each person sends to the next person (circular)
      const activePeople = people.filter((p) => p.joinDay <= day);
      for (let i = 0; i < activePeople.length; i++) {
        const sender = activePeople[i];
        const receiver = activePeople[(i + 1) % activePeople.length];
        const acct = getAccount(db, sender.id)!;
        if (acct.activeBalance > 0n) {
          sendActive(db, sender, receiver, acct.activeBalance);
        }
      }

      // Step 4: Rebase
      const event = rebase(db);

      if (event) {
        const participantCount = activePeople.length;

        // Day 1: 2 participants, each sent 1440 to each other
        // Pre-rebase earned total from transactions (post-fee)
        // Multiplier = target / pre_rebase
        if (day === 1) {
          assert.equal(event.participantCount, 2);
          // Target = 2 * 14400 = 28800
          assert.equal(event.targetTotal, TARGET_EARNED_PER_PERSON * 2n);
          // Multiplier should be high (bootstrapping)
          assert.ok(event.rebaseMultiplier > 5, `Day 1 multiplier should be >5, got ${event.rebaseMultiplier}`);
        }

        // Key checks from white paper:
        if (day === 6) {
          assert.equal(event.participantCount, 10);
        }
        if (day === 7) {
          assert.equal(event.participantCount, 11);
        }
        if (day === 11) {
          assert.equal(event.participantCount, 12);
        }
      }

      // Advance day counter
      db.prepare('UPDATE day_cycle_state SET current_day = current_day + 1 WHERE id = 1').run();
    }

    // Verify: all 12 people have earned balances
    for (const person of people) {
      const acct = getAccount(db, person.id)!;
      assert.ok(acct.earnedBalance > 0n, `Person joined day ${person.joinDay} should have earned balance`);
    }

    // Verify: the rebase preserves the economy total near target
    const allAccts = getAllAccounts(db);
    const totalEarned = allAccts.reduce((sum, a) => sum + a.earnedBalance + a.lockedBalance, 0n);
    const expectedTarget = TARGET_EARNED_PER_PERSON * 12n;
    // Should be close to target (within 1% due to rounding)
    const ratio = Number(totalEarned) / Number(expectedTarget);
    assert.ok(ratio > 0.99 && ratio < 1.01, `Total earned pool should be ~target. Ratio: ${ratio}`);

    // Person L (last joiner, day 8) should have a meaningful balance
    const personL = people[people.length - 1];
    const lAcct = getAccount(db, personL.id)!;
    assert.ok(toDisplay(lAcct.earnedBalance) > 1000, `Person L should have >1000 pts, has ${toDisplay(lAcct.earnedBalance)}`);

    db.close();
  });

  // Test 2: Unspent Active points expire
  it('expires unspent Active points correctly', () => {
    const db = freshDb();
    const a = createAccount(db, 'individual', 1, 100);

    // Mint gives active points
    mintDaily(db);
    assert.equal(getAccount(db, a.account.id)!.activeBalance, DAILY_ACTIVE_POINTS);

    // Expire clears them
    expireDaily(db);
    assert.equal(getAccount(db, a.account.id)!.activeBalance, 0n);

    // Check audit trail
    const logs = db.prepare(
      "SELECT * FROM transaction_log WHERE account_id = ? AND change_type = 'burn_expire'"
    ).all(a.account.id) as any[];
    assert.ok(logs.length > 0, 'Should have burn_expire log entries');

    db.close();
  });

  // Test 3: Company accounts don't receive mints but DO get rebased
  it('company accounts do not receive mints but DO get rebased', () => {
    const db = freshDb();
    const ind = createAccount(db, 'individual', 1, 100);
    const co = createAccount(db, 'company', 1, 0);

    // Give company some earned balance (from a prior transaction)
    updateBalance(db, co.account.id, 'earned_balance', pts(1000));

    // Mint
    mintDaily(db);

    // Individual got minted
    assert.equal(getAccount(db, ind.account.id)!.activeBalance, DAILY_ACTIVE_POINTS);
    // Company did NOT
    assert.equal(getAccount(db, co.account.id)!.activeBalance, 0n);
    assert.equal(getAccount(db, co.account.id)!.supportiveBalance, 0n);
    assert.equal(getAccount(db, co.account.id)!.ambientBalance, 0n);

    // Now send active points from individual to create earned balances
    const acct = getAccount(db, ind.account.id)!;
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      from: ind.account.id, to: co.account.id, amount: DAILY_ACTIVE_POINTS.toString(),
      pointType: 'active', isInPerson: false, memo: '',
    };
    const sig = signPayload(payload, timestamp, ind.privateKey);
    processTransaction(db, {
      from: ind.account.id, to: co.account.id, amount: DAILY_ACTIVE_POINTS,
      pointType: 'active', timestamp, signature: sig,
    });

    // Rebase
    const coBefore = getAccount(db, co.account.id)!;
    const event = rebase(db);

    // Company balance should have changed from rebase
    const coAfter = getAccount(db, co.account.id)!;
    if (event && event.rebaseMultiplier !== 1) {
      assert.notEqual(coAfter.earnedBalance, coBefore.earnedBalance, 'Company should be rebased');
    }

    db.close();
  });

  // Test 4: Rebase preserves percentage ownership
  it('rebase preserves percentage ownership within rounding tolerance', () => {
    const db = freshDb();

    // Create 5 people with different earned balances
    const accounts = [];
    for (let i = 0; i < 5; i++) {
      const result = createAccount(db, 'individual', 1, 100);
      updateBalance(db, result.account.id, 'earned_balance', pts((i + 1) * 1000));
      accounts.push(result);
    }
    // Balances: 1000, 2000, 3000, 4000, 5000 = 15000 total

    // Calculate percentages before rebase
    const totalBefore = accounts.reduce((s, a) => s + getAccount(db, a.account.id)!.earnedBalance, 0n);
    const pctBefore = accounts.map((a) => {
      const bal = getAccount(db, a.account.id)!.earnedBalance;
      return Number(bal) / Number(totalBefore);
    });

    // Rebase
    rebase(db);

    // Calculate percentages after rebase
    const totalAfter = accounts.reduce((s, a) => s + getAccount(db, a.account.id)!.earnedBalance, 0n);
    const pctAfter = accounts.map((a) => {
      const bal = getAccount(db, a.account.id)!.earnedBalance;
      return Number(bal) / Number(totalAfter);
    });

    // Each person's percentage should be preserved within 0.01%
    for (let i = 0; i < 5; i++) {
      const diff = Math.abs(pctBefore[i] - pctAfter[i]);
      assert.ok(diff < 0.0001, `Account ${i}: pct before ${pctBefore[i]}, after ${pctAfter[i]}, diff ${diff}`);
    }

    db.close();
  });

  // Test 5: Block validation
  it('creates and validates a chain of 10 blocks', () => {
    const db = freshDb();
    createGenesisBlock(db);

    for (let i = 1; i <= 10; i++) {
      createBlock(db, i, [`tx-${i}-a`, `tx-${i}-b`]);
    }

    const result = validateChain(db);
    assert.equal(result.valid, true);

    // Verify chain length
    const latest = getLatestBlock(db)!;
    assert.equal(latest.number, 10);

    db.close();
  });

  // Test 6: Tampered block detected
  it('detects tampered block data', () => {
    const db = freshDb();
    createGenesisBlock(db);
    createBlock(db, 1, ['tx1']);
    createBlock(db, 2, ['tx2']);

    // Tamper with block 1's hash
    db.prepare("UPDATE blocks SET hash = 'deadbeef' WHERE number = 1").run();

    const result = validateChain(db);
    assert.equal(result.valid, false);
    assert.ok(result.error, 'Should have error message');

    db.close();
  });

  // Test 7: Full runDayCycle completes correctly
  it('runDayCycle executes expire -> mint -> rebase in order', () => {
    const db = freshDb();
    createGenesisBlock(db);

    // Create 3 people
    const accounts = [];
    for (let i = 0; i < 3; i++) {
      const r = createAccount(db, 'individual', 1, 100);
      accounts.push(r);
    }

    // Give them some earned balance so rebase has something to work with
    for (const a of accounts) {
      updateBalance(db, a.account.id, 'earned_balance', pts(1000));
    }

    // First mint to give them active points
    mintDaily(db);

    // Everyone sends their active to the next person
    for (let i = 0; i < accounts.length; i++) {
      const sender = accounts[i];
      const receiver = accounts[(i + 1) % accounts.length];
      const acct = getAccount(db, sender.account.id)!;
      if (acct.activeBalance > 0n) {
        const ts = Math.floor(Date.now() / 1000) + i;
        const payload = {
          from: sender.account.id, to: receiver.account.id, amount: acct.activeBalance.toString(),
          pointType: 'active', isInPerson: false, memo: '',
        };
        processTransaction(db, {
          from: sender.account.id, to: receiver.account.id, amount: acct.activeBalance,
          pointType: 'active', timestamp: ts, signature: signPayload(payload, ts, sender.privateKey),
        });
      }
    }

    // Now run full day cycle
    const event = runDayCycle(db);

    // Should have rebased
    assert.ok(event, 'Rebase event should be returned');
    assert.equal(event!.participantCount, 3);

    // Active balances should be fresh (minted by cycle)
    for (const a of accounts) {
      const acct = getAccount(db, a.account.id)!;
      assert.equal(acct.activeBalance, DAILY_ACTIVE_POINTS, 'Active should be freshly minted');
    }

    // Day should have advanced
    const state = getCycleState(db);
    assert.equal(state.currentDay, 2);

    db.close();
  });
});
