// The tier-2 fee lottery seeds on the PARENT block's hash, not the current
// block's hash (audit #17).
//
// The current block's hash is chosen by the proposer, who can grind its content
// and timestamp; if the lottery seeded on it, a validator that also runs a
// tier-2 miner could win every block it proposes. The parent hash is committed
// history the current proposer cannot alter for this block, so these tests pin
// two properties:
//   1. changing the CURRENT block's hash does not change the winner, and
//   2. changing the PARENT block's hash can.
// Both while staying fully deterministic (same inputs -> same winner).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import { distributeFeesPublicLottery } from '../src/mining/rewards.js';
import { PRECISION } from '../src/core/constants.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

/** A DB with a genesis block and a block 1 whose hash we control (the parent). */
function dbWithParentHash(parentHash: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  // genesis
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (0, 0, 1700000000, '', 'genesis', 'm', 0)`,
  ).run();
  // block 1 = the parent of block 2, with a caller-controlled hash
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (1, 1, 1700000001, 'genesis', ?, 'm', 0)`,
  ).run(parentHash);
  return db;
}

/** Register `n` tier-2 miners with deterministic public keys, return their ids. */
function makeTier2Miners(db: DatabaseSync, n: number): Array<{ accountId: string; minerId: string }> {
  const out: Array<{ accountId: string; minerId: string }> = [];
  for (let i = 0; i < n; i++) {
    // Deterministic public key per index so the miner set is identical across
    // the separate DBs these tests build - otherwise a different winner could
    // come from a different miner set rather than from the seed.
    const pub = Buffer.from(`miner-${i}`.padEnd(32, '.')).toString('hex');
    const acct = createAccount(db, 'individual', 1, 100, pub);
    updateBalance(db, acct.account.id, 'earned_balance', pts(1000));
    const miner = registerMiner(db, acct.account.id);
    setMinerTier(db, miner.id, 2, 'test');
    out.push({ accountId: acct.account.id, minerId: miner.id });
  }
  return out;
}

function winnerAccountAt(
  db: DatabaseSync,
  miners: Array<{ accountId: string; minerId: string }>,
  blockNumber: number,
  currentHash: string,
): string {
  const dist = distributeFeesPublicLottery(db, blockNumber, currentHash, pts(100));
  assert.ok(dist, 'expected a distribution');
  assert.ok(dist!.lotteryWinnerId, 'expected a lottery winner');
  // minerId is a random uuid per DB; map it to the deterministic account id so
  // winners are comparable across separately-built databases.
  const winner = miners.find((m) => m.minerId === dist!.lotteryWinnerId);
  assert.ok(winner, 'winner miner id should be one we registered');
  return winner!.accountId;
}

describe('fee lottery seeds on the parent hash (audit #17)', () => {
  it('is deterministic: same parent + same miners -> same winner', () => {
    const a = dbWithParentHash('PARENT-X');
    const b = dbWithParentHash('PARENT-X');
    const ma = makeTier2Miners(a, 4);
    const mb = makeTier2Miners(b, 4);
    // Same parent, same accounts -> same winning account.
    assert.equal(winnerAccountAt(a, ma, 2, 'current-A'), winnerAccountAt(b, mb, 2, 'current-A'));
    a.close();
    b.close();
  });

  it('the winner does NOT depend on the current (proposer-chosen) block hash', () => {
    // The core of the fix. Two identical chains, same parent, distributing block
    // 2 under DIFFERENT current-block hashes. Before the fix the winner was
    // sha256(currentHash | accountId), so a different currentHash gave a
    // different winner and the proposer could grind it. Now it must not move.
    const a = dbWithParentHash('PARENT-SAME');
    const b = dbWithParentHash('PARENT-SAME');
    const ma = makeTier2Miners(a, 5);
    const mb = makeTier2Miners(b, 5);
    const winnerA = winnerAccountAt(a, ma, 2, 'proposer-grinds-this-A');
    const winnerB = winnerAccountAt(b, mb, 2, 'proposer-grinds-this-B-completely-different');
    assert.equal(
      winnerA,
      winnerB,
      'a proposer changing the current block hash must not change the lottery winner',
    );
    a.close();
    b.close();
  });

  it('the winner CAN change when the PARENT hash differs', () => {
    // Sanity that the seed is actually consulted: a different, uncontrollable
    // parent hash can select a different winner. We try a handful of parents and
    // require that not all produce the same winner (a fixed winner would mean
    // the seed was ignored).
    const winners = new Set<string>();
    for (const parent of ['P-alpha', 'P-bravo', 'P-charlie', 'P-delta', 'P-echo', 'P-foxtrot']) {
      const db = dbWithParentHash(parent);
      const m = makeTier2Miners(db, 5);
      winners.add(winnerAccountAt(db, m, 2, 'same-current-hash'));
      db.close();
    }
    assert.ok(
      winners.size > 1,
      'different parent hashes should be able to select different winners; the seed is not being consulted',
    );
  });
});
