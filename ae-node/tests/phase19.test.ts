// Phase 19: Block proposer selection.
//
// Two pure-function selectors live in src/core/consensus/proposer-selection.ts:
//
//   1. selectProposer(validators, height, seed) — deterministic, stake-
//      weighted. Same family as Tendermint. Every node computes the same
//      proposer for the same (height, seed).
//   2. selectProposerByVrf(validators, vrfOutputs) — pre-built for a
//      future Algorand-style commit-reveal lottery; picks the validator
//      with the lowest VRF value.
//
// This suite verifies:
//   - Determinism (same inputs → same proposer, every time)
//   - Edge cases (empty set, single validator, zero-stake fallback)
//   - Stake-weighted distribution holds across many heights
//   - Different seeds shift the distribution
//   - VRF lowest-value picks correctly, skips missing submissions, ties
//     broken by accountId

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectProposer,
  selectProposerByVrf,
} from '../src/core/consensus/proposer-selection.js';
import type { ValidatorInfo } from '../src/core/consensus/IValidatorSet.js';

function makeValidator(accountId: string, stake: bigint): ValidatorInfo {
  return {
    accountId,
    nodePublicKey: `node-${accountId}`,
    vrfPublicKey: `vrf-${accountId}`,
    stake,
    isActive: true,
    registeredAt: 0,
    deregisteredAt: null,
  };
}

describe('Phase 19: Block proposer selection', () => {
  // ── Edge cases ───────────────────────────────────────────────────────

  it('returns null for an empty validator set', () => {
    assert.equal(selectProposer([], 1, 'seed'), null);
  });

  it('always returns the only validator when set has size 1', () => {
    const only = makeValidator('alice', 100n);
    for (let h = 0; h < 50; h++) {
      const p = selectProposer([only], h, 'seed');
      assert.ok(p);
      assert.equal(p!.accountId, 'alice');
    }
  });

  it('falls back to round-robin when all stakes are zero', () => {
    const vs = [makeValidator('a', 0n), makeValidator('b', 0n), makeValidator('c', 0n)];
    // Round-robin by sorted accountId: a, b, c → height 0=a, 1=b, 2=c, 3=a, ...
    const sorted = ['a', 'b', 'c'];
    for (let h = 0; h < 9; h++) {
      const p = selectProposer(vs, h, 'seed');
      assert.equal(p!.accountId, sorted[h % 3]);
    }
  });

  it('throws on negative stake', () => {
    const vs = [makeValidator('a', 100n), makeValidator('b', -1n)];
    assert.throws(() => selectProposer(vs, 1, 'seed'), /negative stake/);
  });

  // ── Determinism ──────────────────────────────────────────────────────

  it('same inputs always produce the same proposer', () => {
    const vs = [
      makeValidator('alice', 100n),
      makeValidator('bob', 200n),
      makeValidator('carol', 300n),
    ];
    const a = selectProposer(vs, 42, 'block-hash-deadbeef');
    const b = selectProposer(vs, 42, 'block-hash-deadbeef');
    const c = selectProposer(vs, 42, 'block-hash-deadbeef');
    assert.equal(a!.accountId, b!.accountId);
    assert.equal(a!.accountId, c!.accountId);
  });

  it('different node ordering of the same set yields the same proposer', () => {
    const original = [
      makeValidator('alice', 100n),
      makeValidator('bob', 200n),
      makeValidator('carol', 300n),
    ];
    const reversed = [...original].reverse();
    for (let h = 0; h < 20; h++) {
      const a = selectProposer(original, h, 'seed');
      const b = selectProposer(reversed, h, 'seed');
      assert.equal(a!.accountId, b!.accountId);
    }
  });

  // ── Stake weighting ──────────────────────────────────────────────────

  it('stake-weighted distribution is roughly proportional over many heights', () => {
    // 80/20 split: alice has 80%, bob has 20%
    const vs = [makeValidator('alice', 800n), makeValidator('bob', 200n)];
    const N = 2000;
    let aliceCount = 0;
    let bobCount = 0;
    for (let h = 0; h < N; h++) {
      const p = selectProposer(vs, h, 'seed');
      if (p!.accountId === 'alice') aliceCount++;
      else bobCount++;
    }

    // Expect alice ~= 80% ± 5%, bob ~= 20% ± 5%.
    const aliceShare = aliceCount / N;
    const bobShare = bobCount / N;
    assert.ok(
      aliceShare > 0.75 && aliceShare < 0.85,
      `alice share ${aliceShare.toFixed(3)} not within [0.75, 0.85]`,
    );
    assert.ok(
      bobShare > 0.15 && bobShare < 0.25,
      `bob share ${bobShare.toFixed(3)} not within [0.15, 0.25]`,
    );
  });

  it('equal stake gives roughly equal selection rates', () => {
    const vs = [
      makeValidator('a', 100n),
      makeValidator('b', 100n),
      makeValidator('c', 100n),
      makeValidator('d', 100n),
    ];
    const N = 4000;
    const counts = { a: 0, b: 0, c: 0, d: 0 };
    for (let h = 0; h < N; h++) {
      const p = selectProposer(vs, h, 'shared-seed');
      counts[p!.accountId as 'a' | 'b' | 'c' | 'd']++;
    }
    for (const id of ['a', 'b', 'c', 'd'] as const) {
      const share = counts[id] / N;
      assert.ok(
        share > 0.20 && share < 0.30,
        `${id} share ${share.toFixed(3)} not within [0.20, 0.30]`,
      );
    }
  });

  // ── Seed sensitivity ─────────────────────────────────────────────────

  it('different seeds produce different selection sequences', () => {
    const vs = [
      makeValidator('a', 100n),
      makeValidator('b', 100n),
      makeValidator('c', 100n),
    ];
    const seq1: string[] = [];
    const seq2: string[] = [];
    for (let h = 0; h < 30; h++) {
      seq1.push(selectProposer(vs, h, 'seed-A')!.accountId);
      seq2.push(selectProposer(vs, h, 'seed-B')!.accountId);
    }
    // The two sequences should differ in many positions. Tolerate up to 75%
    // overlap (with 30 samples, full agreement would be 1/3^30 unlikely).
    let matching = 0;
    for (let i = 0; i < 30; i++) if (seq1[i] === seq2[i]) matching++;
    assert.ok(matching < 25, `seeds gave ${matching}/30 matching positions; expected < 25`);
  });

  it('different heights with the same seed produce different proposers', () => {
    const vs = [makeValidator('a', 100n), makeValidator('b', 100n)];
    const distinct = new Set<string>();
    for (let h = 0; h < 20; h++) {
      distinct.add(selectProposer(vs, h, 'shared-seed')!.accountId);
    }
    // With 2 validators across 20 heights and equal stake we should
    // definitely see both.
    assert.equal(distinct.size, 2);
  });

  // ── selectProposerByVrf ──────────────────────────────────────────────

  it('VRF picker returns the validator with the lowest VRF value', () => {
    const vs = [
      makeValidator('alice', 100n),
      makeValidator('bob', 100n),
      makeValidator('carol', 100n),
    ];
    const outputs = new Map<string, bigint>([
      ['alice', 50_000n],
      ['bob', 1_000n],   // lowest
      ['carol', 99_000n],
    ]);
    const winner = selectProposerByVrf(vs, outputs);
    assert.equal(winner!.accountId, 'bob');
  });

  it('VRF picker skips validators with no submitted value', () => {
    const vs = [
      makeValidator('alice', 100n),
      makeValidator('bob', 100n),
    ];
    // Only alice submitted; bob is skipped
    const outputs = new Map<string, bigint>([['alice', 999_999n]]);
    const winner = selectProposerByVrf(vs, outputs);
    assert.equal(winner!.accountId, 'alice');
  });

  it('VRF picker returns null when no validator submitted', () => {
    const vs = [makeValidator('alice', 100n)];
    const outputs = new Map<string, bigint>();
    assert.equal(selectProposerByVrf(vs, outputs), null);
  });

  it('VRF tie is broken by accountId ASCII-ascending', () => {
    const vs = [
      makeValidator('zeta', 100n),
      makeValidator('alpha', 100n),
      makeValidator('mu', 100n),
    ];
    const outputs = new Map<string, bigint>([
      ['zeta', 1n],
      ['alpha', 1n],
      ['mu', 1n],
    ]);
    const winner = selectProposerByVrf(vs, outputs);
    assert.equal(winner!.accountId, 'alpha');
  });

  it('VRF picker is deterministic given the same inputs', () => {
    const vs = [
      makeValidator('a', 100n),
      makeValidator('b', 100n),
      makeValidator('c', 100n),
    ];
    const outputs = new Map<string, bigint>([
      ['a', 12345n],
      ['b', 67890n],
      ['c', 1n],
    ]);
    const w1 = selectProposerByVrf(vs, outputs);
    const w2 = selectProposerByVrf(vs, outputs);
    assert.equal(w1!.accountId, w2!.accountId);
    assert.equal(w1!.accountId, 'c');
  });
});
