// Phase 58: Block-hash inclusion of validator changes.
//
// Sessions 48-51 made validator changes propagate live + on sync. But
// the block hash didn't COMMIT to those changes — a Byzantine sync
// source could swap a register for a deregister (or drop entries, or
// reorder them) on a block in their stash, and the new payload would
// still hash the same as the original. validateIncomingBlock's signature
// check (Session 48) catches direct tampering of the change body, but
// not "I substitute one valid signed change for another."
//
// This session folds computeValidatorChangesHash(payload.validatorChanges)
// into the block hash via a new optional 7th arg on computeBlockHash.
// Mirrors Session 39's cert-in-block-hash promotion exactly:
//
//   - null → empty-string concat → preserves legacy hashes for blocks
//     with no changes (the common case).
//   - non-null → folded into the hash → tampering breaks block.hash.
//
// validateIncomingBlock re-derives the hash from payload.validatorChanges
// and includes it in the expected hash. If the producer's block hash
// committed to a different changes set, the receiver rejects the block.
//
// Verified:
//   1. computeBlockHash with null validatorChangesHash equals the
//      6-arg form (back-compat for no-changes blocks).
//   2. computeBlockHash with non-null changes hash differs from null.
//   3. Different changes lists hash to different block hashes.
//   4. validateIncomingBlock accepts a properly-bound payload.
//   5. validateIncomingBlock rejects a payload whose block hash was
//      computed without the changes (forgot to fold them in).
//   6. validateIncomingBlock rejects a payload with swapped changes
//      (block hash committed to set A, payload ships set B).
//   7. validateIncomingBlock rejects a payload with reordered changes
//      that the producer "would have" hashed differently — well,
//      computeValidatorChangesHash is order-independent, so reorder
//      ALONE doesn't break. But adding/removing entries does.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import {
  createGenesisBlock,
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
  computeValidatorChangesHash,
  type ValidatorChange,
} from '../src/core/consensus/validator-change.js';
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

function makeRegisterChange(acct: AccountHandle, ts = 1714838400): ValidatorChange {
  const node = generateNodeIdentity();
  const vrf = Ed25519VrfProvider.generateKeyPair();
  return signValidatorChangeRegister({
    accountId: acct.accountId,
    nodePublicKey: node.publicKey,
    vrfPublicKey: vrf.publicKey,
    stake: pts(200).toString(),
    timestamp: ts,
    accountPrivateKey: acct.privateKey,
  });
}

describe('Phase 58: Block-hash inclusion of validator changes', () => {
  // ── computeBlockHash back-compat + sensitivity ──────────────────────

  it('null validatorChangesHash equals the 6-arg form for no-changes blocks', () => {
    const six = computeBlockHash(1, '0'.repeat(64), 1714838400, computeMerkleRoot([]), 1, null);
    const sevenNull = computeBlockHash(
      1,
      '0'.repeat(64),
      1714838400,
      computeMerkleRoot([]),
      1,
      null,
      null,
    );
    assert.equal(six, sevenNull, 'null changes hash preserves legacy hash');
  });

  it('non-null validatorChangesHash produces a different block hash', () => {
    const args: [number, string, number, string, number] = [
      1,
      '0'.repeat(64),
      1714838400,
      computeMerkleRoot([]),
      1,
    ];
    const without = computeBlockHash(...args, null, null);
    const withChanges = computeBlockHash(...args, null, 'aa'.repeat(32));
    assert.notEqual(without, withChanges, 'different hash when changes ride the block');
  });

  it('different changes lists hash to different block hashes', () => {
    const db = freshDb();
    const a = createFundedAccount(db, 500);
    const b = createFundedAccount(db, 500);
    const ca = makeRegisterChange(a, 1700000000);
    const cb = makeRegisterChange(b, 1700000001);

    const args: [number, string, number, string, number] = [
      1,
      '0'.repeat(64),
      1714838400,
      computeMerkleRoot([]),
      1,
    ];
    const hash1 = computeBlockHash(...args, null, computeValidatorChangesHash([ca]));
    const hash2 = computeBlockHash(...args, null, computeValidatorChangesHash([cb]));
    const hashBoth = computeBlockHash(...args, null, computeValidatorChangesHash([ca, cb]));
    assert.notEqual(hash1, hash2);
    assert.notEqual(hash1, hashBoth);
    assert.notEqual(hash2, hashBoth);
  });

  // ── validateIncomingBlock binding ───────────────────────────────────

  function setupValidatorEnv(): {
    db: DatabaseSync;
    set: SqliteValidatorSet;
    accountId: string;
    identity: NodeIdentity;
    candidate: AccountHandle;
  } {
    const db = freshDb();
    const localKp = generateKeyPair();
    const local = createAccount(db, 'individual', 1, 100, localKp.publicKey);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      local.account.id,
    );
    const identity = generateNodeIdentity();
    registerValidator(db, {
      accountId: local.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: pts(200),
    });
    const candidate = createFundedAccount(db, 500);
    return {
      db,
      set: new SqliteValidatorSet(db),
      accountId: local.account.id,
      identity,
      candidate,
    };
  }

  it('validateIncomingBlock accepts a properly-bound payload', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);
    const change = makeRegisterChange(env.candidate, Math.floor(Date.now() / 1000));
    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prev = getLatestBlock(env.db)!;
    const changesHash = computeValidatorChangesHash([change]);
    const hash = computeBlockHash(
      prev.number + 1,
      prev.hash,
      ts,
      merkleRoot,
      1,
      null,
      changesHash,
    );
    const payload: IncomingBlockPayload = {
      number: prev.number + 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      validatorChanges: [change],
    };
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.accountId,
      localNodePublicKey: env.identity.publicKey,
    });
    const result = validateIncomingBlock(env.db, consensus, payload, env.accountId, env.identity.publicKey, {
      bftValidatorSet: env.set,
      skipBlockTimestampWindow: true,
    });
    assert.equal(result.valid, true, result.error);
  });

  it('validateIncomingBlock rejects a block hash computed WITHOUT the changes hash', () => {
    // Forgetful producer: built block hash with the legacy 6-arg form
    // but ships validator changes in the payload. The receiver re-
    // derives the changes hash, includes it in expected, and detects
    // the mismatch.
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);
    const change = makeRegisterChange(env.candidate, Math.floor(Date.now() / 1000));
    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prev = getLatestBlock(env.db)!;
    // Forget to include changes in the hash:
    const hash = computeBlockHash(prev.number + 1, prev.hash, ts, merkleRoot, 1, null);
    const payload: IncomingBlockPayload = {
      number: prev.number + 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      validatorChanges: [change], // ride the block but not committed in the hash
    };
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.accountId,
      localNodePublicKey: env.identity.publicKey,
    });
    const result = validateIncomingBlock(env.db, consensus, payload, env.accountId, env.identity.publicKey, {
      bftValidatorSet: env.set,
      skipBlockTimestampWindow: true,
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Block hash mismatch/);
  });

  it('validateIncomingBlock rejects a payload with swapped changes (set A committed, set B shipped)', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);

    // Producer would have committed to set A, but a tampering relay
    // swapped set B into the payload (without re-computing the block
    // hash — they CAN'T re-compute because they don't have the
    // proposer's signature).
    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prev = getLatestBlock(env.db)!;

    const setA = [makeRegisterChange(env.candidate, ts)];
    // Set B: a different signed change for a different account
    const candidateB = createFundedAccount(env.db, 500);
    const setB = [makeRegisterChange(candidateB, ts)];

    // Block hash bound to set A
    const hash = computeBlockHash(
      prev.number + 1,
      prev.hash,
      ts,
      merkleRoot,
      1,
      null,
      computeValidatorChangesHash(setA),
    );
    // Payload ships set B
    const payload: IncomingBlockPayload = {
      number: prev.number + 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      validatorChanges: setB,
    };
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.accountId,
      localNodePublicKey: env.identity.publicKey,
    });
    const result = validateIncomingBlock(env.db, consensus, payload, env.accountId, env.identity.publicKey, {
      bftValidatorSet: env.set,
      skipBlockTimestampWindow: true,
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Block hash mismatch/);
  });

  it('validateIncomingBlock rejects a payload with the changes DROPPED (committed to set, shipped empty)', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);
    const change = makeRegisterChange(env.candidate, Math.floor(Date.now() / 1000));
    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prev = getLatestBlock(env.db)!;

    // Producer committed to a non-empty changes list
    const hash = computeBlockHash(
      prev.number + 1,
      prev.hash,
      ts,
      merkleRoot,
      1,
      null,
      computeValidatorChangesHash([change]),
    );
    // Tampering relay drops the changes
    const payload: IncomingBlockPayload = {
      number: prev.number + 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      validatorChanges: [], // dropped
    };
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.accountId,
      localNodePublicKey: env.identity.publicKey,
    });
    const result = validateIncomingBlock(env.db, consensus, payload, env.accountId, env.identity.publicKey, {
      bftValidatorSet: env.set,
      skipBlockTimestampWindow: true,
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Block hash mismatch/);
  });

  it('reordering changes does NOT break the binding (computeValidatorChangesHash is order-independent)', () => {
    // This is documented behavior: changes are sorted by canonical
    // bytes inside computeValidatorChangesHash, so the producer and
    // every receiver agree on the hash regardless of how the list is
    // ordered in the payload.
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);
    const ca = makeRegisterChange(env.candidate, 1700000000);
    const candidateB = createFundedAccount(env.db, 500);
    const cb = makeRegisterChange(candidateB, 1700000001);

    const ts = Math.floor(Date.now() / 1000);
    const merkleRoot = computeMerkleRoot([]);
    const prev = getLatestBlock(env.db)!;

    // Producer commits to [ca, cb]
    const hash = computeBlockHash(
      prev.number + 1,
      prev.hash,
      ts,
      merkleRoot,
      1,
      null,
      computeValidatorChangesHash([ca, cb]),
    );
    // Payload ships [cb, ca] (reversed)
    const payload: IncomingBlockPayload = {
      number: prev.number + 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      validatorChanges: [cb, ca], // reversed order
    };
    const consensus = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.accountId,
      localNodePublicKey: env.identity.publicKey,
    });
    const result = validateIncomingBlock(env.db, consensus, payload, env.accountId, env.identity.publicKey, {
      bftValidatorSet: env.set,
      skipBlockTimestampWindow: true,
    });
    assert.equal(result.valid, true, `reorder should be tolerated: ${result.error}`);
  });
});
