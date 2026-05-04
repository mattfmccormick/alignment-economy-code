// Repository interface for court storage.
//
// The court tables hold disputes (court_cases) and the juror seats assigned
// to each (court_jury). Cross-table operations involving account balance
// changes (locking stake, paying bounty, burning losers) live in the court
// business logic and use IAccountStore + ITransactionStore for those side
// effects. This interface only owns reads/writes against the court tables.

import type { CourtCase, JurorRecord, Vote } from '../../court/types.js';

export interface CourtCaseInsert {
  id: string;
  type: CourtCase['type'];
  level: CourtCase['level'];
  challengerId: string;
  defendantId: string;
  challengerStake: bigint;
  challengerStakePercent: number;
  status: CourtCase['status'];
  arbitrationDeadline: number | null;
  votingDeadline: number | null;
  appealOf: string | null;
  createdAt: number;
}

export interface JurorInsert {
  id: string;
  caseId: string;
  minerId: string;
  jurorAccountId: string;
  stakeAmount: bigint;
}

export interface ICourtStore {
  // ── court_cases ────────────────────────────────────────────────

  /** Insert a new case. Throws on id collision. */
  insertCase(input: CourtCaseInsert): void;

  /** Look up a case by id. */
  findCaseById(id: string): CourtCase | null;

  /** Active = status NOT IN ('closed','withdrawn','court_verdict','appeal_verdict'). */
  findActiveCases(): CourtCase[];

  /** Cases where the account is challenger or defendant. Newest first. */
  findCasesByAccount(accountId: string): CourtCase[];

  /** Is there an active case against this defendant already? */
  findActiveCaseAgainst(defendantId: string): CourtCase | null;

  /** Cases that appeal the given case id. */
  findAppealsOf(caseId: string): CourtCase[];

  /** How many appeals have been filed against this case? */
  countAppealsOf(caseId: string): number;

  /** Move case to court level (out of arbitration). */
  setLevelToCourt(caseId: string): void;

  /** Mark case as waiting for jury (insufficient eligible miners). */
  setStatusWaitingJury(caseId: string): void;

  /** Move case into the voting stage with a deadline. */
  setStatusVoting(caseId: string, votingDeadline: number): void;

  /** Record the final verdict on a case. */
  setVerdict(caseId: string, verdict: CourtCase['verdict'], status: CourtCase['status'], resolvedAt: number): void;

  // ── court_jury ─────────────────────────────────────────────────

  /** Insert a juror seat for a case. */
  insertJuror(input: JurorInsert): void;

  /** Look up a juror seat by case + miner. */
  findJurorByMiner(caseId: string, minerId: string): JurorRecord | null;

  /** All jurors on a case. */
  findJurorsByCase(caseId: string): JurorRecord[];

  /** Miner ids of every juror on a case. Used during selection to filter conflicts. */
  findJurorMinerIds(caseId: string): string[];

  /** Record a juror's vote. */
  recordVote(caseId: string, minerId: string, vote: Vote, votedAt: number): void;

  /** Count of unvoted jurors on a case. Determines when verdict resolves. */
  countUnvoted(caseId: string): number;
}
