// A bootstrap miner must not be deactivated by the tier evaluator.
//
// registerMiner exempts the first `mining.bootstrap_miner_count` miners from
// the 50% percentHuman floor, because a new network cannot raise a score
// without a panel, run a panel without a miner, or have a miner without a
// score. evaluateMinerTier did not know that exemption existed and revoked it
// on its first run — so a bootstrap miner registered at percentHuman 0 was
// deactivated moments later and the app reported only "Not registered as a
// miner", with no mention of a score or a route back.
//
// Latent until evaluateMinerTier got a production caller: the two rules had
// never both run before.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, updatePercentHuman } from '../src/core/account.js';
import { registerMiner, getMiner } from '../src/mining/registration.js';
import { evaluateMinerTier } from '../src/mining/tiers.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('miner tiers: the bootstrap exemption survives evaluation', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('keeps a bootstrap miner active at percentHuman 0', () => {
    const a = createAccount(db, 'individual', 1, 0);
    const m = registerMiner(db, a.account.id);
    assert.equal(getMiner(db, m.id)!.isActive, true, 'bootstrap registration should succeed');

    evaluateMinerTier(db, m.id);

    assert.equal(
      getMiner(db, m.id)!.isActive,
      true,
      'the evaluator must not revoke an exemption registration deliberately granted',
    );
    db.close();
  });

  it('still deactivates a low-score miner once the bootstrap window has closed', () => {
    setParam(db, 'mining.bootstrap_miner_count', 1, undefined, undefined, true);

    // First miner takes the exemption.
    const a = createAccount(db, 'individual', 1, 0);
    const first = registerMiner(db, a.account.id);

    // Second registers legitimately at 100, then their score collapses.
    const b = createAccount(db, 'individual', 1, 100);
    const second = registerMiner(db, b.account.id);
    updatePercentHuman(db, b.account.id, 10);

    evaluateMinerTier(db, second.id);

    assert.equal(
      getMiner(db, second.id)!.isActive,
      false,
      'past the bootstrap window the 50% floor must still bite',
    );
    assert.equal(getMiner(db, first.id)!.isActive, true, 'the bootstrap miner is untouched');
    db.close();
  });
});
