// Wire protocol for P2P messages.
//
// Every message on the network is signed with the sender's Ed25519 node key.
// Message structure on the wire:
//   { type, data, senderId, publicKey, timestamp, signature }
//
// The signature covers a canonical pipe-separated payload of every field
// except `signature` itself. JSON.stringify(data) is part of the payload —
// V8 preserves insertion order, so as long as senders construct the data
// object with consistent key order, this is deterministic.
//
// Why the publicKey is in every message (not just the handshake): it lets a
// receiver verify a message even before the handshake has completed in the
// other direction, and it lets us ban-list by publicKey (not by the
// spoofable senderId string).

import { ed25519 } from '@noble/curves/ed25519.js';
import type { NetworkMessage, MessageType, Handshake } from './types.js';
import type { NodeIdentity } from './node-identity.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Canonical bytes that get signed for a NetworkMessage. */
function canonicalMessageBytes(
  type: MessageType,
  data: unknown,
  senderId: string,
  publicKey: string,
  timestamp: number,
): string {
  // Pipe-separated. JSON.stringify on `data` is deterministic per V8 insertion order.
  return `${type}|${senderId}|${publicKey}|${timestamp}|${JSON.stringify(data ?? null)}`;
}

/** Canonical bytes that get signed for a Handshake (the data payload of a handshake message). */
export function canonicalHandshakeBytes(hs: Omit<Handshake, 'signature'>): string {
  // networkId folded into the signed bytes so a tampered handshake (peer
  // claims to be on mainnet but produced a signature for testnet) won't
  // verify. New field appended at end so existing fields' positions don't
  // shift; old handshakes (without networkId) won't verify on a v2 network
  // and that's intentional — they were generated against v1 genesis.
  return `${hs.nodeId}|${hs.publicKey}|${hs.version}|${hs.blockHeight}|${hs.genesisHash}|${hs.timestamp}|${hs.nonce}|${hs.networkId}`;
}

/** Build, sign, and serialize an outgoing network message. */
export function createMessage(
  type: MessageType,
  data: unknown,
  senderId: string,
  identity: NodeIdentity,
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = canonicalMessageBytes(type, data, senderId, identity.publicKey, timestamp);
  const sig = ed25519.sign(new TextEncoder().encode(payload), hexToBytes(identity.secretKey));
  const msg: NetworkMessage = {
    type,
    data,
    senderId,
    publicKey: identity.publicKey,
    timestamp,
    signature: bytesToHex(sig),
  };
  return JSON.stringify(msg);
}

/**
 * Parse a wire message and verify its signature. Returns null if:
 *   - the JSON is malformed,
 *   - any required field is missing,
 *   - the signature does not verify against the embedded publicKey.
 *
 * NOTE: ban-list checks happen at the PeerManager layer, not here. This
 * function only enforces "the bytes haven't been tampered with and the
 * sender holds the secret key for the claimed publicKey."
 */
export function parseMessage(raw: string): NetworkMessage | null {
  let msg: NetworkMessage;
  try {
    msg = JSON.parse(raw) as NetworkMessage;
  } catch {
    return null;
  }
  if (
    !msg ||
    typeof msg.type !== 'string' ||
    typeof msg.senderId !== 'string' ||
    typeof msg.publicKey !== 'string' ||
    typeof msg.timestamp !== 'number' ||
    typeof msg.signature !== 'string'
  ) {
    return null;
  }
  if (!verifyMessage(msg)) return null;
  return msg;
}

/** Verify the embedded signature on a parsed NetworkMessage. */
export function verifyMessage(msg: NetworkMessage): boolean {
  try {
    const pk = hexToBytes(msg.publicKey);
    if (pk.length !== 32) return false;
    const sig = hexToBytes(msg.signature);
    if (sig.length !== 64) return false;
    const payload = canonicalMessageBytes(
      msg.type,
      msg.data,
      msg.senderId,
      msg.publicKey,
      msg.timestamp,
    );
    return ed25519.verify(sig, new TextEncoder().encode(payload), pk);
  } catch {
    return false;
  }
}

/** Build a fully-signed Handshake. Caller supplies the connection-level fields. */
export function buildHandshake(
  identity: NodeIdentity,
  fields: {
    nodeId: string;
    version: string;
    blockHeight: number;
    networkId: string;
    genesisHash: string;
    nonce: string;
  },
): Handshake {
  const unsigned: Omit<Handshake, 'signature'> = {
    nodeId: fields.nodeId,
    publicKey: identity.publicKey,
    version: fields.version,
    blockHeight: fields.blockHeight,
    networkId: fields.networkId,
    genesisHash: fields.genesisHash,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: fields.nonce,
  };
  const sig = ed25519.sign(
    new TextEncoder().encode(canonicalHandshakeBytes(unsigned)),
    hexToBytes(identity.secretKey),
  );
  return { ...unsigned, signature: bytesToHex(sig) };
}

/**
 * Verify a Handshake.
 *   - signature must verify against the embedded publicKey
 *   - timestamp must be within ±replayWindowSec of now (default 300s)
 *   - publicKey must be the claimed length
 */
export function verifyHandshake(
  hs: Handshake,
  opts: { replayWindowSec?: number; nowSec?: number } = {},
): boolean {
  try {
    const replayWindow = opts.replayWindowSec ?? 300;
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - hs.timestamp) > replayWindow) return false;

    const pk = hexToBytes(hs.publicKey);
    if (pk.length !== 32) return false;
    const sig = hexToBytes(hs.signature);
    if (sig.length !== 64) return false;

    const unsigned: Omit<Handshake, 'signature'> = {
      nodeId: hs.nodeId,
      publicKey: hs.publicKey,
      version: hs.version,
      blockHeight: hs.blockHeight,
      networkId: hs.networkId,
      genesisHash: hs.genesisHash,
      timestamp: hs.timestamp,
      nonce: hs.nonce,
    };
    return ed25519.verify(sig, new TextEncoder().encode(canonicalHandshakeBytes(unsigned)), pk);
  } catch {
    return false;
  }
}

export function serializeBlock(block: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) {
    result[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return result;
}
