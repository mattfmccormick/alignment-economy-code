// Phase 74: WP v2 Appendix A parameter governance.
//
// Every protocol param falls into one of four classes:
//   Constitutional — immutable, rejected by setParam
//   Bounded        — governable within hardcoded floor/ceiling
//   Algorithmic    — auto-set by formula, no manual changes
//   Open           — freely governable
//
// setParam enforces these rules. Bounded params reject values
// outside their [low, high] range.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam, getParam } from '../src/config/params.js';
import { validateParamChange, PARAM_GOVERNANCE } from '../src/config/governance.js';
import { DEFAULT_PARAMS } from '../src/config/defaults.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('Phase 74: Parameter governance (WP v2 Appendix A)', () => {

  // ── Constitutional params cannot be changed ─────────────────────

  it('rejects changes to constitutional params', () => {
    assert.throws(
      () => validateParamChange('verification.total_max', 200),
      /constitutional/i,
    );
    assert.throws(
      () => validateParamChange('verification.tier_c.tier_c_max', 50),
      /constitutional/i,
    );
    assert.throws(
      () => validateParamChange('network.day_length_seconds', 43200),
      /constitutional/i,
    );
    assert.throws(
      () => validateParamChange('governance.referendum_supermajority', 0.5),
      /constitutional/i,
    );
    assert.throws(
      () => validateParamChange('mining.tier2_jury_attendance_required', 0.9),
      /constitutional/i,
    );
  });

  it('setParam rejects constitutional params at the DB level', () => {
    const db = freshDb();
    assert.throws(
      () => setParam(db, 'verification.total_max', 200),
      /constitutional/i,
    );
    db.close();
  });

  // ── Bounded params: valid changes accepted ──────────────────────

  it('accepts bounded param within range', () => {
    const db = freshDb();
    setParam(db, 'court.jury_size', 13);
    assert.equal(getParam(db, 'court.jury_size'), 13);

    setParam(db, 'decay.monthly_decay_percent', 5);
    assert.equal(getParam(db, 'decay.monthly_decay_percent'), 5);

    setParam(db, 'mining.tier1_fee_share', 0.30);
    assert.equal(getParam(db, 'mining.tier1_fee_share'), 0.30);
    db.close();
  });

  it('accepts bounded param at exact floor', () => {
    const db = freshDb();
    setParam(db, 'court.jury_size', 7);
    assert.equal(getParam(db, 'court.jury_size'), 7);
    db.close();
  });

  it('accepts bounded param at exact ceiling', () => {
    const db = freshDb();
    setParam(db, 'court.jury_size', 25);
    assert.equal(getParam(db, 'court.jury_size'), 25);
    db.close();
  });

  // ── Bounded params: out-of-range changes rejected ───────────────

  it('rejects bounded param below floor', () => {
    assert.throws(
      () => validateParamChange('court.jury_size', 3),
      /below the minimum/,
    );
    assert.throws(
      () => validateParamChange('decay.monthly_decay_percent', 1),
      /below the minimum/,
    );
    assert.throws(
      () => validateParamChange('mining.tier1_fee_share', 0.05),
      /below the minimum/,
    );
  });

  it('rejects bounded param above ceiling', () => {
    assert.throws(
      () => validateParamChange('court.jury_size', 50),
      /above the maximum/,
    );
    assert.throws(
      () => validateParamChange('decay.monthly_decay_percent', 30),
      /above the maximum/,
    );
    assert.throws(
      () => validateParamChange('mining.tier2_accuracy_threshold', 0.99),
      /above the maximum/,
    );
  });

  it('rejects non-numeric value for bounded param', () => {
    assert.throws(
      () => validateParamChange('court.jury_size', 'eleven'),
      /must be a number/,
    );
  });

  // ── Open params: any value accepted ─────────────────────────────

  it('accepts any value for open params', () => {
    const db = freshDb();
    setParam(db, 'network.block_interval_seconds', 5);
    assert.equal(getParam(db, 'network.block_interval_seconds'), 5);

    setParam(db, 'mining.heartbeat_interval_seconds', 120);
    assert.equal(getParam(db, 'mining.heartbeat_interval_seconds'), 120);
    db.close();
  });

  // ── Unknown params rejected ─────────────────────────────────────

  it('rejects unknown parameter keys', () => {
    assert.throws(
      () => validateParamChange('made.up.param', 42),
      /Unknown parameter/,
    );
  });

  it('setParam rejects unknown keys at the DB level', () => {
    const db = freshDb();
    assert.throws(
      () => setParam(db, 'daily.active_points', 2880),
      /Unknown parameter/,
    );
    db.close();
  });

  // ── New WP v2 params exist in defaults ──────────────────────────

  it('new WP v2 params are seeded with correct defaults', () => {
    const db = freshDb();
    assert.equal(getParam(db, 'court.forfeited_challenger_def_share'), 0.50);
    assert.equal(getParam(db, 'court.duplicate_penalty_multiplier'), 2);
    assert.equal(getParam(db, 'governance.referendum_quorum'), 0.10);
    assert.equal(getParam(db, 'blockchain.history_window_years'), 7);
    db.close();
  });

  it('new WP v2 bounded params respect their bounds', () => {
    assert.throws(
      () => validateParamChange('court.forfeited_challenger_def_share', 0.80),
      /above the maximum/,
    );
    assert.throws(
      () => validateParamChange('court.duplicate_penalty_multiplier', 5),
      /above the maximum/,
    );
    assert.throws(
      () => validateParamChange('blockchain.history_window_years', 2),
      /below the minimum/,
    );
  });

  // ── Coverage: every param in defaults.ts has a governance entry ──

  it('every default param has a governance classification', () => {
    for (const key of Object.keys(DEFAULT_PARAMS)) {
      assert.ok(
        PARAM_GOVERNANCE[key],
        `Missing governance entry for param: ${key}`,
      );
    }
  });

  // ── Coverage: all bounded params have both low and high ─────────

  it('all bounded params have low and high bounds defined', () => {
    for (const [key, spec] of Object.entries(PARAM_GOVERNANCE)) {
      if (spec.class === 'bounded') {
        assert.ok(spec.low !== undefined, `Bounded param '${key}' missing low bound`);
        assert.ok(spec.high !== undefined, `Bounded param '${key}' missing high bound`);
        assert.ok(spec.low < spec.high, `Bounded param '${key}': low (${spec.low}) >= high (${spec.high})`);
      }
    }
  });
});
