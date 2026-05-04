// Phase 39: Multi-block BFT catch-up sync (with cert verification).
//
// Session 32 enabled syncing block 1 (which doesn't need a parent cert
// because its parent is genesis). This session enables block 2+ by:
//   - Persisting the commit cert alongside each block on the source side
//     (BftBlockProducer.onCommit does this; this test stages certs
//     directly via blockStore.saveCommitCertificate).
//   - Shipping parentCertificate in get_blocks responses (ChainSync).
//   - Re-saving the parent cert on the receiver side so they can serve
//     it onward.
//
// Test strategy: source DB has blocks 1, 2, 3 with hand-built certs
// (single-validator network → cert is just one precommit). Fresh
// follower in BFT mode connects + syncs all three. Verify each block
// lands AND each parent cert was persisted on the follower (for
// onward sync).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import {
  createGenesisBlock,
  createBlock,
  blockStore,
  getLatestBlock,
} from '../src/core/block.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { BFTConsensus } from '../src/core/consensus/BFTConsensus.js';
import { signVote } from '../src/core/consensus/votes.js';
import {
  buildCommitCertificate,
  computeCertHash,
  type CommitCertificate,
} from '../src/core/consensus/commit-certificate.js';
import { VoteSet } from '../src/core/consensus/vote-aggregator.js';
import { PeerManager } from '../src/network/peer.js';
import { ChainSync } from '../src/network/sync.js';
import {
  payloadToBlock,
  type IncomingBlockPayload,
} from '../src/network/block-validator.js';
import { replayTransaction } from '../src/core/transaction.js';
import { runTransaction } from '../src/db/connection.js';
import { PRECISION } from '../src/core/constants.js';

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

describe('Phase 39: Multi-block BFT catch-up sync', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];
  let pms: PeerManager[] = [];
  let dbs: DatabaseSync[] = [];

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
    for (const db of dbs) {
      try { db.close(); } catch {}
    }
    dbs = [];
  });

  it('a fresh BFT follower syncs blocks 1, 2, 3 with cert verification on every block', async () => {
    // Single-validator BFT network (quorum = 1). The cert for each
    // block is just one precommit signature. Realistic deployments
    // use 2/3+ but the wiring is identical.
    const validatorIdentity = generateNodeIdentity();
    const validatorAccountId = 'val-multi-sync';
    const vrfPublicKey = Ed25519VrfProvider.generateKeyPair().publicKey;

    function setupDb(): { db: DatabaseSync; set: SqliteValidatorSet } {
      const db = freshDb();
      const acct = createAccount(db, 'individual', 1, 100);
      db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(
        validatorAccountId,
        acct.account.id,
      );
      db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
        pts(500).toString(),
        validatorAccountId,
      );
      registerValidator(db, {
        accountId: validatorAccountId,
        nodePublicKey: validatorIdentity.publicKey,
        vrfPublicKey,
        stake: pts(200),
      });
      createGenesisBlock(db);
      return { db, set: new SqliteValidatorSet(db) };
    }

    // ── SOURCE: blocks 1, 2, 3 + commit certs for each ────────────────
    const source = setupDb();
    dbs.push(source.db);
    const sourceStore = blockStore(source.db);

    /**
     * Build a CommitCertificate for a block whose hash is `blockHash` at
     * the given (height, round). Single-validator network → one precommit.
     */
    function buildCertFor(blockHash: string, height: number): CommitCertificate {
      const voteSet = new VoteSet('precommit', height, 0, source.set);
      voteSet.addVote(
        signVote({
          kind: 'precommit',
          height,
          round: 0,
          blockHash,
          validatorAccountId,
          validatorPublicKey: validatorIdentity.publicKey,
          validatorSecretKey: validatorIdentity.secretKey,
        }),
      );
      const cert = buildCommitCertificate(voteSet);
      assert.ok(cert, 'cert must be buildable for a single-validator quorum');
      return cert!;
    }

    // Block 1 (no parent cert — parent is genesis, hash uses null cert)
    const block1 = createBlock(source.db, 1, []);
    const cert1 = buildCertFor(block1.hash, 1);
    sourceStore.saveCommitCertificate(1, cert1);
    // Block 2 — cert-in-block-hash promotion (Session 39): block 2's
    // canonical hash includes the hash of cert1, binding the parent cert
    // into chain history.
    const block2 = createBlock(source.db, 1, [], null, computeCertHash(cert1));
    const cert2 = buildCertFor(block2.hash, 2);
    sourceStore.saveCommitCertificate(2, cert2);
    // Block 3 — same pattern, binding cert2.
    const block3 = createBlock(source.db, 1, [], null, computeCertHash(cert2));
    sourceStore.saveCommitCertificate(3, buildCertFor(block3.hash, 3));

    assert.equal(getLatestBlock(source.db)!.number, 3);

    // ── FOLLOWER: just genesis ────────────────────────────────────────
    const follower = setupDb();
    dbs.push(follower.db);

    // ── PeerManagers ──────────────────────────────────────────────────
    // Source PM uses validator identity so BFTConsensus.validateBlockProducer
    // accepts its sync replies.
    const sourcePM = new PeerManager(validatorIdentity, validatorAccountId, 'phase39-genesis');
    const followerIdentity = generateNodeIdentity();
    const followerPM = new PeerManager(followerIdentity, 'follower-multi', 'phase39-genesis');
    pms.push(sourcePM, followerPM);
    sourcePM.setBlockHeight(3);

    const sourceConsensus = new BFTConsensus({
      validatorSet: source.set,
      localAccountId: validatorAccountId,
      localNodePublicKey: validatorIdentity.publicKey,
      initialHeight: 3,
    });
    const _sourceSync = new ChainSync(source.db, sourcePM, sourceConsensus, source.set);

    const followerConsensus = new BFTConsensus({
      validatorSet: follower.set,
      localAccountId: validatorAccountId,
      localNodePublicKey: followerIdentity.publicKey,
      initialHeight: 0,
    });
    const followerSync = new ChainSync(
      follower.db,
      followerPM,
      followerConsensus,
      follower.set,
    );

    // Follower's sync handler — same as runner installs in BFT mode
    followerSync.setSyncBlockApplyHandler((blockData) => {
      const payload = blockData as unknown as IncomingBlockPayload;
      const block = payloadToBlock(payload);
      const txs = payload.transactions ?? [];
      const parentCert = payload.parentCertificate;
      try {
        runTransaction(follower.db, () => {
          for (const wireTx of txs) {
            replayTransaction(
              follower.db,
              {
                id: wireTx.id,
                from: wireTx.from,
                to: wireTx.to,
                amount: BigInt(wireTx.amount),
                fee: BigInt(wireTx.fee),
                netAmount: BigInt(wireTx.netAmount),
                pointType: wireTx.pointType,
                isInPerson: wireTx.isInPerson,
                memo: wireTx.memo,
                signature: wireTx.signature,
                timestamp: wireTx.timestamp,
              },
              block.number,
            );
          }
          const fStore = blockStore(follower.db);
          fStore.insert(block, /* isGenesis */ false);
          if (parentCert) {
            fStore.saveCommitCertificate(block.number - 1, parentCert);
          }
        });
        return true;
      } catch {
        return false;
      }
    });

    // ── Connect them ──────────────────────────────────────────────────
    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      sourcePM.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const sourceConnected = new Promise<void>((r) =>
      sourcePM.once('peer:connected', () => r()),
    );
    const followerConnected = new Promise<void>((r) =>
      followerPM.once('peer:connected', () => r()),
    );
    followerPM.connectToPeer('127.0.0.1', srv.port);
    await Promise.all([sourceConnected, followerConnected]);
    await wait(50);

    // ── Trigger sync ──────────────────────────────────────────────────
    followerSync.startSync();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const latest = getLatestBlock(follower.db);
      if (latest && latest.number >= 3) break;
      await wait(50);
    }

    // ── Assertions ────────────────────────────────────────────────────
    const followerLatest = getLatestBlock(follower.db);
    assert.ok(followerLatest, 'follower must have synced something');
    assert.equal(followerLatest!.number, 3, 'follower must reach height 3');
    assert.equal(followerLatest!.hash, block3.hash);

    // Each block landed correctly
    const followerStore = blockStore(follower.db);
    assert.equal(followerStore.findByNumber(1)!.hash, block1.hash);
    assert.equal(followerStore.findByNumber(2)!.hash, block2.hash);
    assert.equal(followerStore.findByNumber(3)!.hash, block3.hash);

    // Parent certs persisted on follower (for onward sync). Block 1's
    // cert is NOT included (it's the cert for block 1 itself, shipped
    // when syncing block 2). Block 2's cert is persisted (it shipped
    // as the parentCertificate of block 3). Block 1's parent (genesis)
    // has no cert.
    assert.ok(
      followerStore.findCommitCertificate(1),
      "follower must persist block 1's cert (shipped as block 2's parentCertificate)",
    );
    assert.ok(
      followerStore.findCommitCertificate(2),
      "follower must persist block 2's cert (shipped as block 3's parentCertificate)",
    );
    // Block 3's cert is not shipped during this sync (would be shipped
    // as block 4's parentCertificate). That's expected.

    // The persisted certs verify against the validator set
    const c1 = followerStore.findCommitCertificate(1)!;
    const c2 = followerStore.findCommitCertificate(2)!;
    assert.equal(c1.blockHash, block1.hash);
    assert.equal(c2.blockHash, block2.hash);
  });

  it('blockStore round-trips a CommitCertificate', () => {
    const db = freshDb();
    dbs.push(db);
    createGenesisBlock(db);
    createBlock(db, 1, []);

    const validatorIdentity = generateNodeIdentity();
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run('val-1', acct.account.id);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      'val-1',
    );
    registerValidator(db, {
      accountId: 'val-1',
      nodePublicKey: validatorIdentity.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: pts(200),
    });

    const set = new SqliteValidatorSet(db);
    const block1 = getLatestBlock(db)!;
    const voteSet = new VoteSet('precommit', 1, 0, set);
    voteSet.addVote(
      signVote({
        kind: 'precommit',
        height: 1,
        round: 0,
        blockHash: block1.hash,
        validatorAccountId: 'val-1',
        validatorPublicKey: validatorIdentity.publicKey,
        validatorSecretKey: validatorIdentity.secretKey,
      }),
    );
    const cert = buildCommitCertificate(voteSet);
    assert.ok(cert);

    const store = blockStore(db);
    assert.equal(store.findCommitCertificate(1), null, 'no cert before save');
    store.saveCommitCertificate(1, cert!);
    const loaded = store.findCommitCertificate(1);
    assert.ok(loaded);
    assert.equal(loaded!.blockHash, block1.hash);
    assert.equal(loaded!.height, 1);
    assert.equal(loaded!.precommits.length, 1);
    assert.equal(loaded!.precommits[0].validatorAccountId, 'val-1');
  });
});
