export type CaseType = 'not_human' | 'duplicate_account';
export type CaseLevel = 'arbitration' | 'court' | 'appeal';
export type CaseStatus =
  | 'arbitration_open'
  | 'arbitration_response'
  | 'withdrawn'
  | 'court_open'
  | 'court_waiting_jury'
  | 'court_voting'
  | 'court_verdict'
  | 'appeal_open'
  | 'appeal_voting'
  | 'appeal_verdict'
  | 'closed';

export type Verdict = 'guilty' | 'innocent';
export type Vote = 'human' | 'not_human';

export interface CourtCase {
  id: string;
  type: CaseType;
  level: CaseLevel;
  challengerId: string;
  defendantId: string;
  challengerStake: bigint;
  challengerStakePercent: number;
  status: CaseStatus;
  arbitrationDeadline: number | null;
  votingDeadline: number | null;
  verdict: Verdict | null;
  appealOf: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface JuryAssignment {
  caseId: string;
  minerId: string;
  jurorAccountId: string;
  stakeAmount: bigint;
  vote: Vote | null;
  votedAt: number | null;
}

/**
 * A single juror seat row from the court_jury table. Identical shape to
 * JuryAssignment plus an `id` (the row primary key). The store deals in this
 * type; consumers like resolveVerdict can use either.
 */
export interface JurorRecord extends JuryAssignment {
  id: string;
}

export type ArgumentRole = 'challenger' | 'defendant';

export interface CaseArgument {
  id: string;
  caseId: string;
  submitterId: string;
  role: ArgumentRole;
  text: string;
  attachmentHash: string | null;
  createdAt: number;
}
