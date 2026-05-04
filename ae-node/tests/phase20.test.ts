// Phase 20: BFT vote primitive (prevote / precommit) — sign + verify.
//
// Verifies the wire-level vote primitive that Sessions 15+ will build the
// aggregator and finality logic on top of:
//
//   1. signVote → verifyVote round-trip succeeds
//   2. Different (height, round, blockHash, kind) inputs produce distinct
//      signed bytes (i.e. signing isn't accidentally equivalence-classing
//      two semantically different votes)
//   3. Tampering with any signed field fails verification:
//      blockHash, height, round, kind, timestamp, validatorAccountId
//   4. NIL votes (blockHash=null) sign + verify cleanly and are NOT
//      mistakenly equivalent to a vote on the empty string ""
//   5. Replay-window enforcement: stale or future votes rejected
//   6. Wrong publicKey: signature won't verify under a different validator's key
//   7. expectedPublicKey assertion: refuses a vote claiming to be from a
//      different validator than the aggregator expects
//   8. Malformed inputs return false instead of throwing
//   9. voteId uniqueness across the four vote dimensions

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import {
  signVote,
  verifyVote,
  voteId,
  canonicalVoteBytes,
  type Vote,
} from '../src/core/consensus/votes.js';

function makeSignerInput(overrides: Partial<Parameters<typeof signVote>[0]> = {}) {
  const id = generateNodeIdentity();
  return {
    base: {
      kind: 'prevote' as const,
      height: 100,
      round: 0,
      blockHash: 'deadbeef'.repeat(8),
      validatorAccountId: 'alice',
      validatorPublicKey: id.publicKey,
      validatorSecretKey: id.secretKey,
      ...overrides,
    },
    publicKey: id.publicKey,
  };
}

describe('Phase 20: BFT vote primitive', () => {
  // ── Round-trip ───────────────────────────────────────────────────────

  it('signVote then verifyVote round-trips for a prevote', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    assert.equal(verifyVote(vote), true);
    assert.equal(vote.kind, 'prevote');
    assert.equal(vote.signature.length, 128); // 64 bytes hex
  });

  it('signVote then verifyVote round-trips for a precommit', () => {
    const { base } = makeSignerInput({ kind: 'precommit' });
    const vote = signVote(base);
    assert.equal(verifyVote(vote), true);
    assert.equal(vote.kind, 'precommit');
  });

  it('signVote then verifyVote round-trips for a NIL vote', () => {
    const { base } = makeSignerInput({ blockHash: null });
    const vote = signVote(base);
    assert.equal(verifyVote(vote), true);
    assert.equal(vote.blockHash, null);
  });

  // ── Field-by-field tampering ─────────────────────────────────────────

  it('verifyVote rejects a tampered blockHash', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    const tampered: Vote = { ...vote, blockHash: 'cafebabe'.repeat(8) };
    assert.equal(verifyVote(tampered), false);
  });

  it('verifyVote rejects a tampered height', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    const tampered: Vote = { ...vote, height: vote.height + 1 };
    assert.equal(verifyVote(tampered), false);
  });

  it('verifyVote rejects a tampered round', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    const tampered: Vote = { ...vote, round: vote.round + 1 };
    assert.equal(verifyVote(tampered), false);
  });

  it('verifyVote rejects a tampered kind (prevote → precommit)', () => {
    const { base } = makeSignerInput({ kind: 'prevote' });
    const vote = signVote(base);
    const tampered: Vote = { ...vote, kind: 'precommit' };
    assert.equal(verifyVote(tampered), false);
  });

  it('verifyVote rejects a tampered timestamp', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    const tampered: Vote = { ...vote, timestamp: vote.timestamp + 1 };
    assert.equal(verifyVote(tampered), false);
  });

  it('verifyVote rejects a tampered validatorAccountId', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    const tampered: Vote = { ...vote, validatorAccountId: 'mallory' };
    assert.equal(verifyVote(tampered), false);
  });

  it('verifyVote rejects a tampered validatorPublicKey (signature mismatch)', () => {
    const { base } = makeSignerInput();
    const vote = signVote(base);
    const otherKey = generateNodeIdentity();
    const tampered: Vote = { ...vote, validatorPublicKey: otherKey.publicKey };
    assert.equal(verifyVote(tampered), false);
  });

  // ── NIL ≠ empty-string blockHash ─────────────────────────────────────

  it('NIL vote canonical bytes differ from a vote on empty-string hash', () => {
    const { base } = makeSignerInput();
    const nilVote = signVote({ ...base, blockHash: null });
    const emptyHashVote = signVote({ ...base, blockHash: '' });
    assert.notEqual(canonicalVoteBytes(nilVote), canonicalVoteBytes(emptyHashVote));
    assert.notEqual(nilVote.signature, emptyHashVote.signature);
  });

  // ── Replay window ────────────────────────────────────────────────────

  it('verifyVote rejects votes outside the replay window', () => {
    const { base } = makeSignerInput();
    const vote = signVote({ ...base, now: 1_000_000 });
    // Pretend "now" is 20 minutes after the vote was minted (window=10min)
    assert.equal(
      verifyVote(vote, { nowSec: 1_000_000 + 20 * 60, replayWindowSec: 600 }),
      false,
    );
    // Within window
    assert.equal(
      verifyVote(vote, { nowSec: 1_000_000 + 60, replayWindowSec: 600 }),
      true,
    );
  });

  it('verifyVote rejects votes from the future beyond the replay window', () => {
    const { base } = makeSignerInput();
    const vote = signVote({ ...base, now: 1_000_000 + 60 * 60 });
    assert.equal(
      verifyVote(vote, { nowSec: 1_000_000, replayWindowSec: 600 }),
      false,
    );
  });

  // ── expectedPublicKey assertion ──────────────────────────────────────

  it('verifyVote with expectedPublicKey rejects a vote signed by a different key', () => {
    const { base, publicKey } = makeSignerInput();
    const vote = signVote(base);
    // Verifier expects this vote to be from a DIFFERENT validator's key
    const wrongKey = generateNodeIdentity().publicKey;
    assert.equal(verifyVote(vote, { expectedPublicKey: wrongKey }), false);
    // Same key passes
    assert.equal(verifyVote(vote, { expectedPublicKey: publicKey }), true);
  });

  // ── Malformed input handling ─────────────────────────────────────────

  it('verifyVote returns false for malformed votes (no throws)', () => {
    // missing fields, wrong types
    assert.equal(verifyVote(null as unknown as Vote), false);
    assert.equal(verifyVote({} as Vote), false);
    assert.equal(
      verifyVote({
        kind: 'badKind' as 'prevote',
        height: 1,
        round: 0,
        blockHash: 'x',
        validatorAccountId: 'a',
        validatorPublicKey: 'y',
        timestamp: Math.floor(Date.now() / 1000),
        signature: 'z',
      }),
      false,
    );
    // Negative height
    const { base } = makeSignerInput({ height: -1 });
    assert.equal(verifyVote(signVote(base)), false);
  });

  it('signVote throws on a malformed secret key', () => {
    const { base } = makeSignerInput();
    assert.throws(
      () => signVote({ ...base, validatorSecretKey: 'cafe' }),
      /Vote signing key must be 32 bytes/,
    );
  });

  // ── voteId uniqueness ────────────────────────────────────────────────

  it('voteId distinguishes by kind, height, round, validator', () => {
    const { base } = makeSignerInput();
    const v1 = signVote(base);
    const v2 = signVote({ ...base, kind: 'precommit' });
    const v3 = signVote({ ...base, height: base.height + 1 });
    const v4 = signVote({ ...base, round: base.round + 1 });
    const v5 = signVote({ ...base, validatorAccountId: 'bob' });

    const ids = new Set([voteId(v1), voteId(v2), voteId(v3), voteId(v4), voteId(v5)]);
    assert.equal(ids.size, 5);
  });

  it('voteId is the same for two votes that differ only in blockHash (double-vote case)', () => {
    // A double-voting validator: same (kind, height, round, validator),
    // different blockHash. The aggregator uses voteId for dedup, so these
    // collide — that's how slashable-equivocation evidence is detected
    // (you have two votes with the same id but different signed contents).
    const { base } = makeSignerInput();
    const v1 = signVote({ ...base, blockHash: 'aa'.repeat(32) });
    const v2 = signVote({ ...base, blockHash: 'bb'.repeat(32) });
    assert.equal(voteId(v1), voteId(v2));
    // Both are independently valid signatures
    assert.equal(verifyVote(v1), true);
    assert.equal(verifyVote(v2), true);
    // But the signatures differ (different signed payloads)
    assert.notEqual(v1.signature, v2.signature);
  });
});
