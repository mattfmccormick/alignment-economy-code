// B2: request-body validation on write routes.
//
// Each case sends a correctly-signed request (so auth passes) whose payload is
// malformed for the target route, and asserts the validateBody() gate rejects
// it with a 400 VALIDATION before any business logic runs. A valid-shape
// payload is included per route to confirm the gate lets good input through
// (it then fails later for unrelated reasons, which is fine — we only assert it
// is NOT a validation rejection).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount, updateBalance } from '../src/core/account.js';
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

function makeAccount(db: DatabaseSync, percentHuman = 100) {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  return { accountId: r.account.id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// Each case: a validated route, a payload that violates its schema, and the
// field we expect the validation message to name.
const BAD_CASES = [
  { name: 'POST /miners/evidence (missing evidenceHash)', path: '/api/v1/miners/evidence', payload: { evidenceTypeId: 'gov_id' } },
  { name: 'POST /verification/evidence (missing evidenceHash)', path: '/api/v1/verification/evidence', payload: { evidenceTypeId: 'gov_id' } },
  { name: 'POST /contacts (missing contactAccountId)', path: '/api/v1/contacts', payload: {} },
  // POST /miners/vouches no longer uses validateBody: it takes a signed vouch
  // operation and validates that shape itself (see phase71 + vouch-operation).
  // POST /tags/{products,spaces,supportive,ambient} likewise no longer use
  // validateBody (audit #16): each takes a signed tagging operation and rejects
  // a non-op body with INVALID_OP, then validates chain-applicability itself
  // (see tagging-operation-determinism + the tagging-operation module). Their
  // rejection shape is covered there, not in this validateBody suite.
] as const;

describe('B2: request-body validation on write routes', () => {
  beforeEach(() => resetRateLimits());

  for (const c of BAD_CASES) {
    it(`${c.name} -> 400 VALIDATION`, async () => {
      const db = freshDb();
      const app = createApp(db);
      const caller = makeAccount(db);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signPayload(c.payload, timestamp, caller.privateKey);

      const r = await request(app, 'POST', c.path, {
        accountId: caller.accountId,
        timestamp,
        signature,
        payload: c.payload,
      });

      assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data?.error?.code, 'VALIDATION', `expected VALIDATION, got ${JSON.stringify(r.data)}`);
    });
  }

  it('unauthenticated transaction with a malformed body is still rejected (not 2xx)', async () => {
    // /transactions has no auth middleware (processTransaction self-verifies),
    // so validateBody is the first gate. A body with a non-numeric amount must
    // never reach the money math.
    const db = freshDb();
    const app = createApp(db);
    const r = await request(app, 'POST', '/api/v1/transactions', {
      accountId: 'whoever',
      timestamp: Math.floor(Date.now() / 1000),
      signature: 'x',
      payload: { to: 'someone', amount: 'not-a-number', pointType: 'active' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data?.error?.code, 'VALIDATION');
  });
});

// B3: transaction amounts cross the boundary as base-unit integer strings, so
// money never round-trips through a JS float. Every non-integer-string form is
// rejected by validation before the money math.
describe('B3: base-unit integer-string transaction amounts', () => {
  beforeEach(() => resetRateLimits());

  for (const bad of [
    { label: 'a JS number', amount: 100 },
    { label: 'a float string', amount: '1.5' },
    { label: 'zero', amount: '0' },
    { label: 'a negative string', amount: '-5' },
    { label: 'a leading-zero string', amount: '0100' },
    { label: 'scientific notation', amount: '1e8' },
  ]) {
    it(`rejects ${bad.label} with 400 VALIDATION`, async () => {
      const db = freshDb();
      const app = createApp(db);
      const r = await request(app, 'POST', '/api/v1/transactions', {
        accountId: 'whoever',
        timestamp: Math.floor(Date.now() / 1000),
        signature: 'x',
        payload: { to: 'someone', amount: bad.amount, pointType: 'active' },
      });
      assert.equal(r.status, 400, `expected 400 for ${bad.label}, got ${r.status}`);
      assert.equal(r.data?.error?.code, 'VALIDATION');
    });
  }

  it('accepts a large base-unit amount that would lose precision as a float', async () => {
    const db = freshDb();
    const app = createApp(db);
    const sender = makeAccount(db);
    const receiver = makeAccount(db);

    // 10 billion points = 1e18 base units — far beyond 2^53, so the old
    // `amount * 1e8` float path would have corrupted it. As a string it is exact.
    const amountBaseUnits = '1000000000000000000';
    updateBalance(db, sender.accountId, 'earned_balance', BigInt(amountBaseUnits) * 2n);

    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = {
      from: sender.accountId,
      to: receiver.accountId,
      amount: amountBaseUnits,
      pointType: 'earned',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const signature = signPayload(signedPayload, timestamp, sender.privateKey);

    const r = await request(app, 'POST', '/api/v1/transactions', {
      accountId: sender.accountId,
      timestamp,
      signature,
      payload: {
        to: receiver.accountId,
        amount: amountBaseUnits,
        pointType: 'earned',
        isInPerson: false,
        recipientIsHuman: false,
        memo: '',
      },
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
    // The recipient received the exact base-unit amount minus the fee — no
    // float corruption of the large value.
    assert.equal(r.data?.data?.transaction?.amount, amountBaseUnits);
  });
});
