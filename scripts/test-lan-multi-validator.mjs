#!/usr/bin/env node
/**
 * End-to-end LAN multi-validator test.
 *
 * STATUS: WIP. The orchestration spins up three ae-node subprocesses,
 * each loads the genesis correctly and starts the BFT loop, but the
 * three peers don't currently form a mesh from the script even with
 * staggered boot + seed-node config. The same protocol code path runs
 * green in-process via tests/smoke-multiblock.test.ts (2 runners) and
 * the phase49+ multi-runner tests. Debugging the subprocess gap (likely
 * a peering/handshake nuance specific to the cli.ts wiring) is on the
 * to-do list. Until then this script gets you 80% of the way: it builds
 * the genesis, spawns nodes with the right env, polls /health. You can
 * leave the nodes running and inspect them manually via curl.
 *
 * Spins up three ae-node processes on localhost, each holding one of three
 * pre-allocated validator keystores from a shared genesis spec. They peer
 * via configured seed nodes (no NAT, no public bootstrap), run BFT
 * consensus, and produce blocks together. We assert that each node's
 * /api/v1/network/status reports a height >= MIN_HEIGHT and matching
 * latest-block hashes across the three nodes.
 *
 * This is the dev-time gate the milestone wanted: proof that the install
 * pipeline (Tasks 1-7) actually produces nodes capable of joining a real
 * BFT network. It mirrors what main.cjs does when it spawns ae-node from
 * a saved network-config.
 *
 * Usage from the repo root:
 *
 *   node scripts/test-lan-multi-validator.mjs
 *
 * Exit code 0 on success, non-zero on any failure. Output the height +
 * block hash from each runner so the user (or CI) can see what happened.
 *
 * The script writes per-run state to a fresh directory under the OS temp
 * dir; nothing pollutes the repo. SIGTERMs all children on exit (success
 * or failure).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const aeNodeRoot = join(repoRoot, 'ae-node');
const aeNodeCli = join(aeNodeRoot, 'dist', 'node', 'cli.js');

const VALIDATOR_COUNT = 3;
const MIN_HEIGHT = 3;          // must commit at least 3 blocks to count as alive
const HEALTH_DEADLINE_MS = 30_000;
const HEIGHT_DEADLINE_MS = 90_000; // 9x the 10s block interval — generous
const POLL_INTERVAL_MS = 750;

function log(msg) {
  console.log(`[lan-test] ${msg}`);
}

function err(msg) {
  console.error(`[lan-test] ${msg}`);
}

async function buildGenesis(outputDir) {
  // Pull buildGenesisSet + writeGenesisSet straight from the compiled
  // ae-node dist. Ensures we use the SAME function ae-node uses to seed
  // its genesis state — no skew between test setup and runtime.
  const genesisInitPath = pathToFileURL(join(aeNodeRoot, 'dist', 'node', 'genesis-init.js')).href;
  const { buildGenesisSet, writeGenesisSet } = await import(genesisInitPath);
  const set = buildGenesisSet({
    networkId: `ae-lan-test-${Date.now().toString(36)}`,
    validatorCount: VALIDATOR_COUNT,
    names: ['alpha', 'beta', 'gamma'],
  });
  const r = writeGenesisSet(outputDir, set);
  return { specPath: r.specPath, keystores: set.keystores, keystorePaths: r.keystorePaths };
}

function spawnNode({ idx, accountId, keystorePath, specPath, dbPath, apiPort, p2pPort, seedNodes }) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // harmless on plain node, required when run via electron
    AE_API_PORT: String(apiPort),
    AE_P2P_PORT: String(p2pPort),
    AE_DB_PATH: dbPath,
    AE_LOG_LEVEL: process.env.LAN_TEST_VERBOSE ? 'info' : 'warn',
    AE_CONSENSUS_MODE: 'bft',
    AE_GENESIS_CONFIG_PATH: specPath,
    AE_NODE_KEY_PATH: keystorePath,
    AE_BFT_LOCAL_ACCOUNT_ID: accountId,
    AE_NODE_ID: accountId,
    AE_SEED_NODES: seedNodes.join(','),
  };
  const child = spawn(process.execPath, [aeNodeCli], { cwd: aeNodeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    const lines = chunk.toString().trim().split('\n');
    for (const line of lines) {
      if (line) console.log(`[node-${idx}] ${line}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    const lines = chunk.toString().trim().split('\n');
    for (const line of lines) {
      if (line) console.error(`[node-${idx}] ${line}`);
    }
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) err(`node-${idx} exited with code ${code} (signal ${signal})`);
  });
  return child;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function waitForHealth(apiPort) {
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetchJson(`http://127.0.0.1:${apiPort}/api/v1/health`);
      if (r && r.status === 'ok') return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  return false;
}

async function getNetworkStatus(apiPort) {
  const r = await fetchJson(`http://127.0.0.1:${apiPort}/api/v1/network/status`);
  return r.data ?? r;
}

async function getLatestBlock(apiPort) {
  const r = await fetchJson(`http://127.0.0.1:${apiPort}/api/v1/network/blocks?limit=1`);
  const blocks = r.data?.blocks ?? r.blocks ?? [];
  return blocks[0] ?? null;
}

async function waitForHeight(ports, minHeight) {
  const deadline = Date.now() + HEIGHT_DEADLINE_MS;
  let lastHeights = ports.map(() => 0);
  while (Date.now() < deadline) {
    const heights = [];
    for (const p of ports) {
      try {
        const s = await getNetworkStatus(p);
        heights.push(typeof s.blockHeight === 'number' ? s.blockHeight : -1);
      } catch {
        heights.push(-1);
      }
    }
    if (JSON.stringify(heights) !== JSON.stringify(lastHeights)) {
      log(`heights = [${heights.join(', ')}]`);
      lastHeights = heights;
    }
    if (heights.every((h) => h >= minHeight)) return heights;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  return null;
}

let children = [];

function teardown(reason) {
  log(`tearing down (${reason})`);
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => {
    for (const c of children) {
      try { if (!c.killed) c.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 2000);
}

process.on('SIGINT', () => { teardown('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { teardown('SIGTERM'); process.exit(143); });

async function main() {
  const workDir = join(tmpdir(), `ae-lan-test-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  log(`workDir: ${workDir}`);

  // 1. Build genesis + keystores
  const { specPath, keystores, keystorePaths } = await buildGenesis(workDir);
  log(`spec: ${specPath}`);
  log(`validators: ${keystores.map((k) => k.accountId).join(', ')}`);

  // 2. Allocate ports + spawn 3 nodes that seed off each other
  const apiBase = 4001;
  const p2pBase = 9301;
  const apiPorts = keystores.map((_, i) => apiBase + i);
  const p2pPorts = keystores.map((_, i) => p2pBase + i);

  // Stagger the boot so each child has earlier siblings already listening
  // before it tries to dial them. node-0 has no seeds; node-1 dials
  // node-0; node-2 dials both. Mirrors smoke-multiblock.test's pattern.
  for (let i = 0; i < keystores.length; i++) {
    const ks = keystores[i];
    const ksPath = keystorePaths.find((p) => p.includes(ks.accountId));
    const earlierP2p = p2pPorts.slice(0, i).map((p) => `127.0.0.1:${p}`);
    const child = spawnNode({
      idx: i,
      accountId: ks.accountId,
      keystorePath: ksPath,
      specPath,
      dbPath: join(workDir, `node-${i}.db`),
      apiPort: apiPorts[i],
      p2pPort: p2pPorts[i],
      seedNodes: earlierP2p,
    });
    children.push(child);
    log(`spawned node-${i} pid=${child.pid} api=:${apiPorts[i]} p2p=:${p2pPorts[i]} seeds=[${earlierP2p.join(',') || '(none)'}]`);
    // Wait for this node's /health before starting the next one.
    const ok = await waitForHealth(apiPorts[i]);
    if (!ok) {
      teardown('health timeout');
      err(`node-${i} did not respond on /health within ${HEALTH_DEADLINE_MS}ms`);
      process.exit(2);
    }
    log(`node-${i} health: ok`);
  }

  // 4. Wait for blocks to advance on all three
  log(`waiting for blockHeight >= ${MIN_HEIGHT} on all three...`);
  const heights = await waitForHeight(apiPorts, MIN_HEIGHT);
  if (!heights) {
    teardown('height timeout');
    err(`one or more nodes did not reach height ${MIN_HEIGHT} within ${HEIGHT_DEADLINE_MS}ms`);
    process.exit(3);
  }
  log(`heights converged: [${heights.join(', ')}]`);

  // 5. Compare latest block hashes via /network/blocks?limit=1.
  // Heights matching is necessary but not sufficient — same chain means
  // the SAME block at the same height. Hash divergence here means the
  // network split (shouldn't happen under BFT, but worth catching).
  const blocks = [];
  for (const p of apiPorts) blocks.push(await getLatestBlock(p));
  log(`latest block per node:`);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    log(`  node-${i}: height=${b?.number ?? '?'} hash=${b?.hash ?? '(unavailable)'}`);
  }
  // Find a height all three nodes have, compare hashes there.
  const minMutualHeight = Math.min(...blocks.map((b) => b?.number ?? -1));
  if (minMutualHeight < 0) {
    teardown('block fetch failed');
    err('could not fetch latest block from one or more nodes');
    process.exit(4);
  }
  const hashesAtMin = blocks.map((b) => b.number === minMutualHeight ? b.hash : null);
  // The nodes might be at slightly different heights due to BFT round
  // timing. Re-fetch the hash at minMutualHeight for any node that's
  // ahead so the comparison is apples-to-apples.
  for (let i = 0; i < apiPorts.length; i++) {
    if (hashesAtMin[i]) continue;
    try {
      const r = await fetchJson(`http://127.0.0.1:${apiPorts[i]}/api/v1/network/blocks?limit=10`);
      const list = r.data?.blocks ?? r.blocks ?? [];
      const matching = list.find((b) => b.number === minMutualHeight);
      hashesAtMin[i] = matching?.hash ?? null;
    } catch { /* ignore */ }
  }
  log(`hash at common height ${minMutualHeight}: ${hashesAtMin.join(' / ')}`);
  const distinctHashes = new Set(hashesAtMin.filter(Boolean));
  if (distinctHashes.size > 1) {
    teardown('hash divergence');
    err(`nodes disagree on block hash at height ${minMutualHeight}: ${[...distinctHashes].join(' vs ')}`);
    process.exit(4);
  }

  log('PASS: 3-validator BFT chain advanced past min height with matching hashes');
  teardown('success');

  // Give children a moment to die before exiting cleanly so logs don't
  // get lost.
  setTimeout(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* keep state on failure */ }
    process.exit(0);
  }, 500);
}

main().catch((e) => {
  err(`unhandled: ${e?.stack ?? e}`);
  teardown('exception');
  process.exit(1);
});
