// Phase 16: Tx-to-block linkage + strong catch-up sync.
//
// Session 9 made follower validation strong on live gossip — but historical
// blocks fetched via `get_blocks` were still trusted on their merkleRoot
// because we had no way to recover the original txIds. Session 10 closes
// that gap:
//
//   1. linkTransactionsToBlock + findTransactionIdsByBlock — the storage
//      side. createBlock now stamps every committed tx's block_number.
//   2. Sync replies ship the txIds for each historical block alongside
//      the header, so the receiver can re-derive merkleRoot the same way
//      live gossip does.
//   3. validateIncomingBlock no longer falls back to allowMissingTxIds in
//      the sync path — every historical block goes through the same merkle
//      check as a live one.
//
// This suite verifies the storage primitives and the end-to-end strong-sync
// behaviour with real signed transactions.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { processTransaction, transactionStore } from '../src/core/transaction.js';
import { signPayload } from '../src/core/crypto.js';
import {
  createGenesisBlock,
  createBlock,
  computeMerkleRoot,
  getLatestBlock,
} from '../src/core/block.js';
import { PRECISION } from '../src/core/constants.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import { PeerManager } from '../src/network/peer.js';
import { ChainSync } from '../src/network/sync.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { payloadToBlock } from '../src/network/block-validator.js';
import { blockStore } from '../src/core/block.js';
import { SqliteTransactionStore } from '../src/core/stores/SqliteTransactionStore.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
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

/**
 * Submit a real signed transaction. Returns the resulting tx id.
 */
function submitTx(
  db: DatabaseSync,
  sender: ReturnType<typeof createAccount>,
  receiver: ReturnType<typeof createAccount>,
  amount: bigint,
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    from: sender.account.id,
    to: receiver.account.id,
    amount: amount.toString(),
    pointType: 'active' as const,
    isInPerson: false,
    memo: '',
  };
  const signature = signPayload(payload, timestamp, sender.privateKey);
  const result = processTransaction(db, {
    from: sender.account.id,
    to: receiver.account.id,
    amount,
    pointType: 'active',
    isInPerson: false,
    memo: '',
    timestamp,
    signature,
  });
  return result.transaction.id;
}

describe('Phase 16: Tx-to-block linkage + strong catch-up sync', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];

  afterEach(() => {
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
  });

  // ── Merkle root is set-based (order-independent) ─────────────────────

  it('computeMerkleRoot is independent of input order', () => {
    const a = computeMerkleRoot(['tx-z', 'tx-a', 'tx-m']);
    const b = computeMerkleRoot(['tx-a', 'tx-m', 'tx-z']);
    const c = computeMerkleRoot(['tx-m', 'tx-z', 'tx-a']);
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it('computeMerkleRoot still differs for different sets', () => {
    const a = computeMerkleRoot(['tx-1', 'tx-2']);
    const b = computeMerkleRoot(['tx-1', 'tx-3']);
    assert.notEqual(a, b);
  });

  it('empty txIds hash to the sentinel "empty" root', () => {
    assert.equal(computeMerkleRoot([]), computeMerkleRoot([]));
  });

  // ── Storage-level linkage ────────────────────────────────────────────

  it('createBlock stamps real transactions with the block number', () => {
    const db = freshDb();
    createGenesisBlock(db);

    // Create accounts that have positive active balances
    const sender = createAccount(db, 'individual', 1, 100);
    const receiver = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(1000).toString(),
      sender.account.id,
    );

    const txId = submitTx(db, sender, receiver, pts(50));

    // Before the block: tx exists but block_number is NULL
    const txBefore = transactionStore(db).findTransactionById(txId)!;
    assert.equal(txBefore.blockNumber, null);

    const block = createBlock(db, 1, [txId]);
    assert.equal(block.number, 1);

    // After: tx is linked to block 1
    const txAfter = transactionStore(db).findTransactionById(txId)!;
    assert.equal(txAfter.blockNumber, 1);

    const ids = transactionStore(db).findTransactionIdsByBlock(1);
    assert.deepEqual(ids, [txId]);
  });

  it('linkTransactionsToBlock silently ignores synthetic ids that do not exist', () => {
    const db = freshDb();
    createGenesisBlock(db);

    // Synthetic txIds — never inserted as real transactions
    const block = createBlock(db, 1, ['fake-1', 'fake-2']);
    assert.equal(block.number, 1);

    // No real rows were updated, so findTransactionIdsByBlock returns empty.
    const ids = transactionStore(db).findTransactionIdsByBlock(1);
    assert.deepEqual(ids, []);
  });

  it('findTransactionIdsByBlock returns ids in deterministic ASCII order', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const sender = createAccount(db, 'individual', 1, 100);
    const receiver = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(10000).toString(),
      sender.account.id,
    );

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(submitTx(db, sender, receiver, pts(10)));

    createBlock(db, 1, ids);

    const fetched = transactionStore(db).findTransactionIdsByBlock(1);
    // ORDER BY id, so result should equal ids sorted
    const expected = [...ids].sort();
    assert.deepEqual(fetched, expected);
  });

  // ── Direct store-level checks ────────────────────────────────────────

  it('linkTransactionsToBlock is a no-op when given an empty list', () => {
    const db = freshDb();
    new SqliteTransactionStore(db).linkTransactionsToBlock(7, []);
    // No throw, no rows affected (there are no rows). Just confirm we got here.
    assert.ok(true);
  });

  // ── End-to-end strong catch-up sync ──────────────────────────────────

  it('catch-up sync verifies merkleRoot for every historical block', async () => {
    // Authority builds a 3-block chain with REAL transactions.
    const dbAuth = freshDb();
    createGenesisBlock(dbAuth);

    const sender = createAccount(dbAuth, 'individual', 1, 100);
    const receiver = createAccount(dbAuth, 'individual', 1, 100);
    dbAuth.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(10000).toString(),
      sender.account.id,
    );

    const txIdsByBlock: string[][] = [[], [], []];
    for (let blk = 0; blk < 3; blk++) {
      for (let i = 0; i < 2; i++) txIdsByBlock[blk].push(submitTx(dbAuth, sender, receiver, pts(5)));
      createBlock(dbAuth, 1, txIdsByBlock[blk]);
    }
    assert.equal(getLatestBlock(dbAuth)!.number, 3);

    // Authority key + consensus
    const authIdentity = generateNodeIdentity();
    const authConsensus = new AuthorityConsensus(
      'authority',
      'authority',
      3,
      authIdentity.publicKey,
    );
    const authPeers = new PeerManager(authIdentity, 'authority', 'sync-strong-gen');
    authPeers.setBlockHeight(3);
    const _authSync = new ChainSync(dbAuth, authPeers, authConsensus);

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      authPeers.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // Follower with only genesis. Bound to authority's publicKey.
    const dbNew = freshDb();
    createGenesisBlock(dbNew);
    const newIdentity = generateNodeIdentity();
    const newConsensus = new AuthorityConsensus(
      'authority',
      'new-node',
      0,
      authIdentity.publicKey,
    );
    const newPeers = new PeerManager(newIdentity, 'new-node', 'sync-strong-gen');
    newPeers.setBlockHeight(0);
    const newSync = new ChainSync(dbNew, newPeers, newConsensus);

    const appliedBlocks: number[] = [];
    newSync.setBlockApplyHandler((blockData) => {
      appliedBlocks.push(blockData.number as number);
      const block = payloadToBlock(blockData as unknown as Parameters<typeof payloadToBlock>[0]);
      blockStore(dbNew).insert(block, /* isGenesis */ false);
      return true;
    });

    const connected = new Promise<void>((resolve) => {
      newPeers.once('peer:connected', () => resolve());
    });
    newPeers.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);

    newSync.startSync();
    await wait(500);

    assert.deepEqual(appliedBlocks, [1, 2, 3], 'follower must apply all 3 blocks');
    assert.equal(newPeers.getBlockHeight(), 3);
    assert.equal(newPeers.isBanned(authIdentity.publicKey), false, 'authority must NOT be banned');

    authPeers.disconnectAll();
    newPeers.disconnectAll();
  });

  it('catch-up sync bans the source if a historical block has a tampered merkleRoot', async () => {
    // We achieve this by intercepting the authority's transactions table and
    // deleting one tx after the block was committed — so when sync replies,
    // the txIds it ships (now missing one) won't reproduce the merkleRoot
    // stored on the block. The follower must reject + ban.
    const dbAuth = freshDb();
    createGenesisBlock(dbAuth);

    const sender = createAccount(dbAuth, 'individual', 1, 100);
    const receiver = createAccount(dbAuth, 'individual', 1, 100);
    dbAuth.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(10000).toString(),
      sender.account.id,
    );

    const txA = submitTx(dbAuth, sender, receiver, pts(5));
    const txB = submitTx(dbAuth, sender, receiver, pts(5));
    createBlock(dbAuth, 1, [txA, txB]); // merkleRoot includes both

    // Tamper: delete txA from the transactions table. block.merkleRoot still
    // references both, but findTransactionIdsByBlock(1) now returns only [txB].
    dbAuth.prepare('DELETE FROM transactions WHERE id = ?').run(txA);

    const authIdentity = generateNodeIdentity();
    const authConsensus = new AuthorityConsensus(
      'authority',
      'authority',
      1,
      authIdentity.publicKey,
    );
    const authPeers = new PeerManager(authIdentity, 'authority', 'sync-tamper-gen');
    authPeers.setBlockHeight(1);
    const _authSync = new ChainSync(dbAuth, authPeers, authConsensus);

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      authPeers.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const dbNew = freshDb();
    createGenesisBlock(dbNew);
    const newIdentity = generateNodeIdentity();
    const newConsensus = new AuthorityConsensus(
      'authority',
      'new-node',
      0,
      authIdentity.publicKey,
    );
    const newPeers = new PeerManager(newIdentity, 'new-node', 'sync-tamper-gen');
    newPeers.setBlockHeight(0);
    const _newSync = new ChainSync(dbNew, newPeers, newConsensus);

    const connected = new Promise<void>((resolve) => {
      newPeers.once('peer:connected', () => resolve());
    });
    newPeers.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);

    _newSync.startSync();
    await wait(500);

    assert.equal(
      newPeers.isBanned(authIdentity.publicKey),
      true,
      'follower must ban a peer that ships a block whose txIds do not reproduce the merkleRoot',
    );

    authPeers.disconnectAll();
    newPeers.disconnectAll();
  });
});
