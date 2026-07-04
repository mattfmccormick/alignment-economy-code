// Wallet-side shapes for the API responses the wallet consumes. These mirror
// the ae-node serializers: camelCase fields, with bigint balances serialized as
// base-unit strings (formatting helpers accept string | bigint | number).
//
// Part of the D5 burn-down: replacing `any` in the API client with real types,
// starting with the account (the money-critical entity most pages read).

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
