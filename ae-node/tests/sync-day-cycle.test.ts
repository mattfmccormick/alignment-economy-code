// A node catching up must run the day cycle, exactly as the live commit path
// does.
//
// Found bringing a new machine online against a real chain. The BFT commit
// path calls applyChainDayCycle (BftBlockProducer.onCommit); the sync path in
// runner.ts did not. So a syncing node replayed blocks without ever minting:
// every account stayed at zero, and the first historical transaction that
// spent minted points threw
//
//   Replay: insufficient active balance for tx <id>: has 0, needs 10000000000
//
// and the node retried that block forever. A fresh node could not join any
// chain that had seen a day boundary and real activity — which is every chain
// that has been used.
//
// These tests pin the behaviour applyChainDayCycle must have for the sync path
// to work: deterministic from the block timestamp alone, and idempotent, so a
// node replaying history at full speed lands on the same balances the original
// validators reached in real time.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { applyChainDayCycle } from '../src/core/day-cycle.js';
import { generateKeyPair } from '../src/core/crypto.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function makeAccount(db: DatabaseSync) {
  return createAccount(db, 'individual', 1, 100, generateKeyPair().publicKey).account.id;
}

// 08:59 UTC is the cycle boundary. Pick a timestamp comfortably past one.
const DAY = 86_400;
const BOUNDARY = Date.UTC(2026, 0, 2, 9, 30, 0) / 1000; // after 08:59 on day 2

describe('day cycle drives off block timestamps, so sync can replay it', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('mints when replayed blocks cross a boundary, so balances are not zero', () => {
    const id = makeAccount(db);
    assert.equal(getAccount(db, id)!.activeBalance, 0n, 'starts empty');

    // First call only anchors the schedule — matches the live path's
    // first-block bootstrap.
    applyChainDayCycle(db, BOUNDARY - DAY);
    // A later block crosses the boundary and should mint.
    applyChainDayCycle(db, BOUNDARY);

    assert.ok(
      getAccount(db, id)!.activeBalance > 0n,
      'a replayed block past the boundary must mint, or every historical ' +
        'transaction that spends minted points fails to replay',
    );
    db.close();
  });

  it('is idempotent across repeated blocks in the same day', () => {
    const id = makeAccount(db);
    applyChainDayCycle(db, BOUNDARY - DAY);
    applyChainDayCycle(db, BOUNDARY);
    const afterFirst = getAccount(db, id)!.activeBalance;

    // Sync applies many blocks per day; none may re-mint.
    applyChainDayCycle(db, BOUNDARY + 60);
    applyChainDayCycle(db, BOUNDARY + 120);

    assert.equal(
      getAccount(db, id)!.activeBalance,
      afterFirst,
      'replaying more blocks inside the same day must not mint again',
    );
    db.close();
  });

  it('two nodes replaying the same timestamps reach the same balances', () => {
    // The property sync depends on: derive state from block timestamps alone,
    // never from wall-clock, so a node catching up at full speed matches the
    // validators that lived through it.
    const a = freshDb();
    const b = freshDb();
    const kp = generateKeyPair();
    const idA = createAccount(a, 'individual', 1, 100, kp.publicKey).account.id;
    const idB = createAccount(b, 'individual', 1, 100, kp.publicKey).account.id;
    assert.equal(idA, idB, 'same key gives the same account id');

    const stamps = [BOUNDARY - DAY, BOUNDARY, BOUNDARY + 3600, BOUNDARY + DAY];
    for (const t of stamps) applyChainDayCycle(a, t);
    // Same timestamps, different order of arrival is not simulated here —
    // sync is ordered — but the point is identical inputs, identical output.
    for (const t of stamps) applyChainDayCycle(b, t);

    assert.equal(getAccount(a, idA)!.activeBalance, getAccount(b, idB)!.activeBalance);
    assert.equal(getAccount(a, idA)!.earnedBalance, getAccount(b, idB)!.earnedBalance);
    a.close(); b.close();
  });
});
