// Vote aggregation for one (kind, height, round) tuple.
//
// A VoteSet is the in-memory data structure a validator (or anyone running
// a BFT node) maintains while a round is in flight. Votes arrive over the
// network from peers; the aggregator:
//
//   1. Verifies each vote's signature.
//   2. Confirms the voter is in the configured validator set.
//   3. Confirms the voter's wire publicKey matches their registered key
//      (no impersonation by accountId).
//   4. Dedupes — if the same validator sends the same vote twice, ignore.
//   5. Detects equivocation — same (kind, height, round, validator) but a
//      different signed payload (typically: different blockHash). Both
//      votes are kept as slashable evidence; the FIRST is what counts
//      toward the tally so a malicious validator can't flip their vote
//      after the fact.
//   6. Tallies votes per blockHash (with NIL counted as its own bucket).
//   7. Answers `hasQuorum(blockHash)` and `quorumBlockHash()` against the
//      validator set's quorumCount().
//
// What does NOT live here: the round state machine (when do we advance
// from prevote to precommit?), the proposer logic (who proposes?), or
// the finality decision (when is a block committed?). Those compose this
// primitive in Sessions 16+.
//
// Quorum policy: count-based, matching IValidatorSet.quorumCount() which
// is floor(2N/3) + 1. Stake-weighted quorum can plug in by replacing the
// quorumCount() call without changing this module's interface.

import type { Vote } from './votes.js';
import { verifyVote, voteId } from './votes.js';
import type { IValidatorSet, ValidatorInfo } from './IValidatorSet.js';

const NIL_KEY = '<nil>';

function blockKey(hash: string | null): string {
  return hash === null ? NIL_KEY : hash;
}

export interface EquivocationEvidence {
  /** The vote we already had recorded for this voteId. */
  first: Vote;
  /** The conflicting vote that arrived second. */
  second: Vote;
}

export type AddVoteResult =
  | { status: 'added' }
  | { status: 'duplicate' }
  | { status: 'equivocation'; evidence: EquivocationEvidence }
  | { status: 'rejected'; reason: string };

export interface VoteSetOptions {
  /** Window in seconds for replay-window check on each incoming vote. */
  replayWindowSec?: number;
  /** Override "now" in seconds for deterministic tests. */
  nowSec?: () => number;
}

/**
 * Aggregator for one (kind, height, round) bucket.
 *
 * Construct one VoteSet per (prevote/precommit, height, round) the node is
 * tracking. The validator set is captured at construction — if it changes
 * mid-round, build a new VoteSet for the next round. (Validator-set
 * changes happen at height boundaries in Tendermint anyway.)
 */
export class VoteSet {
  readonly kind: Vote['kind'];
  readonly height: number;
  readonly round: number;

  private readonly validatorSet: IValidatorSet;
  private readonly options: Required<VoteSetOptions>;
  /** Map<voteId, Vote> — the FIRST accepted vote for each id. */
  private readonly votes = new Map<string, Vote>();
  /** All equivocation evidence collected so far. */
  private readonly equivocations: EquivocationEvidence[] = [];
  /** Map<blockKey, Set<accountId>> — tally per block (or NIL). */
  private readonly tallyByBlock = new Map<string, Set<string>>();

  constructor(
    kind: Vote['kind'],
    height: number,
    round: number,
    validatorSet: IValidatorSet,
    opts: VoteSetOptions = {},
  ) {
    this.kind = kind;
    this.height = height;
    this.round = round;
    this.validatorSet = validatorSet;
    this.options = {
      replayWindowSec: opts.replayWindowSec ?? 600,
      nowSec: opts.nowSec ?? (() => Math.floor(Date.now() / 1000)),
    };
  }

  /**
   * Try to add a vote to the set. Returns the disposition.
   */
  addVote(vote: Vote): AddVoteResult {
    // 1. Bucket sanity: this VoteSet is for ONE (kind, height, round).
    if (vote.kind !== this.kind) {
      return { status: 'rejected', reason: `kind mismatch: expected ${this.kind}, got ${vote.kind}` };
    }
    if (vote.height !== this.height) {
      return { status: 'rejected', reason: `height mismatch: expected ${this.height}, got ${vote.height}` };
    }
    if (vote.round !== this.round) {
      return { status: 'rejected', reason: `round mismatch: expected ${this.round}, got ${vote.round}` };
    }

    // 2. Validator membership: is this account in the active set, and does
    //    the wire publicKey match what they registered?
    const validator = this.validatorSet.findByAccountId(vote.validatorAccountId);
    if (!validator) {
      return {
        status: 'rejected',
        reason: `validator ${vote.validatorAccountId} is not in the active set`,
      };
    }
    if (!validator.isActive) {
      return { status: 'rejected', reason: `validator ${vote.validatorAccountId} is inactive` };
    }
    if (validator.nodePublicKey !== vote.validatorPublicKey) {
      return {
        status: 'rejected',
        reason: `vote publicKey does not match registered nodePublicKey for ${vote.validatorAccountId}`,
      };
    }

    // 3. Cryptographic verification with replay-window enforcement.
    const ok = verifyVote(vote, {
      replayWindowSec: this.options.replayWindowSec,
      nowSec: this.options.nowSec(),
      expectedPublicKey: validator.nodePublicKey,
    });
    if (!ok) {
      return { status: 'rejected', reason: 'signature/replay verification failed' };
    }

    // 4. Dedup + equivocation. Two votes with the same id are either
    //    identical (drop) or a slashable double-vote (keep evidence,
    //    don't change the tally — first vote wins).
    const id = voteId(vote);
    const existing = this.votes.get(id);
    if (existing) {
      if (existing.signature === vote.signature) {
        // Byte-identical resend. Common over a noisy gossip network.
        return { status: 'duplicate' };
      }
      // Different signature with same voteId means the validator signed
      // two different payloads at the same (kind, height, round). This is
      // the canonical equivocation evidence.
      const evidence: EquivocationEvidence = { first: existing, second: vote };
      this.equivocations.push(evidence);
      return { status: 'equivocation', evidence };
    }

    // 5. New vote — record it and update the tally.
    this.votes.set(id, vote);
    const key = blockKey(vote.blockHash);
    let bucket = this.tallyByBlock.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      this.tallyByBlock.set(key, bucket);
    }
    bucket.add(vote.validatorAccountId);

    return { status: 'added' };
  }

  /** All accepted votes (one per (kind, height, round, validator)). */
  allVotes(): Vote[] {
    return Array.from(this.votes.values());
  }

  /** Number of distinct validators that have voted in this set. */
  size(): number {
    return this.votes.size;
  }

  /**
   * Map<blockHash | '<nil>' , number> — count of distinct validators who
   * voted on each block (or NIL).
   */
  tally(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, set] of this.tallyByBlock) out.set(key, set.size);
    return out;
  }

  /**
   * Sum of stake of distinct validators who voted on `blockHash`. Returns
   * 0n if no votes for that block. Pass null for the NIL bucket.
   */
  stakeFor(blockHash: string | null): bigint {
    const set = this.tallyByBlock.get(blockKey(blockHash));
    if (!set) return 0n;
    let total = 0n;
    for (const accountId of set) {
      const v = this.validatorSet.findByAccountId(accountId);
      if (v) total += v.stake;
    }
    return total;
  }

  /** True if the vote count for `blockHash` (or NIL) reaches quorumCount(). */
  hasQuorum(blockHash: string | null): boolean {
    const quorum = this.validatorSet.quorumCount();
    if (quorum === 0) return false;
    const set = this.tallyByBlock.get(blockKey(blockHash));
    if (!set) return false;
    return set.size >= quorum;
  }

  /**
   * The blockHash (or null for NIL) that has reached quorum, if any. If
   * multiple blocks somehow reach quorum simultaneously (only possible
   * with a Byzantine majority — a network-fail / safety-violation
   * scenario) the lower-by-string-compare blockHash is returned.
   *
   * Returns:
   *   - the actual hash string when a real block has quorum
   *   - null when NO block has quorum
   *   - the literal '<nil>' string when NIL has quorum (meaning the round
   *     conclusively rejected all proposals; caller advances to round+1)
   */
  quorumBlockHash(): string | null {
    const quorum = this.validatorSet.quorumCount();
    if (quorum === 0) return null;
    const winners: string[] = [];
    for (const [key, set] of this.tallyByBlock) {
      if (set.size >= quorum) winners.push(key);
    }
    if (winners.length === 0) return null;
    winners.sort();
    return winners[0];
  }

  /**
   * Convenience: did any block (real, not NIL) reach quorum? Returns the
   * hash if so, null otherwise. Used by the round state machine to decide
   * "do we precommit on a block, or precommit NIL and advance the round?"
   */
  committedBlockHash(): string | null {
    const winner = this.quorumBlockHash();
    if (winner === null || winner === NIL_KEY) return null;
    return winner;
  }

  /** All equivocation evidence collected so far (slashable misbehavior). */
  getEquivocations(): readonly EquivocationEvidence[] {
    return this.equivocations;
  }

  /** The list of validators (accountId) we still haven't seen a vote from. */
  missingValidators(): string[] {
    const missing: string[] = [];
    for (const v of this.validatorSet.listActive() as ValidatorInfo[]) {
      // Has this validator voted on ANY block in this round?
      let voted = false;
      for (const set of this.tallyByBlock.values()) {
        if (set.has(v.accountId)) {
          voted = true;
          break;
        }
      }
      if (!voted) missing.push(v.accountId);
    }
    return missing;
  }
}
