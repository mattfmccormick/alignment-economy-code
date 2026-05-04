export interface EvidenceType {
  id: string;
  name: string;
  tier: 'A' | 'B' | 'C';
  scoreValue: number;
  maxPerAccount: number | null;
  maxScorePerWindow?: number;
  windowDays?: number;
  minStakePercent?: number;
  requires?: string;
  description: string;
}

export interface VerificationPolicy {
  version: number;
  evidenceTypes: EvidenceType[];
  tierCaps: { A: number; B: number; C: number | null };
  totalCap: number;
  decay: {
    monthlyRate: number;
    inPersonOffset: number;
    maxOffsetPerWindow: number;
    windowDays: number;
  };
}

export interface Evidence {
  id: string;
  accountId: string;
  evidenceTypeId: string;
  evidenceHash: string;
  submittedAt: number;
  reviewedBy: string | null;
}

export interface VerificationPanel {
  id: string;
  accountId: string;
  status: 'pending' | 'in_progress' | 'complete';
  createdAt: number;
  completedAt: number | null;
  medianScore: number | null;
}

export interface PanelReview {
  id: string;
  panelId: string;
  minerId: string;
  score: number;
  evidenceHashOfReview: string;
  submittedAt: number;
}

export interface Vouch {
  id: string;
  voucherId: string;
  vouchedId: string;
  stakeAmount: bigint;
  stakedPercentage: number;
  isActive: boolean;
  createdAt: number;
  withdrawnAt: number | null;
}

export interface VouchRequest {
  id: string;
  fromId: string;
  toId: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string;
  createdAt: number;
  respondedAt: number | null;
}

export interface ScoreBreakdown {
  totalScore: number;
  breakdown: { tierA: number; tierB: number; tierC: number };
  evidenceDetails: Array<{ typeId: string; value: number }>;
  decayApplied: boolean;
  nextDecayDate: number | null;
}
