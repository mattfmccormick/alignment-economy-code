// GET /network/blocks/:number/contents: what a block carried, readable. Backs
// the wallet's block view (Network screen -> block -> transaction). Also pins
// that GET /transactions/:id, which the wallet now uses for anyone's
// transaction, never returns the signatures (audit #2/#3).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { createApp } from '../src/api/server.js';
import { createAccount } from '../src/core/account.js';
import { generateKeyPair } from '../src/core/crypto.js';
import { transactionStore } from '../src/core/transaction.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createGenesisBlock(db);
  return db;
}

async function withApp<T>(db: DatabaseSync, fn: (port: number) => Promise<T>): Promise<T> {
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

// Block 1 carrying one transfer from alice to bob and one vouch op.
function seedBlockWithActivity(db: DatabaseSync): { txId: string; alice: string; bob: string } {
  const alice = createAccount(db, 'individual', 1, 100, generateKeyPair().publicKey).account.id;
  const bob = createAccount(db, 'individual', 1, 100, generateKeyPair().publicKey).account.id;
  const txId = 'tx-block-contents-1';
  const store = transactionStore(db);
  store.insertTransaction({
    id: txId, from: alice, to: bob, amount: '1000000000', fee: '5000000', netAmount: '995000000',
    pointType: 'active', isInPerson: false, recipientIsHuman: false, memo: 'coffee',
    signature: 'secret-signature', receiverSignature: null, timestamp: 1_700_000_000,
  });
  db.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count, vouch_operations)
     VALUES (1, 1, 1700000000, 'prev', 'hash-1', 'root', 1, ?)`,
  ).run(JSON.stringify([{ type: 'vouch_create', voucherId: alice, vouchedId: bob }]));
  store.linkTransactionsToBlock(1, [txId]);
  return { txId, alice, bob };
}

describe('GET /network/blocks/:number/contents', () => {
  it('lists the block\'s transfers and other operations', async () => {
    const db = freshDb();
    const { txId, alice } = seedBlockWithActivity(db);
    const body = await withApp(db, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/network/blocks/1/contents`);
      assert.equal(res.status, 200);
      return (await res.json()) as any;
    });
    assert.equal(body.data.number, 1);
    assert.equal(body.data.transactions.length, 1);
    assert.equal(body.data.transactions[0].id, txId);
    assert.equal(body.data.transactions[0].signature, undefined, 'signature must not be published');
    assert.deepEqual(body.data.operations, [{ kind: 'vouch', type: 'vouch_create', accountId: alice }]);
    db.close();
  });

  it('404s for a block that does not exist', async () => {
    const db = freshDb();
    const res = await withApp(db, (port) => fetch(`http://127.0.0.1:${port}/api/v1/network/blocks/42/contents`));
    assert.equal(res.status, 404);
    db.close();
  });

  it('400s for a non-numeric height', async () => {
    const db = freshDb();
    const res = await withApp(db, (port) => fetch(`http://127.0.0.1:${port}/api/v1/network/blocks/abc/contents`));
    assert.equal(res.status, 400);
    db.close();
  });
});

describe('GET /transactions/:id', () => {
  it('returns the transaction without its signatures', async () => {
    const db = freshDb();
    const { txId } = seedBlockWithActivity(db);
    const body = await withApp(db, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/transactions/${txId}`);
      assert.equal(res.status, 200);
      return (await res.json()) as any;
    });
    assert.equal(body.data.id, txId);
    assert.equal(body.data.blockNumber, 1);
    assert.equal(body.data.signature, undefined);
    assert.equal(body.data.receiverSignature, undefined);
    db.close();
  });
});
