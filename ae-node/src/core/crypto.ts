import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { createHash, createHmac } from 'node:crypto';

export interface KeyPair {
  publicKey: string;   // hex-encoded ML-DSA-65 public key (1952 bytes)
  privateKey: string;  // hex-encoded ML-DSA-65 secret key (4032 bytes)
}

export function generateKeyPair(): KeyPair {
  const kp = ml_dsa65.keygen();
  return {
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
    privateKey: Buffer.from(kp.secretKey).toString('hex'),
  };
}

export function deriveAccountId(publicKeyHex: string): string {
  const hash = sha256(Buffer.from(publicKeyHex, 'hex'));
  return hash.slice(0, 40); // first 20 bytes = 40 hex chars
}

export function sign(data: Uint8Array, privateKeyHex: string): string {
  const secretKey = Buffer.from(privateKeyHex, 'hex');
  const sig = ml_dsa65.sign(data, secretKey);
  return Buffer.from(sig).toString('hex');
}

export function verify(
  data: Uint8Array,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const sig = Buffer.from(signatureHex, 'hex');
    const pubKey = Buffer.from(publicKeyHex, 'hex');
    return ml_dsa65.verify(sig, data, pubKey);
  } catch {
    return false;
  }
}

export function sha256(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Buffer | string, data: Buffer | string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function signPayload(payload: object, timestamp: number, privateKeyHex: string): string {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  return sign(data, privateKeyHex);
}

export function verifyPayload(
  payload: object,
  timestamp: number,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const message = JSON.stringify(payload) + timestamp.toString();
  const data = new TextEncoder().encode(message);
  return verify(data, signatureHex, publicKeyHex);
}
