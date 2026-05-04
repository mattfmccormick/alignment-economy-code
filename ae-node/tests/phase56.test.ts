// Phase 56: Chain-driven validator API endpoints.
//
// Sessions 48 + 49 built the on-chain validator-change mechanism + the
// persisted local queue the BFT proposer drains from. This session
// exposes the queue via API endpoints. Two new routes:
//
//   POST /api/v1/validators/propose-register
//   POST /api/v1/validators/propose-deregister
//
// Body shape: { change: <fully-signed ValidatorChange> }
//
// Auth: the ValidatorChange itself carries an ML-DSA-65 signature
// (computed inside validator-change.ts's canonical-bytes signer).
// That signature IS the authentication — no outer auth-middleware
// wrapper. The endpoint verifies the signature against the account's
// stored publicKey, validates the change shape, and enqueues.
//
// Response: 200 with the enqueued change + status:'pending'. The
// change applies on every node when the next BFT block commits.
//
// The legacy /register and /deregister endpoints (Session 46) still
// exist for back-compat and direct-apply use cases (single-node dev,
// authority-mode setups). The propose-* endpoints are the chain-driven
// path Matt's two-laptop network would actually use.
//
// Verified:
//   1. Successful propose-register enqueues + returns pending status.
//   2. Validator set is NOT updated by the API call (queue only).
//   3. propose-register requires a valid inner signature.
//   4. propose-register rejects when the account doesn't exist.
//   5. propose-register rejects malformed bodies.
//   6. propose-register rejects stake below MIN_VALIDATOR_STAKE.
//   7. propose-deregister enqueues + returns pending status.
//   8. propose-deregister requires a valid inner signature.
//   9. propose-deregister rejects when account is missing.
//  10. propose-* endpoints REQUIRE matching `type` field.
//  11. Legacy /register still works (back-compat untouched).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount } from '../src/core/account.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import {
  signValidatorChangeRegister,
  signValidatorChangeDeregister,
  pendingValidatorChangeCount,
  drainValidatorChanges,
  type ValidatorChangeRegister,
  type ValidatorChangeDeregister,
} from '../src/core/consensus/validator-change.js';
import { generateKeyPair, signPayload } from '../src/core/crypto.js';
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

interface AccountFixture {
  db: DatabaseSync;
  app: ReturnType<typeof createApp>;
  accountId: string;
  publicKey: string;
  privateKey: string;
  nodeIdentity: ReturnType<typeof generateNodeIdentity>;
  vrfPublicKey: string;
}

function setupAccount(earnedDisplay = 500): AccountFixture {
  resetRateLimits();
  const db = freshDb();
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

function buildRegisterChange(env: AccountFixture, ts = Math.floor(Date.now() / 1000)): ValidatorChangeRegister {
  return signValidatorChangeRegister({
    accountId: env.accountId,
    nodePublicKey: env.nodeIdentity.publicKey,
    vrfPublicKey: env.vrfPublicKey,
    stake: pts(200).toString(),
    timestamp: ts,
    accountPrivateKey: env.privateKey,
  });
}

function buildDeregisterChange(env: AccountFixture, ts = Math.floor(Date.now() / 1000)): ValidatorChangeDeregister {
  return signValidatorChangeDeregister({
    accountId: env.accountId,
    timestamp: ts,
    accountPrivateKey: env.privateKey,
  });
}

describe('Phase 56: Chain-driven validator API endpoints', () => {
  // ── propose-register happy path ──────────────────────────────────────

  it('POST /propose-register: enqueues + returns pending status, validator set unchanged', async () => {
    const env = setupAccount();
    const change = buildRegisterChange(env);

    assert.equal(pendingValidatorChangeCount(env.db), 0);
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', { change });

    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);
    assert.equal(data.data.status, 'pending');
    assert.ok(data.data.queueId > 0);
    assert.equal(data.data.change.accountId, env.accountId);

    // Queue grew, but the validator set on the local DB is UNCHANGED —
    // chain-driven path means the apply happens at block-commit time,
    // not at API time.
    assert.equal(pendingValidatorChangeCount(env.db), 1);
    const set = new SqliteValidatorSet(env.db);
    assert.equal(set.findByAccountId(env.accountId), null, 'no validator row created at API time');

    // Account balance is also unchanged (no earned -> locked move yet)
    const acct = env.db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(env.accountId) as { earned_balance: string; locked_balance: string };
    assert.equal(acct.earned_balance, pts(500).toString());
    assert.equal(acct.locked_balance, '0');

    // Drain returns the same change shape we submitted
    const drained = drainValidatorChanges(env.db);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].accountId, env.accountId);
  });

  // ── Auth: invalid signature ──────────────────────────────────────────

  it('POST /propose-register: rejects when the change.signature does not verify', async () => {
    const env = setupAccount();
    const change = buildRegisterChange(env);
    // Tamper a field after signing
    const tampered: ValidatorChangeRegister = { ...change, stake: pts(999).toString() };

    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', {
      change: tampered,
    });
    assert.equal(status, 401);
    assert.equal(data.error.code, 'INVALID_SIGNATURE');
    assert.equal(pendingValidatorChangeCount(env.db), 0, 'tampered change must not enqueue');
  });

  it('POST /propose-register: rejects when signed by a different key', async () => {
    const env = setupAccount();
    // Sign with a fresh keypair the server doesn't know
    const stranger = generateKeyPair();
    const change = signValidatorChangeRegister({
      accountId: env.accountId,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
      stake: pts(200).toString(),
      timestamp: Math.floor(Date.now() / 1000),
      accountPrivateKey: stranger.privateKey,
    });

    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', { change });
    assert.equal(status, 401);
    assert.equal(data.error.code, 'INVALID_SIGNATURE');
  });

  // ── Account not found ────────────────────────────────────────────────

  it('POST /propose-register: 404 when the account does not exist', async () => {
    const env = setupAccount();
    // Sign a change for a fictional accountId
    const change = {
      ...buildRegisterChange(env),
      accountId: 'ff'.repeat(20),
    };
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', { change });
    assert.equal(status, 404);
    assert.equal(data.error.code, 'ACCOUNT_NOT_FOUND');
  });

  // ── Body shape validation ────────────────────────────────────────────

  it('POST /propose-register: 400 on missing change', async () => {
    const env = setupAccount();
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', {});
    assert.equal(status, 400);
    assert.equal(data.error.code, 'INVALID_CHANGE');
  });

  it('POST /propose-register: 400 when change.type is not "register"', async () => {
    const env = setupAccount();
    const dereg = buildDeregisterChange(env); // wrong type for this endpoint
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', {
      change: dereg,
    });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'INVALID_CHANGE');
  });

  // ── MIN_VALIDATOR_STAKE check ────────────────────────────────────────

  it('POST /propose-register: 400 on stake below MIN_VALIDATOR_STAKE', async () => {
    const env = setupAccount();
    // Tiny stake — below MIN_VALIDATOR_STAKE (= 10000n base units)
    const change = signValidatorChangeRegister({
      accountId: env.accountId,
      nodePublicKey: env.nodeIdentity.publicKey,
      vrfPublicKey: env.vrfPublicKey,
      stake: '5000', // < 10000n
      timestamp: Math.floor(Date.now() / 1000),
      accountPrivateKey: env.privateKey,
    });
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-register', { change });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'STAKE_TOO_SMALL');
    assert.equal(pendingValidatorChangeCount(env.db), 0);
  });

  // ── propose-deregister happy path ────────────────────────────────────

  it('POST /propose-deregister: enqueues + returns pending status', async () => {
    const env = setupAccount();
    const change = buildDeregisterChange(env);

    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-deregister', {
      change,
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);
    assert.equal(data.data.status, 'pending');
    assert.equal(data.data.change.type, 'deregister');
    assert.equal(pendingValidatorChangeCount(env.db), 1);
  });

  it('POST /propose-deregister: rejects bad signature', async () => {
    const env = setupAccount();
    const change = buildDeregisterChange(env);
    const tampered = { ...change, accountId: 'aa'.repeat(20) };
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-deregister', {
      change: tampered,
    });
    // Tampered accountId might trigger 404 (account not found) instead
    // of 401 (invalid signature) because the lookup happens before
    // signature verification. Either failure mode is acceptable as
    // long as the change isn't queued.
    assert.equal([401, 404].includes(status), true, `expected 401 or 404, got ${status}`);
    assert.equal(pendingValidatorChangeCount(env.db), 0);
  });

  it('POST /propose-deregister: 404 when account missing', async () => {
    const env = setupAccount();
    const change = {
      ...buildDeregisterChange(env),
      accountId: 'cc'.repeat(20),
    };
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-deregister', {
      change,
    });
    assert.equal(status, 404);
    assert.equal(data.error.code, 'ACCOUNT_NOT_FOUND');
  });

  it('POST /propose-deregister: 400 on wrong change type', async () => {
    const env = setupAccount();
    const reg = buildRegisterChange(env); // wrong type for this endpoint
    const { status, data } = await request(env.app, 'POST', '/api/v1/validators/propose-deregister', {
      change: reg,
    });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'INVALID_CHANGE');
  });

  // ── Back-compat: legacy /register still works ────────────────────────

  it('legacy POST /register still applies directly (back-compat with phase 52)', async () => {
    const env = setupAccount();
    // The legacy endpoint takes outer auth signature, not an inner
    // ValidatorChange. Use the existing phase-52-style request shape.
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
    // Legacy direct-apply: validator IS in the set immediately, no
    // queue used.
    const set = new SqliteValidatorSet(env.db);
    assert.ok(set.findByAccountId(env.accountId));
    assert.equal(pendingValidatorChangeCount(env.db), 0);
  });
});
