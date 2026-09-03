// The daily mint does not read the node-local miners table (audit #6).
//
// Miner registration is node-local and never replicated, so if the mint skips
// accounts that are registered as miners, two nodes with different miner tables
// mint to different accounts and their ledgers silently fork on the first day
// boundary after any miner registers. These tests pin that the mint is a pure
// function of chain state (active individuals), independent of who is a miner.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { mintDaily } from '../src/core/day-cycle.js';
import { DAILY_ACTIVE_POINTS } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function makeIndividual(db: DatabaseSync, seed: string): string {
  const pub = Buffer.from(seed.padEnd(32, '.')).toString('hex');
  return createAccount(db, 'individual', 1, 100, pub).account.id;
}

describe('daily mint is independent of node-local miner state (audit #6)', () => {
  it('a registered miner account still receives its daily allocation', () => {
    // Before the fix, a miner account was skipped by mintDaily via
    // getActiveMiners(db) - a node-local read. Now every active individual is
    // minted regardless of miner status.
    const db = freshDb();
    const minerAcct = makeIndividual(db, 'miner-and-person');
    registerMiner(db, minerAcct);

    mintDaily(db);

    const after = getAccount(db, minerAcct)!;
    assert.equal(
      after.activeBalance,
      DAILY_ACTIVE_POINTS,
      'a miner account must receive the daily allocation, so the mint does not depend on the local miners table',
    );
    db.close();
  });

  it('mints identically whether or not an account is a registered miner', () => {
    // Two databases with the same accounts; in one, an account is also a miner.
    // The minted balances must be identical - the miner table must not change
    // what the mint produces. This is the exact divergence that used to fork
    // two nodes.
    const withMiner = freshDb();
    const withoutMiner = freshDb();

    const idA1 = makeIndividual(withMiner, 'alice');
    makeIndividual(withMiner, 'bob');
    registerMiner(withMiner, idA1); // alice is a miner here

    makeIndividual(withoutMiner, 'alice');
    makeIndividual(withoutMiner, 'bob'); // nobody is a miner here

    mintDaily(withMiner);
    mintDaily(withoutMiner);

    // Same account ids (deterministic pubkeys) -> compare each account's mint.
    for (const seed of ['alice', 'bob']) {
      const id = makeIdFor(seed);
      const a = getAccount(withMiner, id)!;
      const b = getAccount(withoutMiner, id)!;
      assert.equal(a.activeBalance, b.activeBalance, `${seed} active mint must match`);
      assert.equal(a.supportiveBalance, b.supportiveBalance, `${seed} supportive mint must match`);
      assert.equal(a.ambientBalance, b.ambientBalance, `${seed} ambient mint must match`);
    }
    withMiner.close();
    withoutMiner.close();
  });
});

// deriveAccountId of the same deterministic pubkey, so the two DBs name the same
// accounts. Mirrors makeIndividual's key construction.
import { deriveAccountId } from '../src/core/crypto.js';
function makeIdFor(seed: string): string {
  return deriveAccountId(Buffer.from(seed.padEnd(32, '.')).toString('hex'));
}
