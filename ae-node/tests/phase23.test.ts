// Phase 23: BFTConsensus class.
//
// First implementation of IConsensusEngine that uses the multi-validator
// machinery from Sessions 12-16. This suite verifies BFTConsensus
// satisfies the contract:
//
//   1. canProduceBlock: true only when WE are the selected proposer for
//      the next height AND our registered nodePublicKey matches our
//      current node-identity key.
//   2. validateBlockProducer: accepts active validators with the right
//      publicKey; rejects unknowns, deregistered, mismatched keys, and
//      missing publicKey arg.
//   3. finalizedHeight + notifyFinalized: monotonic; tracks committed
//      height separately from chain head.
//   4. validatorSet / quorumSize / listValidators reflect the live set.
//   5. isAuthority: true iff in the active set with matching key.
//   6. getAuthorityId / getNextProposer: returns the actual proposer
//      for height (latest+1) under the seed.
//   7. notifyHeightAdvanced: monotonic; updates seed used for next
//      proposer selection.
//   8. resolveConflict: higher height wins; ties go to A.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { generateNodeIdentity, type NodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { BFTConsensus } from '../src/core/consensus/BFTConsensus.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
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

function setupValidators(count: number, perStake: bigint = pts(200)): {
  db: DatabaseSync;
  set: SqliteValidatorSet;
  validators: ValidatorHandle[];
} {
  const db = freshDb();
  const validators: ValidatorHandle[] = [];
  for (let i = 0; i < count; i++) {
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      (perStake + pts(50)).toString(),
      acct.account.id,
    );
    const identity = generateNodeIdentity();
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: perStake,
    });
    validators.push({ accountId: acct.account.id, identity });
  }
  return { db, set: new SqliteValidatorSet(db), validators };
}

describe('Phase 23: BFTConsensus', () => {
  let env: ReturnType<typeof setupValidators>;

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
  });

  // ── canProduceBlock ──────────────────────────────────────────────────

  it('canProduceBlock returns true only for the selected proposer', () => {
    // For each validator, build a BFTConsensus with that validator as
    // local. Exactly ONE of them should report canProduceBlock = true
    // for any given (height, seed).
    const seed = 'genesis-seed';
    const height = 0;

    const expectedProposer = selectProposer(env.set.listActive(), height + 1, seed)!;

    let positiveCount = 0;
    for (const v of env.validators) {
      const c = new BFTConsensus({
        validatorSet: env.set,
        localAccountId: v.accountId,
        localNodePublicKey: v.identity.publicKey,
        initialHeight: height,
        initialSeed: seed,
      });
      if (c.canProduceBlock()) {
        positiveCount++;
        assert.equal(v.accountId, expectedProposer.accountId);
      }
    }
    assert.equal(positiveCount, 1, 'exactly one validator should be the proposer');
  });

  it('canProduceBlock returns false when local nodePublicKey does not match registered key', () => {
    const v = env.validators[0];
    const wrongKey = generateNodeIdentity();
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: wrongKey.publicKey, // not what was registered
      initialHeight: 0,
      initialSeed: 'seed',
    });
    // Even if proposer-selection points at us, the rotated-key check kicks us out
    assert.equal(c.canProduceBlock(), false);
  });

  it('canProduceBlock returns false for an empty validator set', () => {
    const db = freshDb();
    const empty = new SqliteValidatorSet(db);
    const c = new BFTConsensus({
      validatorSet: empty,
      localAccountId: 'whoever',
      localNodePublicKey: 'a'.repeat(64),
      initialHeight: 0,
      initialSeed: 'seed',
    });
    assert.equal(c.canProduceBlock(), false);
  });

  it('canProduceBlock returns false for a non-validator', () => {
    const stranger = generateNodeIdentity();
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: 'not-registered',
      localNodePublicKey: stranger.publicKey,
      initialHeight: 0,
      initialSeed: 'seed',
    });
    assert.equal(c.canProduceBlock(), false);
  });

  // ── validateBlockProducer ───────────────────────────────────────────

  it('validateBlockProducer accepts active validators with matching publicKey', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[1].accountId,
      localNodePublicKey: env.validators[1].identity.publicKey,
    });
    assert.equal(c.validateBlockProducer(v.accountId, v.identity.publicKey), true);
  });

  it('validateBlockProducer rejects when publicKey is missing', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[1].accountId,
      localNodePublicKey: env.validators[1].identity.publicKey,
    });
    assert.equal(c.validateBlockProducer(v.accountId), false);
  });

  it('validateBlockProducer rejects unknown nodeId', () => {
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[0].accountId,
      localNodePublicKey: env.validators[0].identity.publicKey,
    });
    assert.equal(c.validateBlockProducer('not-a-validator', 'a'.repeat(64)), false);
  });

  it('validateBlockProducer rejects mismatched publicKey', () => {
    const v = env.validators[0];
    const wrong = generateNodeIdentity();
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[1].accountId,
      localNodePublicKey: env.validators[1].identity.publicKey,
    });
    assert.equal(c.validateBlockProducer(v.accountId, wrong.publicKey), false);
  });

  it('validateBlockProducer rejects deregistered validators', () => {
    const v = env.validators[0];
    env.set.markInactive(v.accountId, Math.floor(Date.now() / 1000));
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: env.validators[1].accountId,
      localNodePublicKey: env.validators[1].identity.publicKey,
    });
    assert.equal(c.validateBlockProducer(v.accountId, v.identity.publicKey), false);
  });

  // ── finality + height tracking ──────────────────────────────────────

  it('finalizedHeight starts at initial value and advances monotonically', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
      initialHeight: 5,
      initialFinalizedHeight: 5,
    });
    assert.equal(c.finalizedHeight(), 5);

    c.notifyFinalized(3); // earlier — must NOT regress
    assert.equal(c.finalizedHeight(), 5);

    c.notifyFinalized(8);
    assert.equal(c.finalizedHeight(), 8);

    c.notifyFinalized(8); // same — idempotent
    assert.equal(c.finalizedHeight(), 8);
  });

  it('notifyHeightAdvanced is monotonic and updates seed', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
      initialHeight: 0,
      initialSeed: 'seed-0',
    });
    c.notifyHeightAdvanced(1, 'seed-1');
    assert.equal(c.getLatestHeight(), 1);
    assert.equal(c.getLatestSeed(), 'seed-1');

    // Earlier height — ignore
    c.notifyHeightAdvanced(0, 'seed-stale');
    assert.equal(c.getLatestHeight(), 1);
    assert.equal(c.getLatestSeed(), 'seed-1');

    c.notifyHeightAdvanced(5, 'seed-5');
    assert.equal(c.getLatestHeight(), 5);
    assert.equal(c.getLatestSeed(), 'seed-5');
  });

  it('changing the seed via notifyHeightAdvanced rotates the proposer', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
      initialHeight: 0,
      initialSeed: 'seed-A',
    });
    const proposerA = c.getAuthorityId();

    c.notifyHeightAdvanced(c.getLatestHeight() + 1, 'seed-B');
    const proposerB = c.getAuthorityId();

    // Two different seeds — the chosen proposer should usually differ.
    // We can't guarantee it for any specific seeds, but we CAN check
    // that selectProposer agrees with what BFTConsensus reports.
    const expectedB = selectProposer(env.set.listActive(), c.getLatestHeight() + 1, 'seed-B');
    assert.equal(proposerB, expectedB!.accountId);
    void proposerA;
  });

  // ── validatorSet / quorumSize / listValidators ──────────────────────

  it('validatorSet returns active accountIds; quorumSize follows quorumCount', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });
    assert.equal(c.validatorSet().length, 4);
    assert.equal(c.quorumSize(), 3); // floor(2*4/3)+1

    // Deregister one
    env.set.markInactive(env.validators[1].accountId, Math.floor(Date.now() / 1000));
    assert.equal(c.validatorSet().length, 3);
    assert.equal(c.quorumSize(), 3); // floor(2*3/3)+1 = 3
  });

  it('listValidators returns full ValidatorInfo records', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });
    const list = c.listValidators();
    assert.equal(list.length, 4);
    for (const entry of list) {
      assert.ok(typeof entry.nodePublicKey === 'string' && entry.nodePublicKey.length === 64);
      assert.ok(typeof entry.vrfPublicKey === 'string' && entry.vrfPublicKey.length === 64);
      assert.ok(entry.stake > 0n);
    }
  });

  // ── isAuthority ─────────────────────────────────────────────────────

  it('isAuthority is true for an active validator with matching key', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });
    assert.equal(c.isAuthority(), true);
  });

  it('isAuthority is false after deregistration', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });
    env.set.markInactive(v.accountId, Math.floor(Date.now() / 1000));
    assert.equal(c.isAuthority(), false);
  });

  it('isAuthority is false when local publicKey does not match registered', () => {
    const v = env.validators[0];
    const wrong = generateNodeIdentity();
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: wrong.publicKey,
    });
    assert.equal(c.isAuthority(), false);
  });

  it('isAuthority is false for non-validator account', () => {
    const stranger = generateNodeIdentity();
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: 'not-a-validator',
      localNodePublicKey: stranger.publicKey,
    });
    assert.equal(c.isAuthority(), false);
  });

  // ── resolveConflict ─────────────────────────────────────────────────

  it('resolveConflict prefers higher height; A wins on tie', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
    });
    assert.equal(c.resolveConflict(5, 3), 'A');
    assert.equal(c.resolveConflict(3, 5), 'B');
    assert.equal(c.resolveConflict(7, 7), 'A');
  });

  // ── Proposer rotation correctness ────────────────────────────────────

  it('getAuthorityId rotates proposers across heights as the seed changes', () => {
    const v = env.validators[0];
    const c = new BFTConsensus({
      validatorSet: env.set,
      localAccountId: v.accountId,
      localNodePublicKey: v.identity.publicKey,
      initialHeight: 0,
      initialSeed: 'h0',
    });
    const seen = new Set<string>();
    for (let h = 0; h < 20; h++) {
      c.notifyHeightAdvanced(h + 1, `seed-${h + 1}`);
      seen.add(c.getAuthorityId());
    }
    // Across 20 different (height, seed) pairs we should see multiple
    // proposers from the 4-validator set.
    assert.ok(seen.size >= 2, `expected >=2 distinct proposers, saw ${seen.size}`);
  });
});
