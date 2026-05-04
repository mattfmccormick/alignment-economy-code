// Phase 31: BFT block production with a real signed transaction.
//
// Builds on Phase 30's multi-node consensus by adding actual block content:
//
//   - Pre-create the same sender + receiver accounts in all 4 nodes' DBs
//     (same id, same publicKey, same starting balance).
//   - Pre-compute who the round-0 proposer will be (deterministic given
//     validator set + height + seed).
//   - Submit ONE real signed transaction to that proposer's DB only.
//   - Run BftBlockProducer on every node.
//   - When the proposer fires blockProviderFor, they pull the tx from
//     their unblocked queue, build the block, broadcast content +
//     proposal. Followers stash the block; on commit, replayTransaction
//     applies the same state effect to their DBs.
//   - Assert: every node's sender + receiver balances match the
//     proposer's. Block 1 hash matches. Tx is linked to block 1.
//
// This is the "real BFT chain produces real blocks with real state
// transitions" test. State convergence across independent nodes is the
// proof that the chain is real.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import {
  createGenesisBlock,
  getLatestBlock,
  getBlock,
} from '../src/core/block.js';
import {
  generateKeyPair,
  signPayload,
  deriveAccountId,
} from '../src/core/crypto.js';
import {
  processTransaction,
  transactionStore,
} from '../src/core/transaction.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import { BftBlockProducer } from '../src/core/consensus/BftBlockProducer.js';
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

interface ValidatorSpec {
  accountId: string;
  identity: NodeIdentity;
  vrfPublicKey: string;
}

function buildValidatorSpecs(n: number): ValidatorSpec[] {
  const out: ValidatorSpec[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      accountId: `validator-${i}`,
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    });
  }
  return out;
}

/**
 * Set up one node's DB. Registers all validators + creates sender +
 * receiver accounts (with the supplied keypairs so id is deterministic).
 */
function setupNodeDb(
  specs: ValidatorSpec[],
  sender: { publicKey: string; privateKey: string },
  receiver: { publicKey: string },
): { db: DatabaseSync; set: SqliteValidatorSet; senderId: string; receiverId: string } {
  const db = freshDb();

  // Register all validators (re-use Phase 30's pattern: create account,
  // override its id with the deterministic spec.accountId).
  for (const spec of specs) {
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(
      spec.accountId,
      acct.account.id,
    );
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      spec.accountId,
    );
    registerValidator(db, {
      accountId: spec.accountId,
      nodePublicKey: spec.identity.publicKey,
      vrfPublicKey: spec.vrfPublicKey,
      stake: pts(200),
    });
  }

  // Create sender + receiver with provided pubkeys → same id on every node.
  const senderResult = createAccount(db, 'individual', 1, 100, sender.publicKey);
  const receiverResult = createAccount(db, 'individual', 1, 100, receiver.publicKey);
  const senderId = senderResult.account.id;
  const receiverId = receiverResult.account.id;

  // Fund sender so they can send a transaction (active balance for
  // 'active' point type, which is what processTransaction will debit).
  db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
    pts(1000).toString(),
    senderId,
  );

  return { db, set: new SqliteValidatorSet(db), senderId, receiverId };
}

describe('Phase 31: BFT block production with a real transaction', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];
  let producers: BftBlockProducer[] = [];
  let peerManagersToTearDown: PeerManager[] = [];
  let dbsToClose: DatabaseSync[] = [];

  afterEach(() => {
    for (const p of producers) {
      try { p.stop(); } catch {}
    }
    producers = [];
    for (const pm of peerManagersToTearDown) {
      try { pm.disconnectAll(); } catch {}
    }
    peerManagersToTearDown = [];
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

  it('four BFT nodes commit a block containing a real signed transaction', async () => {
    // ── Setup ──────────────────────────────────────────────────────────
    const specs = buildValidatorSpecs(4);

    // Sender + receiver: deterministic keypairs shared across all 4 DBs
    const senderKeys = generateKeyPair();
    const receiverKeys = generateKeyPair();
    const senderId = deriveAccountId(senderKeys.publicKey);
    const receiverId = deriveAccountId(receiverKeys.publicKey);

    // Build per-node DBs, all carrying the same accounts
    const peerManagers: PeerManager[] = [];
    const sets: SqliteValidatorSet[] = [];
    const dbs: DatabaseSync[] = [];
    const servers: Array<{ server: Server; wss: WebSocketServer; port: number }> = [];

    for (let i = 0; i < specs.length; i++) {
      const setup = setupNodeDb(specs, senderKeys, receiverKeys);
      assert.equal(setup.senderId, senderId);
      assert.equal(setup.receiverId, receiverId);
      dbs.push(setup.db);
      dbsToClose.push(setup.db);
      sets.push(setup.set);

      const pm = new PeerManager(specs[i].identity, specs[i].accountId, 'phase31-genesis');
      peerManagers.push(pm);
      peerManagersToTearDown.push(pm);

      const srv = await createWsServer();
      cleanup.push(srv);
      servers.push(srv);
      srv.wss.on('connection', (ws, req) => {
        pm.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
      });
    }

    // Full mesh
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        peerManagers[i].connectToPeer('127.0.0.1', servers[j].port);
      }
    }
    await wait(300);
    for (const pm of peerManagers) {
      assert.equal(pm.getPeerCount(), 3, 'mesh should have 3 peers per node');
    }

    // Pre-compute round-0 proposer. seed for height 1 = genesis hash.
    const genesisHashOnEachDb = getLatestBlock(dbs[0])!.hash;
    const proposerInfo = selectProposer(sets[0].listActive(), 1, genesisHashOnEachDb, 0)!;
    const proposerIndex = specs.findIndex((s) => s.accountId === proposerInfo.accountId);
    assert.ok(proposerIndex >= 0, 'proposer must be one of our specs');

    // Submit a real signed tx to the PROPOSER's DB only.
    const txAmount = pts(100);
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
    const proposerDb = dbs[proposerIndex];
    const result = processTransaction(proposerDb, {
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

    // Sanity: proposer's DB shows the tx pending; followers don't have it yet
    assert.equal(transactionStore(proposerDb).findUnblockedTransactions().length, 1);
    for (let i = 0; i < dbs.length; i++) {
      if (i === proposerIndex) continue;
      assert.equal(transactionStore(dbs[i]).findUnblockedTransactions().length, 0);
      assert.equal(transactionStore(dbs[i]).findTransactionById(txId), null);
    }

    // ── Build BftBlockProducers ────────────────────────────────────────
    type Node = {
      spec: ValidatorSpec;
      db: DatabaseSync;
      producer: BftBlockProducer;
      committedHash: string | null;
    };
    const nodes: Node[] = [];

    for (let i = 0; i < specs.length; i++) {
      const node: Node = {
        spec: specs[i],
        db: dbs[i],
        producer: null as unknown as BftBlockProducer,
        committedHash: null,
      };
      node.producer = new BftBlockProducer({
        db: dbs[i],
        peerManager: peerManagers[i],
        validatorSet: sets[i],
        localValidator: {
          accountId: specs[i].accountId,
          publicKey: specs[i].identity.publicKey,
          secretKey: specs[i].identity.secretKey,
        },
        day: 1,
        timeouts: { propose: 1500, prevote: 800, precommit: 800 },
        onBlockCommitted: (block) => {
          if (node.committedHash === null) node.committedHash = block.hash;
        },
      });
      nodes.push(node);
    }
    producers = nodes.map((n) => n.producer);

    // ── Run consensus ──────────────────────────────────────────────────
    for (const n of nodes) n.producer.start();

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (nodes.every((n) => n.committedHash !== null)) break;
      await wait(50);
    }

    for (const n of nodes) {
      assert.ok(n.committedHash, `node ${n.spec.accountId} did not commit`);
    }

    // Stop consensus before asserting — otherwise the chain keeps
    // advancing in the background (height 2 with empty blocks, etc.)
    // and our state assertions race the next round.
    for (const n of nodes) n.producer.stop();

    // ── Assertions: state convergence across all 4 nodes ───────────────

    // Same block hash on every node
    const refHash = nodes[0].committedHash!;
    for (let i = 1; i < nodes.length; i++) {
      assert.equal(nodes[i].committedHash!, refHash);
    }

    // Block 1 (specifically — chain may have advanced) is in every node's
    // DB and matches the committed hash.
    for (const n of nodes) {
      const block1 = getBlock(n.db, 1)!;
      assert.ok(block1, `node ${n.spec.accountId} missing block 1`);
      assert.equal(block1.number, 1);
      assert.equal(block1.hash, refHash);
      assert.equal(block1.transactionCount, 1);
      // Sanity: block 1 is at minimum the latest, possibly more.
      assert.ok(getLatestBlock(n.db)!.number >= 1);
    }

    // Tx is in every node's transactions table, linked to block 1
    for (const n of nodes) {
      const tx = transactionStore(n.db).findTransactionById(txId);
      assert.ok(tx, `node ${n.spec.accountId} missing tx ${txId}`);
      assert.equal(tx!.blockNumber, 1);
    }

    // Sender + receiver balances converge byte for byte
    const refSender = getAccount(nodes[0].db, senderId)!;
    const refReceiver = getAccount(nodes[0].db, receiverId)!;
    for (let i = 1; i < nodes.length; i++) {
      const sender = getAccount(nodes[i].db, senderId)!;
      const receiver = getAccount(nodes[i].db, receiverId)!;
      assert.equal(
        sender.activeBalance,
        refSender.activeBalance,
        `node ${nodes[i].spec.accountId} sender activeBalance diverged`,
      );
      assert.equal(
        receiver.earnedBalance,
        refReceiver.earnedBalance,
        `node ${nodes[i].spec.accountId} receiver earnedBalance diverged`,
      );
    }

    // Sanity check: sender's balance dropped by amount, receiver's grew by netAmount
    const senderInitial = pts(1000);
    assert.equal(refSender.activeBalance, senderInitial - txAmount);
    // netAmount = amount - fee (fee is amount * TRANSACTION_FEE_RATE / FEE_DENOMINATOR)
    assert.ok(refReceiver.earnedBalance > 0n);
    assert.ok(refReceiver.earnedBalance < txAmount);

    // Stash should be drained on every node after commit
    for (const n of nodes) {
      assert.equal(n.producer.stashSize(), 0);
    }
  });
});
