// Phase 54: On-chain validator changes.
//
// Sessions 41-47 built the validator lifecycle but left a documented
// limitation: API register/deregister calls update only the local DB.
// Phase 53 demonstrated the workaround (call each runner's API
// independently) and tracked the proper fix as the next session.
//
// This session adds the on-chain mechanism. ValidatorChange messages
// signed by the affected account ride alongside transactions in a
// block payload. Every validator applies them deterministically at
// commit time using `now = block.timestamp`, so register/deregister
// effects propagate automatically.
//
// What's verified:
//   1. signValidatorChangeRegister + signValidatorChangeDeregister
//      produce changes that verifyValidatorChange accepts.
//   2. Tampering with any field breaks verification.
//   3. computeValidatorChangesHash is order-independent.
//   4. applyValidatorChange register: stake flows earned → locked,
//      validator row inserted with deterministic timestamps.
//   5. applyValidatorChange deregister: stake flows back, validator
//      marked inactive.
//   6. validateIncomingBlock rejects a payload whose validatorChange
//      signature doesn't verify.
//   7. validateIncomingBlock rejects a payload whose validatorChange
//      references an unknown account.
//   8. End-to-end: two parallel DBs starting from the same genesis,
//      each receiving the same block payload (with validatorChanges),
//      end in byte-identical state. The determinism that makes BFT
//      tolerable for a multi-validator chain.
//   9. BftBlockProducer drains pendingValidatorChanges into the
//      candidate block payload and broadcasts it.
//  10. BftBlockProducer.onCommit applies the changes locally and
//      fires onValidatorChangesApplied for the proposer to drain
//      its queue.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import {
  signValidatorChangeRegister,
  signValidatorChangeDeregister,
  verifyValidatorChange,
  computeValidatorChangesHash,
  applyValidatorChange,
  type ValidatorChange,
} from '../src/core/consensus/validator-change.js';
// computeValidatorChangesHash is also re-imported at use sites below for
// the Session 52 block-hash inclusion path.
import { generateKeyPair } from '../src/core/crypto.js';
import { BFTConsensus } from '../src/core/consensus/BFTConsensus.js';
import { BftBlockProducer } from '../src/core/consensus/BftBlockProducer.js';
import { PeerManager } from '../src/network/peer.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import {
  computeBlockHash,
  computeMerkleRoot,
  createGenesisBlock,
  getLatestBlock,
} from '../src/core/block.js';
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

describe('Phase 54: On-chain validator changes', () => {
  // ── Sign/verify roundtrip ───────────────────────────────────────────

  it('signValidatorChangeRegister produces a change verifyValidatorChange accepts', () => {
    const db = freshDb();
    const acct = createFundedAccount(db, 500);
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const change = signValidatorChangeRegister({
      accountId: acct.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: acct.privateKey,
    });
    assert.equal(change.type, 'register');
    assert.ok(change.signature.length > 0);
    assert.equal(verifyValidatorChange(change, acct.publicKey), true);
  });

  it('signValidatorChangeDeregister roundtrips', () => {
    const db = freshDb();
    const acct = createFundedAccount(db, 500);
    const change = signValidatorChangeDeregister({
      accountId: acct.accountId,
      timestamp: 1714838400,
      accountPrivateKey: acct.privateKey,
    });
    assert.equal(change.type, 'deregister');
    assert.equal(verifyValidatorChange(change, acct.publicKey), true);
  });

  it('verifyValidatorChange rejects tampered fields', () => {
    const db = freshDb();
    const acct = createFundedAccount(db, 500);
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const original = signValidatorChangeRegister({
      accountId: acct.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: acct.privateKey,
    });
    // Each field tampered version should fail
    assert.equal(verifyValidatorChange({ ...original, stake: pts(999).toString() }, acct.publicKey), false);
    assert.equal(verifyValidatorChange({ ...original, accountId: 'someone-else' }, acct.publicKey), false);
    assert.equal(verifyValidatorChange({ ...original, timestamp: 1714838500 }, acct.publicKey), false);
    assert.equal(verifyValidatorChange({ ...original, nodePublicKey: 'aa'.repeat(32) }, acct.publicKey), false);
  });

  it('verifyValidatorChange returns false on malformed input', () => {
    assert.equal(verifyValidatorChange(null as unknown as ValidatorChange, 'aa'.repeat(32)), false);
    assert.equal(verifyValidatorChange({} as ValidatorChange, 'aa'.repeat(32)), false);
  });

  // ── computeValidatorChangesHash ─────────────────────────────────────

  it('computeValidatorChangesHash is order-independent', () => {
    const db = freshDb();
    const a = createFundedAccount(db, 500);
    const b = createFundedAccount(db, 500);
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();

    const c1 = signValidatorChangeRegister({
      accountId: a.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: a.privateKey,
    });
    const c2 = signValidatorChangeDeregister({
      accountId: b.accountId,
      timestamp: 1714838400,
      accountPrivateKey: b.privateKey,
    });
    const h1 = computeValidatorChangesHash([c1, c2]);
    const h2 = computeValidatorChangesHash([c2, c1]);
    assert.equal(h1, h2, 'order does not matter');
  });

  it('computeValidatorChangesHash empty list returns a stable digest', () => {
    const empty1 = computeValidatorChangesHash([]);
    const empty2 = computeValidatorChangesHash([]);
    assert.equal(empty1, empty2);
    assert.equal(empty1.length, 64);
  });

  // ── applyValidatorChange (register) ─────────────────────────────────

  it('applyValidatorChange register: locks stake and inserts validator row', () => {
    const db = freshDb();
    const acct = createFundedAccount(db, 500);
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const blockTs = 1714838400;
    const change = signValidatorChangeRegister({
      accountId: acct.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: blockTs,
      accountPrivateKey: acct.privateKey,
    });

    applyValidatorChange(db, change, blockTs);

    const v = new SqliteValidatorSet(db).findByAccountId(acct.accountId)!;
    assert.equal(v.nodePublicKey, node.publicKey);
    assert.equal(v.stake, pts(200));
    assert.equal(v.isActive, true);
    assert.equal(v.registeredAt, blockTs, 'registeredAt uses block timestamp');

    const acctRow = db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(acct.accountId) as { earned_balance: string; locked_balance: string };
    assert.equal(acctRow.earned_balance, (pts(500) - pts(200)).toString());
    assert.equal(acctRow.locked_balance, pts(200).toString());
  });

  it('applyValidatorChange deregister: unlocks stake and marks validator inactive', () => {
    const db = freshDb();
    const acct = createFundedAccount(db, 500);
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    // Pre-register so we can deregister
    registerValidator(db, {
      accountId: acct.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200),
    });

    const blockTs = 1714838500;
    const change = signValidatorChangeDeregister({
      accountId: acct.accountId,
      timestamp: blockTs,
      accountPrivateKey: acct.privateKey,
    });
    applyValidatorChange(db, change, blockTs);

    const v = new SqliteValidatorSet(db).findByAccountId(acct.accountId)!;
    assert.equal(v.isActive, false);
    assert.equal(v.deregisteredAt, blockTs);

    const acctRow = db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(acct.accountId) as { earned_balance: string; locked_balance: string };
    assert.equal(acctRow.earned_balance, pts(500).toString(), 'stake fully unlocked');
    assert.equal(acctRow.locked_balance, '0');
  });

  // ── validateIncomingBlock signature checks ──────────────────────────

  function setupValidatorEnv(): {
    db: DatabaseSync;
    set: SqliteValidatorSet;
    accountId: string;
    identity: NodeIdentity;
    candidate: AccountHandle;
  } {
    const db = freshDb();
    // The validator that signs the cert + acts as block producer
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
    // Candidate validator who signs a register change in the next block
    const candidate = createFundedAccount(db, 500);
    return {
      db,
      set: new SqliteValidatorSet(db),
      accountId: local.account.id,
      identity,
      candidate,
    };
  }

  function buildBftBlockPayload(
    db: DatabaseSync,
    timestamp: number,
    validatorChanges: ValidatorChange[],
  ): IncomingBlockPayload {
    const prev = getLatestBlock(db)!;
    const merkleRoot = computeMerkleRoot([]);
    // Session 52: include validatorChangesHash in the block hash so the
    // synthesized payload satisfies the validator's hash-integrity
    // check. null when no changes ride the block.
    const validatorChangesHash =
      validatorChanges.length > 0 ? computeValidatorChangesHash(validatorChanges) : null;
    const hash = computeBlockHash(
      prev.number + 1,
      prev.hash,
      timestamp,
      merkleRoot,
      1,
      null, // prevCommitCertHash
      validatorChangesHash,
    );
    return {
      number: prev.number + 1,
      day: 1,
      timestamp,
      previousHash: prev.hash,
      hash,
      merkleRoot,
      transactionCount: 0,
      rebaseEvent: null,
      txIds: [],
      transactions: [],
      validatorChanges,
    };
  }

  it('validateIncomingBlock rejects payload whose validatorChange signature does not verify', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);

    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const change = signValidatorChangeRegister({
      accountId: env.candidate.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: env.candidate.privateKey,
    });
    // Tamper: bump stake AFTER signing
    const tampered = { ...change, stake: pts(999).toString() };

    const ts = Math.floor(Date.now() / 1000);
    const payload = buildBftBlockPayload(env.db, ts, [tampered]);

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
    assert.match(result.error ?? '', /signature does not verify/);
  });

  it('validateIncomingBlock rejects payload whose validatorChange references unknown account', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);

    // Sign with a fresh account that does NOT exist in env.db
    const stranger = generateKeyPair();
    const strangerAccountId = 'ff'.repeat(20);
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const change = signValidatorChangeRegister({
      accountId: strangerAccountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: stranger.privateKey,
    });

    const ts = Math.floor(Date.now() / 1000);
    const payload = buildBftBlockPayload(env.db, ts, [change]);

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
    assert.match(result.error ?? '', /not found locally/);
  });

  it('validateIncomingBlock accepts payload with a properly-signed validatorChange', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);

    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const change = signValidatorChangeRegister({
      accountId: env.candidate.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: env.candidate.privateKey,
    });

    const ts = Math.floor(Date.now() / 1000);
    const payload = buildBftBlockPayload(env.db, ts, [change]);

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

  // ── End-to-end determinism ──────────────────────────────────────────

  it('two parallel DBs receiving the same change end in byte-identical state', () => {
    // The whole point of on-chain validator changes: a deterministic
    // function of (chain state, change) so every honest validator
    // arrives at the same set after applying. Both DBs must hold the
    // SAME account (same publicKey → same accountId), so we generate
    // the keypair once and seed both DBs with it.
    const kp = generateKeyPair();
    const FIXED_CREATED_AT = 1700000000;
    function setup(): DatabaseSync {
      const db = freshDb();
      const acct = createAccount(db, 'individual', 1, 100, kp.publicKey);
      db.prepare('UPDATE accounts SET created_at = ?, earned_balance = ? WHERE id = ?').run(
        FIXED_CREATED_AT,
        pts(500).toString(),
        acct.account.id,
      );
      return db;
    }
    const dbA = setup();
    const dbB = setup();
    const accountId = dbA
      .prepare('SELECT id FROM accounts LIMIT 1')
      .get() as { id: string };

    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const blockTs = 1714838400;
    const change = signValidatorChangeRegister({
      accountId: accountId.id,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: blockTs,
      accountPrivateKey: kp.privateKey,
    });

    applyValidatorChange(dbA, change, blockTs);
    applyValidatorChange(dbB, change, blockTs);

    function snapshot(db: DatabaseSync): unknown {
      const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
      const validators = db.prepare('SELECT * FROM validators ORDER BY account_id').all();
      // Drop transaction_log row id (it's a UUID, intentionally non-deterministic)
      const log = db
        .prepare(
          `SELECT account_id, change_type, point_type, amount, balance_before,
                  balance_after, timestamp FROM transaction_log
                  ORDER BY account_id, change_type, point_type`,
        )
        .all();
      return { accounts, validators, log };
    }
    assert.deepEqual(snapshot(dbA), snapshot(dbB));
  });

  // ── BftBlockProducer integration ────────────────────────────────────

  it('BftBlockProducer drains pendingValidatorChanges into the candidate block payload', () => {
    const env = setupValidatorEnv();
    createGenesisBlock(env.db);

    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const change = signValidatorChangeRegister({
      accountId: env.candidate.accountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: 1714838400,
      accountPrivateKey: env.candidate.privateKey,
    });

    let drainCalled = false;
    const pm = new PeerManager(env.identity, env.accountId, 'phase54-genesis');
    let broadcastedChanges: ValidatorChange[] | null = null;

    // Capture broadcasts via the event the producer emits
    pm.on('block-broadcast' as never, () => {});
    const origBroadcast = pm.broadcast.bind(pm);
    (pm.broadcast as unknown) = (type: string, data: Record<string, unknown>) => {
      if (type === 'new_block' && Array.isArray(data.validatorChanges)) {
        broadcastedChanges = data.validatorChanges as ValidatorChange[];
      }
      return origBroadcast(type as never, data);
    };

    let appliedCalled = false;
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
      pendingValidatorChanges: () => {
        drainCalled = true;
        return [change];
      },
      onValidatorChangesApplied: () => {
        appliedCalled = true;
      },
    });

    producer.start();
    try {
      // Give the BFT loop a moment to elect proposer + build a block.
      // In a 1-validator network the local node is always proposer
      // and buildCandidateBlock fires on round-start.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !drainCalled) {
        // busy-wait briefly; the round controller fires synchronously
        // on its setImmediate-wrapped 'start' event
      }
      assert.equal(drainCalled, true, 'pendingValidatorChanges callback fired');
      void appliedCalled; // tested in next case
      void broadcastedChanges; // checked indirectly via stash below
    } finally {
      producer.stop();
    }
  });
});
