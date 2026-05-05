// Public types exposed by the SDK. Mirrors the shapes ae-node returns
// over /api/v1/* without depending on ae-node internals — that way the
// SDK can be published without bundling the entire backend, and a future
// ae-node refactor doesn't ripple into every consumer.

export type AccountType = 'individual' | 'company' | 'government' | 'ai_bot';
export type PointType = 'active' | 'supportive' | 'ambient' | 'earned';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { timestamp: number };
}

export interface Account {
  id: string;
  publicKey: string;
  type: AccountType;
  percentHuman: number;
  joinedDay: number;
  isActive: boolean;
  activeBalance: string;       // bigint serialized as base-10 string
  supportiveBalance: string;
  ambientBalance: string;
  earnedBalance: string;
  lockedBalance: string;
  protectionWindowEnd: number | null;
  createdAt: number;
}

export interface Transaction {
  id: string;
  from: string;
  to: string;
  amount: string;            // base-10 bigint
  fee: string;
  netAmount: string;
  pointType: PointType;
  isInPerson: boolean;
  /** Receiver's countersignature on isInPerson txs (Phase 67); null otherwise. */
  receiverSignature: string | null;
  memo: string;
  signature: string;
  timestamp: number;
  blockNumber: number | null;
}

export interface NetworkStatus {
  currentDay: number;
  blockHeight: number;
  participantCount: number;
  minerCount: number;
  totalEarnedPool: string;
  targetTotal: string;
  transactionsToday: number;
  feePoolBalance: string;
}

export interface Block {
  number: number;
  hash: string;
  parentHash: string;
  day: number;
  timestamp: number;
  authorityNodeId: string;
  authoritySignature: string;
}

/** The transaction body the API expects on POST /transactions. */
export interface TransactionPayload {
  to: string;
  amount: number;            // display units (NOT base units)
  pointType: PointType;
  isInPerson?: boolean;
  memo?: string;
  /** Required when isInPerson === true; rejected otherwise. */
  receiverSignature?: string;
}

// ─── Court ──────────────────────────────────────────────────────────────

export type CaseType = 'not_human' | 'duplicate_account';
export type CaseLevel = 'tier1_panel' | 'tier2_jury' | 'full_jury';
export type CaseStatus =
  | 'arbitration'
  | 'voting'
  | 'resolved'
  | 'expired'
  | 'appealed';
export type Verdict = 'guilty' | 'innocent' | 'no_consensus' | null;

export interface CourtCase {
  id: string;
  type: CaseType;
  level: CaseLevel;
  challengerId: string;
  defendantId: string;
  challengerStake: string;          // bigint base-10 string
  challengerStakePercent: number;
  status: CaseStatus;
  arbitrationDeadline: number;
  votingDeadline: number;
  verdict: Verdict;
  appealOf: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

// ─── Miners / Vouches ──────────────────────────────────────────────────

export interface MinerStatus {
  isMiner: boolean;
  miner?: {
    accountId: string;
    tier: number;
    stake: string;            // bigint base-10
    accuracy: number | null;
    casesHeard: number;
    registeredAt: number;
  };
}

export interface Vouch {
  id: string;
  voucherId: string;
  voucheeId: string;
  stakeAmount: string;        // bigint base-10
  status: string;             // 'active' | 'burned' | 'released'
  createdAt: number;
  releasedAt: number | null;
}

export interface VouchesForAccount {
  received: Vouch[];
  given: Vouch[];
}

// ─── Tags (durable goods + spaces) ─────────────────────────────────────

export interface Product {
  id: string;
  name: string;
  category: string;
  manufacturerId: string;
  createdBy: string;
  isActive: boolean;
  createdAt: number;
}

export interface Space {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  entityId: string | null;
  collectionRate: number;
  isActive: boolean;
  createdAt: number;
}
