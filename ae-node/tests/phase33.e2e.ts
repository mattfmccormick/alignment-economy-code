// Phase 33: Runner-level BFT integration.
//
// AENodeRunner can now boot in two modes:
//   - 'authority' (default): existing setInterval-based block production
//   - 'bft': spawns a BftBlockProducer driving propose/prevote/precommit
//     rounds against the validator set stored in the DB
//
// What's verified:
//   1. Default config (no consensusMode) still boots Authority mode and
//      doesn't construct a BftBlockProducer.
//   2. consensusMode='bft' boots and constructs a BftBlockProducer.
//   3. consensusMode='bft' without bftLocalAccountId throws (the wiring
//      catches misconfiguration before the chain can produce a fork).
//   4. Stop tears down the BFT producer cleanly.
//
// We don't run a multi-runner end-to-end here — phase31 already proves
// BftBlockProducer interop directly. This suite verifies the runner wiring.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AENodeRunner } from '../src/node/runner.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { registerValidator } from '../src/core/consensus/registration.js';
import { PRECISION } from '../src/core/constants.js';
import type { AENodeConfig } from '../src/node/config.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

/**
 * Create a temp dir + pre-seed a SQLite DB with one registered validator
 * whose nodePublicKey matches the supplied identity. Returns the dbPath
 * + accountId so the runner can boot against it.
 */
function setupValidatorDb(identity: ReturnType<typeof generateNodeIdentity>): {
  dir: string;
  dbPath: string;
  accountId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ae-runner-bft-'));
  const dbPath = join(dir, 'node.db');

  // Initialize the DB with schema, params, validator. Then close so the
  // runner can open it fresh.
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);

  const acct = createAccount(db, 'individual', 1, 100);
  const accountId = 'val-runner-test';
  db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(accountId, acct.account.id);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    pts(500).toString(),
    accountId,
  );
  registerValidator(db, {
    accountId,
    nodePublicKey: identity.publicKey,
    vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
    stake: pts(200),
  });
  db.close();
  return { dir, dbPath, accountId };
}

function baseConfig(dbPath: string): AENodeConfig {
  return {
    nodeId: 'runner-test',
    authorityNodeId: '',
    apiPort: 0, // ephemeral
    p2pPort: 0, // ephemeral
    apiHost: '127.0.0.1',
    p2pHost: '127.0.0.1',
    dbPath,
    seedNodes: [],
    maxPeers: 5,
    dayCycleIntervalMs: 86_400_000,
    blockIntervalMs: 10_000,
    logLevel: 'error',
  };
}

describe('Phase 33: Runner-level BFT integration', () => {
  const tempDirs: string[] = [];
  let runners: AENodeRunner[] = [];

  afterEach(() => {
    for (const r of runners) {
      try { r.stop(); } catch {}
    }
    runners = [];
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tempDirs.length = 0;
  });

  it('default config (no consensusMode) does not start a BftBlockProducer', () => {
    const id = generateNodeIdentity();
    const setup = setupValidatorDb(id);
    tempDirs.push(setup.dir);

    const runner = new AENodeRunner({
      ...baseConfig(setup.dbPath),
      authorityNodeId: 'runner-test',
      // authorityNodeId equals nodeId so this node is the authority for the
      // default block-production path. consensusMode unset.
      nodeKeyPath: join(setup.dir, 'node-key.json'),
    });
    // Stash the identity so the loadOrCreateNodeIdentity call matches.
    // (Easier: just let it generate a fresh one — authority mode doesn't
    // care about the validators table.)
    runners.push(runner);

    runner.start();
    assert.equal(runner.getBftBlockProducer(), null, 'authority mode must not have a BFT producer');
  });

  it("consensusMode='bft' boots and starts a BftBlockProducer", () => {
    const id = generateNodeIdentity();
    const setup = setupValidatorDb(id);
    tempDirs.push(setup.dir);

    // Pre-write the node-key file so the runner picks up the SAME identity
    // that we registered in the validators table. Otherwise loadOrCreateNodeIdentity
    // would generate a new one and BFTConsensus would refuse to act as
    // proposer (registered nodePublicKey != local nodePublicKey).
    const nodeKeyPath = join(setup.dir, 'node-key.json');
    writeFileSync(nodeKeyPath, JSON.stringify(id), { mode: 0o600 });

    const runner = new AENodeRunner({
      ...baseConfig(setup.dbPath),
      // BFT mode requires nodeId === bftLocalAccountId (the wire-envelope
      // senderId is what consensus.validateBlockProducer looks up).
      nodeId: setup.accountId,
      consensusMode: 'bft',
      bftLocalAccountId: setup.accountId,
      nodeKeyPath,
    });
    runners.push(runner);

    runner.start();

    const producer = runner.getBftBlockProducer();
    assert.ok(producer, 'BFT mode must construct a BftBlockProducer');
  });

  it("consensusMode='bft' without bftLocalAccountId throws on start", () => {
    const id = generateNodeIdentity();
    const setup = setupValidatorDb(id);
    tempDirs.push(setup.dir);

    const nodeKeyPath = join(setup.dir, 'node-key.json');
    writeFileSync(nodeKeyPath, JSON.stringify(id), { mode: 0o600 });

    const runner = new AENodeRunner({
      ...baseConfig(setup.dbPath),
      consensusMode: 'bft',
      // bftLocalAccountId intentionally omitted
      nodeKeyPath,
    });
    runners.push(runner);

    assert.throws(() => runner.start(), /requires bftValidatorSet and bftLocalAccountId|bftLocalAccountId/);
  });

  it('stop() tears down the BFT producer', () => {
    const id = generateNodeIdentity();
    const setup = setupValidatorDb(id);
    tempDirs.push(setup.dir);

    const nodeKeyPath = join(setup.dir, 'node-key.json');
    writeFileSync(nodeKeyPath, JSON.stringify(id), { mode: 0o600 });

    const runner = new AENodeRunner({
      ...baseConfig(setup.dbPath),
      nodeId: setup.accountId,
      consensusMode: 'bft',
      bftLocalAccountId: setup.accountId,
      nodeKeyPath,
    });
    runners.push(runner);

    runner.start();
    assert.ok(runner.getBftBlockProducer());

    runner.stop();
    assert.equal(
      runner.getBftBlockProducer(),
      null,
      'stop() should null out the BFT producer reference',
    );
    // Don't double-stop in afterEach
    runners.length = 0;
  });
});
