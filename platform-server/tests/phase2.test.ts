// Phase 2: auth endpoints.
//
// Covers the four routes (signup, signin, signout, me) end to end over
// real HTTP against a fresh in-memory-ish SQLite db. Each test boots a
// new app instance so they don't share state.
//
// What we lock in here:
//   - Signup happy path returns a session token + the server's recovery
//     public key (so the wallet can encrypt future recovery_blobs).
//   - Duplicate email is 409 EMAIL_TAKEN.
//   - Signin happy path returns the vaultBlob the user uploaded at signup
//     (so the wallet can decrypt locally with the password).
//   - Wrong password and unknown email both return the SAME 401 code so
//     a probe cannot enumerate registered emails.
//   - /me requires a session, returns the right user + accountId.
//   - /signout revokes the session: subsequent /me with the same token
//     gets 401 AUTH_REVOKED.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { createApp, openDb } from '../src/index.js';
import { type PlatformConfig } from '../src/config.js';

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-p2-'));
  return join(dir, 'platform.db');
}

function testConfig(): PlatformConfig {
  // Deterministic per-test config. Recovery keypair generated fresh so
  // tests don't share state. Short session TTL (10s) is plenty; tests
  // don't need to exercise the expiry path here.
  const priv = randomBytes(32);
  const pub = x25519.getPublicKey(priv);
  return {
    port: 0,
    dbPath: ':memory:',
    recoveryPrivateKey: Buffer.from(priv).toString('hex'),
    recoveryPublicKey: Buffer.from(pub).toString('hex'),
    sessionSecret: randomBytes(32).toString('hex'),
    sessionTtlSeconds: 60,
    recoveryCooldownSeconds: 60,
    emailMode: 'dev',
  };
}

function httpRequest(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const baseHeaders: Record<string, string> = { ...headers };
      if (bodyStr) baseHeaders['Content-Type'] = 'application/json';
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method, headers: baseHeaders },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode!, data }); }
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

function fixtureSignup(emailSuffix = '') {
  // The wallet would build these by encrypting the AE private key with
  // the password (vaultBlob) and to the server's recovery public key
  // (recoveryBlob). Phase 5 wires the real client-side helpers. Here we
  // just feed in opaque strings of the right shape; the server doesn't
  // validate the contents.
  return {
    email: `alice${emailSuffix}@example.com`,
    password: 'correct horse battery staple',
    vaultBlob: 'deadbeef-vault-' + randomBytes(8).toString('hex'),
    recoveryBlob: 'cafef00d-recovery-' + randomBytes(8).toString('hex'),
    accountId: 'acct_' + randomBytes(20).toString('hex').slice(0, 40),
  };
}

describe('Phase 2: auth endpoints', () => {
  it('POST /signup creates a user and returns a session', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const body = fixtureSignup();

    const r = await httpRequest(app, 'POST', '/api/v1/signup', body);
    assert.equal(r.status, 201);
    assert.equal(r.data.success, true);
    assert.equal(r.data.data.accountId, body.accountId);
    assert.equal(r.data.data.recoveryPublicKey, cfg.recoveryPublicKey);
    assert.ok(typeof r.data.data.sessionToken === 'string' && r.data.data.sessionToken.length > 10);
    assert.ok(typeof r.data.data.expiresAt === 'number');
    db.close();
  });

  it('POST /signup with a duplicate email returns 409 EMAIL_TAKEN', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const body = fixtureSignup();
    await httpRequest(app, 'POST', '/api/v1/signup', body);
    const second = await httpRequest(app, 'POST', '/api/v1/signup', { ...body, accountId: 'acct_different' });
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'EMAIL_TAKEN');
    db.close();
  });

  it('POST /signup with a too-short password returns 400 WEAK_PASSWORD', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const r = await httpRequest(app, 'POST', '/api/v1/signup', { ...fixtureSignup(), password: 'short' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'WEAK_PASSWORD');
    db.close();
  });

  it('POST /signin happy path returns the vaultBlob the wallet uploaded', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const body = fixtureSignup();
    await httpRequest(app, 'POST', '/api/v1/signup', body);
    const r = await httpRequest(app, 'POST', '/api/v1/signin', { email: body.email, password: body.password });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, true);
    assert.equal(r.data.data.vaultBlob, body.vaultBlob);
    assert.equal(r.data.data.accountId, body.accountId);
    assert.ok(typeof r.data.data.sessionToken === 'string');
    db.close();
  });

  it('POST /signin with wrong password returns 401 AUTH_INVALID', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const body = fixtureSignup();
    await httpRequest(app, 'POST', '/api/v1/signup', body);
    const r = await httpRequest(app, 'POST', '/api/v1/signin', { email: body.email, password: 'wrong password 12345678' });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'AUTH_INVALID');
    db.close();
  });

  it('POST /signin with unknown email returns 401 AUTH_INVALID (same as wrong password)', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const r = await httpRequest(app, 'POST', '/api/v1/signin', { email: 'ghost@nowhere.com', password: 'whatever password' });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'AUTH_INVALID');
    db.close();
  });

  it('GET /me with a valid session returns user + accountId', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const body = fixtureSignup();
    const signup = await httpRequest(app, 'POST', '/api/v1/signup', body);
    const token = signup.data.data.sessionToken as string;
    const r = await httpRequest(app, 'GET', '/api/v1/me', undefined, { Authorization: `Bearer ${token}` });
    assert.equal(r.status, 200);
    assert.equal(r.data.data.email, body.email);
    assert.equal(r.data.data.accountId, body.accountId);
    assert.equal(r.data.data.emailVerified, false);
    assert.equal(r.data.data.twoFactorEnabled, false);
    db.close();
  });

  it('GET /me without a session returns 401 AUTH_MISSING', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const r = await httpRequest(app, 'GET', '/api/v1/me');
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'AUTH_MISSING');
    db.close();
  });

  it('POST /signout revokes the session; subsequent /me returns 401 AUTH_REVOKED', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const body = fixtureSignup();
    const signup = await httpRequest(app, 'POST', '/api/v1/signup', body);
    const token = signup.data.data.sessionToken as string;
    const so = await httpRequest(app, 'POST', '/api/v1/signout', undefined, { Authorization: `Bearer ${token}` });
    assert.equal(so.status, 200);
    assert.equal(so.data.data.revoked, true);

    const me = await httpRequest(app, 'GET', '/api/v1/me', undefined, { Authorization: `Bearer ${token}` });
    assert.equal(me.status, 401);
    assert.equal(me.data.error.code, 'AUTH_REVOKED');
    db.close();
  });

  it('POST /signup with a duplicate accountId returns 409 ACCOUNT_TAKEN', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const body = fixtureSignup();
    await httpRequest(app, 'POST', '/api/v1/signup', body);
    const second = await httpRequest(app, 'POST', '/api/v1/signup', { ...body, email: 'someoneelse@example.com' });
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'ACCOUNT_TAKEN');
    db.close();
  });
});
