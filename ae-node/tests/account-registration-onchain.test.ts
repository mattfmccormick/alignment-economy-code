// Account registrations carried by a block.
//
// Why this exists
// ---------------
// Gossip (`new_account`) closed the live half of account replication: a node
// that is online when an account is created learns about it within a round
// trip. It did not close the offline half. A node that is down at that moment
// and later catches up by syncing blocks still has no row, because ChainSync
// ships blocks and certs only — so it fail-stops on the first block that
// references the account, and the chain halts.
//
// Putting registrations in the block closes it: a node syncing months later
// replays them from the chain like any other state change.
//
// The backward-compatibility test at the bottom is the one that protects an
// existing network. computeBlockHash appends the registrations hash and treats
// absent as empty, so every block ever committed keeps exactly the digest it
// had. Break that and every historical block fails verification on upgrade,
// which would strand a running chain.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { computeBlockHash, blockStore } from '../src/core/block.js';
import { getAccount, createAccount } from '../src/core/account.js';
import {
  applyAccountRegistration,
  computeAccountRegistrationsHash,
  queueAccountRegistration,
  drainAccountRegistrations,
  removeAppliedAccountRegistrations,
  type AccountRegistration,
} from '../src/core/account-registration.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import type { Block } from '../src/core/types.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function regFor(kp: { publicKey: string }): AccountRegistration {
  return {
    accountId: deriveAccountId(kp.publicKey),
    publicKey: kp.publicKey,
    type: 'individual',
    joinedDay: 1,
  };
}

describe('on-chain account registrations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = freshDb();
  });

  // ── hashing ──────────────────────────────────────────────────────────

  it('hash is order-independent', () => {
    // Two proposers can drain their queues in a different order and must still
    // produce the same block hash.
    const a = regFor(generateKeyPair());
    const b = regFor(generateKeyPair());
    assert.equal(
      computeAccountRegistrationsHash([a, b]),
      computeAccountRegistrationsHash([b, a]),
    );
  });

  it('hash changes when an entry is dropped or altered', () => {
    const a = regFor(generateKeyPair());
    const b = regFor(generateKeyPair());
    const both = computeAccountRegistrationsHash([a, b]);

    assert.notEqual(both, computeAccountRegistrationsHash([a]));
    assert.notEqual(
      both,
      computeAccountRegistrationsHash([a, { ...b, type: 'company' }]),
    );
    assert.notEqual(
      both,
      computeAccountRegistrationsHash([a, { ...b, joinedDay: 99 }]),
    );
  });

  // ── the backward-compatibility guarantee ─────────────────────────────

  it('a block carrying no registrations hashes exactly as it did before', () => {
    // This is what lets an existing chain upgrade in place. If appending the
    // new part changed the digest for blocks that carry nothing, every
    // historical block would fail verification the moment a node upgraded.
    const args = [7, 'a'.repeat(64), 1786890000, 'b'.repeat(64), 3] as const;

    const legacy = computeBlockHash(...args);
    assert.equal(computeBlockHash(...args, null, null), legacy);
    assert.equal(computeBlockHash(...args, null, null, null), legacy);

    // And a block that DOES carry registrations must differ.
    const withRegs = computeBlockHash(
      ...args,
      null,
      null,
      computeAccountRegistrationsHash([regFor(generateKeyPair())]),
    );
    assert.notEqual(withRegs, legacy);
  });

  // ── applying ─────────────────────────────────────────────────────────

  it('applies a registration and stamps createdAt from the block timestamp', () => {
    // Not the local clock: every node must write the same value, or nodes
    // would differ on a field for no reason.
    const reg = regFor(generateKeyPair());
    const blockTs = 1786890000;

    assert.equal(applyAccountRegistration(db, reg, blockTs), true);
    const acct = getAccount(db, reg.accountId)!;
    assert.equal(acct.createdAt, blockTs);
    assert.equal(acct.percentHuman, 0);
    assert.equal(acct.earnedBalance, 0n);
  });

  it('is idempotent, so replaying a block twice is safe', () => {
    // Sync and the live commit path can both deliver the same block, and
    // resumeCycle can re-enter after a crash.
    const reg = regFor(generateKeyPair());
    assert.equal(applyAccountRegistration(db, reg, 1786890000), true);
    assert.equal(applyAccountRegistration(db, reg, 1786890000), false);
    assert.equal(applyAccountRegistration(db, reg, 1786899999), false);
    assert.equal(getAccount(db, reg.accountId)!.createdAt, 1786890000);
  });

  it('rejects a registration whose id does not match its public key', () => {
    const kp = generateKeyPair();
    assert.throws(
      () =>
        applyAccountRegistration(
          db,
          { accountId: 'ff'.repeat(20), publicKey: kp.publicKey, type: 'individual', joinedDay: 1 },
          1786890000,
        ),
      /does not match its public key/,
    );
  });

  // ── the proposer queue ───────────────────────────────────────────────

  it('queues, drains in FIFO order, and removes once applied', () => {
    const first = regFor(generateKeyPair());
    const second = regFor(generateKeyPair());
    queueAccountRegistration(db, first);
    queueAccountRegistration(db, second);

    const drained = drainAccountRegistrations(db);
    assert.equal(drained.length, 2);
    assert.deepEqual(drained.map((r) => r.accountId), [first.accountId, second.accountId]);

    assert.equal(removeAppliedAccountRegistrations(db, drained), 2);
    assert.equal(drainAccountRegistrations(db).length, 0);
  });

  it('removing entries this node never queued is a harmless no-op', () => {
    // Every node runs the drain callback after a commit, but only the proposer
    // had rows to remove.
    assert.equal(removeAppliedAccountRegistrations(db, [regFor(generateKeyPair())]), 0);
  });

  it('refuses to queue a registration with a mismatched id', () => {
    // A bad entry here would become a block no honest node can apply.
    const kp = generateKeyPair();
    assert.throws(
      () =>
        queueAccountRegistration(db, {
          accountId: 'ab'.repeat(20),
          publicKey: kp.publicKey,
          type: 'individual',
          joinedDay: 1,
        }),
      /does not match its public key/,
    );
    assert.equal(drainAccountRegistrations(db).length, 0);
  });

  // ── persistence, which is what makes catch-up work ───────────────────

  it('round-trips registrations through block storage', () => {
    // A node serving sync replies has to ship what it stored. If the column
    // did not survive the round trip, a late joiner would receive blocks with
    // the registrations silently stripped and be right back where it started.
    const store = blockStore(db);
    const genesis: Block = {
      number: 0, day: 0, timestamp: 1786890000, previousHash: '0'.repeat(64),
      hash: 'g'.repeat(64), merkleRoot: 'm'.repeat(64), transactionCount: 0,
      rebaseEvent: null, prevCommitCertHash: null, validatorChanges: null,
      accountRegistrations: null,
    };
    store.insert(genesis, true);

    const regs = [regFor(generateKeyPair()), regFor(generateKeyPair())];
    const block: Block = {
      number: 1, day: 1, timestamp: 1786890060, previousHash: genesis.hash,
      hash: 'h'.repeat(64), merkleRoot: 'n'.repeat(64), transactionCount: 0,
      rebaseEvent: null, prevCommitCertHash: null, validatorChanges: null,
      accountRegistrations: regs,
    };
    store.insert(block, false);

    const read = store.findByNumber(1)!;
    assert.deepEqual(read.accountRegistrations, regs);
    assert.equal(store.findByNumber(0)!.accountRegistrations, null);
  });

  // ── the property that matters ────────────────────────────────────────

  it('lets a node that was offline learn an account purely from the block', () => {
    // The scenario: node A creates an account while node B is down. B comes
    // back and syncs. Before on-chain registrations there was no path for B to
    // ever learn about it, and the first block referencing it halted B.
    const nodeA = freshDb();
    const nodeB = freshDb();

    const kp = generateKeyPair();
    const created = createAccount(nodeA, 'individual', 1, 0, kp.publicKey);
    assert.equal(getAccount(nodeB, created.account.id), null, 'B was offline and missed it');

    // B replays the block that carried the registration.
    const reg: AccountRegistration = {
      accountId: created.account.id,
      publicKey: created.account.publicKey,
      type: created.account.type,
      joinedDay: created.account.joinedDay,
    };
    applyAccountRegistration(nodeB, reg, 1786890000);

    assert.ok(getAccount(nodeB, created.account.id), 'B now knows the account');
    assert.equal(getAccount(nodeB, created.account.id)!.publicKey, created.account.publicKey);
  });
});
