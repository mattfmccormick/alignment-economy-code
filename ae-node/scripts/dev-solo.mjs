#!/usr/bin/env node
// One command for a local chain where everything works:
//
//   npm run dev:solo
//
// Why this exists. Plain `npm run dev` starts the legacy single-authority
// block producer. That producer only makes a block when a payment is waiting,
// never applies the payment under the default commit-time execution, and never
// looks at the chain-ordered operation queues. So on a plain dev node a payment
// stays "pending" forever, and miner registration, vouching, verification
// panels, products, spaces and tags are accepted and then sit in a queue that
// nothing drains. Every one of those is consensus state now and only the BFT
// block producer applies it.
//
// A one-validator BFT chain is the real thing at its smallest: same producer,
// same apply path, same day cycle as a 50-validator network, a quorum of one.
// This script creates that network the first time it runs and starts it.
//
// Created on first run, all git-ignored, all private to this machine:
//   testnet/solo-dev/genesis.json        the network spec (one validator)
//   testnet/solo-dev/keys/<id>.json      that validator's keystore
//   node-config.solo.json                points the node at the two files above
//   data/solo-dev.db                     the chain
//
// It uses P2P port 9100, not 9000, and its own database, so it can never peer
// with or write to a real network configured in node-config.json.
//
// To start over: stop the node, delete data/solo-dev.db* and run it again.
// To sign into the miner app as the genesis validator (which starts funded and
// 100% human), use the keystore file under testnet/solo-dev/keys/.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const netDir = join(root, 'testnet', 'solo-dev');
const keysDir = join(netDir, 'keys');
const configPath = join(root, 'node-config.solo.json');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(tsx)) {
  console.error('Dependencies are not installed. Run "npm install" in ae-node first.');
  process.exit(1);
}

if (!existsSync(join(netDir, 'genesis.json'))) {
  console.log('[dev:solo] No local network yet. Creating a one-validator genesis...');
  const made = spawnSync(
    process.execPath,
    [
      tsx, 'src/scripts/init-genesis.ts',
      '--output', './testnet/solo-dev',
      '--network-id', 'ae-devnet-solo',
      '--validators', '1',
      '--names', 'validator-1',
      '--initial-earned', '5000',
      '--stake', '1000',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (made.status !== 0) process.exit(made.status ?? 1);
}

if (!existsSync(configPath)) {
  const keystores = existsSync(keysDir) ? readdirSync(keysDir).filter((f) => f.endsWith('.json')) : [];
  if (keystores.length !== 1) {
    console.error(
      `[dev:solo] Expected exactly one keystore in ${keysDir}, found ${keystores.length}. ` +
        'Delete testnet/solo-dev and run this again.',
    );
    process.exit(1);
  }
  const accountId = keystores[0].replace(/\.json$/, '');
  const config = {
    _comment:
      'LOCAL ONE-VALIDATOR DEVNET, written by scripts/dev-solo.mjs. Own database, own P2P port. Never peers with a real network.',
    consensusMode: 'bft',
    genesisConfigPath: './testnet/solo-dev/genesis.json',
    nodeKeyPath: `./testnet/solo-dev/keys/${accountId}.json`,
    bftLocalAccountId: accountId,
    nodeId: accountId,
    apiPort: 3000,
    p2pPort: 9100,
    dbPath: './data/solo-dev.db',
    seedNodes: [],
    blockIntervalMs: 10000,
    bftStartupDelayMs: 2000,
    logLevel: 'info',
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`[dev:solo] Wrote ${configPath}`);
}

const child = spawn(
  process.execPath,
  [tsx, 'watch', 'src/node/cli.ts', '--config=./node-config.solo.json', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
