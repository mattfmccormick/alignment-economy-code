#!/usr/bin/env node
/**
 * Validator self-onboarding CLI.
 *
 * Generates a fresh validator identity (account ML-DSA-65 keypair, P2P
 * Ed25519 keypair, VRF Ed25519 keypair) and writes them as a single
 * keystore file plus a runner config pointing at it. After running this,
 * the operator has everything needed to boot a node that talks to an
 * existing AE network.
 *
 * What this CLI does NOT do (yet — Phase E):
 *   - Fetch the genesis spec from a seed node automatically.
 *   - Sign and submit the on-chain validator/register transaction. That
 *     still needs to be done via API once the node is running and the
 *     account has enough Earned points to stake.
 *
 * Usage:
 *
 *   npm run validator:setup -- \
 *     --network-id ae-mainnet-1 \
 *     --output ./my-validator \
 *     [--name alice] \
 *     [--api-port 3000] \
 *     [--p2p-port 9000] \
 *     [--seed seed1.ae.org:9000,seed2.ae.org:9000]
 *
 * On success the script prints:
 *   - The new accountId (publicly shareable)
 *   - The keystore + config paths
 *   - Next-step instructions: download genesis.json, fund the account,
 *     boot the node, file the validator/register transaction.
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateKeyPair, deriveAccountId } from '../core/crypto.js';
import { generateNodeIdentity } from '../network/node-identity.js';
import { Ed25519VrfProvider } from '../core/consensus/Ed25519VrfProvider.js';
import { NETWORK_ID_REGEX } from '../node/genesis-config.js';

interface ParsedArgs {
  networkId: string;
  output: string;
  name: string;
  apiPort: number;
  p2pPort: number;
  seedNodes: Array<{ host: string; port: number }>;
}

function usage(): never {
  console.error(`Usage: npm run validator:setup -- --network-id <id> --output <dir> [options]

Options:
  --network-id <id>          REQUIRED. Network identifier of the chain you're joining.
                             Lowercase alphanumeric+hyphen, 3-32 chars.
                             Examples: ae-mainnet-1, ae-testnet-1.
  --output, -o <dir>         REQUIRED. Output directory for keystore + config.
  --name <label>             Friendly label written into the keystore. Default: "validator".
  --api-port <port>          Local HTTP API port. Default 3000.
  --p2p-port <port>          P2P listening port (must be reachable for inbound peers). Default 9000.
  --seed <h1:p1,h2:p2,...>   Comma-separated initial peers to dial. Required for a real network.
  --help, -h                 Show this message.
`);
  process.exit(1);
}

function parseSeedNodes(input: string): Array<{ host: string; port: number }> {
  const out: Array<{ host: string; port: number }> = [];
  for (const entry of input.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [host, portStr] = trimmed.split(':');
    if (!host || !portStr) {
      console.error(`Bad seed entry "${trimmed}" — expected host:port`);
      usage();
    }
    const port = parseInt(portStr, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`Bad port in seed entry "${trimmed}"`);
      usage();
    }
    out.push({ host, port });
  }
  return out;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<ParsedArgs> = { name: 'validator', apiPort: 3000, p2pPort: 9000, seedNodes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--network-id':
        out.networkId = next; i++; break;
      case '--output':
      case '-o':
        out.output = next; i++; break;
      case '--name':
        out.name = next; i++; break;
      case '--api-port':
        out.apiPort = parseInt(next, 10); i++; break;
      case '--p2p-port':
        out.p2pPort = parseInt(next, 10); i++; break;
      case '--seed':
        out.seedNodes = parseSeedNodes(next); i++; break;
      case '--help':
      case '-h':
        usage();
      default:
        console.error(`Unknown flag: ${a}`);
        usage();
    }
  }
  if (!out.networkId) { console.error('--network-id is required'); usage(); }
  if (!NETWORK_ID_REGEX.test(out.networkId)) {
    console.error(`--network-id must match ${NETWORK_ID_REGEX} (lowercase alphanumeric+hyphen, 3-32 chars)`);
    usage();
  }
  if (!out.output) { console.error('--output is required'); usage(); }
  return {
    networkId: out.networkId,
    output: out.output,
    name: out.name!,
    apiPort: out.apiPort!,
    p2pPort: out.p2pPort!,
    seedNodes: out.seedNodes!,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const outputDir = resolve(args.output);
  if (existsSync(outputDir)) {
    console.warn(`[warn] output directory already exists: ${outputDir}`);
    console.warn('       refusing to overwrite — pick a fresh directory or remove this one.');
    process.exit(1);
  }
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'data'), { recursive: true });

  // Generate the three keypairs an AE validator needs.
  const account = generateKeyPair();        // ML-DSA-65 — signs txs
  const nodeKey = generateNodeIdentity();   // Ed25519  — P2P identity
  const vrfKey = Ed25519VrfProvider.generateKeyPair(); // Ed25519 — VRF for proposer selection
  const accountId = deriveAccountId(account.publicKey);

  // Keystore matches the shape used by ValidatorKeystore in genesis-init.ts
  // so existing tooling (loadOrCreateNodeIdentity, etc.) reads it directly.
  const keystorePath = join(outputDir, 'keystore.json');
  const keystore = {
    publicKey: nodeKey.publicKey,
    secretKey: nodeKey.secretKey,
    name: args.name,
    accountId,
    account: { publicKey: account.publicKey, privateKey: account.privateKey },
    vrf: { publicKey: vrfKey.publicKey, secretKey: vrfKey.secretKey },
    networkId: args.networkId,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(keystorePath, JSON.stringify(keystore, null, 2), { mode: 0o600 });

  // Runner config pointing at the keystore + sensible defaults for joining
  // an existing network.
  const dbPath = join(outputDir, 'data', 'ae-node.db');
  const configPath = join(outputDir, 'node-config.json');
  const config = {
    nodeId: accountId,
    bftLocalAccountId: accountId,
    consensusMode: 'bft',
    apiPort: args.apiPort,
    p2pPort: args.p2pPort,
    apiHost: '0.0.0.0',
    p2pHost: '0.0.0.0',
    dbPath,
    nodeKeyPath: keystorePath,
    genesisConfigPath: join(outputDir, 'genesis.json'),
    seedNodes: args.seedNodes,
    maxPeers: 20,
    dayCycleIntervalMs: 86400000,
    blockIntervalMs: 10000,
    logLevel: 'info',
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('');
  console.log('=== AE validator identity generated ===');
  console.log('');
  console.log(`Network:       ${args.networkId}`);
  console.log(`Account ID:    ${accountId}`);
  console.log(`Node pubkey:   ${nodeKey.publicKey.slice(0, 16)}…`);
  console.log(`VRF pubkey:    ${vrfKey.publicKey.slice(0, 16)}…`);
  console.log('');
  console.log(`Keystore:      ${keystorePath}  (mode 0600 — keep private)`);
  console.log(`Config:        ${configPath}`);
  console.log(`DB will live:  ${dbPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('');
  console.log(`  1. Get genesis.json for "${args.networkId}" from an existing operator and place it at:`);
  console.log(`       ${join(outputDir, 'genesis.json')}`);
  console.log('     (Without it the node will boot a private chain instead of joining.)');
  console.log('');
  console.log('  2. Boot the node:');
  console.log(`       AE_CONFIG_FILE=${configPath} npm run dev   # from ae-node/`);
  console.log('');
  console.log('  3. Earn the minimum validator stake (or have someone send you Earned points).');
  console.log('     Validator registration requires earnedBalance >= MIN_VALIDATOR_STAKE.');
  console.log('');
  console.log('  4. Submit a signed validator/register transaction via the API to enter the');
  console.log('     active validator set. Until then your node syncs the chain but does not');
  console.log('     produce blocks.');
  console.log('');
  console.log('NEVER share keystore.json. The node key controls your validator identity; the');
  console.log('account key controls your funds. Loss = lose access. Disclosure = lose stake.');
  console.log('');
}

main();
