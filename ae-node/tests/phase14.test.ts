// Phase 14: Signed P2P handshakes, signed messages, and ban list.
//
// Verifies the security properties our P2P layer depends on once we've moved
// beyond the unauthenticated phase-10 protocol:
//   1. Round-trip: createMessage → parseMessage verifies the embedded signature.
//   2. Tampered data, tampered signature, swapped publicKey all fail verifyMessage.
//   3. Handshake replay window is enforced (stale timestamps rejected).
//   4. Handshake whose envelope publicKey doesn't match the inner publicKey is rejected.
//   5. Self-connection (same publicKey on both ends) is rejected.
//   6. Ban list disconnects an existing connection AND prevents reconnect.
//   7. NodeIdentity is persisted on disk and re-loaded across restarts.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { ed25519 } from '@noble/curves/ed25519.js';

import { PeerManager } from '../src/network/peer.js';
import {
  createMessage,
  parseMessage,
  verifyMessage,
  buildHandshake,
  verifyHandshake,
} from '../src/network/messages.js';
import {
  generateNodeIdentity,
  loadOrCreateNodeIdentity,
  signNodeMessage,
  verifyNodeMessage,
} from '../src/network/node-identity.js';
import type { NetworkMessage, Handshake } from '../src/network/types.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function createWsServer(): Promise<{ server: Server; wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, wss, port: addr.port });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Phase 14: Signed P2P handshakes + ban list', () => {
  const cleanupServers: Array<{ server: Server; wss: WebSocketServer }> = [];
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const s of cleanupServers) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanupServers.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    cleanupDirs.length = 0;
  });

  // ── createMessage / parseMessage round-trip and tampering ───────────────

  it('round-trips a signed message through parseMessage', () => {
    const id = generateNodeIdentity();
    const wire = createMessage('ping', { hello: 'world' }, 'node-x', id);
    const parsed = parseMessage(wire);
    assert.ok(parsed, 'message must verify and parse');
    assert.equal(parsed!.type, 'ping');
    assert.deepEqual(parsed!.data, { hello: 'world' });
    assert.equal(parsed!.publicKey, id.publicKey);
  });

  it('parseMessage returns null when data is tampered after signing', () => {
    const id = generateNodeIdentity();
    const wire = createMessage('new_transaction', { id: 'tx-1', amount: '100' }, 'node-x', id);
    const parsed = JSON.parse(wire) as NetworkMessage;
    // Tamper with the data after the signature was computed
    (parsed.data as Record<string, unknown>).amount = '999999';
    const tampered = JSON.stringify(parsed);
    assert.equal(parseMessage(tampered), null);
  });

  it('parseMessage returns null when signature is tampered', () => {
    const id = generateNodeIdentity();
    const wire = createMessage('ping', null, 'node-x', id);
    const parsed = JSON.parse(wire) as NetworkMessage;
    // Flip one byte of the signature
    const sigBytes = hexToBytes(parsed.signature);
    sigBytes[0] ^= 0x01;
    parsed.signature = bytesToHex(sigBytes);
    assert.equal(parseMessage(JSON.stringify(parsed)), null);
  });

  it('parseMessage returns null when publicKey is swapped to a different valid key', () => {
    const idA = generateNodeIdentity();
    const idB = generateNodeIdentity();
    const wire = createMessage('ping', null, 'node-x', idA);
    const parsed = JSON.parse(wire) as NetworkMessage;
    // Swap to B's pubkey; A's signature won't verify under B's key
    parsed.publicKey = idB.publicKey;
    assert.equal(parseMessage(JSON.stringify(parsed)), null);
  });

  it('verifyMessage exposes the same check directly', () => {
    const id = generateNodeIdentity();
    const wire = createMessage('ping', { x: 1 }, 'node-x', id);
    const parsed = JSON.parse(wire) as NetworkMessage;
    assert.equal(verifyMessage(parsed), true);
    parsed.timestamp = parsed.timestamp + 1; // change one byte of signed payload
    assert.equal(verifyMessage(parsed), false);
  });

  // ── Handshake-specific checks ──────────────────────────────────────────

  it('verifyHandshake rejects stale timestamps outside the replay window', () => {
    const id = generateNodeIdentity();
    const hs = buildHandshake(id, {
      nodeId: 'n1',
      version: '0.1.0',
      blockHeight: 0,
      genesisHash: 'g',
      nonce: 'abc123',
    });
    // Pretend we're 10 minutes in the future
    const future = hs.timestamp + 10 * 60;
    assert.equal(verifyHandshake(hs, { nowSec: future, replayWindowSec: 300 }), false);
    // Within window
    assert.equal(verifyHandshake(hs, { nowSec: hs.timestamp + 60, replayWindowSec: 300 }), true);
  });

  it('verifyHandshake rejects a handshake whose signature was made with a different key', () => {
    const idA = generateNodeIdentity();
    const idB = generateNodeIdentity();
    const hs = buildHandshake(idA, {
      nodeId: 'n1',
      version: '0.1.0',
      blockHeight: 0,
      genesisHash: 'g',
      nonce: 'abc123',
    });
    // Replace the publicKey field to claim it's from idB
    const tampered: Handshake = { ...hs, publicKey: idB.publicKey };
    assert.equal(verifyHandshake(tampered), false);
  });

  // ── Live two-node handshake + ban list ─────────────────────────────────

  it('rejects a peer connecting with a publicKey already on the ban list', async () => {
    const idA = generateNodeIdentity();
    const idB = generateNodeIdentity();
    const nodeA = new PeerManager(idA, 'node-a', 'g-ban');
    const nodeB = new PeerManager(idB, 'node-b', 'g-ban');

    const srv = await createWsServer();
    cleanupServers.push(srv);
    srv.wss.on('connection', (ws, req) => {
      nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // Pre-ban B before they ever connect
    nodeA.banPeer(idB.publicKey, 'pre-ban for test');

    nodeB.connectToPeer('127.0.0.1', srv.port);
    await wait(200);

    assert.equal(nodeA.getPeerCount(), 0, 'A should not accept a banned peer');
    assert.equal(nodeA.isBanned(idB.publicKey), true);

    nodeA.disconnectAll();
    nodeB.disconnectAll();
  });

  it('disconnects an active peer when they get banned mid-session', async () => {
    const idA = generateNodeIdentity();
    const idB = generateNodeIdentity();
    const nodeA = new PeerManager(idA, 'node-a', 'g-mid-ban');
    const nodeB = new PeerManager(idB, 'node-b', 'g-mid-ban');

    const srv = await createWsServer();
    cleanupServers.push(srv);
    srv.wss.on('connection', (ws, req) => {
      nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const connected = new Promise<void>((resolve) => {
      nodeA.once('peer:connected', () => resolve());
    });
    nodeB.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);
    assert.equal(nodeA.getPeerCount(), 1);

    // Ban B mid-session
    nodeA.banPeer(idB.publicKey, 'misbehavior');
    await wait(100);

    assert.equal(nodeA.getPeerCount(), 0, 'banned peer must be disconnected');

    nodeA.disconnectAll();
    nodeB.disconnectAll();
  });

  it('rejects a self-connection (same publicKey on both ends)', async () => {
    const id = generateNodeIdentity();
    const nodeA = new PeerManager(id, 'node-a', 'g-self');
    const nodeB = new PeerManager(id, 'node-b', 'g-self'); // SAME identity, different label

    const srv = await createWsServer();
    cleanupServers.push(srv);
    srv.wss.on('connection', (ws, req) => {
      nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    nodeB.connectToPeer('127.0.0.1', srv.port);
    await wait(200);

    assert.equal(nodeA.getPeerCount(), 0, 'self-connection must be rejected');

    nodeA.disconnectAll();
    nodeB.disconnectAll();
  });

  // ── Persistence of NodeIdentity ────────────────────────────────────────

  it('loadOrCreateNodeIdentity persists the keypair across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ae-node-id-'));
    cleanupDirs.push(dir);
    const path = join(dir, 'node-key.json');
    assert.equal(existsSync(path), false);

    const first = loadOrCreateNodeIdentity(path);
    assert.ok(first.publicKey.length === 64);
    assert.ok(first.secretKey.length === 64);
    assert.equal(existsSync(path), true);

    const second = loadOrCreateNodeIdentity(path);
    assert.equal(second.publicKey, first.publicKey);
    assert.equal(second.secretKey, first.secretKey);
  });

  it('signNodeMessage / verifyNodeMessage round-trip and reject tampering', () => {
    const id = generateNodeIdentity();
    const sig = signNodeMessage(id.secretKey, 'hello world');
    assert.equal(verifyNodeMessage(id.publicKey, 'hello world', sig), true);
    assert.equal(verifyNodeMessage(id.publicKey, 'hello WORLD', sig), false);

    const other = generateNodeIdentity();
    assert.equal(verifyNodeMessage(other.publicKey, 'hello world', sig), false);
  });

  // ── Sanity: a handshake signed by an UNKNOWN key from outside the
  //    PeerManager API still gets rejected at the wire level. This catches
  //    the case where someone bypasses buildHandshake and crafts their own.
  it('rejects a hand-crafted handshake whose signature does not verify', async () => {
    const idA = generateNodeIdentity();
    const nodeA = new PeerManager(idA, 'node-a', 'g-rogue');

    const srv = await createWsServer();
    cleanupServers.push(srv);
    srv.wss.on('connection', (ws, req) => {
      nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // Open a raw WebSocket and send a deliberately-broken signed message
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((r) => ws.once('open', () => r()));

    const idB = generateNodeIdentity();
    const hs: Handshake = {
      nodeId: 'rogue',
      publicKey: idB.publicKey,
      version: '0.1.0',
      blockHeight: 0,
      genesisHash: 'g-rogue',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'feedface',
      signature: '00'.repeat(64), // garbage
    };
    // Build a valid envelope (createMessage signs the envelope) wrapping
    // a Handshake whose inner signature is invalid. The envelope verifies
    // (so parseMessage passes) but validateHandshake will reject.
    const envelope = createMessage('handshake', hs, 'rogue', idB);
    ws.send(envelope);

    await wait(200);
    assert.equal(nodeA.getPeerCount(), 0);

    ws.close();
    nodeA.disconnectAll();
  });

  // ── Sanity: ed25519 keys generated by us are usable raw via @noble. This
  //    guards against an upstream change to the secret-key encoding.
  it('NodeIdentity secret keys are 32 raw Ed25519 bytes (not seed+pub)', () => {
    const id = generateNodeIdentity();
    assert.equal(id.secretKey.length, 64); // 32 bytes hex = 64 chars
    const pkDerived = bytesToHex(ed25519.getPublicKey(hexToBytes(id.secretKey)));
    assert.equal(pkDerived, id.publicKey);
  });
});
