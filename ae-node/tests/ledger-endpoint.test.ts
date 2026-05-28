// GET /accounts/:id/ledger — the transaction_log audit trail that powers the
// miner Income and Audit pages. Surfaces every balance change (receives,
// fees, mints, fee-pool/mining distributions, court bounties, burns) newest
// first, paginated.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { createAccount } from '../src/core/account.js';
import { processTransaction } from '../src/core/transaction.js';
import { signPayload } from '../src/core/crypto.js';
import { createApp } from '../src/api/server.js';
import { PRECISION } from '../src/core/constants.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createGenesisBlock(db);
  return db;
}

async function startApp(db: DatabaseSync): Promise<{ port: number; server: Server }> {
  const server = createServer(createApp(db));
  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { port, server };
}

function send(db: DatabaseSync, from: ReturnType<typeof createAccount>, to: ReturnType<typeof createAccount>, amount: bigint, ts: number): void {
  const payload = { from: from.account.id, to: to.account.id, amount: amount.toString(), pointType: 'active' as const, isInPerson: false, memo: '' };
  const signature = signPayload(payload, ts, from.privateKey);
  processTransaction(db, { from: from.account.id, to: to.account.id, amount, pointType: 'active', isInPerson: false, memo: '', timestamp: ts, signature });
}

describe('GET /accounts/:id/ledger', () => {
  it('returns the account audit trail with tx_receive / tx_send / fee entries', async () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 100);
    const receiver = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(pts(1000).toString(), sender.account.id);

    send(db, sender, receiver, pts(50), Math.floor(Date.now() / 1000));

    const { port, server } = await startApp(db);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${receiver.account.id}/ledger`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.data.entries));
      assert.ok(body.data.entries.length >= 1, 'receiver must have at least one log entry');
      assert.equal(body.data.entries[0].account_id, receiver.account.id);
      assert.ok(body.data.entries.some((e: any) => e.change_type === 'tx_receive'));
      assert.equal(typeof body.data.entries[0].amount, 'string'); // bigint serialized

      const sres = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${sender.account.id}/ledger`);
      const sbody = await sres.json() as any;
      const types = new Set(sbody.data.entries.map((e: any) => e.change_type));
      assert.ok(types.has('tx_send'), 'sender ledger includes tx_send');
      assert.ok(types.has('fee'), 'sender ledger includes fee');
    } finally {
      server.close();
    }
  });

  it('returns an empty list for an account with no activity', async () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);

    const { port, server } = await startApp(db);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${acct.account.id}/ledger`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.success, true);
      assert.deepEqual(body.data.entries, []);
      assert.equal(body.data.total, 0);
    } finally {
      server.close();
    }
  });

  it('honors the limit query param while reporting the full total', async () => {
    const db = freshDb();
    const sender = createAccount(db, 'individual', 1, 100);
    const receiver = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(pts(1000).toString(), sender.account.id);

    const base = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) send(db, sender, receiver, pts(5), base + i);

    const { port, server } = await startApp(db);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${sender.account.id}/ledger?limit=2`);
      const body = await res.json() as any;
      assert.equal(body.data.entries.length, 2, 'page is capped at the limit');
      assert.ok(body.data.total > 2, 'total reflects every entry, not just the page');
    } finally {
      server.close();
    }
  });
});
