// The state root is recorded per block, so a joining node has something to
// check a snapshot against.
//
// Before this, the root existed only in the gossip payload: a receiver compared
// it once, logged a warning on mismatch, and threw it away. Nothing could ask
// "what was the state at height N?" after the fact, which meant a state
// snapshot could only ever be trusted on the word of whoever handed it over.
//
// Two properties these tests pin, both of which are easy to get subtly wrong:
//
//   1. The lookup is EXACT-match, unlike findValidatorSnapshot's "at or before"
//      walk. A validator set persists until changed, so inheriting the previous
//      row is the right answer there. A state root describes one height and
//      nothing else, so inheriting would let a snapshot verify against state it
//      does not contain — a false pass on the one check that matters.
//   2. The root distinguishes states that differ. Trivial-looking, but the root
//      is only worth recording if it is sensitive to the fields consensus
//      depends on, and a fingerprint that quietly ignores a field is worse than
//      no fingerprint at all.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { blockStore, createGenesisBlock } from '../src/core/block.js';
import { computeStateRoot, recordStateRoot } from '../src/core/state-root.js';
import { createAccount } from '../src/core/account.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  createGenesisBlock(db);
  return db;
}

/** Insert a bare block at `n` so there is a row to attach a root to. */
function addBlock(db: DatabaseSync, n: number) {
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (?, 1, ?, 'p', ?, 'm', 0)`,
  ).run(n, 1_700_000_000 + n, `hash-${n}`);
}

// Deterministic per seed, so the same seed produces the same account id in two
// separate databases. deriveAccountId hex-decodes the public key, so a
// non-hex placeholder decodes to empty and every account collides on one id —
// which silently turns "two ledgers agree" into "two ledgers are both empty".
function pubKeyFor(seed: string): string {
  return Buffer.from(seed.padEnd(32, '.')).toString('hex');
}

function makeAccount(db: DatabaseSync, seed: string) {
  return createAccount(db, 'individual', 1, 0, pubKeyFor(seed)).account;
}

describe('state root persistence', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it('records the root of the state as it stands when called', () => {
    const store = blockStore(db);
    addBlock(db, 1);

    makeAccount(db, 'alice');
    const expected = computeStateRoot(db);
    recordStateRoot(db, 1);

    assert.equal(store.findStateRoot(1), expected);
  });

  it('returns null for a height whose root was never recorded', () => {
    const store = blockStore(db);
    addBlock(db, 1);
    assert.equal(store.findStateRoot(1), null);
  });

  it('does NOT fall back to an earlier height', () => {
    // The whole point of the exact-match lookup. If height 5 answered with
    // height 1's root, a snapshot taken at 5 would "verify" against state from
    // four blocks earlier and the check would pass on wrong data.
    const store = blockStore(db);
    addBlock(db, 1);
    makeAccount(db, 'alice');
    recordStateRoot(db, 1);

    addBlock(db, 5);
    assert.notEqual(store.findStateRoot(1), null, 'precondition: 1 is recorded');
    assert.equal(store.findStateRoot(5), null);
  });

  it('returns null for a block that does not exist', () => {
    assert.equal(blockStore(db).findStateRoot(999), null);
  });

  it('records a different root once state changes', () => {
    const store = blockStore(db);
    addBlock(db, 1);
    makeAccount(db, 'alice');
    recordStateRoot(db, 1);

    addBlock(db, 2);
    makeAccount(db, 'bob');
    recordStateRoot(db, 2);

    const r1 = store.findStateRoot(1);
    const r2 = store.findStateRoot(2);
    assert.ok(r1 && r2);
    assert.notEqual(r1, r2, 'a new account must move the root');
  });

  it('records the same root twice when nothing changed between blocks', () => {
    // Two heights with identical account state hash identically. This is what
    // makes a mismatch between two machines meaningful: a difference can only
    // come from a difference in state, never from the height it was taken at.
    const store = blockStore(db);
    addBlock(db, 1);
    addBlock(db, 2);
    makeAccount(db, 'alice');

    recordStateRoot(db, 1);
    recordStateRoot(db, 2);

    assert.equal(store.findStateRoot(1), store.findStateRoot(2));
  });

  it('overwrites rather than appends when re-recorded at the same height', () => {
    // Idempotence matters because a resumed or retried commit path may reach
    // the same height twice. The last write must win, and it must not error.
    const store = blockStore(db);
    addBlock(db, 1);
    makeAccount(db, 'alice');
    recordStateRoot(db, 1);
    const first = store.findStateRoot(1);

    makeAccount(db, 'bob');
    recordStateRoot(db, 1);
    const second = store.findStateRoot(1);

    assert.notEqual(first, second);
    assert.equal(second, computeStateRoot(db));
  });

  it('does not throw when the block row is missing', () => {
    // recordStateRoot sits on the commit path. A diagnostic write must never be
    // able to take down consensus, so the failure mode is a missing row, not an
    // exception reaching the caller.
    assert.doesNotThrow(() => recordStateRoot(db, 4242));
    assert.equal(blockStore(db).findStateRoot(4242), null);
  });

  it('survives the v16 migration on a database that predates the column', () => {
    // The upgrade path a node with an existing chain actually takes: it has a
    // v15 blocks table with no state_root, restarts on new code, and
    // initializeSchema migrates it. Old rows keep NULL — their roots cannot be
    // reconstructed without replaying from genesis — and new heights record
    // normally.
    const old = new DatabaseSync(':memory:');
    initializeSchema(old);
    // Roll the blocks table back to its v15 shape. DROP + CREATE rather than
    // DROP COLUMN because the latter reparses the stored CREATE TABLE text and
    // chokes on the comments in it; ADD COLUMN, which is all the migration
    // uses, is unaffected.
    old.exec('DROP TABLE blocks');
    old.exec(`CREATE TABLE blocks (
      number INTEGER PRIMARY KEY,
      day INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      merkle_root TEXT NOT NULL,
      transaction_count INTEGER NOT NULL,
      rebase_event TEXT,
      commit_certificate TEXT,
      validator_snapshot TEXT,
      prev_commit_cert_hash TEXT,
      validator_changes TEXT,
      account_registrations TEXT
    )`);
    old.prepare('UPDATE schema_version SET version = 15').run();

    const before = old.prepare('PRAGMA table_info(blocks)').all() as Array<{ name: string }>;
    assert.ok(!before.some((c) => c.name === 'state_root'), 'precondition: v15 shape');

    initializeSchema(old);

    const after = old.prepare('PRAGMA table_info(blocks)').all() as Array<{ name: string }>;
    assert.ok(after.some((c) => c.name === 'state_root'), 'v16 adds the column');

    addBlock(old, 1);
    makeAccount(old, 'alice');
    recordStateRoot(old, 1);
    assert.equal(blockStore(old).findStateRoot(1), computeStateRoot(old));
    old.close();
  });
});

describe('state root sensitivity', () => {
  // A fingerprint is only useful if it moves when the things consensus depends
  // on move. These are the drift cases the root exists to make audible: they
  // previously produced either an unrelated throw much later, or no signal at
  // all.

  it('moves when a balance changes', () => {
    const db = freshDb();
    const a = makeAccount(db, 'alice');
    const before = computeStateRoot(db);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run('12345', a.id);
    assert.notEqual(computeStateRoot(db), before);
    db.close();
  });

  it('moves when percentHuman changes', () => {
    // The case that used to be completely silent. replayTransaction takes
    // netAmount off the wire verbatim and never re-derives the spend multiplier
    // locally, so nodes could hold different views of who is verified and
    // converge on the proposer's arithmetic without anything ever saying so.
    const db = freshDb();
    const a = makeAccount(db, 'alice');
    const before = computeStateRoot(db);
    db.prepare('UPDATE accounts SET percent_human = 100 WHERE id = ?').run(a.id);
    assert.notEqual(computeStateRoot(db), before);
    db.close();
  });

  it('moves when an account exists on one node and not the other', () => {
    const a = freshDb();
    const b = freshDb();
    makeAccount(a, 'alice');
    makeAccount(b, 'alice');
    assert.equal(computeStateRoot(a), computeStateRoot(b), 'precondition: they agree');

    makeAccount(a, 'bob');
    assert.notEqual(computeStateRoot(a), computeStateRoot(b));
    a.close();
    b.close();
  });
});
