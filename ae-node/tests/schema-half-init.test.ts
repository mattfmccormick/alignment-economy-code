// A database whose schema_version table exists but holds no row.
//
// This stranded laptop 2 during the first two-machine run. Its first node
// attempt started before the genesis files were in place, got far enough to
// create every table, and died before inserting the version row. From then on
// initializeSchema read `SELECT version FROM schema_version`, got undefined,
// and crashed with "Cannot read properties of undefined (reading 'version')"
// — a TypeError pointing into schema.ts that says nothing about the real
// problem. It recurred on every start, so the node was permanently unbootable
// until someone knew to delete the file.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { createAccount } from '../src/core/account.js';

describe('initializeSchema: half-initialised databases', () => {
  it('recovers when the version table exists but is empty', () => {
    const db = new DatabaseSync(':memory:');
    // Exactly the state a crash mid-init leaves behind.
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');

    assert.doesNotThrow(() => initializeSchema(db));

    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.ok(row && row.version > 0, 'version row must be written');

    // And the database is actually usable, not just non-throwing.
    const acct = createAccount(db, 'individual', 1, 0);
    assert.ok(acct.account.id);
    db.close();
  });

  it('leaves exactly one version row after recovering', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    initializeSchema(db);
    initializeSchema(db); // idempotent re-entry
    const rows = db.prepare('SELECT version FROM schema_version').all();
    assert.equal(rows.length, 1, 'must not accumulate duplicate version rows');
    db.close();
  });

  it('refuses to guess when there is real data but no version row', () => {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    createAccount(db, 'individual', 1, 0);
    // Simulate a hand-edited / partially-restored file.
    db.prepare('DELETE FROM schema_version').run();

    // Stamping the current version here would skip every migration and leave
    // the schema silently behind the code. Failing loudly is the safe move.
    assert.throws(
      () => initializeSchema(db),
      /schema version cannot be determined/i,
    );
    db.close();
  });

  it('still initialises a genuinely fresh database', () => {
    const db = new DatabaseSync(':memory:');
    assert.doesNotThrow(() => initializeSchema(db));
    const acct = createAccount(db, 'individual', 1, 0);
    assert.ok(acct.account.id);
    db.close();
  });
});
