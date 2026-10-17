// No maker, no tag. A product must name the account that made it and a space
// must name the account that runs it, and only those can be tagged, because a
// tag with no recipient burns the person's whole allocation at finalization.
//
// Enforced when an op enters the queue (checkTaggingAdmissionPolicy), NOT in
// validateTaggingOperationApplicable, which block validation also runs: older
// blocks carry maker-less registrations and must still replay. The last test
// pins that split.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount } from '../src/core/account.js';
import { generateKeyPair, signPayload } from '../src/core/crypto.js';
import { registerProduct } from '../src/tagging/products.js';
import { registerSpace } from '../src/tagging/spaces.js';
import {
  signProductRegister,
  signSpaceRegister,
  signSupportiveSubmit,
  signAmbientSubmit,
  validateTaggingOperationApplicable,
  checkTaggingAdmissionPolicy,
  type TaggingOperation,
} from '../src/tagging/tagging-operation.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function makeAccount(db: DatabaseSync): { accountId: string; privateKey: string } {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, 100, kp.publicKey);
  return { accountId: r.account.id, privateKey: kp.privateKey };
}

async function withApp<T>(db: DatabaseSync, fn: (port: number) => Promise<T>): Promise<T> {
  resetRateLimits();
  const server: Server = createServer(createApp(db));
  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

async function postOp(
  port: number,
  path: string,
  who: { accountId: string; privateKey: string },
  op: TaggingOperation,
): Promise<{ status: number; body: any }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { op };
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/tags/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: who.accountId,
      timestamp,
      signature: signPayload(payload, timestamp, who.privateKey),
      payload,
    }),
  });
  return { status: res.status, body: await res.json() };
}

const now = () => Math.floor(Date.now() / 1000);

describe('Tagging needs a recipient account', () => {
  it('registers a product that names its manufacturer', async () => {
    const db = freshDb();
    const owner = makeAccount(db);
    const maker = makeAccount(db);
    const op = signProductRegister({
      accountId: owner.accountId, name: 'Oak chair', category: 'furniture',
      manufacturerId: maker.accountId, timestamp: now(), accountPrivateKey: owner.privateKey,
    });
    const r = await withApp(db, (port) => postOp(port, 'products', owner, op));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'pending');
    db.close();
  });

  it('refuses a product with no manufacturer', async () => {
    const db = freshDb();
    const owner = makeAccount(db);
    const op = signProductRegister({
      accountId: owner.accountId, name: 'Oak chair', category: 'furniture',
      timestamp: now(), accountPrivateKey: owner.privateKey,
    });
    const r = await withApp(db, (port) => postOp(port, 'products', owner, op));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'TAG_RECIPIENT_REQUIRED');
    db.close();
  });

  it('refuses a space with no entity, accepts one with an entity', async () => {
    const db = freshDb();
    const owner = makeAccount(db);
    const runner = makeAccount(db);
    const bare = signSpaceRegister({
      accountId: owner.accountId, name: 'Park', spaceType: 'park', collectionRate: 0,
      timestamp: now(), accountPrivateKey: owner.privateKey,
    });
    const linked = signSpaceRegister({
      accountId: owner.accountId, name: 'Library', spaceType: 'building', collectionRate: 0,
      entityId: runner.accountId, timestamp: now() + 1, accountPrivateKey: owner.privateKey,
    });
    const [refused, accepted] = await withApp(db, async (port) => [
      await postOp(port, 'spaces', owner, bare),
      await postOp(port, 'spaces', owner, linked),
    ]);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'TAG_RECIPIENT_REQUIRED');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    db.close();
  });

  it('refuses tagging an older product that has no manufacturer, allows one that does', async () => {
    const db = freshDb();
    const tagger = makeAccount(db);
    const maker = makeAccount(db);
    const orphan = registerProduct(db, 'Old desk', 'furniture', tagger.accountId);
    const made = registerProduct(db, 'New desk', 'furniture', tagger.accountId, maker.accountId);
    const tagOrphan = signSupportiveSubmit({
      accountId: tagger.accountId, day: 1, tags: [{ productId: orphan.id, minutesUsed: 60 }],
      timestamp: now(), accountPrivateKey: tagger.privateKey,
    });
    const tagMade = signSupportiveSubmit({
      accountId: tagger.accountId, day: 1, tags: [{ productId: made.id, minutesUsed: 60 }],
      timestamp: now() + 1, accountPrivateKey: tagger.privateKey,
    });
    const [refused, accepted] = await withApp(db, async (port) => [
      await postOp(port, 'supportive', tagger, tagOrphan),
      await postOp(port, 'supportive', tagger, tagMade),
    ]);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'TAG_RECIPIENT_REQUIRED');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    db.close();
  });

  it('refuses tagging an older space that has no entity', async () => {
    const db = freshDb();
    const tagger = makeAccount(db);
    const orphan = registerSpace(db, 'Old plaza', 'park');
    const op = signAmbientSubmit({
      accountId: tagger.accountId, day: 1, tags: [{ spaceId: orphan.id, minutesOccupied: 30 }],
      timestamp: now(), accountPrivateKey: tagger.privateKey,
    });
    const r = await withApp(db, (port) => postOp(port, 'ambient', tagger, op));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'TAG_RECIPIENT_REQUIRED');
    db.close();
  });

  it('keeps maker-less registrations valid for block replay', () => {
    // The queue-entry rule must not leak into block validation, or nodes would
    // reject historical blocks that carry these.
    const db = freshDb();
    const owner = makeAccount(db);
    const op = signProductRegister({
      accountId: owner.accountId, name: 'Oak chair', category: 'furniture',
      timestamp: now(), accountPrivateKey: owner.privateKey,
    });
    assert.equal(validateTaggingOperationApplicable(db, op), null);
    assert.match(checkTaggingAdmissionPolicy(db, op) ?? '', /manufacturer account ID is required/);
    db.close();
  });
});
