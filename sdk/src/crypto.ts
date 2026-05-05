// Cryptographic primitives the SDK exposes to consumers. Same algorithms
// the wallet uses internally (ae-app/src/lib/crypto.ts). Lifted here so
// third-party tools can sign transactions, derive accountIds, and verify
// signatures without depending on ae-app or ae-node.
//
// Wire format reminder:
//   - account signing key: ML-DSA-65 (post-quantum), 1952 byte publicKey
//   - hashing: SHA-256
//   - mnemonic: BIP39 12-word, deterministic ML-DSA-65 keypair derivation

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface KeyPair {
  publicKey: string;   // hex, 1952 bytes for ML-DSA-65
  privateKey: string;  // hex, 4032 bytes (publicKey + secret material)
}

/** Generate a fresh ML-DSA-65 keypair from system entropy. */
export function generateKeyPair(): KeyPair {
  const kp = ml_dsa65.keygen();
  return { publicKey: bytesToHex(kp.publicKey), privateKey: bytesToHex(kp.secretKey) };
}

/** SHA-256 prefix of the publicKey, hex. The first 20 bytes of the hash
 *  become the accountId everyone refers to on-chain. */
export function deriveAccountId(publicKeyHex: string): string {
  const pubBytes = hexToBytes(publicKeyHex);
  const hash = sha256(pubBytes);
  return bytesToHex(hash.slice(0, 20));
}

/**
 * Sign a JSON payload + timestamp with an ML-DSA-65 private key.
 * Compatible with ae-node's verifyPayload. The canonical bytes are
 * `JSON.stringify(payload) + timestamp`. Both sides must agree on
 * key ordering — the SDK trusts the caller to pass `payload` in the
 * exact shape the server expects (the API route docs spell it out).
 */
export function signPayload(payload: object, timestamp: number, privateKeyHex: string): string {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  const secretKey = hexToBytes(privateKeyHex);
  const sig = ml_dsa65.sign(data, secretKey);
  return bytesToHex(sig);
}

export function verifyPayload(
  payload: object,
  timestamp: number,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  try {
    return ml_dsa65.verify(hexToBytes(signatureHex), data, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

// ─── BIP39 mnemonic helpers ─────────────────────────────────────────
// Same convention as the wallet: 12 words = 128 bits of entropy. The
// mnemonic deterministically maps to one ML-DSA-65 keypair so a user can
// recover their account on any device by typing the same 12 words.

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(phrase.trim(), wordlist);
}

export function mnemonicToKeypair(phrase: string): KeyPair {
  // BIP39 standard derivation: phrase + empty passphrase -> 64-byte seed.
  // ML-DSA keygen takes 32 bytes; we use the first half so the SDK and
  // the wallet produce the same keypair from the same mnemonic.
  const seed64 = mnemonicToSeedSync(phrase.trim(), '');
  const seed32 = seed64.slice(0, 32);
  const kp = ml_dsa65.keygen(seed32);
  return { publicKey: bytesToHex(kp.publicKey), privateKey: bytesToHex(kp.secretKey) };
}

export { hexToBytes, bytesToHex };
