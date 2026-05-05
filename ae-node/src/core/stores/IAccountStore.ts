// Repository interface for account storage.
//
// Why this exists:
//   - The SQL queries that read and write the `accounts` table used to live
//     directly inside core/account.ts. That tied protocol logic to a specific
//     storage backend (node:sqlite) and made it impossible to swap to Postgres,
//     a sharded store, or an in-memory test store without rewriting
//     business logic.
//   - This interface is the single contract every storage implementation must
//     honor. The protocol code depends on this interface only, so the storage
//     backend can change underneath without touching the day cycle, the
//     transaction processor, the court, or any of the other core modules.
//
// New backends drop in by implementing this interface:
//   - SqliteAccountStore (the current one)
//   - PostgresAccountStore (future Phase 2 work)
//   - InMemoryAccountStore (tests, or speculative state in the consensus engine)

import type { Account, AccountInheritance, AccountType } from '../types.js';

export type BalanceField =
  | 'earned_balance'
  | 'active_balance'
  | 'supportive_balance'
  | 'ambient_balance'
  | 'locked_balance';

export interface AccountInsert {
  id: string;
  publicKey: string;
  type: AccountType;
  percentHuman: number;
  joinedDay: number;
  createdAt: number;
}

export interface IAccountStore {
  /** Look up an account by its derived ID. Returns null if not found. */
  findById(id: string): Account | null;

  /** Look up an account by its public key. Returns null if not found. */
  findByPublicKey(publicKey: string): Account | null;

  /** Iterate every account. Used by the day cycle and explorer. */
  findAll(): Account[];

  /** All active individuals. Eligible for the daily mint regardless of percentHuman; verification gates spending (the percentHuman multiplier on transactions and tag finalization), not minting. */
  findActiveIndividuals(): Account[];

  /** Insert a new account row. Throws if id collides. */
  insert(input: AccountInsert): void;

  /** Update one of the bigint balance columns. Field must be a known balance column. */
  updateBalance(accountId: string, field: BalanceField, newValue: bigint): void;

  /** Update the percent-human score (0-100). */
  updatePercentHuman(accountId: string, percentHuman: number): void;

  /** Mark an account inactive. Used after court verdicts. */
  deactivate(accountId: string): void;

  /** Count of all active individuals. Used by rebase to size the per-person target. Includes unverified accounts because they receive the mint and hold balances. */
  countActiveParticipants(): number;

  /** Sum of (earned + locked) balances across all accounts. Used by rebase. */
  totalEarnedPool(): bigint;

  /**
   * Stamp the owner's last outbound action time. The dead-man-switch
   * inheritance flow uses this to decide when an account is abandoned —
   * if `now - lastActivityAt >= deadManSwitchDays`, beneficiaries can
   * claim. Called from processTransaction (and similar code paths).
   */
  setLastActivity(accountId: string, timestamp: number): void;

  /**
   * Set or clear the inheritance config for an account. Pass null to
   * remove. Called by the inheritance helpers in core/inheritance.ts;
   * direct callers should use setInheritance there for validation.
   */
  setInheritance(accountId: string, config: AccountInheritance | null): void;
}
