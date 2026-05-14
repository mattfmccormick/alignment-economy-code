// Phase 5: two-factor auth (TOTP).
//
// Covers:
//   - enroll returns a fresh secret + otpauth URI
//   - confirm with a wrong code -> 401 TOTP_INVALID, no DB change
//   - confirm with the right code -> 200, totp_secret persisted
//   - second enroll while already enabled -> 409 TOTP_ALREADY_ENABLED
//   - signin without code when 2FA on -> 401 TOTP_REQUIRED
//   - signin with wrong code -> 401 TOTP_INVALID
//   - signin with right code -> 200 (vault returned)
//   - disable with wrong code -> 401, totp_secret unchanged
//   - disable with right code -> 200, totp_secret cleared, signin no
//     longer requires a code

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { authenticator } from 'otplib';
import { createApp, openDb } from '../src/index.js';
import { type PlatformConfig } from '../src/config.js';

authenticator.options = { window: 1 };

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-p5-'));
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
    recoveryCooldownSeconds: 86400,
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

async function signupFresh(app: ReturnType<typeof createApp>) {
  const email = `alice+${randomBytes(6).toString('hex')}@example.com`;
  const password = 'correct horse battery staple';
  const body = {
    email,
    password,
    vaultBlob: 'vault-' + randomBytes(8).toString('hex'),
    recoveryBlob: 'recovery-' + randomBytes(8).toString('hex'),
    accountId: 'acct_' + randomBytes(20).toString('hex').slice(0, 40),
  };
  const r = await httpRequest(app, 'POST', '/api/v1/signup', body);
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return { email, password, sessionToken: r.data.data.sessionToken as string };
}

describe('Phase 5: two-factor auth (TOTP)', () => {
  it('enroll returns secret + otpauth URI; does not yet persist', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const u = await signupFresh(app);

    const r = await httpRequest(app, 'POST', '/api/v1/2fa/enroll', {}, { Authorization: `Bearer ${u.sessionToken}` });
    assert.equal(r.status, 200);
    assert.ok(typeof r.data.data.secret === 'string' && r.data.data.secret.length >= 16);
    assert.ok(r.data.data.otpauthUri.startsWith('otpauth://totp/'));

    // Not yet persisted: signin should still succeed without a code.
    const signin = await httpRequest(app, 'POST', '/api/v1/signin', { email: u.email, password: u.password });
    assert.equal(signin.status, 200);
    db.close();
  });

  it('confirm with wrong code fails and does not persist', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const u = await signupFresh(app);
    const enroll = await httpRequest(app, 'POST', '/api/v1/2fa/enroll', {}, { Authorization: `Bearer ${u.sessionToken}` });

    const r = await httpRequest(app, 'POST', '/api/v1/2fa/confirm',
      { secret: enroll.data.data.secret, code: '000000' },
      { Authorization: `Bearer ${u.sessionToken}` },
    );
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'TOTP_INVALID');

    const signin = await httpRequest(app, 'POST', '/api/v1/signin', { email: u.email, password: u.password });
    assert.equal(signin.status, 200, 'signin still works because confirm failed');
    db.close();
  });

  it('confirm with the right code persists the secret and gates signin', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const u = await signupFresh(app);
    const enroll = await httpRequest(app, 'POST', '/api/v1/2fa/enroll', {}, { Authorization: `Bearer ${u.sessionToken}` });
    const code = authenticator.generate(enroll.data.data.secret);

    const confirm = await httpRequest(app, 'POST', '/api/v1/2fa/confirm',
      { secret: enroll.data.data.secret, code },
      { Authorization: `Bearer ${u.sessionToken}` },
    );
    assert.equal(confirm.status, 200);
    assert.equal(confirm.data.data.enabled, true);

    // signin without code now fails with TOTP_REQUIRED.
    const noCode = await httpRequest(app, 'POST', '/api/v1/signin', { email: u.email, password: u.password });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.data.error.code, 'TOTP_REQUIRED');

    // signin with wrong code fails with TOTP_INVALID.
    const wrongCode = await httpRequest(app, 'POST', '/api/v1/signin', { email: u.email, password: u.password, code: '000000' });
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.data.error.code, 'TOTP_INVALID');

    // signin with the right code succeeds.
    const code2 = authenticator.generate(enroll.data.data.secret);
    const ok = await httpRequest(app, 'POST', '/api/v1/signin', { email: u.email, password: u.password, code: code2 });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.data.vaultBlob);
    db.close();
  });

  it('second enroll while already enabled returns 409', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const u = await signupFresh(app);
    const enroll1 = await httpRequest(app, 'POST', '/api/v1/2fa/enroll', {}, { Authorization: `Bearer ${u.sessionToken}` });
    const code = authenticator.generate(enroll1.data.data.secret);
    await httpRequest(app, 'POST', '/api/v1/2fa/confirm', { secret: enroll1.data.data.secret, code }, { Authorization: `Bearer ${u.sessionToken}` });

    const enroll2 = await httpRequest(app, 'POST', '/api/v1/2fa/enroll', {}, { Authorization: `Bearer ${u.sessionToken}` });
    assert.equal(enroll2.status, 409);
    assert.equal(enroll2.data.error.code, 'TOTP_ALREADY_ENABLED');
    db.close();
  });

  it('disable with wrong code keeps 2FA on; with right code clears it', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const u = await signupFresh(app);
    const enroll = await httpRequest(app, 'POST', '/api/v1/2fa/enroll', {}, { Authorization: `Bearer ${u.sessionToken}` });
    const onCode = authenticator.generate(enroll.data.data.secret);
    await httpRequest(app, 'POST', '/api/v1/2fa/confirm', { secret: enroll.data.data.secret, code: onCode }, { Authorization: `Bearer ${u.sessionToken}` });

    const wrong = await httpRequest(app, 'POST', '/api/v1/2fa/disable', { code: '000000' }, { Authorization: `Bearer ${u.sessionToken}` });
    assert.equal(wrong.status, 401);

    const code = authenticator.generate(enroll.data.data.secret);
    const ok = await httpRequest(app, 'POST', '/api/v1/2fa/disable', { code }, { Authorization: `Bearer ${u.sessionToken}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.data.disabled, true);

    // signin now works without a code.
    const signin = await httpRequest(app, 'POST', '/api/v1/signin', { email: u.email, password: u.password });
    assert.equal(signin.status, 200);
    db.close();
  });

  it('disable without a valid session returns 401', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const app = createApp(db, cfg);
    const r = await httpRequest(app, 'POST', '/api/v1/2fa/disable', { code: '000000' });
    assert.equal(r.status, 401);
    db.close();
  });
});
