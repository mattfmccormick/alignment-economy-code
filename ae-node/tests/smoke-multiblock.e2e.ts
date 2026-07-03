// Smoke test: prove the chain runs past block 2 after the Session 53
// parent-cert-in-gossip fix. Pre-fix, every block at height >= 2 failed
// gossip validation and the producer got banned, so the chain died at
// block 1 even though phase 49/35/53 weren't watching for it.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AENodeRunner } from '../src/node/runner.js';
import { buildGenesisSet, writeGenesisSet } from '../src/node/genesis-init.js';
import { getLatestBlock } from '../src/core/block.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import type { AENodeConfig } from '../src/node/config.js';

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function baseConfig(
  dbPath: string,
  nodeKeyPath: string,
  nodeId: string,
  genesisConfigPath: string,
  bftLocalAccountId: string,
): AENodeConfig {
  return {
    nodeId,
    authorityNodeId: '',
    apiPort: 0,
    p2pPort: 0,
    apiHost: '127.0.0.1',
    p2pHost: '127.0.0.1',
    dbPath,
    nodeKeyPath,
    genesisConfigPath,
    consensusMode: 'bft',
    bftLocalAccountId,
    seedNodes: [],
    maxPeers: 5,
    dayCycleIntervalMs: 86_400_000,
    blockIntervalMs: 10_000,
    logLevel: 'error',
  };
}

describe('Smoke: BFT chain runs past block 2', () => {
  const tempDirs: string[] = [];
  let runners: AENodeRunner[] = [];

  afterEach(async () => {
    for (const r of runners) {
      try { r.stop(); } catch {}
    }
    runners = [];
    await wait(50);
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tempDirs.length = 0;
  });

  it('two runners commit blocks 1, 2, 3 in sequence (pre-Session-53 this died at block 2)', async () => {
    resetRateLimits();
    const set = buildGenesisSet({ networkId: 'ae-test',
      validatorCount: 2,
      names: ['validator-1', 'validator-2'],
      initialEarnedDisplay: 5000,
      stakeDisplay: 200,
    });
    const genesisDir = mkdtempSync(join(tmpdir(), 'smoke-multi-'));
    tempDirs.push(genesisDir);
    const { specPath } = writeGenesisSet(genesisDir, set);

    const ksA = set.keystores[0];
    const ksB = set.keystores[1];
    const aDir = mkdtempSync(join(tmpdir(), 'smoke-A-'));
    const bDir = mkdtempSync(join(tmpdir(), 'smoke-B-'));
    tempDirs.push(aDir, bDir);

    const aKey = join(aDir, 'node-key.json');
    const bKey = join(bDir, 'node-key.json');
    writeFileSync(aKey, JSON.stringify(ksA), { mode: 0o600 });
    writeFileSync(bKey, JSON.stringify(ksB), { mode: 0o600 });

    const runnerA = new AENodeRunner(
      baseConfig(join(aDir, 'node.db'), aKey, ksA.accountId, specPath, ksA.accountId),
    );
    runners.push(runnerA);
    runnerA.start();
    await runnerA.waitForReady();

    const runnerB = new AENodeRunner({
      ...baseConfig(join(bDir, 'node.db'), bKey, ksB.accountId, specPath, ksB.accountId),
      seedNodes: [{ host: '127.0.0.1', port: runnerA.getP2PPort() }],
    });
    runners.push(runnerB);
    runnerB.start();
    await runnerB.waitForReady();

    // Wait for peer mesh
    const meshDeadline = Date.now() + 5_000;
    while (
      Date.now() < meshDeadline &&
      runnerA.getP2PNode().peerManager.getPeerCount() < 1
    ) {
      await wait(50);
    }

    // Wait for both runners to commit at least block 3. With 2-validator
    // BFT and quorum=2, blocks should fire every 5-15s under normal
    // conditions. 120s deadline accommodates the multi-runner flake.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const aLatest = getLatestBlock(runnerA.getDb());
      const bLatest = getLatestBlock(runnerB.getDb());
      if ((aLatest?.number ?? 0) >= 3 && (bLatest?.number ?? 0) >= 3) break;
      await wait(200);
    }

    const aLatest = getLatestBlock(runnerA.getDb())!;
    const bLatest = getLatestBlock(runnerB.getDb())!;
    const aPeers = runnerA.getP2PNode().peerManager.getPeerCount();
    const bPeers = runnerB.getP2PNode().peerManager.getPeerCount();
    assert.ok(
      aLatest.number >= 3,
      `A must reach block 3+ (was ${aLatest.number}, peers=${aPeers})`,
    );
    assert.ok(
      bLatest.number >= 3,
      `B must reach block 3+ (was ${bLatest.number}, peers=${bPeers})`,
    );

    // Block hashes must agree at every height both runners have
    const minHeight = Math.min(aLatest.number, bLatest.number);
    for (let h = 1; h <= minHeight; h++) {
      const aBlock = runnerA.getDb()
        .prepare('SELECT hash FROM blocks WHERE number = ?')
        .get(h) as { hash: string };
      const bBlock = runnerB.getDb()
        .prepare('SELECT hash FROM blocks WHERE number = ?')
        .get(h) as { hash: string };
      assert.equal(aBlock.hash, bBlock.hash, `block ${h} hash agrees`);
    }

    console.log(`✓ both runners reached block ${minHeight} with matching hashes`);
  });
});
