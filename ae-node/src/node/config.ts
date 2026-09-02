import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * When a transaction's effect on balances happens.
 *
 * 'receipt' — the historical behaviour. Balances move the moment the API or
 * gossip accepts a transaction; the block that later contains it merely records
 * that it happened.
 *
 * 'commit' — balances move only when the block carrying the transaction
 * commits.
 *
 * 'receipt' has a double-spend vector, and it is not subtle. Submit two
 * conflicting spends to two different validators simultaneously and each
 * accepts the one it saw first, because each is individually valid against the
 * state that node held. The nodes now disagree about the sender's balance, and
 * the first block containing both is unappliable on both of them. State becomes
 * a function of message arrival order instead of the chain — which also means
 * no state root can ever be enforced, because honest nodes legitimately differ.
 *
 * 'commit' fixes that: ordering is decided once, by consensus, and every node
 * applies the same sequence.
 *
 * MUST BE IDENTICAL ON EVERY NODE OF A NETWORK. Mixing modes means half the
 * validators have applied a transaction the other half have not, which is the
 * divergence this is meant to remove.
 */
export type ExecutionMode = 'receipt' | 'commit';

export interface AENodeConfig {
  // Node identity
  nodeId: string;
  authorityNodeId: string;

  /**
   * When transaction effects are applied. See ExecutionMode. Defaults to
   * 'commit'; set AE_EXECUTION_MODE=receipt to get the legacy behaviour.
   */
  executionMode: ExecutionMode;

  // Network
  apiPort: number;
  p2pPort: number;
  apiHost: string;
  p2pHost: string;

  // Database
  dbPath: string;

  // P2P node identity (Ed25519 keypair). Defaults to node-key.json next to the DB.
  nodeKeyPath?: string;

  /**
   * Path to a JSON GenesisSpec (see src/node/genesis-config.ts). When set
   * AND the local DB has no genesis block yet, the runner applies the
   * spec to seed the deterministic genesis state shared across operators.
   * When unset, falls back to the legacy createGenesisBlock() path
   * (random-timestamp single-node testing). Required for any multi-
   * operator network — without it, two nodes will generate different
   * genesis hashes and reject each other at handshake.
   */
  genesisConfigPath?: string;

  /**
   * Hex Ed25519 public key of the network's authority. Followers REQUIRE this
   * to validate incoming blocks at the cryptographic-identity level (not just
   * the spoofable nodeId string). The authority itself doesn't need to set
   * this in config — it learns its own publicKey at boot and self-binds.
   */
  authorityPublicKey?: string;

  /**
   * Consensus mode. Default 'authority' (Phase 1 single-authority chain).
   * 'bft' switches in BFTConsensus + spawns a BftBlockProducer that drives
   * propose/prevote/precommit rounds. The validator set is read from the
   * `validators` table; bftLocalAccountId names this node's row in it.
   */
  consensusMode?: 'authority' | 'bft';

  /**
   * Required when consensusMode === 'bft'. The accountId this validator
   * is registered under. Must match a row in the validators table whose
   * node_public_key equals the local node-identity public key.
   */
  bftLocalAccountId?: string;

  /**
   * Session 54: delay BFT first round start by this many ms after the
   * runner finishes startup. Lets peer connections settle before round
   * 0 fires, preventing the early-startup desync where one runner
   * races through round 0 alone (broadcasting to zero peers) while
   * the other is still connecting. Without the delay,
   * RoundController's drop-on-round-mismatch leaves the validators
   * permanently out of sync.
   *
   * Default 2000ms — generous enough for local testing and for real
   * deployments. Set 0 if peers are guaranteed to be connected before
   * BFT starts (rare).
   */
  bftStartupDelayMs?: number;

  // P2P
  seedNodes: Array<{ host: string; port: number }>;
  maxPeers: number;

  // Day cycle
  dayCycleIntervalMs: number; // how often to run the day cycle (default: 86400000 = 24h)

  // Block production
  /**
   * Minimum gap between blocks, in ms. Default 10s.
   *
   * Applies to BOTH consensus modes. It previously paced only the legacy
   * Authority path, so a BFT chain ignored it entirely and produced blocks as
   * fast as rounds completed — about every 2.7 seconds, whether or not anything
   * had happened. A real chain reached 30,932 blocks carrying 4 transactions.
   *
   * That is a joinability problem more than a disk one: a new node replays every
   * block, so if sync is slower than production, a node that falls behind can
   * never catch up, and the threshold tightens as the chain grows.
   *
   * EVERY VALIDATOR ON A NETWORK MUST USE THE SAME VALUE — see
   * BftDriverConfig.blockIntervalMs for why mismatched pacing desynchronises
   * rounds.
   */
  blockIntervalMs: number;

  // SSL
  sslCert?: string;
  sslKey?: string;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_CONFIG: AENodeConfig = {
  nodeId: '',
  authorityNodeId: '',
  executionMode: 'commit',
  apiPort: 3000,
  p2pPort: 9000,
  apiHost: '0.0.0.0',
  p2pHost: '0.0.0.0',
  dbPath: './data/ae-node.db',
  seedNodes: [],
  maxPeers: 20,
  dayCycleIntervalMs: 86_400_000,
  blockIntervalMs: 10_000,
  logLevel: 'info',
};

/** Parse seed nodes from comma-separated string: "host1:port1,host2:port2" */
function parseSeedNodes(str: string): Array<{ host: string; port: number }> {
  if (!str.trim()) return [];
  return str.split(',').map((s) => {
    const [host, portStr] = s.trim().split(':');
    return { host, port: parseInt(portStr, 10) };
  });
}

/** Load config from environment variables, config file, or defaults */
export function loadConfig(configPath?: string): AENodeConfig {
  let fileConfig: Partial<AENodeConfig> = {};

  // Try loading config file
  const path = configPath ?? process.env.AE_CONFIG_FILE;
  if (path && existsSync(path)) {
    const raw = readFileSync(resolve(path), 'utf-8');
    fileConfig = JSON.parse(raw);
  }

  // Environment variables override file config
  const config: AENodeConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    nodeId: process.env.AE_NODE_ID ?? fileConfig.nodeId ?? DEFAULT_CONFIG.nodeId,
    executionMode:
      (process.env.AE_EXECUTION_MODE as ExecutionMode | undefined) ??
      fileConfig.executionMode ??
      DEFAULT_CONFIG.executionMode,
    authorityNodeId: process.env.AE_AUTHORITY_NODE_ID ?? fileConfig.authorityNodeId ?? DEFAULT_CONFIG.authorityNodeId,
    apiPort: (parseInt(process.env.AE_API_PORT ?? '', 10) || 0) || (fileConfig.apiPort ?? DEFAULT_CONFIG.apiPort),
    p2pPort: (parseInt(process.env.AE_P2P_PORT ?? '', 10) || 0) || (fileConfig.p2pPort ?? DEFAULT_CONFIG.p2pPort),
    apiHost: process.env.AE_API_HOST ?? fileConfig.apiHost ?? DEFAULT_CONFIG.apiHost,
    p2pHost: process.env.AE_P2P_HOST ?? fileConfig.p2pHost ?? DEFAULT_CONFIG.p2pHost,
    dbPath: process.env.AE_DB_PATH ?? fileConfig.dbPath ?? DEFAULT_CONFIG.dbPath,
    nodeKeyPath: process.env.AE_NODE_KEY_PATH ?? fileConfig.nodeKeyPath,
    genesisConfigPath: process.env.AE_GENESIS_CONFIG_PATH ?? fileConfig.genesisConfigPath,
    authorityPublicKey: process.env.AE_AUTHORITY_PUBLIC_KEY ?? fileConfig.authorityPublicKey,
    consensusMode:
      (process.env.AE_CONSENSUS_MODE as AENodeConfig['consensusMode']) ??
      fileConfig.consensusMode,
    bftLocalAccountId: process.env.AE_BFT_LOCAL_ACCOUNT_ID ?? fileConfig.bftLocalAccountId,
    bftStartupDelayMs: process.env.AE_BFT_STARTUP_DELAY_MS
      ? parseInt(process.env.AE_BFT_STARTUP_DELAY_MS, 10)
      : fileConfig.bftStartupDelayMs,
    seedNodes: process.env.AE_SEED_NODES
      ? parseSeedNodes(process.env.AE_SEED_NODES)
      : (fileConfig.seedNodes ?? DEFAULT_CONFIG.seedNodes),
    maxPeers: (parseInt(process.env.AE_MAX_PEERS ?? '', 10) || 0) || (fileConfig.maxPeers ?? DEFAULT_CONFIG.maxPeers),
    dayCycleIntervalMs: (parseInt(process.env.AE_DAY_CYCLE_MS ?? '', 10) || 0) || (fileConfig.dayCycleIntervalMs ?? DEFAULT_CONFIG.dayCycleIntervalMs),
    blockIntervalMs: (parseInt(process.env.AE_BLOCK_INTERVAL_MS ?? '', 10) || 0) || (fileConfig.blockIntervalMs ?? DEFAULT_CONFIG.blockIntervalMs),
    sslCert: process.env.AE_SSL_CERT ?? fileConfig.sslCert,
    sslKey: process.env.AE_SSL_KEY ?? fileConfig.sslKey,
    logLevel: (process.env.AE_LOG_LEVEL as AENodeConfig['logLevel']) ?? fileConfig.logLevel ?? DEFAULT_CONFIG.logLevel,
  };

  return config;
}
