// Phase 57: Sync-replay of validator changes.
//
// Sessions 48-50 made validator changes propagate through the live BFT
// path: signed change → queue → block payload → applied at commit on
// every node. But that only works for nodes that were ONLINE when the
// block landed. A node syncing past blocks (cold catch-up after
// downtime, or a fresh joiner) didn't pick up validator changes from
// historical blocks — their CURRENT validator set stayed at genesis +
// whatever they witnessed live, even though chain history said the set
// had churned.
//
// This session closes that gap:
//
//   1. Block.validatorChanges is now a persisted field (new
//      blocks.validator_changes JSON column, schema v5 → v6).
//   2. ChainSync source ships validatorChanges in sync replies (auto
//      via serializeBlock which spreads all Block fields).
//   3. Runner's BFT-mode sync apply handler:
//        - inserts the block (persists validatorChanges)
//        - saves parent cert + parent snapshot (for serving onward)
//        - saves THIS block's snapshot — pre-change, matches the set
//          that signed cert(N)
//        - applies validatorChanges to mutate the set for height N+1
//
// Verified:
//   1. Block type carries validatorChanges; SqliteBlockStore round-trips
//      it through the validator_changes column.
//   2. payloadToBlock copies validatorChanges from payload to block.
//   3. payloadToBlock normalizes empty list → null for storage.
//   4. End-to-end: feed a block-with-changes payload through the sync
//      apply handler, verify the candidate validator is now registered
//      on the follower AND the snapshot at the block's height is the
//      pre-change set.

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
import { registerValidator } from '../src/core/consensus/registration.js';
import { generateKeyPair } from '../src/core/crypto.js';
import {
  signValidatorChangeRegister,
  applyValidatorChange,
  type ValidatorChange,
} from '../src/core/consensus/validator-change.js';
import {
  payloadToBlock,
  type IncomingBlockPayload,
} from '../src/network/block-validator.js';
import { runTransaction } from '../src/db/connection.js';
import type { Block } from '../src/core/types.js';
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

interface AccountHandle {
  accountId: string;
  publicKey: string;
  privateKey: string;
}

function createFundedAccount(db: DatabaseSync, earnedDisplay: number): AccountHandle {
  const kp = generateKeyPair();
  const acct = createAccount(db, 'individual', 1, 100, kp.publicKey);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    pts(earnedDisplay).toString(),
    acct.account.id,
  );
  return { accountId: acct.account.id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

interface ValidatorHandle extends AccountHandle {
  identity: NodeIdentity;
  vrfPublicKey: string;
}

function registerAsValidator(db: DatabaseSync, acct: AccountHandle): ValidatorHandle {
  const identity = generateNodeIdentity();
  const vrfPublicKey = Ed25519VrfProvider.generateKeyPair().publicKey;
  registerValidator(db, {
    accountId: acct.accountId,
    nodePublicKey: identity.publicKey,
    vrfPublicKey,
    stake: pts(200),
  });
  return { ...acct, identity, vrfPublicKey };
}

describe('Phase 57: Sync-replay of validator changes', () => {
  // ── Block + storage round-trip ──────────────────────────────────────

  it('Block.validatorChanges round-trips through SqliteBlockStore', () => {
    const db = freshDb();
    const candidate = createFundedAccount(db, 500);
    createGenesisBlock(db);

    const change = signValidatorChangeRegister({
      accountId: candidate.accountId,
      nodePublicKey: 'aa'.repeat(32),
      vrfPublicKey: 'bb'.repeat(32),
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: candidate.privateKey,
    });

    // Build a block manually with validatorChanges set
    const block: Block = {
      number: 1,
      day: 1,
      timestamp: 1714838500,
      previousHash: getLatestBlock(db)!.hash,
      hash: '',
      merkleRoot: computeMerkleRoot([]),
      transactionCount: 0,
      rebaseEvent: null,
      prevCommitCertHash: null,
      validatorChanges: [change],
    };
    block.hash = computeBlockHash(1, block.previousHash, block.timestamp, block.merkleRoot, 1, null);

    blockStore(db).insert(block, false);
    const loaded = blockStore(db).findByNumber(1)!;
    assert.equal(loaded.validatorChanges?.length, 1);
    assert.equal(loaded.validatorChanges![0].accountId, candidate.accountId);
    assert.equal(loaded.validatorChanges![0].type, 'register');
  });

  it('SqliteBlockStore stores null when no validator changes ride a block', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const block1 = createBlock(db, 1, []);
    const loaded = blockStore(db).findByNumber(1)!;
    assert.equal(loaded.validatorChanges, null);
    assert.equal(block1.validatorChanges, null);
  });

  // ── payloadToBlock copies the field ─────────────────────────────────

  it('payloadToBlock copies validatorChanges from payload to block', () => {
    const db = freshDb();
    const candidate = createFundedAccount(db, 500);
    const change = signValidatorChangeRegister({
      accountId: candidate.accountId,
      nodePublicKey: 'aa'.repeat(32),
      vrfPublicKey: 'bb'.repeat(32),
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: candidate.privateKey,
    });

    const payload: IncomingBlockPayload = {
      number: 1,
      day: 1,
      timestamp: 1714838500,
      previousHash: '0'.repeat(64),
      hash: 'aa'.repeat(32),
      merkleRoot: computeMerkleRoot([]),
      transactionCount: 0,
      rebaseEvent: null,
      validatorChanges: [change],
    };
    const block = payloadToBlock(payload);
    assert.equal(block.validatorChanges?.length, 1);
    assert.equal(block.validatorChanges![0].accountId, candidate.accountId);
  });

  it('payloadToBlock normalizes empty/missing validatorChanges to null', () => {
    const payload: IncomingBlockPayload = {
      number: 1,
      day: 1,
      timestamp: 1714838500,
      previousHash: '0'.repeat(64),
      hash: 'aa'.repeat(32),
      merkleRoot: computeMerkleRoot([]),
      transactionCount: 0,
      rebaseEvent: null,
      // no validatorChanges
    };
    assert.equal(payloadToBlock(payload).validatorChanges, null);

    const empty = payloadToBlock({ ...payload, validatorChanges: [] });
    assert.equal(empty.validatorChanges, null, 'empty list normalized to null');
  });

  // ── End-to-end sync replay simulation ───────────────────────────────
  //
  // This test mimics the runner's BFT sync apply handler step-by-step,
  // verifying that a follower processing a synced block with a
  // validatorChange ends up with both:
  //   - the new validator registered in their CURRENT validators table
  //   - the snapshot at the block's height capturing the PRE-CHANGE set
  //     (so future cert(N) verification works correctly)

  it('a follower replaying a synced block applies validator changes + snapshots pre-change set', () => {
    // Two parallel DBs: source already has the change applied, follower
    // is fresh from genesis. Both seeded with the same accounts so the
    // signed change verifies on both.
    function setup(): {
      db: DatabaseSync;
      existingValidator: ValidatorHandle;
      candidate: AccountHandle;
    } {
      const db = freshDb();
      // Seed accounts with deterministic publicKeys so both DBs hold
      // byte-identical state. Use shared keypairs across both setups
      // via a closure trick — see the kpExisting/kpCandidate hoist
      // below.
      const acctExisting = createAccount(db, 'individual', 1, 100, kpExisting.publicKey);
      db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
        pts(500).toString(),
        acctExisting.account.id,
      );
      const existingValidator = registerAsValidator(
        db,
        { accountId: acctExisting.account.id, publicKey: kpExisting.publicKey, privateKey: kpExisting.privateKey },
      );
      const acctCandidate = createAccount(db, 'individual', 1, 100, kpCandidate.publicKey);
      db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
        pts(500).toString(),
        acctCandidate.account.id,
      );
      const candidate: AccountHandle = {
        accountId: acctCandidate.account.id,
        publicKey: kpCandidate.publicKey,
        privateKey: kpCandidate.privateKey,
      };
      createGenesisBlock(db);
      return { db, existingValidator, candidate };
    }
    const kpExisting = generateKeyPair();
    const kpCandidate = generateKeyPair();

    const source = setup();
    const follower = setup();

    // On the source: apply the register-candidate change locally so
    // the source has the post-change set + can serve the change in a
    // sync reply.
    const blockTs = Math.floor(Date.now() / 1000);
    const candidateNodeKey = generateNodeIdentity().publicKey;
    const candidateVrfKey = Ed25519VrfProvider.generateKeyPair().publicKey;
    const change: ValidatorChange = signValidatorChangeRegister({
      accountId: source.candidate.accountId,
      nodePublicKey: candidateNodeKey,
      vrfPublicKey: candidateVrfKey,
      stake: pts(200).toString(),
      timestamp: blockTs,
      accountPrivateKey: source.candidate.privateKey,
    });

    // Build block 1 on the source carrying the change
    const sourcePrev = getLatestBlock(source.db)!;
    const block1: Block = {
      number: 1,
      day: 1,
      timestamp: blockTs,
      previousHash: sourcePrev.hash,
      hash: '',
      merkleRoot: computeMerkleRoot([]),
      transactionCount: 0,
      rebaseEvent: null,
      prevCommitCertHash: null,
      validatorChanges: [change],
    };
    block1.hash = computeBlockHash(1, block1.previousHash, block1.timestamp, block1.merkleRoot, 1, null);

    // Source persists block + applies change (mimicking BftBlockProducer.onCommit)
    runTransaction(source.db, () => {
      blockStore(source.db).insert(block1, false);
      blockStore(source.db).saveValidatorSnapshot(1, new SqliteValidatorSet(source.db).listAll());
      applyValidatorChange(source.db, change, blockTs);
    });

    // Source post-state: existing validator + candidate are both validators
    const sourceSet = new SqliteValidatorSet(source.db);
    assert.equal(sourceSet.listActive().length, 2);
    assert.ok(sourceSet.findByAccountId(source.candidate.accountId));

    // ── Follower receives block-1 payload via sync apply path ────────
    // We mimic the runner's BFT sync handler inline so this test
    // stays decoupled from the AENodeRunner machinery (which spins up
    // P2P + API). Same logic, no network.
    const payload: IncomingBlockPayload = {
      number: block1.number,
      day: block1.day,
      timestamp: block1.timestamp,
      previousHash: block1.previousHash,
      hash: block1.hash,
      merkleRoot: block1.merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      validatorChanges: [change],
    };

    const followerSet = new SqliteValidatorSet(follower.db);
    runTransaction(follower.db, () => {
      const block = payloadToBlock(payload);
      blockStore(follower.db).insert(block, false);
      // Snapshot pre-change set (captures the set that signed cert(1))
      blockStore(follower.db).saveValidatorSnapshot(block.number, followerSet.listAll());
      // Apply changes (mutates set for block 2 onward)
      for (const c of payload.validatorChanges ?? []) {
        applyValidatorChange(follower.db, c, block.timestamp);
      }
    });

    // ── Assertions ──────────────────────────────────────────────────
    // 1. Follower's CURRENT validator set now matches source's
    const sourceActive = sourceSet.listActive().map((v) => v.accountId).sort();
    const followerActive = followerSet.listActive().map((v) => v.accountId).sort();
    assert.deepEqual(followerActive, sourceActive, 'follower active set matches source after sync');
    assert.equal(followerActive.length, 2);

    // 2. Snapshot at block 1 captures the PRE-change set (just the
    //    existing validator, before the candidate's register applies)
    const snap1 = blockStore(follower.db).findValidatorSnapshot(1)!;
    assert.equal(snap1.length, 1, 'snapshot(1) is the pre-change set');
    assert.equal(snap1[0].accountId, follower.existingValidator.accountId);

    // 3. Block stored with validatorChanges so this follower can serve
    //    the changes onward
    const stored = blockStore(follower.db).findByNumber(1)!;
    assert.equal(stored.validatorChanges?.length, 1);
    assert.equal(stored.validatorChanges![0].accountId, source.candidate.accountId);

    // 4. Account balance flowed earned -> locked on the follower (the
    //    same as on the source — proof the apply was deterministic)
    const sourceCand = source.db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(source.candidate.accountId);
    const followerCand = follower.db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(follower.candidate.accountId);
    assert.deepEqual(followerCand, sourceCand);
  });
});
