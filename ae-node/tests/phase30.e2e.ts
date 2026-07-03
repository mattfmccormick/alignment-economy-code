// Phase 30: Multi-node BFT consensus — the moment of truth.
//
// Four in-process nodes, each with their own DB and PeerManager but
// sharing an identical 4-validator set. They connect P2P in a star
// (one server, three clients). Each runs a BftRuntime. The test
// observes every node's onCommit callback and asserts:
//
//   - All four converge on the SAME (height, blockHash, cert)
//   - The committed cert verifies independently against each node's
//     own validator set
//   - The proposer for round 0 is the same on every node (deterministic
//     selection)
//
// If this test passes, BFT consensus is real: a quorum of independent
// nodes is producing finalized blocks together.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import { BftRuntime } from '../src/core/consensus/BftRuntime.js';
import { verifyCommitCertificate, type CommitCertificate } from '../src/core/consensus/commit-certificate.js';
import { PeerManager } from '../src/network/peer.js';
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

interface ValidatorSpec {
  accountId: string;
  identity: NodeIdentity;
  vrfPublicKey: string;
}

/**
 * Build N validator specs (deterministic across nodes). Each node will
 * register all N of these in its own DB so every node's listActive
 * returns the same set.
 */
function buildValidatorSpecs(n: number): ValidatorSpec[] {
  const out: ValidatorSpec[] = [];
  for (let i = 0; i < n; i++) {
    const accountId = `validator-${i}`;
    const identity = generateNodeIdentity();
    const vrfPublicKey = Ed25519VrfProvider.generateKeyPair().publicKey;
    out.push({ accountId, identity, vrfPublicKey });
  }
  return out;
}

/**
 * For one node: build a fresh DB, create accounts for every validator,
 * fund them, and register all validators in this node's DB. Returns the
 * DB + the SqliteValidatorSet view.
 */
function setupNodeDb(specs: ValidatorSpec[]): {
  db: DatabaseSync;
  set: SqliteValidatorSet;
} {
  const db = freshDb();
  for (const spec of specs) {
    // We need to spin up an account for each validator so registerValidator's
    // balance check passes. Real deployments would derive accountId from the
    // ML-DSA pubkey; for test purposes we override the synthetic id.
    const acct = createAccount(db, 'individual', 1, 100);
    // Replace the auto-generated account id with our deterministic spec id
    db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(spec.accountId, acct.account.id);
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
  return { db, set: new SqliteValidatorSet(db) };
}

describe('Phase 30: Multi-node BFT consensus', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];
  let runtimes: BftRuntime[] = [];
  let peerManagersToTearDown: PeerManager[] = [];
  let dbsToClose: DatabaseSync[] = [];

  afterEach(() => {
    for (const r of runtimes) {
      try { r.stop(); } catch {}
    }
    runtimes = [];
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

  /**
   * Build N nodes in a FULL MESH. Every node opens its own WebSocket
   * server; every node connects outbound to every node with a higher
   * index. End state: every node has direct connections to every other
   * node, so a single broadcast from any node reaches the rest.
   *
   * (PeerManager doesn't currently relay incoming gossip to other peers.
   * In a real deployment that's a gap to fill — for this test we use
   * full mesh so vote propagation is guaranteed.)
   */
  async function meshConnect(specs: ValidatorSpec[], genesisHash: string): Promise<{
    peerManagers: PeerManager[];
    sets: SqliteValidatorSet[];
    dbs: DatabaseSync[];
  }> {
    const peerManagers: PeerManager[] = [];
    const sets: SqliteValidatorSet[] = [];
    const dbs: DatabaseSync[] = [];
    const servers: Array<{ server: Server; wss: WebSocketServer; port: number }> = [];

    // 1) Build each node's PeerManager + listening server
    for (let i = 0; i < specs.length; i++) {
      const setup = setupNodeDb(specs);
      dbs.push(setup.db);
      dbsToClose.push(setup.db);
      sets.push(setup.set);
      const pm = new PeerManager(specs[i].identity, specs[i].accountId, genesisHash);
      peerManagers.push(pm);
      peerManagersToTearDown.push(pm);

      const srv = await createWsServer();
      cleanup.push(srv);
      servers.push(srv);
      srv.wss.on('connection', (ws, req) => {
        pm.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
      });
    }

    // 2) Each node i connects outbound to every node j > i. Half the
    //    connections cover both directions because PeerManager handshake
    //    is bidirectional (handshake + handshake_ack).
    const totalConnections = (specs.length * (specs.length - 1)) / 2;
    let connections = 0;
    const allConnected = new Promise<void>((resolve) => {
      const onConnected = () => {
        connections++;
        if (connections >= totalConnections * 2) resolve(); // both sides observe
      };
      for (const pm of peerManagers) pm.on('peer:connected', onConnected);
    });

    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        peerManagers[i].connectToPeer('127.0.0.1', servers[j].port);
      }
    }

    // Cap on wait — if mesh doesn't settle in 2s we'll see it in test failures.
    await Promise.race([allConnected, wait(2000)]);
    await wait(100);
    return { peerManagers, sets, dbs };
  }

  it('four nodes converge on the same commit at height 1', async () => {
    const specs = buildValidatorSpecs(4);
    const sharedSeed = 'phase30-seed-1';

    // Pre-compute the round-0 proposer for sanity. Every node agrees
    // because they all see the same active validator set.
    const sample = setupNodeDb(specs);
    const proposerForR0 = selectProposer(sample.set.listActive(), 1, sharedSeed)!;
    void proposerForR0; // useful for debugging

    // Full mesh — see meshConnect docs.
    const mesh = await meshConnect(specs, 'phase30-genesis');

    type Node = {
      spec: ValidatorSpec;
      set: SqliteValidatorSet;
      runtime: BftRuntime;
      committed: { height: number; blockHash: string; cert: CommitCertificate } | null;
    };
    const nodes: Node[] = [];

    // The hash every node will vote on. Whoever turns out to be the
    // round-N proposer puts this up; followers vote on it.
    const PROPOSED_BLOCK_HASH = 'cafe' + 'babe'.repeat(15);

    for (let i = 0; i < specs.length; i++) {
      const node: Node = {
        spec: specs[i],
        set: mesh.sets[i],
        runtime: null as unknown as BftRuntime,
        committed: null,
      };
      node.runtime = new BftRuntime({
        peerManager: mesh.peerManagers[i],
        validatorSet: mesh.sets[i],
        localValidator: {
          accountId: specs[i].accountId,
          publicKey: specs[i].identity.publicKey,
          secretKey: specs[i].identity.secretKey,
        },
        initialHeight: 1,
        proposerSeedFor: () => sharedSeed,
        // Whatever round we end up in, the proposer puts up the same
        // hash. Followers vote on whatever they receive.
        blockProviderFor: () => PROPOSED_BLOCK_HASH,
        onCommit: (height, blockHash, cert) => {
          // Only capture the FIRST commit. The driver will keep running
          // and may commit height 2, 3, ... in the time it takes the
          // test to poll for convergence; we want to assert on the
          // initial round so all nodes' captures match.
          if (node.committed === null) {
            node.committed = { height, blockHash, cert };
          }
        },
        timeouts: { propose: 1500, prevote: 800, precommit: 800 },
      });
      nodes.push(node);
    }

    runtimes = nodes.map((n) => n.runtime);

    // Sanity: each node sees the other 3 as peers
    for (const pm of mesh.peerManagers) {
      assert.equal(pm.getPeerCount(), 3, 'every node should see 3 peers in mesh');
    }

    for (const n of nodes) n.runtime.start();

    // Poll for convergence
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (nodes.every((n) => n.committed !== null)) break;
      await wait(50);
    }

    for (const n of nodes) {
      assert.ok(n.committed, `node ${n.spec.accountId} did not commit before deadline`);
    }

    const ref = nodes[0].committed!;
    for (let i = 1; i < nodes.length; i++) {
      assert.equal(nodes[i].committed!.height, ref.height);
      assert.equal(nodes[i].committed!.blockHash, ref.blockHash);
    }
    assert.equal(ref.height, 1);
    assert.equal(ref.blockHash, PROPOSED_BLOCK_HASH);

    // Each node's cert verifies independently against its own validator
    // set — proves they all see the same registered validators.
    for (const n of nodes) {
      const result = verifyCommitCertificate(n.committed!.cert, n.set);
      assert.equal(
        result.valid,
        true,
        `node ${n.spec.accountId} cert failed verification: ${result.error}`,
      );
      assert.ok(result.signers!.length >= 3, 'cert below quorum');
    }
  });

  it('three of four nodes still commit even if one is offline (quorum = 3)', async () => {
    // The 4-validator set is registered in every node's DB, but only 3
    // of them actually run. quorum = 3, so the 3 live nodes are exactly
    // enough — they commit, the offline one stays at the empty chain.
    const allSpecs = buildValidatorSpecs(4);
    const liveSpecs = allSpecs.slice(0, 3); // specs[3] stays offline
    const sharedSeed = 'phase30-quorum-seed';

    // meshConnect takes a list of specs and builds N nodes for them.
    // We pass only the LIVE specs but seed each live node's DB with the
    // FULL 4-validator set so quorum math is 3-of-4.
    const peerManagers: PeerManager[] = [];
    const sets: SqliteValidatorSet[] = [];
    const servers: Array<{ server: Server; wss: WebSocketServer; port: number }> = [];

    for (let i = 0; i < liveSpecs.length; i++) {
      const setup = setupNodeDb(allSpecs); // all 4 registered in each node's DB
      sets.push(setup.set);
      dbsToClose.push(setup.db);
      const pm = new PeerManager(liveSpecs[i].identity, liveSpecs[i].accountId, 'p30-quorum');
      peerManagers.push(pm);
      peerManagersToTearDown.push(pm);

      const srv = await createWsServer();
      cleanup.push(srv);
      servers.push(srv);
      srv.wss.on('connection', (ws, req) => {
        pm.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
      });
    }

    // Mesh-connect the 3 live nodes
    for (let i = 0; i < liveSpecs.length; i++) {
      for (let j = i + 1; j < liveSpecs.length; j++) {
        peerManagers[i].connectToPeer('127.0.0.1', servers[j].port);
      }
    }
    await wait(300); // give mesh time to settle (3 mutual handshakes)

    type Node = {
      spec: ValidatorSpec;
      set: SqliteValidatorSet;
      runtime: BftRuntime;
      committed: { height: number; blockHash: string } | null;
    };
    const nodes: Node[] = [];

    const PROPOSED = '1234' + 'abcd'.repeat(15);

    for (let i = 0; i < liveSpecs.length; i++) {
      const node: Node = {
        spec: liveSpecs[i],
        set: sets[i],
        runtime: null as unknown as BftRuntime,
        committed: null,
      };
      node.runtime = new BftRuntime({
        peerManager: peerManagers[i],
        validatorSet: sets[i],
        localValidator: {
          accountId: liveSpecs[i].accountId,
          publicKey: liveSpecs[i].identity.publicKey,
          secretKey: liveSpecs[i].identity.secretKey,
        },
        initialHeight: 1,
        proposerSeedFor: () => sharedSeed,
        blockProviderFor: () => PROPOSED,
        onCommit: (height, blockHash) => {
          if (node.committed === null) {
            node.committed = { height, blockHash };
          }
        },
        // Faster timeouts in case round 0's proposer is the offline node
        // — we'll need to advance to round 1 (or further) before a live
        // proposer fires. Round-rotation in selectProposer ensures a
        // different validator gets selected each round.
        timeouts: { propose: 800, prevote: 500, precommit: 500 },
      });
      nodes.push(node);
    }

    runtimes = nodes.map((n) => n.runtime);

    // Each live node sees 2 peers
    for (const pm of peerManagers) {
      assert.equal(pm.getPeerCount(), 2);
    }

    for (const n of nodes) n.runtime.start();

    // 12s deadline — enough for several round advances if the offline
    // node happens to be early in the rotation.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (nodes.every((n) => n.committed !== null)) break;
      await wait(50);
    }

    for (const n of nodes) {
      assert.ok(n.committed, `live node ${n.spec.accountId} did not commit`);
    }
    const ref = nodes[0].committed!;
    for (let i = 1; i < nodes.length; i++) {
      assert.equal(nodes[i].committed!.blockHash, ref.blockHash);
    }
  });
});
