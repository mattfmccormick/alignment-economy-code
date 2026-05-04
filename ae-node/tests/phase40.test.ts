// Phase 40: Dynamic timeouts per NIL round.
//
// When a round NIL-times-out (network was slow, proposer offline,
// partition healing), the next round's timeouts grow so the network
// has more headroom to settle. Without scaling, a noisy network can
// NIL-loop forever at the same fast timeouts.
//
// Scaling formula: effectiveTimeout = baseTimeout + step * round.
// Reset to base on commit (height advance).
//
// Verified:
//   1. Round 0 uses base timeouts.
//   2. Round 1 adds (1 * step) to each phase.
//   3. Round N adds (N * step).
//   4. Custom timeoutScaling honored.
//   5. {0,0,0} scaling disables growth — every round uses base.
//   6. Reset on commit: after a successful commit, the next height's
//      round 0 is back at base timeouts.
//
// Implementation observed via the set-timeout actions emitted by the
// driver — each one carries the durationMs the controller asked for.

import { describe, it } from 'node:test';
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
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import {
  BftDriver,
  type IBftClock,
  type IBftTransport,
  type TimerId,
} from '../src/core/consensus/bft-driver.js';
import type { Proposal } from '../src/core/consensus/proposal.js';
import type { Vote } from '../src/core/consensus/votes.js';
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

class FakeTransport implements IBftTransport {
  proposalsOut: Proposal[] = [];
  votesOut: Vote[] = [];
  setTimeoutMs: number[] = [];
  private proposalHandlers: Array<(p: Proposal) => void> = [];
  private voteHandlers: Array<(v: Vote) => void> = [];
  broadcastProposal(p: Proposal) { this.proposalsOut.push(p); }
  broadcastVote(v: Vote) { this.votesOut.push(v); }
  onProposal(h: (p: Proposal) => void) { this.proposalHandlers.push(h); }
  onVote(h: (v: Vote) => void) { this.voteHandlers.push(h); }
  pushVote(v: Vote) { for (const h of this.voteHandlers) h(v); }
}

class FakeClock implements IBftClock {
  /** Captures every setTimeout duration, in order, for assertions. */
  recordedDurations: number[] = [];
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; cb: () => void }>();
  private nowMs = 0;
  setTimeout(cb: () => void, ms: number): TimerId {
    this.recordedDurations.push(ms);
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

const HASH_X = '11'.repeat(32);

describe('Phase 40: Dynamic timeouts per NIL round', () => {
  it('round 0 uses base timeouts; rounds 1+ add scaling step', () => {
    const env = setupValidators(4);
    const sel = selectProposer(env.set.listActive(), 1, 'seed', 0)!;
    const proposer = env.validators.find((v) => v.accountId === sel.accountId)!;

    const transport = new FakeTransport();
    const clock = new FakeClock();
    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'seed',
      localValidator: {
        accountId: proposer.accountId,
        publicKey: proposer.identity.publicKey,
        secretKey: proposer.identity.secretKey,
      },
      blockProviderFor: () => HASH_X,
      onCommit: () => {},
      // base 1000/500/500, step 100/50/50 — easy math
      timeouts: { propose: 1000, prevote: 500, precommit: 500 },
      timeoutScaling: { proposeStep: 100, prevoteStep: 50, precommitStep: 50 },
    });
    driver.start();

    // Round 0: proposer broadcasts proposal + own prevote, then a
    // prevote-timeout is scheduled. With 4 validators (quorum = 3) we
    // don't have quorum yet, so the next timer is for prevote.
    // Recorded so far: round 0 prevote timeout = 500.
    assert.deepEqual(clock.recordedDurations, [500], 'round 0 prevote = base 500');

    // Drive prevote-timeout to advance through phases
    clock.tick(500);
    // Now precommit-timeout scheduled at 500
    assert.deepEqual(clock.recordedDurations, [500, 500], 'round 0 precommit = base 500');

    clock.tick(500);
    // advance-round → round 1 starts. Non-proposer (seed/round changed)
    // sets a propose timeout. Round 1 propose = 1000 + 100*1 = 1100.
    // The proposer for round 1 might or might not be local; either way
    // a timeout is set.
    const round1ProposeTimeout = clock.recordedDurations[2];
    // Could be propose timeout (if local is not round 1 proposer)
    // OR prevote (if local IS round 1 proposer and broadcasts immediately)
    // The math: base 1000 + step 100 = 1100 (propose) or 500 + 50 = 550 (prevote)
    assert.ok(
      round1ProposeTimeout === 1100 || round1ProposeTimeout === 550,
      `round 1 timeout should be 1100 (propose) or 550 (prevote); got ${round1ProposeTimeout}`,
    );

    driver.stop();
  });

  it('round N uses base + step * N', () => {
    const env = setupValidators(4);
    const transport = new FakeTransport();
    const clock = new FakeClock();
    // Use a follower (no localValidator) so each round just sets a
    // propose timeout and times out — easier to observe scaling.
    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'seed',
      // No localValidator → follower mode → never proposer → propose
      // timeout fires every round
      onCommit: () => {},
      timeouts: { propose: 1000, prevote: 500, precommit: 500 },
      timeoutScaling: { proposeStep: 100, prevoteStep: 50, precommitStep: 50 },
    });
    driver.start();

    // Round 0: propose timeout = 1000
    assert.equal(clock.recordedDurations[0], 1000, 'round 0 propose = 1000');

    // tick through propose-timeout → NIL prevote → prevote-timeout
    // is set as 500 (round 0)
    clock.tick(1000);
    assert.equal(clock.recordedDurations[1], 500, 'round 0 prevote = 500');

    // tick through prevote-timeout → NIL precommit → precommit-timeout = 500
    clock.tick(500);
    assert.equal(clock.recordedDurations[2], 500, 'round 0 precommit = 500');

    // tick through precommit-timeout → advance to round 1. Round 1
    // propose timeout = 1000 + 100*1 = 1100
    clock.tick(500);
    assert.equal(clock.recordedDurations[3], 1100, 'round 1 propose = 1100');

    // round 1 prevote-timeout = 500 + 50*1 = 550
    clock.tick(1100);
    assert.equal(clock.recordedDurations[4], 550, 'round 1 prevote = 550');

    // round 1 precommit-timeout = 550
    clock.tick(550);
    assert.equal(clock.recordedDurations[5], 550, 'round 1 precommit = 550');

    // advance to round 2; propose = 1000 + 100*2 = 1200
    clock.tick(550);
    assert.equal(clock.recordedDurations[6], 1200, 'round 2 propose = 1200');

    driver.stop();
  });

  it('zero scaling disables growth — every round uses base timeouts', () => {
    const env = setupValidators(4);
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'seed',
      onCommit: () => {},
      timeouts: { propose: 800, prevote: 400, precommit: 400 },
      timeoutScaling: { proposeStep: 0, prevoteStep: 0, precommitStep: 0 },
    });
    driver.start();

    // Tick through several rounds
    for (let r = 0; r < 4; r++) {
      clock.tick(800); // propose timeout
      clock.tick(400); // prevote timeout
      clock.tick(400); // precommit timeout
    }

    // Every propose timeout should be 800, prevote 400, precommit 400.
    // Iterate the recorded sequence: pattern is [propose, prevote,
    // precommit, propose, prevote, precommit, ...] — every 3rd entry
    // is propose, etc.
    for (let i = 0; i < clock.recordedDurations.length; i++) {
      const ms = clock.recordedDurations[i];
      const phaseIdx = i % 3;
      const expected = phaseIdx === 0 ? 800 : 400;
      assert.equal(
        ms,
        expected,
        `with zero scaling, recordedDurations[${i}] should be ${expected}, got ${ms}`,
      );
    }

    driver.stop();
  });

  it('reset on commit: round 0 of next height uses base again', () => {
    const env = setupValidators(4);
    const sel = selectProposer(env.set.listActive(), 1, 'seed', 0)!;
    const proposer = env.validators.find((v) => v.accountId === sel.accountId)!;

    const transport = new FakeTransport();
    const clock = new FakeClock();
    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'seed',
      localValidator: {
        accountId: proposer.accountId,
        publicKey: proposer.identity.publicKey,
        secretKey: proposer.identity.secretKey,
      },
      blockProviderFor: () => HASH_X,
      onCommit: () => {},
      timeouts: { propose: 1000, prevote: 500, precommit: 500 },
      timeoutScaling: { proposeStep: 200, prevoteStep: 100, precommitStep: 100 },
    });
    driver.start();

    // Drive prevote + precommit quorum to commit at height 1, round 0
    const others = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
    for (const v of others) {
      transport.pushVote(
        signVote({
          kind: 'prevote', height: 1, round: 0, blockHash: HASH_X,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    for (const v of others) {
      transport.pushVote(
        signVote({
          kind: 'precommit', height: 1, round: 0, blockHash: HASH_X,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    // Driver advanced to height 2, round 0. Locked in prior height too,
    // but lock cleared on commit (Session 31).
    assert.equal(driver.getCurrentHeight(), 2);
    assert.equal(driver.getCurrentRound(), 0);

    // The latest set-timeout should be base (round 0): prevote = 500.
    // Either prevote (if local is height-2 proposer) or propose (if not).
    const last = clock.recordedDurations[clock.recordedDurations.length - 1];
    assert.ok(
      last === 1000 || last === 500,
      `after commit, height-2 round-0 timeout should be base (1000 propose or 500 prevote); got ${last}`,
    );

    driver.stop();
  });
});
