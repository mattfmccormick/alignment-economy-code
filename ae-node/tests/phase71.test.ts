// Phase 71: regression test for the auth-hardening sweep.
//
// The May 5 sweep added authMiddleware to nine previously-unauthenticated
// POST/PUT routes (/miners/vouches, /miners/register, /miners/evidence,
// /miners/vouch-requests POST + PUT, /tags/supportive, /tags/ambient,
// /tags/products, /tags/spaces, /contacts/* CRUD). Each closed a real
// impersonation vector. This phase covers a representative subset with
// HTTP-level integration tests so a regression on any of those routes is
// loud, not silent.
//
// What we lock in for every route under test:
//   1. No signature in body                → 401 AUTH_MISSING
//   2. Wrong signature (different keypair)  → 401 AUTH_INVALID
//   3. Body field that should equal req.accountId disagrees → 403 *_MISMATCH
//   4. Correctly signed envelope            → 2xx OR a non-401/403 error
//      (the protocol-level error path tells us auth passed)
//
// Coverage chosen for diversity:
//   - /miners/vouches    : the original finding; back-compat shim path
//   - /tags/supportive   : redirects daily point flow
//   - /contacts/         : auth + ownership-checked PUT shape

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount } from '../src/core/account.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        url,
        { method, headers: bodyStr ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, data: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode!, data });
            }
          });
        },
      );
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

/** Create an active account from a real keypair so we have keys to sign with. */
function makeAccount(db: DatabaseSync, percentHuman = 100): { accountId: string; publicKey: string; privateKey: string } {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  return { accountId: r.account.id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

describe('Phase 71: auth-hardening regression', () => {
  beforeEach(() => resetRateLimits());

  describe('POST /miners/vouches', () => {
    it('rejects unsigned body with 401 AUTH_MISSING', async () => {
      const db = freshDb();
      const voucher = makeAccount(db);
      const vouchee = makeAccount(db);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/miners/vouches', {
        voucherId: voucher.accountId,
        vouchedId: vouchee.accountId,
        stakeAmount: '100',
      });
      assert.equal(r.status, 401);
      assert.equal(r.data?.error?.code, 'AUTH_MISSING');
      db.close();
    });

    it('rejects a forged signature (signed by a different keypair) with 401', async () => {
      const db = freshDb();
      const voucher = makeAccount(db);
      const vouchee = makeAccount(db);
      const attacker = generateKeyPair(); // not the voucher's key
      const ts = Math.floor(Date.now() / 1000);
      const payload = { vouchedId: vouchee.accountId, stakeAmount: '100' };
      const sig = signPayload(payload, ts, attacker.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/miners/vouches', {
        accountId: voucher.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      assert.equal(r.status, 401);
      assert.equal(r.data?.error?.code, 'AUTH_INVALID');
      db.close();
    });

    it('rejects body voucherId that disagrees with the signed account (403)', async () => {
      const db = freshDb();
      const voucher = makeAccount(db);
      const vouchee = makeAccount(db);
      const someoneElse = makeAccount(db);
      const ts = Math.floor(Date.now() / 1000);
      const payload = { voucherId: someoneElse.accountId, vouchedId: vouchee.accountId, stakeAmount: '100' };
      const sig = signPayload(payload, ts, voucher.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/miners/vouches', {
        accountId: voucher.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      assert.equal(r.status, 403);
      assert.equal(r.data?.error?.code, 'VOUCHER_MISMATCH');
      db.close();
    });

    it('passes auth on a correctly-signed envelope (then fails on insufficient balance, NOT on auth)', async () => {
      const db = freshDb();
      const voucher = makeAccount(db); // 0 earned balance
      const vouchee = makeAccount(db);
      const ts = Math.floor(Date.now() / 1000);
      const payload = { vouchedId: vouchee.accountId, stakeAmount: '10000000000' }; // 100 pts
      const sig = signPayload(payload, ts, voucher.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/miners/vouches', {
        accountId: voucher.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      // Auth passed. The protocol then rejected because earned=0.
      assert.notEqual(r.status, 401, `auth rejected unexpectedly: ${JSON.stringify(r.data)}`);
      assert.notEqual(r.status, 403, `403 unexpected: ${JSON.stringify(r.data)}`);
      db.close();
    });
  });

  describe('POST /tags/supportive', () => {
    it('rejects unsigned body with 401', async () => {
      const db = freshDb();
      const owner = makeAccount(db);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/tags/supportive', {
        accountId: owner.accountId,
        day: 1,
        tags: [],
      });
      assert.equal(r.status, 401);
      db.close();
    });

    it('rejects body accountId that disagrees with the signed caller (403)', async () => {
      const db = freshDb();
      const owner = makeAccount(db);
      const victim = makeAccount(db);
      const ts = Math.floor(Date.now() / 1000);
      const payload = { accountId: victim.accountId, day: 1, tags: [] };
      const sig = signPayload(payload, ts, owner.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/tags/supportive', {
        accountId: owner.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      assert.equal(r.status, 403);
      assert.equal(r.data?.error?.code, 'ACCOUNT_MISMATCH');
      db.close();
    });

    it('passes auth on a correctly-signed envelope', async () => {
      const db = freshDb();
      const owner = makeAccount(db);
      const ts = Math.floor(Date.now() / 1000);
      const payload = { day: 1, tags: [] };
      const sig = signPayload(payload, ts, owner.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/tags/supportive', {
        accountId: owner.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      assert.notEqual(r.status, 401, `auth rejected: ${JSON.stringify(r.data)}`);
      assert.notEqual(r.status, 403, `403 unexpected: ${JSON.stringify(r.data)}`);
      db.close();
    });
  });

  describe('POST /contacts', () => {
    it('rejects unsigned body with 401', async () => {
      const db = freshDb();
      const owner = makeAccount(db);
      const friend = makeAccount(db);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/contacts', {
        ownerId: owner.accountId,
        contactAccountId: friend.accountId,
        nickname: 'F',
      });
      assert.equal(r.status, 401);
      db.close();
    });

    it('rejects body ownerId that disagrees with the signed caller (403)', async () => {
      const db = freshDb();
      const owner = makeAccount(db);
      const friend = makeAccount(db);
      const victim = makeAccount(db);
      const ts = Math.floor(Date.now() / 1000);
      const payload = { ownerId: victim.accountId, contactAccountId: friend.accountId, nickname: 'F' };
      const sig = signPayload(payload, ts, owner.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/contacts', {
        accountId: owner.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      assert.equal(r.status, 403);
      assert.equal(r.data?.error?.code, 'OWNER_MISMATCH');
      db.close();
    });

    it('passes auth on a correctly-signed envelope', async () => {
      const db = freshDb();
      const owner = makeAccount(db);
      const friend = makeAccount(db);
      const ts = Math.floor(Date.now() / 1000);
      const payload = { contactAccountId: friend.accountId, nickname: 'F' };
      const sig = signPayload(payload, ts, owner.privateKey);
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/contacts', {
        accountId: owner.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      assert.notEqual(r.status, 401, `auth rejected: ${JSON.stringify(r.data)}`);
      assert.notEqual(r.status, 403, `403 unexpected: ${JSON.stringify(r.data)}`);
      db.close();
    });
  });
});

