// Phase 25: BFT round state machine.
//
// Drives the round controller through every phase transition without
// any timers or network — events are pushed in directly and the
// returned actions are inspected.
//
//   1. Start as proposer: emits broadcast-proposal + own prevote.
//   2. Start as non-proposer: emits set-timeout(propose) and waits.
//   3. received-proposal from the right proposer triggers prevote.
//   4. received-proposal from the WRONG proposer is ignored.
//   5. propose-timeout → NIL prevote.
//   6. 2/3+ prevotes for hash → precommit.
//   7. 2/3+ NIL prevotes → precommit NIL.
//   8. prevote-timeout (no quorum) → precommit NIL.
//   9. 2/3+ precommits for hash → commit-block + CommitCertificate.
//  10. 2/3+ NIL precommits → advance-round.
//  11. precommit-timeout → advance-round.
//  12. polka without proposal: 2/3+ prevotes arrive before the proposal,
//      controller skips ahead to precommit.
//  13. follower mode: tracks votes, never broadcasts; commits when sees
//      2/3+ precommits.
//  14. once committed/failed, further events are ignored.

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
  type RoundAction,
  type LocalValidator,
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

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

function findActions(actions: RoundAction[], type: RoundAction['type']): RoundAction[] {
  return actions.filter((a) => a.type === type);
}

describe('Phase 25: Round state machine', () => {
  let env: ReturnType<typeof setupValidators>;
  /** The validator selected to propose at height=1 round=0 with seed='seed-h1'. */
  let proposer: ValidatorHandle;
  /** A non-proposer validator, useful as the local node in follower-perspective tests. */
  let nonProposer: ValidatorHandle;

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
    const sel = selectProposer(env.set.listActive(), 1, 'seed-h1')!;
    proposer = env.validators.find((v) => v.accountId === sel.accountId)!;
    nonProposer = env.validators.find((v) => v.accountId !== sel.accountId)!;
  });

  // ── Start as proposer ────────────────────────────────────────────────

  it('start as the proposer: emits broadcast-proposal + own prevote + prevote-timeout', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(proposer),
      blockProvider: () => HASH_A,
    });
    const actions = ctrl.handle({ type: 'start' });

    const props = findActions(actions, 'broadcast-proposal');
    const votes = findActions(actions, 'broadcast-vote');
    const timers = findActions(actions, 'set-timeout');
    assert.equal(props.length, 1);
    assert.equal(votes.length, 1);
    assert.equal(timers.length, 1);

    const prop = props[0];
    if (prop.type === 'broadcast-proposal') {
      assert.equal(prop.proposal.height, 1);
      assert.equal(prop.proposal.blockHash, HASH_A);
      assert.equal(prop.proposal.proposerAccountId, proposer.accountId);
    }

    const vote = votes[0];
    if (vote.type === 'broadcast-vote') {
      assert.equal(vote.vote.kind, 'prevote');
      assert.equal(vote.vote.blockHash, HASH_A);
    }

    const t = timers[0];
    if (t.type === 'set-timeout') assert.equal(t.phase, 'prevote');

    assert.equal(ctrl.getPhase(), 'prevote');
  });

  // ── Start as non-proposer ────────────────────────────────────────────

  it('start as non-proposer: only sets propose-timeout, waits for proposal', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    const actions = ctrl.handle({ type: 'start' });
    assert.equal(findActions(actions, 'broadcast-proposal').length, 0);
    assert.equal(findActions(actions, 'broadcast-vote').length, 0);
    const timers = findActions(actions, 'set-timeout');
    assert.equal(timers.length, 1);
    if (timers[0].type === 'set-timeout') assert.equal(timers[0].phase, 'propose');
    assert.equal(ctrl.getPhase(), 'propose');
  });

  // ── Receiving a valid proposal ───────────────────────────────────────

  it('received-proposal from the legitimate proposer triggers prevote', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });

    const proposal = signProposal({
      height: 1,
      round: 0,
      blockHash: HASH_A,
      proposerAccountId: proposer.accountId,
      proposerPublicKey: proposer.identity.publicKey,
      proposerSecretKey: proposer.identity.secretKey,
    });

    const actions = ctrl.handle({ type: 'received-proposal', proposal });
    const votes = findActions(actions, 'broadcast-vote');
    assert.equal(votes.length, 1);
    if (votes[0].type === 'broadcast-vote') {
      assert.equal(votes[0].vote.kind, 'prevote');
      assert.equal(votes[0].vote.blockHash, HASH_A);
    }
    assert.equal(ctrl.getPhase(), 'prevote');
  });

  it('received-proposal from the WRONG proposer is ignored', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });

    // nonProposer signs a proposal pretending to be proposer
    const fakeProp = signProposal({
      height: 1,
      round: 0,
      blockHash: HASH_A,
      proposerAccountId: nonProposer.accountId,
      proposerPublicKey: nonProposer.identity.publicKey,
      proposerSecretKey: nonProposer.identity.secretKey,
    });
    const actions = ctrl.handle({ type: 'received-proposal', proposal: fakeProp });
    assert.equal(actions.length, 0);
    assert.equal(ctrl.getPhase(), 'propose');
  });

  it('received-proposal with bad signature is ignored', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });

    const proposal = signProposal({
      height: 1,
      round: 0,
      blockHash: HASH_A,
      proposerAccountId: proposer.accountId,
      proposerPublicKey: proposer.identity.publicKey,
      proposerSecretKey: proposer.identity.secretKey,
    });
    // Tamper the signature
    const tampered = {
      ...proposal,
      signature: proposal.signature.slice(0, -2) + ((parseInt(proposal.signature.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')),
    };
    const actions = ctrl.handle({ type: 'received-proposal', proposal: tampered });
    assert.equal(actions.length, 0);
    assert.equal(ctrl.getPhase(), 'propose');
  });

  // ── Propose timeout ──────────────────────────────────────────────────

  it('propose-timeout casts NIL prevote', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    const actions = ctrl.handle({ type: 'propose-timeout' });
    const votes = findActions(actions, 'broadcast-vote');
    assert.equal(votes.length, 1);
    if (votes[0].type === 'broadcast-vote') {
      assert.equal(votes[0].vote.kind, 'prevote');
      assert.equal(votes[0].vote.blockHash, null);
    }
    assert.equal(ctrl.getPhase(), 'prevote');
  });

  // ── Prevote → precommit ─────────────────────────────────────────────

  it('2/3+ prevotes for the same hash triggers precommit', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(proposer),
      blockProvider: () => HASH_A,
    });
    ctrl.handle({ type: 'start' }); // proposer's own prevote already in
    // Need 2 more validators' prevotes to hit quorum=3
    const others = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      const vote = signVote({
        kind: 'prevote',
        height: 1,
        round: 0,
        blockHash: HASH_A,
        validatorAccountId: v.accountId,
        validatorPublicKey: v.identity.publicKey,
        validatorSecretKey: v.identity.secretKey,
      });
      lastActions = ctrl.handle({ type: 'received-vote', vote });
    }
    const precommits = findActions(lastActions, 'broadcast-vote');
    assert.equal(precommits.length, 1);
    if (precommits[0].type === 'broadcast-vote') {
      assert.equal(precommits[0].vote.kind, 'precommit');
      assert.equal(precommits[0].vote.blockHash, HASH_A);
    }
    assert.equal(ctrl.getPhase(), 'precommit');
  });

  it('2/3+ NIL prevotes triggers NIL precommit', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' }); // local NIL prevote
    // Two more NIL prevotes from other validators
    const others = env.validators.filter((v) => v.accountId !== nonProposer.accountId).slice(0, 2);
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      const vote = signVote({
        kind: 'prevote',
        height: 1,
        round: 0,
        blockHash: null,
        validatorAccountId: v.accountId,
        validatorPublicKey: v.identity.publicKey,
        validatorSecretKey: v.identity.secretKey,
      });
      lastActions = ctrl.handle({ type: 'received-vote', vote });
    }
    const precommits = findActions(lastActions, 'broadcast-vote');
    assert.equal(precommits.length, 1);
    if (precommits[0].type === 'broadcast-vote') {
      assert.equal(precommits[0].vote.kind, 'precommit');
      assert.equal(precommits[0].vote.blockHash, null);
    }
    assert.equal(ctrl.getPhase(), 'precommit');
  });

  it('prevote-timeout casts NIL precommit', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });
    const actions = ctrl.handle({ type: 'prevote-timeout' });
    const votes = findActions(actions, 'broadcast-vote');
    assert.equal(votes.length, 1);
    if (votes[0].type === 'broadcast-vote') {
      assert.equal(votes[0].vote.kind, 'precommit');
      assert.equal(votes[0].vote.blockHash, null);
    }
    assert.equal(ctrl.getPhase(), 'precommit');
  });

  // ── Precommit → commit ──────────────────────────────────────────────

  it('2/3+ precommits for the same hash triggers commit-block', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(proposer),
      blockProvider: () => HASH_A,
    });
    ctrl.handle({ type: 'start' });
    const others = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
    // Drive prevote quorum
    for (const v of others) {
      ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    // Now drive precommit quorum
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'precommit',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    const commits = findActions(lastActions, 'commit-block');
    assert.equal(commits.length, 1);
    if (commits[0].type === 'commit-block') {
      assert.equal(commits[0].blockHash, HASH_A);
      assert.equal(commits[0].certificate.precommits.length, 3);
    }
    assert.equal(ctrl.getPhase(), 'committed');
    assert.ok(ctrl.getCommitCertificate());
  });

  it('2/3+ NIL precommits triggers advance-round', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });
    ctrl.handle({ type: 'prevote-timeout' }); // local NIL precommit cast
    const others = env.validators.filter((v) => v.accountId !== nonProposer.accountId).slice(0, 2);
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'precommit',
          height: 1,
          round: 0,
          blockHash: null,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    assert.equal(findActions(lastActions, 'advance-round').length, 1);
    assert.equal(ctrl.getPhase(), 'failed');
  });

  it('precommit-timeout triggers advance-round', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });
    ctrl.handle({ type: 'prevote-timeout' });
    const actions = ctrl.handle({ type: 'precommit-timeout' });
    assert.equal(findActions(actions, 'advance-round').length, 1);
    assert.equal(ctrl.getPhase(), 'failed');
  });

  // ── Polka without proposal ───────────────────────────────────────────

  it('polka without proposal: skips ahead to precommit when prevote quorum lands first', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' }); // we're in propose phase, no proposal yet
    // 3 OTHER validators all submit prevotes for HASH_A (none of which is local)
    const others = env.validators.filter((v) => v.accountId !== nonProposer.accountId);
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    // Once we cross quorum=3, controller skips ahead: casts our own
    // prevote AND our precommit on HASH_A.
    const broadcasts = findActions(lastActions, 'broadcast-vote');
    assert.ok(broadcasts.length >= 1);
    const kinds = broadcasts.map((a) => a.type === 'broadcast-vote' ? a.vote.kind : '');
    assert.ok(kinds.includes('precommit'));
    assert.equal(ctrl.getPhase(), 'precommit');
  });

  // ── Follower mode ────────────────────────────────────────────────────

  it('follower mode (no localValidator): tracks votes, never broadcasts, commits when sees quorum', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      // localValidator deliberately omitted
    });
    const startActions = ctrl.handle({ type: 'start' });
    // Follower still sets a propose-timeout so it stays event-driven
    assert.equal(findActions(startActions, 'broadcast-proposal').length, 0);
    assert.equal(findActions(startActions, 'broadcast-vote').length, 0);

    // The proposal arrives
    const proposal = signProposal({
      height: 1,
      round: 0,
      blockHash: HASH_A,
      proposerAccountId: proposer.accountId,
      proposerPublicKey: proposer.identity.publicKey,
      proposerSecretKey: proposer.identity.secretKey,
    });
    const propActions = ctrl.handle({ type: 'received-proposal', proposal });
    // Follower transitions to prevote phase (so quorum tracking continues)
    // but emits no broadcast-vote
    assert.equal(findActions(propActions, 'broadcast-vote').length, 0);
    assert.equal(ctrl.getPhase(), 'prevote');

    // 3 validators' prevotes land — quorum reached
    for (const v of env.validators.slice(0, 3)) {
      ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    // Follower should have transitioned to precommit. (Even without local
    // votes, the prevote VoteSet hit quorum.)
    assert.equal(ctrl.getPhase(), 'precommit');

    // 3 precommits land
    let lastActions: RoundAction[] = [];
    for (const v of env.validators.slice(0, 3)) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'precommit',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    // Follower commits (even without having voted itself)
    assert.equal(findActions(lastActions, 'commit-block').length, 1);
    assert.equal(ctrl.getPhase(), 'committed');
  });

  // ── Terminal-state events are ignored ────────────────────────────────

  it('events after committed/failed are ignored', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'seed-h1',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });
    ctrl.handle({ type: 'prevote-timeout' });
    ctrl.handle({ type: 'precommit-timeout' });
    assert.equal(ctrl.getPhase(), 'failed');

    // Now spam more events — should all be no-ops
    const aftermath = ctrl.handle({ type: 'propose-timeout' });
    assert.equal(aftermath.length, 0);
    assert.equal(ctrl.getPhase(), 'failed');
  });
});
