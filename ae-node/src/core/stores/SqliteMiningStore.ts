// SQLite-backed implementation of IMiningStore.

import { DatabaseSync } from 'node:sqlite';
import type { Miner } from '../../mining/types.js';
import type {
  AssignmentInsert,
  IMiningStore,
  JuryServiceInsert,
  MinerInsert,
  TierChangeInsert,
} from './IMiningStore.js';

function rowToMiner(row: Record<string, unknown>): Miner {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    tier: row.tier as 1 | 2,
    isActive: (row.is_active as number) === 1,
    registeredAt: row.registered_at as number,
    deactivatedAt: row.deactivated_at as number | null,
  };
}

export class SqliteMiningStore implements IMiningStore {
  constructor(private readonly db: DatabaseSync) {}

  // ── miners ─────────────────────────────────────────────────────

  countActiveMiners(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM miners WHERE is_active = 1')
      .get() as { cnt: number };
    return row.cnt;
  }

  findMinerById(minerId: string): Miner | null {
    const row = this.db
      .prepare('SELECT * FROM miners WHERE id = ?')
      .get(minerId) as Record<string, unknown> | undefined;
    return row ? rowToMiner(row) : null;
  }

  findMinerByAccountId(accountId: string): Miner | null {
    const row = this.db
      .prepare('SELECT * FROM miners WHERE account_id = ? AND is_active = 1')
      .get(accountId) as Record<string, unknown> | undefined;
    return row ? rowToMiner(row) : null;
  }

  findActiveMiners(tier?: 1 | 2): Miner[] {
    let rows: Array<Record<string, unknown>>;
    if (tier !== undefined) {
      rows = this.db
        .prepare('SELECT * FROM miners WHERE is_active = 1 AND tier = ?')
        .all(tier) as Array<Record<string, unknown>>;
    } else {
      rows = this.db
        .prepare('SELECT * FROM miners WHERE is_active = 1')
        .all() as Array<Record<string, unknown>>;
    }
    return rows.map(rowToMiner);
  }

  insertMiner(input: MinerInsert): void {
    this.db
      .prepare(
        `INSERT INTO miners (id, account_id, tier, is_active, registered_at, deactivated_at)
         VALUES (?, ?, ?, 1, ?, NULL)`,
      )
      .run(input.id, input.accountId, input.tier, input.registeredAt);
  }

  deactivateMiner(minerId: string, deactivatedAt: number): void {
    this.db
      .prepare('UPDATE miners SET is_active = 0, deactivated_at = ? WHERE id = ?')
      .run(deactivatedAt, minerId);
  }

  setMinerTier(minerId: string, newTier: 1 | 2): void {
    this.db.prepare('UPDATE miners SET tier = ? WHERE id = ?').run(newTier, minerId);
  }

  recordTierChange(input: TierChangeInsert): void {
    this.db
      .prepare(
        `INSERT INTO miner_tier_changes (id, miner_id, from_tier, to_tier, reason, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.minerId, input.fromTier, input.toTier, input.reason, input.timestamp);
  }

  // ── miner_heartbeats ───────────────────────────────────────────

  insertHeartbeat(minerId: string, blockHeight: number, timestamp: number): void {
    this.db
      .prepare('INSERT INTO miner_heartbeats (miner_id, timestamp, block_height) VALUES (?, ?, ?)')
      .run(minerId, timestamp, blockHeight);
  }

  countHeartbeatsSince(minerId: string, sinceTimestamp: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM miner_heartbeats WHERE miner_id = ? AND timestamp >= ?',
      )
      .get(minerId, sinceTimestamp) as { cnt: number };
    return row.cnt;
  }

  lastHeartbeatAt(minerId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(timestamp) as ts FROM miner_heartbeats WHERE miner_id = ?')
      .get(minerId) as { ts: number | null };
    return row.ts;
  }

  deleteHeartbeatsBefore(cutoffTimestamp: number): void {
    this.db.prepare('DELETE FROM miner_heartbeats WHERE timestamp < ?').run(cutoffTimestamp);
  }

  // ── miner_verification_assignments ─────────────────────────────

  insertAssignment(input: AssignmentInsert): void {
    this.db
      .prepare(
        `INSERT INTO miner_verification_assignments (id, miner_id, panel_id, assigned_at, deadline, completed, missed)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(input.id, input.minerId, input.panelId, input.assignedAt, input.deadline);
  }

  findAssignmentMinerIds(panelId: string): string[] {
    const rows = this.db
      .prepare('SELECT miner_id FROM miner_verification_assignments WHERE panel_id = ?')
      .all(panelId) as Array<{ miner_id: string }>;
    return rows.map((r) => r.miner_id);
  }

  markAssignmentComplete(minerId: string, panelId: string): void {
    this.db
      .prepare(
        'UPDATE miner_verification_assignments SET completed = 1 WHERE miner_id = ? AND panel_id = ?',
      )
      .run(minerId, panelId);
  }

  markAssignmentMissed(minerId: string, panelId: string): void {
    this.db
      .prepare(
        'UPDATE miner_verification_assignments SET missed = 1 WHERE miner_id = ? AND panel_id = ?',
      )
      .run(minerId, panelId);
  }

  countMinerAssignments(minerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM miner_verification_assignments WHERE miner_id = ?')
      .get(minerId) as { cnt: number };
    return row.cnt;
  }

  countMinerAssignmentsCompleted(minerId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM miner_verification_assignments WHERE miner_id = ? AND completed = 1',
      )
      .get(minerId) as { cnt: number };
    return row.cnt;
  }

  // ── miner_jury_service ─────────────────────────────────────────

  recordJuryService(input: JuryServiceInsert): void {
    this.db
      .prepare(
        `INSERT INTO miner_jury_service (id, miner_id, case_id, called_at, voted, vote_matched_verdict)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.minerId,
        input.caseId,
        input.calledAt,
        input.voted ? 1 : 0,
        input.voteMatchedVerdict === null ? null : input.voteMatchedVerdict ? 1 : 0,
      );
  }

  countJuryServices(minerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM miner_jury_service WHERE miner_id = ?')
      .get(minerId) as { cnt: number };
    return row.cnt;
  }

  countJuryServicesVoted(minerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM miner_jury_service WHERE miner_id = ? AND voted = 1')
      .get(minerId) as { cnt: number };
    return row.cnt;
  }

  countJuryServicesCorrect(minerId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM miner_jury_service WHERE miner_id = ? AND voted = 1 AND vote_matched_verdict = 1',
      )
      .get(minerId) as { cnt: number };
    return row.cnt;
  }
}
