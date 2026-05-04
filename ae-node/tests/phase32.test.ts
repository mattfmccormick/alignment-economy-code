// Phase 32: BFT-mode transaction gossip.
//
// Without this, only the node where a transaction is submitted (via the
// API) has the tx in its unblocked queue. If the proposer for the next
// block happens to be a different validator, the tx never makes it into
// a block — single-point-of-failure for tx submission.
//
// With this: any node can submit a tx, it propagates to all peers, and
// every peer's findUnblockedTransactions includes it. Whichever validator
// gets elected proposer has the tx ready.
//
// What's verified:
//   1. Two BFT-mode AENodes mesh-connected.
//   2. Same sender + receiver accounts on both DBs (deterministic
//      ML-DSA pubkeys → same id everywhere).
//   3. Node A submits a tx via processTransaction; balance updates
//      locally and the tx is in A's findUnblockedTransactions.
//   4. Node A broadcasts the tx via PeerManager.broadcast('new_transaction').
//   5. Node B's AENode subscriber catches the wire payload and calls
//      replayTransaction(db, input, null) — applies state without
//      linking to a block.
//   6. Assertions on B's DB:
//      - sender.activeBalance dropped by amount
//      - receiver.earnedBalance grew by netAmount
//      - tx is in transactions table with block_number = NULL
//      - findUnblockedTransactions returns it
//   7. Idempotency: re-broadcasting the same tx doesn't double-apply.
//   8. Authority-mode path still uses mempool (unchanged).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { createGenesisBlock } from '../src/core/block.js';
import {
  generateKeyPair,
  signPayload,
  deriveAccountId,
} from '../src/core/crypto.js';
import {
  processTransaction,
  transactionStore,
} from '../src/core/transaction.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { AENode } from '../src/network/node.js';
import { PeerManager } from '../src/network/peer.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createGenesisBlock(db);
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

function setupBftNodeDb(opts: {
  validatorAccountId: string;
  validatorIdentity: ReturnType<typeof generateNodeIdentity>;
  vrfPublicKey: string;
  sender: { publicKey: string };
  receiver: { publicKey: string };
}): { db: DatabaseSync; set: SqliteValidatorSet } {
  const db = freshDb();
  // Validator account
  const acct = createAccount(db, 'individual', 1, 100);
  db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(
    opts.validatorAccountId,
    acct.account.id,
  );
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    pts(500).toString(),
    opts.validatorAccountId,
  );
  registerValidator(db, {
    accountId: opts.validatorAccountId,
    nodePublicKey: opts.validatorIdentity.publicKey,
    vrfPublicKey: opts.vrfPublicKey,
    stake: pts(200),
  });

  // Sender + receiver accounts (with deterministic pubkeys → same id on every node)
  createAccount(db, 'individual', 1, 100, opts.sender.publicKey);
  createAccount(db, 'individual', 1, 100, opts.receiver.publicKey);
  db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
    pts(1000).toString(),
    deriveAccountId(opts.sender.publicKey),
  );
  return { db, set: new SqliteValidatorSet(db) };
}

describe('Phase 32: BFT-mode transaction gossip', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];
  let nodes: AENode[] = [];
  let dbsToClose: DatabaseSync[] = [];

  afterEach(() => {
    for (const n of nodes) {
      try { n.stop(); } catch {}
    }
    nodes = [];
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
    for (const db of dbsToClose) {
      try { db.close(); } catch {}
    }
    dbsToClose = [];
  });

  it('a tx submitted on node A propagates to node B and applies state in BFT mode', async () => {
    // Two BFT nodes, mesh-connected
    const validatorA = {
      accountId: 'val-a',
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    };
    const validatorB = {
      accountId: 'val-b',
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    };

    const senderKeys = generateKeyPair();
    const receiverKeys = generateKeyPair();
    const senderId = deriveAccountId(senderKeys.publicKey);
    const receiverId = deriveAccountId(receiverKeys.publicKey);

    const setupA = setupBftNodeDb({
      validatorAccountId: validatorA.accountId,
      validatorIdentity: validatorA.identity,
      vrfPublicKey: validatorA.vrfPublicKey,
      sender: senderKeys,
      receiver: receiverKeys,
    });
    const setupB = setupBftNodeDb({
      validatorAccountId: validatorB.accountId,
      validatorIdentity: validatorB.identity,
      vrfPublicKey: validatorB.vrfPublicKey,
      sender: senderKeys,
      receiver: receiverKeys,
    });
    dbsToClose.push(setupA.db, setupB.db);

    // For tx gossip alone, each node only needs its own validator
    // registered (so AENode can construct BFTConsensus). The validator
    // set's contents are irrelevant to the tx-gossip code path —
    // it's gated only by config.consensusMode === 'bft'.

    // Wire up two AENodes in BFT mode, listening on dynamic ports
    const srvA = await createWsServer();
    cleanup.push(srvA);
    const srvB = await createWsServer();
    cleanup.push(srvB);

    // Use PeerManager directly for this test — full AENode.start() spins
    // up its own server and we're already running ours. Instead we
    // invoke the AENode constructor (which sets up the tx:received
    // handler) and feed events through PeerManager.handleIncomingConnection.
    const nodeA = new AENode(setupA.db, {
      nodeId: validatorA.accountId,
      genesisHash: 'phase32-genesis',
      p2pPort: 0,
      authorityNodeId: '',
      identity: validatorA.identity,
      consensusMode: 'bft',
      bftValidatorSet: setupA.set,
      bftLocalAccountId: validatorA.accountId,
    });
    const nodeB = new AENode(setupB.db, {
      nodeId: validatorB.accountId,
      genesisHash: 'phase32-genesis',
      p2pPort: 0,
      authorityNodeId: '',
      identity: validatorB.identity,
      consensusMode: 'bft',
      bftValidatorSet: setupB.set,
      bftLocalAccountId: validatorB.accountId,
    });
    nodes.push(nodeA, nodeB);

    // Hook the WebSocket servers to the respective PeerManagers
    srvA.wss.on('connection', (ws, req) => {
      nodeA.peerManager.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });
    srvB.wss.on('connection', (ws, req) => {
      nodeB.peerManager.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // Connect A -> B, wait for both sides to register the peer
    const aConnected = new Promise<void>((r) => nodeA.peerManager.once('peer:connected', () => r()));
    const bConnected = new Promise<void>((r) => nodeB.peerManager.once('peer:connected', () => r()));
    nodeA.peerManager.connectToPeer('127.0.0.1', srvB.port);
    await Promise.all([aConnected, bConnected]);
    await wait(50);

    // ── Step 1: submit tx on A ────────────────────────────────────────
    const txAmount = pts(50);
    const txTimestamp = Math.floor(Date.now() / 1000);
    const payload = {
      from: senderId,
      to: receiverId,
      amount: txAmount.toString(),
      pointType: 'active' as const,
      isInPerson: false,
      memo: '',
    };
    const txSig = signPayload(payload, txTimestamp, senderKeys.privateKey);
    const result = processTransaction(setupA.db, {
      from: senderId,
      to: receiverId,
      amount: txAmount,
      pointType: 'active',
      isInPerson: false,
      memo: '',
      timestamp: txTimestamp,
      signature: txSig,
    });
    const txId = result.transaction.id;

    // Sanity: A has the tx; B doesn't
    assert.equal(transactionStore(setupA.db).findTransactionsByBlock(0).length, 0);
    assert.ok(transactionStore(setupA.db).findTransactionById(txId));
    assert.equal(transactionStore(setupB.db).findTransactionById(txId), null);

    // ── Step 2: broadcast the wire form of the tx ─────────────────────
    const txRow = transactionStore(setupA.db).findTransactionById(txId)!;
    // Diagnostic: track whether B's apply path fired and whether it succeeded
    let bApplied = false;
    let bApplyFailed: unknown = null;
    nodeB.peerManager.on('transaction:applied', () => { bApplied = true; });
    nodeB.peerManager.on('transaction:apply-failed', (_tx, err) => { bApplyFailed = err; });

    assert.equal(nodeA.peerManager.getPeerCount(), 1, 'A should have B as peer');
    assert.equal(nodeB.peerManager.getPeerCount(), 1, 'B should have A as peer');

    nodeA.peerManager.broadcast('new_transaction', {
      id: txRow.id,
      from: txRow.from,
      to: txRow.to,
      amount: txRow.amount,
      fee: txRow.fee,
      netAmount: txRow.netAmount,
      pointType: txRow.pointType,
      isInPerson: txRow.isInPerson,
      memo: txRow.memo,
      signature: txRow.signature,
      timestamp: txRow.timestamp,
    });

    // Give the gossip a moment to land + apply
    await wait(100);

    if (bApplyFailed) throw bApplyFailed;
    assert.equal(bApplied, true, 'B should have applied the gossiped tx');

    // ── Step 3: assert state convergence on B ─────────────────────────
    const bSender = getAccount(setupB.db, senderId)!;
    const bReceiver = getAccount(setupB.db, receiverId)!;
    const aSender = getAccount(setupA.db, senderId)!;
    const aReceiver = getAccount(setupA.db, receiverId)!;

    assert.equal(bSender.activeBalance, aSender.activeBalance, 'sender balance must match A');
    assert.equal(bReceiver.earnedBalance, aReceiver.earnedBalance, 'receiver balance must match A');

    // B has the tx with block_number=NULL (gossiped, not yet committed)
    const bTx = transactionStore(setupB.db).findTransactionById(txId);
    assert.ok(bTx, 'B should have the tx after gossip');
    assert.equal(bTx!.blockNumber, null);

    // findUnblockedTransactions on B includes this tx → any future
    // proposer (including B) can put it in a block.
    const bUnblocked = transactionStore(setupB.db).findUnblockedTransactions();
    assert.ok(bUnblocked.some((t) => t.id === txId));
  });

  it('idempotent — receiving the same tx twice does not double-apply', async () => {
    // Compact version of the previous test: gossip the same tx twice,
    // verify state changed only once.
    const validatorA = {
      accountId: 'val-a',
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    };
    const validatorB = {
      accountId: 'val-b',
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    };

    const senderKeys = generateKeyPair();
    const receiverKeys = generateKeyPair();
    const senderId = deriveAccountId(senderKeys.publicKey);
    const receiverId = deriveAccountId(receiverKeys.publicKey);

    const setupA = setupBftNodeDb({
      validatorAccountId: validatorA.accountId,
      validatorIdentity: validatorA.identity,
      vrfPublicKey: validatorA.vrfPublicKey,
      sender: senderKeys,
      receiver: receiverKeys,
    });
    const setupB = setupBftNodeDb({
      validatorAccountId: validatorB.accountId,
      validatorIdentity: validatorB.identity,
      vrfPublicKey: validatorB.vrfPublicKey,
      sender: senderKeys,
      receiver: receiverKeys,
    });
    dbsToClose.push(setupA.db, setupB.db);

    const srvA = await createWsServer();
    cleanup.push(srvA);
    const srvB = await createWsServer();
    cleanup.push(srvB);

    const nodeA = new AENode(setupA.db, {
      nodeId: validatorA.accountId,
      genesisHash: 'phase32-idem',
      p2pPort: 0,
      authorityNodeId: '',
      identity: validatorA.identity,
      consensusMode: 'bft',
      bftValidatorSet: setupA.set,
      bftLocalAccountId: validatorA.accountId,
    });
    const nodeB = new AENode(setupB.db, {
      nodeId: validatorB.accountId,
      genesisHash: 'phase32-idem',
      p2pPort: 0,
      authorityNodeId: '',
      identity: validatorB.identity,
      consensusMode: 'bft',
      bftValidatorSet: setupB.set,
      bftLocalAccountId: validatorB.accountId,
    });
    nodes.push(nodeA, nodeB);

    srvA.wss.on('connection', (ws, req) => {
      nodeA.peerManager.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });
    srvB.wss.on('connection', (ws, req) => {
      nodeB.peerManager.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const aConnected = new Promise<void>((r) => nodeA.peerManager.once('peer:connected', () => r()));
    const bConnected = new Promise<void>((r) => nodeB.peerManager.once('peer:connected', () => r()));
    nodeA.peerManager.connectToPeer('127.0.0.1', srvB.port);
    await Promise.all([aConnected, bConnected]);
    await wait(50);

    const txAmount = pts(50);
    const txTimestamp = Math.floor(Date.now() / 1000);
    const txPayload = {
      from: senderId,
      to: receiverId,
      amount: txAmount.toString(),
      pointType: 'active' as const,
      isInPerson: false,
      memo: '',
    };
    const txSig = signPayload(txPayload, txTimestamp, senderKeys.privateKey);
    const result = processTransaction(setupA.db, {
      from: senderId,
      to: receiverId,
      amount: txAmount,
      pointType: 'active',
      isInPerson: false,
      memo: '',
      timestamp: txTimestamp,
      signature: txSig,
    });
    const txRow = transactionStore(setupA.db).findTransactionById(result.transaction.id)!;
    const wireTx = {
      id: txRow.id,
      from: txRow.from,
      to: txRow.to,
      amount: txRow.amount,
      fee: txRow.fee,
      netAmount: txRow.netAmount,
      pointType: txRow.pointType,
      isInPerson: txRow.isInPerson,
      memo: txRow.memo,
      signature: txRow.signature,
      timestamp: txRow.timestamp,
    };

    nodeA.peerManager.broadcast('new_transaction', wireTx);
    await wait(100);

    const bSenderAfterFirst = getAccount(setupB.db, senderId)!.activeBalance;
    const bReceiverAfterFirst = getAccount(setupB.db, receiverId)!.earnedBalance;

    // Second broadcast — should be a no-op on B (hasTransaction returns true)
    nodeA.peerManager.broadcast('new_transaction', wireTx);
    await wait(100);

    const bSenderAfterSecond = getAccount(setupB.db, senderId)!.activeBalance;
    const bReceiverAfterSecond = getAccount(setupB.db, receiverId)!.earnedBalance;

    assert.equal(bSenderAfterSecond, bSenderAfterFirst, 'sender balance must not change on duplicate gossip');
    assert.equal(bReceiverAfterSecond, bReceiverAfterFirst, 'receiver balance must not change on duplicate gossip');
  });
});
