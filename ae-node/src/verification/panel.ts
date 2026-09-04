// Verification panel business logic.
//
// All persistence goes through IVerificationStore + IMiningStore. This file
// contains only the protocol semantics: "a panel completes when N miners
// submit scores, then the median becomes the applicant's percentHuman."

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { sha256 } from '../core/crypto.js';
import { updatePercentHuman } from '../core/account.js';
import { NotFoundError, ValidationError, ConflictError } from '../core/errors.js';
import { miningStore } from '../mining/registration.js';
import { SqliteVerificationStore } from '../core/stores/SqliteVerificationStore.js';
import type { IVerificationStore } from '../core/stores/IVerificationStore.js';
import type { VerificationPanel, PanelReview } from './types.js';

export function verificationStore(db: DatabaseSync): IVerificationStore {
  return new SqliteVerificationStore(db);
}

// LEGACY, NODE-LOCAL PATH — DO NOT WIRE INTO A ROUTE OR CONSENSUS STEP.
//
// createPanel / submitPanelScore below write the panel row, the reviews, and
// (on completion) percentHuman directly on ONE node. Panel completion is now
// chain-ordered through verification/panel-operation.ts, which applies the same
// median → percentHuman deterministically at commit on every node. That is what
// makes percentHuman a pure function of the chain (the prerequisite for closing
// audit #4). Calling these node-local functions from production would re-open
// the fork: two nodes could hold different percentHuman for the same account.
//
// They are kept only because their tests (phase3, panel-deadlines,
// panel-verdict-idempotency) encode the completion, deadline, idempotency and
// fractional-score semantics the on-chain path must also honour. Read them as
// the reference spec, not as a callable production API.
export function createPanel(db: DatabaseSync, accountId: string): VerificationPanel {
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  verificationStore(db).insertPanel({ id, accountId, createdAt: now });
  return { id, accountId, status: 'pending', createdAt: now, completedAt: null, medianScore: null };
}

export function assignMinersToPanel(
  db: DatabaseSync,
  panelId: string,
  _minerIds: string[],
): void {
  // Bumping status to in_progress on assignment is purely a UI hint — the real
  // tracking lives in panel_reviews (rows appear when miners actually score).
  verificationStore(db).setPanelInProgressIfPending(panelId);
}

export function submitPanelScore(
  db: DatabaseSync,
  panelId: string,
  minerId: string,
  score: number,
): { recorded: boolean; panelComplete: boolean; medianScore: number | null } {
  if (score < 0 || score > 100) throw new ValidationError('Score must be 0-100', 'INVALID_SCORE');

  // The score must be a whole number, and this is not cosmetic validation.
  //
  // An odd-sized panel takes the median as `sorted[mid]` verbatim, so a miner
  // submitting 87.5 wrote 87.5 into `percent_human`. SQLite is dynamically
  // typed and stores a real in an INTEGER column happily. Every daily-point
  // spend then does `BigInt(sender.percentHuman)`, which throws RangeError on a
  // non-integer — so a single fractional score permanently bricks that
  // account's ability to spend, and the error surfaces nowhere near its cause.
  if (!Number.isInteger(score)) {
    throw new ValidationError(
      `Score must be a whole number, got ${score}. Fractional scores corrupt percentHuman.`,
      'INVALID_SCORE',
    );
  }

  const verif = verificationStore(db);
  const now = Math.floor(Date.now() / 1000);
  const reviewHash = sha256(`${panelId}:${minerId}:${score}:${now}`);

  // A finished panel is finished. Without this a late miner's score was
  // accepted, recomputed the median over the larger set, and silently rewrote
  // a verification that had already been published — moving someone's
  // percentHuman after the fact with no record that the number had changed.
  const existing = verif.findPanelById(panelId);
  if (!existing) throw new NotFoundError(`Panel not found: ${panelId}`);
  if (existing.status === 'complete') {
    throw new ConflictError(
      `Panel ${panelId} already completed with a median of ${existing.medianScore}`,
      'PANEL_COMPLETE',
    );
  }

  // Transition pending → in_progress on first score (idempotent if already
  // in_progress).
  verif.setPanelInProgressIfPending(panelId);

  verif.insertReview({
    id: uuid(),
    panelId,
    minerId,
    score,
    evidenceHashOfReview: reviewHash,
    submittedAt: now,
  });

  // Close the FIFO assignment. `markAssignmentComplete` existed and had no
  // production caller, so doing the work never registered: every miner's
  // `countMinerAssignmentsCompleted` stayed at zero regardless of how many
  // panels they had actually reviewed, which is the number their reliability
  // is judged on. It also meant the deadline sweep could not tell a miner who
  // reviewed on time from one who ignored the panel entirely.
  miningStore(db).markAssignmentComplete(minerId, panelId);

  // Determine if the panel is complete:
  //   - 3+ reviews is the standard threshold
  //   - OR all assigned miners have submitted (early-network graceful fallback)
  const scores = verif.findScoresByPanel(panelId);
  const panel = verif.findPanelById(panelId);
  if (!panel) {
    throw new NotFoundError(`Panel not found after recording review: ${panelId}`);
  }
  const accountId = panel.accountId;

  const targetReviews = 3;
  const assignedCount = getAssignedCount(db, panelId);
  const panelComplete = scores.length >= targetReviews || scores.length >= assignedCount;

  let medianScore: number | null = null;

  if (panelComplete) {
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    // Rounded on BOTH branches. The even branch always was; the odd branch
    // passed sorted[mid] through untouched, which is how a fractional score
    // reached percent_human. Belt and braces alongside the integer check above:
    // rows written before that check existed can still be in the database.
    medianScore = Math.round(
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    );

    verif.completePanel(panelId, now, medianScore);

    // Update account's percentHuman
    updatePercentHuman(db, accountId, medianScore);
  }

  return { recorded: true, panelComplete, medianScore };
}

function getAssignedCount(db: DatabaseSync, panelId: string): number {
  // Count actual assignments. If fewer than 3 miners were assigned (early
  // network), the panel completes when all of them have submitted scores —
  // not when an unreachable count of 3 is hit.
  //
  // Live assignments only. A miner who blew their deadline is marked missed by
  // expireOverdueAssignments, and counting them here would keep the threshold
  // permanently out of reach: the panel needs `scores.length >= assignedCount`,
  // and someone who never reviews never contributes a score. That is how one
  // silent miner used to strand an applicant at percentHuman 0 forever, with
  // every spend burning to nothing.
  const ids = miningStore(db).findLiveAssignmentMinerIds(panelId);
  return ids.length > 0 ? ids.length : 3;
}

export function getPanelForAccount(db: DatabaseSync, accountId: string): VerificationPanel | null {
  return verificationStore(db).findLatestPanelForAccount(accountId);
}

export function getPanelReviews(db: DatabaseSync, panelId: string): PanelReview[] {
  return verificationStore(db).findReviewsByPanel(panelId);
}
