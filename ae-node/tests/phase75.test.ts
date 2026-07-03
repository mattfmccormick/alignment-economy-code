// Phase 75: WP v2 §7 blockchain pruning (7-year rolling window).
//
// Blocks older than the configured window are pruned. Genesis (block 0)
// is always preserved. Transactions linked to pruned blocks are deleted.
// Current state (account balances, scores) is unaffected since state
// lives in the latest block, not in history.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { createGenesisBlock, createBlock, getBlock, getLatestBlock, pruneChain } from '../src/core/block.js';
import { processTransaction } from '../src/core/transaction.js';
import { signPayload } from '../src/core/crypto.js';
import { PRECISION } from '../src/core/constants.js';

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

function insertBlockAtTimestamp(db: DatabaseSync, number: number, day: number, timestamp: number): void {
  const prev = getBlock(db, number - 1);
  assert.ok(prev, `Previous block ${number - 1} must exist`);
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(number, day, timestamp, prev.hash, `hash_${number}`, `merkle_${number}`, 0);
}

describe('Phase 75: Blockchain pruning (WP v2 §7)', () => {

  it('prunes blocks older than the history window, preserving genesis', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const sevenYearsAgo = Math.floor(Date.now() / 1000) - (8 * 365.25 * 86400);
    insertBlockAtTimestamp(db, 1, 1, sevenYearsAgo);
    insertBlockAtTimestamp(db, 2, 2, sevenYearsAgo + 86400);
    insertBlockAtTimestamp(db, 3, 3, Math.floor(Date.now() / 1000) - 86400);

    const result = pruneChain(db);
    assert.ok(result.prunedBlocks >= 1, 'should prune at least one old block');
    assert.ok(getBlock(db, 0), 'genesis block must survive');
    assert.ok(getBlock(db, 3), 'recent block must survive');
    db.close();
  });

  it('does nothing when no blocks are old enough', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const recent = Math.floor(Date.now() / 1000) - 86400;
    insertBlockAtTimestamp(db, 1, 1, recent);

    const result = pruneChain(db);
    assert.equal(result.prunedBlocks, 0);
    assert.ok(getBlock(db, 0));
    assert.ok(getBlock(db, 1));
    db.close();
  });

  it('deletes transactions linked to pruned blocks', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const sender = createAccount(db, 'individual', 1, 100);
    const receiver = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'earned_balance', pts(10000));

    const eightYearsAgo = Math.floor(Date.now() / 1000) - Math.round(8 * 365.25 * 86400);
    insertBlockAtTimestamp(db, 1, 1, eightYearsAgo);

    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      from: sender.account.id,
      to: receiver.account.id,
      amount: pts(100).toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const signature = signPayload(payload, timestamp, sender.privateKey);
    const txResult = processTransaction(db, {
      from: sender.account.id,
      to: receiver.account.id,
      amount: pts(100),
      pointType: 'earned',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
      signature,
      timestamp,
    });

    db.prepare('UPDATE transactions SET block_number = ? WHERE id = ?')
      .run(1, txResult.transaction.id);

    const txBefore = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE block_number = 1')
      .get() as { c: number };
    assert.equal(txBefore.c, 1);

    const result = pruneChain(db);
    assert.ok(result.prunedBlocks >= 1);
    assert.ok(result.prunedTransactions >= 1);

    const txAfter = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE block_number = 1')
      .get() as { c: number };
    assert.equal(txAfter.c, 0, 'transactions in pruned blocks should be deleted');
    db.close();
  });

  it('preserves account state after pruning', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const acct = createAccount(db, 'individual', 1, 100);
    updateBalance(db, acct.account.id, 'earned_balance', pts(5000));

    const eightYearsAgo = Math.floor(Date.now() / 1000) - Math.round(8 * 365.25 * 86400);
    insertBlockAtTimestamp(db, 1, 1, eightYearsAgo);
    insertBlockAtTimestamp(db, 2, 2, eightYearsAgo + 86400);

    const balanceBefore = getAccount(db, acct.account.id)!.earnedBalance;
    pruneChain(db);
    const balanceAfter = getAccount(db, acct.account.id)!.earnedBalance;

    assert.equal(balanceAfter, balanceBefore, 'account balances must not change on prune');
    db.close();
  });

  it('respects the governance parameter for window size', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const fourYearsAgo = Math.floor(Date.now() / 1000) - Math.round(4 * 365.25 * 86400);
    insertBlockAtTimestamp(db, 1, 1, fourYearsAgo);

    // Default window is 7 years, so 4-year-old block should survive
    let result = pruneChain(db);
    assert.equal(result.prunedBlocks, 0, 'block within 7-year window should survive');

    // Shrink window to 3 years (bounded min is 3)
    setParam(db, 'blockchain.history_window_years', 3);
    result = pruneChain(db);
    assert.ok(result.prunedBlocks >= 1, 'block outside 3-year window should be pruned');
    db.close();
  });

  it('never prunes genesis block even if it is old', () => {
    const db = freshDb();
    createGenesisBlock(db);

    // Use a nowSeconds far in the future to make genesis very old
    const farFuture = Math.floor(Date.now() / 1000) + Math.round(20 * 365.25 * 86400);
    const result = pruneChain(db, farFuture);
    assert.equal(result.prunedBlocks, 0);
    assert.ok(getBlock(db, 0), 'genesis must always survive');
    db.close();
  });
});
