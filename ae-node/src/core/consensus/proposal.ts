// BFT block proposal — the wire-level "I propose block X for height H,
// round R" message that kicks off a consensus round.
//
// A round at height H runs:
//
//   propose  — selected proposer broadcasts a Proposal carrying the
//              block hash they're putting up for vote
//   prevote  — every validator broadcasts a prevote (Session 14)
//   precommit — every validator broadcasts a precommit (Session 14)
//   commit   — 2/3+ precommits → CommitCertificate (Session 16) → block
//              advances to height H+1
//
// The Proposal primitive is the third BFT wire message alongside the
// two Vote kinds. It's structured the same way (canonical payload, sign,
// verify with replay window, optional expectedPublicKey assertion) so
// receiver code that already handles votes can fan in proposals without
// learning a new pattern.
//
// What's NOT in this file: the round state machine that consumes
// proposals + votes and decides when to commit. That's a separate module
// so its rules can be tested without timers or network plumbing.
//
// Signing key: same Ed25519 P2P / node-identity key that signs handshakes
// (Session 8) and votes (Session 14). The proposal's proposerPublicKey
// is what an aggregator/round-controller uses to confirm the proposal
// came from the validator who was supposed to propose for this height.

import { ed25519 } from '@noble/curves/ed25519.js';

/** A signed BFT block proposal. */
export interface Proposal {
  /** Block height being proposed for. */
  height: number;
  /** Round number within the height (bumps on view changes). */
  round: number;
  /**
   * The hash of the proposed block. Unlike Vote, a Proposal cannot be NIL —
   * "I have no block to propose" isn't a thing; the round simply times out
   * and proposer rotates.
   */
  blockHash: string;
  /** The proposing validator's account id. */
  proposerAccountId: string;
  /** The proposing validator's Ed25519 P2P / node-identity public key (32 bytes hex). */
  proposerPublicKey: string;
  /** Unix seconds when the proposal was minted. */
  timestamp: number;
  /** Hex Ed25519 signature over canonicalProposalBytes(proposal). */
  signature: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Canonical bytes that get signed for a proposal. Pipe-separated, same
 * shape as canonicalVoteBytes. The literal 'proposal' tag in the prefix
 * ensures the signed bytes can never collide with a vote's canonical
 * payload — defense-in-depth against domain-confusion attacks.
 */
export function canonicalProposalBytes(p: Omit<Proposal, 'signature'>): string {
  return [
    'proposal',
    p.height,
    p.round,
    p.blockHash,
    p.proposerAccountId,
    p.proposerPublicKey,
    p.timestamp,
  ].join('|');
}

export interface SignProposalInput {
  height: number;
  round: number;
  blockHash: string;
  proposerAccountId: string;
  proposerPublicKey: string;
  /** Hex Ed25519 secret key (32 bytes hex). */
  proposerSecretKey: string;
  /** Override timestamp (for tests / deterministic replays). */
  now?: number;
}

/** Construct + sign a proposal. */
export function signProposal(input: SignProposalInput): Proposal {
  const sk = hexToBytes(input.proposerSecretKey);
  if (sk.length !== 32) {
    throw new Error(`Proposal signing key must be 32 bytes, got ${sk.length}`);
  }
  if (typeof input.blockHash !== 'string' || input.blockHash.length === 0) {
    throw new Error('Proposal blockHash must be a non-empty string');
  }
  const unsigned: Omit<Proposal, 'signature'> = {
    height: input.height,
    round: input.round,
    blockHash: input.blockHash,
    proposerAccountId: input.proposerAccountId,
    proposerPublicKey: input.proposerPublicKey,
    timestamp: input.now ?? Math.floor(Date.now() / 1000),
  };
  const payload = canonicalProposalBytes(unsigned);
  const sig = ed25519.sign(new TextEncoder().encode(payload), sk);
  return { ...unsigned, signature: bytesToHex(sig) };
}

export interface VerifyProposalOpts {
  /** Window in seconds: proposal.timestamp must be within ±this of `nowSec`. Default 600s. */
  replayWindowSec?: number;
  /** Override "now" (for deterministic tests). Defaults to Date.now()/1000. */
  nowSec?: number;
  /**
   * Optional: when set, the proposal's proposerPublicKey must equal this.
   * Used by round-controllers that already know which key they expect for
   * the current proposer.
   */
  expectedPublicKey?: string;
}

/**
 * Verify a proposal's signature, key shape, and timestamp window. Returns
 * `false` for any failure mode — never throws on malformed input.
 */
export function verifyProposal(proposal: Proposal, opts: VerifyProposalOpts = {}): boolean {
  try {
    if (!proposal || typeof proposal !== 'object') return false;
    if (typeof proposal.height !== 'number' || !Number.isFinite(proposal.height) || proposal.height < 0) return false;
    if (typeof proposal.round !== 'number' || !Number.isFinite(proposal.round) || proposal.round < 0) return false;
    if (typeof proposal.blockHash !== 'string' || proposal.blockHash.length === 0) return false;
    if (typeof proposal.proposerAccountId !== 'string' || proposal.proposerAccountId.length === 0) return false;
    if (typeof proposal.proposerPublicKey !== 'string') return false;
    if (typeof proposal.timestamp !== 'number') return false;
    if (typeof proposal.signature !== 'string') return false;

    const replayWindow = opts.replayWindowSec ?? 600;
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - proposal.timestamp) > replayWindow) return false;

    if (opts.expectedPublicKey && opts.expectedPublicKey !== proposal.proposerPublicKey) return false;

    const pk = hexToBytes(proposal.proposerPublicKey);
    if (pk.length !== 32) return false;
    const sig = hexToBytes(proposal.signature);
    if (sig.length !== 64) return false;

    const payload = canonicalProposalBytes(proposal);
    return ed25519.verify(sig, new TextEncoder().encode(payload), pk);
  } catch {
    return false;
  }
}

/**
 * Deduplication key. Two proposals with the same id are considered "the
 * same proposal slot" — the proposer for (height, round). Two proposals
 * with the same id but different signed contents (typically: different
 * blockHash) is provable proposer-equivocation, the analog of the
 * double-vote case. The round controller will use this to detect
 * misbehaving proposers; slashing logic ships in a future session.
 */
export function proposalId(p: Proposal): string {
  return `proposal:${p.height}:${p.round}:${p.proposerAccountId}`;
}
