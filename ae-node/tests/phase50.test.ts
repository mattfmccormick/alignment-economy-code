// Phase 50: Block timestamp bounds.
//
// Session 40 promoted the day cycle to a deterministic chain event
// keyed off block.timestamp. Without an upper bound on how far that
// timestamp can drift from the validator's local clock, a malicious
// or clock-broken proposer could stamp a block with timestamp = year
// 2099 and force the cycle loop to advance every honest validator's
// state by thousands of days in a single onCommit. The 1000-iteration
// safety bound (also Session 40) caps damage but doesn't prevent it.
//
// This session adds the bound at the validation layer:
//   - validateBlockTimestamp(blockTs, nowSec, maxDriftSec) — pure
//     window check used by both code paths below.
//   - validateIncomingBlock enforces the bound by default; sync path
//     passes skipBlockTimestampWindow=true because historical blocks
//     legitimately have old timestamps.
//   - BftBlockProducer's block:received handler validates timestamp
//     before stashing. Apply-time defense: even if BFT consensus
//     somehow finalizes a cert over a bad block, the local validator
//     never enters that bad state.
//
// Limitation (documented in code, follow-up session): RoundController
// votes on hashes without inspecting block content, so a Byzantine
// proposer + Byzantine majority could still get a cert. The proper
// fix is to gate prevote on content validation. For now this is
// apply-time defense only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import {
  createGenesisBlock,
  createBlock,
  computeBlockHash,
  computeMerkleRoot,
  getLatestBlock,
} from '../src/core/block.js';
import {
  validateBlockTimestamp,
  validateIncomingBlock,
  DEFAULT_MAX_TIMESTAMP_DRIFT_SEC,
  type IncomingBlockPayload,
} from '../src/network/block-validator.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { BFTConsensus } from '../src/core/consensus/BFTConsensus.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import { PeerManager } from '../src/network/peer.js';
import { BftBlockProducer } from '../src/core/consensus/BftBlockProducer.js';
import { signVote } from '../src/core/consensus/votes.js';
import {
  buildCommitCertificate,
  computeCertHash,
} from '../src/core/consensus/commit-certificate.js';
import { VoteSet } from '../src/core/consensus/vote-aggregator.js';
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

describe('Phase 50: Block timestamp bounds', () => {
  // ── Pure validateBlockTimestamp ─────────────────────────────────────

  it('accepts a block exactly at "now"', () => {
    const r = validateBlockTimestamp(1000, 1000, 300);
    assert.equal(r.valid, true);
  });

  it('accepts a block exactly at the future edge of the window', () => {
    assert.equal(validateBlockTimestamp(1300, 1000, 300).valid, true);
  });

  it('accepts a block exactly at the past edge of the window', () => {
    assert.equal(validateBlockTimestamp(700, 1000, 300).valid, true);
  });

  it('rejects a block one second past the future edge', () => {
    const r = validateBlockTimestamp(1301, 1000, 300);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /301s in the future/);
  });

  it('rejects a block one second past the past edge', () => {
    const r = validateBlockTimestamp(699, 1000, 300);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /301s in the past/);
  });

  it('rejects NaN / non-finite block timestamps', () => {
    assert.equal(validateBlockTimestamp(NaN, 1000, 300).valid, false);
    assert.equal(validateBlockTimestamp(Infinity, 1000, 300).valid, false);
    assert.equal(validateBlockTimestamp(-Infinity, 1000, 300).valid, false);
  });

  it('honors a custom drift window', () => {
    // Tight 5-second window
    assert.equal(validateBlockTimestamp(1004, 1000, 5).valid, true);
    assert.equal(validateBlockTimestamp(1005, 1000, 5).valid, true);
    assert.equal(validateBlockTimestamp(1006, 1000, 5).valid, false);
  });

  it('uses 300s default when no window is provided', () => {
    assert.equal(validateBlockTimestamp(1300, 1000).valid, true); // == default edge
    assert.equal(validateBlockTimestamp(1301, 1000).valid, false);
    assert.equal(DEFAULT_MAX_TIMESTAMP_DRIFT_SEC, 300);
  });

  // ── validateIncomingBlock integration ────────────────────────────────

  function buildAuthorityPayload(
    db: DatabaseSync,
    timestamp: number,
  ): IncomingBlockPayload {
    const prev = getLatestBlock(db)!;
    const txIds: string[] = [];
    const merkleRoot = computeMerkleRoot(txIds);
    const number = prev.number + 1;
    const day = 1;
    const hash = computeBlockHash(number, prev.hash, timestamp, merkleRoot, day);
    return {
      number,
      day,
      timestamp,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds,
      transactions: [],
    };
  }

  it('validateIncomingBlock rejects a block 600s in the future (default 300s window)', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();
    const now = Math.floor(Date.now() / 1000);
    const payload = buildAuthorityPayload(db, now + 600);

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey, {
      nowSec: now,
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /600s in the future/);
  });

  it('validateIncomingBlock rejects a block 600s in the past (default window)', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();
    const now = Math.floor(Date.now() / 1000);
    const payload = buildAuthorityPayload(db, now - 600);

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey, {
      nowSec: now,
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /600s in the past/);
  });

  it('validateIncomingBlock accepts a block exactly at the edge', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();
    const now = Math.floor(Date.now() / 1000);
    const payload = buildAuthorityPayload(db, now + 300); // exactly at edge

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey, {
      nowSec: now,
    });
    assert.equal(result.valid, true, result.error);
  });

  it('validateIncomingBlock with skipBlockTimestampWindow accepts an old block (sync path)', () => {
    // Catch-up sync: peer ships a block from days ago. Default check
    // would reject it. skipBlockTimestampWindow: true is what makes
    // sync work.
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();
    const now = Math.floor(Date.now() / 1000);
    const payload = buildAuthorityPayload(db, now - 7 * 86400); // a week old

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey, {
      nowSec: now,
      skipBlockTimestampWindow: true,
    });
    assert.equal(result.valid, true, result.error);
  });

  it('validateIncomingBlock honors a custom maxTimestampDriftSec', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();
    const now = Math.floor(Date.now() / 1000);

    // 60s ahead, with a 30s tight window → reject
    const tight = validateIncomingBlock(
      db,
      consensus,
      buildAuthorityPayload(db, now + 60),
      'authority',
      authKey.publicKey,
      { nowSec: now, maxTimestampDriftSec: 30 },
    );
    assert.equal(tight.valid, false);

    // Same block, 600s window → accept
    const wide = validateIncomingBlock(
      db,
      consensus,
      buildAuthorityPayload(db, now + 60),
      'authority',
      authKey.publicKey,
      { nowSec: now, maxTimestampDriftSec: 600 },
    );
    assert.equal(wide.valid, true, wide.error);
  });

  // ── BftBlockProducer stash defense ──────────────────────────────────

  function setupValidator(): {
    db: DatabaseSync;
    set: SqliteValidatorSet;
    accountId: string;
    identity: NodeIdentity;
    vrfPublicKey: string;
  } {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    const accountId = acct.account.id;
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      accountId,
    );
    const identity = generateNodeIdentity();
    const vrfPublicKey = Ed25519VrfProvider.generateKeyPair().publicKey;
    registerValidator(db, {
      accountId,
      nodePublicKey: identity.publicKey,
      vrfPublicKey,
      stake: pts(200),
    });
    return { db, set: new SqliteValidatorSet(db), accountId, identity, vrfPublicKey };
  }

  it('BftBlockProducer.start: sending a future-stamped block via peerManager does NOT grow the stash', () => {
    const env = setupValidator();
    createGenesisBlock(env.db);

    const pm = new PeerManager(env.identity, env.accountId, 'phase50-genesis');
    const producer = new BftBlockProducer({
      db: env.db,
      peerManager: pm,
      validatorSet: env.set,
      localValidator: {
        accountId: env.accountId,
        publicKey: env.identity.publicKey,
        secretKey: env.identity.secretKey,
      },
      day: 1,
    });
    producer.start();

    try {
      // The runtime's BFT loop may have already produced a local
      // candidate block by the time start() returns (this validator
      // gets selected as proposer for block 1 in a 1-validator setup).
      // We assert NO INCREASE rather than absolute zero, isolating the
      // filter behavior from the proposer behavior.
      const before = producer.stashSize();

      // Build a syntactically-valid payload but stamp it 1 hour in the future
      const futureTs = Math.floor(Date.now() / 1000) + 3600;
      const merkleRoot = computeMerkleRoot([]);
      const prev = getLatestBlock(env.db)!;
      const futurePayload: IncomingBlockPayload = {
        number: 1,
        day: 1,
        // Use a deliberately-different hash so that even if the runtime
        // happened to produce a block at the same height, the entries
        // would not collide. The filter rejects this regardless of hash.
        timestamp: futureTs,
        previousHash: prev.hash,
        hash: 'ff'.repeat(32),
        merkleRoot,
        transactionCount: 0,
        rebaseEvent: null,
        txIds: [],
        transactions: [],
      };

      // The PeerManager event the producer subscribes to. Emitting
      // directly on the EventEmitter bypasses the network layer; the
      // producer's handler runs synchronously.
      pm.emit('block:received', futurePayload);

      assert.equal(
        producer.stashSize(),
        before,
        'future-stamped block must not enter the stash (size unchanged)',
      );
    } finally {
      producer.stop();
    }
  });

  it('BftBlockProducer.start: sending a fresh-stamped block grows the stash by 1', () => {
    const env = setupValidator();
    createGenesisBlock(env.db);

    const pm = new PeerManager(env.identity, env.accountId, 'phase50-genesis');
    const producer = new BftBlockProducer({
      db: env.db,
      peerManager: pm,
      validatorSet: env.set,
      localValidator: {
        accountId: env.accountId,
        publicKey: env.identity.publicKey,
        secretKey: env.identity.secretKey,
      },
      day: 1,
    });
    producer.start();

    try {
      const before = producer.stashSize();
      const ts = Math.floor(Date.now() / 1000); // current
      const merkleRoot = computeMerkleRoot([]);
      const prev = getLatestBlock(env.db)!;
      const payload: IncomingBlockPayload = {
        number: 1,
        day: 1,
        timestamp: ts,
        previousHash: prev.hash,
        // Distinct hash so we add a NEW entry rather than overwriting
        // any block the runtime may have stashed itself.
        hash: 'aa'.repeat(32),
        merkleRoot,
        transactionCount: 0,
        rebaseEvent: null,
        txIds: [],
        transactions: [],
      };

      pm.emit('block:received', payload);
      assert.equal(
        producer.stashSize(),
        before + 1,
        'fresh-stamped block must enter the stash (size +1)',
      );
    } finally {
      producer.stop();
    }
  });

  // ── Cross-check with BFT cert path: timestamp check fires BEFORE cert check
  it('BFT path: future-stamped block is rejected at timestamp check, not cert check', () => {
    // A block with a wildly future timestamp but otherwise valid BFT
    // cert + binding should fail on the new timestamp check, not slip
    // through to the cert path. Order matters because timestamp
    // rejection is cheap; cert verification isn't.
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      acct.account.id,
    );
    const identity = generateNodeIdentity();
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: pts(200),
    });
    const set = new SqliteValidatorSet(db);
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);

    // Build a real cert for block 1
    const voteSet = new VoteSet('precommit', 1, 0, set);
    voteSet.addVote(
      signVote({
        kind: 'precommit', height: 1, round: 0, blockHash: block1.hash,
        validatorAccountId: acct.account.id,
        validatorPublicKey: identity.publicKey,
        validatorSecretKey: identity.secretKey,
      }),
    );
    const cert = buildCommitCertificate(voteSet)!;
    const certHash = computeCertHash(cert);

    const now = Math.floor(Date.now() / 1000);
    const futureTs = now + 86400; // 1 day in the future
    const merkleRoot = computeMerkleRoot([]);
    const block2Hash = computeBlockHash(2, block1.hash, futureTs, merkleRoot, 1, certHash);
    const payload: IncomingBlockPayload = {
      number: 2,
      day: 1,
      timestamp: futureTs,
      previousHash: block1.hash,
      hash: block2Hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      parentCertificate: cert,
      prevCommitCertHash: certHash,
    };

    const consensus = new BFTConsensus({
      validatorSet: set,
      localAccountId: acct.account.id,
      localNodePublicKey: identity.publicKey,
    });
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      acct.account.id,
      identity.publicKey,
      { bftValidatorSet: set, skipCertTimestampWindow: true, nowSec: now },
    );
    assert.equal(result.valid, false);
    // The timestamp message wins, NOT a cert-path message
    assert.match(result.error ?? '', /in the future/);
  });
});
