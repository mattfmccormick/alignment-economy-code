// Phase 24: BFT proposal primitive — sign + verify.
//
// Verifies the wire-level proposal primitive that Sessions 19+ will hook
// into the round state machine and the network transport:
//
//   1. signProposal → verifyProposal round-trips
//   2. Tampering with each signed field fails verification:
//      blockHash, height, round, timestamp, proposerAccountId,
//      proposerPublicKey
//   3. canonicalProposalBytes is domain-tagged with 'proposal' so a
//      proposal's signed payload can never collide with a vote's
//   4. Replay-window enforcement: stale or future proposals rejected
//   5. expectedPublicKey assertion: refuses a proposal claiming to be
//      from a different proposer than the controller expects
//   6. signProposal validates inputs (32-byte secret key, non-empty
//      blockHash)
//   7. Malformed proposals return false instead of throwing
//   8. proposalId distinguishes (height, round, proposer); collides on
//      double-proposal (same slot, different blockHash)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import {
  signProposal,
  verifyProposal,
  proposalId,
  canonicalProposalBytes,
  type Proposal,
} from '../src/core/consensus/proposal.js';
import { canonicalVoteBytes } from '../src/core/consensus/votes.js';

function makeSigner(overrides: Partial<Parameters<typeof signProposal>[0]> = {}) {
  const id = generateNodeIdentity();
  return {
    base: {
      height: 100,
      round: 0,
      blockHash: 'deadbeef'.repeat(8),
      proposerAccountId: 'alice',
      proposerPublicKey: id.publicKey,
      proposerSecretKey: id.secretKey,
      ...overrides,
    },
    publicKey: id.publicKey,
  };
}

describe('Phase 24: BFT proposal primitive', () => {
  // ── Round-trip ───────────────────────────────────────────────────────

  it('signProposal → verifyProposal round-trips', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    assert.equal(verifyProposal(p), true);
    assert.equal(p.signature.length, 128); // 64 bytes hex
  });

  // ── Field-by-field tampering ─────────────────────────────────────────

  it('rejects a tampered blockHash', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    const t: Proposal = { ...p, blockHash: 'cafebabe'.repeat(8) };
    assert.equal(verifyProposal(t), false);
  });

  it('rejects a tampered height', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    const t: Proposal = { ...p, height: p.height + 1 };
    assert.equal(verifyProposal(t), false);
  });

  it('rejects a tampered round', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    const t: Proposal = { ...p, round: p.round + 1 };
    assert.equal(verifyProposal(t), false);
  });

  it('rejects a tampered timestamp', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    const t: Proposal = { ...p, timestamp: p.timestamp + 1 };
    assert.equal(verifyProposal(t), false);
  });

  it('rejects a tampered proposerAccountId', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    const t: Proposal = { ...p, proposerAccountId: 'mallory' };
    assert.equal(verifyProposal(t), false);
  });

  it('rejects a tampered proposerPublicKey (signature mismatch)', () => {
    const { base } = makeSigner();
    const p = signProposal(base);
    const otherKey = generateNodeIdentity();
    const t: Proposal = { ...p, proposerPublicKey: otherKey.publicKey };
    assert.equal(verifyProposal(t), false);
  });

  // ── Domain separation: proposal canonical bytes ≠ vote canonical bytes ──

  it('proposal canonical bytes are domain-tagged so they cannot collide with vote bytes', () => {
    const { base } = makeSigner();
    const proposalBytes = canonicalProposalBytes({
      height: base.height,
      round: base.round,
      blockHash: base.blockHash,
      proposerAccountId: base.proposerAccountId,
      proposerPublicKey: base.proposerPublicKey,
      timestamp: 1_000_000,
    });
    const voteBytes = canonicalVoteBytes({
      kind: 'prevote',
      height: base.height,
      round: base.round,
      blockHash: base.blockHash,
      validatorAccountId: base.proposerAccountId,
      validatorPublicKey: base.proposerPublicKey,
      timestamp: 1_000_000,
    });
    assert.notEqual(proposalBytes, voteBytes);
    // The 'proposal' tag is the domain separator
    assert.ok(proposalBytes.startsWith('proposal|'));
    assert.ok(voteBytes.startsWith('prevote|'));
  });

  // ── Replay window ────────────────────────────────────────────────────

  it('rejects proposals outside the replay window', () => {
    const { base } = makeSigner();
    const p = signProposal({ ...base, now: 1_000_000 });
    // 20 minutes after sign, window is 10 min
    assert.equal(
      verifyProposal(p, { nowSec: 1_000_000 + 20 * 60, replayWindowSec: 600 }),
      false,
    );
    // Within window
    assert.equal(
      verifyProposal(p, { nowSec: 1_000_000 + 60, replayWindowSec: 600 }),
      true,
    );
  });

  it('rejects proposals from the future beyond the replay window', () => {
    const { base } = makeSigner();
    const p = signProposal({ ...base, now: 1_000_000 + 60 * 60 });
    assert.equal(
      verifyProposal(p, { nowSec: 1_000_000, replayWindowSec: 600 }),
      false,
    );
  });

  // ── expectedPublicKey assertion ──────────────────────────────────────

  it('expectedPublicKey rejects a proposal signed by a different key', () => {
    const { base, publicKey } = makeSigner();
    const p = signProposal(base);
    const wrongKey = generateNodeIdentity().publicKey;
    assert.equal(verifyProposal(p, { expectedPublicKey: wrongKey }), false);
    assert.equal(verifyProposal(p, { expectedPublicKey: publicKey }), true);
  });

  // ── Input validation ─────────────────────────────────────────────────

  it('signProposal throws on a malformed secret key', () => {
    const { base } = makeSigner();
    assert.throws(
      () => signProposal({ ...base, proposerSecretKey: 'cafe' }),
      /signing key must be 32 bytes/,
    );
  });

  it('signProposal throws on an empty blockHash', () => {
    const { base } = makeSigner();
    assert.throws(
      () => signProposal({ ...base, blockHash: '' }),
      /non-empty string/,
    );
  });

  // ── Malformed input handling ─────────────────────────────────────────

  it('verifyProposal returns false for malformed proposals (no throws)', () => {
    assert.equal(verifyProposal(null as unknown as Proposal), false);
    assert.equal(verifyProposal({} as Proposal), false);

    const { base } = makeSigner();
    const p = signProposal(base);

    // Empty blockHash on the wire
    assert.equal(verifyProposal({ ...p, blockHash: '' }), false);
    // Negative height
    assert.equal(verifyProposal({ ...p, height: -1 }), false);
    // Negative round
    assert.equal(verifyProposal({ ...p, round: -1 }), false);
    // Empty proposerAccountId
    assert.equal(verifyProposal({ ...p, proposerAccountId: '' }), false);
  });

  // ── proposalId ───────────────────────────────────────────────────────

  it('proposalId distinguishes by height, round, proposer', () => {
    const { base } = makeSigner();
    const a = signProposal(base);
    const b = signProposal({ ...base, height: base.height + 1 });
    const c = signProposal({ ...base, round: base.round + 1 });
    const d = signProposal({ ...base, proposerAccountId: 'bob' });

    const ids = new Set([proposalId(a), proposalId(b), proposalId(c), proposalId(d)]);
    assert.equal(ids.size, 4);
  });

  it('proposalId is the same for two proposals that differ only in blockHash (double-proposal case)', () => {
    // A proposer who signs two different blocks for the same (height, round)
    // is provably misbehaving — same proposalId, different signed contents.
    // Aggregator/controller can detect this and slash later.
    const { base } = makeSigner();
    const a = signProposal({ ...base, blockHash: 'aa'.repeat(32) });
    const b = signProposal({ ...base, blockHash: 'bb'.repeat(32) });
    assert.equal(proposalId(a), proposalId(b));
    assert.equal(verifyProposal(a), true);
    assert.equal(verifyProposal(b), true);
    assert.notEqual(a.signature, b.signature);
  });
});
