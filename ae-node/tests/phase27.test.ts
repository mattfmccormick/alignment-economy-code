// Phase 27: PeerManager BFT transport adapter.
//
// Bridges the in-memory IBftTransport contract (Session 20) onto the
// signed-gossip wire from Session 8. Two real PeerManagers connect over
// a real WebSocket; one broadcasts a proposal/vote via the adapter, the
// other receives it via its own adapter's handler.
//
// What's verified:
//   1. broadcastProposal arrives at the peer's onProposal handler
//      with the same blockHash + signature it left with.
//   2. broadcastVote (prevote) routes through onVote.
//   3. broadcastVote (precommit) also routes through onVote.
//   4. Inner signatures survive the round trip — the receiver can
//      still call verifyVote / verifyProposal successfully.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { PeerManager } from '../src/network/peer.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { PeerManagerBftTransport } from '../src/core/consensus/PeerManagerBftTransport.js';
import { signProposal, verifyProposal, type Proposal } from '../src/core/consensus/proposal.js';
import { signVote, verifyVote, type Vote } from '../src/core/consensus/votes.js';

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

const HASH_X = '11'.repeat(32);

describe('Phase 27: PeerManager BFT transport adapter', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];

  afterEach(() => {
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
  });

  /** Set up two connected PeerManagers and return their adapters. */
  async function connectedPair(): Promise<{
    a: PeerManager;
    b: PeerManager;
    transportA: PeerManagerBftTransport;
    transportB: PeerManagerBftTransport;
    aIdentity: ReturnType<typeof generateNodeIdentity>;
    bIdentity: ReturnType<typeof generateNodeIdentity>;
  }> {
    const aIdentity = generateNodeIdentity();
    const bIdentity = generateNodeIdentity();
    const a = new PeerManager(aIdentity, 'node-a', 'phase27-genesis');
    const b = new PeerManager(bIdentity, 'node-b', 'phase27-genesis');
    const transportA = new PeerManagerBftTransport(a);
    const transportB = new PeerManagerBftTransport(b);

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      a.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const aConnected = new Promise<void>((resolve) =>
      a.once('peer:connected', () => resolve()),
    );
    b.connectToPeer('127.0.0.1', srv.port);
    await aConnected;
    // Give B time to process the handshake_ack so it lists A as peer
    await wait(50);

    return { a, b, transportA, transportB, aIdentity, bIdentity };
  }

  it('broadcastProposal arrives at the peer with intact signature', async () => {
    const env = await connectedPair();
    const { transportA, transportB, bIdentity } = env;

    const received: Proposal[] = [];
    transportA.onProposal((p) => received.push(p));

    // B (the proposer) signs with its node identity (acting as a validator key)
    const proposal = signProposal({
      height: 7,
      round: 0,
      blockHash: HASH_X,
      proposerAccountId: 'b-account',
      proposerPublicKey: bIdentity.publicKey,
      proposerSecretKey: bIdentity.secretKey,
    });
    transportB.broadcastProposal(proposal);

    await wait(100);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], proposal);
    // Inner signature still verifies after round-trip
    assert.equal(verifyProposal(received[0]), true);

    env.a.disconnectAll();
    env.b.disconnectAll();
  });

  it('broadcastVote (prevote) arrives via onVote', async () => {
    const env = await connectedPair();
    const { transportA, transportB, bIdentity } = env;

    const received: Vote[] = [];
    transportA.onVote((v) => received.push(v));

    const vote = signVote({
      kind: 'prevote',
      height: 7,
      round: 0,
      blockHash: HASH_X,
      validatorAccountId: 'b-account',
      validatorPublicKey: bIdentity.publicKey,
      validatorSecretKey: bIdentity.secretKey,
    });
    transportB.broadcastVote(vote);

    await wait(100);
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 'prevote');
    assert.deepEqual(received[0], vote);
    assert.equal(verifyVote(received[0]), true);

    env.a.disconnectAll();
    env.b.disconnectAll();
  });

  it('broadcastVote (precommit) arrives via onVote', async () => {
    const env = await connectedPair();
    const { transportA, transportB, bIdentity } = env;

    const received: Vote[] = [];
    transportA.onVote((v) => received.push(v));

    const vote = signVote({
      kind: 'precommit',
      height: 7,
      round: 0,
      blockHash: HASH_X,
      validatorAccountId: 'b-account',
      validatorPublicKey: bIdentity.publicKey,
      validatorSecretKey: bIdentity.secretKey,
    });
    transportB.broadcastVote(vote);

    await wait(100);
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 'precommit');
    assert.deepEqual(received[0], vote);
    assert.equal(verifyVote(received[0]), true);

    env.a.disconnectAll();
    env.b.disconnectAll();
  });

  it('mixed prevotes + precommits all funnel through onVote', async () => {
    const env = await connectedPair();
    const { transportA, transportB, bIdentity } = env;

    const prevotes: Vote[] = [];
    const precommits: Vote[] = [];
    transportA.onVote((v) => {
      if (v.kind === 'prevote') prevotes.push(v);
      else precommits.push(v);
    });

    transportB.broadcastVote(signVote({
      kind: 'prevote',
      height: 1, round: 0, blockHash: HASH_X,
      validatorAccountId: 'b-account',
      validatorPublicKey: bIdentity.publicKey,
      validatorSecretKey: bIdentity.secretKey,
    }));
    transportB.broadcastVote(signVote({
      kind: 'precommit',
      height: 1, round: 0, blockHash: HASH_X,
      validatorAccountId: 'b-account',
      validatorPublicKey: bIdentity.publicKey,
      validatorSecretKey: bIdentity.secretKey,
    }));

    await wait(150);
    assert.equal(prevotes.length, 1);
    assert.equal(precommits.length, 1);

    env.a.disconnectAll();
    env.b.disconnectAll();
  });

  it('proposal and votes can be VRF-key-different from the node identity (sanity)', async () => {
    // In production a validator's vote-signing key is the same as their
    // node identity (Session 14 design), but the VRF key is separate.
    // This test confirms the transport doesn't care WHO signed the
    // payload — that's the BFT layer's job.
    const env = await connectedPair();
    const { transportA, transportB } = env;

    const received: Proposal[] = [];
    transportA.onProposal((p) => received.push(p));

    // Use a totally different validator identity for the proposal
    const validatorKey = generateNodeIdentity();
    const proposal = signProposal({
      height: 9,
      round: 0,
      blockHash: HASH_X,
      proposerAccountId: 'unrelated-validator',
      proposerPublicKey: validatorKey.publicKey,
      proposerSecretKey: validatorKey.secretKey,
    });
    transportB.broadcastProposal(proposal);

    await wait(100);
    assert.equal(received.length, 1);
    // Inner signature still verifies under the validator's key, not B's
    assert.equal(verifyProposal(received[0]), true);
    // Sanity: the proposer we signed as does not equal B's gossip identity
    assert.notEqual(proposal.proposerPublicKey, env.bIdentity.publicKey);
    void Ed25519VrfProvider; // keep import meaningful

    env.a.disconnectAll();
    env.b.disconnectAll();
  });
});
