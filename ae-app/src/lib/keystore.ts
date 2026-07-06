// Passphrase-encrypted keystore (D2).
//
// Wraps a wallet's secret material (a JSON string holding the BIP39 mnemonic
// or a raw private key) in an authenticated, passphrase-derived envelope so it
// is not readable at rest in localStorage. Encryption is OPT-IN: an existing
// plaintext wallet keeps working until the user chooses "Protect with a
// passphrase."
//
// Crypto: PBKDF2-SHA256 (600k iterations) stretches the passphrase into a
// 256-bit AES-GCM key using a random per-envelope salt; AES-GCM then encrypts
// the plaintext with a random 12-byte IV and authenticates it (so a wrong
// passphrase or any tampering fails decryption rather than returning garbage).
// Everything runs in WebCrypto (SubtleCrypto) — no key material is ever sent
// anywhere, and the derived key is never persisted.

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

/** Versioned on-disk shape. `v` lets us evolve the KDF/cipher later. */
export interface KeystoreEnvelope {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64 (AES-GCM ciphertext + tag)
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto SubtleCrypto is unavailable in this environment');
  return c.subtle;
};

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a plaintext secret string under `passphrase`. Returns the envelope. */
export async function encryptSecret(plaintext: string, passphrase: string): Promise<KeystoreEnvelope> {
  if (!passphrase) throw new Error('A passphrase is required');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
}

/**
 * Decrypt an envelope. Throws if the passphrase is wrong or the ciphertext was
 * tampered with (AES-GCM authentication failure surfaces as a decrypt error).
 */
export async function decryptSecret(envelope: KeystoreEnvelope, passphrase: string): Promise<string> {
  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.iv);
  const ct = fromBase64(envelope.ct);
  const key = await deriveKey(passphrase, salt, envelope.iter);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource);
  } catch {
    throw new Error('Wrong passphrase or corrupted keystore');
  }
  return new TextDecoder().decode(plain);
}

/** True when a parsed localStorage value looks like an encrypted envelope. */
export function isKeystoreEnvelope(value: unknown): value is KeystoreEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return e.v === 1 && e.kdf === 'PBKDF2-SHA256'
    && typeof e.salt === 'string' && typeof e.iv === 'string' && typeof e.ct === 'string';
}
