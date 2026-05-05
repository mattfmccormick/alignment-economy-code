// All balance values are stored as bigint in fixed-precision (hundredths).
// 144000n = 1440.00 points. This prevents floating-point drift.

// Type-only import to avoid runtime circular deps with consensus modules.
import type { ValidatorChange } from './consensus/validator-change.js';

export type AccountType = 'individual' | 'company' | 'government' | 'ai_bot';
export type PointType = 'active' | 'supportive' | 'ambient' | 'earned';

export interface Account {
  id: string;                          // first 20 bytes of SHA-256(publicKey), hex
  publicKey: string;                   // hex-encoded Ed25519 public key
  type: AccountType;
  earnedBalance: bigint;
  activeBalance: bigint;
  supportiveBalance: bigint;
  ambientBalance: bigint;
  lockedBalance: bigint;               // points locked in vouch stakes
  percentHuman: number;                // 0-100 integer
  joinedDay: number;
  isActive: boolean;
  protectionWindowEnd: number | null;
  createdAt: number;                   // unix timestamp
}

export interface AccountCreationResult {
  account: Account;
  publicKey: string;
  privateKey: string;                  // returned ONCE, never stored
}

export type ChangeType =
  | 'tx_send'
  | 'tx_receive'
  | 'fee'
  | 'mint'
  | 'rebase'
  | 'burn_expire'
  | 'burn_unverified'
  | 'vouch_lock'
  | 'vouch_unlock'
  | 'vouch_burn'
  | 'bounty'
  | 'court_burn'
  | 'fee_distribution';

export interface TransactionLogEntry {
  id: string;
  accountId: string;
  changeType: ChangeType;
  pointType: PointType;
  amount: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  referenceId: string;
  timestamp: number;
}

export interface Transaction {
  id: string;
  from: string;
  to: string;
  amount: bigint;                      // in fixed-precision
  fee: bigint;
  netAmount: bigint;
  pointType: PointType;
  isInPerson: boolean;
  memo: string;
  signature: string;
  /**
   * Receiver's countersignature. Required (non-null) on isInPerson
   * transactions per the whitepaper's dual-signature requirement; both
   * parties must consent to the in-person attestation, otherwise a
   * malicious sender could spam isInPerson=true txs to inflate either
   * party's percent-human score. Null on regular transactions.
   */
  receiverSignature: string | null;
  timestamp: number;
  blockNumber: number | null;
}

export interface FeePool {
  totalAccumulated: bigint;
  totalDistributed: bigint;
  currentBalance: bigint;
}

export interface Block {
  number: number;
  day: number;
  timestamp: number;
  previousHash: string;
  hash: string;
  merkleRoot: string;
  transactionCount: number;
  rebaseEvent: RebaseEvent | null;
  /**
   * Hash of the commit certificate for this block's parent (block N-1).
   * Folded into this block's canonical hash so a tampered cert cannot ride
   * alongside an otherwise-valid block: change one byte of the parent cert
   * and the resulting child block hash no longer matches.
   *
   * null in three cases:
   *   - genesis (no parent)
   *   - block 1 in BFT mode (parent is genesis, which has no cert)
   *   - any block produced under AuthorityConsensus (no certs in Phase 1)
   *
   * Set by BftBlockProducer for blocks N >= 2 under BFT consensus, and
   * verified by validateIncomingBlock against `parentCertificate` on the
   * receive side.
   */
  prevCommitCertHash: string | null;
  /**
   * Validator-set changes carried by this block (Session 51). Persisted
   * so a node syncing past blocks can re-apply them and arrive at the
   * correct CURRENT validator set — without this, a late joiner only
   * sees the genesis set plus whatever changes happened after they
   * connected.
   *
   * Empty list (or `null` for legacy/Authority blocks) means no changes
   * rode this block. Each entry is a fully-signed ValidatorChange whose
   * signature was verified by validateIncomingBlock at receive time.
   */
  validatorChanges: ValidatorChange[] | null;
}

export interface RebaseEvent {
  day: number;
  participantCount: number;
  preRebaseTotal: bigint;
  targetTotal: bigint;
  rebaseMultiplier: number;            // stored as float for display; math uses bigint
  postRebaseTotal: bigint;
}

// White-paper cycle phases anchored to UTC time:
//   active        normal operating state, all transactions allowed
//   expiring      08:59 UTC: zeroing daily balances. Daily-point txs blocked.
//   rebasing      08:59 UTC: applying daily rebase multiplier. Daily-point txs blocked.
//   between_cycles after expire+rebase, before advance+mint. The "blackout minute."
//                 Daily-point txs blocked. Earned-point txs still allowed.
//   minting       09:00 UTC: minting fresh allocations on the new day.
//   idle          legacy initial state (pre-first-cycle); equivalent to 'active'.
export type CyclePhase = 'idle' | 'expiring' | 'rebasing' | 'between_cycles' | 'minting' | 'active';

export interface DayCycleState {
  currentDay: number;
  cyclePhase: CyclePhase;
  phaseStartedAt: number;
}
