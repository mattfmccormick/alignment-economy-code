// A miner operation applied on two nodes reaches identical state.
//
// Who is a miner is consensus state (fee split, fee lottery, panel assignment),
// so a registration must move every node's miner set the same way. Before this,
// POST /miners/register applied it to one node only and the sets forked (audit
// #5/#6/#7). Now the operation rides a block; these tests pin that a register
// (and a deregister) leave two independent databases agreeing on the active
// miner set, and that a re-delivered operation is a no-op.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { getMinerByAccount, getActiveMiners } from '../src/mining/registration.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import {
  signMinerRegister,
  signMinerDeregister,
  applyMinerOperation,
  verifyMinerOperation,
  computeMinerOperationsHash,
  deriveMinerId,
} from '../src/mining/miner-operation.js';

interface Party {
  id: string;
  pub: string;
  priv: string;
}
function party(): Party {
  const kp = generateKeyPair();
  return { id: deriveAccountId(kp.publicKey), pub: kp.publicKey, priv: kp.privateKey };
}

function node(...accts: Party[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  for (const a of accts) createAccount(db, 'individual', 1, 100, a.pub);
  return db;
}

// The miner set as a comparable, id-independent fingerprint: the sorted account
// ids of active miners (miner ids are derived deterministically, but comparing
// accounts is the property that matters).
function minerAccounts(db: DatabaseSync): string[] {
  return getActiveMiners(db).map((m) => m.accountId).sort();
}

describe('miner operation determinism across nodes', () => {
  it('a register applied on two nodes yields the same active miner set', () => {
    const alice = party();
    const a = node(alice);
    const b = node(alice);
    assert.deepEqual(minerAccounts(a), []);

    const op = signMinerRegister({ accountId: alice.id, timestamp: 1_700_000_100, accountPrivateKey: alice.priv });
    applyMinerOperation(a, op, 1_700_000_100);
    applyMinerOperation(b, op, 1_700_000_100);

    assert.deepEqual(minerAccounts(a), [alice.id]);
    assert.deepEqual(minerAccounts(a), minerAccounts(b));
    // The miner id is deterministic too, so the rows match, not just the set.
    assert.equal(getMinerByAccount(a, alice.id)!.id, getMinerByAccount(b, alice.id)!.id);
    assert.equal(getMinerByAccount(a, alice.id)!.id, deriveMinerId(op));
    a.close();
    b.close();
  });

  it('register then deregister converges to an empty set on both nodes', () => {
    const alice = party();
    const a = node(alice);
    const b = node(alice);
    const reg = signMinerRegister({ accountId: alice.id, timestamp: 1_700_000_200, accountPrivateKey: alice.priv });
    applyMinerOperation(a, reg, 1_700_000_200);
    applyMinerOperation(b, reg, 1_700_000_200);
    assert.deepEqual(minerAccounts(a), [alice.id]);

    const dereg = signMinerDeregister({ accountId: alice.id, timestamp: 1_700_000_300, accountPrivateKey: alice.priv });
    applyMinerOperation(a, dereg, 1_700_000_300);
    applyMinerOperation(b, dereg, 1_700_000_300);
    assert.deepEqual(minerAccounts(a), []);
    assert.deepEqual(minerAccounts(a), minerAccounts(b));
    a.close();
    b.close();
  });

  it('a re-delivered register is a no-op (idempotent)', () => {
    const alice = party();
    const db = node(alice);
    const op = signMinerRegister({ accountId: alice.id, timestamp: 1_700_000_400, accountPrivateKey: alice.priv });
    applyMinerOperation(db, op, 1_700_000_400);
    const setOnce = minerAccounts(db);
    applyMinerOperation(db, op, 1_700_000_400); // re-delivery
    assert.deepEqual(minerAccounts(db), setOnce);
    // Still exactly one miner, not two.
    assert.equal(getActiveMiners(db).length, 1);
    db.close();
  });

  it('the operations hash is order-independent and the signature verifies', () => {
    const alice = party();
    const bob = party();
    const opA = signMinerRegister({ accountId: alice.id, timestamp: 1_700_000_500, accountPrivateKey: alice.priv });
    const opB = signMinerRegister({ accountId: bob.id, timestamp: 1_700_000_501, accountPrivateKey: bob.priv });
    assert.equal(computeMinerOperationsHash([opA, opB]), computeMinerOperationsHash([opB, opA]));
    assert.equal(verifyMinerOperation(opA, alice.pub), true);
    assert.equal(verifyMinerOperation(opA, bob.pub), false);
  });
});
