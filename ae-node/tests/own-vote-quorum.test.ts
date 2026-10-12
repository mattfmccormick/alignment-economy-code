// A validator must act on a quorum that its OWN vote completes.
//
// Quorum used to be evaluated only when a vote arrived from a peer. A node's
// own vote goes straight into its VoteSet, so when that vote was the last one
// in, nothing ever looked at the tally again and the round ran out its
// timeout. Two things followed:
//
//   - A single-validator network never committed a block. This is the "solo"
//     mode of the desktop app and the natural `npm run dev` setup, and it is
//     the only block producer that drains the chain-ordered operation lanes
//     (miner registration, vouches, panels, tags), so on a solo node all of
//     those queued forever.
//
//   - On a small multi-validator network, whichever validator was slowest in
//     a round sat on a complete quorum, then voted NIL (prevote case) or
//     failed the round while its peers committed (precommit case). At n = 3
//     quorum is unanimity, so one such NIL fails the round for everyone.
//
// The round controller now evaluates quorum after every local cast. The
// driver, in turn, must not recurse when a round finishes inside the call
// that started it, which a solo validator now does on every block.

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
import { signVote, type Vote } from '../src/core/consensus/votes.js';
import { signProposal, type Proposal } from '../src/core/consensus/proposal.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import {
  RoundController,
  type RoundAction,
  type LocalValidator,
} from '../src/core/consensus/round-controller.js';
import {
  BftDriver,
  type IBftTransport,
  type IBftClock,
  type TimerId,
} from '../src/core/consensus/bft-driver.js';
import { PRECISION } from '../src/core/constants.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

interface ValidatorHandle {
  accountId: string;
  identity: NodeIdentity;
}

function setupValidators(count: number): { set: SqliteValidatorSet; validators: ValidatorHandle[] } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
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
  return { set: new SqliteValidatorSet(db), validators };
}

function asLocal(v: ValidatorHandle): LocalValidator {
  return { accountId: v.accountId, publicKey: v.identity.publicKey, secretKey: v.identity.secretKey };
}

function vote(v: ValidatorHandle, kind: 'prevote' | 'precommit', blockHash: string | null): Vote {
  return signVote({
    kind,
    height: 1,
    round: 0,
    blockHash,
    validatorAccountId: v.accountId,
    validatorPublicKey: v.identity.publicKey,
    validatorSecretKey: v.identity.secretKey,
  });
}

function proposalFrom(v: ValidatorHandle, blockHash: string): Proposal {
  return signProposal({
    height: 1,
    round: 0,
    blockHash,
    proposerAccountId: v.accountId,
    proposerPublicKey: v.identity.publicKey,
    proposerSecretKey: v.identity.secretKey,
  });
}

function typesOf(actions: RoundAction[]): string[] {
  return actions.map((a) => a.type);
}

const SEED = 'seed-h1';
const HASH_A = 'aa'.repeat(32);

class FakeTransport implements IBftTransport {
  proposalsOut: Proposal[] = [];
  votesOut: Vote[] = [];
  broadcastProposal(p: Proposal): void { this.proposalsOut.push(p); }
  broadcastVote(v: Vote): void { this.votesOut.push(v); }
  onProposal(): void {}
  onVote(): void {}
}

/** Manual clock: nothing fires until the test says so. */
class FakeClock implements IBftClock {
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; cb: () => void }>();
  private nowMs = 0;
  setTimeout(callback: () => void, durationMs: number): TimerId {
    const id = this.nextId++;
    this.pending.set(id, { fireAt: this.nowMs + durationMs, cb: callback });
    return id;
  }
  clearTimeout(id: TimerId): void { this.pending.delete(id as number); }
  /** Advance time, firing what was due at the START of the tick (not what those callbacks schedule). */
  tick(ms: number): void {
    this.nowMs += ms;
    const due: Array<[number, () => void]> = [];
    for (const [id, t] of this.pending) if (t.fireAt <= this.nowMs) due.push([id, t.cb]);
    for (const [id] of due) this.pending.delete(id);
    for (const [, cb] of due) cb();
  }
  /** Delays (relative to now) of everything still scheduled. */
  pendingDelays(): number[] {
    return [...this.pending.values()].map((t) => t.fireAt - this.nowMs).sort((a, b) => a - b);
  }
}

describe('own vote completes the quorum: round controller', () => {
  it('a single validator commits its own proposal on start', () => {
    const { set, validators } = setupValidators(1);
    const ctrl = new RoundController({
      validatorSet: set,
      height: 1,
      round: 0,
      proposerSeed: SEED,
      localValidator: asLocal(validators[0]),
      blockProvider: () => HASH_A,
    });

    const actions = ctrl.handle({ type: 'start' });

    assert.equal(ctrl.getPhase(), 'committed');
    const commit = actions.find((a) => a.type === 'commit-block');
    assert.ok(commit && commit.type === 'commit-block', 'start returns commit-block');
    assert.equal(commit.blockHash, HASH_A);
    assert.equal(commit.certificate.precommits.length, 1, 'cert is the one precommit a quorum of one needs');
    // The full path was walked, not skipped: proposal, prevote, polka, lock, precommit, commit.
    assert.deepEqual(
      typesOf(actions).filter((t) => t !== 'set-timeout'),
      ['broadcast-proposal', 'broadcast-vote', 'observed-polka', 'broadcast-vote', 'set-lock', 'commit-block'],
    );
  });

  it('a single validator with nothing to propose fails the round as soon as the propose timeout fires', () => {
    const { set, validators } = setupValidators(1);
    const ctrl = new RoundController({
      validatorSet: set,
      height: 1,
      round: 0,
      proposerSeed: SEED,
      localValidator: asLocal(validators[0]),
      // no blockProvider: cannot propose
    });

    assert.deepEqual(typesOf(ctrl.handle({ type: 'start' })), ['set-timeout']);
    const actions = ctrl.handle({ type: 'propose-timeout' });

    // NIL prevote is a NIL quorum of one, so is the NIL precommit: no reason
    // to sit through two more timeouts.
    assert.equal(ctrl.getPhase(), 'failed');
    assert.equal(actions[actions.length - 1].type, 'advance-round');
  });

  it('a single validator that rejects its own block content votes NIL and fails the round, never commits it', () => {
    const { set, validators } = setupValidators(1);
    const ctrl = new RoundController({
      validatorSet: set,
      height: 1,
      round: 0,
      proposerSeed: SEED,
      localValidator: asLocal(validators[0]),
      blockProvider: () => HASH_A,
      validateBlockContent: () => ({ valid: false, error: 'test' }),
    });

    const actions = ctrl.handle({ type: 'start' });

    assert.equal(ctrl.getPhase(), 'failed');
    assert.equal(actions.find((a) => a.type === 'commit-block'), undefined);
    assert.equal(actions.find((a) => a.type === 'set-lock'), undefined, 'a NIL precommit never locks');
  });

  it('n=3: peers prevote before the proposal reaches us, and our prevote completing the polka makes us precommit', () => {
    const { set, validators } = setupValidators(3); // quorum = 3, i.e. everyone
    const sel = selectProposer(set.listActive(), 1, SEED)!;
    const proposer = validators.find((v) => v.accountId === sel.accountId)!;
    const [local, otherPeer] = validators.filter((v) => v.accountId !== sel.accountId);

    const ctrl = new RoundController({
      validatorSet: set,
      height: 1,
      round: 0,
      proposerSeed: SEED,
      localValidator: asLocal(local),
    });
    ctrl.handle({ type: 'start' });

    // Both peers' prevotes overtake the proposal. Two of three is not a polka,
    // so the "polka without proposal" shortcut cannot fire.
    assert.deepEqual(ctrl.handle({ type: 'received-vote', vote: vote(proposer, 'prevote', HASH_A) }), []);
    assert.deepEqual(ctrl.handle({ type: 'received-vote', vote: vote(otherPeer, 'prevote', HASH_A) }), []);
    assert.equal(ctrl.getPhase(), 'propose');

    // Now the proposal lands. Our prevote is the third of three.
    const actions = ctrl.handle({ type: 'received-proposal', proposal: proposalFrom(proposer, HASH_A) });

    assert.equal(ctrl.getPhase(), 'precommit', 'moved on without waiting for the prevote timeout');
    const cast = actions.filter((a) => a.type === 'broadcast-vote');
    assert.equal(cast.length, 2, 'prevote and precommit both cast in the same step');
    assert.ok(cast[1].type === 'broadcast-vote' && cast[1].vote.kind === 'precommit');
    assert.ok(cast[1].type === 'broadcast-vote' && cast[1].vote.blockHash === HASH_A, 'precommit is for the block, not NIL');
    assert.ok(actions.some((a) => a.type === 'observed-polka'));
  });

  it('n=3: peers precommit before we do, and our precommit completing the quorum commits the block', () => {
    const { set, validators } = setupValidators(3);
    const sel = selectProposer(set.listActive(), 1, SEED)!;
    const proposer = validators.find((v) => v.accountId === sel.accountId)!;
    const [local, otherPeer] = validators.filter((v) => v.accountId !== sel.accountId);

    const ctrl = new RoundController({
      validatorSet: set,
      height: 1,
      round: 0,
      proposerSeed: SEED,
      localValidator: asLocal(local),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'received-proposal', proposal: proposalFrom(proposer, HASH_A) });
    assert.equal(ctrl.getPhase(), 'prevote');

    // The two peers are a step ahead of us: their precommits arrive while we
    // are still collecting prevotes.
    assert.deepEqual(ctrl.handle({ type: 'received-vote', vote: vote(proposer, 'precommit', HASH_A) }), []);
    assert.deepEqual(ctrl.handle({ type: 'received-vote', vote: vote(otherPeer, 'precommit', HASH_A) }), []);

    // Their prevotes catch up. The second one completes the polka, we
    // precommit, and that precommit is the third of three.
    ctrl.handle({ type: 'received-vote', vote: vote(proposer, 'prevote', HASH_A) });
    const actions = ctrl.handle({ type: 'received-vote', vote: vote(otherPeer, 'prevote', HASH_A) });

    assert.equal(ctrl.getPhase(), 'committed', 'committed with the network instead of failing the round alone');
    const commit = actions.find((a) => a.type === 'commit-block');
    assert.ok(commit && commit.type === 'commit-block');
    assert.equal(commit.certificate.precommits.length, 3);
  });

  it('n=4: one vote is not a quorum, so a multi-validator proposer still waits for its peers', () => {
    const { set, validators } = setupValidators(4);
    const sel = selectProposer(set.listActive(), 1, SEED)!;
    const proposer = validators.find((v) => v.accountId === sel.accountId)!;

    const ctrl = new RoundController({
      validatorSet: set,
      height: 1,
      round: 0,
      proposerSeed: SEED,
      localValidator: asLocal(proposer),
      blockProvider: () => HASH_A,
    });
    const actions = ctrl.handle({ type: 'start' });

    assert.equal(ctrl.getPhase(), 'prevote');
    assert.deepEqual(typesOf(actions), ['broadcast-proposal', 'broadcast-vote', 'set-timeout']);
  });
});

describe('own vote completes the quorum: driver does not recurse', () => {
  function soloDriver(opts: { blockIntervalMs?: number; rejectContent?: boolean } = {}) {
    const { set, validators } = setupValidators(1);
    const clock = new FakeClock();
    const transport = new FakeTransport();
    const commits: number[] = [];
    const failed: number[] = [];
    let built = 0;
    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: set,
      initialHeight: 1,
      proposerSeedFor: (h) => `seed-h${h}`,
      localValidator: asLocal(validators[0]),
      blockProviderFor: (h) => {
        built++;
        return h.toString(16).padStart(64, '0');
      },
      validateBlockContent: opts.rejectContent ? () => ({ valid: false, error: 'test' }) : undefined,
      blockIntervalMs: opts.blockIntervalMs,
      onCommit: (h) => { commits.push(h); },
      onRoundFailed: (_h, r) => { failed.push(r); },
    });
    return { driver, clock, commits, failed, builtCount: () => built };
  }

  it('with no block interval, a solo validator commits ONE block per turn of the clock', () => {
    const { driver, clock, commits } = soloDriver();

    driver.start();
    // The round finished inside start(). Recursing here would have committed
    // without bound; instead exactly one block landed and the next round is
    // waiting on the clock.
    assert.deepEqual(commits, [1]);
    assert.equal(driver.getCurrentHeight(), 2);
    assert.ok(clock.pendingDelays().includes(0), 'next round is scheduled, not already running');

    clock.tick(0);
    assert.deepEqual(commits, [1, 2]);
    clock.tick(0);
    assert.deepEqual(commits, [1, 2, 3]);

    driver.stop();
    clock.tick(0);
    assert.deepEqual(commits, [1, 2, 3], 'stop() cancels the deferred round');
  });

  it('with a block interval, a solo validator produces one block per interval', () => {
    const { driver, clock, commits } = soloDriver({ blockIntervalMs: 10_000 });

    driver.start();
    assert.deepEqual(commits, [1]);

    clock.tick(9_999);
    assert.deepEqual(commits, [1], 'no block before the interval elapses');
    clock.tick(1);
    assert.deepEqual(commits, [1, 2]);
    clock.tick(10_000);
    assert.deepEqual(commits, [1, 2, 3]);
    driver.stop();
  });

  it('a solo validator whose own block fails validation backs off between rounds instead of spinning', () => {
    const { driver, clock, commits, failed, builtCount } = soloDriver({ rejectContent: true });

    driver.start();
    // Round 0 failed inside start(): NIL prevote, NIL precommit, advance.
    assert.deepEqual(commits, []);
    assert.deepEqual(failed, [0]);
    assert.equal(driver.getCurrentRound(), 1);
    assert.equal(builtCount(), 1, 'did not immediately build a second candidate');

    // Nothing more happens until a prevote timeout's worth of time has passed.
    clock.tick(1);
    assert.deepEqual(failed, [0]);
    const wait = Math.max(...clock.pendingDelays());
    assert.ok(wait >= 1000, `held back for at least a second, got ${wait}ms`);
    clock.tick(wait);
    assert.deepEqual(failed, [0, 1]);
    driver.stop();
  });
});
