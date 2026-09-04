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
import type { AccountRegistration } from '../account-registration.js';
import type { VouchOperation } from '../../verification/vouch-operation.js';
import type { MinerOperation } from '../../mining/miner-operation.js';

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
  const rawRegistrations = row.account_registrations as string | null | undefined;
  const rawVouchOps = row.vouch_operations as string | null | undefined;
  const rawMinerOps = row.miner_operations as string | null | undefined;
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
    accountRegistrations: rawRegistrations
      ? (JSON.parse(rawRegistrations) as AccountRegistration[])
      : null,
    vouchOperations: rawVouchOps ? (JSON.parse(rawVouchOps) as VouchOperation[]) : null,
    minerOperations: rawMinerOps ? (JSON.parse(rawMinerOps) as MinerOperation[]) : null,
  };
}

function validatorChangesToColumn(block: Block): string | null {
  if (!block.validatorChanges || block.validatorChanges.length === 0) return null;
  return JSON.stringify(block.validatorChanges);
}

// Null rather than '[]' for the empty case, matching validator changes: the
// vast majority of blocks carry no registrations, and null is what the hash
// treats as absent.
function accountRegistrationsToColumn(block: Block): string | null {
  if (!block.accountRegistrations || block.accountRegistrations.length === 0) return null;
  return JSON.stringify(block.accountRegistrations);
}

function vouchOperationsToColumn(block: Block): string | null {
  if (!block.vouchOperations || block.vouchOperations.length === 0) return null;
  return JSON.stringify(block.vouchOperations);
}

function minerOperationsToColumn(block: Block): string | null {
  if (!block.minerOperations || block.minerOperations.length === 0) return null;
  return JSON.stringify(block.minerOperations);
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
    const cols =
      'number, day, timestamp, previous_hash, hash, merkle_root, transaction_count, ' +
      'rebase_event, prev_commit_cert_hash, validator_changes, account_registrations, vouch_operations, miner_operations';
    const sql = isGenesis
      ? `INSERT OR IGNORE INTO blocks (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO blocks (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
        accountRegistrationsToColumn(block),
        vouchOperationsToColumn(block),
        minerOperationsToColumn(block),
      );
  }

  pruneBlocksThrough(cutoffNumber: number): number {
    const result = this.db
      .prepare('DELETE FROM blocks WHERE number > 0 AND number <= ?')
      .run(cutoffNumber);
    return Number(result.changes);
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

  /**
   * Store the validator set for a height, but only when it differs from the set
   * already in force.
   *
   * This wrote ~617 bytes on EVERY block recording a validator set that changes
   * perhaps a handful of times in a chain's life — about 30% of total storage
   * spent restating something that had not moved. On a real chain that was
   * 30,932 near-identical copies of a two-validator list.
   *
   * Dropping the duplicates is safe because the READ below resolves "the set in
   * force at height N" rather than "the row stored at height N". A height with
   * no row inherits the most recent earlier one, which is the same answer.
   */
  saveValidatorSnapshot(blockNumber: number, validators: ValidatorInfo[]): void {
    const inForce = this.findValidatorSnapshot(blockNumber - 1);
    if (inForce && sameValidatorSet(inForce, validators)) return;

    const json = encodeValidatorSnapshot(validators);
    this.db
      .prepare('UPDATE blocks SET validator_snapshot = ? WHERE number = ?')
      .run(json, blockNumber);
  }

  /**
   * The validator set in force at `blockNumber` — the snapshot stored at that
   * height, or the most recent one before it.
   *
   * Used to verify a historical commit certificate against the validators as
   * they were at that height, which matters once validators are slashed or
   * deregister: their old precommit signatures must still verify.
   *
   * The "at or before" walk is what makes storing only on change correct. An
   * exact-match lookup would return null for any height whose set was unchanged
   * — which, after this optimisation, is almost all of them.
   */
  saveStateRoot(blockNumber: number, root: string): void {
    this.db
      .prepare('UPDATE blocks SET state_root = ? WHERE number = ?')
      .run(root, blockNumber);
  }

  /**
   * Exact-match lookup, unlike findValidatorSnapshot's "at or before" walk.
   *
   * The difference is deliberate. A validator set persists until something
   * changes it, so a height with no row means "unchanged, inherit the earlier
   * one" and answering with the previous row is correct. A state root describes
   * one specific height and nothing else, so a height with no row means "not
   * recorded" — answering with a neighbour's value would let a snapshot verify
   * against state it does not actually contain.
   */
  findStateRoot(blockNumber: number): string | null {
    const row = this.db
      .prepare('SELECT state_root FROM blocks WHERE number = ?')
      .get(blockNumber) as { state_root: string | null } | undefined;
    return row?.state_root ?? null;
  }

  findValidatorSnapshot(blockNumber: number): ValidatorInfo[] | null {
    const row = this.db
      .prepare(
        `SELECT validator_snapshot FROM blocks
          WHERE number <= ? AND validator_snapshot IS NOT NULL
          ORDER BY number DESC LIMIT 1`,
      )
      .get(blockNumber) as { validator_snapshot: string | null } | undefined;
    if (!row || !row.validator_snapshot) return null;
    return decodeValidatorSnapshot(row.validator_snapshot);
  }
}

/**
 * Do two validator sets describe the same validators, with the same keys, stake
 * and active flags?
 *
 * Sorted by accountId first so an ordering difference between `listAll()` calls
 * is not mistaken for a real change — that would defeat the deduplication
 * without being incorrect, which is the kind of bug that hides for months.
 */
function sameValidatorSet(a: ValidatorInfo[], b: ValidatorInfo[]): boolean {
  if (a.length !== b.length) return false;
  const key = (v: ValidatorInfo) =>
    `${v.accountId}|${v.nodePublicKey}|${v.vrfPublicKey}|${v.stake.toString()}|${v.isActive ? 1 : 0}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((x, i) => x === sb[i]);
}
