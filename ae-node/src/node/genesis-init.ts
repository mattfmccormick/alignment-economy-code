// Genesis-set generator.
//
// Produces (genesis spec + per-operator keystores) for a fresh AE
// network. The spec is the public artifact every operator loads at
// boot (Session 41); the keystores are private to each operator and
// hold all the secret material for a single validator.
//
// Why this is split from the CLI in src/scripts/init-genesis.ts:
//
//   - Pure functions are testable. `buildGenesisSet(opts)` returns
//     {spec, keystores} from inputs without touching disk; phase48
//     tests run thousands of variations to prove every keystore
//     matches its spec entry.
//   - `writeGenesisSet(outputDir, set)` is the only side-effecting
//     piece. Tested separately with mkdtemp directories.
//   - The CLI parses argv and calls both. That layer is just plumbing.
//
// Output layout:
//
//   <outputDir>/genesis.json                — shared spec, sent to every operator
//   <outputDir>/keys/<accountId>.json       — one per validator, PRIVATE
//
// The keystore format mirrors NodeIdentity for the node key but adds
// the account and VRF keys + a friendly `name` field. Keystores are
// written with mode 0600 on POSIX (Windows ignores the mode flag, but
// the file is created in the user's home dir by default so it's still
// not world-readable in practice).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, deriveAccountId } from '../core/crypto.js';
import { generateNodeIdentity } from '../network/node-identity.js';
import { Ed25519VrfProvider } from '../core/consensus/Ed25519VrfProvider.js';
import { MIN_VALIDATOR_STAKE } from '../core/consensus/registration.js';
import { PRECISION } from '../core/constants.js';
import { NETWORK_ID_REGEX, type GenesisSpec, type GenesisAccountSpec } from './genesis-config.js';

/**
 * One operator's complete secret material for a single validator. Each
 * file is written with mode 0o600 and should never leave the operator's
 * machine. Loading the keystore restores the account+node+VRF identities
 * needed to participate in consensus and sign transactions.
 *
 * The Ed25519 P2P-layer keys sit at the JSON top level so
 * `loadOrCreateNodeIdentity(path)` can read this same file directly —
 * NodeIdentity's `{publicKey, secretKey}` shape is a strict subset of
 * the keystore. The runner reads it once for AE_NODE_KEY_PATH; the
 * rest of the fields (account, vrf, name, accountId) are ignored by
 * that loader but available for other tooling.
 */
export interface ValidatorKeystore {
  /** Ed25519 P2P-layer publicKey, hex. Top-level so NodeIdentity loaders work directly. */
  publicKey: string;
  /** Ed25519 P2P-layer secretKey, hex. Top-level so NodeIdentity loaders work directly. */
  secretKey: string;
  /** Friendly label set by the CLI (e.g., "validator-1", "matt"). */
  name: string;
  /** Derived account id (first 20 bytes of SHA-256(accountPublicKey), hex). */
  accountId: string;
  /** ML-DSA-65 keys for signing transactions. */
  account: { publicKey: string; privateKey: string };
  /** Ed25519 VRF keys. Used by proposer selection / lottery. */
  vrf: { publicKey: string; secretKey: string };
}

export interface BuildGenesisSetOptions {
  /**
   * Human-readable network identifier baked into the spec and the genesis
   * hash. Required — there is no sensible default. Must match
   * NETWORK_ID_REGEX (lowercase alphanumeric+hyphen, 3-32 chars). Examples:
   * "ae-mainnet-1", "ae-testnet-2026", "ae-devnet-matt".
   */
  networkId: string;
  /** Number of validators to seed. Default 2 (Matt + wife). */
  validatorCount?: number;
  /** Unix-second timestamp baked into the spec. Default = Math.floor(Date.now() / 1000). */
  genesisTimestamp?: number;
  /** Day number stamped on the genesis block. Default 0. */
  genesisDay?: number;
  /**
   * Initial earned balance per validator in DISPLAY units. Default 500
   * (= 50,000 fixed-precision). Must be >= stakeDisplay so the validator
   * registration math works.
   */
  initialEarnedDisplay?: number;
  /**
   * Stake locked per validator in DISPLAY units. Default 200. Must be
   * >= MIN_VALIDATOR_STAKE / PRECISION (1.00 in display units, currently).
   */
  stakeDisplay?: number;
  /**
   * Optional human-readable names per validator (e.g. ["alice", "bob"]).
   * Used in the keystore filename hint and friendly logs. Default
   * ["validator-1", "validator-2", ...].
   */
  names?: string[];
}

export interface BuildGenesisSetResult {
  spec: GenesisSpec;
  keystores: ValidatorKeystore[];
}

const DEFAULT_INITIAL_EARNED_DISPLAY = 500;
const DEFAULT_STAKE_DISPLAY = 200;
const DEFAULT_VALIDATOR_COUNT = 2;
const DEFAULT_GENESIS_DAY = 0;

function displayToFixedString(display: number): string {
  // PRECISION = 100_000_000n — one point of display value = 10^8 base
  // units. Using `display * 100` would silently shrink stakes by 10^6
  // and break every downstream calculation.
  return BigInt(Math.round(display * Number(PRECISION))).toString();
}

/**
 * Generate a fresh validator set: one account/node/VRF triple per
 * validator. Pure function over crypto random — calling twice produces
 * different keys.
 */
export function buildGenesisSet(opts: BuildGenesisSetOptions): BuildGenesisSetResult {
  if (!opts || typeof opts.networkId !== 'string' || !NETWORK_ID_REGEX.test(opts.networkId)) {
    throw new Error(
      `buildGenesisSet: networkId is required and must match ${NETWORK_ID_REGEX} (e.g. "ae-mainnet-1")`,
    );
  }
  const validatorCount = opts.validatorCount ?? DEFAULT_VALIDATOR_COUNT;
  if (!Number.isInteger(validatorCount) || validatorCount < 1) {
    throw new Error(`validatorCount must be a positive integer, got ${validatorCount}`);
  }
  const initialEarnedDisplay = opts.initialEarnedDisplay ?? DEFAULT_INITIAL_EARNED_DISPLAY;
  const stakeDisplay = opts.stakeDisplay ?? DEFAULT_STAKE_DISPLAY;
  if (initialEarnedDisplay <= 0) {
    throw new Error(`initialEarnedDisplay must be positive, got ${initialEarnedDisplay}`);
  }
  if (stakeDisplay <= 0) {
    throw new Error(`stakeDisplay must be positive, got ${stakeDisplay}`);
  }
  if (stakeDisplay > initialEarnedDisplay) {
    throw new Error(
      `stakeDisplay ${stakeDisplay} cannot exceed initialEarnedDisplay ${initialEarnedDisplay}`,
    );
  }
  const stakeFixed = BigInt(Math.round(stakeDisplay * Number(PRECISION)));
  if (stakeFixed < MIN_VALIDATOR_STAKE) {
    throw new Error(
      `stakeDisplay ${stakeDisplay} converts to ${stakeFixed}, below MIN_VALIDATOR_STAKE ${MIN_VALIDATOR_STAKE}`,
    );
  }

  const names = opts.names ?? Array.from({ length: validatorCount }, (_, i) => `validator-${i + 1}`);
  if (names.length !== validatorCount) {
    throw new Error(
      `names array length ${names.length} must match validatorCount ${validatorCount}`,
    );
  }
  const seenNames = new Set<string>();
  for (const n of names) {
    if (!n || typeof n !== 'string') throw new Error(`invalid name: ${n}`);
    if (seenNames.has(n)) throw new Error(`duplicate name: ${n}`);
    seenNames.add(n);
  }

  const genesisTimestamp = opts.genesisTimestamp ?? Math.floor(Date.now() / 1000);
  const genesisDay = opts.genesisDay ?? DEFAULT_GENESIS_DAY;

  const accounts: GenesisAccountSpec[] = [];
  const keystores: ValidatorKeystore[] = [];

  for (let i = 0; i < validatorCount; i++) {
    const account = generateKeyPair(); // ML-DSA-65
    const node = generateNodeIdentity(); // Ed25519 P2P
    const vrf = Ed25519VrfProvider.generateKeyPair(); // Ed25519 VRF
    const accountId = deriveAccountId(account.publicKey);

    accounts.push({
      publicKey: account.publicKey,
      type: 'individual',
      percentHuman: 100,
      earnedBalance: displayToFixedString(initialEarnedDisplay),
      validator: {
        nodePublicKey: node.publicKey,
        vrfPublicKey: vrf.publicKey,
        stake: displayToFixedString(stakeDisplay),
      },
    });

    keystores.push({
      publicKey: node.publicKey,
      secretKey: node.secretKey,
      name: names[i],
      accountId,
      account,
      vrf,
    });
  }

  const spec: GenesisSpec = {
    version: 2,
    networkId: opts.networkId,
    genesisTimestamp,
    genesisDay,
    accounts,
  };

  return { spec, keystores };
}

/**
 * Persist a generated set to disk. Layout:
 *
 *   <outputDir>/genesis.json
 *   <outputDir>/keys/<accountId>.json   (mode 0o600)
 *
 * Returns the paths so the CLI can print them. Throws if outputDir
 * already exists with conflicting files; safe on a fresh empty dir.
 */
export function writeGenesisSet(
  outputDir: string,
  set: BuildGenesisSetResult,
): { specPath: string; keystorePaths: string[] } {
  mkdirSync(outputDir, { recursive: true });
  const keysDir = join(outputDir, 'keys');
  mkdirSync(keysDir, { recursive: true });

  const specPath = join(outputDir, 'genesis.json');
  writeFileSync(specPath, JSON.stringify(set.spec, null, 2), { mode: 0o644 });

  const keystorePaths: string[] = [];
  for (const ks of set.keystores) {
    const path = join(keysDir, `${ks.accountId}.json`);
    writeFileSync(path, JSON.stringify(ks, null, 2), { mode: 0o600 });
    keystorePaths.push(path);
  }

  return { specPath, keystorePaths };
}
