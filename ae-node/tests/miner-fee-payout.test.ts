// Fees must actually reach miners, and must not be paid twice.
//
// Found on the live two-laptop network: 4.75 points collected across four
// transactions, total_distributed still 0, nothing in any miner's balance.
//
// Two defects behind it.
//
// 1. commitBlockSideEffects scoped the payout to getBlockTotalFees(blockNumber).
//    A block whose fees land while no miner is active pays nobody —
//    distributeFeesPublicLottery returns null at its zero-miner guard — and
//    because the amount was scoped to that one block, nothing ever revisited it.
//    The fee had already left the sender, so those points were destroyed.
//
// 2. distributeFeesPublicLottery never called distributeFromFeePool, so the
//    pool was a write-only counter claiming value no account held. Once the
//    payout is driven BY the pool balance, that omission would re-pay the same
//    fees every block, so the two fixes only work together.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { getFeePool, addToFeePool } from '../src/core/fee-pool.js';
import { commitBlockSideEffects } from '../src/mining/rewards.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

describe('miner fees: collected fees reach miners', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('pays the pool out to an active miner', () => {
    const a = createAccount(db, 'individual', 1, 100);
    updateBalance(db, a.account.id, 'earned_balance', pts(100));
    registerMiner(db, a.account.id);

    const before = getAccount(db, a.account.id)!.earnedBalance;
    addToFeePool(db, pts(5));

    commitBlockSideEffects(db, 1, 'blockhash-1');

    assert.equal(
      getAccount(db, a.account.id)!.earnedBalance,
      before + pts(5),
      'the miner should receive the fees',
    );
    assert.equal(getFeePool(db).currentBalance, 0n, 'the pool must be drawn down');
    assert.equal(getFeePool(db).totalDistributed, pts(5), 'distribution must be recorded');
    db.close();
  });

  it('does not pay the same fees twice on later blocks', () => {
    const a = createAccount(db, 'individual', 1, 100);
    updateBalance(db, a.account.id, 'earned_balance', pts(100));
    registerMiner(db, a.account.id);

    addToFeePool(db, pts(5));
    commitBlockSideEffects(db, 1, 'blockhash-1');
    const afterFirst = getAccount(db, a.account.id)!.earnedBalance;

    // Three more blocks, no new fees.
    commitBlockSideEffects(db, 2, 'blockhash-2');
    commitBlockSideEffects(db, 3, 'blockhash-3');
    commitBlockSideEffects(db, 4, 'blockhash-4');

    assert.equal(
      getAccount(db, a.account.id)!.earnedBalance,
      afterFirst,
      'an empty pool must pay nothing — otherwise this prints money every block',
    );
    assert.equal(getFeePool(db).currentBalance, 0n);
    db.close();
  });

  it('recovers fees stranded while no miner was active', () => {
    // Fees arrive with nobody to pay. This is the live failure: the payout is
    // skipped, and scoped-to-one-block accounting meant it never came back.
    addToFeePool(db, pts(4.75));
    commitBlockSideEffects(db, 1, 'blockhash-1');
    assert.equal(
      getFeePool(db).currentBalance,
      pts(4.75),
      'with no miners the fees stay in the pool rather than vanishing',
    );

    // A miner appears later.
    const a = createAccount(db, 'individual', 1, 100);
    updateBalance(db, a.account.id, 'earned_balance', pts(100));
    registerMiner(db, a.account.id);
    const before = getAccount(db, a.account.id)!.earnedBalance;

    commitBlockSideEffects(db, 2, 'blockhash-2');

    assert.equal(
      getAccount(db, a.account.id)!.earnedBalance,
      before + pts(4.75),
      'previously stranded fees must be picked up once someone can receive them',
    );
    assert.equal(getFeePool(db).currentBalance, 0n);
    db.close();
  });
});
