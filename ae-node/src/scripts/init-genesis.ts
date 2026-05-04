#!/usr/bin/env node
/**
 * Generate a fresh AE genesis set.
 *
 * Produces:
 *   <output>/genesis.json          — the shared spec, send to every operator
 *   <output>/keys/<accountId>.json — one private keystore per validator
 *
 * Each keystore holds the secret material (ML-DSA account + Ed25519 node +
 * Ed25519 VRF keys) for ONE operator. Distribute one keystore privately to
 * each operator, share genesis.json publicly.
 *
 * Usage:
 *
 *   npm run genesis:init -- --output ./testnet
 *
 *   npm run genesis:init -- \
 *     --validators 2 \
 *     --names alice,bob \
 *     --output ./testnet \
 *     --initial-earned 500 \
 *     --stake 200
 *
 * On a successful run the CLI prints the genesis spec hash so operators
 * can confirm out-of-band ("text me your genesis hash") that they all
 * loaded the same file before they try to peer.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildGenesisSet, writeGenesisSet } from '../node/genesis-init.js';
import { genesisSpecHash } from '../node/genesis-config.js';

interface ParsedArgs {
  output: string;
  networkId: string;
  validators: number;
  names?: string[];
  initialEarned: number;
  stake: number;
  genesisTimestamp?: number;
}

function usage(): never {
  console.error(`Usage: npm run genesis:init -- --output <dir> --network-id <id> [options]

Options:
  --output, -o <dir>           Output directory (REQUIRED).
  --network-id <id>            Human-readable network identifier (REQUIRED).
                               Lowercase alphanumeric+hyphen, 3-32 chars.
                               Examples: ae-mainnet-1, ae-testnet-1, ae-devnet-matt.
  --validators, -n <count>     Number of validators. Default 2.
  --names <a,b,...>            Comma-separated friendly names. Default validator-1,validator-2,...
  --initial-earned <pts>       Initial earned balance per validator in display units. Default 500.
  --stake <pts>                Stake per validator in display units. Default 200.
  --genesis-timestamp <unix>   Pin a specific genesis unix timestamp. Default = now.
  --help, -h                   Show this message.
`);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<ParsedArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--output':
      case '-o':
        out.output = next;
        i++;
        break;
      case '--network-id':
        out.networkId = next;
        i++;
        break;
      case '--validators':
      case '-n':
        out.validators = parseInt(next, 10);
        i++;
        break;
      case '--names':
        out.names = next.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        i++;
        break;
      case '--initial-earned':
        out.initialEarned = parseFloat(next);
        i++;
        break;
      case '--stake':
        out.stake = parseFloat(next);
        i++;
        break;
      case '--genesis-timestamp':
        out.genesisTimestamp = parseInt(next, 10);
        i++;
        break;
      case '--help':
      case '-h':
        usage();
      default:
        console.error(`Unknown flag: ${a}`);
        usage();
    }
  }
  if (!out.output) {
    console.error('--output is required');
    usage();
  }
  if (!out.networkId) {
    console.error('--network-id is required');
    usage();
  }
  return {
    output: out.output,
    networkId: out.networkId,
    validators: out.validators ?? 2,
    names: out.names,
    initialEarned: out.initialEarned ?? 500,
    stake: out.stake ?? 200,
    genesisTimestamp: out.genesisTimestamp,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const outputDir = resolve(args.output);
  if (existsSync(outputDir)) {
    console.warn(
      `[warn] output directory already exists: ${outputDir}\n` +
        `      existing files will be overwritten by this run.`,
    );
  }

  const set = buildGenesisSet({
    networkId: args.networkId,
    validatorCount: args.validators,
    names: args.names,
    initialEarnedDisplay: args.initialEarned,
    stakeDisplay: args.stake,
    genesisTimestamp: args.genesisTimestamp,
  });

  const { specPath, keystorePaths } = writeGenesisSet(outputDir, set);
  const specHash = genesisSpecHash(set.spec);

  console.log('');
  console.log('=== AE genesis generated ===');
  console.log('');
  console.log(`Network:     ${args.networkId}`);
  console.log(`Spec:        ${specPath}`);
  console.log(`Spec hash:   ${specHash}`);
  console.log(`Validators:  ${set.keystores.length}`);
  console.log('');
  for (const ks of set.keystores) {
    const path = keystorePaths.find((p) => p.endsWith(`${ks.accountId}.json`))!;
    console.log(`  [${ks.name}]`);
    console.log(`    accountId:    ${ks.accountId}`);
    console.log(`    nodePubKey:   ${ks.publicKey.slice(0, 16)}…`);
    console.log(`    keystore:     ${path}`);
  }
  console.log('');
  console.log('Distribution:');
  console.log(`  - Send the spec file (${specPath}) to every operator. Public.`);
  console.log(`  - Send each keystore to its named operator ONLY. PRIVATE — never share.`);
  console.log('');
  console.log('Each operator boots their node with:');
  console.log('  AE_GENESIS_CONFIG_PATH=<path/to/genesis.json>');
  console.log('  AE_NODE_KEY_PATH=<path/to/keys/<accountId>.json>');
  console.log('  AE_BFT_LOCAL_ACCOUNT_ID=<accountId>');
  console.log('  AE_NODE_ID=<accountId>');
  console.log('  AE_CONSENSUS_MODE=bft');
  console.log('');
  console.log('All operators must compare spec hashes out-of-band before trying to peer.');
  console.log('');
}

main();
