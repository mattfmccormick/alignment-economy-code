// Repository interface for block storage.
//
// This is the second of the IXxxStore interfaces (after IAccountStore).
// Blocks are append-only; the contract reflects that — there is no
// updateBlock or deleteBlock. A block, once inserted, never mutates.
//
// In Phase 3 (multi-validator consensus) the consensus engine will need to
// stage candidate blocks during voting before committing them. That use
// case can either:
//   1. Use a separate "PendingBlockStore" with delete + commit semantics
//   2. Drop in an in-memory IBlockStore for the speculative state
// Both options are clean because protocol code only touches IBlockStore.

import type { Block } from '../types.js';
import type { CommitCertificate } from '../consensus/commit-certificate.js';
import type { ValidatorInfo } from '../consensus/IValidatorSet.js';

export interface IBlockStore {
  /** Look up a block by its sequence number. Returns null if not found. */
  findByNumber(n: number): Block | null;

  /** The most recent block by number. Used by createBlock to chain. */
  findLatest(): Block | null;

  /** Every block in ascending order. Used by chain validation. */
  findAll(): Block[];

  /**
   * Append a block to the chain.
   * - For genesis (block #0), use upsert semantics (INSERT OR IGNORE) so the
   *   call is idempotent across restarts.
   * - For any other block, insert; throw on duplicate number.
   */
  insert(block: Block, isGenesis: boolean): void;

  /**
   * Persist a BFT commit certificate alongside the existing block row.
   * Only relevant for BFT consensus; AuthorityConsensus never calls this.
   * Idempotent — re-inserting the same cert overwrites the previous one.
   */
  saveCommitCertificate(blockNumber: number, cert: CommitCertificate): void;

  /**
   * Look up the commit cert for a given block height. Returns null when:
   *   - the block is genesis (no cert)
   *   - the block was committed under AuthorityConsensus (no cert)
   *   - the block doesn't exist
   *
   * ChainSync uses this on the source side to ship parentCert in sync
   * replies; the receiver uses it for cert verification on every block
   * during catch-up.
   */
  findCommitCertificate(blockNumber: number): CommitCertificate | null;

  /**
   * Delete blocks with number > 0 (preserve genesis) AND number <= cutoff.
   * Returns the count of deleted rows. Used by the 7-year rolling-window
   * pruning mechanism (WP v2 §7).
   */
  pruneBlocksThrough(cutoffNumber: number): number;

  /**
   * Persist the validator set as it was at block N. Used by BFT chains so
   * a historical cert can be verified against the contemporaneous set
   * even after validators have been slashed or deregistered. Idempotent.
   */
  saveValidatorSnapshot(blockNumber: number, validators: ValidatorInfo[]): void;

  /**
   * The validator set as of block N. Returns null for blocks that don't
   * have a snapshot (genesis, Authority blocks, blocks predating this
   * feature). When non-null, this is the set that signed cert(N).
   */
  findValidatorSnapshot(blockNumber: number): ValidatorInfo[] | null;

  /**
   * Record the account-state fingerprint as it stood after block N was fully
   * applied (transactions, fee distribution, validator changes and any day
   * cycle that block's timestamp triggered).
   *
   * The root already travelled in the gossip payload, where it was compared
   * once and thrown away. Persisting it is what lets a joining node check a
   * state snapshot against a height instead of trusting whoever handed it the
   * bytes, and lets two operators diff a specific height after the fact rather
   * than watching live logs scroll past.
   */
  saveStateRoot(blockNumber: number, root: string): void;

  /**
   * The recorded state root at block N, or null for blocks committed before
   * this was recorded (it cannot be reconstructed after the fact without
   * replaying the chain from genesis).
   */
  findStateRoot(blockNumber: number): string | null;
}
