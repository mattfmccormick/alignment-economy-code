// Wallet-side shapes for the API responses the wallet consumes. These mirror
// the ae-node serializers: camelCase fields, with bigint balances serialized as
// base-unit strings (formatting helpers accept string | bigint | number).
//
// Part of the D5 burn-down: replacing `any` in the API client with real types,
// starting with the account (the money-critical entity most pages read).

/** A bare acknowledgement returned by mutation routes that carry no payload. */
export interface SuccessResponse {
  success: boolean;
}

/** The percent-human score breakdown (ae-node's `ScoreBreakdown`). */
export interface ScoreBreakdownData {
  totalScore: number;
  breakdown: { tierA: number; tierB: number; tierC: number };
  evidenceDetails: Array<{ typeId: string; value: number }>;
  decayApplied: boolean;
  nextDecayDate: number | null;
}

export interface AccountData {
  id: string;
  type: string;
  publicKey: string;
  earnedBalance: string;
  activeBalance: string;
  supportiveBalance: string;
  ambientBalance: string;
  lockedBalance: string;
  percentHuman: number;
  joinedDay: number;
  isActive: boolean;
  isEscrowed: boolean;
  protectionWindowEnd: number | null;
  createdAt: number;
}

/**
 * What `GET /accounts/:id` returns: the serialized account plus the derived
 * `percentOfEconomy` (the account's share of the total Earned pool), which the
 * route computes on the fly. `createAccount` returns the plain `AccountData`.
 */
export interface AccountDetail extends AccountData {
  percentOfEconomy: number;
}

/**
 * A settled transaction as returned by `GET /accounts/:id/transactions`
 * (ae-node's `rowToTransaction`). CamelCase; amounts are base-unit strings.
 * Note: this is the transaction record, distinct from the snake_case
 * `transaction_log` audit rows the ledger endpoint returns.
 */
export interface TransactionData {
  id: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  netAmount: string;
  pointType: string;
  isInPerson: boolean;
  recipientIsHuman: boolean;
  memo: string;
  signature: string;
  receiverSignature: string | null;
  timestamp: number;
  blockNumber: number | null;
}

// ─── Court ───────────────────────────────────────────────────────────────

/** A dispute case as serialized by the court routes (`serializeCase`). */
export interface CourtCaseData {
  id: string;
  type: string;
  level: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  challengerStakePercent: number;
  status: string;
  arbitrationDeadline: number;
  votingDeadline: number;
  verdict: string | null;
  appealOf: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** A case in the "my cases" list — a subset plus the viewer's role flags. */
export interface MyCaseData {
  id: string;
  type: string;
  level: string;
  status: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  challengerStakePercent: number;
  verdict: string | null;
  createdAt: number;
  resolvedAt: number | null;
  isDefendant: boolean;
  isChallenger: boolean;
}

/** A juror row in a case's panel. `vote` is 'sealed' until all have voted. */
export interface JurorData {
  minerId: string;
  jurorAccountId: string;
  stakeAmount: string;
  vote: string | null;
  votedAt: number | null;
}

/** An entry in a case's append-only argument log. */
export interface CaseArgumentData {
  id: string;
  caseId: string;
  submitterId: string;
  role: 'challenger' | 'defendant';
  text: string;
  attachmentHash: string | null;
  createdAt: number;
}

/**
 * An account-search hit from `GET /contacts/search/accounts`. Snake_case —
 * the route returns raw DB columns.
 */
export interface AccountSearchResult {
  id: string;
  public_key: string;
  type: string;
  percent_human: number;
  earned_balance: string;
  is_active: number;
}

/**
 * A recurring-transfer row from `GET /recurring/:accountId`. Snake_case — the
 * route returns raw joined DB columns (`SELECT r.*, a.public_key …`).
 */
export interface RecurringTransferData {
  id: string;
  from_id: string;
  to_id: string;
  amount: string | number;
  point_type: string;
  schedule: string;
  is_active: number;
  created_at: number;
  to_public_key?: string;
}

// ─── Tagging (durable goods & spaces) ─────────────────────────────────────

/** A durable-good product (camelCase; mapped from DB rows by the route). */
export interface ProductData {
  id: string;
  name: string;
  category: string;
  manufacturerId: string | null;
  createdBy: string;
  isActive: boolean;
  createdAt: number;
}

/** A physical space. */
export interface SpaceData {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  entityId: string | null;
  collectionRate: number;
  isActive: boolean;
  createdAt: number;
}

/** A submitted supportive tag (durable-good minutes). Points as a string. */
export interface SupportiveTagData {
  id: string;
  accountId: string;
  day: number;
  productId: string;
  minutesUsed: number;
  pointsAllocated: string;
  status: string;
}

/** A submitted ambient tag (space-occupancy minutes). Points as a string. */
export interface AmbientTagData {
  id: string;
  accountId: string;
  day: number;
  spaceId: string;
  minutesOccupied: number;
  pointsAllocated: string;
  status: string;
}

/** A verification-panel summary (ae-node's `VerificationPanel`). */
export interface PanelSummary {
  id: string;
  accountId: string;
  status: 'pending' | 'in_progress' | 'complete';
  createdAt: number;
  completedAt: number | null;
  medianScore: number | null;
}

// ─── Vouching ────────────────────────────────────────────────────────────

/** A vouch (WP v2: percentage-based). API stringifies the bigint stake. */
export interface VouchData {
  id: string;
  voucherId: string;
  vouchedId: string;
  stakeAmount: string;
  stakedPercentage: number;
  isActive: boolean;
  createdAt: number;
  withdrawnAt: number | null;
}

/** A pending vouch request between two accounts. */
export interface VouchRequestData {
  id: string;
  fromId: string;
  toId: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string;
  createdAt: number;
  respondedAt: number | null;
}

// ─── Miners & network ────────────────────────────────────────────────────

/** A miner record (ae-node's `Miner`). */
export interface MinerData {
  id: string;
  accountId: string;
  tier: 1 | 2;
  isActive: boolean;
  registeredAt: number;
  deactivatedAt: number | null;
}

/** `GET /miners/status/:id`: whether the account is a miner, and the record. */
export interface MinerStatus {
  isMiner: boolean;
  miner?: MinerData;
}

/**
 * A contacts-list row from `GET /contacts/:ownerId`. This one is snake_case —
 * the route returns raw joined DB columns (`SELECT c.*, a.public_key, …`)
 * rather than a camelCase serializer, so consumers must map it.
 */
export interface ContactData {
  id: string;
  owner_id: string;
  contact_account_id: string;
  nickname: string;
  is_favorite: number;
  created_at: number;
  public_key: string;
  percent_human: number;
  account_type: string;
}

/** `GET /network/status`: network-wide counters (bigint pools as strings). */
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
