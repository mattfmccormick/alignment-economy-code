export type CaseType = 'not_human' | 'duplicate_account';
export type CaseLevel = 'arbitration' | 'court' | 'appeal';
export type CaseStatus =
  | 'arbitration_open'
  | 'arbitration_response'
  /** The challenger withdrew during arbitration. */
  | 'withdrawn'
  /** Closed with no verdict and no fault: no jury, or no majority. */
  | 'dismissed'
  | 'court_open'
  | 'court_waiting_jury'
  | 'court_voting'
  /**
   * The jury has decided but nothing has settled. Every stake stays locked and
   * the defendant stays frozen until the appeal window closes or the appeal
   * is decided, then the case settles once against the final verdict.
   */
  | 'verdict_pending'
  /** Final and settled. */
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
  /**
   * For `duplicate_account` cases: the earlier account the defendant is
   * alleged to duplicate. On a guilty verdict this account survives (the
   * defendant closes) and pays the overlap penalty (WP §9.3). NULL for
   * `not_human` cases.
   */
  counterpartId: string | null;
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
  /**
   * Files backing the post. The file itself stays with whoever added it; the
   * case carries its name and SHA-256 so it cannot be swapped later.
   */
  attachments: ArgumentAttachment[];
  /** Ways the poster offers to prove themselves beyond the text. */
  offers: ArgumentOffer[];
  createdAt: number;
}

export interface ArgumentAttachment {
  name: string;
  hash: string;
}

export type ArgumentOffer = 'call' | 'in_person';
