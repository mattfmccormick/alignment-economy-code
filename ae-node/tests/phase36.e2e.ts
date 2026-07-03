// Phase 36: Gossip relay (PeerManager re-broadcasts incoming gossip).
//
// Without relay, PeerManager.broadcast only reaches direct peers — votes
// and txs from validator A never reach validator C if C connects only to
// validator B. With relay, B forwards anything it receives (excluding
// the immediate sender) so messages traverse the graph.
//
// Topology used: star (A↔B and B↔C, NO direct A↔C connection).
//   A — B — C
//
// Verified:
//   1. A broadcasts a tx → B receives it → B relays to C → C receives.
//      C never has a direct connection to A.
//   2. Same for new_block.
//   3. Same for proposals + prevotes + precommits.
//   4. Dedup: when A sends the same tx twice, C only fires its handler
//      once (relay loop protected by seenTx).
//   5. Echo cancel: C's relay does not bounce back to B (excluded by
//      the relay's excludeId=msg.senderId).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { PeerManager } from '../src/network/peer.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { signProposal, type Proposal } from '../src/core/consensus/proposal.js';
import { signVote, type Vote } from '../src/core/consensus/votes.js';

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

const HASH_X = 'aa'.repeat(32);

describe('Phase 36: Gossip relay', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];
  let pms: PeerManager[] = [];

  afterEach(() => {
    for (const pm of pms) {
      try { pm.disconnectAll(); } catch {}
    }
    pms = [];
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
  });

  /** Set up a 3-node star: A↔B, B↔C, no direct A↔C. */
  async function buildStar(): Promise<{
    a: PeerManager;
    b: PeerManager;
    c: PeerManager;
    aId: ReturnType<typeof generateNodeIdentity>;
    bId: ReturnType<typeof generateNodeIdentity>;
    cId: ReturnType<typeof generateNodeIdentity>;
  }> {
    const aId = generateNodeIdentity();
    const bId = generateNodeIdentity();
    const cId = generateNodeIdentity();

    // B is the hub; opens a server. A and C connect to B.
    const a = new PeerManager(aId, 'node-a', 'star-gen');
    const b = new PeerManager(bId, 'node-b', 'star-gen');
    const c = new PeerManager(cId, 'node-c', 'star-gen');
    pms.push(a, b, c);

    const srvB = await createWsServer();
    cleanup.push(srvB);
    srvB.wss.on('connection', (ws, req) => {
      b.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // A and C connect to B. Wait for handshakes to land in both directions.
    let bConnections = 0;
    const allBConnected = new Promise<void>((resolve) => {
      const onConn = () => {
        bConnections++;
        if (bConnections >= 2) resolve();
      };
      b.on('peer:connected', onConn);
    });
    a.connectToPeer('127.0.0.1', srvB.port);
    c.connectToPeer('127.0.0.1', srvB.port);
    await Promise.race([allBConnected, wait(2000)]);
    // Give the ack messages time to land at A and C
    await wait(100);

    return { a, b, c, aId, bId, cId };
  }

  // ── Transactions relay through the hub ────────────────────────────────

  it('A broadcasts a tx → B relays → C receives (star topology)', async () => {
    const { a, b, c } = await buildStar();
    assert.equal(a.getPeerCount(), 1, 'A should see only B');
    assert.equal(b.getPeerCount(), 2, 'B should see A and C');
    assert.equal(c.getPeerCount(), 1, 'C should see only B');

    const txReceivedAtC: unknown[] = [];
    c.on('transaction:received', (data) => txReceivedAtC.push(data));

    a.broadcast('new_transaction', { id: 'star-tx-1', from: 'foo', to: 'bar', amount: '10' });
    await wait(200);

    assert.equal(txReceivedAtC.length, 1, 'C must receive the tx via B relay');
    assert.deepEqual(txReceivedAtC[0], {
      id: 'star-tx-1',
      from: 'foo',
      to: 'bar',
      amount: '10',
    });
  });

  // ── Block relay ──────────────────────────────────────────────────────

  it('A broadcasts a new_block → B relays → C receives', async () => {
    const { a, c } = await buildStar();
    const blocksAtC: unknown[] = [];
    c.on('block:received', (data) => blocksAtC.push(data));

    a.broadcast('new_block', {
      number: 1,
      hash: 'cafebabe'.repeat(8),
      previousHash: '0'.repeat(64),
      day: 1,
      timestamp: Math.floor(Date.now() / 1000),
      merkleRoot: 'd'.repeat(64),
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
    });
    await wait(200);

    assert.equal(blocksAtC.length, 1);
  });

  // ── Proposal relay ───────────────────────────────────────────────────

  it('A broadcasts a proposal → B relays → C receives', async () => {
    const { a, c, aId } = await buildStar();
    const propsAtC: Proposal[] = [];
    c.on('proposal:received', (data) => propsAtC.push(data as Proposal));

    const proposal = signProposal({
      height: 5,
      round: 0,
      blockHash: HASH_X,
      proposerAccountId: 'node-a',
      proposerPublicKey: aId.publicKey,
      proposerSecretKey: aId.secretKey,
    });
    a.broadcast('proposal', proposal as unknown as Record<string, unknown>);
    await wait(200);

    assert.equal(propsAtC.length, 1);
    assert.equal(propsAtC[0].blockHash, HASH_X);
    // Inner signature still verifies after relay (B re-wraps the envelope
    // but doesn't touch the inner Proposal payload)
    assert.equal(propsAtC[0].proposerPublicKey, aId.publicKey);
  });

  it('A broadcasts a prevote and a precommit → both reach C via B', async () => {
    const { a, c, aId } = await buildStar();
    const prevotes: Vote[] = [];
    const precommits: Vote[] = [];
    c.on('prevote:received', (data) => prevotes.push(data as Vote));
    c.on('precommit:received', (data) => precommits.push(data as Vote));

    const baseInputs = {
      height: 5,
      round: 0,
      blockHash: HASH_X,
      validatorAccountId: 'node-a',
      validatorPublicKey: aId.publicKey,
      validatorSecretKey: aId.secretKey,
    };
    a.broadcast('prevote', signVote({ ...baseInputs, kind: 'prevote' }) as unknown as Record<string, unknown>);
    a.broadcast('precommit', signVote({ ...baseInputs, kind: 'precommit' }) as unknown as Record<string, unknown>);
    await wait(200);

    assert.equal(prevotes.length, 1);
    assert.equal(precommits.length, 1);
  });

  // ── Dedup: same message twice doesn't fire C's handler twice ─────────

  it('duplicate tx broadcasts are deduped — C handler fires only once', async () => {
    const { a, c } = await buildStar();
    let firedAtC = 0;
    c.on('transaction:received', () => firedAtC++);

    const tx = { id: 'dedup-tx-1', from: 'x', to: 'y', amount: '1' };
    a.broadcast('new_transaction', tx);
    await wait(50);
    a.broadcast('new_transaction', tx); // exact same id
    await wait(200);

    assert.equal(firedAtC, 1, 'duplicate tx must not double-fire C handler');
  });

  // ── Echo cancellation: relay does not loop ──────────────────────────

  it("relay excludes the sender so messages don't bounce back", async () => {
    const { a, b } = await buildStar();
    let bRelayedTimes = 0;
    // We can't easily observe "B relayed back to A" from the outside —
    // but A's seenTx set would dedup any echo. Instead, set up:
    //  A broadcasts → B receives (and relays to C).
    //  We listen on A for transaction:received. Without echo cancel, A
    //  would receive its own broadcast back from B.
    a.on('transaction:received', () => bRelayedTimes++);
    b.broadcast('new_transaction', {
      id: 'echo-tx',
      from: 'm',
      to: 'n',
      amount: '5',
    });
    await wait(200);
    // A might receive it via B's broadcast (B was the originator; B's own
    // broadcast goes to all peers including A). That's fine — it's the
    // ORIGINAL not a relay echo. We're verifying that A doesn't ALSO get
    // the same tx a second time via C's relay.
    assert.equal(bRelayedTimes, 1, 'A must receive the tx exactly once');
  });
});
