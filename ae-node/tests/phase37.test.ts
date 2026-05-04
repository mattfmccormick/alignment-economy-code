// Phase 37: Locking-on-precommit (Tendermint safety property).
//
// Once a validator precommits a real (non-NIL) block at (height H, round R),
// they're "locked" on it. In any later round at height H, they refuse to
// prevote a different block — the locking rule downgrades any non-matching
// prevote to NIL. Lock clears when chain head advances to height H+1.
//
// Why this matters: it's the safety property that prevents 1/3+ Byzantine
// validators from forking the chain. Without it, an attacker could
// convince an honest validator to flip their vote across rounds, leading
// to two different commits at the same height.
//
// What's verified:
//   1. RoundController unit-level
//      - precommitting a real block emits a set-lock action
//      - precommitting NIL does NOT emit set-lock
//      - a fresh round started with priorLock + matching proposal
//        prevotes the locked hash normally
//      - a fresh round started with priorLock + DIFFERENT proposal
//        downgrades the prevote to NIL
//   2. BftDriver lifecycle
//      - currentLock starts null
//      - set-lock action stores the lock
//      - lock survives advance-round into the next round
//      - lock CLEARS when commit-block advances height
//
// Polka unlock (allowing a locked validator to prevote a new block when
// they observe 2/3+ prevotes for it at a higher round) is intentionally
// NOT yet implemented — see RoundControllerConfig.priorLock docs.

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
import { signProposal } from '../src/core/consensus/proposal.js';
import { signVote } from '../src/core/consensus/votes.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import {
  RoundController,
  type LocalValidator,
  type LockState,
  type RoundAction,
} from '../src/core/consensus/round-controller.js';
import {
  BftDriver,
  type IBftClock,
  type IBftTransport,
  type TimerId,
} from '../src/core/consensus/bft-driver.js';
import type { Proposal } from '../src/core/consensus/proposal.js';
import type { Vote } from '../src/core/consensus/votes.js';
import type { CommitCertificate } from '../src/core/consensus/commit-certificate.js';
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

describe('Phase 37: Locking-on-precommit', () => {
  let env: ReturnType<typeof setupValidators>;
  let proposer: ValidatorHandle;
  let nonProposer: ValidatorHandle;

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
    const sel = selectProposer(env.set.listActive(), 1, 'lock-seed', 0)!;
    proposer = env.validators.find((v) => v.accountId === sel.accountId)!;
    nonProposer = env.validators.find((v) => v.accountId !== sel.accountId)!;
  });

  // ── RoundController: set-lock on real precommit ─────────────────────

  it('precommitting a real block emits a set-lock action', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(proposer),
      blockProvider: () => HASH_A,
    });
    ctrl.handle({ type: 'start' });

    // Drive prevote quorum on HASH_A
    const others = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
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

    // The transition into precommit emitted a set-lock alongside the broadcast-vote
    const locks = findActions(lastActions, 'set-lock');
    assert.equal(locks.length, 1, 'should emit set-lock when precommitting real block');
    if (locks[0].type === 'set-lock') {
      assert.equal(locks[0].lockState.blockHash, HASH_A);
      assert.equal(locks[0].lockState.round, 0);
    }
  });

  it('precommitting NIL does NOT emit a set-lock action', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 0,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(nonProposer),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' }); // NIL prevote
    const actions = ctrl.handle({ type: 'prevote-timeout' }); // NIL precommit

    const locks = findActions(actions, 'set-lock');
    assert.equal(locks.length, 0, 'NIL precommit must not emit set-lock');
  });

  // ── RoundController: priorLock honored in prevote ───────────────────

  it('priorLock + matching proposal: prevotes the locked hash normally', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(nonProposer),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });

    // Round 1's proposer might be A or someone else — just inject a
    // proposal for HASH_A that matches the lock.
    const r1Proposer = selectProposer(env.set.listActive(), 1, 'lock-seed', 1)!;
    const r1ProposerHandle = env.validators.find((v) => v.accountId === r1Proposer.accountId)!;
    const proposal = signProposal({
      height: 1,
      round: 1,
      blockHash: HASH_A,
      proposerAccountId: r1Proposer.accountId,
      proposerPublicKey: r1ProposerHandle.identity.publicKey,
      proposerSecretKey: r1ProposerHandle.identity.secretKey,
    });

    const actions = ctrl.handle({ type: 'received-proposal', proposal });
    const votes = findActions(actions, 'broadcast-vote');
    assert.equal(votes.length, 1);
    if (votes[0].type === 'broadcast-vote') {
      assert.equal(votes[0].vote.kind, 'prevote');
      assert.equal(
        votes[0].vote.blockHash,
        HASH_A,
        'matching proposal: prevote the locked hash',
      );
    }
  });

  it('priorLock + DIFFERENT proposal: downgrades prevote to NIL', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(nonProposer),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });

    const r1Proposer = selectProposer(env.set.listActive(), 1, 'lock-seed', 1)!;
    const r1ProposerHandle = env.validators.find((v) => v.accountId === r1Proposer.accountId)!;
    const proposal = signProposal({
      height: 1,
      round: 1,
      blockHash: HASH_B, // different from lock!
      proposerAccountId: r1Proposer.accountId,
      proposerPublicKey: r1ProposerHandle.identity.publicKey,
      proposerSecretKey: r1ProposerHandle.identity.secretKey,
    });

    const actions = ctrl.handle({ type: 'received-proposal', proposal });
    const votes = findActions(actions, 'broadcast-vote');
    assert.equal(votes.length, 1);
    if (votes[0].type === 'broadcast-vote') {
      assert.equal(votes[0].vote.kind, 'prevote');
      assert.equal(
        votes[0].vote.blockHash,
        null,
        'different proposal under lock: prevote MUST be NIL',
      );
    }
  });

  it('priorLock without proposal (timeout): NIL prevote (lock-or-NIL semantics)', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'lock-seed',
      localValidator: asLocal(nonProposer),
      priorLock: { blockHash: HASH_A, round: 0 },
    });
    ctrl.handle({ type: 'start' });
    const actions = ctrl.handle({ type: 'propose-timeout' });
    const votes = findActions(actions, 'broadcast-vote');
    assert.equal(votes.length, 1);
    if (votes[0].type === 'broadcast-vote') {
      assert.equal(votes[0].vote.blockHash, null);
    }
  });

  // ── BftDriver: lock state lifecycle ─────────────────────────────────

  /** Test transport that captures broadcasts but doesn't relay. */
  class FakeTransport implements IBftTransport {
    proposalsOut: Proposal[] = [];
    votesOut: Vote[] = [];
    private proposalHandlers: Array<(p: Proposal) => void> = [];
    private voteHandlers: Array<(v: Vote) => void> = [];
    broadcastProposal(p: Proposal) { this.proposalsOut.push(p); }
    broadcastVote(v: Vote) { this.votesOut.push(v); }
    onProposal(h: (p: Proposal) => void) { this.proposalHandlers.push(h); }
    onVote(h: (v: Vote) => void) { this.voteHandlers.push(h); }
    pushVote(v: Vote) { for (const h of this.voteHandlers) h(v); }
  }

  class FakeClock implements IBftClock {
    private nextId = 1;
    private pending = new Map<number, { fireAt: number; cb: () => void }>();
    private nowMs = 0;
    setTimeout(cb: () => void, ms: number): TimerId {
      const id = this.nextId++;
      this.pending.set(id, { fireAt: this.nowMs + ms, cb });
      return id;
    }
    clearTimeout(id: TimerId) { this.pending.delete(id as number); }
    tick(ms: number) {
      this.nowMs += ms;
      const due: Array<[number, () => void]> = [];
      for (const [id, t] of this.pending) if (t.fireAt <= this.nowMs) due.push([id, t.cb]);
      for (const [id] of due) this.pending.delete(id);
      for (const [, cb] of due) cb();
    }
  }

  it('BftDriver currentLock: starts null, set on real precommit, cleared on commit', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const commits: Array<{ height: number; hash: string }> = [];

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'lock-seed',
      localValidator: asLocal(proposer),
      blockProviderFor: () => HASH_A,
      onCommit: (h, hash) => commits.push({ height: h, hash }),
      timeouts: { propose: 100, prevote: 50, precommit: 50 },
    });
    driver.start();

    // Initially no lock
    assert.equal(driver.getCurrentLock(), null);

    // Drive 2 prevotes from others to trigger our precommit
    const others = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
    for (const v of others) {
      transport.pushVote(
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
    // After our local precommit, lock is set
    const lock = driver.getCurrentLock();
    assert.ok(lock, 'lock should be set after precommitting real block');
    assert.equal(lock!.blockHash, HASH_A);
    assert.equal(lock!.round, 0);

    // Drive 2 precommits to reach commit
    for (const v of others) {
      transport.pushVote(
        signVote({
          kind: 'precommit',
          height: 1,
          round: 0,
          blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }

    // Commit fired; height advanced; lock cleared
    assert.equal(commits.length, 1);
    assert.equal(driver.getCurrentLock(), null, 'lock must clear when height advances');
    driver.stop();
  });

  it('BftDriver carries lock across NIL-advance rounds at the same height', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'lock-seed',
      localValidator: asLocal(proposer),
      blockProviderFor: () => HASH_A,
      onCommit: () => {},
      timeouts: { propose: 100, prevote: 50, precommit: 50 },
    });
    driver.start();

    // Get to a precommit on HASH_A in round 0 (drive prevote quorum)
    const others = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
    for (const v of others) {
      transport.pushVote(
        signVote({
          kind: 'prevote',
          height: 1, round: 0, blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    assert.ok(driver.getCurrentLock(), 'lock should be set after our precommit');

    // Now precommit phase times out (nobody else precommits) → advance round
    clock.tick(50);
    assert.equal(driver.getCurrentRound(), 1, 'should be in round 1 now');
    assert.ok(driver.getCurrentLock(), 'lock must survive into the next round at same height');
    assert.equal(driver.getCurrentLock()!.blockHash, HASH_A);
    driver.stop();
  });
});
