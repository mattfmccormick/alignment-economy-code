// Phase 15: Independent block validation by followers.
//
// A follower must NOT trust whatever bytes the network hands them. This
// suite exercises the validateIncomingBlock function directly and via the
// full P2P path, verifying every rejection branch:
//
//   1. Producer authentication
//      - rejects unknown senderId
//      - rejects mismatched publicKey when authorityPublicKey is bound
//      - accepts the legacy nodeId-only path when authorityPublicKey is unset
//   2. Height contiguity
//      - rejects gaps (skipped blocks)
//      - rejects re-submissions of an existing height
//   3. PrevHash chain
//      - rejects blocks whose previousHash doesn't link to local head
//   4. Hash integrity
//      - rejects tampered timestamp / day / merkleRoot in the block payload
//   5. Merkle integrity
//      - rejects blocks whose claimed txIds don't reproduce the merkleRoot
//      - rejects transactionCount inconsistency
//   6. Live gossip path
//      - bans a peer that ships an invalid block

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import {
  createGenesisBlock,
  createBlock,
  computeBlockHash,
  computeMerkleRoot,
  getLatestBlock,
} from '../src/core/block.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import { PeerManager } from '../src/network/peer.js';
import { ChainSync } from '../src/network/sync.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import {
  validateIncomingBlock,
  type IncomingBlockPayload,
} from '../src/network/block-validator.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

/**
 * Build a block payload chained onto the DB's current latest, WITHOUT
 * persisting it. Lets a test simulate "the authority just produced a block
 * and gossiped it; what does our local validator say?" without polluting
 * the DB so the validator's height check stays correct.
 *
 * Also generates a synthetic `transactions` array matching the txIds so the
 * payload satisfies validateIncomingBlock's wire-completeness check.
 * Tests that want to exercise the missing-transactions branch can `delete`
 * payload.transactions after building.
 */
function buildPayload(
  db: DatabaseSync,
  opts: { number?: number; day?: number; txIds?: string[]; timestamp?: number } = {},
): IncomingBlockPayload {
  const prev = getLatestBlock(db);
  const number = opts.number ?? (prev ? prev.number + 1 : 1);
  const day = opts.day ?? 1;
  const txIds = opts.txIds ?? [];
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const previousHash = prev ? prev.hash : '0'.repeat(64);
  const merkleRoot = computeMerkleRoot(txIds);
  const hash = computeBlockHash(number, previousHash, timestamp, merkleRoot, day);
  const transactions = txIds.map((id) => ({
    id,
    from: 'a',
    to: 'b',
    amount: '0',
    fee: '0',
    netAmount: '0',
    pointType: 'earned' as const,
    isInPerson: false,
    memo: '',
    signature: '',
    timestamp,
  }));
  return {
    number,
    day,
    timestamp,
    previousHash,
    hash,
    merkleRoot,
    transactionCount: txIds.length,
    rebaseEvent: null,
    txIds,
    transactions,
  };
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

describe('Phase 15: Independent block validation', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];

  afterEach(() => {
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
  });

  // ── Producer authentication ──────────────────────────────────────────

  it('rejects a block from a sender that is not the authority', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const authorityKey = generateNodeIdentity();
    const consensus = new AuthorityConsensus(
      'authority',
      'follower',
      0,
      authorityKey.publicKey,
    );

    const payload = buildPayload(db);

    // ROGUE sender claiming to be the authority — different publicKey
    const rogueKey = generateNodeIdentity();
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      'authority',
      rogueKey.publicKey,
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /not an accepted block producer/);
  });

  it('rejects a block from an unknown nodeId even if publicKey looks plausible', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');

    const payload = buildPayload(db);

    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      'rogue-node',
      generateNodeIdentity().publicKey,
    );
    assert.equal(result.valid, false);
  });

  it('accepts a block from the authority when authorityPublicKey is bound and matches', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const authorityKey = generateNodeIdentity();
    const consensus = new AuthorityConsensus(
      'authority',
      'follower',
      0,
      authorityKey.publicKey,
    );

    const payload = buildPayload(db);

    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      'authority',
      authorityKey.publicKey,
    );
    assert.equal(result.valid, true, result.error);
  });

  it('falls back to nodeId-only check when authorityPublicKey is unset (legacy)', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');

    const payload = buildPayload(db);

    // Any publicKey works because consensus has no expected key bound
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      'authority',
      generateNodeIdentity().publicKey,
    );
    assert.equal(result.valid, true);
  });

  // ── Height contiguity ────────────────────────────────────────────────

  it('rejects a block with a height gap', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    // Build a payload claiming to be block 5 when local head is genesis (0)
    const payload = buildPayload(db, { number: 5 });

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Height gap/);
  });

  it('rejects a block whose number duplicates an existing height', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    // Persist block 1, then try to validate another block claiming to be 1
    createBlock(db, 1, ['tx-1']);
    // Now local head is block 1, so payload number=1 is a duplicate (gap)
    const payload = buildPayload(db, { number: 1, txIds: ['tx-1'] });
    // Override previousHash to point at genesis (which #1 should chain to)
    const genesis = getLatestBlock(db); // block 1 is now latest
    void genesis;

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Height gap/);
  });

  // ── PrevHash chain ───────────────────────────────────────────────────

  it('rejects a block whose previousHash does not link to local head', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db);
    // Tamper previousHash to fork; rebuild hash so the hash check would still pass
    payload.previousHash = 'f'.repeat(64);
    payload.hash = computeBlockHash(payload.number, payload.previousHash, payload.timestamp, payload.merkleRoot, payload.day);

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Previous hash mismatch/);
  });

  // ── Hash integrity ───────────────────────────────────────────────────

  it('rejects a block whose hash field is wrong for the claimed contents', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db);
    payload.hash = '0'.repeat(64); // tamper

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Block hash mismatch/);
  });

  it('rejects a block whose timestamp was tampered (changes hash)', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db);
    payload.timestamp = payload.timestamp + 1; // hash field still says the OLD value

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Block hash mismatch/);
  });

  // ── Merkle integrity ─────────────────────────────────────────────────

  it('rejects a block whose txIds do not reproduce the merkleRoot', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db, { txIds: ['tx-1', 'tx-2'] });
    // Swap txIds — same length, different content; merkleRoot field unchanged
    payload.txIds = ['tx-EVIL', 'tx-9'];

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Merkle root mismatch/);
  });

  it('rejects a block whose transactionCount disagrees with txIds.length', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db, { txIds: ['tx-1', 'tx-2'] });
    payload.transactionCount = 99; // claimed in block, doesn't match txIds.length

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Transaction count mismatch/);
  });

  it('rejects a block missing txIds when allowMissingTxIds is false', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db);
    delete (payload as Partial<IncomingBlockPayload>).txIds;

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /missing txIds/);
  });

  it('accepts a block missing txIds when allowMissingTxIds is true (sync path)', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const payload = buildPayload(db);
    delete (payload as Partial<IncomingBlockPayload>).txIds;

    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      'authority',
      authKey.publicKey,
      { allowMissingTxIds: true },
    );
    assert.equal(result.valid, true);
  });

  // ── Sanity: a HAPPY PATH block validates end-to-end ──────────────────

  it('accepts a well-formed block with all checks enabled', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const authKey = generateNodeIdentity();
    const consensus = new AuthorityConsensus('authority', 'follower', 0, authKey.publicKey);

    const txIds = ['tx-a', 'tx-b', 'tx-c'];
    const payload = buildPayload(db, { txIds });
    // Sanity check our test setup
    assert.equal(computeMerkleRoot(txIds), payload.merkleRoot);

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, true, result.error);
  });

  // ── Live gossip path: bad block bans the peer ────────────────────────

  it('bans a peer that gossips a block with an unauthorized producer', async () => {
    // Setup: A is a follower whose consensus is bound to a known authority
    // publicKey. B connects pretending to be the authority but signs with
    // their own (different) key. validateIncomingBlock rejects on producer
    // authentication; A must ban B.
    const dbA = freshDb();
    createGenesisBlock(dbA);

    const idA = generateNodeIdentity();
    const idB = generateNodeIdentity();
    const realAuthKey = generateNodeIdentity(); // the REAL authority's key
    const sharedGenesis = 'genesis-test-15';

    const consensusA = new AuthorityConsensus(
      'authority',
      'follower-a',
      0,
      realAuthKey.publicKey,
    );

    const peersA = new PeerManager(idA, 'follower-a', sharedGenesis);
    // ChainSync wires the listeners that perform validateIncomingBlock + ban
    const _syncA = new ChainSync(dbA, peersA, consensusA);

    const peersB = new PeerManager(idB, 'authority', sharedGenesis);

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      peersA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const connected = new Promise<void>((resolve) => {
      peersA.once('peer:connected', () => resolve());
    });
    peersB.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);

    assert.equal(peersA.getPeerCount(), 1);
    assert.equal(peersA.isBanned(idB.publicKey), false);

    // B builds a structurally-valid block that points at A's real genesis
    // (so prev-hash check would pass). The producer-auth check is what fails.
    const aGenesis = getLatestBlock(dbA)!;
    const txIds = ['tx-x'];
    const merkleRoot = computeMerkleRoot(txIds);
    const ts = Math.floor(Date.now() / 1000);
    const fakeBlock = {
      number: 1,
      day: 1,
      timestamp: ts,
      previousHash: aGenesis.hash,
      merkleRoot,
      hash: computeBlockHash(1, aGenesis.hash, ts, merkleRoot, 1),
      transactionCount: 1,
      rebaseEvent: null,
      txIds,
    };

    peersB.broadcast('new_block', fakeBlock);
    await wait(200);

    assert.equal(peersA.isBanned(idB.publicKey), true, 'A must ban B for unauthorized block');
    assert.equal(peersA.getPeerCount(), 0, 'banned peer must be disconnected');

    peersA.disconnectAll();
    peersB.disconnectAll();
  });

  it('bans a peer that gossips a block with a tampered merkleRoot', async () => {
    // Even when B holds the legit authority key, if the txIds they ship
    // don't reproduce the merkleRoot, A rejects + bans.
    const dbA = freshDb();
    createGenesisBlock(dbA);

    const idA = generateNodeIdentity();
    const idAuthority = generateNodeIdentity();
    const sharedGenesis = 'genesis-test-15-merkle';

    // A trusts idAuthority as the authority key
    const consensusA = new AuthorityConsensus(
      'authority',
      'follower-a',
      0,
      idAuthority.publicKey,
    );

    const peersA = new PeerManager(idA, 'follower-a', sharedGenesis);
    const _syncA = new ChainSync(dbA, peersA, consensusA);

    // B IS the authority by key — but ships a tampered block
    const peersB = new PeerManager(idAuthority, 'authority', sharedGenesis);

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      peersA.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    const connected = new Promise<void>((resolve) => {
      peersA.once('peer:connected', () => resolve());
    });
    peersB.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);

    // Build a block whose txIds DON'T match its merkleRoot
    const aGenesis = getLatestBlock(dbA)!;
    const realTxIds = ['tx-real-1', 'tx-real-2'];
    const merkleRoot = computeMerkleRoot(realTxIds);
    const ts = Math.floor(Date.now() / 1000);
    const tamperedBlock = {
      number: 1,
      day: 1,
      timestamp: ts,
      previousHash: aGenesis.hash,
      merkleRoot,
      hash: computeBlockHash(1, aGenesis.hash, ts, merkleRoot, 1),
      transactionCount: 2,
      rebaseEvent: null,
      txIds: ['tx-FAKE-1', 'tx-FAKE-2'], // doesn't reproduce merkleRoot
    };

    peersB.broadcast('new_block', tamperedBlock);
    await wait(200);

    assert.equal(peersA.isBanned(idAuthority.publicKey), true);

    peersA.disconnectAll();
    peersB.disconnectAll();
  });
});
