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

// A signed panel_score operation (a miner scores an open verification panel).
// Canonical bytes must match ae-node canonicalBytesFor exactly.
export function signPanelScore(
  accountId: string,
  panelId: string,
  score: number,
  timestamp: number,
  privateKeyHex: string,
): { type: 'panel_score'; accountId: string; panelId: string; score: number; timestamp: number; signature: string } {
  const canonical = `panel_score|${accountId}|${panelId}|${score}|${timestamp}`;
  const sig = ml_dsa65.sign(new TextEncoder().encode(canonical), hexToBytes(privateKeyHex));
  return { type: 'panel_score', accountId, panelId, score, timestamp, signature: bytesToHex(sig) };
}

// Vouch signing lives in the wallet (ae-app). People vouch; miners verify.

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
