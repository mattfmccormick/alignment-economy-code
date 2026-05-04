// Phase 44: Polka unlock — Tendermint liveness recovery.
//
// Sessions 31 + 37 made locking symmetric on prevote + precommit. But
// the rule "never unlock until height advances" can stall a locked
// validator when the network has moved past their lock — they refuse to
// vote anything else, while 2/3+ have switched to a new block. Without
// polka unlock, the locked validator stays stuck for the rest of the
// height (eventually catches up via sync after height advances).
//
// Polka unlock fixes this: when a locked validator observes 2/3+
// prevotes (a "polka") on a different block at a higher round, they
// unlock and follow the polka. If that round commits, the lock is
// replaced.
//
// Verified:
//   1. RoundController emits 'observed-polka' when prevote VoteSet hits
//      real-block quorum.
//   2. priorLock alone (no polka): castPrevote downgrades to NIL on
//      different hash (Session 31 behavior preserved).
//   3. priorLock + priorPolka (polka.round > lock.round, different hash):
//      castPrevote ALLOWS the polka's hash through. Lock is bypassed.
//   4. Same applies to castPrecommit (lock-honoring symmetry preserved).
//   5. Polka with round <= lock.round does NOT unlock (Tendermint rule:
//      only newer polkas unlock).
//   6. Polka on the SAME hash as the lock doesn't change behavior.
//   7. BftDriver tracks latestPolka across rounds; passes priorPolka.
//   8. latestPolka clears on commit (height advances).

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
  RoundController,
  type LocalValidator,
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

describe('Phase 44: Polka unlock', () => {
  let env: ReturnType<typeof setupValidators>;
  let local: ValidatorHandle;
  let others: ValidatorHandle[];

  beforeEach(() => {
    env = setupValidators(4); // quorum = 3
    const sel = selectProposer(env.set.listActive(), 1, 'polka-seed', 1)!;
    local = env.validators.find((v) => v.accountId !== sel.accountId)!;
    others = env.validators.filter((v) => v.accountId !== local.accountId);
  });

  // ── observed-polka emission ──────────────────────────────────────────

  it('RoundController emits observed-polka when prevote quorum hits a real block', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'polka-seed',
      localValidator: asLocal(local),
    });
    ctrl.handle({ type: 'start' });
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

    const polkas = findActions(lastActions, 'observed-polka');
    assert.equal(polkas.length, 1, 'should emit observed-polka on real-block prevote quorum');
    if (polkas[0].type === 'observed-polka') {
      assert.equal(polkas[0].round, 1);
      assert.equal(polkas[0].blockHash, HASH_A);
    }
  });

  it('does NOT emit observed-polka when only NIL prevotes reach quorum', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 1,
      proposerSeed: 'polka-seed',
      localValidator: asLocal(local),
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });

    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 1, blockHash: null,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }
    assert.equal(findActions(lastActions, 'observed-polka').length, 0);
  });

  // ── Polka unlock semantics ──────────────────────────────────────────

  it('priorLock + priorPolka (newer round, different hash): castPrevote follows the polka', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 2,
      proposerSeed: 'polka-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 0 },
      priorPolka: { blockHash: HASH_B, round: 1 },
    });
    ctrl.handle({ type: 'start' });

    // Drive 3 prevotes for HASH_B from others; quorum reached
    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 2, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }

    // Without polka unlock: precommit would be NIL (locked on A,
    // asked for B). With polka unlock: precommit is HASH_B.
    const precommits = findActions(lastActions, 'broadcast-vote').filter(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'precommit',
    );
    assert.equal(precommits.length, 1);
    if (precommits[0].type === 'broadcast-vote') {
      assert.equal(
        precommits[0].vote.blockHash,
        HASH_B,
        'polka unlock allows precommit on the polka hash',
      );
    }
  });

  it('priorLock + polka with round <= lock.round: lock NOT bypassed', () => {
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 2,
      proposerSeed: 'polka-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 1 },
      priorPolka: { blockHash: HASH_B, round: 0 }, // OLDER than lock
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });

    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 2, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }

    // Lock still holds — precommit should be NIL (not HASH_B)
    const precommits = findActions(lastActions, 'broadcast-vote').filter(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'precommit',
    );
    assert.equal(precommits.length, 1);
    if (precommits[0].type === 'broadcast-vote') {
      assert.equal(
        precommits[0].vote.blockHash,
        null,
        'older polka should NOT unlock — lock still constrains us',
      );
    }
  });

  it('priorLock + polka on SAME hash as lock: behaves identically with or without polka', () => {
    // Polka and lock agree — no unlock needed; the validator just
    // votes the lock hash normally.
    const ctrl = new RoundController({
      validatorSet: env.set,
      height: 1,
      round: 2,
      proposerSeed: 'polka-seed',
      localValidator: asLocal(local),
      priorLock: { blockHash: HASH_A, round: 0 },
      priorPolka: { blockHash: HASH_A, round: 1 }, // same hash, newer round
    });
    ctrl.handle({ type: 'start' });
    ctrl.handle({ type: 'propose-timeout' });

    let lastActions: RoundAction[] = [];
    for (const v of others) {
      lastActions = ctrl.handle({
        type: 'received-vote',
        vote: signVote({
          kind: 'prevote', height: 1, round: 2, blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      });
    }

    const precommits = findActions(lastActions, 'broadcast-vote').filter(
      (a) => a.type === 'broadcast-vote' && a.vote.kind === 'precommit',
    );
    assert.equal(precommits.length, 1);
    if (precommits[0].type === 'broadcast-vote') {
      assert.equal(precommits[0].vote.blockHash, HASH_A);
    }
  });

  // ── BftDriver polka tracking ────────────────────────────────────────

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

  it('BftDriver tracks latestPolka across rounds; passes priorPolka into next round', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'polka-seed',
      localValidator: asLocal(local),
      onCommit: () => {},
      timeouts: { propose: 100, prevote: 50, precommit: 50 },
      timeoutScaling: { proposeStep: 0, prevoteStep: 0, precommitStep: 0 },
    });
    driver.start();

    // Initial: no polka yet
    assert.equal(driver.getLatestPolka(), null);

    // In round 0, push 3 prevotes for HASH_B from others. The local
    // validator's prevote is NIL (no proposal); the 3 others' votes
    // form a polka on HASH_B.
    clock.tick(100); // propose-timeout → local NIL prevote
    for (const v of others) {
      transport.pushVote(
        signVote({
          kind: 'prevote', height: 1, round: 0, blockHash: HASH_B,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }

    // Driver should now have a polka recorded
    const polka = driver.getLatestPolka();
    assert.ok(polka, 'driver should record polka after observed-polka action');
    assert.equal(polka!.blockHash, HASH_B);
    assert.equal(polka!.round, 0);
    driver.stop();
  });

  it('latestPolka clears on commit (height advance)', () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const sel = selectProposer(env.set.listActive(), 1, 'polka-seed', 0)!;
    const proposer = env.validators.find((v) => v.accountId === sel.accountId)!;

    const driver = new BftDriver({
      transport,
      clock,
      validatorSet: env.set,
      initialHeight: 1,
      proposerSeedFor: () => 'polka-seed',
      localValidator: asLocal(proposer),
      blockProviderFor: () => HASH_A,
      onCommit: () => {},
      timeouts: { propose: 100, prevote: 50, precommit: 50 },
      timeoutScaling: { proposeStep: 0, prevoteStep: 0, precommitStep: 0 },
    });
    driver.start();

    // Drive prevote quorum on HASH_A → polka recorded
    const otherVals = env.validators.filter((v) => v.accountId !== proposer.accountId).slice(0, 2);
    for (const v of otherVals) {
      transport.pushVote(
        signVote({
          kind: 'prevote', height: 1, round: 0, blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    assert.ok(driver.getLatestPolka(), 'polka recorded after quorum');

    // Drive precommit quorum to commit
    for (const v of otherVals) {
      transport.pushVote(
        signVote({
          kind: 'precommit', height: 1, round: 0, blockHash: HASH_A,
          validatorAccountId: v.accountId,
          validatorPublicKey: v.identity.publicKey,
          validatorSecretKey: v.identity.secretKey,
        }),
      );
    }
    assert.equal(driver.getCurrentHeight(), 2, 'should commit + advance height');
    assert.equal(driver.getLatestPolka(), null, 'polka must clear on commit');

    driver.stop();
  });
});
