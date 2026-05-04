// Phase 41: Slashing pipeline (equivocation → stake burn).
//
// Verifies the slashing primitives that turn provable Byzantine
// behavior into economic consequence.
//
//   verifyEquivocationEvidence(evidence) → boolean
//     1. Both votes must verify cryptographically
//     2. Same voteId (kind, height, round, validator)
//     3. Different signed bytes (not duplicates)
//     4. Same validatorAccountId + validatorPublicKey
//
//   slashValidator(db, accountId, evidence)
//     - Atomically: mark inactive, burn stake (lockedBalance → 0),
//       audit-log entry. Idempotent on already-inactive.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { signVote, type Vote } from '../src/core/consensus/votes.js';
import {
  verifyEquivocationEvidence,
  slashValidator,
} from '../src/core/consensus/slashing.js';
import type { EquivocationEvidence } from '../src/core/consensus/vote-aggregator.js';
import { transactionStore } from '../src/core/transaction.js';
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

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

function setupValidator(): {
  db: DatabaseSync;
  set: SqliteValidatorSet;
  accountId: string;
  identity: ReturnType<typeof generateNodeIdentity>;
  stake: bigint;
} {
  const db = freshDb();
  const acct = createAccount(db, 'individual', 1, 100);
  const accountId = 'val-slash';
  db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(accountId, acct.account.id);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    pts(500).toString(),
    accountId,
  );
  const identity = generateNodeIdentity();
  const stake = pts(200);
  registerValidator(db, {
    accountId,
    nodePublicKey: identity.publicKey,
    vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    stake,
  });
  return { db, set: new SqliteValidatorSet(db), accountId, identity, stake };
}

/** Build two equivocating prevotes for the same (height, round, validator). */
function makeEquivocation(
  identity: ReturnType<typeof generateNodeIdentity>,
  accountId: string,
  height: number,
  round: number,
): EquivocationEvidence {
  const first = signVote({
    kind: 'prevote',
    height,
    round,
    blockHash: HASH_A,
    validatorAccountId: accountId,
    validatorPublicKey: identity.publicKey,
    validatorSecretKey: identity.secretKey,
  });
  const second = signVote({
    kind: 'prevote',
    height,
    round,
    blockHash: HASH_B, // <-- different
    validatorAccountId: accountId,
    validatorPublicKey: identity.publicKey,
    validatorSecretKey: identity.secretKey,
  });
  return { first, second };
}

describe('Phase 41: Slashing pipeline', () => {
  // ── verifyEquivocationEvidence ──────────────────────────────────────

  it('valid equivocation: same voteId, different signed bytes, both signatures verify', () => {
    const env = setupValidator();
    const evidence = makeEquivocation(env.identity, env.accountId, 5, 0);
    const result = verifyEquivocationEvidence(evidence);
    assert.equal(result.valid, true, result.reason);
  });

  it('rejects evidence with different voteIds', () => {
    const env = setupValidator();
    // Different rounds → different voteIds
    const evidence: EquivocationEvidence = {
      first: signVote({
        kind: 'prevote', height: 5, round: 0, blockHash: HASH_A,
        validatorAccountId: env.accountId,
        validatorPublicKey: env.identity.publicKey,
        validatorSecretKey: env.identity.secretKey,
      }),
      second: signVote({
        kind: 'prevote', height: 5, round: 1, blockHash: HASH_B,
        validatorAccountId: env.accountId,
        validatorPublicKey: env.identity.publicKey,
        validatorSecretKey: env.identity.secretKey,
      }),
    };
    const result = verifyEquivocationEvidence(evidence);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /voteIds differ/);
  });

  it('rejects evidence with identical signatures (duplicate, not equivocation)', () => {
    const env = setupValidator();
    const v = signVote({
      kind: 'prevote', height: 5, round: 0, blockHash: HASH_A,
      validatorAccountId: env.accountId,
      validatorPublicKey: env.identity.publicKey,
      validatorSecretKey: env.identity.secretKey,
    });
    const result = verifyEquivocationEvidence({ first: v, second: v });
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /identical signatures/);
  });

  it('rejects evidence where the two votes are from different validators', () => {
    const a = generateNodeIdentity();
    const b = generateNodeIdentity();
    const evidence: EquivocationEvidence = {
      first: signVote({
        kind: 'prevote', height: 5, round: 0, blockHash: HASH_A,
        validatorAccountId: 'alice',
        validatorPublicKey: a.publicKey,
        validatorSecretKey: a.secretKey,
      }),
      second: signVote({
        kind: 'prevote', height: 5, round: 0, blockHash: HASH_B,
        validatorAccountId: 'bob',
        validatorPublicKey: b.publicKey,
        validatorSecretKey: b.secretKey,
      }),
    };
    const result = verifyEquivocationEvidence(evidence);
    assert.equal(result.valid, false);
    // voteId encodes the validator, so different validators trip the
    // voteIds-differ check before the explicit accountId check
    assert.match(result.reason ?? '', /voteIds differ|different validatorAccountId/);
  });

  it('rejects evidence with a tampered signature (cryptographic check fails)', () => {
    const env = setupValidator();
    const evidence = makeEquivocation(env.identity, env.accountId, 5, 0);
    // Flip one byte of the second signature
    const tamperedSig =
      evidence.second.signature.slice(0, -2) +
      ((parseInt(evidence.second.signature.slice(-2), 16) ^ 0x01).toString(16).padStart(2, '0'));
    evidence.second = { ...evidence.second, signature: tamperedSig };
    const result = verifyEquivocationEvidence(evidence);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /signature invalid/);
  });

  // ── slashValidator: happy path ──────────────────────────────────────

  it('slashes a validator on valid equivocation: marks inactive, burns stake, audit log', () => {
    const env = setupValidator();
    const evidence = makeEquivocation(env.identity, env.accountId, 5, 0);

    // Pre-state: locked = stake, earned = 500-200 = 300, validator active
    const preAcct = getAccount(env.db, env.accountId)!;
    assert.equal(preAcct.lockedBalance, env.stake);
    assert.equal(env.set.findByAccountId(env.accountId)!.isActive, true);

    const result = slashValidator(env.db, env.accountId, evidence);
    assert.equal(result.slashed, true, result.reason);
    assert.equal(result.burnedAmount, env.stake);

    // Post-state: locked = 0, earned unchanged (stake destroyed, not refunded)
    const postAcct = getAccount(env.db, env.accountId)!;
    assert.equal(postAcct.lockedBalance, 0n, 'stake must be burned');
    assert.equal(postAcct.earnedBalance, preAcct.earnedBalance, 'earned must not change');
    assert.equal(env.set.findByAccountId(env.accountId)!.isActive, false);

    // Audit log entry tagged 'court_burn' for the burn
    const logs = transactionStore(env.db).findLogsByAccount(env.accountId, 'court_burn');
    assert.equal(logs.length, 1);
    assert.equal(BigInt(logs[0].amount), env.stake);
  });

  // ── slashValidator: rejection paths ─────────────────────────────────

  it('rejects slash with invalid evidence (no state change)', () => {
    const env = setupValidator();
    // Evidence with same signatures (duplicate, not equivocation)
    const v = signVote({
      kind: 'prevote', height: 5, round: 0, blockHash: HASH_A,
      validatorAccountId: env.accountId,
      validatorPublicKey: env.identity.publicKey,
      validatorSecretKey: env.identity.secretKey,
    });
    const result = slashValidator(env.db, env.accountId, { first: v, second: v });
    assert.equal(result.slashed, false);

    // Validator still active, stake intact
    assert.equal(env.set.findByAccountId(env.accountId)!.isActive, true);
    assert.equal(getAccount(env.db, env.accountId)!.lockedBalance, env.stake);
  });

  it('rejects slash when accountId argument does not match evidence', () => {
    const env = setupValidator();
    const evidence = makeEquivocation(env.identity, env.accountId, 5, 0);
    const result = slashValidator(env.db, 'someone-else', evidence);
    assert.equal(result.slashed, false);
    // Mismatch is detected BEFORE the validator-set lookup, so we see
    // the "evidence is for X, not Y" message
    assert.match(result.reason ?? '', /evidence is for .+, not someone-else/);
  });

  it('rejects slash for an unregistered validator (matching evidence)', () => {
    // Same identity used to sign evidence, but the validator with this
    // accountId is NOT registered in the local set.
    const db = freshDb();
    const identity = generateNodeIdentity();
    const evidence: EquivocationEvidence = {
      first: signVote({
        kind: 'prevote', height: 5, round: 0, blockHash: HASH_A,
        validatorAccountId: 'unknown-val',
        validatorPublicKey: identity.publicKey,
        validatorSecretKey: identity.secretKey,
      }),
      second: signVote({
        kind: 'prevote', height: 5, round: 0, blockHash: HASH_B,
        validatorAccountId: 'unknown-val',
        validatorPublicKey: identity.publicKey,
        validatorSecretKey: identity.secretKey,
      }),
    };
    const result = slashValidator(db, 'unknown-val', evidence);
    assert.equal(result.slashed, false);
    assert.match(result.reason ?? '', /not registered/);
  });

  it('idempotent on already-inactive validator', () => {
    const env = setupValidator();
    const evidence = makeEquivocation(env.identity, env.accountId, 5, 0);

    // First slash succeeds
    const r1 = slashValidator(env.db, env.accountId, evidence);
    assert.equal(r1.slashed, true);

    // Second slash is a no-op
    const r2 = slashValidator(env.db, env.accountId, evidence);
    assert.equal(r2.slashed, false);
    assert.match(r2.reason ?? '', /already inactive/);

    // No double-burn
    assert.equal(getAccount(env.db, env.accountId)!.lockedBalance, 0n);
    // Single audit-log entry, not two
    const logs = transactionStore(env.db).findLogsByAccount(env.accountId, 'court_burn');
    assert.equal(logs.length, 1);
  });

  it('rejects slash if the registered nodePublicKey does not match the evidence', () => {
    const env = setupValidator();
    // Evidence signed by a DIFFERENT key but claiming env.accountId
    const otherIdentity = generateNodeIdentity();
    const v1: Vote = signVote({
      kind: 'prevote', height: 5, round: 0, blockHash: HASH_A,
      validatorAccountId: env.accountId,
      validatorPublicKey: otherIdentity.publicKey,
      validatorSecretKey: otherIdentity.secretKey,
    });
    const v2: Vote = signVote({
      kind: 'prevote', height: 5, round: 0, blockHash: HASH_B,
      validatorAccountId: env.accountId,
      validatorPublicKey: otherIdentity.publicKey,
      validatorSecretKey: otherIdentity.secretKey,
    });
    const result = slashValidator(env.db, env.accountId, { first: v1, second: v2 });
    assert.equal(result.slashed, false);
    assert.match(result.reason ?? '', /does not match registered nodePublicKey/);
    // Validator is still active, stake intact
    assert.equal(env.set.findByAccountId(env.accountId)!.isActive, true);
  });
});
