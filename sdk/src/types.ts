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
