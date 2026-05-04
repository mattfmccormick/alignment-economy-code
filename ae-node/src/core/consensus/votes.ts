// BFT consensus votes — the wire-level primitive that drives prevote and
// precommit rounds.
//
// A round of Tendermint-style consensus at height H runs:
//
//   1. Propose. The selected proposer broadcasts a candidate block.
//   2. Prevote. Every validator signs and broadcasts a Vote{kind: 'prevote'}
//      for either:
//        - the proposed block's hash (they accept it), OR
//        - null  (NIL — they reject the proposal or never saw it)
//   3. Precommit. After observing prevotes from 2/3+ of validators for the
//      same blockHash, every validator signs Vote{kind: 'precommit'} on
//      that hash. If 2/3+ prevotes did not converge, they precommit NIL
//      and the round bumps; the proposer for round+1 takes over.
//   4. Commit. Once 2/3+ precommits land for the same blockHash, the
//      block is final. The chain advances.
//
// What lives in this file: just the vote primitive — its shape, canonical
// signing bytes, sign/verify helpers, and a deduplication key. The
// machinery that COLLECTS votes, TALLIES them, and decides "did we hit
// quorum" lives in subsequent sessions on top of this primitive.
//
// Signing key: votes are signed with the validator's Ed25519 P2P / node-
// identity key (same key that signs handshakes and gossip from Session 8).
// Tendermint's "privValidator" key is conceptually separate to allow
// HSM-grade protection of the high-value voting key while letting the
// P2P key rotate freely; for Phase-3 prep we use the same key for both.
// Promoting voting to its own keypair is a follow-up session.
//
// Replay protection: a vote includes a Unix-second timestamp and is
// rejected if it falls outside ±replayWindowSec of the verifier's clock.
// Default window is 600s (10 min) — looser than the handshake window
// (300s / 5 min) because vote propagation through a partitioned network
// can be slow. The deduplication key voteId(vote) lets the aggregator
// reject duplicate (kind, height, round, validator) submissions
// regardless of timestamp.

import { ed25519 } from '@noble/curves/ed25519.js';

export type VoteKind = 'prevote' | 'precommit';

/** A signed BFT vote. Travels over the network as a NetworkMessage payload. */
export interface Vote {
  kind: VoteKind;
  /** Block height this vote applies to. */
  height: number;
  /** Round number within the height. 0 = first attempt; bumps on view changes. */
  round: number;
  /**
   * The block hash the validator is voting on, OR null for a NIL vote.
   * NIL means "I don't accept any block this round." It's how a validator
   * signals timeout / proposer-failure / disagreement without abstaining.
   */
  blockHash: string | null;
  /** The voting validator's account id (the economic identity). */
  validatorAccountId: string;
  /** The voting validator's Ed25519 P2P / node-identity public key (32 bytes hex). */
  validatorPublicKey: string;
  /** Unix seconds when the vote was minted. */
  timestamp: number;
  /** Hex Ed25519 signature over canonicalVoteBytes(vote). */
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
 * Canonical bytes that get signed for a vote. Pipe-separated so it's safe
 * even if any field contains characters that would need JSON escaping.
 * The literal '<nil>' sentinel disambiguates a NIL vote from a vote on a
 * block whose hash happened to be the empty string.
 */
export function canonicalVoteBytes(v: Omit<Vote, 'signature'>): string {
  return [
    v.kind,
    v.height,
    v.round,
    v.blockHash ?? '<nil>',
    v.validatorAccountId,
    v.validatorPublicKey,
    v.timestamp,
  ].join('|');
}

export interface SignVoteInput {
  kind: VoteKind;
  height: number;
  round: number;
  blockHash: string | null;
  validatorAccountId: string;
  validatorPublicKey: string;
  /** Hex Ed25519 secret key (32 bytes hex). */
  validatorSecretKey: string;
  /** Override timestamp (for tests / deterministic replays). */
  now?: number;
}

/** Construct + sign a vote. */
export function signVote(input: SignVoteInput): Vote {
  const sk = hexToBytes(input.validatorSecretKey);
  if (sk.length !== 32) {
    throw new Error(`Vote signing key must be 32 bytes, got ${sk.length}`);
  }
  const unsigned: Omit<Vote, 'signature'> = {
    kind: input.kind,
    height: input.height,
    round: input.round,
    blockHash: input.blockHash,
    validatorAccountId: input.validatorAccountId,
    validatorPublicKey: input.validatorPublicKey,
    timestamp: input.now ?? Math.floor(Date.now() / 1000),
  };
  const payload = canonicalVoteBytes(unsigned);
  const sig = ed25519.sign(new TextEncoder().encode(payload), sk);
  return { ...unsigned, signature: bytesToHex(sig) };
}

export interface VerifyVoteOpts {
  /** Window in seconds: vote.timestamp must be within ±this of `nowSec`. */
  replayWindowSec?: number;
  /** Override "now" (for deterministic tests). Defaults to Date.now()/1000. */
  nowSec?: number;
  /**
   * Optional: when set, the vote's validatorPublicKey must equal this. Used
   * by aggregators that already know which key they expect (e.g. they
   * looked up the validator and want to confirm the vote was signed by
   * that validator and not someone else with a known accountId).
   */
  expectedPublicKey?: string;
}

/**
 * Verify a vote's signature, key shape, and timestamp window. Returns
 * `false` for any failure mode — never throws on malformed input.
 */
export function verifyVote(vote: Vote, opts: VerifyVoteOpts = {}): boolean {
  try {
    if (!vote || typeof vote !== 'object') return false;
    if (vote.kind !== 'prevote' && vote.kind !== 'precommit') return false;
    if (typeof vote.height !== 'number' || !Number.isFinite(vote.height) || vote.height < 0) return false;
    if (typeof vote.round !== 'number' || !Number.isFinite(vote.round) || vote.round < 0) return false;
    if (vote.blockHash !== null && typeof vote.blockHash !== 'string') return false;
    if (typeof vote.validatorAccountId !== 'string' || vote.validatorAccountId.length === 0) return false;
    if (typeof vote.validatorPublicKey !== 'string') return false;
    if (typeof vote.timestamp !== 'number') return false;
    if (typeof vote.signature !== 'string') return false;

    const replayWindow = opts.replayWindowSec ?? 600;
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - vote.timestamp) > replayWindow) return false;

    if (opts.expectedPublicKey && opts.expectedPublicKey !== vote.validatorPublicKey) return false;

    const pk = hexToBytes(vote.validatorPublicKey);
    if (pk.length !== 32) return false;
    const sig = hexToBytes(vote.signature);
    if (sig.length !== 64) return false;

    const payload = canonicalVoteBytes(vote);
    return ed25519.verify(sig, new TextEncoder().encode(payload), pk);
  } catch {
    return false;
  }
}

/**
 * Deduplication key: two votes with the same id are considered "the same
 * vote" by the aggregator regardless of their timestamps or signatures.
 * This catches double-voting attempts; in Tendermint, a validator who
 * submits two different votes with the same (kind, height, round) is
 * provably malicious and gets slashed. Slashing lives in a future
 * session — this just exposes the key.
 */
export function voteId(v: Vote): string {
  return `${v.kind}:${v.height}:${v.round}:${v.validatorAccountId}`;
}
