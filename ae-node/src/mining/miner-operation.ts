// Miner registration operations that ride a block.
//
// Why this exists
// ---------------
// Who is a miner is consensus-relevant: the active miner set decides the fee
// split (tier 1 vs tier 2), the fee lottery, and (once panels are chain-ordered)
// who is assigned to review a verification panel. Yet registerMiner wrote to one
// node's local `miners` table with no gossip and no block, so the set differed
// per node - the fork source behind the fee-distribution findings (#5/#7) and
// the reason the daily-mint exclusion had to be dropped (#6). This module puts
// registration on the chain, mirroring exactly what vouch-operation /
// account-registration / validator-change already do: a signed operation,
// queued locally, gossiped so any proposer includes it, folded into the block
// hash, and applied deterministically at commit on every node.
//
// Determinism
// -----------
// Two node-local inputs had to go: the miner id (was uuid(), now derived from
// the signature) and the timestamp (was Date.now(), now the block timestamp).
// The bootstrap-window check (registerMiner) reads countActiveMiners(), which is
// deterministic once the set itself is chain-ordered - every node has applied
// the same registrations in the same block order. The percentHuman floor for
// NON-bootstrap miners still depends on percentHuman being chain state (panels),
// which is the next piece; bootstrap-window registration is fully deterministic
// today.

import { DatabaseSync } from 'node:sqlite';
import { sha256, sign, verify } from '../core/crypto.js';
import { registerMiner, deactivateMiner, getMinerByAccount } from './registration.js';
import { getAccount } from '../core/account.js';

export interface MinerOpRegister {
  type: 'miner_register';
  /** The account registering as a miner. Signer. */
  accountId: string;
  timestamp: number;
  signature: string;
}

export interface MinerOpDeregister {
  type: 'miner_deregister';
  /** The account leaving the miner set. Signer; must own the miner. */
  accountId: string;
  timestamp: number;
  signature: string;
}

export type MinerOperation = MinerOpRegister | MinerOpDeregister;

function canonicalBytesFor(op: MinerOperation): string {
  return `${op.type}|${op.accountId}|${op.timestamp}`;
}

/**
 * Deterministic miner id for a register op: a hash of the signature, so every
 * node stores the miner under the same id.
 */
export function deriveMinerId(op: MinerOpRegister): string {
  return sha256(`miner.id.v1\n${op.signature}`).slice(0, 40);
}

export type SignMinerRegisterInput = { accountId: string; timestamp: number; accountPrivateKey: string };
export type SignMinerDeregisterInput = SignMinerRegisterInput;

export function signMinerRegister(input: SignMinerRegisterInput): MinerOpRegister {
  const unsigned: Omit<MinerOpRegister, 'signature'> = {
    type: 'miner_register',
    accountId: input.accountId,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as MinerOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function signMinerDeregister(input: SignMinerDeregisterInput): MinerOpDeregister {
  const unsigned: Omit<MinerOpDeregister, 'signature'> = {
    type: 'miner_deregister',
    accountId: input.accountId,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as MinerOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function verifyMinerOperation(op: MinerOperation, accountPublicKey: string): boolean {
  try {
    if (op.type !== 'miner_register' && op.type !== 'miner_deregister') return false;
    if (typeof op.accountId !== 'string' || op.accountId.length === 0) return false;
    if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return false;
    if (typeof op.signature !== 'string') return false;
    const bytes = new TextEncoder().encode(canonicalBytesFor(op));
    return verify(bytes, op.signature, accountPublicKey);
  } catch {
    return false;
  }
}

/** Order-independent hash of the operation set, folded into the block hash. */
export function computeMinerOperationsHash(ops: MinerOperation[]): string {
  if (ops.length === 0) return sha256('no-miner-operations');
  return sha256(ops.map(canonicalBytesFor).sort().join('|'));
}

/**
 * Apply one miner operation deterministically at commit. Idempotent: a register
 * for an account that is already an active miner is skipped, and a deregister of
 * an account with no active miner is skipped, so a re-delivered block is a no-op.
 */
export function applyMinerOperation(
  db: DatabaseSync,
  op: MinerOperation,
  blockTimestampSec: number,
): void {
  if (op.type === 'miner_register') {
    if (getMinerByAccount(db, op.accountId)) return; // already a miner
    registerMiner(db, op.accountId, { id: deriveMinerId(op), now: blockTimestampSec });
  } else {
    const miner = getMinerByAccount(db, op.accountId);
    if (!miner) return; // nothing to deregister
    deactivateMiner(db, miner.id, 'deregister', blockTimestampSec);
  }
}

/**
 * Can this node apply the op? Used by the proposer to avoid queueing - and a
 * follower to avoid voting for - a block carrying an operation that would throw.
 * Returns an error string or null.
 */
export function validateMinerOperationApplicable(db: DatabaseSync, op: MinerOperation): string | null {
  const acct = getAccount(db, op.accountId);
  if (!acct) return `account not found: ${op.accountId}`;
  if (op.type === 'miner_register') {
    if (acct.type !== 'individual') return 'only individual accounts can be miners';
    if (getMinerByAccount(db, op.accountId)) return 'already an active miner';
  } else if (!getMinerByAccount(db, op.accountId)) {
    return 'not an active miner';
  }
  return null;
}

// ─── Persisted queue (mirror of pending_vouch_operations) ──────────────────

export function enqueueMinerOperation(db: DatabaseSync, op: MinerOperation): number {
  const result = db
    .prepare(
      `INSERT INTO pending_miner_operations (account_id, op_json, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(op.accountId, JSON.stringify(op), Math.floor(Date.now() / 1000));
  return Number(result.lastInsertRowid);
}

export function drainMinerOperations(db: DatabaseSync, limit = 100): MinerOperation[] {
  const rows = db
    .prepare(
      `SELECT op_json FROM pending_miner_operations ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Array<{ op_json: string }>;
  return rows.map((r) => JSON.parse(r.op_json) as MinerOperation);
}

export function removeAppliedMinerOperations(db: DatabaseSync, applied: MinerOperation[]): number {
  if (applied.length === 0) return 0;
  let removed = 0;
  const byAccount = new Map<string, Set<string>>();
  for (const op of applied) {
    const set = byAccount.get(op.accountId) ?? new Set<string>();
    set.add(canonicalBytesFor(op));
    byAccount.set(op.accountId, set);
  }
  for (const [accountId, canonicals] of byAccount) {
    const rows = db
      .prepare('SELECT id, op_json FROM pending_miner_operations WHERE account_id = ?')
      .all(accountId) as Array<{ id: number; op_json: string }>;
    for (const row of rows) {
      try {
        const op = JSON.parse(row.op_json) as MinerOperation;
        if (canonicals.has(canonicalBytesFor(op))) {
          db.prepare('DELETE FROM pending_miner_operations WHERE id = ?').run(row.id);
          removed++;
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return removed;
}

export function pendingMinerOperationCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM pending_miner_operations').get() as { c: number };
  return r.c;
}
