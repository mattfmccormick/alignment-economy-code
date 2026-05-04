// Verification panel business logic.
//
// All persistence goes through IVerificationStore + IMiningStore. This file
// contains only the protocol semantics: "a panel completes when N miners
// submit scores, then the median becomes the applicant's percentHuman."

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { sha256 } from '../core/crypto.js';
import { updatePercentHuman } from '../core/account.js';
import { miningStore } from '../mining/registration.js';
import { SqliteVerificationStore } from '../core/stores/SqliteVerificationStore.js';
import type { IVerificationStore } from '../core/stores/IVerificationStore.js';
import type { VerificationPanel, PanelReview } from './types.js';

export function verificationStore(db: DatabaseSync): IVerificationStore {
  return new SqliteVerificationStore(db);
}

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
  if (score < 0 || score > 100) throw new Error('Score must be 0-100');

  const verif = verificationStore(db);
  const now = Math.floor(Date.now() / 1000);
  const reviewHash = sha256(`${panelId}:${minerId}:${score}:${now}`);

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

  // Determine if the panel is complete:
  //   - 3+ reviews is the standard threshold
  //   - OR all assigned miners have submitted (early-network graceful fallback)
  const scores = verif.findScoresByPanel(panelId);
  const panel = verif.findPanelById(panelId);
  if (!panel) {
    throw new Error(`Panel not found after recording review: ${panelId}`);
  }
  const accountId = panel.accountId;

  const targetReviews = 3;
  const assignedCount = getAssignedCount(db, panelId);
  const panelComplete = scores.length >= targetReviews || scores.length >= assignedCount;

  let medianScore: number | null = null;

  if (panelComplete) {
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianScore = sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];

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
  const ids = miningStore(db).findAssignmentMinerIds(panelId);
  return ids.length > 0 ? ids.length : 3;
}

export function getPanelForAccount(db: DatabaseSync, accountId: string): VerificationPanel | null {
  return verificationStore(db).findLatestPanelForAccount(accountId);
}

export function getPanelReviews(db: DatabaseSync, panelId: string): PanelReview[] {
  return verificationStore(db).findReviewsByPanel(panelId);
}
