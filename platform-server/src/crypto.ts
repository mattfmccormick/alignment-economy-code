// Crypto primitives used by the platform server.
//
// Three jobs:
//   1. Hash + verify user passwords. Argon2id is the standard. We pick
//      conservative parameters (memory cost 65536 KiB, iterations 3,
//      parallelism 4) that take ~100ms on a modest VPS. Tune up before
//      production hardening.
//   2. Decrypt recovery_blobs during the verified recovery flow. We use
//      ECIES with x25519 + ChaCha20-Poly1305: client encrypts the AE
//      private key against the server's x25519 public key plus an
//      ephemeral keypair; server decrypts with its long-term private
//      key plus the ephemeral public key in the envelope.
//   3. Sign + verify opaque session tokens via HMAC-SHA256 over a random
//      uuid plus an expiry timestamp. Cheap to mint, cheap to check, no
//      JWT complexity.

import argon2 from 'argon2';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// ECIES envelope shape for recovery_blob. Stored as a single hex string.
//   bytes 0..32     ephemeralPublicKey (client's one-time x25519 pubkey)
//   bytes 32..44    nonce (12 bytes for chacha20-poly1305)
//   bytes 44..end   ciphertext (with poly1305 auth tag at the tail)
export interface RecoveryEnvelope {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function parseRecoveryBlob(hex: string): RecoveryEnvelope {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 32 + 12 + 16 + 1) {
    throw new Error('recovery blob too short');
  }
  return {
    ephemeralPublicKey: buf.subarray(0, 32),
    nonce: buf.subarray(32, 44),
    ciphertext: buf.subarray(44),
  };
}

export function serializeRecoveryBlob(envelope: RecoveryEnvelope): string {
  return Buffer.concat([envelope.ephemeralPublicKey, envelope.nonce, envelope.ciphertext]).toString('hex');
}

/**
 * Server-side recovery decrypt. Used only during a verified recovery flow.
 * Returns the plaintext the client originally sealed (the user's AE
 * private key plus whatever else the client chose to bundle).
 */
export function decryptRecoveryBlob(
  hex: string,
  serverPrivateKeyHex: string,
): Uint8Array {
  const env = parseRecoveryBlob(hex);
  const serverPrivateKey = Buffer.from(serverPrivateKeyHex, 'hex');
  const sharedSecret = x25519.getSharedSecret(serverPrivateKey, env.ephemeralPublicKey);
  const cipher = chacha20poly1305(sharedSecret, env.nonce);
  return cipher.decrypt(env.ciphertext);
}

// ── Session tokens ─────────────────────────────────────────────────────

/** Mint a fresh session token: random uuid plus expiry plus HMAC. */
export function mintSessionToken(sessionId: string, expiresAt: number, secretHex: string): string {
  const payload = `${sessionId}.${expiresAt}`;
  const hmac = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(payload)
    .digest('hex');
  return `${payload}.${hmac}`;
}

export interface ParsedSessionToken {
  sessionId: string;
  expiresAt: number;
}

/**
 * Verify and parse a session token. Returns the session id + expiry on
 * success, null on tampering, expiry, or any other validation failure.
 * Constant-time HMAC compare to avoid timing leaks.
 */
export function verifySessionToken(token: string, secretHex: string): ParsedSessionToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const sessionId = parts[0];
  const expiresAtStr = parts[1];
  const hmacFromToken = parts[2];
  if (!sessionId || !expiresAtStr || !hmacFromToken) return null;
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt)) return null;

  const payload = `${sessionId}.${expiresAt}`;
  const expectedHmac = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(payload)
    .digest();
  const givenHmac = Buffer.from(hmacFromToken, 'hex');
  if (givenHmac.length !== expectedHmac.length) return null;
  if (!timingSafeEqual(givenHmac, expectedHmac)) return null;
  if (Math.floor(Date.now() / 1000) >= expiresAt) return null;

  return { sessionId, expiresAt };
}

// ── Misc ───────────────────────────────────────────────────────────────

/** Cryptographically random url-safe token. Used for email + recovery links. */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}
