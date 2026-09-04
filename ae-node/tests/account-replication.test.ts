// Account replication across nodes.
//
// Why this exists
// ---------------
// `createAccount` was reachable from exactly two places: POST /accounts and
// the seed script. Both did a plain local INSERT. There was no gossip, no
// mempool entry, and no account transaction type, so an account existed only
// on the node whose API created it.
//
// On a single node that is invisible. On a multi-validator network it is fatal:
// every validator replays every block against its own state, and
// replayTransaction throws `Replay: sender account not found` when the row is
// missing. Before the fail-stop landed that throw unwound into a raw
// ws.on('message') handler and killed the node; after it, the node halts. Both
// mean the chain stops the first time anyone sends points between machines.
//
// These tests cover the replication primitive: idempotency, id forgery
// resistance, what a peer is and is not allowed to set, and the end-to-end
// property that matters — a replicated account makes a previously-fatal replay
// succeed.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import {
  accountStore,
  applyPeerAccountRegistration,
  createAccount,
  getAccount,
  updateBalance,
} from '../src/core/account.js';
import { replayTransaction, calculateFee } from '../src/core/transaction.js';
import { generateKeyPair, deriveAccountId, signPayload } from '../src/core/crypto.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('account replication between nodes', () => {
  let nodeA: DatabaseSync;
  let nodeB: DatabaseSync;

  beforeEach(() => {
    nodeA = freshDb();
    nodeB = freshDb();
  });

  it('replicates an account created on one node to another', () => {
    const kp = generateKeyPair();
    const created = createAccount(nodeA, 'individual', 1, 0, kp.publicKey);

    assert.equal(getAccount(nodeB, created.account.id), null, 'precondition: B has not seen it');

    const written = applyPeerAccountRegistration(accountStore(nodeB), {
      id: created.account.id,
      publicKey: created.account.publicKey,
      type: created.account.type,
      joinedDay: created.account.joinedDay,
      createdAt: created.account.createdAt,
    });

    assert.equal(written, true);
    const onB = getAccount(nodeB, created.account.id)!;
    assert.equal(onB.id, created.account.id);
    assert.equal(onB.publicKey, created.account.publicKey);
    assert.equal(onB.type, 'individual');
  });

  it('is idempotent: re-delivery of the same registration is a no-op', () => {
    // Gossip is at-least-once and relayed, so the same registration arrives
    // repeatedly. A second apply must not throw and must not disturb the row.
    const kp = generateKeyPair();
    const id = deriveAccountId(kp.publicKey);
    const reg = {
      id,
      publicKey: kp.publicKey,
      type: 'individual' as const,
      joinedDay: 1,
      createdAt: 1786890000,
    };

    assert.equal(applyPeerAccountRegistration(accountStore(nodeB), reg), true);
    assert.equal(applyPeerAccountRegistration(accountStore(nodeB), reg), false);
    assert.equal(applyPeerAccountRegistration(accountStore(nodeB), reg), false);
    assert.equal(getAccount(nodeB, id)!.publicKey, kp.publicKey);
  });

  it('rejects a registration whose id does not match its public key', () => {
    // Without this check a peer could claim any id it liked and squat the row
    // for an account whose key it does not hold.
    const kp = generateKeyPair();
    assert.throws(
      () =>
        applyPeerAccountRegistration(accountStore(nodeB), {
          id: 'ff'.repeat(20),
          publicKey: kp.publicKey,
          type: 'individual',
          joinedDay: 1,
          createdAt: 1786890000,
        }),
      /does not match its public key/,
    );
    assert.equal(getAccount(nodeB, 'ff'.repeat(20)), null);
  });

  it('rejects a malformed public key', () => {
    assert.throws(
      () =>
        applyPeerAccountRegistration(accountStore(nodeB), {
          id: 'ab'.repeat(20),
          publicKey: 'not-hex',
          type: 'individual',
          joinedDay: 1,
          createdAt: 1786890000,
        }),
      /1952-byte hex string/,
    );
  });

  it('never lets a peer grant percentHuman or a balance', () => {
    // A replicated account is an empty shell. Score comes from a completed
    // verification panel; value only ever moves through replayed transactions.
    const kp = generateKeyPair();
    const id = deriveAccountId(kp.publicKey);
    applyPeerAccountRegistration(accountStore(nodeB), {
      id,
      publicKey: kp.publicKey,
      type: 'individual',
      joinedDay: 1,
      createdAt: 1786890000,
      // Deliberately smuggling extra fields the way a hostile peer would.
      ...({ percentHuman: 100, earnedBalance: '999999999999' } as object),
    });

    const acct = getAccount(nodeB, id)!;
    assert.equal(acct.percentHuman, 0);
    assert.equal(acct.earnedBalance, 0n);
    assert.equal(acct.activeBalance, 0n);
  });

  // ── the property that actually matters ───────────────────────────────
  it('turns a fatal cross-node replay into a successful one', () => {
    const senderKp = generateKeyPair();
    const recipientKp = generateKeyPair();

    // Both accounts are created on node A only, exactly as the wallet does.
    const sender = createAccount(nodeA, 'individual', 1, 100, senderKp.publicKey);
    const recipient = createAccount(nodeA, 'individual', 1, 100, recipientKp.publicKey);
    updateBalance(nodeA, sender.account.id, 'earned_balance', 500_00000000n);

    const amount = 12_00000000n;
    const timestamp = 1786890000;
    const payload = {
      from: sender.account.id,
      to: recipient.account.id,
      amount: amount.toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    // Honest wire values. replayTransaction re-derives fee/netAmount from local
    // chain state now (audit #4) and applies the DERIVED value, so the wire must
    // carry the true numbers or the assertions below would measure a fiction.
    // Earned points take no percentHuman discount but still pay the fee.
    const fee = calculateFee(amount);
    const net = amount - fee;
    const wireTx = {
      id: 'tx-cross-node-1',
      from: sender.account.id,
      to: recipient.account.id,
      amount,
      fee,
      netAmount: net,
      pointType: 'earned' as const,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
      signature: signPayload(payload, timestamp, senderKp.privateKey),
      receiverSignature: null,
      timestamp,
    };

    // Node B replaying the block that carries this tx: the pre-fix failure.
    assert.throws(
      () => replayTransaction(nodeB, wireTx, 1),
      /sender account not found/,
      'without replication, B cannot apply the block — this is what halted the chain',
    );

    // Now replicate both accounts the way gossip does, and fund the sender the
    // way B would have from earlier replayed blocks.
    for (const a of [sender.account, recipient.account]) {
      applyPeerAccountRegistration(accountStore(nodeB), {
        id: a.id,
        publicKey: a.publicKey,
        type: a.type,
        joinedDay: a.joinedDay,
        createdAt: a.createdAt,
      });
    }
    updateBalance(nodeB, sender.account.id, 'earned_balance', 500_00000000n);

    replayTransaction(nodeB, wireTx, 1);

    assert.equal(getAccount(nodeB, recipient.account.id)!.earnedBalance, net);
    assert.equal(
      getAccount(nodeB, sender.account.id)!.earnedBalance,
      500_00000000n - amount,
    );

    // Both nodes applying the same block must land on the same numbers, which
    // is the whole point: blocks carry no state root, so nothing downstream
    // would ever notice if they did not.
    replayTransaction(nodeA, wireTx, 1);
    for (const id of [sender.account.id, recipient.account.id]) {
      assert.equal(
        getAccount(nodeA, id)!.earnedBalance,
        getAccount(nodeB, id)!.earnedBalance,
        `nodes disagree on earned balance for ${id}`,
      );
    }
  });
});
