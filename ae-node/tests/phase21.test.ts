// Phase 21: Vote aggregation (VoteSet).
//
// VoteSet collects votes for one (kind, height, round) bucket and answers
// "have we hit quorum?" The behaviors verified here:
//
//   1. New votes from registered validators are accepted.
//   2. Byte-identical resends are deduped (status 'duplicate').
//   3. A different vote from the same validator with the same voteId is
//      flagged as 'equivocation' and produces evidence.
//   4. Votes from non-validators / inactive validators / wrong publicKey /
//      wrong (kind, height, round) are rejected with a reason.
//   5. tally() returns vote counts per blockHash, with NIL as its own
//      bucket.
//   6. hasQuorum + quorumBlockHash respect IValidatorSet.quorumCount()
//      (Tendermint-style 2/3+1).
//   7. committedBlockHash returns null when only NIL has quorum.
//   8. stakeFor returns the sum of stake of validators who voted on a block.
//   9. missingValidators() lists validators who haven't voted yet.
//
// Tests use real signed votes (signVote with a real Ed25519 key) so
// signature verification + replay window are exercised end to end.

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
  stake: bigint;
}

/** Spin up N registered validators in a fresh db; returns handles + the set. */
function setupValidators(
  count: number,
  perValidatorStake: bigint = pts(200),
): { db: DatabaseSync; set: SqliteValidatorSet; validators: ValidatorHandle[] } {
  const db = freshDb();
  const validators: ValidatorHandle[] = [];

  for (let i = 0; i < count; i++) {
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      (perValidatorStake + pts(50)).toString(),
      acct.account.id,
    );
    const identity = generateNodeIdentity();
    const vrfKey = Ed25519VrfProvider.generateKeyPair();
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey: vrfKey.publicKey,
      stake: perValidatorStake,
    });
    validators.push({ accountId: acct.account.id, identity, stake: perValidatorStake });
  }

  return { db, set: new SqliteValidatorSet(db), validators };
}

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

describe('Phase 21: Vote aggregation (VoteSet)', () => {
  let env: ReturnType<typeof setupValidators>;

  beforeEach(() => {
    env = setupValidators(4); // 4 validators → quorum = 3
  });

  // ── Happy-path adds + dedup + tally ─────────────────────────────────

  it('accepts a new vote and records it in the tally', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    const r = set.addVote(vote);
    assert.equal(r.status, 'added');
    assert.equal(set.size(), 1);
    assert.equal(set.tally().get(HASH_A), 1);
  });

  it('byte-identical resend is deduped', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    assert.equal(set.addVote(vote).status, 'added');
    assert.equal(set.addVote(vote).status, 'duplicate');
    assert.equal(set.size(), 1);
  });

  it('tally tracks counts per blockHash', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    // 2 votes on HASH_A, 1 on HASH_B
    for (let i = 0; i < 2; i++) {
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
    const v3 = env.validators[2];
    set.addVote(
      signVote({
        kind: 'prevote',
        height: 1,
        round: 0,
        blockHash: HASH_B,
        validatorAccountId: v3.accountId,
        validatorPublicKey: v3.identity.publicKey,
        validatorSecretKey: v3.identity.secretKey,
      }),
    );
    assert.equal(set.tally().get(HASH_A), 2);
    assert.equal(set.tally().get(HASH_B), 1);
    assert.equal(set.size(), 3);
  });

  // ── Equivocation ─────────────────────────────────────────────────────

  it('detects equivocation when same validator signs different blockHashes', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    const voteA = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    const voteB = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_B,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });

    assert.equal(set.addVote(voteA).status, 'added');
    const r = set.addVote(voteB);
    assert.equal(r.status, 'equivocation');
    if (r.status === 'equivocation') {
      assert.equal(r.evidence.first.blockHash, HASH_A);
      assert.equal(r.evidence.second.blockHash, HASH_B);
    }
    // First vote wins the tally; second is recorded as evidence only.
    assert.equal(set.tally().get(HASH_A), 1);
    assert.equal(set.tally().get(HASH_B), undefined);
    assert.equal(set.getEquivocations().length, 1);
  });

  // ── Rejection paths ──────────────────────────────────────────────────

  it('rejects votes with mismatched kind/height/round', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    const wrongKind = signVote({
      kind: 'precommit',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    const wrongHeight = signVote({
      kind: 'prevote',
      height: 99,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    const wrongRound = signVote({
      kind: 'prevote',
      height: 1,
      round: 5,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });

    const r1 = set.addVote(wrongKind);
    assert.equal(r1.status, 'rejected');
    if (r1.status === 'rejected') assert.match(r1.reason, /kind mismatch/);

    const r2 = set.addVote(wrongHeight);
    assert.equal(r2.status, 'rejected');
    if (r2.status === 'rejected') assert.match(r2.reason, /height mismatch/);

    const r3 = set.addVote(wrongRound);
    assert.equal(r3.status, 'rejected');
    if (r3.status === 'rejected') assert.match(r3.reason, /round mismatch/);
  });

  it('rejects votes from non-validators', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const stranger = generateNodeIdentity();
    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: 'unknown-account',
      validatorPublicKey: stranger.publicKey,
      validatorSecretKey: stranger.secretKey,
    });
    const r = set.addVote(vote);
    assert.equal(r.status, 'rejected');
    if (r.status === 'rejected') assert.match(r.reason, /not in the active set/);
  });

  it('rejects a vote whose publicKey does not match the registered nodePublicKey', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    const imposter = generateNodeIdentity();
    // Signs a vote claiming to be v.accountId but with imposter's key
    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: imposter.publicKey,
      validatorSecretKey: imposter.secretKey,
    });
    const r = set.addVote(vote);
    assert.equal(r.status, 'rejected');
    if (r.status === 'rejected') {
      assert.match(r.reason, /does not match registered nodePublicKey/);
    }
  });

  it('rejects votes with a tampered signature', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    // Flip a byte in the signature
    const tampered = {
      ...vote,
      signature: vote.signature.slice(0, -2) + ((parseInt(vote.signature.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')),
    };
    const r = set.addVote(tampered);
    assert.equal(r.status, 'rejected');
    if (r.status === 'rejected') assert.match(r.reason, /signature/);
  });

  it('rejects votes from a deregistered validator', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v = env.validators[0];
    // Deregister v
    env.set.markInactive(v.accountId, Math.floor(Date.now() / 1000));

    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
    });
    const r = set.addVote(vote);
    assert.equal(r.status, 'rejected');
    if (r.status === 'rejected') assert.match(r.reason, /inactive/);
  });

  // ── Quorum ───────────────────────────────────────────────────────────

  it('hasQuorum is false until the quorum count is reached', () => {
    // 4 validators → quorum = 3
    const set = new VoteSet('prevote', 1, 0, env.set);
    for (let i = 0; i < 2; i++) {
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
    assert.equal(set.hasQuorum(HASH_A), false);
    assert.equal(set.quorumBlockHash(), null);
    assert.equal(set.committedBlockHash(), null);

    // Third vote pushes us over quorum
    const v3 = env.validators[2];
    set.addVote(
      signVote({
        kind: 'prevote',
        height: 1,
        round: 0,
        blockHash: HASH_A,
        validatorAccountId: v3.accountId,
        validatorPublicKey: v3.identity.publicKey,
        validatorSecretKey: v3.identity.secretKey,
      }),
    );
    assert.equal(set.hasQuorum(HASH_A), true);
    assert.equal(set.quorumBlockHash(), HASH_A);
    assert.equal(set.committedBlockHash(), HASH_A);
  });

  it('NIL votes have their own quorum bucket; committedBlockHash returns null even when NIL wins', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    for (let i = 0; i < 3; i++) {
      const v = env.validators[i];
      set.addVote(
        signVote({
          kind: 'prevote',
          height: 1,
          round: 0,
          blockHash: null,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    assert.equal(set.hasQuorum(null), true);
    assert.equal(set.quorumBlockHash(), '<nil>');
    // committedBlockHash treats NIL quorum as "no block committed"
    assert.equal(set.committedBlockHash(), null);
  });

  // ── stakeFor / missingValidators ────────────────────────────────────

  it('stakeFor sums stake of validators who voted for a block', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    // 2 validators vote for A
    for (let i = 0; i < 2; i++) {
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
    const expected = env.validators[0].stake + env.validators[1].stake;
    assert.equal(set.stakeFor(HASH_A), expected);
    assert.equal(set.stakeFor(HASH_B), 0n);
  });

  it('missingValidators reports validators who have not voted yet', () => {
    const set = new VoteSet('prevote', 1, 0, env.set);
    const v0 = env.validators[0];
    set.addVote(
      signVote({
        kind: 'prevote',
        height: 1,
        round: 0,
        blockHash: HASH_A,
        validatorAccountId: v0.accountId,
        validatorPublicKey: v0.identity.publicKey,
        validatorSecretKey: v0.identity.secretKey,
      }),
    );
    const missing = set.missingValidators();
    assert.equal(missing.length, 3);
    assert.equal(missing.includes(v0.accountId), false);
    assert.equal(missing.includes(env.validators[1].accountId), true);
    assert.equal(missing.includes(env.validators[2].accountId), true);
    assert.equal(missing.includes(env.validators[3].accountId), true);
  });

  // ── Replay window ───────────────────────────────────────────────────

  it('rejects stale votes outside the replay window', () => {
    const set = new VoteSet('prevote', 1, 0, env.set, {
      replayWindowSec: 600,
      nowSec: () => 2_000_000, // verifier's "now"
    });
    const v = env.validators[0];
    const vote = signVote({
      kind: 'prevote',
      height: 1,
      round: 0,
      blockHash: HASH_A,
      validatorAccountId: v.accountId,
      validatorPublicKey: v.identity.publicKey,
      validatorSecretKey: v.identity.secretKey,
      now: 1_000_000, // way before the replay window
    });
    const r = set.addVote(vote);
    assert.equal(r.status, 'rejected');
    if (r.status === 'rejected') assert.match(r.reason, /signature/);
  });
});
