// Repository interface for verification storage.
//
// Tables behind this interface:
//   - verification_panels   (proof-of-human review sessions)
//   - panel_reviews         (one row per miner score on a panel)
//   - verification_evidence (submitted evidence, e.g. gov_id hashes)
//   - vouches               (peer stakes attesting to humanity)
//   - vouch_requests        (incoming/outgoing vouch invitations)
//
// Cross-table operations (locking voucher stake on the accounts table) live
// in business logic and use IAccountStore for those side effects.

import type { Evidence, PanelReview, VerificationPanel, Vouch, VouchRequest } from '../../verification/types.js';

export interface PanelInsert {
  id: string;
  accountId: string;
  createdAt: number;
}

export interface ReviewInsert {
  id: string;
  panelId: string;
  minerId: string;
  score: number;
  evidenceHashOfReview: string;
  submittedAt: number;
}

export interface EvidenceInsert {
  id: string;
  accountId: string;
  evidenceTypeId: string;
  evidenceHash: string;
  submittedAt: number;
}

export interface VouchInsert {
  id: string;
  voucherId: string;
  vouchedId: string;
  stakeAmount: bigint;
  stakedPercentage: number;
  createdAt: number;
}

export interface VouchRequestInsert {
  id: string;
  fromId: string;
  toId: string;
  message: string;
  createdAt: number;
}

export interface IVerificationStore {
  // ── verification_panels ────────────────────────────────────────

  insertPanel(input: PanelInsert): void;

  findPanelById(panelId: string): VerificationPanel | null;

  /** Most recent panel for an account, or null. Used by clients to show "your last verification". */
  findLatestPanelForAccount(accountId: string): VerificationPanel | null;

  /** All panels for an account, newest first. */
  findPanelsByAccount(accountId: string): VerificationPanel[];

  /** Idempotent transition: only flip pending → in_progress if currently pending. */
  setPanelInProgressIfPending(panelId: string): void;

  /** Mark a panel complete with the median miner score. */
  completePanel(panelId: string, completedAt: number, medianScore: number): void;

  // ── panel_reviews ──────────────────────────────────────────────

  insertReview(input: ReviewInsert): void;

  findReviewsByPanel(panelId: string): PanelReview[];

  /** Just the scores, sorted asc. Used to compute the median. */
  findScoresByPanel(panelId: string): number[];

  // ── verification_evidence ──────────────────────────────────────

  insertEvidence(input: EvidenceInsert): void;

  findEvidenceByAccount(accountId: string): Evidence[];

  // ── vouches ────────────────────────────────────────────────────

  insertVouch(input: VouchInsert): void;

  findActiveVouchById(vouchId: string): Vouch | null;

  /** Active vouches RECEIVED by an account (vouched_id = ?). */
  findActiveVouchesForAccount(accountId: string): Vouch[];

  /** Active vouches GIVEN by an account (voucher_id = ?). */
  findActiveVouchesGivenBy(accountId: string): Vouch[];

  /** Mark a vouch inactive (withdrawn or burned). */
  markVouchInactive(vouchId: string, withdrawnAt: number): void;

  // ── vouch_requests ─────────────────────────────────────────────

  insertVouchRequest(input: VouchRequestInsert): void;

  /** Pending requests where this account is the recipient (someone is asking them to vouch). */
  findPendingIncomingRequests(accountId: string): VouchRequest[];

  /** Pending requests sent by this account (asking others to vouch for me). */
  findPendingOutgoingRequests(accountId: string): VouchRequest[];

  /** Update a request's status (accepted or declined). */
  setVouchRequestStatus(id: string, status: 'accepted' | 'declined', respondedAt: number): void;
}
