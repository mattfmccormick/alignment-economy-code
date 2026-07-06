// W3: accuracy-weighted proposer selection (WP §8.4).
//
// Validators are weighted for block proposal by their proof-of-human
// verification/jury accuracy, "not on capital staked." The weight lives in
// ValidatorInfo.proposerWeight (populated by the live validator set from
// getCompositeAccuracy); selectProposer uses it, falling back to `stake` only
// for raw fixtures/snapshots. Quorum is unaffected (count-based), so this only
// changes who proposes, never finality.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { selectProposer } from '../src/core/consensus/proposer-selection.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import type { ValidatorInfo } from '../src/core/consensus/IValidatorSet.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function validator(accountId: string, fields: Partial<ValidatorInfo>): ValidatorInfo {
  return {
    accountId,
    nodePublicKey: `node-${accountId}`,
    vrfPublicKey: `vrf-${accountId}`,
    stake: 100n,
    isActive: true,
    registeredAt: 0,
    deregisteredAt: null,
    ...fields,
  };
}

// Count proposer wins across many distinct seeds.
function distribution(validators: ValidatorInfo[], n: number): Record<string, number> {
  const wins: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const p = selectProposer(validators, 1, `seed-${i}`)!;
    wins[p.accountId] = (wins[p.accountId] ?? 0) + 1;
  }
  return wins;
}

describe('W3: accuracy-weighted proposer selection', () => {
  it('selects proportionally to proposerWeight (accuracy), not stake', () => {
    // Equal stake, very unequal accuracy: A=90, B=10. A should win ~90%.
    const vals = [
      validator('A', { stake: 100n, proposerWeight: 90n }),
      validator('B', { stake: 100n, proposerWeight: 10n }),
    ];
    const wins = distribution(vals, 600);
    assert.ok(wins.A > wins.B, `A (accurate) should propose more: ${JSON.stringify(wins)}`);
    // Roughly 90/10 — allow generous slack for hash variance.
    assert.ok(wins.A > 450 && wins.A < 570, `A share ~90%: ${JSON.stringify(wins)}`);
  });

  it('falls back to stake when proposerWeight is absent (raw fixtures/snapshots)', () => {
    // No proposerWeight → weight by stake. A stake 90, B stake 10 → ~90/10.
    const vals = [
      validator('A', { stake: 90n }),
      validator('B', { stake: 10n }),
    ];
    const wins = distribution(vals, 600);
    assert.ok(wins.A > wins.B, `stake fallback still weights: ${JSON.stringify(wins)}`);
    assert.ok(wins.A > 450, `A share ~90% via stake: ${JSON.stringify(wins)}`);
  });

  it('is deterministic: same (height, round, seed) always yields the same proposer', () => {
    const vals = [
      validator('A', { proposerWeight: 50n }),
      validator('B', { proposerWeight: 50n }),
      validator('C', { proposerWeight: 50n }),
    ];
    for (let i = 0; i < 50; i++) {
      const seed = `s-${i}`;
      const first = selectProposer(vals, 7, seed, 2)!.accountId;
      const again = selectProposer(vals, 7, seed, 2)!.accountId;
      assert.equal(first, again);
    }
  });

  it('SqliteValidatorSet.listActive populates proposerWeight from accuracy', () => {
    const db = freshDb();
    const set = new SqliteValidatorSet(db);

    // One validator whose account is a registered miner (new miner → 100%
    // accuracy → weight 100), one whose account exists but has no miner record
    // (defaults to 100 too). Both accounts are real (validators FK to accounts).
    const minerAcct = createAccount(db, 'individual', 1, 100);
    registerMiner(db, minerAcct.account.id);
    const plainAcct = createAccount(db, 'individual', 1, 100);
    set.insert({ accountId: minerAcct.account.id, nodePublicKey: 'n1', vrfPublicKey: 'v1', stake: 100n, registeredAt: 0 });
    set.insert({ accountId: plainAcct.account.id, nodePublicKey: 'n2', vrfPublicKey: 'v2', stake: 100n, registeredAt: 0 });

    const active = set.listActive();
    assert.equal(active.length, 2);
    for (const v of active) {
      assert.notEqual(v.proposerWeight, undefined, 'live set must populate proposerWeight');
      assert.equal(v.proposerWeight, 100n, 'new miner / no-record → benefit-of-the-doubt weight 100');
    }
  });
});
