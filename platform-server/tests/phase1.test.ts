// Phase 1: platform-server scaffolding.
//
// Locks in the boot path: schema applies cleanly, /health responds,
// the recovery keypair can round-trip a ciphertext (so the recovery
// blob shape is correct), session tokens verify, and the config
// loader picks up dev fallbacks without crashing.

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
import {
  hashPassword,
  verifyPassword,
  decryptRecoveryBlob,
  serializeRecoveryBlob,
  mintSessionToken,
  verifySessionToken,
  randomToken,
} from '../src/crypto.js';

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-test-'));
  return join(dir, 'platform.db');
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
          res.on('data', (c) => (data += c));
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
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

describe('Phase 1: platform-server scaffold', () => {
  it('openDb applies schema and /health responds', async () => {
    const db = openDb(freshDbPath());
    const app = createApp(db);
    const r = await request(app, 'GET', '/api/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.ok(typeof r.data.timestamp === 'number');
    db.close();
  });

  it('schema_version is at 1 after fresh init', () => {
    const db = openDb(freshDbPath());
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.equal(row.version, 1);
    db.close();
  });

  it('Argon2id hash round-trips with the right password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.ok(await verifyPassword(hash, 'correct horse battery staple'));
    assert.ok(!(await verifyPassword(hash, 'wrong password')));
  });

  it('recovery envelope: client encrypts to server pubkey, server decrypts', () => {
    // Simulate the signup-time recovery_blob flow end to end. The client
    // has a one-time x25519 keypair, derives a shared secret with the
    // server's long-term public key, encrypts the plaintext with
    // chacha20-poly1305. Server decrypts using its long-term private key
    // and the ephemeral public key it received.
    const serverPriv = randomBytes(32);
    const serverPub = x25519.getPublicKey(serverPriv);

    const ephemeralPriv = randomBytes(32);
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, serverPub);
    const nonce = randomBytes(12);
    const plaintext = new TextEncoder().encode('user-ae-private-key-or-mnemonic-bytes');
    const ciphertext = chacha20poly1305(sharedSecret, nonce).encrypt(plaintext);

    const blob = serializeRecoveryBlob({
      ephemeralPublicKey: ephemeralPub,
      nonce,
      ciphertext,
    });

    const decrypted = decryptRecoveryBlob(blob, Buffer.from(serverPriv).toString('hex'));
    assert.deepEqual(new TextDecoder().decode(decrypted), 'user-ae-private-key-or-mnemonic-bytes');
  });

  it('recovery envelope: wrong server private key fails to decrypt', () => {
    const realServerPriv = randomBytes(32);
    const realServerPub = x25519.getPublicKey(realServerPriv);
    const ephemeralPriv = randomBytes(32);
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, realServerPub);
    const nonce = randomBytes(12);
    const ciphertext = chacha20poly1305(sharedSecret, nonce).encrypt(new TextEncoder().encode('payload'));
    const blob = serializeRecoveryBlob({
      ephemeralPublicKey: ephemeralPub,
      nonce,
      ciphertext,
    });

    const wrongServerPriv = randomBytes(32);
    assert.throws(() => decryptRecoveryBlob(blob, Buffer.from(wrongServerPriv).toString('hex')));
  });

  it('session token mints and verifies; rejects tampering and expiry', () => {
    const secret = randomBytes(32).toString('hex');
    const sid = randomToken(16);
    const goodExpiry = Math.floor(Date.now() / 1000) + 60;
    const token = mintSessionToken(sid, goodExpiry, secret);

    const parsed = verifySessionToken(token, secret);
    assert.ok(parsed);
    assert.equal(parsed?.sessionId, sid);
    assert.equal(parsed?.expiresAt, goodExpiry);

    // Tamper with one hex char of the HMAC tail.
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    assert.equal(verifySessionToken(tampered, secret), null);

    // Wrong secret.
    const otherSecret = randomBytes(32).toString('hex');
    assert.equal(verifySessionToken(token, otherSecret), null);

    // Expired.
    const expiredToken = mintSessionToken(sid, Math.floor(Date.now() / 1000) - 60, secret);
    assert.equal(verifySessionToken(expiredToken, secret), null);
  });
});
