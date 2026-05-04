// Phase 43: Lock-honoring precommits.
//
// Session 31 made castPrevote downgrade to NIL when locked on a
// different hash. Session 37 extends this to castPrecommit — without
// it, a Byzantine majority could induce a locked validator to precommit
// a different block in a later round, flipping their lock and breaking
// the safety property.
//
// The Tendermint locking rule applies SYMMETRICALLY:
//   - prevote: locked on H1, asked to prevote H2 → prevote NIL
//   - precommit: locked on H1, asked to precommit H2 → precommit NIL
//
// NIL precommits never form a lock; the existing lock from the prior
// round is preserved.
//
// What's verified:
//   1. priorLock + matching prevote-quorum hash: precommit normally
//   2. priorLock + DIFFERENT prevote-quorum hash: precommit NIL
//      (downgrade) but the round still moves to precommit phase
//   3. NIL precommit emits no set-lock action — existing lock survives
//   4. Lock survives when downgraded NIL precommit is the local
//      validator's contribution; the round still commits the block
//      based on OTHER validators' precommits (3/4 from non-locked
//      validators is still quorum)

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
import { signProposal } from '../src/core/consensus/proposal.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import {
  RoundController,
  type LocalValidator,
  type RoundAction,
} from '../src/core/consensus/round-controller.js';
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

interface ValidatorHandle {
  accountId: string;
  identity: NodeIdentity;
}

function setupValidators(count: number): {
  db: DatabaseSync;
  set: SqliteValidatorSet;
  validators: ValidatorHandle[];
} {
  const db = freshDb();
  const validators: ValidatorHandle[] = [];
  for (let i = 0; i < count; i++) {
    const acct = createAccount(db, 'individual', 1, 100);
    db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
      pts(500).toString(),
      acct.account.id,
    );
    const identity = generateNodeIdentity();
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: identity.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: pts(200),
    });
    validators.push({ accountId: acct.account.id, identity });
  }
  return { db, set: new SqliteValidatorSet(db), validators };
}

function asLocal(v: ValidatorHandle): LocalValidator {
  return {
    accountId: v.accountId,
    publicKey: v.identity.publicKey,
    secretKey: v.identity.secretKey,
  };
}

function findActions(actions: RoundAction[], type: RoundAction['type']): RoundAction[] {
  return actions.filter((a) => a.type === type);
}

describe('Phase 43: Lock-honoring precommits', () => {
  let env: ReturnType<typeof setupValidators>;
  let local: ValidatorHandle;
  let others: ValidatorHandle[];

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
    // Pick a non-proposer for the local validator so we don't
    // accidentally trigger broadcast-proposal flows.
    const sel = selectProposer(env.set.listActive(), 1, 'lock-seed', 1)!;
    local = env.validators.find((v) => v.accountId !== sel.accountId)!;
    others = env.validators.filter((v) => v.accountId !== local.accountId);
  });

  it('priorLock + matching quorum hash: precommit normally', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });
    // Drive 2 prevotes from others on HASH_A → quorum (3 of 4 with our own NIL? no — see below)

    // We're locked on HASH_A; on propose-timeout we'd cast NIL.
    // To test the matching-hash path, we need the controller to be
    // in prevote phase and observe quorum on HASH_A — which means
    // 3 distinct validators voting HASH_A. Our local won't (it cast
    // NIL on propose-timeout, since we have no proposal). So we
    // need 3 others' prevotes for HASH_A.
    ctrl.handle({ type: 'propose-timeout' }); // local NIL prevote
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 1, blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }

    // Quorum on HASH_A reached after the 3rd prevote. Controller
    // should castPrecommit(HASH_A). HASH_A matches our lock → real precommit.
    const votes = findActions(lastActions, 'broadcast-vote');
    const precommit = votes.find(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'precommit',
    );
    assert.ok(precommit, 'should emit a precommit broadcast');
    if (precommit && precommit.type === 'broadcast-vote') {
      assert.equal(
        precommit.vote.blockHash,
        HASH_A,
        'precommit on locked hash: keep the hash',
      );
    }
    // Lock action also emitted (re-locks at the new round)
    const lockActions = findActions(lastActions, 'set-lock');
    assert.equal(lockActions.length, 1);
    if (lockActions[0].type === 'set-lock') {
      assert.equal(lockActions[0].lockState.blockHash, HASH_A);
      assert.equal(lockActions[0].lockState.round, 1);
    }
  });

  it('priorLock + DIFFERENT quorum hash: precommit downgrades to NIL', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' }); // local NIL prevote

    // 3 OTHERS prevote HASH_B (different from our lock HASH_A)
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 1, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }

    // Quorum on HASH_B. We're asked to precommit HASH_B but we're
    // locked on HASH_A — downgrade to NIL.
    const precommitVotes = findActions(lastActions, 'broadcast-vote').filter(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'precommit',
    );
    assert.equal(precommitVotes.length, 1);
    if (precommitVotes[0].type === 'broadcast-vote') {
      assert.equal(
        precommitVotes[0].vote.blockHash,
        null,
        'locked validator must NOT precommit a different hash; downgrade to NIL',
      );
    }

    // No new set-lock action — NIL precommits don't form a lock,
    // and the existing lock should be preserved by the driver.
    const lockActions = findActions(lastActions, 'set-lock');
    assert.equal(
      lockActions.length,
      0,
      'NIL precommit must not emit set-lock; existing lock preserved',
    );
  });

  it('NIL-downgraded precommit still allows the round to commit (via observed precommits from others)', () => {
    // Setup: A is locked on HASH_A. Round 1 has B/C/D voting HASH_B.
    // A's precommit is NIL (downgraded). B/C/D's precommits for HASH_B
    // form quorum (3 of 4 distinct validators). A's local controller
    // observes the precommit quorum and emits commit-block(HASH_B).
    // This is the key insight: the lock prevents A from voting WRONG,
    // but doesn't prevent the network from committing the block A
    // observes.
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });

    // 3 prevotes for HASH_B from others
    for (const v of others) {
      ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 1, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    // Now we should be in precommit phase with our NIL precommit cast
    assert.equal(ctrl.getPhase(), 'precommit');

    // 3 precommits for HASH_B from others
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'precommit', height: 1, round: 1, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }

    // commit-block emitted for HASH_B — our local controller
    // observes the network's quorum and recognizes the commit even
    // though our own precommit was NIL.
    const commits = findActions(lastActions, 'commit-block');
    assert.equal(commits.length, 1);
    if (commits[0].type === 'commit-block') {
      assert.equal(commits[0].blockHash, HASH_B);
      // Cert has 3 signers (the others; our NIL didn't count for HASH_B)
      assert.equal(commits[0].certificate.precommits.length, 3);
    }
    assert.equal(ctrl.getPhase(), 'committed');
  });

  it('lock applies on prevote AND precommit (full symmetry)', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });

    // Receive a proposal for HASH_B (different from lock)
    const r1Proposer = selectProposer(env.set.listActive(), 1, 'lock-seed', 1)!;
    const r1ProposerHandle = env.validators.find(
      (v) => v.accountId === r1Proposer.accountId,
    )!;
    const signedProposal = signProposal({
      height: 1,
      round: 1,
      blockHash: HASH_B,
      proposerAccountId: r1Proposer.accountId,
      proposerPublicKey: r1ProposerHandle.identity.publicKey,
      proposerSecretKey: r1ProposerHandle.identity.secretKey,
    });

    const proposalActions = ctrl.handle({ type: 'received-proposal', proposal: signedProposal });
    // Our prevote on this proposal: locked on A, asked to vote B → NIL
    const prevoteVotes = findActions(proposalActions, 'broadcast-vote').filter(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'prevote',
    );
    assert.equal(prevoteVotes.length, 1);
    if (prevoteVotes[0].type === 'broadcast-vote') {
      assert.equal(prevoteVotes[0].vote.blockHash, null, 'locked → prevote NIL');
    }

    // Now drive prevote quorum on HASH_B from others
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 1, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    // Our precommit: locked on A, quorum on B → NIL
    const precommits = findActions(lastActions, 'broadcast-vote').filter(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'precommit',
    );
    assert.equal(precommits.length, 1);
    if (precommits[0].type === 'broadcast-vote') {
      assert.equal(precommits[0].vote.blockHash, null, 'locked → precommit NIL too');
    }
  });
});
