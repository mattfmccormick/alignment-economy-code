// A vouch operation applied on two nodes reaches identical state.
//
// This is the property the whole chain-ordering of vouches exists to guarantee
// (audit #4/#16). A vouch moves the voucher's balance (earned -> locked) and, on
// withdrawal, the vouched account's percentHuman — all in the state root. Before
// this, POST /miners/vouches applied it to one node only, so the ledgers forked.
// Now the operation rides a block and applies deterministically everywhere; these
// tests pin that a create and a withdraw leave two independent databases with
// byte-identical state roots, and that a re-delivered operation is a no-op.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, updateBalance, getAccount } from '../src/core/account.js';
import { computeStateRoot } from '../src/core/state-root.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import { PRECISION } from '../src/core/constants.js';
import {
  signVouchCreate,
  signVouchWithdraw,
  applyVouchOperation,
  verifyVouchOperation,
  computeVouchOperationsHash,
  deriveVouchId,
} from '../src/verification/vouch-operation.js';

interface Party {
  id: string;
  pub: string;
  priv: string;
}

function party(seed: string): Party {
  // Deterministic keys via a fixed seed so both node DBs name the same accounts.
  const kp = generateKeyPair();
  return { id: deriveAccountId(kp.publicKey), pub: kp.publicKey, priv: kp.privateKey };
}

/** A node DB seeded with the given accounts, the voucher funded. */
function node(voucher: Party, vouched: Party, voucherEarned: bigint): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createAccount(db, 'individual', 1, 100, voucher.pub);
  createAccount(db, 'individual', 1, 100, vouched.pub);
  updateBalance(db, voucher.id, 'earned_balance', voucherEarned);
  return db;
}

describe('vouch operation determinism across nodes', () => {
  it('a create applied on two nodes yields identical state roots', () => {
    const voucher = party('voucher');
    const vouched = party('vouched');
    const earned = 1000n * PRECISION;

    const a = node(voucher, vouched, earned);
    const b = node(voucher, vouched, earned);
    assert.equal(computeStateRoot(a), computeStateRoot(b), 'precondition: identical start');

    const op = signVouchCreate({
      voucherId: voucher.id,
      vouchedId: vouched.id,
      stakePercent: 10,
      timestamp: 1_700_000_100,
      voucherPrivateKey: voucher.priv,
    });

    applyVouchOperation(a, op, 1_700_000_100);
    applyVouchOperation(b, op, 1_700_000_100);

    assert.equal(
      computeStateRoot(a),
      computeStateRoot(b),
      'two nodes that applied the same vouch must agree on the state root',
    );
    // And the stake actually moved (earned -> locked).
    assert.ok(getAccount(a, voucher.id)!.lockedBalance > 0n, 'stake was locked');
    assert.equal(
      getAccount(a, voucher.id)!.lockedBalance,
      getAccount(b, voucher.id)!.lockedBalance,
    );
    a.close();
    b.close();
  });

  it('a create then a withdraw converge on both nodes (stake back, score dropped)', () => {
    const voucher = party('voucher2');
    const vouched = party('vouched2');
    const earned = 1000n * PRECISION;
    const a = node(voucher, vouched, earned);
    const b = node(voucher, vouched, earned);

    const createOp = signVouchCreate({
      voucherId: voucher.id,
      vouchedId: vouched.id,
      stakePercent: 10,
      timestamp: 1_700_000_200,
      voucherPrivateKey: voucher.priv,
    });
    applyVouchOperation(a, createOp, 1_700_000_200);
    applyVouchOperation(b, createOp, 1_700_000_200);
    assert.equal(computeStateRoot(a), computeStateRoot(b));

    const withdrawOp = signVouchWithdraw({
      voucherId: voucher.id,
      vouchId: deriveVouchId(createOp),
      timestamp: 1_700_000_300,
      voucherPrivateKey: voucher.priv,
    });
    applyVouchOperation(a, withdrawOp, 1_700_000_300);
    applyVouchOperation(b, withdrawOp, 1_700_000_300);

    assert.equal(computeStateRoot(a), computeStateRoot(b));
    assert.equal(getAccount(a, voucher.id)!.lockedBalance, 0n, 'stake unlocked');
    a.close();
    b.close();
  });

  it('a re-delivered create is a no-op (idempotent)', () => {
    const voucher = party('voucher3');
    const vouched = party('vouched3');
    const db = node(voucher, vouched, 1000n * PRECISION);
    const op = signVouchCreate({
      voucherId: voucher.id,
      vouchedId: vouched.id,
      stakePercent: 10,
      timestamp: 1_700_000_400,
      voucherPrivateKey: voucher.priv,
    });
    applyVouchOperation(db, op, 1_700_000_400);
    const once = computeStateRoot(db);
    applyVouchOperation(db, op, 1_700_000_400); // re-delivery
    assert.equal(computeStateRoot(db), once, 'a re-applied vouch must not move state again');
    db.close();
  });

  it('the operations hash is order-independent and signature verifies', () => {
    const voucher = party('voucher4');
    const vouched = party('vouched4');
    const op1 = signVouchCreate({
      voucherId: voucher.id,
      vouchedId: vouched.id,
      stakePercent: 5,
      timestamp: 1_700_000_500,
      voucherPrivateKey: voucher.priv,
    });
    const op2 = signVouchCreate({
      voucherId: voucher.id,
      vouchedId: vouched.id,
      stakePercent: 7,
      timestamp: 1_700_000_501,
      voucherPrivateKey: voucher.priv,
    });
    // Order-independent (sorted internally).
    assert.equal(computeVouchOperationsHash([op1, op2]), computeVouchOperationsHash([op2, op1]));
    // Signature verifies against the voucher, and fails against a stranger.
    assert.equal(verifyVouchOperation(op1, voucher.pub), true);
    assert.equal(verifyVouchOperation(op1, vouched.pub), false);
  });
});
