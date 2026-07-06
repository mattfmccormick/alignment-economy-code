// W5: nullifier duplicate check (WP §8.2).
//
// The evidence hash is derived from the credential file, so the same document
// always produces the same hash. It must not verify more than one account.
// Before this fix the hash was stored but never checked across accounts, so
// one ID could be submitted to ten accounts — exactly the basic duplicate
// attack the white paper says the nullifier prevents.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { submitEvidence, getEvidenceForAccount } from '../src/verification/evidence.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('W5: nullifier duplicate check', () => {
  it('rejects the same credential hash on a different account', () => {
    const db = freshDb();
    const alice = createAccount(db, 'individual', 1, 0);
    const bob = createAccount(db, 'individual', 1, 0);
    const hash = 'sha256:the-same-passport-scan';

    // Alice registers the credential — fine.
    submitEvidence(db, alice.account.id, 'gov_id', hash);

    // Bob tries the identical file — rejected as a duplicate credential.
    assert.throws(
      () => submitEvidence(db, bob.account.id, 'gov_id', hash),
      /already registered|DUPLICATE_CREDENTIAL/,
    );

    // Bob has no evidence on file; Alice still owns the one record.
    assert.equal(getEvidenceForAccount(db, bob.account.id).length, 0);
    assert.equal(getEvidenceForAccount(db, alice.account.id).length, 1);
  });

  it('allows the same account to re-submit its own credential (re-verification)', () => {
    const db = freshDb();
    const alice = createAccount(db, 'individual', 1, 0);
    const hash = 'sha256:my-own-passport';

    submitEvidence(db, alice.account.id, 'gov_id', hash);
    // Re-uploading the same file on the same account must not be blocked.
    assert.doesNotThrow(() => submitEvidence(db, alice.account.id, 'gov_id', hash));
    assert.equal(getEvidenceForAccount(db, alice.account.id).length, 2);
  });

  it('lets different accounts submit different credentials', () => {
    const db = freshDb();
    const alice = createAccount(db, 'individual', 1, 0);
    const bob = createAccount(db, 'individual', 1, 0);

    submitEvidence(db, alice.account.id, 'gov_id', 'sha256:alice-id');
    assert.doesNotThrow(() => submitEvidence(db, bob.account.id, 'gov_id', 'sha256:bob-id'));
  });
});
