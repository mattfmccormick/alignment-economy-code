import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance, countActiveParticipants } from '../src/core/account.js';
import { processTransaction } from '../src/core/transaction.js';
import { signPayload } from '../src/core/crypto.js';
import { createGenesisBlock, createBlock, getLatestBlock, validateChain } from '../src/core/block.js';
import { runDayCycle, getCycleState } from '../src/core/day-cycle.js';
import { registerMiner } from '../src/mining/registration.js';
import { calculateScore } from '../src/verification/scoring.js';
import { createVouch } from '../src/verification/vouching.js';
import { fileChallenge, selectJury, submitVote, resolveVerdict } from '../src/court/court.js';
import { registerProduct, linkManufacturer } from '../src/tagging/products.js';
import { submitSupportiveTags, finalizeSupportiveTags } from '../src/tagging/supportive.js';
import { PRECISION, DAILY_ACTIVE_POINTS, DAILY_SUPPORTIVE_POINTS, DAILY_AMBIENT_POINTS } from '../src/core/constants.js';
import { Mempool } from '../src/network/mempool.js';
import { AuthorityConsensus } from '../src/network/consensus.js';

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

describe('Phase 12: Integration Tests', () => {

  // Test 1: Full lifecycle - create, transact, day cycle, verify chain
  it('runs a complete 3-day economic simulation with 5 participants', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const accounts = [];
    for (let i = 0; i < 5; i++) {
      accounts.push(createAccount(db, 'individual', 1, 100));
    }

    for (let day = 0; day < 3; day++) {
      const rebaseEvent = runDayCycle(db);

      if (day > 0 && rebaseEvent) {
        assert.equal(rebaseEvent.participantCount, 5);
      }

      // Sign and send a real transaction
      const sender = accounts[day % 5];
      const receiver = accounts[(day + 1) % 5];
      const senderAcct = getAccount(db, sender.account.id)!;
      const txAmount = pts(100);

      if (senderAcct.activeBalance >= txAmount) {
        const timestamp = Math.floor(Date.now() / 1000);
        const payload = {
          from: sender.account.id,
          to: receiver.account.id,
          amount: txAmount.toString(),
          pointType: 'active' as const,
          isInPerson: false,
          memo: `day ${day}`,
        };
        const signature = signPayload(payload, timestamp, sender.privateKey);

        processTransaction(db, {
          from: sender.account.id,
          to: receiver.account.id,
          amount: txAmount,
          pointType: 'active',
          isInPerson: false,
          memo: `day ${day}`,
          signature,
          timestamp,
        });
      }
    }

    assert.equal(validateChain(db).valid, true);

    for (const acct of accounts) {
      assert.equal(getAccount(db, acct.account.id)!.isActive, true);
    }

    assert.equal(getCycleState(db).currentDay, 4);
  });

  // Test 2: Mining + Court integration
  it('integrates mining and court systems for guilty verdict', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const defendant = createAccount(db, 'individual', 1, 60);
    updateBalance(db, defendant.account.id, 'earned_balance', pts(500));

    // Challenger must be a miner
    const challenger = createAccount(db, 'individual', 1, 100);
    updateBalance(db, challenger.account.id, 'earned_balance', pts(1000));
    registerMiner(db, challenger.account.id);

    // 5 Tier 2 juror miners
    for (let i = 0; i < 5; i++) {
      const acct = createAccount(db, 'individual', 1, 100);
      updateBalance(db, acct.account.id, 'earned_balance', pts(500));
      const miner = registerMiner(db, acct.account.id);
      db.prepare('UPDATE miners SET tier = 2 WHERE id = ?').run(miner.id);
    }

    const courtCase = fileChallenge(db, challenger.account.id, defendant.account.id, 'sybil', 5);
    // fileChallenge sets status to arbitration_open
    assert.equal(courtCase.status, 'arbitration_open');

    const juryMinerIds = selectJury(db, courtCase.id, 'block-hash-123');
    assert.ok(juryMinerIds.length > 0);

    for (const minerId of juryMinerIds) {
      submitVote(db, courtCase.id, minerId, 'not_human');
    }

    const verdict = resolveVerdict(db, courtCase.id);
    assert.equal(verdict, 'guilty');

    assert.equal(getAccount(db, defendant.account.id)!.isActive, false);
  });

  // Test 3: Tagging + Day Cycle integration
  it('processes supportive tags through full day cycle', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const user = createAccount(db, 'individual', 1, 100);
    const manufacturer = createAccount(db, 'company', 1, 0);

    runDayCycle(db);

    const userAcct = getAccount(db, user.account.id)!;
    assert.equal(userAcct.supportiveBalance, DAILY_SUPPORTIVE_POINTS);

    const product = registerProduct(db, 'Quality Chair', 'furniture', user.account.id);
    linkManufacturer(db, product.id, manufacturer.account.id);

    const day = getCycleState(db).currentDay;
    submitSupportiveTags(db, user.account.id, day, [
      { productId: product.id, minutesUsed: 1440 },
    ]);

    // finalizeSupportiveTags takes (db, accountId, day)
    finalizeSupportiveTags(db, user.account.id, day);

    const mfgAcct = getAccount(db, manufacturer.account.id)!;
    assert.ok(mfgAcct.earnedBalance > 0n, 'manufacturer should receive supportive points');
  });

  // Test 4: Vouching builds percent-human score
  it('vouching chain builds percent-human score', () => {
    const db = freshDb();

    const vouchers = [];
    for (let i = 0; i < 10; i++) {
      const acct = createAccount(db, 'individual', 1, 100);
      updateBalance(db, acct.account.id, 'earned_balance', pts(1000));
      vouchers.push(acct);
    }

    const target = createAccount(db, 'individual', 1, 0);

    for (const voucher of vouchers) {
      // createVouch takes bigint for stakeAmount
      createVouch(db, voucher.account.id, target.account.id, pts(50));
    }

    const score = calculateScore(db, target.account.id);
    assert.ok(score.totalScore >= 90, `Expected >= 90, got ${score.totalScore}`);
  });

  // Test 5: Mempool + Consensus determinism
  it('mempool feeds deterministic block production', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const mempool = new Mempool();
    const consensus = new AuthorityConsensus('authority', 'authority');
    assert.equal(consensus.canProduceBlock(), true);

    for (const id of ['tx-c', 'tx-a', 'tx-b']) {
      mempool.add({
        id, from: 'a', to: 'b', amount: pts(10), fee: pts(0.05),
        netAmount: pts(9.95), pointType: 'earned', isInPerson: false,
        memo: '', signature: '', timestamp: 1000, blockNumber: null,
      });
    }

    const pending = mempool.getPending(100);
    const orderedIds = pending.map((t) => t.id);
    const block = createBlock(db, getCycleState(db).currentDay, orderedIds);

    assert.equal(block.transactionCount, 3);
    mempool.removeMany(orderedIds);
    assert.equal(mempool.size(), 0);
    assert.equal(validateChain(db).valid, true);
  });

  // Test 6: New participant joining mid-economy
  it('handles new participant joining after multiple day cycles', () => {
    const db = freshDb();
    createGenesisBlock(db);

    for (let i = 0; i < 3; i++) {
      createAccount(db, 'individual', 1, 100);
    }

    for (let d = 0; d < 5; d++) runDayCycle(db);

    const state = getCycleState(db);
    assert.equal(state.currentDay, 6);

    const newbie = createAccount(db, 'individual', state.currentDay, 50);
    runDayCycle(db);

    const newAcct = getAccount(db, newbie.account.id)!;
    assert.equal(newAcct.activeBalance, DAILY_ACTIVE_POINTS);
    assert.equal(newAcct.supportiveBalance, DAILY_SUPPORTIVE_POINTS);
    assert.equal(newAcct.ambientBalance, DAILY_AMBIENT_POINTS);
    assert.equal(countActiveParticipants(db), 4);
  });

  // Test 7: Chain integrity across all operations
  it('maintains chain integrity through mixed operations', () => {
    const db = freshDb();
    createGenesisBlock(db);

    createAccount(db, 'individual', 1, 100);
    createAccount(db, 'individual', 1, 100);

    runDayCycle(db);

    for (let i = 0; i < 5; i++) {
      createBlock(db, getCycleState(db).currentDay, [`tx-${i}`]);
    }

    runDayCycle(db);

    for (let i = 5; i < 10; i++) {
      createBlock(db, getCycleState(db).currentDay, [`tx-${i}`]);
    }

    assert.equal(validateChain(db).valid, true);
    assert.equal(getLatestBlock(db)!.number, 10);
  });
});
