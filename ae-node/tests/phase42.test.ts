// Phase 42: Per-height validator-set snapshotting.
//
// A historical CommitCertificate must still verify even if some of its
// signers have since been slashed or deregistered. Without snapshotting,
// verifyCommitCertificate looks up each signer in the CURRENT validator
// set; an inactive signer fails the active-check and the whole cert
// fails. With snapshotting, the cert is verified against the validator
// set as it was AT cert.height — the contemporaneous truth.
//
// What this enables:
//   - Catch-up sync of past blocks signed by validators who later got
//     slashed (Session 35) or who deregistered.
//   - Historical chain audits.
//
// Tests:
//   1. SnapshotValidatorSet adapter behavior (immutable, lookups,
//      quorum count, listActive filtering).
//   2. blockStore round-trips a validator snapshot.
//   3. validateIncomingBlock prefers parentValidatorSnapshot over
//      bftValidatorSet — a cert signed by a now-slashed validator
//      verifies via snapshot but fails via current set.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import {
  createGenesisBlock,
  createBlock,
  blockStore,
  computeBlockHash,
  computeMerkleRoot,
  getLatestBlock,
} from '../src/core/block.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { SnapshotValidatorSet } from '../src/core/consensus/SnapshotValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { signVote } from '../src/core/consensus/votes.js';
import {
  buildCommitCertificate,
  computeCertHash,
  type CommitCertificate,
} from '../src/core/consensus/commit-certificate.js';
import { VoteSet } from '../src/core/consensus/vote-aggregator.js';
import { BFTConsensus } from '../src/core/consensus/BFTConsensus.js';
import {
  validateIncomingBlock,
  type IncomingBlockPayload,
} from '../src/network/block-validator.js';
import type { ValidatorInfo } from '../src/core/consensus/IValidatorSet.js';
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

const HASH_X = '11'.repeat(32);

interface ValidatorHandle {
  accountId: string;
  identity: NodeIdentity;
  vrfPublicKey: string;
}

function setupValidators(count: number): {
  db: DatabaseSync;
  set: SqliteValidatorSet;
  validators: ValidatorHandle[];
} {
  const db = freshDb();
  const validators: ValidatorHandle[] = [];
  for (let i = 0; i < count; i++) {
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      acct.account.id,
    );
    const identity = generateNodeIdentity();
    const vrfPublicKey = Ed25519VrfProvider.generateKeyPair().publicKey;
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey,
      stake: pts(200),
    });
    validators.push({ accountId: acct.account.id, identity, vrfPublicKey });
  }
  return { db, set: new SqliteValidatorSet(db), validators };
}

describe('Phase 42: Per-height validator-set snapshotting', () => {
  // ── SnapshotValidatorSet adapter ─────────────────────────────────────

  it('SnapshotValidatorSet implements IValidatorSet over a frozen list', () => {
    const validators: ValidatorInfo[] = [
      {
        accountId: 'b',
        nodePublicKey: 'b'.repeat(64),
        vrfPublicKey: '00'.repeat(32),
        stake: pts(100),
        isActive: true,
        registeredAt: 0,
        deregisteredAt: null,
      },
      {
        accountId: 'a',
        nodePublicKey: 'a'.repeat(64),
        vrfPublicKey: '00'.repeat(32),
        stake: pts(200),
        isActive: true,
        registeredAt: 0,
        deregisteredAt: null,
      },
      {
        accountId: 'c',
        nodePublicKey: 'c'.repeat(64),
        vrfPublicKey: '00'.repeat(32),
        stake: pts(150),
        isActive: false,
        registeredAt: 0,
        deregisteredAt: 100,
      },
    ];
    const snap = new SnapshotValidatorSet(validators);

    // Lookups
    assert.ok(snap.findByAccountId('a'));
    assert.equal(snap.findByAccountId('a')!.stake, pts(200));
    assert.ok(snap.findByNodePublicKey('b'.repeat(64)));
    assert.equal(snap.findByAccountId('nope'), null);

    // listActive: filters out 'c', sorts by accountId
    const active = snap.listActive();
    assert.equal(active.length, 2);
    assert.equal(active[0].accountId, 'a');
    assert.equal(active[1].accountId, 'b');

    // listAll: includes 'c'
    assert.equal(snap.listAll().length, 3);

    // totalActiveStake (only a + b)
    assert.equal(snap.totalActiveStake(), pts(200) + pts(100));

    // quorumCount: 2 active → floor(4/3)+1 = 2
    assert.equal(snap.quorumCount(), 2);
  });

  it('SnapshotValidatorSet is immutable — mutators throw', () => {
    const snap = new SnapshotValidatorSet([]);
    assert.throws(() => snap.insert({} as any), /immutable/);
    assert.throws(() => snap.markInactive('x', 1), /immutable/);
    assert.throws(() => snap.markActive('x'), /immutable/);
  });

  // ── blockStore snapshot round-trip ──────────────────────────────────

  it('blockStore round-trips a validator snapshot', () => {
    const env = setupValidators(3);
    createGenesisBlock(env.db);
    const block1 = createBlock(env.db, 1, []);

    const snapshot = env.set.listAll();
    const store = blockStore(env.db);

    assert.equal(store.findValidatorSnapshot(1), null, 'no snapshot before save');
    store.saveValidatorSnapshot(1, snapshot);

    const loaded = store.findValidatorSnapshot(1);
    assert.ok(loaded);
    assert.equal(loaded!.length, 3);
    // bigint stake survives JSON round-trip
    for (const v of loaded!) {
      assert.equal(typeof v.stake, 'bigint');
      assert.equal(v.stake, pts(200));
    }
    // Same accountIds (sorted is no guarantee at storage layer; check by
    // looking up via SnapshotValidatorSet)
    const snap = new SnapshotValidatorSet(loaded!);
    for (const v of env.validators) {
      assert.ok(snap.findByAccountId(v.accountId));
    }
    void block1;
  });

  // ── validateIncomingBlock: snapshot beats current set ────────────────

  it('cert signed by a NOW-SLASHED validator verifies via snapshot but fails via current set', () => {
    // Three validators sign a cert at "block 1". Then validator 0 gets
    // slashed (markInactive). The current set says validator 0 is
    // inactive — verifyCommitCertificate against the current set fails
    // because one of the signers is no longer active. But against the
    // snapshot from block 1, the cert verifies cleanly.
    const env = setupValidators(3);
    createGenesisBlock(env.db);
    const block1 = createBlock(env.db, 1, []);
    // Local chain head stays at block 1; we synthesize a block-2
    // payload below to drive validation without growing the chain.

    // Build a cert for block 1 using all three validators (overkill
    // for quorum=3 of 3 but exercises the multi-signer path)
    const voteSet = new VoteSet('precommit', 1, 0, env.set);
    for (const v of env.validators) {
      voteSet.addVote(
        signVote({
          kind: 'precommit', height: 1, round: 0, blockHash: block1.hash,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    const cert = buildCommitCertificate(voteSet)!;

    // Capture the snapshot BEFORE slashing
    const historicalSnapshot = env.set.listAll();
    blockStore(env.db).saveValidatorSnapshot(1, historicalSnapshot);

    // Now slash validator 0 (mark inactive)
    env.set.markInactive(env.validators[0].accountId, Math.floor(Date.now() / 1000));

    // Build a synthetic block-2 payload chained onto block 1.
    // Cert-in-block-hash promotion (Session 39): include the cert hash
    // in block 2's canonical hash so the parentCertificate is bound to
    // this block at the hash level.
    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prevCommitCertHash = computeCertHash(cert);
    const block2Hash = computeBlockHash(2, block1.hash, ts, merkleRoot, 1, prevCommitCertHash);
    const payload: IncomingBlockPayload = {
      number: 2,
      day: 1,
      timestamp: ts,
      previousHash: block1.hash,
      hash: block2Hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      parentCertificate: cert,
      prevCommitCertHash,
    };

    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[0].accountId,
      localNodePublicKey: env.validators[0].identity.publicKey,
    });

    // ── WITHOUT snapshot: verification fails because v0 is now inactive
    const withoutSnap = validateIncomingBlock(
      env.db,
      consensus,
      payload,
      env.validators[1].accountId, // sender (a different active validator)
      env.validators[1].identity.publicKey,
      { bftValidatorSet: env.set, skipCertTimestampWindow: true },
    );
    assert.equal(withoutSnap.valid, false, 'cert should fail against current set after slash');
    assert.match(withoutSnap.error ?? '', /inactive|verification failed/);

    // ── WITH snapshot: verification succeeds (snapshot has v0 active)
    const withSnap = validateIncomingBlock(
      env.db,
      consensus,
      { ...payload, parentValidatorSnapshot: historicalSnapshot },
      env.validators[1].accountId,
      env.validators[1].identity.publicKey,
      { bftValidatorSet: env.set, skipCertTimestampWindow: true },
    );
    assert.equal(withSnap.valid, true, withSnap.error);
  });

  // ── Sanity: snapshot verification still rejects bad certs ───────────

  it('snapshot path still rejects sub-quorum certs', () => {
    const env = setupValidators(3);
    createGenesisBlock(env.db);
    const block1 = createBlock(env.db, 1, []);
    // Local chain head is block 1. We synthesize a block-2 payload
    // that chains onto it (without persisting block 2 — the test is
    // about validation, not chain growth).

    // Hand-build a sub-quorum cert (1 of 3 signers; quorum is 3)
    const voteSet = new VoteSet('precommit', 1, 0, env.set);
    voteSet.addVote(
      signVote({
        kind: 'precommit', height: 1, round: 0, blockHash: block1.hash,
        validatorAccountId: env.validators[0].accountId,
        validatorPublicKey: env.validators[0].identity.publicKey,
        validatorSecretKey: env.validators[0].identity.secretKey,
      }),
    );
    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: block1.hash,
      precommits: voteSet.allVotes(),
    };
    const snapshot = env.set.listAll();

    // Build a synthetic block-2 payload (chains onto block 1).
    // Bind the (sub-quorum) cert into the block hash via prevCommitCertHash
    // so the validator gets past the cert-binding check and reaches the
    // actual quorum/verification check we're testing here.
    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prevCommitCertHash = computeCertHash(cert);
    const block2Hash = computeBlockHash(2, block1.hash, ts, merkleRoot, 1, prevCommitCertHash);

    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[0].accountId,
      localNodePublicKey: env.validators[0].identity.publicKey,
    });

    const result = validateIncomingBlock(
      env.db,
      consensus,
      {
        number: 2,
        day: 1,
        timestamp: ts,
        previousHash: block1.hash,
        hash: block2Hash,
        merkleRoot,
        transactionCount: 0,
        rebaseEvent: null,
        txIds: [],
        transactions: [],
        parentCertificate: cert,
        parentValidatorSnapshot: snapshot,
        prevCommitCertHash,
      },
      env.validators[1].accountId,
      env.validators[1].identity.publicKey,
      { bftValidatorSet: env.set, skipCertTimestampWindow: true },
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /quorum|verification failed/);
    void getLatestBlock;
  });
});
