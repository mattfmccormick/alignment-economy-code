import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function signPayload(payload: object, timestamp: number, privateKeyHex: string): string {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  const secretKey = hexToBytes(privateKeyHex);
  const sig = ml_dsa65.sign(data, secretKey);
  return bytesToHex(sig);
}

export function derivePublicKey(privateKeyHex: string): string {
  // ML-DSA secret key contains the public key in the last 1952 bytes
  const secretKey = hexToBytes(privateKeyHex);
  // For ML-DSA-65, public key is 1952 bytes, secret key is 4032 bytes
  // The public key is embedded at the end of the secret key
  const publicKey = secretKey.slice(secretKey.length - 1952);
  return bytesToHex(publicKey);
}

// ─── BIP39 mnemonic-derived keys ─────────────────────────────────────────
//
// A user's wallet boils down to a 12-word phrase. From it we deterministically
// derive a 32-byte seed (BIP39 PBKDF2), feed that to ML-DSA-65 keygen, and get
// the same publicKey/privateKey every time. Storing only the mnemonic locally
// means a user can recover their wallet on any device by typing 12 words.

/** Generate a fresh BIP39 mnemonic (12 words, 128 bits of entropy). */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

/** Validate a user-typed mnemonic against the BIP39 wordlist + checksum. */
export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(phrase.trim(), wordlist);
}

/** Derive the ML-DSA-65 keypair (hex-encoded) from a BIP39 mnemonic. */
export function mnemonicToKeypair(phrase: string): { publicKey: string; privateKey: string } {
  // BIP39 standard derivation: mnemonic + passphrase => 64-byte seed.
  // We use the empty passphrase (most common BIP39 setup); ML-DSA keygen
  // takes 32 bytes, so we use the first half.
  const seed64 = mnemonicToSeedSync(phrase.trim(), '');
  const seed32 = seed64.slice(0, 32);
  const kp = ml_dsa65.keygen(seed32);
  return {
    publicKey: bytesToHex(kp.publicKey),
    privateKey: bytesToHex(kp.secretKey),
  };
}

export { hexToBytes, bytesToHex };
