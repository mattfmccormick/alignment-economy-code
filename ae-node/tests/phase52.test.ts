// Phase 52: Validator API surface.
//
// Sessions 41 + 42 + 43 made genesis-time bootstrapping work — every
// validator on a network is seeded from a shared GenesisSpec at boot.
// This session adds the runtime path: an account holder posts a
// signed register or deregister request to the API while the network
// is already running.
//
// Endpoints:
//   POST /api/v1/validators/register     — auth required (ML-DSA sig)
//   POST /api/v1/validators/deregister   — auth required
//   GET  /api/v1/validators              — public list (active only)
//   GET  /api/v1/validators/:accountId   — public single fetch
//
// Verified:
//   1. Successful register stakes the account, returns ValidatorInfo,
//      account row's earned -> locked balance flows correctly.
//   2. Unauthenticated register rejected.
//   3. Wrong-key signature rejected (auth middleware catches).
//   4. Stake exceeding earnedBalance rejected with the protocol's error.
//   5. Stake below MIN_VALIDATOR_STAKE rejected (display-units error).
//   6. Invalid hex node/vrf keys rejected.
//   7. Re-registering the same account rejected.
//   8. Successful deregister unlocks stake; balance flows back.
//   9. Deregister of non-validator rejected.
//  10. GET / lists active validators only.
//  11. GET /:accountId returns single validator or 404.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
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
        {
          method,
          headers: bodyStr ? { 'Content-Type': 'application/json' } : {},
        },
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

/**
 * Set up a fresh DB + app + an account with a balance. Returns the
 * everything the tests need to sign register/deregister calls.
 */
function setupAccount(earnedDisplay = 500): {
  db: DatabaseSync;
  app: ReturnType<typeof createApp>;
  accountId: string;
  publicKey: string;
  privateKey: string;
  nodeIdentity: ReturnType<typeof generateNodeIdentity>;
  vrfPublicKey: string;
} {
  resetRateLimits();
  const db = freshDb();
  // Server-side keypair so we have the privateKey for signing
  const kp = generateKeyPair();
  const acct = createAccount(db, 'individual', 1, 100, kp.publicKey);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    pts(earnedDisplay).toString(),
    acct.account.id,
  );
  const app = createApp(db);
  return {
    db,
    app,
    accountId: acct.account.id,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    nodeIdentity: generateNodeIdentity(),
    vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
  };
}

describe('Phase 52: Validator API surface', () => {
  // ── Successful register ─────────────────────────────────────────────

  it('POST /register: signed payload stakes the account and returns ValidatorInfo', async () => {
    const env = setupAccount();
    const payload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);

    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);
    assert.equal(data.data.accountId, env.accountId);
    assert.equal(data.data.nodePublicKey, env.nodeIdentity.publicKey);
    assert.equal(data.data.vrfPublicKey, env.vrfPublicKey);
    // 200 display * 1e8 PRECISION = 20_000_000_000 fixed
    assert.equal(data.data.stake, pts(200).toString());
    assert.equal(data.data.isActive, true);

    // Account-side accounting flowed: earned -> locked
    const acct = getAccount(env.db, env.accountId)!;
    assert.equal(acct.earnedBalance, pts(500) - pts(200));
    assert.equal(acct.lockedBalance, pts(200));
  });

  // ── Auth failures ────────────────────────────────────────────────────

  it('POST /register: missing signature → 401', async () => {
    const env = setupAccount();
    const payload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      // no signature
      payload,
    });
    assert.equal(status, 401);
    assert.equal(data.error.code, 'AUTH_MISSING');
  });

  it('POST /register: signature from a different key → 401', async () => {
    const env = setupAccount();
    // Sign with a fresh keypair the server doesn't know about
    const wrong = generateKeyPair();
    const payload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, wrong.privateKey);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(status, 401);
    assert.equal(data.error.code, 'AUTH_INVALID');
  });

  // ── Body-validation failures ─────────────────────────────────────────

  it('POST /register: stake exceeding earnedBalance → 400 with protocol message', async () => {
    const env = setupAccount(500);
    const payload = {
      stake: 9999, // way more than 500
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'REGISTER_FAILED');
    assert.match(data.error.message, /Insufficient earned balance/);
  });

  it('POST /register: stake below MIN_VALIDATOR_STAKE → 400 with display-units error', async () => {
    const env = setupAccount();
    // MIN_VALIDATOR_STAKE = 10000n base units. With PRECISION = 10^8,
    // that's 0.0001 display. Anything less trips the floor.
    const payload = {
      stake: 0.00005,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'STAKE_TOO_SMALL');
    assert.match(data.error.message, /below minimum/);
  });

  it('POST /register: invalid nodePublicKey hex → 400', async () => {
    const env = setupAccount();
    const payload = {
      stake: 200,
      nodePublicKey: 'not-hex',
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'REGISTER_FAILED');
    assert.match(data.error.message, /nodePublicKey must be 32 bytes/);
  });

  it('POST /register: re-registering the same account → 400', async () => {
    const env = setupAccount();
    const payload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);

    const first = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(first.status, 200);

    // Sign a fresh request with new keys (the existing nodePublicKey is
    // already taken — we want to hit the "already registered" path, not
    // the duplicate-key path)
    const newNode = generateNodeIdentity();
    const newVrf = Ed25519VrfProvider.generateKeyPair().publicKey;
    const payload2 = {
      stake: 50,
      nodePublicKey: newNode.publicKey,
      vrfPublicKey: newVrf,
    };
    const ts2 = ts + 1;
    const sig2 = signPayload(payload2, ts2, env.privateKey);

    const second = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts2,
      signature: sig2,
      payload: payload2,
    });
    assert.equal(second.status, 400);
    assert.match(second.data.error.message, /already a registered validator/);
  });

  // ── Deregister ──────────────────────────────────────────────────────

  it('POST /deregister: unlocks stake and marks validator inactive', async () => {
    const env = setupAccount(500);

    // Register first
    const regPayload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const regTs = Math.floor(Date.now() / 1000);
    const regSig = signPayload(regPayload, regTs, env.privateKey);
    const reg = await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: regTs,
      signature: regSig,
      payload: regPayload,
    });
    assert.equal(reg.status, 200);

    // Deregister
    const deregPayload = {};
    const deregTs = regTs + 1;
    const deregSig = signPayload(deregPayload, deregTs, env.privateKey);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/deregister', {
      accountId: env.accountId,
      timestamp: deregTs,
      signature: deregSig,
      payload: deregPayload,
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);
    assert.equal(data.data.accountId, env.accountId);
    assert.equal(data.data.isActive, false);
    assert.ok(data.data.deregisteredAt);

    // Stake unlocked back to earned
    const acct = getAccount(env.db, env.accountId)!;
    assert.equal(acct.earnedBalance, pts(500), 'earned restored to original');
    assert.equal(acct.lockedBalance, 0n);
  });

  it('POST /deregister: non-validator → 400', async () => {
    const env = setupAccount();
    const ts = Math.floor(Date.now() / 1000);
    const payload = {};
    const sig = signPayload(payload, ts, env.privateKey);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/deregister', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'DEREGISTER_FAILED');
    assert.match(data.error.message, /not a validator/);
  });

  // ── GET endpoints ───────────────────────────────────────────────────

  it('GET /: lists active validators only', async () => {
    const env = setupAccount();

    // Empty initially
    const empty = await request(env.app, 'GET', '/api/v1/validators');
    assert.equal(empty.status, 200);
    assert.equal(empty.data.success, true);
    assert.equal(empty.data.data.length, 0);
    assert.equal(empty.data.meta.count, 0);

    // After registering, listed
    const payload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);
    await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });

    const listed = await request(env.app, 'GET', '/api/v1/validators');
    assert.equal(listed.data.data.length, 1);
    assert.equal(listed.data.data[0].accountId, env.accountId);

    // After deregister, list is empty (listActive filters)
    const deregPayload = {};
    const deregTs = ts + 1;
    const deregSig = signPayload(deregPayload, deregTs, env.privateKey);
    await request(env.app, 'POST', '/api/v1/validators/deregister', {
      accountId: env.accountId,
      timestamp: deregTs,
      signature: deregSig,
      payload: deregPayload,
    });
    const afterDereg = await request(env.app, 'GET', '/api/v1/validators');
    assert.equal(afterDereg.data.data.length, 0, 'deregistered validator not in active list');
  });

  it('GET /:accountId: returns single validator or 404', async () => {
    const env = setupAccount();

    // Before registering: 404
    const missing = await request(env.app, 'GET', `/api/v1/validators/${env.accountId}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, 'NOT_FOUND');

    // Register and re-fetch
    const payload = {
      stake: 200,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
    };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, env.privateKey);
    await request(env.app, 'POST', '/api/v1/validators/register', {
      accountId: env.accountId,
      timestamp: ts,
      signature: sig,
      payload,
    });
    const found = await request(env.app, 'GET', `/api/v1/validators/${env.accountId}`);
    assert.equal(found.status, 200);
    assert.equal(found.data.data.accountId, env.accountId);
    assert.equal(found.data.data.isActive, true);
  });
});
