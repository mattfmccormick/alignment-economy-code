// State-root fingerprint: making node divergence detectable at all.
//
// Why this exists
// ---------------
// Blocks commit to their transactions via merkleRoot but never to the state
// those transactions produce. computeBlockHash covers number, previous hash,
// timestamp, merkle root, day, parent cert and validator changes — no balance
// or account commitment anywhere.
//
// So two nodes could disagree about every balance on the network and nothing
// would say so. Balance drift surfaced only indirectly, as a
// `Replay: insufficient <type> balance` throw the first time a divergent
// account happened to overspend what the lagging node thought it had.
// percentHuman drift produced no error whatsoever, ever, because
// replayTransaction takes netAmount off the wire verbatim and never re-derives
// the spend multiplier locally — nodes silently converged on the proposer's
// arithmetic while holding different views of who was verified.
//
// The two tests that matter most here are the percentHuman one and the
// dev-bump one: both are states that used to be completely invisible.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import {
  createAccount,
  updateBalance,
  updatePercentHuman,
  accountStore,
  applyPeerAccountRegistration,
} from '../src/core/account.js';
import { computeStateRoot } from '../src/core/state-root.js';
import { generateKeyPair } from '../src/core/crypto.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('state root', () => {
  let a: DatabaseSync;
  let b: DatabaseSync;

  beforeEach(() => {
    a = freshDb();
    b = freshDb();
  });

  it('two empty ledgers agree', () => {
    assert.equal(computeStateRoot(a), computeStateRoot(b));
  });

  it('is stable across repeated calls', () => {
    const kp = generateKeyPair();
    createAccount(a, 'individual', 1, 0, kp.publicKey);
    assert.equal(computeStateRoot(a), computeStateRoot(a));
  });

  it('two nodes holding identical accounts agree', () => {
    const kps = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    for (const kp of kps) {
      const created = createAccount(a, 'individual', 1, 0, kp.publicKey);
      applyPeerAccountRegistration(accountStore(b), {
        id: created.account.id,
        publicKey: created.account.publicKey,
        type: created.account.type,
        joinedDay: created.account.joinedDay,
        createdAt: created.account.createdAt,
      });
    }
    assert.equal(computeStateRoot(a), computeStateRoot(b));
  });

  it('does not depend on the order accounts were inserted', () => {
    // Nodes learn about accounts in whatever order gossip delivers them. If
    // the digest depended on insertion order, honest nodes would disagree
    // constantly and the check would be worse than useless.
    const kps = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const made = kps.map((kp) => createAccount(a, 'individual', 1, 0, kp.publicKey).account);

    for (const acct of [...made].reverse()) {
      applyPeerAccountRegistration(accountStore(b), {
        id: acct.id,
        publicKey: acct.publicKey,
        type: acct.type,
        joinedDay: acct.joinedDay,
        createdAt: acct.createdAt,
      });
    }
    assert.equal(computeStateRoot(a), computeStateRoot(b));
  });

  it('ignores locally-set fields that honest nodes legitimately differ on', () => {
    // A replicated account carries the origin node's createdAt. If the digest
    // covered it, every honest pair would diverge the moment they replicated
    // anything.
    const kp = generateKeyPair();
    const created = createAccount(a, 'individual', 1, 0, kp.publicKey);
    applyPeerAccountRegistration(accountStore(b), {
      id: created.account.id,
      publicKey: created.account.publicKey,
      type: created.account.type,
      joinedDay: created.account.joinedDay,
      createdAt: created.account.createdAt + 9999,
    });
    assert.equal(computeStateRoot(a), computeStateRoot(b));
  });

  // ── the cases that were previously invisible ─────────────────────────

  it('catches a balance disagreement', () => {
    const kp = generateKeyPair();
    const id = createAccount(a, 'individual', 1, 0, kp.publicKey).account.id;
    applyPeerAccountRegistration(accountStore(b), {
      id,
      publicKey: kp.publicKey,
      type: 'individual',
      joinedDay: 1,
      createdAt: 1786890000,
    });
    assert.equal(computeStateRoot(a), computeStateRoot(b), 'precondition: they agree');

    updateBalance(a, id, 'earned_balance', 500_00000000n);
    assert.notEqual(computeStateRoot(a), computeStateRoot(b));
  });

  it('catches a percentHuman disagreement, which nothing else ever could', () => {
    // replayTransaction takes netAmount off the wire and never re-derives the
    // spend multiplier, so this divergence produced no error at any point in
    // the protocol. It is exactly what dev-bump-ph.mjs creates when run on one
    // node of a network and not the others.
    const kp = generateKeyPair();
    const id = createAccount(a, 'individual', 1, 0, kp.publicKey).account.id;
    applyPeerAccountRegistration(accountStore(b), {
      id,
      publicKey: kp.publicKey,
      type: 'individual',
      joinedDay: 1,
      createdAt: 1786890000,
    });
    assert.equal(computeStateRoot(a), computeStateRoot(b));

    updatePercentHuman(a, id, 100);

    assert.notEqual(
      computeStateRoot(a),
      computeStateRoot(b),
      'percentHuman divergence must be visible',
    );
  });

  it('catches an account that exists on only one node', () => {
    const kp = generateKeyPair();
    createAccount(a, 'individual', 1, 0, kp.publicKey);
    assert.notEqual(computeStateRoot(a), computeStateRoot(b));
  });

  it('reconverges once the missing account is replicated', () => {
    const kp = generateKeyPair();
    const created = createAccount(a, 'individual', 1, 0, kp.publicKey);
    assert.notEqual(computeStateRoot(a), computeStateRoot(b));

    applyPeerAccountRegistration(accountStore(b), {
      id: created.account.id,
      publicKey: created.account.publicKey,
      type: created.account.type,
      joinedDay: created.account.joinedDay,
      createdAt: created.account.createdAt,
    });
    assert.equal(computeStateRoot(a), computeStateRoot(b));
  });

  it('does not lose precision on balances above 2^53', () => {
    // Balances are stored as TEXT and hashed as TEXT. Routing them through
    // Number would collapse distinct large values onto the same digest, which
    // would hide divergence in exactly the accounts where it matters most.
    const kp = generateKeyPair();
    const id = createAccount(a, 'individual', 1, 0, kp.publicKey).account.id;
    const kpB = kp;
    const idB = createAccount(b, 'individual', 1, 0, kpB.publicKey).account.id;
    assert.equal(id, idB);

    updateBalance(a, id, 'earned_balance', 9007199254740993n); // 2^53 + 1
    updateBalance(b, idB, 'earned_balance', 9007199254740992n); // 2^53

    assert.notEqual(computeStateRoot(a), computeStateRoot(b));
  });
});
