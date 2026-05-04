// Block business logic.
//
// All persistence goes through IBlockStore (./stores/IBlockStore.ts). The
// functions exported here keep their original DatabaseSync-taking signatures
// for back-compat; internally each one wraps the db in a SqliteBlockStore.
// New code should take IBlockStore directly.

import { DatabaseSync } from 'node:sqlite';
import { sha256 } from './crypto.js';
import type { Block, RebaseEvent } from './types.js';
import { SqliteBlockStore } from './stores/SqliteBlockStore.js';
import type { IBlockStore } from './stores/IBlockStore.js';
import { SqliteTransactionStore } from './stores/SqliteTransactionStore.js';
import type { ITransactionStore } from './stores/ITransactionStore.js';
import { commitBlockSideEffects } from '../mining/rewards.js';

export function blockStore(db: DatabaseSync): IBlockStore {
  return new SqliteBlockStore(db);
}

// ─── Hashing primitives (pure, no storage) ──────────────────────────────

/**
 * Merkle root over a block's transaction set.
 *
 * Ordering: the input txIds are sorted ASCII-ascending before hashing. This
 * makes the merkleRoot a function of the SET of transactions, not the order
 * they happened to be inserted into the mempool. That matters for sync: a
 * follower can fetch txIds from storage in any order and still recompute
 * the same root. It also matches the AE protocol's actual semantics — every
 * transaction's state effect is applied at API-receipt time by
 * processTransaction, so the in-block ordering carries no execution meaning.
 *
 * NOTE: this is a hash-affecting change vs. earlier prototypes. There is no
 * production data yet, so callers don't need a migration path.
 */
export function computeMerkleRoot(txIds: string[]): string {
  if (txIds.length === 0) return sha256('empty');

  const sorted = [...txIds].sort();
  let hashes = sorted.map((id) => sha256(id));

  while (hashes.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      if (i + 1 < hashes.length) {
        next.push(sha256(hashes[i] + hashes[i + 1]));
      } else {
        next.push(hashes[i]); // odd element promoted
      }
    }
    hashes = next;
  }

  return hashes[0];
}

/**
 * Canonical block hash.
 *
 * Takes optional cryptographic commitments to two block-payload artifacts
 * that would otherwise be sidecar metadata:
 *
 *   - prevCommitCertHash: hash of the parent block's commit certificate
 *     (Session 39). Tampering with the parent cert breaks this hash.
 *
 *   - validatorChangesHash: hash of THIS block's validatorChanges
 *     (Session 52). Tampering with the changes list — swapping a
 *     register for a deregister, dropping an entry, reordering — breaks
 *     this hash. Mirrors the cert-hash pattern.
 *
 * For backward compatibility with AuthorityConsensus, genesis, and the
 * many blocks that carry no certs / no validator changes, both args
 * default to null. Empty-string concatenation produces an identical
 * hash to the no-arg form, so existing blocks need no migration.
 */
export function computeBlockHash(
  number: number,
  previousHash: string,
  timestamp: number,
  merkleRoot: string,
  day: number,
  prevCommitCertHash: string | null = null,
  validatorChangesHash: string | null = null,
): string {
  const certPart = prevCommitCertHash ?? '';
  const changesPart = validatorChangesHash ?? '';
  return sha256(`${number}${previousHash}${timestamp}${merkleRoot}${day}${certPart}${changesPart}`);
}

// ─── Block construction (pure logic + store I/O) ────────────────────────

export function createGenesisBlockWithStore(store: IBlockStore): Block {
  const genesis: Block = {
    number: 0,
    day: 0,
    timestamp: Math.floor(Date.now() / 1000),
    previousHash: '0'.repeat(64),
    hash: '',
    merkleRoot: sha256('genesis'),
    transactionCount: 0,
    rebaseEvent: null,
    prevCommitCertHash: null,
    validatorChanges: null,
  };
  genesis.hash = computeBlockHash(
    genesis.number,
    genesis.previousHash,
    genesis.timestamp,
    genesis.merkleRoot,
    genesis.day,
    genesis.prevCommitCertHash,
  );
  store.insert(genesis, /* isGenesis */ true);
  return genesis;
}

export function createBlockWithStore(
  store: IBlockStore,
  day: number,
  txIds: string[],
  rebaseEvent: RebaseEvent | null = null,
  txStore?: ITransactionStore,
  prevCommitCertHash: string | null = null,
): Block {
  const prev = store.findLatest();
  if (!prev) throw new Error('No genesis block found. Call createGenesisBlock first.');

  const merkleRoot = computeMerkleRoot(txIds);
  const timestamp = Math.floor(Date.now() / 1000);
  const number = prev.number + 1;
  const hash = computeBlockHash(number, prev.hash, timestamp, merkleRoot, day, prevCommitCertHash);

  const block: Block = {
    number,
    day,
    timestamp,
    previousHash: prev.hash,
    hash,
    merkleRoot,
    transactionCount: txIds.length,
    rebaseEvent,
    prevCommitCertHash,
    validatorChanges: null,
  };

  store.insert(block, /* isGenesis */ false);

  // Stamp the committed transactions with this block number so followers can
  // re-derive the merkleRoot during catch-up sync. txIds that don't exist in
  // the transactions table (synthetic ids in tests) are silently skipped.
  if (txStore && txIds.length > 0) {
    txStore.linkTransactionsToBlock(number, txIds);
  }

  return block;
}

export function validateBlockWithStore(store: IBlockStore, block: Block): { valid: boolean; error?: string } {
  // Verify hash
  const expectedHash = computeBlockHash(
    block.number,
    block.previousHash,
    block.timestamp,
    block.merkleRoot,
    block.day,
    block.prevCommitCertHash,
  );
  if (block.hash !== expectedHash) {
    return { valid: false, error: `Hash mismatch: expected ${expectedHash}, got ${block.hash}` };
  }

  // Verify previous hash chain
  if (block.number > 0) {
    const prevBlock = store.findByNumber(block.number - 1);
    if (!prevBlock) {
      return { valid: false, error: `Previous block ${block.number - 1} not found` };
    }
    if (block.previousHash !== prevBlock.hash) {
      return { valid: false, error: `Previous hash mismatch` };
    }
  }

  return { valid: true };
}

export function validateChainWithStore(store: IBlockStore): { valid: boolean; error?: string; blockNumber?: number } {
  const blocks = store.findAll();

  for (const block of blocks) {
    const result = validateBlockWithStore(store, block);
    if (!result.valid) {
      return { valid: false, error: result.error, blockNumber: block.number };
    }
  }

  return { valid: true };
}

// ─── Back-compat (db, ...) shims ────────────────────────────────────────

export function createGenesisBlock(db: DatabaseSync): Block {
  return createGenesisBlockWithStore(blockStore(db));
}

export function getLatestBlock(db: DatabaseSync): Block | null {
  return blockStore(db).findLatest();
}

export function getBlock(db: DatabaseSync, number: number): Block | null {
  return blockStore(db).findByNumber(number);
}

export function createBlock(
  db: DatabaseSync,
  day: number,
  txIds: string[],
  rebaseEvent: RebaseEvent | null = null,
  prevCommitCertHash: string | null = null,
): Block {
  const block = createBlockWithStore(
    blockStore(db),
    day,
    txIds,
    rebaseEvent,
    new SqliteTransactionStore(db),
    prevCommitCertHash,
  );
  // Distribute the block's fees per the WP economics (20% Tier 1, 80% Tier 2
  // with a 60/40 lottery/baseline split). Idempotent — safe to re-call.
  commitBlockSideEffects(db, block.number, block.hash);
  return block;
}

export function validateBlock(db: DatabaseSync, block: Block): { valid: boolean; error?: string } {
  return validateBlockWithStore(blockStore(db), block);
}

export function validateChain(db: DatabaseSync): { valid: boolean; error?: string; blockNumber?: number } {
  return validateChainWithStore(blockStore(db));
}
