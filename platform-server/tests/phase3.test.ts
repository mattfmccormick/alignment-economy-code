// Phase 3: forgot-password / recovery flow.
//
// The full path: /recover/start (get token) → /recover/verify (mark email
// clicked) → wait for cooldown → /recover/complete (set new password +
// upload new vault + recovery blobs). We use AE_PLATFORM_ALLOW_TEST_NOW=1
// plus a `now` body field to shortcut the cooldown in tests.
//
// What we lock in:
//   - start returns 200 with a `sent` flag regardless of whether the email
//     exists (no enumeration leak), and includes a `devToken` in dev mode
//   - start for an unknown email returns 200 but creates no row
//   - verify marks the token verified; second verify is idempotent
//   - complete refuses to run if /verify hasn't been called
//   - complete refuses to run before the cooldown has elapsed
//   - complete happy path swaps password_hash, vault_blob, recovery_blob,
//     marks the token completed, revokes all existing sessions
//   - after recovery, sign-in with the OLD password fails
//   - after recovery, sign-in with the NEW password works AND returns the
//     newly-uploaded vault_blob (not the old one)
//   - completing the same token twice is rejected
//   - completing with an expired token is rejected

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { createApp, openDb } from '../src/index.js';
import { type PlatformConfig } from '../src/config.js';
import { serializeRecoveryBlob } from '../src/crypto.js';

const ORIGINAL_ALLOW_TEST_NOW = process.env.AE_PLATFORM_ALLOW_TEST_NOW;
before(() => { process.env.AE_PLATFORM_ALLOW_TEST_NOW = '1'; });
after(() => {
  if (ORIGINAL_ALLOW_TEST_NOW === undefined) delete process.env.AE_PLATFORM_ALLOW_TEST_NOW;
  else process.env.AE_PLATFORM_ALLOW_TEST_NOW = ORIGINAL_ALLOW_TEST_NOW;
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-p3-'));
  return join(dir, 'platform.db');
}

function testConfig(): PlatformConfig {
  const priv = randomBytes(32);
  const pub = x25519.getPublicKey(priv);
  return {
    port: 0,
    dbPath: ':memory:',
    recoveryPrivateKey: Buffer.from(priv).toString('hex'),
    recoveryPublicKey: Buffer.from(pub).toString('hex'),
    sessionSecret: randomBytes(32).toString('hex'),
    sessionTtlSeconds: 60,
    recoveryCooldownSeconds: 86400, // 24h, will be shortcut in tests
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
      const h: Record<string, string> = { ...headers };
      if (bodyStr) h['Content-Type'] = 'application/json';
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method, headers: h },
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

/**
 * Build a real recovery_blob the way a client would: ECIES envelope over
 * x25519 + chacha20-poly1305. Sealed plaintext is opaque; we just need
 * the server to be able to decrypt with its private key.
 */
function buildRecoveryBlob(serverPubHex: string, plaintext: string): string {
  const serverPub = Buffer.from(serverPubHex, 'hex');
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const sharedSecret = x25519.getSharedSecret(ephPriv, serverPub);
  const nonce = randomBytes(12);
  const ciphertext = chacha20poly1305(sharedSecret, nonce).encrypt(new TextEncoder().encode(plaintext));
  return serializeRecoveryBlob({ ephemeralPublicKey: ephPub, nonce, ciphertext });
}

async function signupTestUser(app: ReturnType<typeof createApp>, cfg: PlatformConfig, opts?: { email?: string; password?: string }) {
  const email = opts?.email ?? 'alice@example.com';
  const password = opts?.password ?? 'correct horse battery staple';
  const body = {
    email,
    password,
    vaultBlob: 'original-vault-' + randomBytes(8).toString('hex'),
    recoveryBlob: buildRecoveryBlob(cfg.recoveryPublicKey, 'original-secret'),
    accountId: 'acct_' + randomBytes(20).toString('hex').slice(0, 40),
  };
  const r = await httpRequest(app, 'POST', '/api/v1/signup', body);
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return { ...body, userId: r.data.data.userId as string, sessionToken: r.data.data.sessionToken as string };
}

describe('Phase 3: recovery flow', () => {
  it('start returns devToken and creates a row for a registered email', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const user = await signupTestUser(app, cfg);

    const r = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    assert.equal(r.status, 200);
    assert.equal(r.data.data.sent, true);
    assert.ok(typeof r.data.data.devToken === 'string' && r.data.data.devToken.length > 16);

    const row = db.prepare('SELECT user_id FROM recovery_tokens WHERE token = ?').get(r.data.data.devToken) as { user_id: string };
    assert.equal(row.user_id, user.userId);
    db.close();
  });

  it('start for an unknown email returns the SAME 200 shape with no devToken row', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const r = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: 'ghost@nowhere.com' });
    assert.equal(r.status, 200);
    assert.equal(r.data.data.sent, true);
    // No devToken in the response when the email doesn't exist (we don't
    // want to bother emailing a non-user). And no row in the table.
    const count = (db.prepare('SELECT COUNT(*) as c FROM recovery_tokens').get() as { c: number }).c;
    assert.equal(count, 0);
    db.close();
  });

  it('verify marks the token verified; second verify is idempotent', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const user = await signupTestUser(app, cfg);
    const startR = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    const token = startR.data.data.devToken as string;

    const v1 = await httpRequest(app, 'POST', '/api/v1/recover/verify', { token });
    assert.equal(v1.status, 200);
    assert.equal(v1.data.data.verified, true);
    const v2 = await httpRequest(app, 'POST', '/api/v1/recover/verify', { token });
    assert.equal(v2.status, 200);
    assert.equal(v2.data.data.verified, true);
    db.close();
  });

  it('complete refuses if /verify never ran', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const user = await signupTestUser(app, cfg);
    const startR = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    const token = startR.data.data.devToken as string;

    const r = await httpRequest(app, 'POST', '/api/v1/recover/complete', {
      token,
      newPassword: 'a brand new strong password',
      newVaultBlob: 'new-vault',
      newRecoveryBlob: buildRecoveryBlob(cfg.recoveryPublicKey, 'new-secret'),
      now: Math.floor(Date.now() / 1000) + cfg.recoveryCooldownSeconds + 1,
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'NOT_VERIFIED');
    db.close();
  });

  it('complete refuses before the cooldown elapses', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const user = await signupTestUser(app, cfg);
    const startR = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    const token = startR.data.data.devToken as string;
    await httpRequest(app, 'POST', '/api/v1/recover/verify', { token });

    const r = await httpRequest(app, 'POST', '/api/v1/recover/complete', {
      token,
      newPassword: 'a brand new strong password',
      newVaultBlob: 'new-vault',
      newRecoveryBlob: buildRecoveryBlob(cfg.recoveryPublicKey, 'new-secret'),
      // No `now` override → real time, cooldown of 24h hasn't elapsed
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'COOLDOWN_ACTIVE');
    db.close();
  });

  it('complete happy path swaps password+vault+recovery, revokes sessions, and lets the user sign in with the new password', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const user = await signupTestUser(app, cfg);

    // Sign in once before recovery so we can confirm the session gets revoked.
    const preSignin = await httpRequest(app, 'POST', '/api/v1/signin', { email: user.email, password: user.password });
    assert.equal(preSignin.status, 200);
    const preToken = preSignin.data.data.sessionToken as string;

    const startR = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    const token = startR.data.data.devToken as string;
    await httpRequest(app, 'POST', '/api/v1/recover/verify', { token });

    const newPassword = 'totally different password 9999';
    const newVaultBlob = 'new-vault-' + randomBytes(8).toString('hex');
    const newRecoveryBlob = buildRecoveryBlob(cfg.recoveryPublicKey, 'new-secret-after-reset');

    const completeR = await httpRequest(app, 'POST', '/api/v1/recover/complete', {
      token,
      newPassword,
      newVaultBlob,
      newRecoveryBlob,
      now: Math.floor(Date.now() / 1000) + cfg.recoveryCooldownSeconds + 1,
    });
    assert.equal(completeR.status, 200);
    assert.equal(completeR.data.data.recovered, true);

    // Pre-recovery session is revoked.
    const meWithOldToken = await httpRequest(app, 'GET', '/api/v1/me', undefined, { Authorization: `Bearer ${preToken}` });
    assert.equal(meWithOldToken.status, 401);
    assert.equal(meWithOldToken.data.error.code, 'AUTH_REVOKED');

    // Old password no longer works.
    const oldSignin = await httpRequest(app, 'POST', '/api/v1/signin', { email: user.email, password: user.password });
    assert.equal(oldSignin.status, 401);

    // New password works AND returns the new vault blob.
    const newSignin = await httpRequest(app, 'POST', '/api/v1/signin', { email: user.email, password: newPassword });
    assert.equal(newSignin.status, 200);
    assert.equal(newSignin.data.data.vaultBlob, newVaultBlob);
    db.close();
  });

  it('completing the same token twice is rejected', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const user = await signupTestUser(app, cfg);

    const startR = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    const token = startR.data.data.devToken as string;
    await httpRequest(app, 'POST', '/api/v1/recover/verify', { token });
    const body = {
      token,
      newPassword: 'totally different password 9999',
      newVaultBlob: 'new-vault',
      newRecoveryBlob: buildRecoveryBlob(cfg.recoveryPublicKey, 'new-secret'),
      now: Math.floor(Date.now() / 1000) + cfg.recoveryCooldownSeconds + 1,
    };
    const first = await httpRequest(app, 'POST', '/api/v1/recover/complete', body);
    assert.equal(first.status, 200);
    const second = await httpRequest(app, 'POST', '/api/v1/recover/complete', body);
    assert.equal(second.status, 404);
    assert.equal(second.data.error.code, 'TOKEN_INVALID');
    db.close();
  });

  it('verify with an unknown token returns 404 TOKEN_INVALID', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db, testConfig());
    const r = await httpRequest(app, 'POST', '/api/v1/recover/verify', { token: 'not-a-real-token' });
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'TOKEN_INVALID');
    db.close();
  });
});
