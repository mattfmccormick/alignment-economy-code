// On-chain validator changes.
//
// Sessions 41-47 built the validator lifecycle:
//   - Genesis spec seeds the initial set (Session 41)
//   - API endpoints for register / deregister at runtime (Session 46)
//   - End-to-end churn test demonstrates manual cross-DB sync (Session 47)
//
// Phase 53 explicitly documented the limitation: a runtime register
// or deregister only updates the local DB it was called against. To
// keep two validators' sets in sync, the test had to call both APIs
// independently. That works for tests but doesn't scale: in a real
// network, every node needs the same view, and a node that was
// offline during the API call wouldn't see the change at all.
//
// This module defines the ON-CHAIN mechanism. A ValidatorChange is a
// signed message describing one of:
//   - register: stake earned points + register node and VRF keys
//   - deregister: unlock stake, mark inactive
//
// Changes ride alongside transactions in a block payload. When the
// block commits on every node, each change applies deterministically
// via the existing registerValidator / deregisterValidator functions
// using `now = block.timestamp` so audit-log timestamps stay
// byte-identical across nodes.
//
// Out of scope for this session (tracked as follow-ups):
//   - API endpoints that enqueue changes instead of direct apply
//   - Persisted queue table for proposers to drain
//   - Block-hash inclusion of the changes (defense-in-depth)
//   - Sync-replay of changes when catching up past the chain head

import { DatabaseSync } from 'node:sqlite';
import { sign, verify, sha256 } from '../crypto.js';
import {
  registerValidator,
  deregisterValidator,
} from './registration.js';

/**
 * One validator-state change. Discriminated by `type`. Both variants
 * carry an outer signature that must verify against the affected
 * account's ML-DSA-65 publicKey.
 *
 * Stake, when present, is fixed-precision bigint encoded as a base-10
 * string for JSON portability.
 */
export type ValidatorChange = ValidatorChangeRegister | ValidatorChangeDeregister;

export interface ValidatorChangeRegister {
  type: 'register';
  /** The account performing the registration. Signature MUST verify against this account's publicKey. */
  accountId: string;
  /** Hex Ed25519 P2P-layer key (32 bytes / 64 chars). */
  nodePublicKey: string;
  /** Hex Ed25519 VRF key. */
  vrfPublicKey: string;
  /** Stake to lock, fixed-precision bigint as base-10 string. */
  stake: string;
  /** Unix-second timestamp (replay window check on the receive side). */
  timestamp: number;
  /** ML-DSA-65 signature over the canonical bytes (see canonicalBytesFor). */
  signature: string;
}

export interface ValidatorChangeDeregister {
  type: 'deregister';
  /** The account performing the deregistration. Must equal the validator's accountId. */
  accountId: string;
  /** Unix-second timestamp. */
  timestamp: number;
  /** ML-DSA-65 signature over the canonical bytes. */
  signature: string;
}

/**
 * Canonical bytes that get signed. Stable across implementations: the
 * exact same string for the same logical change, regardless of how
 * fields were ordered when constructing the JSON. This matters because
 * a signed change might travel through several JSON encode/decode
 * cycles before verification.
 */
function canonicalBytesFor(change: ValidatorChange): string {
  if (change.type === 'register') {
    return [
      'register',
      change.accountId,
      change.nodePublicKey,
      change.vrfPublicKey,
      change.stake,
      change.timestamp,
    ].join('|');
  }
  // deregister
  return ['deregister', change.accountId, change.timestamp].join('|');
}

/**
 * Inputs to signValidatorChange. The signing-side helper builds the
 * change object, computes canonical bytes, signs them with the
 * account's ML-DSA private key, and returns the fully-signed change.
 */
export type SignValidatorChangeRegisterInput = Omit<
  ValidatorChangeRegister,
  'type' | 'signature'
> & { accountPrivateKey: string };

export type SignValidatorChangeDeregisterInput = Omit<
  ValidatorChangeDeregister,
  'type' | 'signature'
> & { accountPrivateKey: string };

export function signValidatorChangeRegister(
  input: SignValidatorChangeRegisterInput,
): ValidatorChangeRegister {
  const unsigned: Omit<ValidatorChangeRegister, 'signature'> = {
    type: 'register',
    accountId: input.accountId,
    nodePublicKey: input.nodePublicKey,
    vrfPublicKey: input.vrfPublicKey,
    stake: input.stake,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as ValidatorChange));
  const signature = sign(bytes, input.accountPrivateKey);
  return { ...unsigned, signature };
}

export function signValidatorChangeDeregister(
  input: SignValidatorChangeDeregisterInput,
): ValidatorChangeDeregister {
  const unsigned: Omit<ValidatorChangeDeregister, 'signature'> = {
    type: 'deregister',
    accountId: input.accountId,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as ValidatorChange));
  const signature = sign(bytes, input.accountPrivateKey);
  return { ...unsigned, signature };
}

/**
 * Verify a change's signature against the account's publicKey. Pure —
 * does NOT consult the DB. Returns false on any structural problem
 * (bad hex, wrong shape) instead of throwing, so callers can use this
 * in a "skip the bad ones, accept the good ones" loop.
 */
export function verifyValidatorChange(
  change: ValidatorChange,
  accountPublicKey: string,
): boolean {
  try {
    if (typeof change?.type !== 'string') return false;
    if (change.type !== 'register' && change.type !== 'deregister') return false;
    if (typeof change.accountId !== 'string' || change.accountId.length === 0) return false;
    if (typeof change.timestamp !== 'number' || !Number.isFinite(change.timestamp)) return false;
    if (typeof change.signature !== 'string') return false;
    if (change.type === 'register') {
      if (typeof change.nodePublicKey !== 'string') return false;
      if (typeof change.vrfPublicKey !== 'string') return false;
      if (typeof change.stake !== 'string') return false;
    }
    const bytes = new TextEncoder().encode(canonicalBytesFor(change));
    return verify(bytes, change.signature, accountPublicKey);
  } catch {
    return false;
  }
}

/**
 * Stable digest of a list of changes, used by future block-hash
 * promotion. Sort-independent: changes are sorted by canonical bytes
 * before hashing, so two block producers with the same logical set
 * produce the same digest regardless of insertion order. Returns a
 * 64-char hex string, same shape as a block hash.
 */
export function computeValidatorChangesHash(changes: ValidatorChange[]): string {
  if (changes.length === 0) return sha256('no-changes');
  const canon = changes.map(canonicalBytesFor).sort().join('|');
  return sha256(canon);
}

/**
 * Apply a single change deterministically to the DB. Calls the existing
 * register / deregister helpers with `now = blockTimestampSec` so
 * timestamps in the validators table and audit log are byte-identical
 * across nodes.
 *
 * Throws on any application failure (e.g., insufficient earned balance,
 * already registered, not a validator). Callers should catch + log;
 * in practice every honest validator agrees on whether a change
 * applies because they all see the same chain state.
 */
export function applyValidatorChange(
  db: DatabaseSync,
  change: ValidatorChange,
  blockTimestampSec: number,
): void {
  if (change.type === 'register') {
    registerValidator(db, {
      accountId: change.accountId,
      nodePublicKey: change.nodePublicKey,
      vrfPublicKey: change.vrfPublicKey,
      stake: BigInt(change.stake),
      now: blockTimestampSec,
    });
  } else {
    deregisterValidator(db, {
      accountId: change.accountId,
      now: blockTimestampSec,
    });
  }
}

// ─── Persisted queue (Session 49) ──────────────────────────────────────
//
// Local-only queue holding signed ValidatorChanges that haven't yet
// landed in a block. The BFT proposer drains via drainValidatorChanges
// when building each candidate block; after the block commits on every
// node, the proposer's onValidatorChangesApplied callback removes the
// drained entries via removeAppliedValidatorChanges.
//
// Stored as JSON because the shape varies by `type`. We re-validate
// signatures at validateIncomingBlock time on the receive side, so the
// queue itself doesn't enforce signature validity at insert — that's
// the caller's job.

/**
 * Insert a signed change into the local pending queue. Returns the
 * row id (auto-incrementing) which the caller can ignore — drain
 * works by ordered scan, not by id reference.
 *
 * Idempotent semantics not enforced: duplicate inserts of the same
 * (accountId, type, timestamp) tuple will produce duplicate queue
 * entries. The proposer drains all of them; the apply step throws on
 * the second one (already-registered) and the runTransaction wrapping
 * the commit rolls back. Callers who need idempotency should check
 * before enqueueing.
 */
export function enqueueValidatorChange(
  db: DatabaseSync,
  change: ValidatorChange,
): number {
  const json = JSON.stringify(change);
  const result = db
    .prepare(
      `INSERT INTO pending_validator_changes (account_id, change_json, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(change.accountId, json, Math.floor(Date.now() / 1000));
  return Number(result.lastInsertRowid);
}

/**
 * Pull pending changes from the queue in FIFO order (created_at ASC,
 * id ASC as a tiebreaker for same-second inserts). The optional limit
 * caps the number returned per block; callers passing it can spread
 * a large backlog across multiple blocks.
 *
 * Does NOT delete from the queue. Deletion happens in
 * removeAppliedValidatorChanges, called by the proposer after the
 * block commits. This split lets the proposer abort cleanly on commit
 * failure: the entries stay queued for retry.
 */
export function drainValidatorChanges(
  db: DatabaseSync,
  limit: number = 100,
): ValidatorChange[] {
  const rows = db
    .prepare(
      `SELECT change_json FROM pending_validator_changes
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Array<{ change_json: string }>;
  return rows.map((r) => JSON.parse(r.change_json) as ValidatorChange);
}

/**
 * Delete entries from the queue matching the given changes. Matched by
 * canonical bytes (the same fingerprint used for signing) so an entry
 * is removed regardless of JSON-key-order differences. Idempotent:
 * missing entries are silently no-ops.
 *
 * The implementation deletes by account_id + canonical-bytes match.
 * Multiple entries with identical canonical bytes (theoretically
 * possible if the same change was enqueued twice) all get removed.
 */
export function removeAppliedValidatorChanges(
  db: DatabaseSync,
  applied: ValidatorChange[],
): number {
  if (applied.length === 0) return 0;
  let removed = 0;
  // Group rows by accountId for cheaper scans
  const byAccount = new Map<string, Set<string>>();
  for (const change of applied) {
    const set = byAccount.get(change.accountId) ?? new Set<string>();
    set.add(canonicalBytesFor(change));
    byAccount.set(change.accountId, set);
  }
  for (const [accountId, canonicals] of byAccount) {
    const rows = db
      .prepare(
        `SELECT id, change_json FROM pending_validator_changes WHERE account_id = ?`,
      )
      .all(accountId) as Array<{ id: number; change_json: string }>;
    for (const row of rows) {
      try {
        const c = JSON.parse(row.change_json) as ValidatorChange;
        if (canonicals.has(canonicalBytesFor(c))) {
          db.prepare('DELETE FROM pending_validator_changes WHERE id = ?').run(row.id);
          removed++;
        }
      } catch {
        // Skip malformed rows; they shouldn't exist but a damaged
        // queue entry isn't a reason to abort the cleanup pass.
      }
    }
  }
  return removed;
}

/** Returns the current queue depth. Useful for tests + telemetry. */
export function pendingValidatorChangeCount(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM pending_validator_changes')
    .get() as { cnt: number };
  return row.cnt;
}
