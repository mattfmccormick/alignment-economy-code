// A snapshot exported from one node must verify on another.
//
// This is the property scripts/snapshot.mjs rests on: a node can hand its whole
// database to a joiner, and the joiner can tell whether what it received is the
// state the network actually agrees on rather than replaying every block from
// genesis to find out.
//
// The failure this pins down is specific and easy to hit by accident. The node
// runs SQLite in WAL mode, so the newest committed pages live in the -wal
// sidecar, not in ae-node.db. Copying ae-node.db with cp or Explorer while the
// node is running silently omits them, and the result is a database that opens
// fine, reports a plausible height, and holds state from some earlier moment.
// VACUUM INTO reads through a transaction and writes one consistent file. The
// tests below show the difference, so nobody "simplifies" the export back to a
// file copy later.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSchema } from '../src/db/schema.js';
import { blockStore, createGenesisBlock } from '../src/core/block.js';
import { computeStateRoot, recordStateRoot } from '../src/core/state-root.js';
import { createAccount } from '../src/core/account.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ae-snapshot-'));
});

after(() => {
  // Best-effort. On Windows a database handle can outlive close() long enough
  // for rm to hit EPERM, and a failed tmpdir cleanup must not fail the suite.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will reap it */
  }
});

function pubKeyFor(seed: string): string {
  return Buffer.from(seed.padEnd(32, '.')).toString('hex');
}

/** A node's on-disk database, in the WAL mode the real node uses. */
function sourceNode(name: string): { db: DatabaseSync; path: string } {
  const path = join(dir, `${name}.db`);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  initializeSchema(db);
  createGenesisBlock(db);
  return { db, path };
}

function addBlock(db: DatabaseSync, n: number) {
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (?, 1, ?, 'p', ?, 'm', 0)`,
  ).run(n, 1_700_000_000 + n, `hash-${n}`);
}

/**
 * Build a chain with real account state and a root recorded at every height,
 * so the head carries something a joiner can check against.
 */
function buildChain(db: DatabaseSync, heights: number): void {
  for (let n = 1; n <= heights; n++) {
    addBlock(db, n);
    createAccount(db, 'individual', 1, 0, pubKeyFor(`acct-${n}`));
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id != ?').run(
      String(1000 * n),
      'nobody',
    );
    recordStateRoot(db, n);
  }
}

describe('snapshot export and verify', () => {
  it('a VACUUM INTO copy verifies against the root recorded in it', () => {
    // The happy path, and the whole point: state in the exported file hashes to
    // the root that file records for its own head, so a joiner importing it
    // arrives at exactly the state the exporter had at that height.
    const src = sourceNode('happy');
    buildChain(src.db, 12);
    const expected = blockStore(src.db).findStateRoot(12);
    assert.ok(expected, 'precondition: head has a recorded root');

    const out = join(dir, 'happy-snapshot.db');
    src.db.exec(`VACUUM INTO '${out}'`);
    src.db.close();

    const snap = new DatabaseSync(out, { readOnly: true });
    const head = (snap.prepare('SELECT MAX(number) AS h FROM blocks').get() as { h: number }).h;
    assert.equal(head, 12);
    assert.equal(computeStateRoot(snap), expected);
    assert.equal(blockStore(snap).findStateRoot(12), expected);
    snap.close();
  });

  it('the snapshot carries the whole chain, not just the head', () => {
    // A state-only extract would leave the joiner unable to look up parents,
    // validate the chain, or serve sync to anyone else. The export is
    // deliberately the full database; this pins that so a later "let's make the
    // file smaller" change has to argue with a failing test.
    const src = sourceNode('full');
    buildChain(src.db, 8);
    const out = join(dir, 'full-snapshot.db');
    src.db.exec(`VACUUM INTO '${out}'`);
    src.db.close();

    const snap = new DatabaseSync(out, { readOnly: true });
    const store = blockStore(snap);
    for (let n = 1; n <= 8; n++) {
      assert.ok(store.findByNumber(n), `block ${n} present`);
    }
    assert.ok(store.findByNumber(0), 'genesis present');
    snap.close();
  });

  it('a hand copy of a live WAL database is caught, not silently accepted', () => {
    // The failure mode the export exists to avoid. Writes made after the last
    // checkpoint sit in the -wal file; copying only the .db leaves them behind.
    // The copy still opens, still reports a height, and still looks fine — but
    // its accounts no longer hash to the root recorded at that height, so
    // verify rejects it instead of a joiner discovering it hours later.
    const src = sourceNode('torn');
    buildChain(src.db, 5);

    // More state, deliberately left unflushed in the WAL.
    addBlock(src.db, 6);
    createAccount(src.db, 'individual', 1, 0, pubKeyFor('late-arrival'));
    recordStateRoot(src.db, 6);

    assert.ok(existsSync(`${src.path}-wal`), 'precondition: WAL sidecar exists');

    const torn = join(dir, 'torn-copy.db');
    copyFileSync(src.path, torn); // what an operator does by hand

    const recorded = blockStore(src.db).findStateRoot(6);
    assert.ok(recorded);
    src.db.close();

    // Three ways the copy can be wrong, all of which verify must catch:
    // it may not be a readable database at all (the schema itself can live in
    // the WAL on a young file), it may be missing the newest blocks, or it may
    // carry the blocks without the account state that came with them. What must
    // never happen is a torn copy that looks complete AND consistent.
    let looksComplete = false;
    let looksConsistent = false;
    let copy: DatabaseSync | null = null;
    try {
      copy = new DatabaseSync(torn, { readOnly: true });
      const headRow = copy.prepare('SELECT MAX(number) AS h FROM blocks').get() as {
        h: number | null;
      };
      looksComplete = headRow.h === 6;
      const rootAtHead = blockStore(copy).findStateRoot(headRow.h ?? -1);
      looksConsistent = rootAtHead !== null && computeStateRoot(copy) === rootAtHead;
    } catch {
      // Unreadable is the loudest possible rejection.
      looksComplete = false;
      looksConsistent = false;
    } finally {
      copy?.close();
    }

    assert.ok(
      !(looksComplete && looksConsistent),
      'a hand copy of a live WAL database must not pass as a complete, consistent snapshot',
    );
  });

  it('two nodes that agree produce the same root at the same height', () => {
    // What --peer checks over HTTP. Same inputs, same recorded root, so a
    // difference between two machines means real drift and never an artefact of
    // when the snapshot was taken.
    const a = sourceNode('peer-a');
    const b = sourceNode('peer-b');
    buildChain(a.db, 6);
    buildChain(b.db, 6);

    assert.equal(blockStore(a.db).findStateRoot(6), blockStore(b.db).findStateRoot(6));
    a.db.close();
    b.db.close();
  });

  it('a node with different state produces a different root at the same height', () => {
    // The other half: verification is only worth running if it can actually
    // fail. One extra account on one side must change the answer.
    const a = sourceNode('drift-a');
    const b = sourceNode('drift-b');
    buildChain(a.db, 6);
    buildChain(b.db, 6);
    assert.equal(
      blockStore(a.db).findStateRoot(6),
      blockStore(b.db).findStateRoot(6),
      'precondition: they agree',
    );

    createAccount(b.db, 'individual', 1, 0, pubKeyFor('extra'));
    recordStateRoot(b.db, 6);

    assert.notEqual(blockStore(a.db).findStateRoot(6), blockStore(b.db).findStateRoot(6));
    a.db.close();
    b.db.close();
  });
});
