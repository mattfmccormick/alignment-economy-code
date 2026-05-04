// Phase 59: End-to-end chain-driven validator changes.
//
// Sessions 48-52 built the validator-change five-piece:
//   48: on-chain mechanism (block payload field, applied at commit)
//   49: persisted local queue + runner wiring
//   50: API endpoints (propose-register / propose-deregister)
//   51: sync replay for late joiners
//   52: block-hash binding (defense in depth)
//
// Phase 53 demonstrated MANUAL cross-DB sync (call each runner's API
// independently). This test proves AUTOMATIC propagation: a single
// signed change posted to one runner's API rides the next BFT block
// and applies on every runner.
//
// Setup:
//   - Genesis spec: validator-1 + validator-2 are validators; a third
//     candidate account is funded but NOT a validator initially.
//   - Two runners boot from the shared spec (proves Sessions 41+42+43).
//   - The candidate signs a ValidatorChangeRegister and POSTs to runner
//     A's /propose-register endpoint.
//   - A's queue grows; A's BFT producer drains it into the next block;
//     the block commits on both runners; the candidate is now a
//     registered validator on BOTH DBs.
//
// Note on quorum dynamics: once the candidate registers, N=3 active and
// quorum=3. Without the candidate running a node the chain stalls after
// the register block lands. That's expected — the test just observes
// the block-with-change committed and asserts both DBs reflect the
// candidate's registration. The post-stall behavior is a separate
// concern.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'http';

import { AENodeRunner } from '../src/node/runner.js';
import { buildGenesisSet, writeGenesisSet } from '../src/node/genesis-init.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { signValidatorChangeRegister } from '../src/core/consensus/validator-change.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { getLatestBlock } from '../src/core/block.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import { PRECISION } from '../src/core/constants.js';
import type { GenesisAccountSpec } from '../src/node/genesis-config.js';
import type { AENodeConfig } from '../src/node/config.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
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
    logLevel: 'warn',
  };
}

describe('Phase 59: E2E chain-driven validator changes', () => {
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

  it('candidate signs a register; A POSTs it; both runners commit + apply via the chain', async () => {
    resetRateLimits();

    // ── 1. Genesis: validator-1 + validator-2 + candidate (non-validator)
    const set = buildGenesisSet({ networkId: 'ae-test',
      validatorCount: 2,
      names: ['validator-1', 'validator-2'],
      initialEarnedDisplay: 5000,
      stakeDisplay: 200,
    });

    // The candidate is generated separately so we hold its privateKey
    // for signing the change. It rides on the genesis spec as a
    // non-validator account.
    const candidateKp = generateKeyPair();
    const candidateAccountSpec: GenesisAccountSpec = {
      publicKey: candidateKp.publicKey,
      type: 'individual',
      percentHuman: 100,
      earnedBalance: pts(5000).toString(),
      // no validator field — the candidate is non-validator-yet
    };
    set.spec.accounts.push(candidateAccountSpec);

    const genesisDir = mkdtempSync(join(tmpdir(), 'phase59-genesis-'));
    tempDirs.push(genesisDir);
    const { specPath } = writeGenesisSet(genesisDir, set);

    const ksA = set.keystores[0];
    const ksB = set.keystores[1];

    // ── 2. Per-runner data dirs + node-key files ─────────────────────
    const aDir = mkdtempSync(join(tmpdir(), 'phase59-A-'));
    const bDir = mkdtempSync(join(tmpdir(), 'phase59-B-'));
    tempDirs.push(aDir, bDir);

    const aDb = join(aDir, 'node.db');
    const aKey = join(aDir, 'node-key.json');
    const bDb = join(bDir, 'node.db');
    const bKey = join(bDir, 'node-key.json');

    writeFileSync(aKey, JSON.stringify(ksA), { mode: 0o600 });
    writeFileSync(bKey, JSON.stringify(ksB), { mode: 0o600 });

    // ── 3. Start both runners ───────────────────────────────────────
    const runnerA = new AENodeRunner(
      baseConfig(aDb, aKey, ksA.accountId, specPath, ksA.accountId),
    );
    runners.push(runnerA);
    runnerA.start();
    await runnerA.waitForReady();
    const aP2P = runnerA.getP2PPort();
    const aApi = runnerA.getApiPort();

    const runnerB = new AENodeRunner({
      ...baseConfig(bDb, bKey, ksB.accountId, specPath, ksB.accountId),
      seedNodes: [{ host: '127.0.0.1', port: aP2P }],
    });
    runners.push(runnerB);
    runnerB.start();
    await runnerB.waitForReady();

    // DIAGNOSTIC: capture any peer-ban events on either runner
    const banEvents: Array<{ runner: string; publicKey: string; reason?: string }> = [];
    runnerA.getP2PNode().peerManager.on('peer:banned', (data: any) => {
      banEvents.push({ runner: 'A', publicKey: data.publicKey, reason: data.reason });
    });
    runnerB.getP2PNode().peerManager.on('peer:banned', (data: any) => {
      banEvents.push({ runner: 'B', publicKey: data.publicKey, reason: data.reason });
    });

    // Wait for peer mesh
    const meshDeadline = Date.now() + 5_000;
    while (
      Date.now() < meshDeadline &&
      runnerA.getP2PNode().peerManager.getPeerCount() < 1
    ) {
      await wait(50);
    }
    assert.equal(
      runnerA.getP2PNode().peerManager.getPeerCount(),
      1,
      'A must see B as peer',
    );

    // Sanity: both runners see 2 active validators initially
    const aSetEarly = new SqliteValidatorSet(runnerA.getDb()).listActive();
    const bSetEarly = new SqliteValidatorSet(runnerB.getDb()).listActive();
    assert.equal(aSetEarly.length, 2);
    assert.equal(bSetEarly.length, 2);

    // ── 4. Candidate signs a register change + POSTs to A's API ─────
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    const candidateAccountId = deriveAccountId(candidateKp.publicKey);
    const change = signValidatorChangeRegister({
      accountId: candidateAccountId,
      nodePublicKey: node.publicKey,
      vrfPublicKey: vrf.publicKey,
      stake: pts(200).toString(),
      timestamp: Math.floor(Date.now() / 1000),
      accountPrivateKey: candidateKp.privateKey,
    });

    const submitResp = await postJson(aApi, '/api/v1/validators/propose-register', {
      change,
    });
    assert.equal(submitResp.status, 200, JSON.stringify(submitResp.data));
    assert.equal(submitResp.data.success, true);
    assert.equal(submitResp.data.data.status, 'pending');

    // ── 5. Wait for both runners to register the candidate ──────────
    // The change is in A's queue. A's BFT producer drains it on
    // its next propose round. The block carrying the change commits
    // on both runners (quorum=2 still — block N's cert was signed by
    // pre-change set). After commit, the candidate is registered on
    // both DBs.
    //
    // Once the candidate is in the active set, quorum becomes 3 and
    // the chain stalls (the candidate isn't running a node).
    //
    // This test is in the documented multi-runner BFT timing flake
    // category (phase 35/49/53). Pass case: 5-30s. Worst case: ~120s
    // when the first block hits successive NIL timeouts before the
    // change rides one. Retry on flake; isolated single-runner tests
    // (phase 54/55/56/57/58) cover the protocol primitives.
    const propagateDeadline = Date.now() + 150_000;
    let aHasCandidate = false;
    let bHasCandidate = false;
    while (Date.now() < propagateDeadline && !(aHasCandidate && bHasCandidate)) {
      aHasCandidate = !!new SqliteValidatorSet(runnerA.getDb()).findByAccountId(candidateAccountId);
      bHasCandidate = !!new SqliteValidatorSet(runnerB.getDb()).findByAccountId(candidateAccountId);
      if (aHasCandidate && bHasCandidate) break;
      await wait(100);
    }
    if (!aHasCandidate || !bHasCandidate) {
      const aLatest = getLatestBlock(runnerA.getDb());
      const bLatest = getLatestBlock(runnerB.getDb());
      const aQueue = runnerA.getDb()
        .prepare('SELECT COUNT(*) as cnt FROM pending_validator_changes')
        .get() as { cnt: number };
      const aSetCount = new SqliteValidatorSet(runnerA.getDb()).listActive().length;
      const bSetCount = new SqliteValidatorSet(runnerB.getDb()).listActive().length;
      throw new Error(
        `propagation timeout: aHasCandidate=${aHasCandidate} bHasCandidate=${bHasCandidate} ` +
          `aLatest=${aLatest?.number ?? 0} bLatest=${bLatest?.number ?? 0} ` +
          `aQueue=${aQueue.cnt} aSet=${aSetCount} bSet=${bSetCount} ` +
          `bans=${JSON.stringify(banEvents)}`,
      );
    }

    // ── 6. Both runners agree on the candidate's validator row ──────
    const aCandidate = new SqliteValidatorSet(runnerA.getDb()).findByAccountId(candidateAccountId)!;
    const bCandidate = new SqliteValidatorSet(runnerB.getDb()).findByAccountId(candidateAccountId)!;
    assert.equal(aCandidate.nodePublicKey, node.publicKey);
    assert.equal(aCandidate.vrfPublicKey, vrf.publicKey);
    assert.equal(aCandidate.stake, pts(200));
    assert.equal(aCandidate.isActive, true);
    // Byte-identical across runners (the determinism property)
    assert.equal(aCandidate.nodePublicKey, bCandidate.nodePublicKey);
    assert.equal(aCandidate.vrfPublicKey, bCandidate.vrfPublicKey);
    assert.equal(aCandidate.stake, bCandidate.stake);

    // ── 7. Account balance flowed earned -> locked on both ──────────
    const aAcct = runnerA.getDb()
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(candidateAccountId) as { earned_balance: string; locked_balance: string };
    const bAcct = runnerB.getDb()
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(candidateAccountId) as { earned_balance: string; locked_balance: string };
    assert.equal(aAcct.earned_balance, (pts(5000) - pts(200)).toString());
    assert.equal(aAcct.locked_balance, pts(200).toString());
    assert.deepEqual(bAcct, aAcct, 'candidate account state agrees across runners');

    // ── 8. A's local pending queue is drained ───────────────────────
    const queueRow = runnerA.getDb()
      .prepare('SELECT COUNT(*) as cnt FROM pending_validator_changes')
      .get() as { cnt: number };
    assert.equal(queueRow.cnt, 0, 'A drained the queue after the block applied');

    // ── 9. Both runners committed at least one block ────────────────
    const aLatest = getLatestBlock(runnerA.getDb())!;
    const bLatest = getLatestBlock(runnerB.getDb())!;
    assert.ok(aLatest.number >= 1);
    assert.ok(bLatest.number >= 1);
    // Block hashes for any commonly-committed height must match
    const commonHeight = Math.min(aLatest.number, bLatest.number);
    if (commonHeight >= 1) {
      const aBlock = runnerA.getDb().prepare('SELECT hash FROM blocks WHERE number = ?').get(commonHeight);
      const bBlock = runnerB.getDb().prepare('SELECT hash FROM blocks WHERE number = ?').get(commonHeight);
      assert.deepEqual(aBlock, bBlock, `block ${commonHeight} hash agrees across runners`);
    }
  });
});
