import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
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

// Vouch operations (audit #4/#16). A vouch rides the chain, so the client signs
// a VouchOperation over its CANONICAL pipe-delimited bytes, byte-identical to
// ae-node's verification/vouch-operation.ts canonicalBytesFor(). Raw ML-DSA
// over the canonical string, NOT the JSON+timestamp envelope signPayload uses.
export interface VouchOpCreate {
  type: 'vouch_create';
  voucherId: string;
  vouchedId: string;
  stakePercent: number;
  timestamp: number;
  signature: string;
}

export function signVouchCreate(
  voucherId: string,
  vouchedId: string,
  stakePercent: number,
  timestamp: number,
  privateKeyHex: string,
): VouchOpCreate {
  const canonical = `vouch_create|${voucherId}|${vouchedId}|${stakePercent}|${timestamp}`;
  const sig = ml_dsa65.sign(new TextEncoder().encode(canonical), hexToBytes(privateKeyHex));
  return { type: 'vouch_create', voucherId, vouchedId, stakePercent, timestamp, signature: bytesToHex(sig) };
}

export function signMinerRegister(
  accountId: string,
  timestamp: number,
  privateKeyHex: string,
): { type: 'miner_register'; accountId: string; timestamp: number; signature: string } {
  const canonical = `miner_register|${accountId}|${timestamp}`;
  const sig = ml_dsa65.sign(new TextEncoder().encode(canonical), hexToBytes(privateKeyHex));
  return { type: 'miner_register', accountId, timestamp, signature: bytesToHex(sig) };
}

// A signed panel_create operation (the applicant requests verification of their
// own account). Canonical bytes must match ae-node canonicalBytesFor exactly.
export function signPanelCreate(
  accountId: string,
  timestamp: number,
  privateKeyHex: string,
): { type: 'panel_create'; accountId: string; timestamp: number; signature: string } {
  const canonical = `panel_create|${accountId}|${timestamp}`;
  const sig = ml_dsa65.sign(new TextEncoder().encode(canonical), hexToBytes(privateKeyHex));
  return { type: 'panel_create', accountId, timestamp, signature: bytesToHex(sig) };
}

export function signPayload(payload: object, timestamp: number, privateKeyHex: string): string {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  const secretKey = hexToBytes(privateKeyHex);
  const sig = ml_dsa65.sign(data, secretKey);
  return bytesToHex(sig);
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

/**
 * Derive the accountId from a public key: the first 20 bytes of its SHA-256,
 * hex-encoded. Must stay byte-identical to ae-node's deriveAccountId in
 * core/crypto.ts, which is what actually assigns ids on the server.
 *
 * This exists so a 12-word recovery phrase is genuinely sufficient to restore
 * a wallet. Before it, the accountId was only ever computed server-side and
 * read back off the create-account response, so recovery demanded the phrase
 * AND a 40-character hex id the user had no reason to have written down.
 * Handing someone twelve words, calling them a recovery phrase, and then
 * requiring a second secret to use them is a data-loss trap: the phrase alone
 * is what every wallet in the world teaches people to keep.
 *
 * The derivation is deterministic and offline, so recovery needs no server
 * lookup and no by-public-key endpoint.
 */
export function deriveAccountId(publicKeyHex: string): string {
  return bytesToHex(sha256(hexToBytes(publicKeyHex)).slice(0, 20));
}

export { hexToBytes, bytesToHex };
