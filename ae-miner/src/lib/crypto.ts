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
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function signPayload(payload: object, timestamp: number, privateKeyHex: string): string {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  const secretKey = hexToBytes(privateKeyHex);
  const sig = ml_dsa65.sign(data, secretKey);
  return bytesToHex(sig);
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

// ─── Vouch operations (audit #4/#16) ─────────────────────────────────────
//
// A vouch now rides the chain, so the client signs a VouchOperation over its
// CANONICAL pipe-delimited bytes - byte-identical to ae-node's
// verification/vouch-operation.ts canonicalBytesFor(). The route verifies this
// signature against the voucher's public key and queues the op for a block.
// This is a raw ML-DSA sign over the canonical string, NOT the JSON+timestamp
// envelope signPayload uses.

function signCanonical(message: string, privateKeyHex: string): string {
  const sig = ml_dsa65.sign(new TextEncoder().encode(message), hexToBytes(privateKeyHex));
  return bytesToHex(sig);
}

export interface VouchOpCreate {
  type: 'vouch_create';
  voucherId: string;
  vouchedId: string;
  stakePercent: number;
  timestamp: number;
  signature: string;
}

export interface VouchOpWithdraw {
  type: 'vouch_withdraw';
  voucherId: string;
  vouchId: string;
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
  return {
    type: 'vouch_create',
    voucherId,
    vouchedId,
    stakePercent,
    timestamp,
    signature: signCanonical(canonical, privateKeyHex),
  };
}

export function signVouchWithdraw(
  voucherId: string,
  vouchId: string,
  timestamp: number,
  privateKeyHex: string,
): VouchOpWithdraw {
  const canonical = `vouch_withdraw|${voucherId}|${vouchId}|${timestamp}`;
  return {
    type: 'vouch_withdraw',
    voucherId,
    vouchId,
    timestamp,
    signature: signCanonical(canonical, privateKeyHex),
  };
}

// ─── BIP39 mnemonic-derived keys ─────────────────────────────────────────
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(phrase.trim(), wordlist);
}

export function mnemonicToKeypair(phrase: string): { publicKey: string; privateKey: string } {
  const seed64 = mnemonicToSeedSync(phrase.trim(), '');
  const seed32 = seed64.slice(0, 32);
  const kp = ml_dsa65.keygen(seed32);
  return {
    publicKey: bytesToHex(kp.publicKey),
    privateKey: bytesToHex(kp.secretKey),
  };
}

export { hexToBytes, bytesToHex };
