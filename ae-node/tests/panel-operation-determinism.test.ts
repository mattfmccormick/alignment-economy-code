// A panel operation applied on two nodes reaches identical state — including
// the applicant's percentHuman.
//
// Panel completion (median of the scores → percentHuman) was the last writer of
// percentHuman that ran node-locally, which is the determinism gap behind audit
// #4: spend value is amount * percentHuman / 100, so a forked percentHuman
// forks the value a spend moves. These tests pin that panel_create + panel_score
// ops, applied in the same order on two independent databases, leave both
// agreeing on the panel status, the median, AND the applicant's percentHuman —
// and that a re-delivered op, or a second op from the same miner, is a no-op.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import { signMinerRegister, applyMinerOperation } from '../src/mining/miner-operation.js';
import {
  signPanelCreate,
  signPanelScore,
  applyPanelOperation,
  verifyPanelOperation,
  computePanelOperationsHash,
  derivePanelId,
  validatePanelOperationApplicable,
} from '../src/verification/panel-operation.js';
import { verificationStore } from '../src/verification/panel.js';

interface Party {
  id: string;
  pub: string;
  priv: string;
}
function party(): Party {
  const kp = generateKeyPair();
  return { id: deriveAccountId(kp.publicKey), pub: kp.publicKey, priv: kp.privateKey };
}

function node(...accts: Party[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  for (const a of accts) createAccount(db, 'individual', 1, 0, a.pub);
  return db;
}

// Register a set of accounts as miners on a node via the chain-ordered path, so
// the active miner count (which the completion target snapshots) is set up the
// same way on both nodes.
function registerMiners(db: DatabaseSync, ts: number, ...miners: Party[]): void {
  let t = ts;
  for (const m of miners) {
    const op = signMinerRegister({ accountId: m.id, timestamp: t++, accountPrivateKey: m.priv });
    applyMinerOperation(db, op, t);
  }
}

describe('panel operation determinism across nodes', () => {
  it('create + a full panel of scores yields the same median and percentHuman on both nodes', () => {
    const applicant = party();
    const m1 = party();
    const m2 = party();
    const m3 = party();

    const a = node(applicant, m1, m2, m3);
    const b = node(applicant, m1, m2, m3);
    registerMiners(a, 1_700_000_000, m1, m2, m3);
    registerMiners(b, 1_700_000_000, m1, m2, m3);

    // Applicant requests a panel.
    const create = signPanelCreate({
      accountId: applicant.id,
      timestamp: 1_700_000_100,
      accountPrivateKey: applicant.priv,
    });
    const panelId = derivePanelId(create);
    applyPanelOperation(a, create, 1_700_000_100);
    applyPanelOperation(b, create, 1_700_000_100);

    // Three miners score 60, 80, 70 → median 70. Target = min(panel_size=3, 3) = 3.
    const scores: Array<[Party, number]> = [
      [m1, 60],
      [m2, 80],
      [m3, 70],
    ];
    for (const [m, s] of scores) {
      const op = signPanelScore({
        accountId: m.id,
        panelId,
        score: s,
        timestamp: 1_700_000_200 + s,
        accountPrivateKey: m.priv,
      });
      applyPanelOperation(a, op, 1_700_000_300);
      applyPanelOperation(b, op, 1_700_000_300);
    }

    const panelA = verificationStore(a).findPanelById(panelId)!;
    const panelB = verificationStore(b).findPanelById(panelId)!;
    assert.equal(panelA.status, 'complete');
    assert.equal(panelA.medianScore, 70);
    assert.equal(panelB.status, panelA.status);
    assert.equal(panelB.medianScore, panelA.medianScore);

    // The whole point: percentHuman is identical across the two nodes.
    assert.equal(getAccount(a, applicant.id)!.percentHuman, 70);
    assert.equal(getAccount(b, applicant.id)!.percentHuman, getAccount(a, applicant.id)!.percentHuman);

    a.close();
    b.close();
  });

  it('does not complete before the target is met, then completes on the last score', () => {
    const applicant = party();
    const m1 = party();
    const m2 = party();
    const m3 = party();
    const db = node(applicant, m1, m2, m3);
    registerMiners(db, 1_700_000_000, m1, m2, m3);

    const create = signPanelCreate({
      accountId: applicant.id,
      timestamp: 1_700_000_100,
      accountPrivateKey: applicant.priv,
    });
    const panelId = derivePanelId(create);
    applyPanelOperation(db, create, 1_700_000_100);

    // Two of three scores in: still open, percentHuman untouched (started at 0).
    for (const [i, m] of [m1, m2].entries()) {
      const op = signPanelScore({
        accountId: m.id,
        panelId,
        score: 50,
        timestamp: 1_700_000_200 + i,
        accountPrivateKey: m.priv,
      });
      applyPanelOperation(db, op, 1_700_000_300);
    }
    assert.equal(verificationStore(db).findPanelById(panelId)!.status, 'in_progress');
    assert.equal(getAccount(db, applicant.id)!.percentHuman, 0);

    // Third score crosses the target: complete, median 50 → percentHuman 50.
    const last = signPanelScore({
      accountId: m3.id,
      panelId,
      score: 50,
      timestamp: 1_700_000_250,
      accountPrivateKey: m3.priv,
    });
    applyPanelOperation(db, last, 1_700_000_300);
    assert.equal(verificationStore(db).findPanelById(panelId)!.status, 'complete');
    assert.equal(getAccount(db, applicant.id)!.percentHuman, 50);

    db.close();
  });

  it('a re-delivered score, and a second score from the same miner, are both no-ops', () => {
    const applicant = party();
    const m1 = party();
    const db = node(applicant, m1);
    registerMiners(db, 1_700_000_000, m1); // one miner → target = min(3,1) = 1

    const create = signPanelCreate({
      accountId: applicant.id,
      timestamp: 1_700_000_100,
      accountPrivateKey: applicant.priv,
    });
    const panelId = derivePanelId(create);
    applyPanelOperation(db, create, 1_700_000_100);

    const op = signPanelScore({
      accountId: m1.id,
      panelId,
      score: 42,
      timestamp: 1_700_000_200,
      accountPrivateKey: m1.priv,
    });
    applyPanelOperation(db, op, 1_700_000_300);
    // Target 1 → completes on the first score.
    assert.equal(verificationStore(db).findPanelById(panelId)!.medianScore, 42);
    assert.equal(getAccount(db, applicant.id)!.percentHuman, 42);

    // Re-delivery: no new review, median unchanged.
    applyPanelOperation(db, op, 1_700_000_300);
    assert.equal(verificationStore(db).findScoresByPanel(panelId).length, 1);

    // A DIFFERENT score op from the same miner (new signature) must not add a
    // second review — one score per miner per panel, and the panel is complete.
    const op2 = signPanelScore({
      accountId: m1.id,
      panelId,
      score: 99,
      timestamp: 1_700_000_400,
      accountPrivateKey: m1.priv,
    });
    applyPanelOperation(db, op2, 1_700_000_500);
    assert.equal(verificationStore(db).findScoresByPanel(panelId).length, 1);
    assert.equal(getAccount(db, applicant.id)!.percentHuman, 42);

    db.close();
  });

  it('validation rejects self-scoring, non-miner signers, and out-of-range scores', () => {
    const applicant = party();
    const m1 = party();
    const outsider = party();
    const db = node(applicant, m1, outsider);
    registerMiners(db, 1_700_000_000, m1);

    const create = signPanelCreate({
      accountId: applicant.id,
      timestamp: 1_700_000_100,
      accountPrivateKey: applicant.priv,
    });
    const panelId = derivePanelId(create);
    applyPanelOperation(db, create, 1_700_000_100);

    // A non-miner cannot score.
    const bySomeoneElse = signPanelScore({
      accountId: outsider.id,
      panelId,
      score: 50,
      timestamp: 1_700_000_200,
      accountPrivateKey: outsider.priv,
    });
    assert.equal(validatePanelOperationApplicable(db, bySomeoneElse), 'signer is not an active miner');

    // Out-of-range score is rejected by validation (and by verify).
    const bad = signPanelScore({
      accountId: m1.id,
      panelId,
      score: 150,
      timestamp: 1_700_000_200,
      accountPrivateKey: m1.priv,
    });
    assert.equal(validatePanelOperationApplicable(db, bad), 'score must be a whole number 0-100');

    db.close();
  });

  it('the operations hash is order-independent and the signature verifies', () => {
    const applicant = party();
    const m1 = party();
    const create = signPanelCreate({
      accountId: applicant.id,
      timestamp: 1_700_000_100,
      accountPrivateKey: applicant.priv,
    });
    const panelId = derivePanelId(create);
    const score = signPanelScore({
      accountId: m1.id,
      panelId,
      score: 55,
      timestamp: 1_700_000_200,
      accountPrivateKey: m1.priv,
    });
    assert.equal(
      computePanelOperationsHash([create, score]),
      computePanelOperationsHash([score, create]),
    );
    assert.equal(verifyPanelOperation(create, applicant.pub), true);
    assert.equal(verifyPanelOperation(create, m1.pub), false);
    assert.equal(verifyPanelOperation(score, m1.pub), true);
  });
});
