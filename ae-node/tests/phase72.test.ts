// Phase 72: extend the auth-hardening regression coverage.
//
// Phase 71 locked in the shared authMiddleware behaviour on three routes.
// But the shared-middleware test would NOT catch a route that simply forgets
// to call authMiddleware — that regression is per-route. This phase adds
// per-route coverage for the remaining high-value money/flow routes so a
// future refactor that drops auth on any of them fails loudly:
//
//   - POST /miners/register   : identity (becomes a verifier)
//   - POST /miners/evidence    : sybil-bypass vector (fake identity evidence)
//   - POST /tags/ambient       : redirects the victim's daily ambient flow
//   - POST /recurring          : schedules transfers out of an account
//
// For each: unsigned body -> 401, forged signature -> 401 AUTH_INVALID,
// and a body identity field that disagrees with the signed caller -> 403.

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

function makeAccount(db: DatabaseSync, percentHuman = 100): { accountId: string; publicKey: string; privateKey: string } {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  return { accountId: r.account.id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// Each entry: a route that must enforce auth, a representative payload, the
// identity field carried in the payload, and the mismatch error code.
const ROUTES = [
  { name: 'POST /miners/register', path: '/api/v1/miners/register', payload: {}, idField: 'accountId', mismatchCode: 'ACCOUNT_MISMATCH' },
  { name: 'POST /miners/evidence', path: '/api/v1/miners/evidence', payload: { evidenceTypeId: 'gov_id', evidenceHash: 'abc123' }, idField: 'accountId', mismatchCode: 'ACCOUNT_MISMATCH' },
  { name: 'POST /tags/ambient', path: '/api/v1/tags/ambient', payload: { day: 1, tags: [] }, idField: 'accountId', mismatchCode: 'ACCOUNT_MISMATCH' },
  { name: 'POST /recurring', path: '/api/v1/recurring', payload: { toId: 'placeholder', amount: '100', pointType: 'earned', schedule: 'daily' }, idField: 'fromId', mismatchCode: 'FROM_MISMATCH' },
] as const;

describe('Phase 72: per-route auth coverage', () => {
  beforeEach(() => resetRateLimits());

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('rejects an unsigned body with 401', async () => {
        const db = freshDb();
        const caller = makeAccount(db);
        const app = createApp(db);
        // No signature/timestamp/payload envelope — just raw fields.
        const r = await request(app, 'POST', route.path, { accountId: caller.accountId, ...route.payload });
        assert.equal(r.status, 401);
        db.close();
      });

      it('rejects a forged signature (different keypair) with 401 AUTH_INVALID', async () => {
        const db = freshDb();
        const caller = makeAccount(db);
        const attacker = generateKeyPair();
        const ts = Math.floor(Date.now() / 1000);
        const sig = signPayload(route.payload, ts, attacker.privateKey);
        const app = createApp(db);
        const r = await request(app, 'POST', route.path, {
          accountId: caller.accountId,
          timestamp: ts,
          signature: sig,
          payload: route.payload,
        });
        assert.equal(r.status, 401);
        assert.equal(r.data?.error?.code, 'AUTH_INVALID');
        db.close();
      });

      it('rejects an identity field that disagrees with the signed caller (403)', async () => {
        const db = freshDb();
        const caller = makeAccount(db);
        const victim = makeAccount(db);
        const ts = Math.floor(Date.now() / 1000);
        // Sign with the caller's key, but claim the victim's id in the payload.
        const payload = { ...route.payload, [route.idField]: victim.accountId };
        const sig = signPayload(payload, ts, caller.privateKey);
        const app = createApp(db);
        const r = await request(app, 'POST', route.path, {
          accountId: caller.accountId,
          timestamp: ts,
          signature: sig,
          payload,
        });
        assert.equal(r.status, 403);
        assert.equal(r.data?.error?.code, route.mismatchCode);
        db.close();
      });
    });
  }
});
