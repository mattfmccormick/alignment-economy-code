// SQLite-backed implementation of IValidatorSet. All SQL against the
// `validators` table lives here.

import { DatabaseSync } from 'node:sqlite';
import type {
  IValidatorSet,
  ValidatorInfo,
  ValidatorRegistration,
} from './IValidatorSet.js';

function rowToValidator(row: Record<string, unknown>): ValidatorInfo {
  return {
    accountId: row.account_id as string,
    nodePublicKey: row.node_public_key as string,
    vrfPublicKey: row.vrf_public_key as string,
    stake: BigInt(row.stake as string),
    isActive: (row.is_active as number) === 1,
    registeredAt: row.registered_at as number,
    deregisteredAt:
      row.deregistered_at === null ? null : (row.deregistered_at as number),
  };
}

export class SqliteValidatorSet implements IValidatorSet {
  constructor(private readonly db: DatabaseSync) {}

  insert(info: ValidatorRegistration): void {
    this.db
      .prepare(
        `INSERT INTO validators (account_id, node_public_key, vrf_public_key, stake, is_active, registered_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        info.accountId,
        info.nodePublicKey,
        info.vrfPublicKey,
        info.stake.toString(),
        info.registeredAt,
      );
  }

  markInactive(accountId: string, deregisteredAt: number): void {
    this.db
      .prepare(
        `UPDATE validators SET is_active = 0, deregistered_at = ? WHERE account_id = ?`,
      )
      .run(deregisteredAt, accountId);
  }

  markActive(accountId: string): void {
    this.db
      .prepare(
        `UPDATE validators SET is_active = 1, deregistered_at = NULL WHERE account_id = ?`,
      )
      .run(accountId);
  }

  findByAccountId(accountId: string): ValidatorInfo | null {
    const row = this.db
      .prepare(`SELECT * FROM validators WHERE account_id = ?`)
      .get(accountId) as Record<string, unknown> | undefined;
    return row ? rowToValidator(row) : null;
  }

  findByNodePublicKey(publicKey: string): ValidatorInfo | null {
    const row = this.db
      .prepare(`SELECT * FROM validators WHERE node_public_key = ?`)
      .get(publicKey) as Record<string, unknown> | undefined;
    return row ? rowToValidator(row) : null;
  }

  listActive(): ValidatorInfo[] {
    const rows = this.db
      .prepare(`SELECT * FROM validators WHERE is_active = 1 ORDER BY account_id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToValidator);
  }

  listAll(): ValidatorInfo[] {
    const rows = this.db
      .prepare(`SELECT * FROM validators ORDER BY account_id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToValidator);
  }

  totalActiveStake(): bigint {
    const rows = this.db
      .prepare(`SELECT stake FROM validators WHERE is_active = 1`)
      .all() as Array<{ stake: string }>;
    let total = 0n;
    for (const r of rows) total += BigInt(r.stake);
    return total;
  }

  quorumCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM validators WHERE is_active = 1`)
      .get() as { cnt: number };
    const n = row.cnt;
    if (n === 0) return 0;
    // floor(2N/3) + 1 — matches Tendermint-style 2/3+ majority.
    return Math.floor((2 * n) / 3) + 1;
  }
}
