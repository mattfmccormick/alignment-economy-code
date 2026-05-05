// SQLite-backed implementation of IAccountStore.
//
// This file owns every SQL query against the `accounts` table. If you find
// yourself writing raw SQL against accounts in another file, move it here.
// The rest of the protocol (account.ts, day-cycle.ts, etc.) talks to this
// through IAccountStore only.

import { DatabaseSync } from 'node:sqlite';
import type { Account, AccountInheritance, AccountType } from '../types.js';
import type { AccountInsert, BalanceField, IAccountStore } from './IAccountStore.js';

const ALLOWED_BALANCE_FIELDS: ReadonlySet<BalanceField> = new Set([
  'earned_balance',
  'active_balance',
  'supportive_balance',
  'ambient_balance',
  'locked_balance',
]);

function parseInheritance(raw: unknown): AccountInheritance | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.beneficiaries)) {
      return {
        beneficiaries: parsed.beneficiaries.filter((b: unknown): b is string => typeof b === 'string'),
        threshold: typeof parsed.threshold === 'number' ? parsed.threshold : 1,
        deadManSwitchDays: typeof parsed.deadManSwitchDays === 'number' ? parsed.deadManSwitchDays : 365,
        configuredAt: typeof parsed.configuredAt === 'number' ? parsed.configuredAt : 0,
      };
    }
  } catch { /* fall through */ }
  return null;
}

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    publicKey: row.public_key as string,
    type: row.type as AccountType,
    earnedBalance: BigInt(row.earned_balance as string),
    activeBalance: BigInt(row.active_balance as string),
    supportiveBalance: BigInt(row.supportive_balance as string),
    ambientBalance: BigInt(row.ambient_balance as string),
    lockedBalance: BigInt(row.locked_balance as string),
    percentHuman: row.percent_human as number,
    joinedDay: row.joined_day as number,
    isActive: (row.is_active as number) === 1,
    protectionWindowEnd: row.protection_window_end as number | null,
    createdAt: row.created_at as number,
    lastActivityAt: (row.last_activity_at as number | null) ?? null,
    inheritance: parseInheritance(row.inheritance),
  };
}

export class SqliteAccountStore implements IAccountStore {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToAccount(row) : null;
  }

  findByPublicKey(publicKey: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE public_key = ?')
      .get(publicKey) as Record<string, unknown> | undefined;
    return row ? rowToAccount(row) : null;
  }

  findAll(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts').all() as Array<Record<string, unknown>>;
    return rows.map(rowToAccount);
  }

  findActiveIndividuals(): Account[] {
    // Every active individual receives the daily mint regardless of percent_human.
    // Verification status is enforced at the *spend* layer (transactions and tag
    // finalization multiply value by percent_human/100), not at the mint layer.
    // This lets new joiners see their allocation accumulating, which is the
    // visible carrot that makes verification worth pursuing. Sybil resistance
    // still holds: an unverified account at 0% can mint freely but moves zero
    // value, so duplicate accounts gain nothing economically.
    const rows = this.db
      .prepare(
        "SELECT * FROM accounts WHERE type = 'individual' AND is_active = 1",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToAccount);
  }

  insert(input: AccountInsert): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, public_key, type, earned_balance, active_balance,
         supportive_balance, ambient_balance, locked_balance, percent_human,
         joined_day, is_active, protection_window_end, created_at, last_activity_at, inheritance)
         VALUES (?, ?, ?, '0', '0', '0', '0', '0', ?, ?, 1, NULL, ?, NULL, NULL)`,
      )
      .run(input.id, input.publicKey, input.type, input.percentHuman, input.joinedDay, input.createdAt);
  }

  setLastActivity(accountId: string, timestamp: number): void {
    this.db.prepare('UPDATE accounts SET last_activity_at = ? WHERE id = ?').run(timestamp, accountId);
  }

  setInheritance(accountId: string, config: AccountInheritance | null): void {
    const json = config ? JSON.stringify(config) : null;
    this.db.prepare('UPDATE accounts SET inheritance = ? WHERE id = ?').run(json, accountId);
  }

  updateBalance(accountId: string, field: BalanceField, newValue: bigint): void {
    // node:sqlite doesn't support parameterized column names. Hard-validate
    // the column name against the allowlist before splicing it in.
    if (!ALLOWED_BALANCE_FIELDS.has(field)) {
      throw new Error(`Invalid balance field: ${field}`);
    }
    this.db
      .prepare(`UPDATE accounts SET ${field} = ? WHERE id = ?`)
      .run(newValue.toString(), accountId);
  }

  updatePercentHuman(accountId: string, percentHuman: number): void {
    this.db.prepare('UPDATE accounts SET percent_human = ? WHERE id = ?').run(percentHuman, accountId);
  }

  deactivate(accountId: string): void {
    this.db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(accountId);
  }

  countActiveParticipants(): number {
    // Counts every active individual (verified or not). Used for rebase math
    // and network-health stats. We count unverified accounts because they
    // receive the mint and hold balances; excluding them would skew the rebase
    // target and make the per-person purchasing power drift as people verify.
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM accounts WHERE type = 'individual' AND is_active = 1",
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  totalEarnedPool(): bigint {
    // SUM done in JS rather than SQL because we store balances as text-bigint.
    const rows = this.db
      .prepare('SELECT earned_balance, locked_balance FROM accounts')
      .all() as Array<{ earned_balance: string; locked_balance: string }>;
    let total = 0n;
    for (const row of rows) {
      total += BigInt(row.earned_balance) + BigInt(row.locked_balance);
    }
    return total;
  }
}
