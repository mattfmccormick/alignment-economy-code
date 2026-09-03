// Vouch operations that ride a block.
//
// Why this exists
// ---------------
// A vouch locks a percentage of the voucher's own holdings (earned -> locked)
// and, on withdrawal, can reduce the vouched account's percentHuman. Both are
// consensus-relevant: the locked balance and percentHuman are in the state
// root. Yet POST /miners/vouches applied the vouch directly to one node's
// database with no gossip and no block — so a vouch created on the node that
// received the request existed nowhere else, and the two ledgers silently
// forked (different locked balances, different percentHuman). This is the same
// class of bug the account-registration and validator-change work already
// closed for their own state, and this module closes it for vouches by mirroring
// them exactly: operations are signed by the voucher, queued locally, drained
// into the block the proposer builds, folded into the block hash so they cannot
// be reordered or tampered with, and applied deterministically at commit on
// every node — live or catching up later.
//
// Determinism, the whole point
// ----------------------------
// Two things had to stop being node-local for this to be safe:
//   - the vouch id (was uuid()) is now derived from the voucher's signature, so
//     every node stores the vouch under the same id, and a later withdrawal
//     references an id all nodes agree on;
//   - the timestamp (was Date.now()) is the block timestamp, so the vouches
//     table and its audit log are byte-identical everywhere.
// The stake amount is computed from the voucher's balance AT APPLY TIME, which
// is deterministic because the block fixes the order operations apply in — the
// same reason transactions moved to commit-time execution.

import { DatabaseSync } from 'node:sqlite';
import { sha256, sign, verify } from '../core/crypto.js';
import { createVouch, withdrawVouch } from './vouching.js';
import { verificationStore } from './panel.js';
import { getAccount } from '../core/account.js';

export interface VouchOpCreate {
  type: 'vouch_create';
  /** The account creating the vouch and staking its own points. Signer. */
  voucherId: string;
  /** The account being vouched for. */
  vouchedId: string;
  /** Percentage of the voucher's holdings to stake (0 < p <= 100). */
  stakePercent: number;
  /** Unix seconds; part of the signed bytes and the replay window. */
  timestamp: number;
  /** ML-DSA-65 signature by the voucher over canonicalBytesFor(op). */
  signature: string;
}

export interface VouchOpWithdraw {
  type: 'vouch_withdraw';
  /** The voucher withdrawing — must equal the vouch's voucherId. Signer. */
  voucherId: string;
  /** The vouch being withdrawn (deterministic id from the create op). */
  vouchId: string;
  timestamp: number;
  signature: string;
}

export type VouchOperation = VouchOpCreate | VouchOpWithdraw;

/**
 * Stable, fixed-order fingerprint of one operation. None of the values can
 * contain a pipe (hex ids, an integer, a decimal), so no escaping is needed.
 * The 'vouch_create' / 'vouch_withdraw' tag keeps the two shapes from ever
 * producing the same bytes.
 */
function canonicalBytesFor(op: VouchOperation): string {
  if (op.type === 'vouch_create') {
    return `vouch_create|${op.voucherId}|${op.vouchedId}|${op.stakePercent}|${op.timestamp}`;
  }
  return `vouch_withdraw|${op.voucherId}|${op.vouchId}|${op.timestamp}`;
}

/**
 * The deterministic vouch id for a create operation: a hash of the voucher's
 * signature. Every node derives the same id from the same signed bytes, so the
 * vouches table stays identical and a later withdrawal can name the vouch.
 */
export function deriveVouchId(createOp: VouchOpCreate): string {
  return sha256(`vouch.id.v1\n${createOp.signature}`).slice(0, 40);
}

export type SignVouchCreateInput = Omit<VouchOpCreate, 'type' | 'signature'> & {
  voucherPrivateKey: string;
};
export type SignVouchWithdrawInput = Omit<VouchOpWithdraw, 'type' | 'signature'> & {
  voucherPrivateKey: string;
};

export function signVouchCreate(input: SignVouchCreateInput): VouchOpCreate {
  const unsigned: Omit<VouchOpCreate, 'signature'> = {
    type: 'vouch_create',
    voucherId: input.voucherId,
    vouchedId: input.vouchedId,
    stakePercent: input.stakePercent,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as VouchOperation));
  return { ...unsigned, signature: sign(bytes, input.voucherPrivateKey) };
}

export function signVouchWithdraw(input: SignVouchWithdrawInput): VouchOpWithdraw {
  const unsigned: Omit<VouchOpWithdraw, 'signature'> = {
    type: 'vouch_withdraw',
    voucherId: input.voucherId,
    vouchId: input.vouchId,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as VouchOperation));
  return { ...unsigned, signature: sign(bytes, input.voucherPrivateKey) };
}

/**
 * Verify an operation's signature against the voucher's account public key.
 * Pure; does not touch the DB. Returns false on any structural problem instead
 * of throwing, so a block-validation loop can drop the bad ones.
 */
export function verifyVouchOperation(op: VouchOperation, voucherPublicKey: string): boolean {
  try {
    if (op.type !== 'vouch_create' && op.type !== 'vouch_withdraw') return false;
    if (typeof op.voucherId !== 'string' || op.voucherId.length === 0) return false;
    if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return false;
    if (typeof op.signature !== 'string') return false;
    if (op.type === 'vouch_create') {
      if (typeof op.vouchedId !== 'string' || op.vouchedId.length === 0) return false;
      if (typeof op.stakePercent !== 'number' || !Number.isFinite(op.stakePercent)) return false;
    } else if (typeof op.vouchId !== 'string' || op.vouchId.length === 0) {
      return false;
    }
    const bytes = new TextEncoder().encode(canonicalBytesFor(op));
    return verify(bytes, op.signature, voucherPublicKey);
  } catch {
    return false;
  }
}

/**
 * Hash of the whole operation set, folded into the block hash. Sorted before
 * hashing so two nodes that drained in a different order still agree, and a
 * reorder-only tamper produces the same hash (reordering is not an attack;
 * dropping or adding an entry is, and both change the digest). The empty-set
 * result mirrors computeValidatorChangesHash, and the block-hash builder passes
 * null (-> '') for the empty case, so a block with no vouch ops hashes exactly
 * as it did before this lane existed — backward compatible.
 */
export function computeVouchOperationsHash(ops: VouchOperation[]): string {
  if (ops.length === 0) return sha256('no-vouch-operations');
  return sha256(ops.map(canonicalBytesFor).sort().join('|'));
}

/**
 * Apply one operation deterministically at block commit.
 *
 * Idempotent: a create whose derived id already exists is skipped (the block
 * carrying it committed before, on this node or via a re-delivered payload),
 * and a withdraw of an already-inactive vouch is skipped. Without this a block
 * replayed twice — the ordinary case where gossip and block-replay both arrive
 * — would double-apply and diverge.
 *
 * Uses the block timestamp as `now` so the vouches table and audit log are
 * identical on every node.
 */
export function applyVouchOperation(
  db: DatabaseSync,
  op: VouchOperation,
  blockTimestampSec: number,
): void {
  const verif = verificationStore(db);
  if (op.type === 'vouch_create') {
    const id = deriveVouchId(op);
    // Already applied? (re-delivery / re-replay)
    if (verif.findActiveVouchById(id)) return;
    createVouch(db, op.voucherId, op.vouchedId, op.stakePercent, {
      id,
      now: blockTimestampSec,
    });
  } else {
    // Withdraw only if the vouch is still active; otherwise this is a
    // re-delivery and must be a no-op.
    if (!verif.findActiveVouchById(op.vouchId)) return;
    withdrawVouch(db, op.vouchId, blockTimestampSec);
  }
}

/**
 * Validate an operation against local chain state the way the pre-vote dry run
 * validates a transaction: can this node apply it? Returns an error string, or
 * null when it applies. Used so a proposer does not queue — and a follower does
 * not vote for — a block carrying a vouch operation no honest node can apply.
 */
export function validateVouchOperationApplicable(db: DatabaseSync, op: VouchOperation): string | null {
  const voucher = getAccount(db, op.voucherId);
  if (!voucher) return `voucher account not found: ${op.voucherId}`;
  if (op.type === 'vouch_create') {
    if (op.voucherId === op.vouchedId) return 'cannot vouch for yourself';
    if (!getAccount(db, op.vouchedId)) return `vouched account not found: ${op.vouchedId}`;
    if (op.stakePercent <= 0 || op.stakePercent > 100) return 'stakePercent out of range';
  } else {
    const vouch = verificationStore(db).findActiveVouchById(op.vouchId);
    if (!vouch) return `active vouch not found: ${op.vouchId}`;
    if (vouch.voucherId !== op.voucherId) return 'withdrawer is not the voucher';
  }
  return null;
}

// ─── Persisted queue (mirror of pending_validator_changes) ─────────────────

/** Insert a signed operation into the local pending queue. */
export function enqueueVouchOperation(db: DatabaseSync, op: VouchOperation): number {
  const result = db
    .prepare(
      `INSERT INTO pending_vouch_operations (voucher_id, op_json, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(op.voucherId, JSON.stringify(op), Math.floor(Date.now() / 1000));
  return Number(result.lastInsertRowid);
}

/** Pending operations in FIFO order for the proposer. Does NOT delete. */
export function drainVouchOperations(db: DatabaseSync, limit = 100): VouchOperation[] {
  const rows = db
    .prepare(
      `SELECT op_json FROM pending_vouch_operations
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Array<{ op_json: string }>;
  return rows.map((r) => JSON.parse(r.op_json) as VouchOperation);
}

/** Delete queue entries matching the applied operations (by canonical bytes). */
export function removeAppliedVouchOperations(db: DatabaseSync, applied: VouchOperation[]): number {
  if (applied.length === 0) return 0;
  let removed = 0;
  const byVoucher = new Map<string, Set<string>>();
  for (const op of applied) {
    const set = byVoucher.get(op.voucherId) ?? new Set<string>();
    set.add(canonicalBytesFor(op));
    byVoucher.set(op.voucherId, set);
  }
  for (const [voucherId, canonicals] of byVoucher) {
    const rows = db
      .prepare('SELECT id, op_json FROM pending_vouch_operations WHERE voucher_id = ?')
      .all(voucherId) as Array<{ id: number; op_json: string }>;
    for (const row of rows) {
      try {
        const op = JSON.parse(row.op_json) as VouchOperation;
        if (canonicals.has(canonicalBytesFor(op))) {
          db.prepare('DELETE FROM pending_vouch_operations WHERE id = ?').run(row.id);
          removed++;
        }
      } catch {
        /* skip malformed row */
      }
    }
  }
  return removed;
}

export function pendingVouchOperationCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM pending_vouch_operations').get() as { c: number };
  return r.c;
}
