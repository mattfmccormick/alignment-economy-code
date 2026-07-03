// Phase 60: Liveness under proposer absence + restart resilience.
//
// What this proves at the AENodeRunner level (Phase 30 covered the
// BftRuntime unit-level case):
//
//   1. With 4 validators registered (quorum = floor(2N/3)+1 = 3) and only
//      3 runners booted, the live 3 keep the chain producing. When the
//      absent validator is the round-0 proposer, the live 3 wait
//      propose-timeout, NIL-prevote, advance to round 1, and commit
//      under a different proposer.
//
//   2. A runner can be stopped mid-chain and restarted from the same
//      dbPath + nodeKeyPath. On restart it loads its on-disk state,
//      reconnects to peers, ChainSync catches it up, and then it
//      resumes participating in consensus. Block hashes match across
//      every height the restarted node has.
//
// Why this matters: real operators WILL kill and restart their nodes
// (deploys, OS updates, machine reboots, occasional crashes). A chain
// that can't survive node restart isn't usable. And a chain that halts
// when one of N validators is offline isn't BFT — it's just multi-node
// authority.

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

function getBlockHashAt(runner: AENodeRunner, height: number): string | null {
  const row = runner.getDb()
    .prepare('SELECT hash FROM blocks WHERE number = ?')
    .get(height) as { hash: string } | undefined;
  return row?.hash ?? null;
}

describe('Phase 60: Liveness + restart resilience', () => {
  const tempDirs: string[] = [];
  let runners: AENodeRunner[] = [];

  afterEach(async () => {
    for (const r of runners) {
      try { r.stop(); } catch {}
    }
    runners = [];
    await wait(100);
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tempDirs.length = 0;
  });

  // ── Test 1: round rotation under proposer absence ───────────────────

  it('chain advances with 1-of-4 validators absent (quorum=3 met by live 3)', async () => {
    resetRateLimits();

    // 4-validator genesis. Quorum = floor(2*4/3)+1 = 3, so 3 live runners
    // can commit. The 4th keystore exists in the spec (so it's a registered
    // validator) but we never boot a runner for it.
    const set = buildGenesisSet({ networkId: 'ae-test',
      validatorCount: 4,
      names: ['validator-1', 'validator-2', 'validator-3', 'validator-absent'],
      initialEarnedDisplay: 5000,
      stakeDisplay: 200,
    });

    const genesisDir = mkdtempSync(join(tmpdir(), 'phase60-genesis-'));
    tempDirs.push(genesisDir);
    const { specPath } = writeGenesisSet(genesisDir, set);

    // Boot 3 of the 4 keystores. The 4th (absent) just exists in the
    // spec — its ID is in every node's validator-set DB so quorum
    // calculations include it, but no live process votes for it.
    const liveKeystores = [set.keystores[0], set.keystores[1], set.keystores[2]];
    const liveRunners: AENodeRunner[] = [];
    const dirs: string[] = [];

    for (let i = 0; i < liveKeystores.length; i++) {
      const ks = liveKeystores[i];
      const dir = mkdtempSync(join(tmpdir(), `phase60-live${i + 1}-`));
      tempDirs.push(dir);
      dirs.push(dir);
      const dbPath = join(dir, 'node.db');
      const nodeKeyPath = join(dir, 'node-key.json');
      writeFileSync(nodeKeyPath, JSON.stringify(ks), { mode: 0o600 });

      // Each runner seeds off every prior runner so the mesh fills out
      // even if peer-discovery's exchangeInterval (60s default) hasn't
      // fired yet.
      const seedNodes = liveRunners.map((r) => ({
        host: '127.0.0.1',
        port: r.getP2PPort(),
      }));

      const runner = new AENodeRunner({
        ...baseConfig(dbPath, nodeKeyPath, ks.accountId, specPath, ks.accountId),
        seedNodes,
      });
      runners.push(runner);
      liveRunners.push(runner);
      runner.start();
      await runner.waitForReady();
    }

    // Wait for full mesh (each live runner sees the other 2)
    const meshDeadline = Date.now() + 8_000;
    while (Date.now() < meshDeadline) {
      const allMeshed = liveRunners.every(
        (r) => r.getP2PNode().peerManager.getPeerCount() >= 2,
      );
      if (allMeshed) break;
      await wait(50);
    }

    // Wait for height >= 3. With proposer rotating each height and the
    // absent validator being 1-of-4, on average every 4 heights need a
    // round-1 commit. Reaching height 3 means the chain survived AT
    // LEAST one of those (probabilistically) and at minimum proves
    // multi-block production with one validator absent.
    //
    // 180s deadline is generous; round 1's startup-delay-extended timeouts
    // can stretch to 30-40s per height when the absent validator is the
    // proposer.
    const commitDeadline = Date.now() + 180_000;
    while (Date.now() < commitDeadline) {
      const heights = liveRunners.map((r) => getLatestBlock(r.getDb())?.number ?? 0);
      if (heights.every((h) => h >= 3)) break;
      await wait(200);
    }

    const finalHeights = liveRunners.map((r) => getLatestBlock(r.getDb())?.number ?? 0);
    const peerCounts = liveRunners.map((r) => r.getP2PNode().peerManager.getPeerCount());
    for (let i = 0; i < liveRunners.length; i++) {
      assert.ok(
        finalHeights[i] >= 3,
        `live runner ${i + 1} must reach block 3+ (was ${finalHeights[i]}, peers=${peerCounts[i]})`,
      );
    }

    // Block hashes agree across every live runner at every height all 3
    // have reached. This is the property that proves they committed the
    // SAME chain, not three independent forks.
    const minHeight = Math.min(...finalHeights);
    for (let h = 1; h <= minHeight; h++) {
      const refHash = getBlockHashAt(liveRunners[0], h);
      assert.ok(refHash, `runner-1 must have block ${h}`);
      for (let i = 1; i < liveRunners.length; i++) {
        const hash = getBlockHashAt(liveRunners[i], h);
        assert.equal(
          hash,
          refHash,
          `runner ${i + 1} block ${h} hash must match runner-1`,
        );
      }
    }

    console.log(
      `✓ 4-validator chain with 1 absent advanced to block ${minHeight} ` +
        `(heights=${finalHeights.join(',')})`,
    );
  });

  // ── Test 2: stop a runner mid-chain, restart it from disk, verify resync ──

  it('stopped runner restarts from disk, reconnects, and catches up', async () => {
    resetRateLimits();

    // 4-validator setup again. All 4 boot, commit a few blocks, then
    // we kill one and let the remaining 3 (quorum=3) keep producing.
    // The killed one comes back from the same dbPath + nodeKeyPath
    // and ChainSync catches it up.
    const set = buildGenesisSet({ networkId: 'ae-test',
      validatorCount: 4,
      names: ['validator-1', 'validator-2', 'validator-3', 'validator-restart'],
      initialEarnedDisplay: 5000,
      stakeDisplay: 200,
    });

    const genesisDir = mkdtempSync(join(tmpdir(), 'phase60-restart-genesis-'));
    tempDirs.push(genesisDir);
    const { specPath } = writeGenesisSet(genesisDir, set);

    // Per-runner persistent dirs so the killed runner can come back to
    // the same on-disk state.
    const dirs: string[] = [];
    const dbPaths: string[] = [];
    const nodeKeyPaths: string[] = [];
    for (let i = 0; i < 4; i++) {
      const dir = mkdtempSync(join(tmpdir(), `phase60-restart${i + 1}-`));
      tempDirs.push(dir);
      dirs.push(dir);
      dbPaths.push(join(dir, 'node.db'));
      nodeKeyPaths.push(join(dir, 'node-key.json'));
      writeFileSync(nodeKeyPaths[i], JSON.stringify(set.keystores[i]), { mode: 0o600 });
    }

    const startRunner = async (
      idx: number,
      seedRunners: AENodeRunner[],
    ): Promise<AENodeRunner> => {
      const ks = set.keystores[idx];
      const seedNodes = seedRunners.map((r) => ({
        host: '127.0.0.1',
        port: r.getP2PPort(),
      }));
      const runner = new AENodeRunner({
        ...baseConfig(dbPaths[idx], nodeKeyPaths[idx], ks.accountId, specPath, ks.accountId),
        seedNodes,
      });
      runners.push(runner);
      runner.start();
      await runner.waitForReady();
      return runner;
    };

    // Boot all 4
    const runner1 = await startRunner(0, []);
    const runner2 = await startRunner(1, [runner1]);
    const runner3 = await startRunner(2, [runner1, runner2]);
    let runner4: AENodeRunner | null = await startRunner(3, [runner1, runner2, runner3]);

    // Wait for full mesh
    const meshDeadline = Date.now() + 8_000;
    while (Date.now() < meshDeadline) {
      const ok = [runner1, runner2, runner3, runner4!].every(
        (r) => r.getP2PNode().peerManager.getPeerCount() >= 3,
      );
      if (ok) break;
      await wait(50);
    }

    // Phase A: all 4 alive. Wait for height >= 2 — quorum=3 of 4 means
    // every block commits in round 0 unless a peer message dropped.
    const phaseADeadline = Date.now() + 90_000;
    while (Date.now() < phaseADeadline) {
      const heights = [runner1, runner2, runner3, runner4!].map(
        (r) => getLatestBlock(r.getDb())?.number ?? 0,
      );
      if (heights.every((h) => h >= 2)) break;
      await wait(200);
    }
    const phaseAHeight = getLatestBlock(runner4!.getDb())?.number ?? 0;
    assert.ok(
      phaseAHeight >= 2,
      `Phase A: all 4 runners must commit block 2+ before kill (runner4 was ${phaseAHeight})`,
    );

    // Phase B: kill runner4. Strip it from `runners` so afterEach
    // doesn't try to stop it again, and remember the height it was at
    // when killed.
    const heightAtKill = getLatestBlock(runner4!.getDb())!.number;
    runner4!.stop();
    runners = runners.filter((r) => r !== runner4);
    runner4 = null;
    await wait(200); // let the WS close propagate

    // Quorum is still met by runners 1/2/3 (3 of 4). Wait for them to
    // commit at least 2 more blocks past where runner4 stopped — this
    // guarantees runner4's restart will need to catch up via sync.
    const phaseBTarget = heightAtKill + 2;
    const phaseBDeadline = Date.now() + 180_000;
    while (Date.now() < phaseBDeadline) {
      const heights = [runner1, runner2, runner3].map(
        (r) => getLatestBlock(r.getDb())?.number ?? 0,
      );
      if (heights.every((h) => h >= phaseBTarget)) break;
      await wait(200);
    }
    const liveHeights = [runner1, runner2, runner3].map(
      (r) => getLatestBlock(r.getDb())?.number ?? 0,
    );
    for (let i = 0; i < liveHeights.length; i++) {
      assert.ok(
        liveHeights[i] >= phaseBTarget,
        `Phase B: live runner ${i + 1} must reach block ${phaseBTarget} ` +
          `(was ${liveHeights[i]}); chain must keep producing while one validator is offline`,
      );
    }

    // Phase C: restart runner4 from the SAME disk state. It should:
    //   1. Load its DB (block 0..heightAtKill on disk).
    //   2. Read its keystore from nodeKeyPaths[3].
    //   3. Reconnect to runners 1/2/3 via seedNodes.
    //   4. ChainSync fires (2s after start) and pulls missed blocks.
    //   5. Eventually reach the same height as the live 3.
    const runner4Restart = await startRunner(3, [runner1, runner2, runner3]);

    // Wait for runner4 to catch up to (or surpass) the heightAtKill+2 mark
    // it missed while down. ChainSync runs every 2s and pulls in batches.
    const phaseCTarget = phaseBTarget;
    const phaseCDeadline = Date.now() + 60_000;
    while (Date.now() < phaseCDeadline) {
      const h = getLatestBlock(runner4Restart.getDb())?.number ?? 0;
      if (h >= phaseCTarget) break;
      await wait(200);
    }
    const restartHeight = getLatestBlock(runner4Restart.getDb())?.number ?? 0;
    assert.ok(
      restartHeight >= phaseCTarget,
      `Phase C: restarted runner4 must catch up to block ${phaseCTarget} ` +
        `via sync (was ${restartHeight}); restart must trigger resync`,
    );

    // Block hashes match runner1's at every height runner4 has.
    for (let h = 1; h <= restartHeight; h++) {
      const refHash = getBlockHashAt(runner1, h);
      const restartHash = getBlockHashAt(runner4Restart, h);
      assert.ok(refHash && restartHash, `block ${h} must exist on both runners`);
      assert.equal(
        restartHash,
        refHash,
        `restarted runner4 block ${h} hash must match runner1`,
      );
    }

    console.log(
      `✓ runner4 killed at block ${heightAtKill}, chain advanced to ${liveHeights[0]} ` +
        `during downtime, restarted runner4 caught up to block ${restartHeight} with matching hashes`,
    );
  });
});
