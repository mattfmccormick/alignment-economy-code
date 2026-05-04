import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock, createBlock, getLatestBlock } from '../src/core/block.js';
import { PeerManager } from '../src/network/peer.js';
import { Mempool } from '../src/network/mempool.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import { ChainSync } from '../src/network/sync.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
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

/** Connect two PeerManagers: creates server for nodeA, nodeB connects to it */
async function connectPair(
  nodeA: PeerManager,
  nodeB: PeerManager,
  cleanup: Array<{ server: Server; wss: WebSocketServer }>,
): Promise<{ port: number }> {
  const srv = await createWsServer();
  cleanup.push(srv);
  srv.wss.on('connection', (ws, req) => {
    nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
  });

  const connected = new Promise<void>((resolve) => {
    nodeA.once('peer:connected', () => resolve());
  });

  nodeB.connectToPeer('127.0.0.1', srv.port);
  await connected;
  // Give B time to process handshake_ack
  await wait(50);
  return { port: srv.port };
}

describe('Phase 10: P2P Networking', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];

  afterEach(() => {
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
  });

  // Test 1: Peer discovery - two nodes connect via WebSocket and complete handshake
  it('discovers peers via handshake exchange', async () => {
    const nodeA = new PeerManager(generateNodeIdentity(), 'node-a', 'genesis-1');
    const nodeB = new PeerManager(generateNodeIdentity(), 'node-b', 'genesis-1');

    await connectPair(nodeA, nodeB, cleanup);

    assert.equal(nodeA.getPeerCount(), 1);
    assert.equal(nodeB.getPeerCount(), 1);
    assert.equal(nodeA.getConnectedPeers()[0].id, 'node-b');
    assert.equal(nodeB.getConnectedPeers()[0].id, 'node-a');

    nodeA.disconnectAll();
    nodeB.disconnectAll();
  });

  // Test 2: Transaction propagation - send tx from B, A receives it
  it('propagates transactions across peers', async () => {
    const nodeA = new PeerManager(generateNodeIdentity(), 'node-a', 'genesis-2');
    const nodeB = new PeerManager(generateNodeIdentity(), 'node-b', 'genesis-2');

    await connectPair(nodeA, nodeB, cleanup);

    const txReceived = new Promise<any>((resolve) => {
      nodeA.on('transaction:received', (data) => resolve(data));
    });

    // B broadcasts; B has A as a peer after handshake_ack
    nodeB.broadcast('new_transaction', { id: 'tx-001', from: 'alice', to: 'bob', amount: '100' });

    const receivedTx = await txReceived;
    assert.equal(receivedTx.id, 'tx-001');
    assert.equal(receivedTx.from, 'alice');

    nodeA.disconnectAll();
    nodeB.disconnectAll();
  });

  // Test 3: Chain sync after restart - node catches up on missed blocks
  it('syncs chain from peer after restart', async () => {
    // Authority node has 3 blocks. We use empty txIds because this test
    // exercises chain-sync mechanics, not transaction linkage. Creating
    // blocks with synthetic ids (e.g. 'tx1') would leave their stored
    // txIds empty (nothing to link to) and fail the strong merkle check
    // sync now performs.
    const dbAuth = freshDb();
    createGenesisBlock(dbAuth);
    createBlock(dbAuth, 1, []);
    createBlock(dbAuth, 1, []);
    createBlock(dbAuth, 1, []);
    assert.equal(getLatestBlock(dbAuth)!.number, 3);

    const authPeers = new PeerManager(generateNodeIdentity(), 'authority', 'sync-gen');
    authPeers.setBlockHeight(3);
    const authConsensus = new AuthorityConsensus('authority', 'authority');

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      authPeers.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // ChainSync on authority handles block requests
    const _authSync = new ChainSync(dbAuth, authPeers, authConsensus);

    // New node with only genesis
    const dbNew = freshDb();
    createGenesisBlock(dbNew);

    const newPeers = new PeerManager(generateNodeIdentity(), 'new-node', 'sync-gen');
    newPeers.setBlockHeight(0);
    const newConsensus = new AuthorityConsensus('authority', 'new-node');
    const newSync = new ChainSync(dbNew, newPeers, newConsensus);

    const appliedBlocks: number[] = [];
    newSync.setBlockApplyHandler((blockData) => {
      appliedBlocks.push(blockData.number as number);
      dbNew.prepare(
        `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count, rebase_event)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        blockData.number,
        blockData.day,
        blockData.timestamp,
        blockData.previousHash ?? blockData.previous_hash,
        blockData.hash,
        blockData.merkleRoot ?? blockData.merkle_root,
        blockData.transactionCount ?? blockData.transaction_count,
        null,
      );
      return true;
    });

    // Connect and wait for handshake
    const connected = new Promise<void>((resolve) => {
      newPeers.once('peer:connected', () => resolve());
    });
    newPeers.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);

    // Trigger sync
    newSync.startSync();
    await wait(500);

    assert.deepEqual(appliedBlocks, [1, 2, 3]);
    assert.equal(newPeers.getBlockHeight(), 3);

    authPeers.disconnectAll();
    newPeers.disconnectAll();
  });

  // Test 4: Transaction deduplication - same tx received twice only processes once
  it('deduplicates transactions seen multiple times', async () => {
    const nodeA = new PeerManager(generateNodeIdentity(), 'node-a', 'dedup-gen');
    const nodeB = new PeerManager(generateNodeIdentity(), 'node-b', 'dedup-gen');
    const nodeC = new PeerManager(generateNodeIdentity(), 'node-c', 'dedup-gen');

    // A is the server; B and C connect
    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    let connCount = 0;
    const allConnected = new Promise<void>((resolve) => {
      nodeA.on('peer:connected', () => { connCount++; if (connCount >= 2) resolve(); });
    });

    nodeB.connectToPeer('127.0.0.1', srv.port);
    nodeC.connectToPeer('127.0.0.1', srv.port);
    await allConnected;
    // Wait for B and C to process their handshake_ack so they have A as a peer
    await wait(100);

    assert.ok(nodeB.getPeerCount() >= 1, 'B should have A as peer');
    assert.ok(nodeC.getPeerCount() >= 1, 'C should have A as peer');

    let txCount = 0;
    nodeA.on('transaction:received', () => { txCount++; });

    const tx = { id: 'dup-tx-001', from: 'alice', to: 'bob', amount: '50' };
    nodeB.broadcast('new_transaction', tx);
    // Small delay so both messages arrive separately
    await wait(50);
    nodeC.broadcast('new_transaction', tx);

    await wait(200);
    assert.equal(txCount, 1, 'duplicate tx should be filtered');

    nodeA.disconnectAll();
    nodeB.disconnectAll();
    nodeC.disconnectAll();
  });

  // Test 5: Mempool determinism
  it('returns deterministically sorted transactions from mempool', () => {
    const mempool = new Mempool();

    const mkTx = (id: string, ts: number) => ({
      id, from: 'a', to: 'b', amount: 100n, fee: 1n, netAmount: 99n,
      pointType: 'earned' as const, isInPerson: false, memo: '', signature: '', timestamp: ts, blockNumber: null,
    });

    mempool.add(mkTx('zz-tx', 1000));
    mempool.add(mkTx('aa-tx', 1000));
    mempool.add(mkTx('mm-tx', 999));

    const pending = mempool.getPending(10);
    assert.equal(pending[0].id, 'mm-tx');  // earlier timestamp
    assert.equal(pending[1].id, 'aa-tx');  // same ts, sorted by id
    assert.equal(pending[2].id, 'zz-tx');

    // Determinism check
    const pending2 = mempool.getPending(10);
    assert.deepEqual(pending.map((t) => t.id), pending2.map((t) => t.id));
  });

  // Test 6: Authority consensus
  it('enforces authority consensus for block production', () => {
    const authority = new AuthorityConsensus('auth-node', 'auth-node');
    assert.equal(authority.canProduceBlock(), true);
    assert.equal(authority.validateBlockProducer('auth-node'), true);
    assert.equal(authority.validateBlockProducer('rogue'), false);

    const follower = new AuthorityConsensus('auth-node', 'follower');
    assert.equal(follower.canProduceBlock(), false);
    assert.equal(follower.isAuthority(), false);
    assert.equal(follower.validateBlockProducer('auth-node'), true);
  });

  // Test 7: Genesis hash mismatch rejection
  it('rejects peers with mismatched genesis hash', async () => {
    const nodeA = new PeerManager(generateNodeIdentity(), 'node-a', 'genesis-ALPHA');
    const nodeB = new PeerManager(generateNodeIdentity(), 'node-b', 'genesis-BETA');

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      nodeA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    let peerConnected = false;
    nodeA.on('peer:connected', () => { peerConnected = true; });

    nodeB.connectToPeer('127.0.0.1', srv.port);
    await wait(300);

    assert.equal(peerConnected, false);
    assert.equal(nodeA.getPeerCount(), 0);

    nodeA.disconnectAll();
    nodeB.disconnectAll();
  });
});
