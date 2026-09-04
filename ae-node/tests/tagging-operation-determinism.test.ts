// A tagging operation applied on two nodes reaches identical state (audit #16).
//
// Products, spaces, and supportive/ambient tag rows were written node-locally,
// so at the day boundary each node finalized a different set and the ledgers
// forked. These ops ride a block and apply deterministically at commit. The
// tests pin: deterministic ids + canonical bytes (including free text that
// contains the pipe the old vouch/miner encoding assumed away), order-
// independent op-set hash, signature verify, idempotent / last-writer-wins
// apply, applicability validation, and two-node convergence of the actual rows.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import { getProduct } from '../src/tagging/products.js';
import { getSpace } from '../src/tagging/spaces.js';
import { getSupportiveTags } from '../src/tagging/supportive.js';
import {
  signProductRegister,
  signSpaceRegister,
  signSupportiveSubmit,
  signAmbientSubmit,
  canonicalBytesFor,
  computeTaggingOperationsHash,
  verifyTaggingOperation,
  validateTaggingOperationApplicable,
  applyTaggingOperation,
  deriveProductId,
  deriveSpaceId,
  type TaggingOperation,
} from '../src/tagging/tagging-operation.js';

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
const TS = 1_700_000_000;

describe('tagging operation determinism across nodes', () => {
  it('a product_register applied on two nodes yields the same product row', () => {
    const alice = party();
    const a = node(alice);
    const b = node(alice);
    const op = signProductRegister({
      accountId: alice.id, name: 'Oak Chair', category: 'furniture', timestamp: TS, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(a, op, TS);
    applyTaggingOperation(b, op, TS);
    const id = deriveProductId(op);
    assert.equal(getProduct(a, id)!.name, 'Oak Chair');
    assert.deepEqual(getProduct(a, id), getProduct(b, id));
    a.close();
    b.close();
  });

  it('canonical bytes survive a name containing a pipe and quotes (the JSON-encoding guarantee)', () => {
    const alice = party();
    const op = signProductRegister({
      accountId: alice.id, name: 'A|B "x"', category: 'c', timestamp: TS, accountPrivateKey: alice.priv,
    });
    // The signed bytes are a JSON positional array — the pipe is inside a JSON
    // string, not a delimiter — so verify succeeds and there is no ambiguity.
    assert.equal(verifyTaggingOperation(op, alice.pub), true);
    assert.ok(canonicalBytesFor(op).includes('A|B \\"x\\"'));
  });

  it('a re-delivered product_register is a no-op; two products stay distinct', () => {
    const alice = party();
    const db = node(alice);
    const op = signProductRegister({
      accountId: alice.id, name: 'Chair', category: 'furniture', timestamp: TS, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(db, op, TS);
    applyTaggingOperation(db, op, TS); // re-delivery
    const count = db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number };
    assert.equal(count.c, 1);
    db.close();
  });

  it('a supportive_tag_submit applied on two nodes yields identical tag rows', () => {
    const alice = party();
    const a = node(alice);
    const b = node(alice);
    // A product must be committed before a tag can reference it.
    const prod = signProductRegister({
      accountId: alice.id, name: 'Laptop', category: 'electronics', timestamp: TS, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(a, prod, TS);
    applyTaggingOperation(b, prod, TS);
    const productId = deriveProductId(prod);

    const submit = signSupportiveSubmit({
      accountId: alice.id, day: 1,
      tags: [{ productId, minutesUsed: 120 }],
      timestamp: TS + 1, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(a, submit, TS + 1);
    applyTaggingOperation(b, submit, TS + 1);

    const ta = getSupportiveTags(a, alice.id, 1);
    const tb = getSupportiveTags(b, alice.id, 1);
    assert.equal(ta.length, 1);
    assert.deepEqual(ta, tb); // same id, same pointsAllocated, same everything
    assert.equal(ta[0].pointsAllocated > 0n, true);
    a.close();
    b.close();
  });

  it('a second supportive submit for the same day replaces the first (last-writer-wins)', () => {
    const alice = party();
    const db = node(alice);
    const prod = signProductRegister({
      accountId: alice.id, name: 'Desk', category: 'furniture', timestamp: TS, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(db, prod, TS);
    const productId = deriveProductId(prod);
    const first = signSupportiveSubmit({
      accountId: alice.id, day: 1, tags: [{ productId, minutesUsed: 60 }], timestamp: TS + 1, accountPrivateKey: alice.priv,
    });
    const second = signSupportiveSubmit({
      accountId: alice.id, day: 1, tags: [{ productId, minutesUsed: 200 }], timestamp: TS + 2, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(db, first, TS + 1);
    applyTaggingOperation(db, second, TS + 2);
    const active = db
      .prepare("SELECT minutes_used FROM supportive_tags WHERE account_id = ? AND day = 1 AND status = 'active'")
      .all(alice.id) as Array<{ minutes_used: number }>;
    assert.equal(active.length, 1);
    assert.equal(active[0].minutes_used, 200); // the second op won
    // Re-delivery of the second op is a no-op.
    applyTaggingOperation(db, second, TS + 2);
    const again = db
      .prepare("SELECT COUNT(*) AS c FROM supportive_tags WHERE account_id = ? AND day = 1 AND status = 'active'")
      .get(alice.id) as { c: number };
    assert.equal(again.c, 1);
    db.close();
  });

  it('the operations hash is order-independent and the signature verifies against the signer only', () => {
    const alice = party();
    const bob = party();
    const opA = signProductRegister({ accountId: alice.id, name: 'A', category: 'x', timestamp: TS, accountPrivateKey: alice.priv });
    const opB = signSpaceRegister({ accountId: bob.id, name: 'Park', spaceType: 'park', collectionRate: 0, timestamp: TS, accountPrivateKey: bob.priv });
    assert.equal(computeTaggingOperationsHash([opA, opB]), computeTaggingOperationsHash([opB, opA]));
    assert.equal(verifyTaggingOperation(opA, alice.pub), true);
    assert.equal(verifyTaggingOperation(opA, bob.pub), false);
  });

  it('validateTaggingOperationApplicable rejects the bad cases', () => {
    const alice = party();
    const db = node(alice);
    // over the 1440-minute cap, referencing a product that does not exist yet
    const badProduct = 'deadbeef'.repeat(5);
    const overCap = signSupportiveSubmit({
      accountId: alice.id, day: 1,
      tags: [{ productId: badProduct, minutesUsed: 2000 }],
      timestamp: TS, accountPrivateKey: alice.priv,
    }) as TaggingOperation;
    // product-not-found fires before the cap in the loop, but either is a non-null rejection
    assert.notEqual(validateTaggingOperationApplicable(db, overCap), null);

    const badSpaceType = signSpaceRegister({
      accountId: alice.id, name: 'X', spaceType: 'galaxy' as never, collectionRate: 0, timestamp: TS, accountPrivateKey: alice.priv,
    });
    assert.notEqual(validateTaggingOperationApplicable(db, badSpaceType), null);

    const badRate = signSpaceRegister({
      accountId: alice.id, name: 'X', spaceType: 'room', collectionRate: 250, timestamp: TS, accountPrivateKey: alice.priv,
    });
    assert.notEqual(validateTaggingOperationApplicable(db, badRate), null);

    // a valid product_register passes
    const good = signProductRegister({ accountId: alice.id, name: 'Chair', category: 'furniture', timestamp: TS, accountPrivateKey: alice.priv });
    assert.equal(validateTaggingOperationApplicable(db, good), null);
    db.close();
  });

  it('a space_register with a parent applies on two nodes to the same hierarchy', () => {
    const alice = party();
    const a = node(alice);
    const b = node(alice);
    const parent = signSpaceRegister({
      accountId: alice.id, name: 'Building', spaceType: 'building', collectionRate: 10, timestamp: TS, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(a, parent, TS);
    applyTaggingOperation(b, parent, TS);
    const parentId = deriveSpaceId(parent);
    const child = signSpaceRegister({
      accountId: alice.id, name: 'Room 1', spaceType: 'room', parentId, collectionRate: 0, timestamp: TS + 1, accountPrivateKey: alice.priv,
    });
    applyTaggingOperation(a, child, TS + 1);
    applyTaggingOperation(b, child, TS + 1);
    const childId = deriveSpaceId(child);
    assert.equal(getSpace(a, childId)!.parentId, parentId);
    assert.deepEqual(getSpace(a, childId), getSpace(b, childId));
    a.close();
    b.close();
  });
});
