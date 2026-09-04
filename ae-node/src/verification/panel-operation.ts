// Verification-panel operations that ride a block.
//
// Why this exists
// ---------------
// Panel completion is the last writer of percentHuman that ran node-locally.
// A miner submitted a score to ONE node, that node recomputed the median and
// wrote the applicant's percentHuman, and no other node saw any of it. Two
// nodes could therefore hold different percentHuman for the same account, which
// is the determinism gap behind audit #4: a transaction's spend value is
// `amount * percentHuman / 100`, so if percentHuman forks, the value a spend
// moves forks with it, and a malicious node can hand a follower a block whose
// netAmount was computed against a percentHuman that follower never agreed to.
//
// Vouch withdraw (lower) and, once wired, decay are the other writers; both are
// already chain-driven. This module puts the raise path on the chain too, so
// percentHuman becomes a pure function of the applied blocks — the prerequisite
// for re-deriving spend value locally and rejecting a wire mismatch.
//
// It mirrors exactly what vouch-operation / miner-operation / validator-change
// already do: a signed operation, queued locally, gossiped so any proposer
// includes it, folded into the block hash, and applied deterministically at
// commit on every node.
//
// Determinism
// -----------
// Three node-local inputs had to go:
//   - the panel id (was uuid(), now derived from the create op's signature)
//   - the review id and every timestamp (was Date.now(), now the block
//     timestamp)
//   - the completion THRESHOLD. Completion used to depend on node-local
//     FIFO assignment rows (which miners a node happened to assign, gated by
//     node-local heartbeat state and a module-level round-robin counter), so
//     the count that triggers "panel done, write the median" differed per node.
//     Now the target is snapshotted at panel creation from chain state
//     (`min(panel_size, active miner count)`, both consensus state once the
//     miner set is chain-ordered) and stored on the panel row, so every node
//     completes the panel at the same score, over the same review set, and
//     writes the same median.
//
// What is NOT here yet (documented, follow-up)
// --------------------------------------------
// If fewer than `target` miners ever submit, the panel does not complete — the
// deadline-driven sweep that lets a short-staffed panel finish with whoever
// showed up (mirroring the chain-driven day-cycle boundary) is the next slice.
// The `deadline` column is written now so that slice needs no migration.
// Conflict-of-interest and heartbeat liveness remain node-local UI hints; they
// no longer feed the consensus threshold.

import { DatabaseSync } from 'node:sqlite';
import { sha256, sign, verify } from '../core/crypto.js';
import { getAccount, updatePercentHuman } from '../core/account.js';
import { getActiveMiners, getMinerByAccount } from '../mining/registration.js';
import { getParam } from '../config/params.js';
import { verificationStore } from './panel.js';

export interface PanelOpCreate {
  type: 'panel_create';
  /** The individual requesting verification of their own account. Signer. */
  accountId: string;
  timestamp: number;
  signature: string;
}

export interface PanelOpScore {
  type: 'panel_score';
  /** The scoring miner's account. Signer; must own an active miner. */
  accountId: string;
  /** Derived id of the panel being scored. */
  panelId: string;
  /** 0-100 whole number. */
  score: number;
  timestamp: number;
  signature: string;
}

export type PanelOperation = PanelOpCreate | PanelOpScore;

function canonicalBytesFor(op: PanelOperation): string {
  return op.type === 'panel_create'
    ? `panel_create|${op.accountId}|${op.timestamp}`
    : `panel_score|${op.accountId}|${op.panelId}|${op.score}|${op.timestamp}`;
}

/**
 * Deterministic panel id for a create op: a hash of the signature, so every
 * node stores the panel under the same id and score ops can address it before
 * any node has "assigned" anything.
 */
export function derivePanelId(op: PanelOpCreate): string {
  return sha256(`panel.id.v1\n${op.signature}`).slice(0, 40);
}

/** Deterministic review id for a score op. */
export function deriveReviewId(op: PanelOpScore): string {
  return sha256(`panel.review.v1\n${op.signature}`).slice(0, 40);
}

export type SignPanelCreateInput = { accountId: string; timestamp: number; accountPrivateKey: string };
export type SignPanelScoreInput = {
  accountId: string;
  panelId: string;
  score: number;
  timestamp: number;
  accountPrivateKey: string;
};

export function signPanelCreate(input: SignPanelCreateInput): PanelOpCreate {
  const unsigned: Omit<PanelOpCreate, 'signature'> = {
    type: 'panel_create',
    accountId: input.accountId,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as PanelOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function signPanelScore(input: SignPanelScoreInput): PanelOpScore {
  const unsigned: Omit<PanelOpScore, 'signature'> = {
    type: 'panel_score',
    accountId: input.accountId,
    panelId: input.panelId,
    score: input.score,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as PanelOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function verifyPanelOperation(op: PanelOperation, accountPublicKey: string): boolean {
  try {
    if (op.type !== 'panel_create' && op.type !== 'panel_score') return false;
    if (typeof op.accountId !== 'string' || op.accountId.length === 0) return false;
    if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return false;
    if (typeof op.signature !== 'string') return false;
    if (op.type === 'panel_score') {
      if (typeof op.panelId !== 'string' || op.panelId.length === 0) return false;
      if (typeof op.score !== 'number' || !Number.isInteger(op.score) || op.score < 0 || op.score > 100) {
        return false;
      }
    }
    const bytes = new TextEncoder().encode(canonicalBytesFor(op));
    return verify(bytes, op.signature, accountPublicKey);
  } catch {
    return false;
  }
}

/** Order-independent hash of the operation set, folded into the block hash. */
export function computePanelOperationsHash(ops: PanelOperation[]): string {
  if (ops.length === 0) return sha256('no-panel-operations');
  return sha256(ops.map(canonicalBytesFor).sort().join('|'));
}

/**
 * The completion threshold for a panel, snapshotted at creation from chain
 * state so it is identical on every node.
 *
 * `min(panel_size, active miner count)` — a full panel where enough miners
 * exist, or "everyone available" on a network too small to fill one. Guarded so
 * a network with zero miners at creation asks for a full panel (it simply waits
 * until miners exist) rather than a target of zero, which would "complete" a
 * panel with no scores and write a NaN median.
 */
function completionTarget(db: DatabaseSync): number {
  const panelSize = getParam<number>(db, 'mining.panel_size');
  const activeCount = getActiveMiners(db).length;
  const effective = activeCount === 0 ? panelSize : Math.min(panelSize, activeCount);
  return Math.max(1, effective);
}

/**
 * Apply one panel operation deterministically at commit. Idempotent: a
 * re-delivered create (same panel id already present) or a re-delivered score
 * (same review id already present, or this miner already reviewed this panel) is
 * a no-op, so a replayed block reaches identical state.
 *
 * Uses the block timestamp for every write. When a score brings the panel to
 * its snapshotted target, the median is computed and the applicant's
 * percentHuman is written here — the same code path on every node.
 */
export function applyPanelOperation(
  db: DatabaseSync,
  op: PanelOperation,
  blockTimestampSec: number,
): void {
  const verif = verificationStore(db);

  if (op.type === 'panel_create') {
    const id = derivePanelId(op);
    if (verif.findPanelById(id)) return; // already applied
    const target = completionTarget(db);
    const deadlineHours = getParam<number>(db, 'mining.verification_deadline_hours');
    const deadline = blockTimestampSec + deadlineHours * 3600;
    db.prepare(
      `INSERT INTO verification_panels
         (id, account_id, status, created_at, completed_at, median_score, target_reviews, deadline)
       VALUES (?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
    ).run(id, op.accountId, blockTimestampSec, target, deadline);
    return;
  }

  // panel_score
  const panel = verif.findPanelById(op.panelId);
  if (!panel) return; // create not yet applied on this node, or unknown panel
  if (panel.status === 'complete') return; // a finished panel is finished

  const miner = getMinerByAccount(db, op.accountId);
  if (!miner) return; // signer is not an active miner

  const reviewId = deriveReviewId(op);
  // Idempotent on re-delivery, and one score per miner per panel: a miner
  // cannot inflate the review count (and drag the median) with a second op.
  const dup = db
    .prepare(
      `SELECT 1 FROM panel_reviews WHERE id = ? OR (panel_id = ? AND miner_id = ?) LIMIT 1`,
    )
    .get(reviewId, op.panelId, miner.id);
  if (dup) return;

  verif.insertReview({
    id: reviewId,
    panelId: op.panelId,
    minerId: miner.id,
    score: op.score,
    evidenceHashOfReview: sha256(`panel.review.v1\n${op.signature}`),
    submittedAt: blockTimestampSec,
  });
  verif.setPanelInProgressIfPending(op.panelId);

  // Complete when the snapshotted target is met. target_reviews is a fixed,
  // chain-derived number stored at creation, so this fires at the same score
  // on every node, over the same review set.
  const targetRow = db
    .prepare('SELECT target_reviews FROM verification_panels WHERE id = ?')
    .get(op.panelId) as { target_reviews: number | null } | undefined;
  const target = targetRow?.target_reviews ?? 3;
  const scores = verif.findScoresByPanel(op.panelId);
  if (scores.length >= target) {
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = Math.round(
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    );
    verif.completePanel(op.panelId, blockTimestampSec, median);
    updatePercentHuman(db, panel.accountId, median);
  }
}

/**
 * Can this node apply the op? Used by the proposer to avoid queueing — and a
 * follower to avoid voting for — a block carrying an operation that no honest
 * node can apply. Returns an error string or null.
 */
export function validatePanelOperationApplicable(db: DatabaseSync, op: PanelOperation): string | null {
  const acct = getAccount(db, op.accountId);
  if (!acct) return `account not found: ${op.accountId}`;
  if (op.type === 'panel_create') {
    if (acct.type !== 'individual') return 'only individual accounts can be verified';
    return null;
  }
  // panel_score
  if (!Number.isInteger(op.score) || op.score < 0 || op.score > 100) {
    return 'score must be a whole number 0-100';
  }
  const miner = getMinerByAccount(db, op.accountId);
  if (!miner) return 'signer is not an active miner';
  const panel = verificationStore(db).findPanelById(op.panelId);
  if (!panel) return `panel not found: ${op.panelId}`;
  if (panel.status === 'complete') return 'panel already complete';
  if (panel.accountId === op.accountId) return 'cannot score your own verification panel';
  const already = db
    .prepare('SELECT 1 FROM panel_reviews WHERE panel_id = ? AND miner_id = ? LIMIT 1')
    .get(op.panelId, miner.id);
  if (already) return 'miner already scored this panel';
  return null;
}

// ─── Persisted queue (mirror of pending_miner_operations) ──────────────────

export function enqueuePanelOperation(db: DatabaseSync, op: PanelOperation): number {
  const result = db
    .prepare(
      `INSERT INTO pending_panel_operations (account_id, op_json, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(op.accountId, JSON.stringify(op), Math.floor(Date.now() / 1000));
  return Number(result.lastInsertRowid);
}

export function drainPanelOperations(db: DatabaseSync, limit = 100): PanelOperation[] {
  const rows = db
    .prepare(
      `SELECT op_json FROM pending_panel_operations ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Array<{ op_json: string }>;
  return rows.map((r) => JSON.parse(r.op_json) as PanelOperation);
}

export function removeAppliedPanelOperations(db: DatabaseSync, applied: PanelOperation[]): number {
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
      .prepare('SELECT id, op_json FROM pending_panel_operations WHERE account_id = ?')
      .all(accountId) as Array<{ id: number; op_json: string }>;
    for (const row of rows) {
      try {
        const op = JSON.parse(row.op_json) as PanelOperation;
        if (canonicals.has(canonicalBytesFor(op))) {
          db.prepare('DELETE FROM pending_panel_operations WHERE id = ?').run(row.id);
          removed++;
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return removed;
}

export function pendingPanelOperationCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM pending_panel_operations').get() as { c: number };
  return r.c;
}
