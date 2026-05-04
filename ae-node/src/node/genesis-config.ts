// Genesis configuration — the canonical specification of a chain's
// starting state.
//
// Why this exists:
//   Every node's createGenesisBlock() defaulted to Math.floor(Date.now()/1000)
//   for the genesis timestamp. Two nodes booting at different times produced
//   different genesis hashes, so when they tried to peer the handshake
//   rejected them on genesisHash mismatch. Single-node testing worked;
//   "Matt and his wife each run a node and they peer" did not.
//
//   The fix is a JSON spec that pins:
//     - the genesis block's timestamp (-> deterministic block hash)
//     - the initial set of accounts and their balances
//     - the initial validator set (so a BFT chain has quorum at boot)
//
//   Both nodes load the SAME spec, run applyGenesisSpec on a fresh DB, and
//   end up with byte-identical genesis state.
//
// Design notes:
//   - The spec carries publicKeys, NOT private keys. Private keys live in
//     each operator's local keystore (ML-DSA account key, Ed25519 node key,
//     Ed25519 VRF key). A future CLI can generate the keypairs and emit
//     both the spec (shared) and per-operator key files (private).
//   - Balances are fixed-precision bigint strings ("100000" = 1000.00 points).
//     This matches what's already on the wire and avoids JSON's lack of
//     bigint support.
//   - Idempotent on a fresh DB. Re-running on a DB that already has a
//     genesis block is a no-op (schema-init guards prevent double-insert).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256, deriveAccountId } from '../core/crypto.js';
import { computeBlockHash } from '../core/block.js';
import { blockStore, getLatestBlock } from '../core/block.js';
import { accountStore } from '../core/account.js';
import { registerValidator, MIN_VALIDATOR_STAKE } from '../core/consensus/registration.js';
import type { Block, AccountType } from '../core/types.js';

export interface GenesisAccountSpec {
  /** ML-DSA-65 account signing key, hex-encoded. */
  publicKey: string;
  /** Account category. Only 'individual' accounts get daily allocations. */
  type: AccountType;
  /** 0–100 verification score. Set 100 for testnet bootstrap accounts. */
  percentHuman: number;
  /**
   * Initial earned balance, fixed-precision bigint as a base-10 string.
   * "100000" = 1000.00 points (PRECISION = 100). Must be >= stake when the
   * account is also a validator.
   */
  earnedBalance: string;
  /**
   * If present, this account is registered as a validator at genesis. The
   * stake is moved from earnedBalance to lockedBalance during apply.
   */
  validator?: GenesisValidatorSpec;
}

export interface GenesisValidatorSpec {
  /** Ed25519 P2P-layer publicKey, hex (32 bytes / 64 chars). */
  nodePublicKey: string;
  /** Ed25519 VRF publicKey, hex (32 bytes / 64 chars). */
  vrfPublicKey: string;
  /** Stake to lock, fixed-precision bigint string. >= MIN_VALIDATOR_STAKE. */
  stake: string;
}

export interface GenesisSpec {
  /** Schema version. Bump when the format changes incompatibly. */
  version: 2;
  /**
   * Human-readable network identifier — e.g. "ae-mainnet-1", "ae-testnet-1",
   * "ae-devnet-matt". Allows operators to confirm which network they're on
   * without computing a hash, and surfaces a clear error message ("you're on
   * mainnet, this peer is on testnet") at handshake time. Folded into the
   * spec hash so two networks with the same accounts but different IDs still
   * produce different chain genesis hashes. Lowercase alphanumeric + hyphens,
   * 3-32 chars.
   */
  networkId: string;
  /**
   * Unix-second timestamp written into the genesis block. Pinning this is
   * what makes the genesis hash agree across operators.
   */
  genesisTimestamp: number;
  /** Day number stored on the genesis block. Typically 0. */
  genesisDay: number;
  /** Accounts created at genesis. Non-empty for any usable network. */
  accounts: GenesisAccountSpec[];
}

/** Canonical regex for valid networkId values. */
export const NETWORK_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Stable, single-line digest of a GenesisSpec. Two operators can compare
 * these out-of-band ("text me your genesis hash") to confirm they're on
 * the same network before they try to peer. Independent of computation
 * order — the digest is computed over a canonicalized representation.
 */
export function genesisSpecHash(spec: GenesisSpec): string {
  // Canonical form: sort accounts by publicKey so the digest doesn't
  // depend on the spec author's ordering. Keys-of-objects must also be
  // emitted in a fixed order. networkId is folded in so two networks with
  // identical accounts but different IDs (mainnet vs testnet bootstrapped
  // from the same fixtures) still produce different genesis hashes.
  const sorted = [...spec.accounts].sort((a, b) =>
    a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0,
  );
  const canonical = {
    version: spec.version,
    networkId: spec.networkId,
    genesisTimestamp: spec.genesisTimestamp,
    genesisDay: spec.genesisDay,
    accounts: sorted.map((a) => ({
      publicKey: a.publicKey,
      type: a.type,
      percentHuman: a.percentHuman,
      earnedBalance: a.earnedBalance,
      validator: a.validator
        ? {
            nodePublicKey: a.validator.nodePublicKey,
            vrfPublicKey: a.validator.vrfPublicKey,
            stake: a.validator.stake,
          }
        : null,
    })),
  };
  return sha256(JSON.stringify(canonical));
}

// ─── Loading ────────────────────────────────────────────────────────────

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const VALID_TYPES: ReadonlySet<AccountType> = new Set([
  'individual',
  'company',
  'government',
  'ai_bot',
]);

/**
 * Read a genesis spec from disk and validate it. Throws with a specific
 * error message on any structural problem so a misconfigured network is
 * caught at boot, not at first peer handshake.
 */
export function loadGenesisSpec(path: string): GenesisSpec {
  const raw = readFileSync(resolve(path), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Genesis spec at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validateGenesisSpec(parsed);
}

/** Pure validator. Use this when the spec is already in memory (e.g. tests). */
export function validateGenesisSpec(parsed: unknown): GenesisSpec {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Genesis spec is not an object');
  }
  const s = parsed as Record<string, unknown>;
  if (s.version !== 2) {
    throw new Error(`Genesis spec version must be 2, got ${String(s.version)}`);
  }
  if (typeof s.networkId !== 'string' || !NETWORK_ID_REGEX.test(s.networkId)) {
    throw new Error(
      `networkId must be a lowercase alphanumeric+hyphen string of 3-32 chars (e.g. "ae-mainnet-1"), got ${JSON.stringify(s.networkId)}`,
    );
  }
  if (typeof s.genesisTimestamp !== 'number' || !Number.isInteger(s.genesisTimestamp) || s.genesisTimestamp <= 0) {
    throw new Error('genesisTimestamp must be a positive integer (unix seconds)');
  }
  if (typeof s.genesisDay !== 'number' || !Number.isInteger(s.genesisDay) || s.genesisDay < 0) {
    throw new Error('genesisDay must be a non-negative integer');
  }
  if (!Array.isArray(s.accounts) || s.accounts.length === 0) {
    throw new Error('accounts must be a non-empty array');
  }

  const seenPublicKeys = new Set<string>();
  const seenNodeKeys = new Set<string>();
  const seenVrfKeys = new Set<string>();
  const accounts: GenesisAccountSpec[] = [];

  for (let i = 0; i < s.accounts.length; i++) {
    const a = s.accounts[i] as Record<string, unknown>;
    if (typeof a.publicKey !== 'string' || a.publicKey.length === 0) {
      throw new Error(`accounts[${i}].publicKey must be a non-empty string`);
    }
    if (seenPublicKeys.has(a.publicKey)) {
      throw new Error(`duplicate publicKey in accounts: ${a.publicKey.slice(0, 16)}…`);
    }
    seenPublicKeys.add(a.publicKey);
    if (typeof a.type !== 'string' || !VALID_TYPES.has(a.type as AccountType)) {
      throw new Error(`accounts[${i}].type must be one of individual|company|government|ai_bot`);
    }
    if (typeof a.percentHuman !== 'number' || a.percentHuman < 0 || a.percentHuman > 100) {
      throw new Error(`accounts[${i}].percentHuman must be 0-100`);
    }
    if (typeof a.earnedBalance !== 'string') {
      throw new Error(`accounts[${i}].earnedBalance must be a string (bigint base-10)`);
    }
    let earned: bigint;
    try {
      earned = BigInt(a.earnedBalance);
    } catch {
      throw new Error(`accounts[${i}].earnedBalance is not a valid integer string`);
    }
    if (earned < 0n) {
      throw new Error(`accounts[${i}].earnedBalance must be non-negative`);
    }

    let validator: GenesisValidatorSpec | undefined;
    if (a.validator !== undefined && a.validator !== null) {
      const v = a.validator as Record<string, unknown>;
      if (typeof v.nodePublicKey !== 'string' || !HEX_64.test(v.nodePublicKey)) {
        throw new Error(`accounts[${i}].validator.nodePublicKey must be 64 hex chars`);
      }
      if (seenNodeKeys.has(v.nodePublicKey)) {
        throw new Error(`duplicate nodePublicKey in validators: ${v.nodePublicKey.slice(0, 16)}…`);
      }
      seenNodeKeys.add(v.nodePublicKey);
      if (typeof v.vrfPublicKey !== 'string' || !HEX_64.test(v.vrfPublicKey)) {
        throw new Error(`accounts[${i}].validator.vrfPublicKey must be 64 hex chars`);
      }
      if (seenVrfKeys.has(v.vrfPublicKey)) {
        throw new Error(`duplicate vrfPublicKey in validators: ${v.vrfPublicKey.slice(0, 16)}…`);
      }
      seenVrfKeys.add(v.vrfPublicKey);
      if (typeof v.stake !== 'string') {
        throw new Error(`accounts[${i}].validator.stake must be a string (bigint base-10)`);
      }
      let stake: bigint;
      try {
        stake = BigInt(v.stake);
      } catch {
        throw new Error(`accounts[${i}].validator.stake is not a valid integer string`);
      }
      if (stake < MIN_VALIDATOR_STAKE) {
        throw new Error(
          `accounts[${i}].validator.stake ${stake} below MIN_VALIDATOR_STAKE ${MIN_VALIDATOR_STAKE}`,
        );
      }
      if (stake > earned) {
        throw new Error(
          `accounts[${i}].validator.stake ${stake} exceeds earnedBalance ${earned}`,
        );
      }
      validator = {
        nodePublicKey: v.nodePublicKey,
        vrfPublicKey: v.vrfPublicKey,
        stake: v.stake,
      };
    }

    accounts.push({
      publicKey: a.publicKey,
      type: a.type as AccountType,
      percentHuman: a.percentHuman,
      earnedBalance: a.earnedBalance,
      validator,
    });
  }

  return {
    version: 2,
    networkId: s.networkId,
    genesisTimestamp: s.genesisTimestamp,
    genesisDay: s.genesisDay,
    accounts,
  };
}

// ─── Application ────────────────────────────────────────────────────────

/**
 * Apply a GenesisSpec to a fresh database. Idempotent: if the genesis
 * block already exists (from a prior boot), this is a no-op and the
 * existing block is returned.
 *
 * Application order:
 *   1. Insert the deterministic genesis block (timestamp from spec → hash
 *      is reproducible across operators).
 *   2. Insert every account row directly via the store, using the spec's
 *      genesisTimestamp as createdAt so two operators get byte-identical
 *      account rows.
 *   3. Register validators via the existing registerValidator function,
 *      passing now=genesisTimestamp so the audit log + registered_at
 *      column also stay deterministic.
 *
 * The schema's `day_cycle_state` row is left at its default (current_day=1,
 * cycle_phase='idle') — initializeSchema already inserts that. Operators
 * who want a different starting day should call `setNextCycleAt` after
 * apply, which is a separate concern from genesis.
 */
export function applyGenesisSpec(db: DatabaseSync, spec: GenesisSpec): Block {
  const existing = getLatestBlock(db);
  if (existing) {
    // Already applied. Return the existing block; do NOT reapply (would
    // double-create accounts and validators). Caller can compare
    // existing.hash against an expected hash to detect a network mismatch.
    return existing;
  }

  // 1. Genesis block. Mirror the structure of createGenesisBlockWithStore
  // but with a fixed timestamp and day from the spec.
  const genesis: Block = {
    number: 0,
    day: spec.genesisDay,
    timestamp: spec.genesisTimestamp,
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
  blockStore(db).insert(genesis, /* isGenesis */ true);

  // 2. Accounts. Direct store.insert with deterministic createdAt + balance.
  const aStore = accountStore(db);
  for (const a of spec.accounts) {
    const id = deriveAccountId(a.publicKey);
    if (aStore.findById(id)) {
      // Defensive: if a partial prior apply somehow left accounts in
      // place but no genesis block, skip the duplicate insert.
      continue;
    }
    aStore.insert({
      id,
      publicKey: a.publicKey,
      type: a.type,
      percentHuman: a.percentHuman,
      joinedDay: spec.genesisDay,
      createdAt: spec.genesisTimestamp,
    });
    aStore.updateBalance(id, 'earned_balance', BigInt(a.earnedBalance));
  }

  // 3. Validators. registerValidator handles the earned->locked transfer
  // + audit log. Pass now=genesisTimestamp so timestamps stay deterministic.
  for (const a of spec.accounts) {
    if (!a.validator) continue;
    const id = deriveAccountId(a.publicKey);
    registerValidator(db, {
      accountId: id,
      nodePublicKey: a.validator.nodePublicKey,
      vrfPublicKey: a.validator.vrfPublicKey,
      stake: BigInt(a.validator.stake),
      now: spec.genesisTimestamp,
    });
  }

  return genesis;
}
