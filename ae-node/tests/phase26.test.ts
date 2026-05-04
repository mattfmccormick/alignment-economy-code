// Phase 26: BFT driver — round-lifecycle glue.
//
// The driver wraps RoundController with a transport (for proposals + votes)
// and a clock (for timeouts), and manages the loop:
//
//   commit  → advance to height+1, round 0
//   advance → same height, round+1
//
// Tests use a deterministic in-memory transport bus and a manual clock so
// every step is observable. No real WebSockets, no setTimeout.
//
// Verified:
//   1. start() builds round 0 and fires the controller's start event.
//      Proposer node broadcasts proposal + own prevote.
//   2. Receiving proposal + 2 prevotes + 2 precommits drives a clean
//      commit-block, onCommit fires with the right height/hash/cert.
//   3. After commit, driver advances to height+1, round 0, fresh
//      controller, fresh proposer.
//   4. Manual clock tick triggers propose-timeout in the controller →
//      NIL prevote broadcast.
//   5. NIL precommit quorum drives advance-round; onRoundFailed fires;
//      same height, round bumps.
//   6. Out-of-bucket proposals/votes are silently dropped (height or
//      round mismatch).
//   7. stop() cancels pending timers; further events are no-ops.
//   8. Follower mode: tracks rounds, commits on quorum, never broadcasts.

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
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
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

/** Test transport: lets us push events in and observes outgoing broadcasts. */
class FakeTransport implements IBftTransport {
  proposalsOut: Proposal[] = [];
  votesOut: Vote[] = [];
  private proposalHandlers: Array<(p: Proposal) => void> = [];
  private voteHandlers: Array<(v: Vote) => void> = [];

  broadcastProposal(p: Proposal): void {
    this.proposalsOut.push(p);
  }
  broadcastVote(v: Vote): void {
    this.votesOut.push(v);
  }
  onProposal(h: (p: Proposal) => void): void {
    this.proposalHandlers.push(h);
  }
  onVote(h: (v: Vote) => void): void {
    this.voteHandlers.push(h);
  }
  /** Inject a proposal as if it came over the wire. */
  pushProposal(p: Proposal): void {
    for (const h of this.proposalHandlers) h(p);
  }
  /** Inject a vote as if it came over the wire. */
  pushVote(v: Vote): void {
    for (const h of this.voteHandlers) h(v);
  }
}

/** Manual clock: tests pump time forward explicitly. */
class FakeClock implements IBftClock {
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; cb: () => void }>();
  private nowMs = 0;

  setTimeout(callback: () => void, durationMs: number): TimerId {
    const id = this.nextId++;
    this.pending.set(id, { fireAt: this.nowMs + durationMs, cb: callback });
    return id;
  }
  clearTimeout(id: TimerId): void {
    this.pending.delete(id as number);
  }
  /** Advance time by `ms`, firing any callbacks scheduled in that window. */
  tick(ms: number): void {
    this.nowMs += ms;
    // Iterate by snapshot so callbacks scheduling new timers don't infinite-loop
    const due: Array<[number, () => void]> = [];
    for (const [id, t] of this.pending) if (t.fireAt <= this.nowMs) due.push([id, t.cb]);
    for (const [id] of due) this.pending.delete(id);
    for (const [, cb] of due) cb();
  }
  pendingCount(): number {
    return this.pending.size;
  }
}

const HASH_A = 'aa'.repeat(32);

describe('Phase 26: BFT driver', () => {
  let env: ReturnType<typeof setupValidators>;
  /** The validator selected to propose at height 1, seed='seed-1'. */
  let proposer: ValidatorHandle;
  /** A non-proposer (used for "follower-as-local" perspective). */
  let nonProposer: ValidatorHandle;

  const proposerSeedFor = (h: number) => `seed-${h}`;

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
    const sel = selectProposer(env.set.listActive(), 1, proposerSeedFor(1))!;
    proposer = env.validators.find((v) => v.accountId === sel.accountId)!;
    nonProposer = env.validators.find((v) => v.accountId !== sel.accountId)!;
  });

  // ── start as proposer broadcasts proposal + prevote ──────────────────

  it('start as proposer broadcasts a proposal and own prevote', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const commits: Array<{ height: number; hash: string }> = [];

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: proposer.accountId,
        publicKey: proposer.identity.publicKey,
        secretKey: proposer.identity.secretKey,
      },
      blockProviderFor: () => HASH_A,
      onCommit: (h, hash) => commits.push({ height: h, hash }),
    });
    driver.start();

    assert.equal(transport.proposalsOut.length, 1);
    assert.equal(transport.proposalsOut[0].blockHash, HASH_A);
    assert.equal(transport.votesOut.length, 1);
    assert.equal(transport.votesOut[0].kind, 'prevote');
    assert.equal(driver.getCurrentPhase(), 'prevote');
    assert.equal(commits.length, 0);
    driver.stop();
  });

  // ── happy-path commit advances to next height ───────────────────────

  it('happy-path commit advances to height+1 with a fresh round', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const commits: Array<{ height: number; hash: string; cert: CommitCertificate }> = [];

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: proposer.accountId,
        publicKey: proposer.identity.publicKey,
        secretKey: proposer.identity.secretKey,
      },
      blockProviderFor: () => HASH_A,
      onCommit: (height, hash, cert) => commits.push({ height, hash, cert }),
    });
    driver.start();

    // Two other validators send prevotes for HASH_A → quorum
    const others = env.validators
      .filter((v) => v.accountId !== proposer.accountId)
      .slice(0, 2);
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
    // Now driver is in precommit phase; same two validators send precommits
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

    assert.equal(commits.length, 1);
    assert.equal(commits[0].height, 1);
    assert.equal(commits[0].hash, HASH_A);
    assert.equal(commits[0].cert.precommits.length, 3);

    // Driver advanced to height 2, round 0
    assert.equal(driver.getCurrentHeight(), 2);
    assert.equal(driver.getCurrentRound(), 0);

    driver.stop();
  });

  // ── propose-timeout drives NIL prevote ──────────────────────────────

  it('propose-timeout makes a non-proposer broadcast NIL prevote', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: nonProposer.accountId,
        publicKey: nonProposer.identity.publicKey,
        secretKey: nonProposer.identity.secretKey,
      },
      onCommit: () => {},
      timeouts: { propose: 100 },
    });
    driver.start();
    // No proposal yet; only set-timeout(propose) was scheduled
    assert.equal(transport.votesOut.length, 0);
    assert.equal(clock.pendingCount(), 1);

    clock.tick(100); // propose timeout fires
    assert.equal(transport.votesOut.length, 1);
    assert.equal(transport.votesOut[0].kind, 'prevote');
    assert.equal(transport.votesOut[0].blockHash, null);
    assert.equal(driver.getCurrentPhase(), 'prevote');

    driver.stop();
  });

  // ── NIL precommit quorum advances round ─────────────────────────────

  it('NIL precommit quorum advances to round+1, same height', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const failedRounds: Array<{ height: number; round: number }> = [];

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: nonProposer.accountId,
        publicKey: nonProposer.identity.publicKey,
        secretKey: nonProposer.identity.secretKey,
      },
      onCommit: () => {},
      onRoundFailed: (h, r) => failedRounds.push({ height: h, round: r }),
      timeouts: { propose: 100, prevote: 50, precommit: 50 },
    });
    driver.start();

    clock.tick(100); // propose timeout → NIL prevote
    clock.tick(50); // prevote timeout → NIL precommit

    // Now drive 2 other NIL precommits to hit quorum
    const others = env.validators
      .filter((v) => v.accountId !== nonProposer.accountId)
      .slice(0, 2);
    for (const v of others) {
      transport.pushVote(
        signVote({
          kind: 'precommit',
          height: 1,
          round: 0,
          blockHash: null,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }

    assert.equal(failedRounds.length, 1);
    assert.deepEqual(failedRounds[0], { height: 1, round: 0 });
    // Same height, round bumped
    assert.equal(driver.getCurrentHeight(), 1);
    assert.equal(driver.getCurrentRound(), 1);
    driver.stop();
  });

  // ── precommit-timeout also advances the round ───────────────────────

  it('precommit-timeout advances the round when no quorum forms', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: nonProposer.accountId,
        publicKey: nonProposer.identity.publicKey,
        secretKey: nonProposer.identity.secretKey,
      },
      onCommit: () => {},
      timeouts: { propose: 100, prevote: 50, precommit: 50 },
    });
    driver.start();
    clock.tick(100); // propose-timeout → NIL prevote
    clock.tick(50); // prevote-timeout → NIL precommit
    clock.tick(50); // precommit-timeout → advance-round
    assert.equal(driver.getCurrentRound(), 1);
    driver.stop();
  });

  // ── out-of-bucket events are dropped ─────────────────────────────────

  it('drops proposals/votes that are not for the current (height, round)', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: nonProposer.accountId,
        publicKey: nonProposer.identity.publicKey,
        secretKey: nonProposer.identity.secretKey,
      },
      onCommit: () => {},
      timeouts: { propose: 1_000, prevote: 1_000, precommit: 1_000 },
    });
    driver.start();
    const before = transport.votesOut.length;

    // A vote for a different height
    transport.pushVote(
      signVote({
        kind: 'prevote',
        height: 99,
        round: 0,
        blockHash: HASH_A,
        validatorAccountId: env.validators[0].accountId,
        validatorPublicKey: env.validators[0].identity.publicKey,
        validatorSecretKey: env.validators[0].identity.secretKey,
      }),
    );
    assert.equal(transport.votesOut.length, before, 'driver must not act on out-of-bucket vote');

    driver.stop();
  });

  // ── stop() cancels timers ────────────────────────────────────────────

  it('stop() cancels pending timers; further events are no-ops', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      localValidator: {
        accountId: nonProposer.accountId,
        publicKey: nonProposer.identity.publicKey,
        secretKey: nonProposer.identity.secretKey,
      },
      onCommit: () => {},
      timeouts: { propose: 100, prevote: 100, precommit: 100 },
    });
    driver.start();
    assert.ok(clock.pendingCount() > 0);

    driver.stop();
    assert.equal(clock.pendingCount(), 0);

    // Tick past timeouts; no votes should fire because driver stopped
    const beforeVotes = transport.votesOut.length;
    clock.tick(10_000);
    assert.equal(transport.votesOut.length, beforeVotes);
  });

  // ── follower mode (no localValidator) commits on observed quorum ────

  it('follower mode commits on observed quorum without broadcasting', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    let committedHeight = -1;
    let committedHash: string | null = null;

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor,
      // no localValidator
      onCommit: (h, hash) => {
        committedHeight = h;
        committedHash = hash;
      },
      timeouts: { propose: 100, prevote: 100, precommit: 100 },
    });
    driver.start();

    // Three validators send prevotes + precommits
    const voters = env.validators.slice(0, 3);
    for (const v of voters) {
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
    for (const v of voters) {
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

    assert.equal(committedHeight, 1);
    assert.equal(committedHash, HASH_A);
    // Follower never broadcast anything
    assert.equal(transport.proposalsOut.length, 0);
    assert.equal(transport.votesOut.length, 0);
    // Advanced to next height
    assert.equal(driver.getCurrentHeight(), 2);
    driver.stop();
  });
});
