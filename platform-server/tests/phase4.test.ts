// Phase 4: email sending.
//
// The Mailer abstraction has two implementations. The route handlers
// take it as a constructor dependency so tests can inject ConsoleMailer
// and assert on what was sent. Phase 4 tests just the wiring: the
// /recover/start path actually calls the mailer with the recovery email
// template, the template renders the token + cooldown, and the SMTP
// implementation throws when its required config is missing (caught at
// the route level so a misconfigured SMTP server never blocks the
// user-visible "we sent it" response).

import { describe, it } from 'node:test';
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
import { ConsoleMailer, SmtpMailer, recoveryEmail, verificationEmail } from '../src/mailer.js';
import { serializeRecoveryBlob } from '../src/crypto.js';

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-p4-'));
  return join(dir, 'platform.db');
}

function testConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
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
    ...overrides,
  };
}

function httpRequest(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method, headers: bodyStr ? { 'Content-Type': 'application/json' } : {} },
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

function buildRecoveryBlob(serverPubHex: string): string {
  const serverPub = Buffer.from(serverPubHex, 'hex');
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const sharedSecret = x25519.getSharedSecret(ephPriv, serverPub);
  const nonce = randomBytes(12);
  const ciphertext = chacha20poly1305(sharedSecret, nonce).encrypt(new TextEncoder().encode('payload'));
  return serializeRecoveryBlob({ ephemeralPublicKey: ephPub, nonce, ciphertext });
}

async function signupTestUser(app: ReturnType<typeof createApp>, cfg: PlatformConfig, email = 'alice@example.com') {
  const body = {
    email,
    password: 'correct horse battery staple',
    vaultBlob: 'vault-' + randomBytes(8).toString('hex'),
    recoveryBlob: buildRecoveryBlob(cfg.recoveryPublicKey),
    accountId: 'acct_' + randomBytes(20).toString('hex').slice(0, 40),
  };
  const r = await httpRequest(app, 'POST', '/api/v1/signup', body);
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return body;
}

describe('Phase 4: email sending', () => {
  it('recoveryEmail template includes the token and cooldown', () => {
    const args = recoveryEmail({ email: 'someone@example.com', token: 'abc123token', cooldownHours: 24 });
    assert.equal(args.to, 'someone@example.com');
    assert.ok(args.subject.toLowerCase().includes('reset'));
    assert.ok(args.text.includes('abc123token'));
    assert.ok(args.text.includes('24 hour'));
  });

  it('verificationEmail template includes the token', () => {
    const args = verificationEmail({ email: 'someone@example.com', token: 'verify-xyz' });
    assert.equal(args.to, 'someone@example.com');
    assert.ok(args.subject.toLowerCase().includes('verify'));
    assert.ok(args.text.includes('verify-xyz'));
  });

  it('/recover/start sends a recovery email for a registered user via the injected mailer', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const mailer = new ConsoleMailer();
    const app = createApp(db, cfg, mailer);
    const user = await signupTestUser(app, cfg);

    const r = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    assert.equal(r.status, 200);
    assert.equal(r.data.data.sent, true);
    assert.ok(typeof r.data.data.devToken === 'string');

    const sent = mailer.recordedEmails.get(user.email);
    assert.ok(sent, 'mailer should have a recorded email for the user');
    assert.ok(sent!.text.includes(r.data.data.devToken), 'email body should contain the dev token');
    assert.ok(sent!.subject.toLowerCase().includes('reset'));
    db.close();
  });

  it('/recover/start does NOT call the mailer for an unknown email', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const mailer = new ConsoleMailer();
    const app = createApp(db, cfg, mailer);
    const r = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: 'ghost@example.com' });
    assert.equal(r.status, 200);
    assert.equal(mailer.recordedEmails.size, 0, 'no email should have been sent for an unknown user');
    db.close();
  });

  it('mailer failure does not poison the user-facing response', async () => {
    const db = openDb(freshDbPath());
    const cfg = testConfig();
    const throwingMailer = {
      async send(_args: any): Promise<void> {
        throw new Error('simulated SMTP outage');
      },
    };
    const app = createApp(db, cfg, throwingMailer);
    const user = await signupTestUser(app, cfg);

    const r = await httpRequest(app, 'POST', '/api/v1/recover/start', { email: user.email });
    // Still 200 + `sent: true` even though the mailer threw. The route
    // logs the failure and continues. This is intentional: we don't want
    // a misbehaving SMTP server to expose to a probing attacker whether
    // an email is registered.
    assert.equal(r.status, 200);
    assert.equal(r.data.data.sent, true);
    db.close();
  });

  it('SmtpMailer throws helpfully when its required env vars are missing', async () => {
    const cfgMissing = testConfig({ emailMode: 'smtp', smtpHost: undefined, smtpPort: undefined });
    const mailer = new SmtpMailer(cfgMissing);
    await assert.rejects(
      () => mailer.send({ to: 'x@y.com', subject: 's', text: 't' }),
      /AE_PLATFORM_SMTP_(HOST|FROM)/,
    );
  });
});
