// Phase 22: Commit certificates — cryptographic finality proofs.
//
// A CommitCertificate bundles 2/3+ precommit signatures so anyone can
// independently verify "this block was finalized by the validator set we
// expect" — even nodes that weren't online during the voting round.
//
// Tests cover:
//   1. Round-trip: VoteSet hits quorum → buildCommitCertificate → verify
//   2. buildCommitCertificate returns null when no real block has quorum
//      (only NIL, or below quorum, or wrong VoteSet kind)
//   3. Verification rejects:
//      - empty / null cert
//      - empty precommits array
//      - precommits with wrong kind (prevote)
//      - precommits with mismatched height/round/blockHash
//      - tampered signatures
//      - unknown / inactive validators
//      - publicKey mismatch
//      - duplicate validators
//      - below-quorum count
//   4. skipTimestampWindow lets historical certs verify outside the
//      replay window (catch-up sync use case)

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
import { signVote } from '../src/core/consensus/votes.js';
import { VoteSet } from '../src/core/consensus/vote-aggregator.js';
import {
  buildCommitCertificate,
  verifyCommitCertificate,
  type CommitCertificate,
} from '../src/core/consensus/commit-certificate.js';
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

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

function precommit(v: ValidatorHandle, height: number, round: number, blockHash: string | null) {
  return signVote({
    kind: 'precommit',
    height,
    round,
    blockHash,
    validatorAccountId: v.accountId,
    validatorPublicKey: v.identity.publicKey,
    validatorSecretKey: v.identity.secretKey,
  });
}

describe('Phase 22: Commit certificates', () => {
  let env: ReturnType<typeof setupValidators>;

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
  });

  // ── Build round-trip ─────────────────────────────────────────────────

  it('build → verify round-trips when 3/4 validators precommit on the same hash', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) {
      const r = set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
      assert.equal(r.status, 'added');
    }

    const cert = buildCommitCertificate(set);
    assert.ok(cert, 'cert should be built');
    assert.equal(cert!.blockHash, HASH_A);
    assert.equal(cert!.height, 1);
    assert.equal(cert!.round, 0);
    assert.equal(cert!.precommits.length, 3);

    const result = verifyCommitCertificate(cert!, env.set);
    assert.equal(result.valid, true);
    assert.equal(result.signers!.length, 3);
  });

  it('extra unanimous votes get bundled into the cert too', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    // All 4 vote
    for (const v of env.validators) {
      set.addVote(precommit(v, 1, 0, HASH_A));
    }
    const cert = buildCommitCertificate(set);
    assert.ok(cert);
    assert.equal(cert!.precommits.length, 4);
    assert.equal(verifyCommitCertificate(cert!, env.set).valid, true);
  });

  // ── buildCommitCertificate negative cases ───────────────────────────

  it('buildCommitCertificate returns null when no quorum was reached', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    // Only 2/4 validators — below quorum=3
    for (let i = 0; i < 2; i++) {
      set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    }
    assert.equal(buildCommitCertificate(set), null);
  });

  it('buildCommitCertificate returns null when only NIL has quorum', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) {
      set.addVote(precommit(env.validators[i], 1, 0, null));
    }
    assert.equal(buildCommitCertificate(set), null);
  });

  it('buildCommitCertificate returns null when given a prevote VoteSet', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    for (let i = 0; i < 3; i++) {
      const v = env.validators[i];
      set.addVote(
        signVote({
          kind: 'prevote',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    assert.equal(buildCommitCertificate(set), null);
  });

  // ── Verification rejection cases ─────────────────────────────────────

  it('rejects an empty / malformed cert', () => {
    assert.equal(verifyCommitCertificate(null as unknown as CommitCertificate, env.set).valid, false);
    assert.equal(verifyCommitCertificate({} as CommitCertificate, env.set).valid, false);
    assert.equal(
      verifyCommitCertificate(
        { height: 1, round: 0, blockHash: HASH_A, precommits: [] },
        env.set,
      ).valid,
      false,
    );
  });

  it('rejects a cert with non-precommit votes', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;

    // Sneak a prevote into the precommits list
    const v = env.validators[0];
    const prevote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    cert.precommits[0] = prevote;
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /not 'precommit'/);
  });

  it('rejects a cert with mismatched height in one of the votes', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    // Replace one precommit with one signed for a different height
    cert.precommits[0] = precommit(env.validators[0], 99, 0, HASH_A);
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /vote height/);
  });

  it('rejects a cert with mismatched blockHash in one of the votes', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    cert.precommits[0] = precommit(env.validators[0], 1, 0, HASH_B);
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /blockHash mismatch/);
  });

  it('rejects a cert with a tampered precommit signature', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    const orig = cert.precommits[0];
    cert.precommits[0] = {
      ...orig,
      signature: orig.signature.slice(0, -2) + ((parseInt(orig.signature.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')),
    };
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /signature/);
  });

  it('rejects a cert with a precommit from an unknown validator', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    // Forge a precommit from someone not registered
    const stranger: ValidatorHandle = {
      accountId: 'unknown-account',
      identity: generateNodeIdentity(),
    };
    cert.precommits.push(precommit(stranger, 1, 0, HASH_A));
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /not in the active set/);
  });

  it('rejects a cert with a precommit from a deregistered validator', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    // Deregister validator 0 AFTER the cert was built
    env.set.markInactive(env.validators[0].accountId, Math.floor(Date.now() / 1000));
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /inactive/);
  });

  it('rejects a cert with a publicKey that does not match the registered nodePublicKey', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    const imposter = generateNodeIdentity();
    const imposterVote = signVote({
      kind: 'precommit',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: env.validators[0].accountId,
      validatorPublicKey: imposter.publicKey,
      validatorSecretKey: imposter.secretKey,
    });
    cert.precommits[0] = imposterVote;
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /does not match registered/);
  });

  it('rejects a cert with duplicate signatures from the same validator', () => {
    const set = new VoteSet('precommit', 1, 0, env.set);
    for (let i = 0; i < 3; i++) set.addVote(precommit(env.validators[i], 1, 0, HASH_A));
    const cert = buildCommitCertificate(set)!;
    // Duplicate the first precommit
    cert.precommits.push(cert.precommits[0]);
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /duplicate precommit/);
  });

  it('rejects a below-quorum cert', () => {
    // Create a cert with only 2 precommits in a 4-validator set (quorum=3).
    // We have to hand-build it because buildCommitCertificate refuses
    // sub-quorum input.
    const cert: CommitCertificate = {
      height: 1,
      round: 0,
      blockHash: HASH_A,
      precommits: [
        precommit(env.validators[0], 1, 0, HASH_A),
        precommit(env.validators[1], 1, 0, HASH_A),
      ],
    };
    const r = verifyCommitCertificate(cert, env.set);
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /quorum/);
  });

  // ── skipTimestampWindow for catch-up sync ────────────────────────────

  it('skipTimestampWindow lets a historical cert verify outside the replay window', () => {
    const set = new VoteSet('precommit', 1, 0, env.set, {
      replayWindowSec: 600,
      nowSec: () => 1_000_000,
    });
    // Sign votes "in the past"
    for (let i = 0; i < 3; i++) {
      const v = env.validators[i];
      const vote = signVote({
        kind: 'precommit',
        height: 1,
        round: 0,
        blockHash: HASH_A,
        validatorAccountId: v.accountId,
        validatorPublicKey: v.identity.publicKey,
        validatorSecretKey: v.identity.secretKey,
        now: 1_000_000,
      });
      set.addVote(vote);
    }
    const cert = buildCommitCertificate(set)!;

    // Verifying a year later
    const farFuture = 1_000_000 + 365 * 24 * 60 * 60;

    // Without skipTimestampWindow → fails because votes are stale
    assert.equal(
      verifyCommitCertificate(cert, env.set, { nowSec: farFuture, replayWindowSec: 600 }).valid,
      false,
    );
    // With skipTimestampWindow → passes (this is the catch-up sync path)
    assert.equal(
      verifyCommitCertificate(cert, env.set, { skipTimestampWindow: true }).valid,
      true,
    );
  });
});
