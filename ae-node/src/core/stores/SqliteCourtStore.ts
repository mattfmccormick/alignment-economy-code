// SQLite implementation of ICourtStore.
//
// Owns every SQL query against `court_cases` and `court_jury`. All other
// court business logic (account balance changes, day-cycle reads, etc.)
// lives in src/court/court.ts and uses other stores / helpers for those.

import { DatabaseSync } from 'node:sqlite';
import type { CourtCase, JurorRecord, Verdict, Vote, CaseStatus, CaseLevel, CaseType } from '../../court/types.js';
import type { CourtCaseInsert, ICourtStore, JurorInsert } from './ICourtStore.js';

function rowToCase(row: Record<string, unknown>): CourtCase {
  return {
    id: row.id as string,
    type: row.type as CaseType,
    level: row.level as CaseLevel,
    challengerId: row.challenger_id as string,
    defendantId: row.defendant_id as string,
    challengerStake: BigInt(row.challenger_stake as string),
    challengerStakePercent: row.challenger_stake_percent as number,
    status: row.status as CaseStatus,
    arbitrationDeadline: row.arbitration_deadline as number | null,
    votingDeadline: row.voting_deadline as number | null,
    verdict: row.verdict as Verdict | null,
    appealOf: row.appeal_of as string | null,
    createdAt: row.created_at as number,
    resolvedAt: row.resolved_at as number | null,
  };
}

function rowToJuror(row: Record<string, unknown>): JurorRecord {
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    minerId: row.miner_id as string,
    jurorAccountId: row.juror_account_id as string,
    stakeAmount: BigInt(row.stake_amount as string),
    vote: (row.vote as Vote | null) ?? null,
    votedAt: row.voted_at as number | null,
  };
}

const ACTIVE_CASE_STATUS_FILTER =
  "status NOT IN ('closed', 'withdrawn', 'court_verdict', 'appeal_verdict')";

export class SqliteCourtStore implements ICourtStore {
  constructor(private readonly db: DatabaseSync) {}

  // ── court_cases ────────────────────────────────────────────────

  insertCase(input: CourtCaseInsert): void {
    this.db
      .prepare(
        `INSERT INTO court_cases (id, type, level, challenger_id, defendant_id, challenger_stake,
         challenger_stake_percent, status, arbitration_deadline, voting_deadline, verdict, appeal_of,
         created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.type,
        input.level,
        input.challengerId,
        input.defendantId,
        input.challengerStake.toString(),
        input.challengerStakePercent,
        input.status,
        input.arbitrationDeadline,
        input.votingDeadline,
        input.appealOf,
        input.createdAt,
      );
  }

  findCaseById(id: string): CourtCase | null {
    const row = this.db
      .prepare('SELECT * FROM court_cases WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToCase(row) : null;
  }

  findActiveCases(): CourtCase[] {
    const rows = this.db
      .prepare(`SELECT * FROM court_cases WHERE ${ACTIVE_CASE_STATUS_FILTER}`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToCase);
  }

  findCasesByAccount(accountId: string): CourtCase[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM court_cases WHERE defendant_id = ? OR challenger_id = ? ORDER BY created_at DESC',
      )
      .all(accountId, accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToCase);
  }

  findActiveCaseAgainst(defendantId: string): CourtCase | null {
    const row = this.db
      .prepare(
        `SELECT * FROM court_cases WHERE defendant_id = ? AND ${ACTIVE_CASE_STATUS_FILTER}`,
      )
      .get(defendantId) as Record<string, unknown> | undefined;
    return row ? rowToCase(row) : null;
  }

  findAppealsOf(caseId: string): CourtCase[] {
    const rows = this.db
      .prepare('SELECT * FROM court_cases WHERE appeal_of = ?')
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map(rowToCase);
  }

  countAppealsOf(caseId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM court_cases WHERE appeal_of = ?')
      .get(caseId) as { cnt: number };
    return row.cnt;
  }

  setLevelToCourt(caseId: string): void {
    this.db
      .prepare("UPDATE court_cases SET level = 'court', status = 'court_open' WHERE id = ?")
      .run(caseId);
  }

  setStatusWaitingJury(caseId: string): void {
    this.db
      .prepare("UPDATE court_cases SET status = 'court_waiting_jury' WHERE id = ?")
      .run(caseId);
  }

  setStatusVoting(caseId: string, votingDeadline: number): void {
    this.db
      .prepare("UPDATE court_cases SET status = 'court_voting', voting_deadline = ? WHERE id = ?")
      .run(votingDeadline, caseId);
  }

  setVerdict(caseId: string, verdict: Verdict | null, status: CaseStatus, resolvedAt: number): void {
    this.db
      .prepare('UPDATE court_cases SET verdict = ?, status = ?, resolved_at = ? WHERE id = ?')
      .run(verdict, status, resolvedAt, caseId);
  }

  // ── court_jury ─────────────────────────────────────────────────

  insertJuror(input: JurorInsert): void {
    this.db
      .prepare(
        `INSERT INTO court_jury (id, case_id, miner_id, juror_account_id, stake_amount, vote, voted_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(input.id, input.caseId, input.minerId, input.jurorAccountId, input.stakeAmount.toString());
  }

  findJurorByMiner(caseId: string, minerId: string): JurorRecord | null {
    const row = this.db
      .prepare('SELECT * FROM court_jury WHERE case_id = ? AND miner_id = ?')
      .get(caseId, minerId) as Record<string, unknown> | undefined;
    return row ? rowToJuror(row) : null;
  }

  findJurorsByCase(caseId: string): JurorRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM court_jury WHERE case_id = ?')
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map(rowToJuror);
  }

  findJurorMinerIds(caseId: string): string[] {
    const rows = this.db
      .prepare('SELECT miner_id FROM court_jury WHERE case_id = ?')
      .all(caseId) as Array<{ miner_id: string }>;
    return rows.map((r) => r.miner_id);
  }

  recordVote(caseId: string, minerId: string, vote: Vote, votedAt: number): void {
    this.db
      .prepare('UPDATE court_jury SET vote = ?, voted_at = ? WHERE case_id = ? AND miner_id = ?')
      .run(vote, votedAt, caseId, minerId);
  }

  countUnvoted(caseId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM court_jury WHERE case_id = ? AND vote IS NULL')
      .get(caseId) as { cnt: number };
    return row.cnt;
  }
}
