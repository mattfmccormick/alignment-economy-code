// SQLite implementation of IVerificationStore.

import { DatabaseSync } from 'node:sqlite';
import type {
  Evidence,
  PanelReview,
  VerificationPanel,
  Vouch,
  VouchRequest,
} from '../../verification/types.js';
import type {
  EvidenceInsert,
  IVerificationStore,
  PanelInsert,
  ReviewInsert,
  VouchInsert,
  VouchRequestInsert,
} from './IVerificationStore.js';

function rowToPanel(row: Record<string, unknown>): VerificationPanel {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    status: row.status as VerificationPanel['status'],
    createdAt: row.created_at as number,
    completedAt: row.completed_at as number | null,
    medianScore: row.median_score as number | null,
  };
}

function rowToReview(row: Record<string, unknown>): PanelReview {
  return {
    id: row.id as string,
    panelId: row.panel_id as string,
    minerId: row.miner_id as string,
    score: row.score as number,
    evidenceHashOfReview: row.evidence_hash_of_review as string,
    submittedAt: row.submitted_at as number,
  };
}

function rowToEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    evidenceTypeId: row.evidence_type_id as string,
    evidenceHash: row.evidence_hash as string,
    submittedAt: row.submitted_at as number,
    reviewedBy: row.reviewed_by as string | null,
  };
}

function rowToVouch(row: Record<string, unknown>): Vouch {
  return {
    id: row.id as string,
    voucherId: row.voucher_id as string,
    vouchedId: row.vouched_id as string,
    stakeAmount: BigInt(row.stake_amount as string),
    stakedPercentage: row.staked_percentage as number,
    isActive: (row.is_active as number) === 1,
    createdAt: row.created_at as number,
    withdrawnAt: row.withdrawn_at as number | null,
  };
}

function rowToVouchRequest(row: Record<string, unknown>): VouchRequest {
  return {
    id: row.id as string,
    fromId: row.from_id as string,
    toId: row.to_id as string,
    status: row.status as VouchRequest['status'],
    message: (row.message as string) ?? '',
    createdAt: row.created_at as number,
    respondedAt: row.responded_at as number | null,
  };
}

export class SqliteVerificationStore implements IVerificationStore {
  constructor(private readonly db: DatabaseSync) {}

  // ── verification_panels ────────────────────────────────────────

  insertPanel(input: PanelInsert): void {
    this.db
      .prepare(
        `INSERT INTO verification_panels (id, account_id, status, created_at, completed_at, median_score)
         VALUES (?, ?, 'pending', ?, NULL, NULL)`,
      )
      .run(input.id, input.accountId, input.createdAt);
  }

  findPanelById(panelId: string): VerificationPanel | null {
    const row = this.db
      .prepare('SELECT * FROM verification_panels WHERE id = ?')
      .get(panelId) as Record<string, unknown> | undefined;
    return row ? rowToPanel(row) : null;
  }

  findLatestPanelForAccount(accountId: string): VerificationPanel | null {
    const row = this.db
      .prepare(
        'SELECT * FROM verification_panels WHERE account_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(accountId) as Record<string, unknown> | undefined;
    return row ? rowToPanel(row) : null;
  }

  findPanelsByAccount(accountId: string): VerificationPanel[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_panels WHERE account_id = ? ORDER BY created_at DESC')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToPanel);
  }

  setPanelInProgressIfPending(panelId: string): void {
    this.db
      .prepare(
        "UPDATE verification_panels SET status = 'in_progress' WHERE id = ? AND status = 'pending'",
      )
      .run(panelId);
  }

  completePanel(panelId: string, completedAt: number, medianScore: number): void {
    this.db
      .prepare(
        "UPDATE verification_panels SET status = 'complete', completed_at = ?, median_score = ? WHERE id = ?",
      )
      .run(completedAt, medianScore, panelId);
  }

  // ── panel_reviews ──────────────────────────────────────────────

  insertReview(input: ReviewInsert): void {
    this.db
      .prepare(
        `INSERT INTO panel_reviews (id, panel_id, miner_id, score, evidence_hash_of_review, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.panelId, input.minerId, input.score, input.evidenceHashOfReview, input.submittedAt);
  }

  findReviewsByPanel(panelId: string): PanelReview[] {
    const rows = this.db
      .prepare('SELECT * FROM panel_reviews WHERE panel_id = ?')
      .all(panelId) as Array<Record<string, unknown>>;
    return rows.map(rowToReview);
  }

  findScoresByPanel(panelId: string): number[] {
    const rows = this.db
      .prepare('SELECT score FROM panel_reviews WHERE panel_id = ? ORDER BY score')
      .all(panelId) as Array<{ score: number }>;
    return rows.map((r) => r.score);
  }

  // ── verification_evidence ──────────────────────────────────────

  insertEvidence(input: EvidenceInsert): void {
    this.db
      .prepare(
        `INSERT INTO verification_evidence (id, account_id, evidence_type_id, evidence_hash, submitted_at, reviewed_by)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(input.id, input.accountId, input.evidenceTypeId, input.evidenceHash, input.submittedAt);
  }

  findEvidenceByAccount(accountId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_evidence WHERE account_id = ? ORDER BY submitted_at')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToEvidence);
  }

  // ── vouches ────────────────────────────────────────────────────

  insertVouch(input: VouchInsert): void {
    this.db
      .prepare(
        `INSERT INTO vouches (id, voucher_id, vouched_id, stake_amount, staked_percentage, is_active, created_at, withdrawn_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
      )
      .run(
        input.id,
        input.voucherId,
        input.vouchedId,
        input.stakeAmount.toString(),
        input.stakedPercentage,
        input.createdAt,
      );
  }

  findActiveVouchById(vouchId: string): Vouch | null {
    const row = this.db
      .prepare('SELECT * FROM vouches WHERE id = ? AND is_active = 1')
      .get(vouchId) as Record<string, unknown> | undefined;
    return row ? rowToVouch(row) : null;
  }

  findActiveVouchesForAccount(accountId: string): Vouch[] {
    const rows = this.db
      .prepare('SELECT * FROM vouches WHERE vouched_id = ? AND is_active = 1')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToVouch);
  }

  findActiveVouchesGivenBy(accountId: string): Vouch[] {
    const rows = this.db
      .prepare('SELECT * FROM vouches WHERE voucher_id = ? AND is_active = 1')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToVouch);
  }

  markVouchInactive(vouchId: string, withdrawnAt: number): void {
    this.db
      .prepare('UPDATE vouches SET is_active = 0, withdrawn_at = ? WHERE id = ?')
      .run(withdrawnAt, vouchId);
  }

  // ── vouch_requests ─────────────────────────────────────────────

  insertVouchRequest(input: VouchRequestInsert): void {
    this.db
      .prepare(
        `INSERT INTO vouch_requests (id, from_id, to_id, status, message, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(input.id, input.fromId, input.toId, input.message, input.createdAt);
  }

  findVouchRequestById(id: string): VouchRequest | null {
    const row = this.db
      .prepare('SELECT * FROM vouch_requests WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToVouchRequest(row) : null;
  }

  findPendingIncomingRequests(accountId: string): VouchRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM vouch_requests WHERE to_id = ? AND status = 'pending'")
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToVouchRequest);
  }

  findPendingOutgoingRequests(accountId: string): VouchRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM vouch_requests WHERE from_id = ? AND status = 'pending'")
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToVouchRequest);
  }

  setVouchRequestStatus(id: string, status: 'accepted' | 'declined', respondedAt: number): void {
    this.db
      .prepare('UPDATE vouch_requests SET status = ?, responded_at = ? WHERE id = ?')
      .run(status, respondedAt, id);
  }
}
