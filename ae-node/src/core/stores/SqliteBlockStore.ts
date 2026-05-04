// SQLite-backed implementation of IBlockStore.
//
// Owns every SQL query against the `blocks` table. The rebase_event column
// is JSON-encoded (with bigint → string handling) at write time and parsed
// at read time, so the Block domain object the rest of the protocol sees
// has typed bigints.

import { DatabaseSync } from 'node:sqlite';
import type { Block } from '../types.js';
import type { IBlockStore } from './IBlockStore.js';
import type { CommitCertificate } from '../consensus/commit-certificate.js';
import type { ValidatorInfo } from '../consensus/IValidatorSet.js';
import type { ValidatorChange } from '../consensus/validator-change.js';

/**
 * JSON encoder/decoder for ValidatorInfo[] that survives the bigint stake.
 */
function encodeValidatorSnapshot(validators: ValidatorInfo[]): string {
  return JSON.stringify(validators, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

function decodeValidatorSnapshot(json: string): ValidatorInfo[] {
  const raw = JSON.parse(json) as Array<Record<string, unknown>>;
  return raw.map((r) => ({
    accountId: r.accountId as string,
    nodePublicKey: r.nodePublicKey as string,
    vrfPublicKey: r.vrfPublicKey as string,
    stake: BigInt(r.stake as string),
    isActive: r.isActive as boolean,
    registeredAt: r.registeredAt as number,
    deregisteredAt: r.deregisteredAt as number | null,
  }));
}

function rowToBlock(row: Record<string, unknown>): Block {
  const rawChanges = row.validator_changes as string | null | undefined;
  return {
    number: row.number as number,
    day: row.day as number,
    timestamp: row.timestamp as number,
    previousHash: row.previous_hash as string,
    hash: row.hash as string,
    merkleRoot: row.merkle_root as string,
    transactionCount: row.transaction_count as number,
    rebaseEvent: row.rebase_event ? JSON.parse(row.rebase_event as string) : null,
    prevCommitCertHash: (row.prev_commit_cert_hash as string | null | undefined) ?? null,
    validatorChanges: rawChanges ? (JSON.parse(rawChanges) as ValidatorChange[]) : null,
  };
}

function validatorChangesToColumn(block: Block): string | null {
  if (!block.validatorChanges || block.validatorChanges.length === 0) return null;
  return JSON.stringify(block.validatorChanges);
}

function rebaseEventToColumn(block: Block): string | null {
  if (!block.rebaseEvent) return null;
  // bigint values must be stringified to survive JSON.stringify.
  return JSON.stringify(block.rebaseEvent, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export class SqliteBlockStore implements IBlockStore {
  constructor(private readonly db: DatabaseSync) {}

  findByNumber(n: number): Block | null {
    const row = this.db
      .prepare('SELECT * FROM blocks WHERE number = ?')
      .get(n) as Record<string, unknown> | undefined;
    return row ? rowToBlock(row) : null;
  }

  findLatest(): Block | null {
    const row = this.db
      .prepare('SELECT * FROM blocks ORDER BY number DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row ? rowToBlock(row) : null;
  }

  findAll(): Block[] {
    const rows = this.db
      .prepare('SELECT * FROM blocks ORDER BY number ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToBlock);
  }

  insert(block: Block, isGenesis: boolean): void {
    const sql = isGenesis
      ? `INSERT OR IGNORE INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count, rebase_event, prev_commit_cert_hash, validator_changes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count, rebase_event, prev_commit_cert_hash, validator_changes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.db
      .prepare(sql)
      .run(
        block.number,
        block.day,
        block.timestamp,
        block.previousHash,
        block.hash,
        block.merkleRoot,
        block.transactionCount,
        rebaseEventToColumn(block),
        block.prevCommitCertHash,
        validatorChangesToColumn(block),
      );
  }

  saveCommitCertificate(blockNumber: number, cert: CommitCertificate): void {
    // bigint-safe JSON encoding (CommitCertificate.precommits has number
    // fields, no bigints, but using the same encoder is harmless and
    // future-proof against schema additions).
    const json = JSON.stringify(cert, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    this.db
      .prepare('UPDATE blocks SET commit_certificate = ? WHERE number = ?')
      .run(json, blockNumber);
  }

  findCommitCertificate(blockNumber: number): CommitCertificate | null {
    const row = this.db
      .prepare('SELECT commit_certificate FROM blocks WHERE number = ?')
      .get(blockNumber) as { commit_certificate: string | null } | undefined;
    if (!row || !row.commit_certificate) return null;
    return JSON.parse(row.commit_certificate) as CommitCertificate;
  }

  saveValidatorSnapshot(blockNumber: number, validators: ValidatorInfo[]): void {
    const json = encodeValidatorSnapshot(validators);
    this.db
      .prepare('UPDATE blocks SET validator_snapshot = ? WHERE number = ?')
      .run(json, blockNumber);
  }

  findValidatorSnapshot(blockNumber: number): ValidatorInfo[] | null {
    const row = this.db
      .prepare('SELECT validator_snapshot FROM blocks WHERE number = ?')
      .get(blockNumber) as { validator_snapshot: string | null } | undefined;
    if (!row || !row.validator_snapshot) return null;
    return decodeValidatorSnapshot(row.validator_snapshot);
  }
}
