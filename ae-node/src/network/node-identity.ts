// Node identity — the long-lived Ed25519 keypair that identifies this AE
// node on the P2P network. Distinct from:
//   - Account keys (ML-DSA-65, used to sign transactions)
//   - VRF keys (Ed25519 used by miners for the lottery)
//   - Node ID (a friendly string identifier — the node's PUBLIC KEY proves
//     who actually owns that string at the network level)
//
// Persisted at <dataDir>/node-key.json. Generated on first boot, loaded on
// every subsequent boot. Without this, a node's identity would change on
// every restart and ban-listing wouldn't survive a restart.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';

export interface NodeIdentity {
  /** Hex-encoded Ed25519 public key. 32 bytes. Acts as the node's network identity. */
  publicKey: string;
  /** Hex-encoded Ed25519 secret key. 32 bytes. Never sent over the wire. */
  secretKey: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateNodeIdentity(): NodeIdentity {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { publicKey: bytesToHex(publicKey), secretKey: bytesToHex(secretKey) };
}

/**
 * Load the node's identity from disk, generating + persisting a fresh one if
 * the file doesn't exist. The file is created with chmod 600 (owner-only)
 * because it contains the secret key.
 */
export function loadOrCreateNodeIdentity(path: string): NodeIdentity {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as NodeIdentity;
    if (!parsed.publicKey || !parsed.secretKey) {
      throw new Error(`Node identity at ${path} is malformed`);
    }
    return parsed;
  }

  mkdirSync(dirname(path), { recursive: true });
  const id = generateNodeIdentity();
  writeFileSync(path, JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

/** Sign a payload with the node's secret key. Used for handshake + every gossip msg. */
export function signNodeMessage(secretKeyHex: string, payload: string): string {
  const sk = hexToBytes(secretKeyHex);
  const msg = new TextEncoder().encode(payload);
  return bytesToHex(ed25519.sign(msg, sk));
}

/** Verify a signature against a peer's advertised public key. */
export function verifyNodeMessage(
  publicKeyHex: string,
  payload: string,
  signatureHex: string,
): boolean {
  try {
    const pk = hexToBytes(publicKeyHex);
    if (pk.length !== 32) return false;
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 64) return false;
    const msg = new TextEncoder().encode(payload);
    return ed25519.verify(sig, msg, pk);
  } catch {
    return false;
  }
}
