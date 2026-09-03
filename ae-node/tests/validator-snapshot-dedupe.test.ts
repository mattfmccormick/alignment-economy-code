// Validator snapshots are stored only when the set changes.
//
// Every block used to carry a full copy of the validator set — ~617 bytes
// recording something that changes a handful of times in a chain's life. On the
// real chain that was 30,932 near-identical copies of a two-validator list, and
// roughly 30% of total storage.
//
// The saving is only safe because the read resolves "the set in force at height
// N" rather than "the row stored at height N". These tests pin that equivalence:
// what a caller gets back must be identical to what the old exact-match-on-
// every-block scheme would have returned.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { blockStore, createGenesisBlock } from '../src/core/block.js';
import type { ValidatorInfo } from '../src/core/consensus/IValidatorSet.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  createGenesisBlock(db);
  return db;
}

function validator(id: string, stake = 100n, isActive = true): ValidatorInfo {
  return {
    accountId: id,
    nodePublicKey: `node-${id}`,
    vrfPublicKey: `vrf-${id}`,
    stake,
    isActive,
  };
}

/** Insert a bare block at `n` so there is a row to attach a snapshot to. */
function addBlock(db: DatabaseSync, n: number) {
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (?, 1, ?, 'p', ?, 'm', 0)`,
  ).run(n, 1_700_000_000 + n, `hash-${n}`);
}

function storedSnapshotCount(db: DatabaseSync): number {
  const r = db
    .prepare('SELECT COUNT(*) c FROM blocks WHERE validator_snapshot IS NOT NULL')
    .get() as { c: number };
  return r.c;
}

describe('validator snapshots: stored on change, resolved by lookback', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('writes once for an unchanging set, not once per block', () => {
    const store = blockStore(db);
    const set = [validator('alice'), validator('bob')];

    for (let n = 1; n <= 50; n++) {
      addBlock(db, n);
      store.saveValidatorSnapshot(n, set);
    }

    assert.equal(
      storedSnapshotCount(db),
      1,
      '50 blocks with an unchanged set should store exactly one snapshot',
    );
    db.close();
  });

  it('every height still resolves to the correct set', () => {
    const store = blockStore(db);
    const two = [validator('alice'), validator('bob')];
    const three = [validator('alice'), validator('bob'), validator('carol')];

    for (let n = 1; n <= 5; n++) { addBlock(db, n); store.saveValidatorSnapshot(n, two); }
    for (let n = 6; n <= 10; n++) { addBlock(db, n); store.saveValidatorSnapshot(n, three); }

    // Heights 1-5 see two validators even though only height 1 has a row.
    for (const h of [1, 2, 3, 4, 5]) {
      const s = store.findValidatorSnapshot(h);
      assert.equal(s?.length, 2, `height ${h} should resolve to the 2-validator set`);
    }
    // Heights 6-10 see three, and only height 6 stored a row.
    for (const h of [6, 7, 8, 9, 10]) {
      const s = store.findValidatorSnapshot(h);
      assert.equal(s?.length, 3, `height ${h} should resolve to the 3-validator set`);
    }

    assert.equal(storedSnapshotCount(db), 2, 'one row per actual change');
    db.close();
  });

  it('notices a stake change, not just membership', () => {
    const store = blockStore(db);
    addBlock(db, 1);
    store.saveValidatorSnapshot(1, [validator('alice', 100n)]);
    addBlock(db, 2);
    store.saveValidatorSnapshot(2, [validator('alice', 250n)]);

    assert.equal(storedSnapshotCount(db), 2, 'a stake change is a change');
    assert.equal(store.findValidatorSnapshot(2)?.[0].stake, 250n);
    assert.equal(store.findValidatorSnapshot(1)?.[0].stake, 100n);
    db.close();
  });

  it('notices deactivation', () => {
    const store = blockStore(db);
    addBlock(db, 1);
    store.saveValidatorSnapshot(1, [validator('alice', 100n, true)]);
    addBlock(db, 2);
    store.saveValidatorSnapshot(2, [validator('alice', 100n, false)]);

    assert.equal(storedSnapshotCount(db), 2);
    assert.equal(store.findValidatorSnapshot(2)?.[0].isActive, false);
    db.close();
  });

  it('is not fooled by ordering differences', () => {
    const store = blockStore(db);
    addBlock(db, 1);
    store.saveValidatorSnapshot(1, [validator('alice'), validator('bob')]);
    addBlock(db, 2);
    // Same set, listed the other way round — must not count as a change.
    store.saveValidatorSnapshot(2, [validator('bob'), validator('alice')]);

    assert.equal(
      storedSnapshotCount(db),
      1,
      'a reordered identical set is not a change',
    );
    db.close();
  });
});
