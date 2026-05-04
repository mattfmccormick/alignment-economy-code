// Phase 28: CommitCertificate-in-block integration.
//
// Every block N >= 2 carries a parent certificate proving block N-1 was
// committed by 2/3+ of the validator set. validateIncomingBlock checks
// it against the validator set when bftValidatorSet is provided.
//
// Verifies:
//   1. Authority path (no bftValidatorSet): cert is ignored, blocks
//      validate as before.
//   2. BFT path: block 1 doesn't need a parent cert (genesis has none).
//   3. BFT path: block 2 with a valid parent cert validates.
//   4. BFT path: block 2 with NO parent cert is rejected.
//   5. BFT path: parent cert with wrong height rejected.
//   6. BFT path: parent cert whose blockHash != block.previousHash rejected.
//   7. BFT path: parent cert that fails verifyCommitCertificate (sub-quorum,
//      wrong validator, etc.) rejected.

import { describe, it, beforeEach } from 'node:test';
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
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { signVote, type Vote } from '../src/core/consensus/votes.js';
import { computeCertHash, type CommitCertificate } from '../src/core/consensus/commit-certificate.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import { BFTConsensus } from '../src/core/consensus/BFTConsensus.js';
import {
  validateIncomingBlock,
  type IncomingBlockPayload,
} from '../src/network/block-validator.js';
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

interface ValidatorHandle {
  accountId: string;
  identity: NodeIdentity;
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
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: pts(200),
    });
    validators.push({ accountId: acct.account.id, identity });
  }
  return { db, set: new SqliteValidatorSet(db), validators };
}

function precommit(v: ValidatorHandle, height: number, blockHash: string): Vote {
  return signVote({
    kind: 'precommit',
    height,
    round: 0,
    blockHash,
    validatorAccountId: v.accountId,
    validatorPublicKey: v.identity.publicKey,
    validatorSecretKey: v.identity.secretKey,
  });
}

/** Build an in-memory block payload chained to db's current head, without persisting. */
function buildPayload(
  db: DatabaseSync,
  opts: {
    number?: number;
    day?: number;
    txIds?: string[];
    timestamp?: number;
    parentCertificate?: CommitCertificate;
  } = {},
): IncomingBlockPayload {
  const prev = getLatestBlock(db);
  const number = opts.number ?? (prev ? prev.number + 1 : 1);
  const day = opts.day ?? 1;
  const txIds = opts.txIds ?? [];
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const previousHash = prev ? prev.hash : '0'.repeat(64);
  const merkleRoot = computeMerkleRoot(txIds);
  // Cert-in-block-hash promotion (Session 39): bind the parent cert into
  // the block hash. When no parentCertificate is supplied, prevCommitCertHash
  // stays null and the hash matches the legacy 5-arg form.
  const prevCommitCertHash = opts.parentCertificate
    ? computeCertHash(opts.parentCertificate)
    : null;
  const hash = computeBlockHash(number, previousHash, timestamp, merkleRoot, day, prevCommitCertHash);
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
    transactions: [],
    parentCertificate: opts.parentCertificate,
    prevCommitCertHash,
  };
}

describe('Phase 28: CommitCertificate-in-block integration', () => {
  let env: ReturnType<typeof setupValidators>;
  /** A 4-validator BFT setup. quorum = 3. */
  beforeEach(() => {
    env = setupValidators(4);
  });

  // ── Authority path: no validator set provided, cert is ignored ──────

  it('AuthorityConsensus path: validator set unbound, parentCertificate is ignored', () => {
    const db = freshDb();
    createGenesisBlock(db);
    createBlock(db, 1, []); // block 1 persisted
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    // Block 2 with NO parent cert — under authority, this is fine
    const payload = buildPayload(db);
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      'authority',
      authKey.publicKey,
      // bftValidatorSet OMITTED → cert check skipped
    );
    assert.equal(result.valid, true, result.error);
  });

  // ── BFT path: block 1 needs no parent cert ──────────────────────────

  it('BFT path: block 1 (parent is genesis) does not need a parent cert', () => {
    const db = freshDb();
    createGenesisBlock(db);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    const payload = buildPayload(db); // number = 1 (parent = genesis)
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set },
    );
    assert.equal(result.valid, true, result.error);
  });

  // ── BFT path: block 2 with a valid parent cert ──────────────────────

  it('BFT path: block 2 with a valid parent cert is accepted', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    // 3-of-4 precommits sign block1.hash
    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: block1.hash,
      precommits: env.validators.slice(0, 3).map((vv) => precommit(vv, 1, block1.hash)),
    };

    const payload = buildPayload(db, { parentCertificate: cert });
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set },
    );
    assert.equal(result.valid, true, result.error);
  });

  // ── BFT path: missing parent cert ───────────────────────────────────

  it('BFT path: block 2 without a parent cert is rejected', () => {
    const db = freshDb();
    createGenesisBlock(db);
    createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    const payload = buildPayload(db); // no parentCertificate
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set },
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /missing parentCertificate/);
  });

  // ── BFT path: cert with wrong height ────────────────────────────────

  it('BFT path: parent cert with wrong height is rejected', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    const cert: CommitCertificate = {
      height: 99, // WRONG: should be 1
      round: 0,
      blockHash: block1.hash,
      precommits: env.validators.slice(0, 3).map((vv) => precommit(vv, 99, block1.hash)),
    };

    const payload = buildPayload(db, { parentCertificate: cert });
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set },
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /parentCertificate\.height/);
  });

  // ── BFT path: cert whose blockHash != block.previousHash ────────────

  it('BFT path: parent cert with mismatched blockHash is rejected', () => {
    const db = freshDb();
    createGenesisBlock(db);
    createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    // Cert references some other block's hash, not block 1's
    const wrongHash = 'aa'.repeat(32);
    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: wrongHash,
      precommits: env.validators.slice(0, 3).map((vv) => precommit(vv, 1, wrongHash)),
    };

    const payload = buildPayload(db, { parentCertificate: cert });
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set },
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /does not match block\.previousHash/);
  });

  // ── BFT path: cert that fails verifyCommitCertificate ───────────────

  it('BFT path: sub-quorum parent cert is rejected', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    // Only 2 precommits — quorum is 3
    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: block1.hash,
      precommits: env.validators.slice(0, 2).map((vv) => precommit(vv, 1, block1.hash)),
    };

    const payload = buildPayload(db, { parentCertificate: cert });
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set },
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /parentCertificate verification failed/);
    assert.match(result.error ?? '', /quorum/);
  });

  it('BFT path: parent cert with a tampered precommit signature is rejected', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    const validPrecommits = env.validators
      .slice(0, 3)
      .map((vv) => precommit(vv, 1, block1.hash));
    const orig = validPrecommits[0];
    // Flip one signature byte
    validPrecommits[0] = {
      ...orig,
      signature:
        orig.signature.slice(0, -2) +
        ((parseInt(orig.signature.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')),
    };

    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: block1.hash,
      precommits: validPrecommits,
    };

    const payload = buildPayload(db, { parentCertificate: cert });
    const result = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set, skipCertTimestampWindow: true },
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /parentCertificate verification failed/);
  });

  // ── BFT path: skipCertTimestampWindow flag for catch-up sync ────────

  it('BFT path: skipCertTimestampWindow lets old certs validate during sync', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);

    const v = env.validators[0];
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });

    // Sign precommits in the distant past
    const oldNow = 1_000_000;
    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: block1.hash,
      precommits: env.validators.slice(0, 3).map((vv) =>
        signVote({
          kind: 'precommit',
          height: 1,
          round: 0,
          blockHash: block1.hash,
          validatorAccountId: vv.accountId,
          validatorPublicKey: vv.identity.publicKey,
          validatorSecretKey: vv.identity.secretKey,
          now: oldNow,
        }),
      ),
    };

    const payload = buildPayload(db, { parentCertificate: cert });

    // Without skipCertTimestampWindow → fails because precommits are stale
    const failing = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set, skipCertTimestampWindow: false },
    );
    assert.equal(failing.valid, false);
    assert.match(failing.error ?? '', /parentCertificate verification failed/);

    // With skipCertTimestampWindow → passes (catch-up sync path)
    const passing = validateIncomingBlock(
      db,
      consensus,
      payload,
      v.accountId,
      v.identity.publicKey,
      { bftValidatorSet: env.set, skipCertTimestampWindow: true },
    );
    assert.equal(passing.valid, true, passing.error);
  });
});
