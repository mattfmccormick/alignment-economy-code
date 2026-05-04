// Phase 35: Multi-runner end-to-end BFT.
//
// Two AENodeRunner instances, each fully started (DB, API server, P2P
// server, BFT consensus loop). They mesh-connect via P2P. A user submits
// a real signed transaction to runner A's HTTP API. The full pipeline:
//
//   API on A → processTransaction commits locally on A's DB
//            → txBroadcaster fires → peerManager.broadcast new_transaction
//            → B's PeerManager receives → AENode tx-gossip handler
//            → replayTransaction(B.db, input, null) → tx pending on B too
//            → BFT round runs (proposer broadcasts, both validators vote)
//            → onCommit fires on both runners → block persisted on both DBs
//
// After commit:
//   - Both DBs have block 1 with the same hash
//   - Both DBs have the tx linked to block 1
//   - Sender + receiver balances converge byte-for-byte
//
// This is the "deploy a BFT validator" demo. If this test passes, you
// can run two AENodeRunners on different machines, point them at each
// other via seedNodes, hit one with curl, and watch them produce a
// real block together.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'http';
import { DatabaseSync } from 'node:sqlite';

import { AENodeRunner } from '../src/node/runner.js';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { generateKeyPair, signPayload, deriveAccountId } from '../src/core/crypto.js';
import { transactionStore } from '../src/core/transaction.js';
import { getBlock, getLatestBlock } from '../src/core/block.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import { PRECISION } from '../src/core/constants.js';
import type { AENodeConfig } from '../src/node/config.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ValidatorSpec {
  accountId: string;
  identity: NodeIdentity;
  vrfPublicKey: string;
}

/**
 * Pre-seed a fresh DB on disk with both validators registered + sender
 * and receiver accounts (deterministic ML-DSA pubkeys → same id on
 * every node). Closes the DB so the runner can open it fresh.
 */
function setupRunnerDb(opts: {
  validators: ValidatorSpec[];
  sender: { publicKey: string };
  receiver: { publicKey: string };
}): { dir: string; dbPath: string; nodeKeyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ae-runner-multi-'));
  const dbPath = join(dir, 'node.db');
  const nodeKeyPath = join(dir, 'node-key.json');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);

  // Register every validator. Each gets a real account row (createAccount
  // generates ML-DSA keys we then override with the synthetic accountId).
  for (const v of opts.validators) {
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(v.accountId, acct.account.id);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      v.accountId,
    );
    registerValidator(db, {
      accountId: v.accountId,
      nodePublicKey: v.identity.publicKey,
      vrfPublicKey: v.vrfPublicKey,
      stake: pts(200),
    });
  }

  // Sender + receiver with provided ML-DSA pubkeys → same id on every node
  createAccount(db, 'individual', 1, 100, opts.sender.publicKey);
  createAccount(db, 'individual', 1, 100, opts.receiver.publicKey);
  db.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
    pts(1000).toString(),
    deriveAccountId(opts.sender.publicKey),
  );

  db.close();
  return { dir, dbPath, nodeKeyPath };
}

function baseConfig(
  dbPath: string,
  nodeKeyPath: string,
  nodeId: string,
): AENodeConfig {
  return {
    // In BFT mode the gossip-layer nodeId MUST equal bftLocalAccountId,
    // because validateBlockProducer looks the validator up by the
    // senderId on the wire envelope. If they differ, every gossiped
    // block fails validation and the sender gets banned (Phase 35
    // initial run discovered this the hard way).
    nodeId,
    authorityNodeId: '',
    apiPort: 0, // ephemeral
    p2pPort: 0, // ephemeral
    apiHost: '127.0.0.1',
    p2pHost: '127.0.0.1',
    dbPath,
    nodeKeyPath,
    seedNodes: [],
    maxPeers: 5,
    dayCycleIntervalMs: 86_400_000,
    blockIntervalMs: 10_000,
    logLevel: 'error',
  };
}

/** Send a JSON HTTP POST and parse the JSON response. */
function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

describe('Phase 35: Multi-runner end-to-end BFT', () => {
  const tempDirs: string[] = [];
  let runners: AENodeRunner[] = [];

  afterEach(async () => {
    // Stop runners FIRST so they release their DB handles + sockets,
    // then nuke the temp dirs.
    for (const r of runners) {
      try { r.stop(); } catch {}
    }
    runners = [];
    // Give event loop a tick to actually close sockets
    await wait(50);
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tempDirs.length = 0;
  });

  it('two runners commit a block from an API-submitted transaction', async () => {
    resetRateLimits();

    // ── Validator setup (deterministic across both DBs) ──────────────
    const valA: ValidatorSpec = {
      accountId: 'val-a',
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    };
    const valB: ValidatorSpec = {
      accountId: 'val-b',
      identity: generateNodeIdentity(),
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    };
    const validators = [valA, valB];

    const senderKeys = generateKeyPair();
    const receiverKeys = generateKeyPair();
    const senderId = deriveAccountId(senderKeys.publicKey);
    const receiverId = deriveAccountId(receiverKeys.publicKey);

    // Build per-runner DBs + node-key files. The node-key.json is what
    // loadOrCreateNodeIdentity reads — we MUST pre-seed it with the
    // identity matching the registered validator, otherwise BFTConsensus
    // will refuse to act as proposer (registered nodePublicKey != local).
    const setupA = setupRunnerDb({ validators, sender: senderKeys, receiver: receiverKeys });
    const setupB = setupRunnerDb({ validators, sender: senderKeys, receiver: receiverKeys });
    tempDirs.push(setupA.dir, setupB.dir);
    writeFileSync(setupA.nodeKeyPath, JSON.stringify(valA.identity), { mode: 0o600 });
    writeFileSync(setupB.nodeKeyPath, JSON.stringify(valB.identity), { mode: 0o600 });

    // ── Start runner A first; capture its P2P port ───────────────────
    const runnerA = new AENodeRunner({
      ...baseConfig(setupA.dbPath, setupA.nodeKeyPath, valA.accountId),
      consensusMode: 'bft',
      bftLocalAccountId: valA.accountId,
    });
    runners.push(runnerA);
    runnerA.start();
    await runnerA.waitForReady();
    const aP2PPort = runnerA.getP2PPort();
    const aApiPort = runnerA.getApiPort();
    assert.ok(aP2PPort > 0, `A P2P port must be > 0, got ${aP2PPort}`);
    assert.ok(aApiPort > 0, `A API port must be > 0, got ${aApiPort}`);

    // ── Start runner B with seedNodes pointing at A ──────────────────
    const runnerB = new AENodeRunner({
      ...baseConfig(setupB.dbPath, setupB.nodeKeyPath, valB.accountId),
      consensusMode: 'bft',
      bftLocalAccountId: valB.accountId,
      seedNodes: [{ host: '127.0.0.1', port: aP2PPort }],
    });
    runners.push(runnerB);
    runnerB.start();
    await runnerB.waitForReady();
    const bApiPort = runnerB.getApiPort();
    void bApiPort;

    // Discovery + handshake takes a moment. PeerDiscovery in AENode
    // auto-connects to seedNodes; handshake completes asynchronously.
    // Poll until A has 1 peer (B) connected.
    const meshDeadline = Date.now() + 5_000;
    while (
      Date.now() < meshDeadline &&
      runnerA.getP2PNode().peerManager.getPeerCount() < 1
    ) {
      await wait(50);
    }
    assert.equal(
      runnerA.getP2PNode().peerManager.getPeerCount(),
      1,
      'A must see B as peer',
    );
    assert.equal(
      runnerB.getP2PNode().peerManager.getPeerCount(),
      1,
      'B must see A as peer',
    );

    // ── Submit a real signed tx to runner A's API ────────────────────
    const txAmount = pts(100);
    const txTimestamp = Math.floor(Date.now() / 1000);
    const internalPayload = {
      from: senderId,
      to: receiverId,
      amount: txAmount.toString(),
      pointType: 'active' as const,
      isInPerson: false,
      memo: '',
    };
    const signature = signPayload(internalPayload, txTimestamp, senderKeys.privateKey);
    const apiBody = {
      accountId: senderId,
      timestamp: txTimestamp,
      signature,
      payload: {
        to: receiverId,
        amount: 100, // display units (the API converts)
        pointType: 'active',
        isInPerson: false,
        memo: '',
      },
    };
    const submitResp = await postJson(aApiPort, '/api/v1/transactions', apiBody);
    assert.equal(
      submitResp.status,
      200,
      `tx submit failed: ${JSON.stringify(submitResp.data)}`,
    );
    assert.equal(submitResp.data.success, true);
    const submittedTxId = submitResp.data.data.transaction.id;
    assert.ok(submittedTxId);

    // ── Wait for both runners to commit a block containing the tx ────
    //
    // BFT round timing: propose 3s, prevote 1s, precommit 1s.
    // Worst case: round 0 NIL-times-out (~5s), round 1 commits (~5s).
    // Give 30s budget for safety.
    // 60s budget. Each BFT round is ~5s (3s propose + 1s prevote + 1s
    // precommit), and rounds 0/1 typically NIL-timeout because peer
    // connection settles in parallel with BFT startup. Under heavy
    // parallel test execution, this can stretch further. Real
    // production deployments would dial these timeouts in differently.
    const commitDeadline = Date.now() + 60_000;
    function bothCommitted(): boolean {
      const aLatest = getLatestBlock(runnerA.getDb());
      const bLatest = getLatestBlock(runnerB.getDb());
      if (!aLatest || !bLatest) return false;
      return aLatest.number >= 1 && bLatest.number >= 1;
    }
    while (Date.now() < commitDeadline && !bothCommitted()) {
      await wait(100);
    }
    assert.ok(bothCommitted(), 'both runners must commit at least block 1 within deadline');

    // Stop the BFT loops so the chain doesn't keep advancing while we
    // assert state. Otherwise polling getLatestBlock races subsequent rounds.
    for (const r of runners) {
      r.getBftBlockProducer()?.stop();
    }
    await wait(50);

    // ── Assert state convergence ──────────────────────────────────────

    const aBlock1 = getBlock(runnerA.getDb(), 1)!;
    const bBlock1 = getBlock(runnerB.getDb(), 1)!;
    assert.ok(aBlock1, 'A must have block 1');
    assert.ok(bBlock1, 'B must have block 1');
    assert.equal(aBlock1.hash, bBlock1.hash, 'block-1 hash must match');
    assert.equal(aBlock1.transactionCount, 1, 'block 1 must contain the submitted tx');
    assert.equal(bBlock1.transactionCount, 1);

    // Tx is in both DBs, linked to block 1
    const aTx = transactionStore(runnerA.getDb()).findTransactionById(submittedTxId);
    const bTx = transactionStore(runnerB.getDb()).findTransactionById(submittedTxId);
    assert.ok(aTx, 'A must have the tx');
    assert.ok(bTx, 'B must have the tx');
    assert.equal(aTx!.blockNumber, 1);
    assert.equal(bTx!.blockNumber, 1);

    // Sender + receiver balances converge byte-for-byte
    const aSender = getAccount(runnerA.getDb(), senderId)!;
    const aReceiver = getAccount(runnerA.getDb(), receiverId)!;
    const bSender = getAccount(runnerB.getDb(), senderId)!;
    const bReceiver = getAccount(runnerB.getDb(), receiverId)!;
    assert.equal(aSender.activeBalance, bSender.activeBalance);
    assert.equal(aReceiver.earnedBalance, bReceiver.earnedBalance);

    // Sanity: sender's active dropped by the tx amount; receiver got netAmount
    assert.equal(aSender.activeBalance, pts(1000) - txAmount);
    assert.ok(aReceiver.earnedBalance > 0n);
    assert.ok(aReceiver.earnedBalance < txAmount);
  });
});
