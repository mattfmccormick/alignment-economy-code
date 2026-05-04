// Phase 48: Genesis-set generator (CLI groundwork).
//
// Session 41 made the runner load a GenesisSpec from disk. This session
// produces the spec + the per-operator keystores in one shot, so an
// operator running `npm run genesis:init -- --output ./testnet` ends
// up with everything they need to distribute and boot.
//
// Verified:
//   1. buildGenesisSet returns a spec that passes validateGenesisSpec
//      (so the CLI output is loadable by the runner without extra
//      transformation).
//   2. Each keystore's accountId is derived from its account.publicKey
//      and matches exactly one entry in spec.accounts.
//   3. Each keystore's top-level publicKey/secretKey form a valid
//      NodeIdentity (so loadOrCreateNodeIdentity can read the file).
//   4. Validator info in spec matches the keystore (nodePublicKey +
//      vrfPublicKey + stake all line up).
//   5. validatorCount option drives the size of the output.
//   6. Custom names propagate; default names are validator-N.
//   7. Custom timestamp + balance + stake values are honored.
//   8. Input validation rejects bad opts (zero validators, stake >
//      earned, sub-MIN_VALIDATOR_STAKE, names length mismatch, dup names).
//   9. writeGenesisSet writes the expected files at the expected paths
//      and the spec roundtrips through loadGenesisSpec.
//  10. End-to-end: write a set to disk, load via loadGenesisSpec,
//      apply via applyGenesisSpec, verify validators registered.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  buildGenesisSet,
  writeGenesisSet,
} from '../src/node/genesis-init.js';
import {
  loadGenesisSpec,
  applyGenesisSpec,
  validateGenesisSpec,
} from '../src/node/genesis-config.js';
import { deriveAccountId } from '../src/core/crypto.js';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { loadOrCreateNodeIdentity } from '../src/network/node-identity.js';
import { PRECISION } from '../src/core/constants.js';
import { MIN_VALIDATOR_STAKE } from '../src/core/consensus/registration.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

describe('Phase 48: Genesis-set generator', () => {
  // ── Spec is loadable by Session 41's loader ──────────────────────────

  it('output spec passes validateGenesisSpec', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 3 });
    // JSON round-trip to mimic disk path: validateGenesisSpec runs over
    // a parsed-from-string object.
    const parsed = JSON.parse(JSON.stringify(set.spec));
    const validated = validateGenesisSpec(parsed);
    assert.equal(validated.accounts.length, 3);
  });

  // ── Keystore <-> spec correspondence ─────────────────────────────────

  it('each keystore.accountId is deriveAccountId(account.publicKey)', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 2 });
    for (const ks of set.keystores) {
      assert.equal(ks.accountId, deriveAccountId(ks.account.publicKey));
    }
  });

  it('each keystore matches exactly one spec.accounts entry', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 4 });
    for (const ks of set.keystores) {
      const matches = set.spec.accounts.filter((a) => a.publicKey === ks.account.publicKey);
      assert.equal(matches.length, 1, `keystore for ${ks.name} must match exactly one spec account`);
      const entry = matches[0];
      assert.ok(entry.validator, 'genesis-set validators must have validator block');
      assert.equal(entry.validator!.nodePublicKey, ks.publicKey);
      assert.equal(entry.validator!.vrfPublicKey, ks.vrf.publicKey);
    }
  });

  it('keystore publicKey/secretKey form a valid NodeIdentity (top-level)', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 1 });
    const ks = set.keystores[0];
    // Both Ed25519 hex (32 bytes / 64 hex chars). publicKey is
    // independently verifiable; secretKey we just sanity-check.
    assert.match(ks.publicKey, /^[0-9a-f]{64}$/);
    assert.match(ks.secretKey, /^[0-9a-f]{64}$/);
  });

  // ── Options ──────────────────────────────────────────────────────────

  it('validatorCount controls keystore + spec.accounts length', () => {
    for (const n of [1, 2, 5]) {
      const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: n });
      assert.equal(set.keystores.length, n);
      assert.equal(set.spec.accounts.length, n);
    }
  });

  it('default names are validator-1, validator-2, ...', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 3 });
    assert.deepEqual(
      set.keystores.map((k) => k.name),
      ['validator-1', 'validator-2', 'validator-3'],
    );
  });

  it('custom names propagate to keystores in order', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 2, names: ['alice', 'bob'] });
    assert.deepEqual(
      set.keystores.map((k) => k.name),
      ['alice', 'bob'],
    );
  });

  it('genesisTimestamp option is honored', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 1, genesisTimestamp: 1714838400 });
    assert.equal(set.spec.genesisTimestamp, 1714838400);
  });

  it('initialEarnedDisplay + stakeDisplay convert to fixed-precision in spec', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 1, initialEarnedDisplay: 1000, stakeDisplay: 250 });
    const a = set.spec.accounts[0];
    // PRECISION = 10^8. 1000 display = 100_000_000_000 fixed.
    assert.equal(a.earnedBalance, (BigInt(1000) * PRECISION).toString());
    assert.equal(a.validator!.stake, (BigInt(250) * PRECISION).toString());
    // bigint sanity
    assert.equal(BigInt(a.earnedBalance), BigInt(1000) * PRECISION);
    assert.equal(BigInt(a.validator!.stake), BigInt(250) * PRECISION);
  });

  // ── Input validation ─────────────────────────────────────────────────

  it('rejects validatorCount < 1', () => {
    assert.throws(() => buildGenesisSet({ networkId: 'ae-test', validatorCount: 0 }), /positive integer/);
    assert.throws(() => buildGenesisSet({ networkId: 'ae-test', validatorCount: -1 }), /positive integer/);
  });

  it('rejects stakeDisplay > initialEarnedDisplay', () => {
    assert.throws(
      () => buildGenesisSet({ networkId: 'ae-test', validatorCount: 1, initialEarnedDisplay: 100, stakeDisplay: 200 }),
      /cannot exceed initialEarnedDisplay/,
    );
  });

  it('rejects stakeDisplay below MIN_VALIDATOR_STAKE in fixed units', () => {
    // MIN_VALIDATOR_STAKE is 10000n base units. With PRECISION = 10^8,
    // that's 0.0001 points of display value. Anything smaller trips
    // the floor. stakeDisplay 0.00005 converts to 5000n < 10000n.
    assert.throws(
      () =>
        buildGenesisSet({ networkId: 'ae-test',
          validatorCount: 1,
          initialEarnedDisplay: 0.001,
          stakeDisplay: 0.00005,
        }),
      /below MIN_VALIDATOR_STAKE/,
    );
    void MIN_VALIDATOR_STAKE; // referenced for future invariant-doc readers
  });

  it('rejects names array length mismatch', () => {
    assert.throws(
      () => buildGenesisSet({ networkId: 'ae-test', validatorCount: 3, names: ['only-two', 'names'] }),
      /names array length/,
    );
  });

  it('rejects duplicate names', () => {
    assert.throws(
      () => buildGenesisSet({ networkId: 'ae-test', validatorCount: 2, names: ['matt', 'matt'] }),
      /duplicate name/,
    );
  });

  // ── writeGenesisSet to disk ──────────────────────────────────────────

  it('writeGenesisSet emits genesis.json + keys/<accountId>.json files', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 2 });
    const outDir = mkdtempSync(join(tmpdir(), 'phase48-write-'));
    const { specPath, keystorePaths } = writeGenesisSet(outDir, set);

    assert.ok(existsSync(specPath));
    assert.equal(keystorePaths.length, 2);
    for (const ks of set.keystores) {
      const expectedPath = join(outDir, 'keys', `${ks.accountId}.json`);
      assert.ok(keystorePaths.includes(expectedPath));
      assert.ok(existsSync(expectedPath));
    }

    // Spec roundtrips through the Session 41 loader unchanged.
    const loaded = loadGenesisSpec(specPath);
    assert.equal(loaded.accounts.length, 2);
    assert.equal(loaded.genesisTimestamp, set.spec.genesisTimestamp);
  });

  it('keystore file contents match the in-memory keystore', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 1 });
    const outDir = mkdtempSync(join(tmpdir(), 'phase48-roundtrip-'));
    const { keystorePaths } = writeGenesisSet(outDir, set);
    const onDisk = JSON.parse(readFileSync(keystorePaths[0], 'utf8'));
    assert.deepEqual(onDisk, set.keystores[0]);
  });

  it('keystore file is loadable as NodeIdentity (top-level publicKey/secretKey)', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 1 });
    const outDir = mkdtempSync(join(tmpdir(), 'phase48-nodeid-'));
    const { keystorePaths } = writeGenesisSet(outDir, set);
    // loadOrCreateNodeIdentity reads the file as JSON and pulls
    // publicKey/secretKey. The extra fields (account, vrf, etc.) are
    // ignored. This is the runner's path — set AE_NODE_KEY_PATH to
    // the keystore file and the runner gets the right node identity.
    const id = loadOrCreateNodeIdentity(keystorePaths[0]);
    assert.equal(id.publicKey, set.keystores[0].publicKey);
    assert.equal(id.secretKey, set.keystores[0].secretKey);
  });

  // ── End-to-end: generate -> apply -> validators registered ──────────

  it('end-to-end: build set -> writeGenesisSet -> loadGenesisSpec -> applyGenesisSpec', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 3, names: ['a', 'b', 'c'] });
    const outDir = mkdtempSync(join(tmpdir(), 'phase48-e2e-'));
    const { specPath } = writeGenesisSet(outDir, set);

    const db = freshDb();
    const loaded = loadGenesisSpec(specPath);
    applyGenesisSpec(db, loaded);

    const vSet = new SqliteValidatorSet(db);
    const all = vSet.listAll();
    assert.equal(all.length, 3, 'three validators registered');

    // Every keystore appears as an active validator with the right keys
    for (const ks of set.keystores) {
      const v = vSet.findByAccountId(ks.accountId);
      assert.ok(v, `validator for ${ks.name} must be registered`);
      assert.equal(v!.nodePublicKey, ks.publicKey);
      assert.equal(v!.vrfPublicKey, ks.vrf.publicKey);
      assert.equal(v!.isActive, true);
    }
  });
});
