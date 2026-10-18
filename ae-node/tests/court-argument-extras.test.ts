// A case post can carry more than text: files (name + SHA-256, the file stays
// with its owner) and offers to prove yourself another way ("open to a live
// call", "can meet in person"). The defendant's screen lists the challenger's
// files as the evidence against them, so these must round-trip intact.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, updateBalance } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { fileChallenge, submitArgument, getArgumentsForCase } from '../src/court/court.js';
import { ValidationError } from '../src/core/errors.js';
import { PRECISION } from '../src/core/constants.js';

const HASH = 'a'.repeat(64);

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  const challenger = createAccount(db, 'individual', 1, 100).account.id;
  updateBalance(db, challenger, 'earned_balance', 50_000n * PRECISION);
  registerMiner(db, challenger);
  const defendant = createAccount(db, 'individual', 1, 0).account.id;
  const c = fileChallenge(db, challenger, defendant, 'not_human', 5, 'Opening argument');
  return { db, challenger, defendant, caseId: c.id };
}

describe('court arguments: files and offers', () => {
  it('stores files and offers and reads them back in order', () => {
    const { db, challenger, defendant, caseId } = setup();
    submitArgument(db, caseId, challenger, 'Evidence attached', {
      attachments: [{ name: 'activity-log.csv', hash: HASH.toUpperCase() }],
    });
    // A post can be only an offer, with no text.
    submitArgument(db, caseId, defendant, '', { offers: ['call', 'in_person', 'call'] });

    const log = getArgumentsForCase(db, caseId);
    assert.deepEqual(log.map((a) => a.role), ['challenger', 'challenger', 'defendant']);
    assert.deepEqual(log[0].attachments, []);
    assert.deepEqual(log[1].attachments, [{ name: 'activity-log.csv', hash: HASH }]);
    assert.deepEqual(log[2].offers, ['call', 'in_person']);
    assert.equal(log[2].text, '');
    db.close();
  });

  it('files a challenge with evidence files on the opening argument', () => {
    const { db, challenger } = setup();
    const other = createAccount(db, 'individual', 1, 0).account.id;
    const c = fileChallenge(db, challenger, other, 'not_human', 5, '', undefined, [{ name: 'log.csv', hash: HASH }]);
    const [opening] = getArgumentsForCase(db, c.id);
    assert.equal(opening.text, '');
    assert.deepEqual(opening.attachments, [{ name: 'log.csv', hash: HASH }]);
    db.close();
  });

  it('rejects an empty post, a bad fingerprint and an unknown offer', () => {
    const { db, defendant, caseId } = setup();
    const isValidation = (code: string) => (e: unknown) => e instanceof ValidationError && e.code === code;

    assert.throws(() => submitArgument(db, caseId, defendant, '   '), isValidation('ARGUMENT_REQUIRED'));
    assert.throws(
      () => submitArgument(db, caseId, defendant, 'x', { attachments: [{ name: 'id.jpg', hash: 'not-a-hash' }] }),
      isValidation('INVALID_ATTACHMENT'),
    );
    assert.throws(
      () => submitArgument(db, caseId, defendant, 'x', { offers: ['bribe' as never] }),
      isValidation('INVALID_OFFER'),
    );
    assert.equal(getArgumentsForCase(db, caseId).length, 1); // only the opening argument
    db.close();
  });
});
