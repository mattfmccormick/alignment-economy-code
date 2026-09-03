// Two nodes replaying the same transaction reach byte-identical state.
//
// This is the property every determinism guarantee in the system rests on: a
// transaction accepted by the network must move every node's balances the same
// way, so all nodes agree on the state root. The 3-validator LAN test proves it
// end-to-end, but that test is slow and not in CI. This pins the same property
// at the unit level, fast, by replaying one wire transaction through two
// independent databases and asserting their state roots match.
//
// It is the positive counterpart to state-root.test.ts, which proves the root
// DETECTS a disagreement; this proves the apply path does not CREATE one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { processTransaction, replayTransaction, type ReplayInput } from '../src/core/transaction.js';
import { computeStateRoot } from '../src/core/state-root.js';
import { signPayload, generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import { PRECISION } from '../src/core/constants.js';

interface Party {
  id: string;
  pub: string;
  priv: string;
}

/** A node database seeded with the same two accounts, funded identically. */
function seededNode(alicePub: string, bobPub: string, aliceEarned: bigint): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  const a = createAccount(db, 'individual', 1, 100, alicePub);
  createAccount(db, 'individual', 1, 100, bobPub);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    aliceEarned.toString(),
    a.account.id,
  );
  return db;
}

/**
 * Build a real, signed transaction and return the wire form a follower would
 * replay. Produced on a throwaway "origin" node exactly as processTransaction
 * does, so fee/netAmount are the real derived values, not hand-picked ones.
 */
function makeWireTx(
  alice: Party,
  bob: Party,
  amountPts: number,
  aliceEarned: bigint,
  timestamp = 1_700_000_500,
): ReplayInput {
  const origin = seededNode(alice.pub, bob.pub, aliceEarned);
  const amount = BigInt(amountPts) * PRECISION;
  const payload = {
    from: alice.id,
    to: bob.id,
    amount: amount.toString(),
    pointType: 'earned' as const,
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
  };
  const signature = signPayload(payload, timestamp, alice.priv);
  const { transaction: tx } = processTransaction(origin, {
    from: alice.id,
    to: bob.id,
    amount,
    pointType: 'earned',
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
    timestamp,
    signature,
  });
  origin.close();
  return {
    id: tx.id,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    netAmount: tx.netAmount,
    pointType: tx.pointType,
    isInPerson: tx.isInPerson,
    recipientIsHuman: tx.recipientIsHuman,
    memo: tx.memo,
    signature: tx.signature,
    receiverSignature: null,
    timestamp: tx.timestamp,
  };
}

function parties(): { alice: Party; bob: Party } {
  // Fresh keys each run; the same keypair is used to seed BOTH node databases,
  // so the account ids are identical across nodes (what makes their state roots
  // comparable).
  const a = generateKeyPair();
  const b = generateKeyPair();
  return {
    alice: { id: deriveAccountId(a.publicKey), pub: a.publicKey, priv: a.privateKey },
    bob: { id: deriveAccountId(b.publicKey), pub: b.publicKey, priv: b.privateKey },
  };
}

describe('transaction replay is deterministic across nodes', () => {
  it('two nodes replaying the same transaction reach identical state roots', () => {
    const { alice, bob } = parties();
    const aliceEarned = 1000n * PRECISION;
    const wire = makeWireTx(alice, bob, 10, aliceEarned);

    const nodeA = seededNode(alice.pub, bob.pub, aliceEarned);
    const nodeB = seededNode(alice.pub, bob.pub, aliceEarned);

    // Precondition: identical starting state.
    assert.equal(computeStateRoot(nodeA), computeStateRoot(nodeB));

    replayTransaction(nodeA, wire, 1);
    replayTransaction(nodeB, wire, 1);

    // The whole point: same transaction, same resulting state, everywhere.
    assert.equal(
      computeStateRoot(nodeA),
      computeStateRoot(nodeB),
      'two nodes that applied the same transaction must agree on the state root',
    );
    // And the actual balances match, not just the digest.
    const bobA = getAccount(nodeA, bob.id)!;
    const bobB = getAccount(nodeB, bob.id)!;
    assert.equal(bobA.earnedBalance, bobB.earnedBalance);
    assert.ok(bobA.earnedBalance > 0n, 'recipient was actually credited');

    nodeA.close();
    nodeB.close();
  });

  it('a sequence of transactions in the same order converges', () => {
    const { alice, bob } = parties();
    const aliceEarned = 1000n * PRECISION;

    const nodeA = seededNode(alice.pub, bob.pub, aliceEarned);
    const nodeB = seededNode(alice.pub, bob.pub, aliceEarned);

    // Five distinct transfers (distinct timestamps -> distinct ids). Node B
    // even applies them in a different call order within each "block" to make
    // sure per-transaction application is order-independent for independent
    // txs... but to keep it a fair determinism test we apply the SAME order,
    // since consensus fixes the order. Divergence here would mean the apply
    // itself is nondeterministic.
    const wires: ReplayInput[] = [];
    for (let i = 0; i < 5; i++) {
      // Distinct timestamp -> distinct signed bytes -> distinct id, each
      // properly signed (replayTransaction re-verifies the signature).
      wires.push(makeWireTx(alice, bob, 3, aliceEarned, 1_700_000_500 + i));
    }

    for (const w of wires) {
      replayTransaction(nodeA, w, 1);
      replayTransaction(nodeB, w, 1);
    }

    assert.equal(computeStateRoot(nodeA), computeStateRoot(nodeB));
    nodeA.close();
    nodeB.close();
  });

  it('replaying the same transaction twice on one node is a no-op (idempotent)', () => {
    // A block-replay arriving after gossip already applied the tx must not move
    // the money twice, or a node that saw both paths would diverge from one
    // that saw only one.
    const { alice, bob } = parties();
    const aliceEarned = 1000n * PRECISION;
    const wire = makeWireTx(alice, bob, 10, aliceEarned);

    const node = seededNode(alice.pub, bob.pub, aliceEarned);
    replayTransaction(node, wire, 1);
    const rootOnce = computeStateRoot(node);
    replayTransaction(node, wire, 1); // second delivery
    const rootTwice = computeStateRoot(node);

    assert.equal(rootOnce, rootTwice, 'a re-delivered transaction must not change state');
    node.close();
  });
});
