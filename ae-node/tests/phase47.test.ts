// Phase 47: Genesis configuration (multi-operator bootstrap).
//
// Two laptops on the same AE network must start with byte-identical
// genesis state, or their P2P handshakes reject each other at
// genesisHash mismatch and they never peer. The fix: a JSON GenesisSpec
// pinning the genesis timestamp + initial accounts + initial validator
// set. Both operators load the same spec, run applyGenesisSpec on a
// fresh DB, and end up with identical state.
//
// Verified:
//   1. validateGenesisSpec accepts a well-formed spec and rejects every
//      class of malformed input (version, types, hex lengths, balance
//      vs. stake, duplicates).
//   2. genesisSpecHash is deterministic over (accounts ordered by
//      publicKey) so spec authors can compare hashes out-of-band
//      regardless of how they sorted their JSON.
//   3. applyGenesisSpec creates the deterministic genesis block.
//   4. applyGenesisSpec seeds accounts with the spec's balances at
//      spec.genesisTimestamp (no Date.now() leakage).
//   5. applyGenesisSpec registers validators from the spec, locking
//      stake and producing audit-log entries with deterministic
//      timestamps.
//   6. Two parallel DBs from the same spec are byte-identical across
//      the blocks, accounts, validators, and transaction_log tables —
//      this is the property that lets two laptops peer.
//   7. Idempotency: a second applyGenesisSpec on a DB that already has
//      a genesis block is a no-op.
//   8. loadGenesisSpec reads + validates from disk.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import {
  validateGenesisSpec,
  loadGenesisSpec,
  applyGenesisSpec,
  genesisSpecHash,
  type GenesisSpec,
} from '../src/node/genesis-config.js';
import { generateKeyPair, deriveAccountId } from '../src/core/crypto.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { getLatestBlock, blockStore } from '../src/core/block.js';
import { accountStore } from '../src/core/account.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { MIN_VALIDATOR_STAKE } from '../src/core/consensus/registration.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

/** Build a minimal valid spec with `n` validator accounts. */
function buildSpec(n: number, genesisTimestamp = 1714838400): {
  spec: GenesisSpec;
  identities: Array<{
    accountPub: string;
    accountPriv: string;
    nodePub: string;
    vrfPub: string;
  }>;
} {
  const identities = [];
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const acct = generateKeyPair();
    const node = generateNodeIdentity();
    const vrf = Ed25519VrfProvider.generateKeyPair();
    identities.push({
      accountPub: acct.publicKey,
      accountPriv: acct.privateKey,
      nodePub: node.publicKey,
      vrfPub: vrf.publicKey,
    });
    accounts.push({
      publicKey: acct.publicKey,
      type: 'individual' as const,
      percentHuman: 100,
      earnedBalance: pts(500).toString(),
      validator: {
        nodePublicKey: node.publicKey,
        vrfPublicKey: vrf.publicKey,
        stake: pts(200).toString(),
      },
    });
  }
  return {
    spec: { version: 2, networkId: 'ae-test', genesisTimestamp, genesisDay: 0, accounts },
    identities,
  };
}

describe('Phase 47: Genesis configuration', () => {
  // ── Validation ──────────────────────────────────────────────────────

  it('validateGenesisSpec accepts a well-formed minimal spec', () => {
    const { spec } = buildSpec(2);
    const out = validateGenesisSpec(JSON.parse(JSON.stringify(spec)));
    assert.equal(out.version, 2);
    assert.equal(out.networkId, 'ae-test');
    assert.equal(out.accounts.length, 2);
  });

  it('rejects version != 2', () => {
    const { spec } = buildSpec(1);
    const bad = { ...spec, version: 1 };
    assert.throws(() => validateGenesisSpec(bad), /version must be 2/);
  });

  it('rejects missing or invalid networkId', () => {
    const { spec } = buildSpec(1);
    assert.throws(() => validateGenesisSpec({ ...spec, networkId: undefined }), /networkId/);
    assert.throws(() => validateGenesisSpec({ ...spec, networkId: '' }), /networkId/);
    assert.throws(() => validateGenesisSpec({ ...spec, networkId: 'AE-MAINNET' }), /networkId/); // uppercase
    assert.throws(() => validateGenesisSpec({ ...spec, networkId: 'ae mainnet' }), /networkId/); // space
    assert.throws(() => validateGenesisSpec({ ...spec, networkId: 'ab' }), /networkId/); // too short (2)
  });

  it('rejects non-positive genesisTimestamp', () => {
    const { spec } = buildSpec(1);
    assert.throws(
      () => validateGenesisSpec({ ...spec, genesisTimestamp: 0 }),
      /genesisTimestamp must be a positive integer/,
    );
    assert.throws(
      () => validateGenesisSpec({ ...spec, genesisTimestamp: -1 }),
      /genesisTimestamp must be a positive integer/,
    );
  });

  it('rejects empty accounts array', () => {
    const bad = { version: 2, networkId: 'ae-test', genesisTimestamp: 1, genesisDay: 0, accounts: [] };
    assert.throws(() => validateGenesisSpec(bad), /accounts must be a non-empty array/);
  });

  it('rejects duplicate publicKey across accounts', () => {
    const { spec } = buildSpec(2);
    const bad = {
      ...spec,
      accounts: [spec.accounts[0], { ...spec.accounts[1], publicKey: spec.accounts[0].publicKey }],
    };
    assert.throws(() => validateGenesisSpec(bad), /duplicate publicKey/);
  });

  it('rejects duplicate nodePublicKey across validators', () => {
    const { spec } = buildSpec(2);
    const bad = JSON.parse(JSON.stringify(spec));
    bad.accounts[1].validator.nodePublicKey = bad.accounts[0].validator.nodePublicKey;
    assert.throws(() => validateGenesisSpec(bad), /duplicate nodePublicKey/);
  });

  it('rejects validator nodePublicKey that is not 64 hex chars', () => {
    const { spec } = buildSpec(1);
    const bad = JSON.parse(JSON.stringify(spec));
    bad.accounts[0].validator.nodePublicKey = 'tooshort';
    assert.throws(() => validateGenesisSpec(bad), /nodePublicKey must be 64 hex chars/);
  });

  it('rejects stake below MIN_VALIDATOR_STAKE', () => {
    const { spec } = buildSpec(1);
    const bad = JSON.parse(JSON.stringify(spec));
    bad.accounts[0].validator.stake = (MIN_VALIDATOR_STAKE - 1n).toString();
    assert.throws(() => validateGenesisSpec(bad), /below MIN_VALIDATOR_STAKE/);
  });

  it('rejects stake exceeding earnedBalance', () => {
    const { spec } = buildSpec(1);
    const bad = JSON.parse(JSON.stringify(spec));
    bad.accounts[0].earnedBalance = pts(50).toString();
    bad.accounts[0].validator.stake = pts(200).toString();
    assert.throws(() => validateGenesisSpec(bad), /exceeds earnedBalance/);
  });

  // ── genesisSpecHash determinism ─────────────────────────────────────

  it('genesisSpecHash is independent of account order in the spec', () => {
    const { spec } = buildSpec(3);
    const reordered: GenesisSpec = {
      ...spec,
      accounts: [...spec.accounts].reverse(),
    };
    assert.equal(genesisSpecHash(spec), genesisSpecHash(reordered));
  });

  it('genesisSpecHash changes if any account field changes', () => {
    const { spec } = buildSpec(2);
    const original = genesisSpecHash(spec);
    const tweaked = JSON.parse(JSON.stringify(spec)) as GenesisSpec;
    tweaked.accounts[0].earnedBalance = pts(501).toString();
    assert.notEqual(genesisSpecHash(tweaked), original);
  });

  // ── applyGenesisSpec ────────────────────────────────────────────────

  it('creates the deterministic genesis block at spec.genesisTimestamp', () => {
    const { spec } = buildSpec(1, 1714838400);
    const db = freshDb();
    const block = applyGenesisSpec(db, spec);
    assert.equal(block.number, 0);
    assert.equal(block.day, spec.genesisDay);
    assert.equal(block.timestamp, spec.genesisTimestamp);

    const fromDb = blockStore(db).findByNumber(0)!;
    assert.equal(fromDb.hash, block.hash);
  });

  it('seeds accounts with spec balances + spec timestamp as createdAt', () => {
    const { spec } = buildSpec(2);
    const db = freshDb();
    applyGenesisSpec(db, spec);

    const aStore = accountStore(db);
    for (const a of spec.accounts) {
      const id = deriveAccountId(a.publicKey);
      const account = aStore.findById(id);
      assert.ok(account, 'account must exist');
      assert.equal(account!.publicKey, a.publicKey);
      assert.equal(account!.percentHuman, a.percentHuman);
      assert.equal(account!.createdAt, spec.genesisTimestamp);
      // earned was reduced by stake and locked balance equals stake
      const expectedEarned = BigInt(a.earnedBalance) - BigInt(a.validator!.stake);
      assert.equal(account!.earnedBalance, expectedEarned);
      assert.equal(account!.lockedBalance, BigInt(a.validator!.stake));
    }
  });

  it('registers validators with deterministic registered_at = genesisTimestamp', () => {
    const { spec } = buildSpec(3);
    const db = freshDb();
    applyGenesisSpec(db, spec);

    const set = new SqliteValidatorSet(db);
    const all = set.listAll();
    assert.equal(all.length, 3, 'three validators registered');
    for (const v of all) {
      assert.equal(v.registeredAt, spec.genesisTimestamp);
      assert.equal(v.isActive, true);
      assert.equal(v.deregisteredAt, null);
    }
  });

  // ── Determinism: two parallel DBs from the same spec ────────────────

  it('two DBs from the same spec produce byte-identical genesis state', () => {
    const { spec } = buildSpec(3);

    const db1 = freshDb();
    const db2 = freshDb();
    applyGenesisSpec(db1, spec);
    applyGenesisSpec(db2, spec);

    function snapshot(db: DatabaseSync): unknown {
      const blocks = db.prepare('SELECT * FROM blocks ORDER BY number').all();
      const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
      const validators = db.prepare('SELECT * FROM validators ORDER BY account_id').all();
      // Drop transaction_log row id (it's a UUID, intentionally non-deterministic)
      // but compare the rest of the fields.
      const log = db
        .prepare(
          `SELECT account_id, change_type, point_type, amount, balance_before,
                  balance_after, timestamp FROM transaction_log
                  ORDER BY account_id, change_type, point_type`,
        )
        .all();
      return { blocks, accounts, validators, log };
    }

    const s1 = snapshot(db1);
    const s2 = snapshot(db2);
    assert.deepEqual(s1, s2);

    // The block hashes specifically must agree — that's the property
    // P2P handshakes use to confirm operators are on the same network.
    const hash1 = getLatestBlock(db1)!.hash;
    const hash2 = getLatestBlock(db2)!.hash;
    assert.equal(hash1, hash2, 'genesis hash must agree across operators');
  });

  // ── Idempotency ─────────────────────────────────────────────────────

  it('applying twice on a DB with an existing genesis is a no-op', () => {
    const { spec } = buildSpec(2);
    const db = freshDb();

    const first = applyGenesisSpec(db, spec);
    const accountsBefore = db.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number };
    const validatorsBefore = db.prepare('SELECT COUNT(*) as n FROM validators').get() as { n: number };

    const second = applyGenesisSpec(db, spec);
    const accountsAfter = db.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number };
    const validatorsAfter = db.prepare('SELECT COUNT(*) as n FROM validators').get() as { n: number };

    assert.equal(first.hash, second.hash, 'returned block hash unchanged');
    assert.equal(accountsAfter.n, accountsBefore.n, 'no duplicate accounts');
    assert.equal(validatorsAfter.n, validatorsBefore.n, 'no duplicate validators');
  });

  // ── loadGenesisSpec from disk ───────────────────────────────────────

  it('loadGenesisSpec reads JSON from disk and validates it', () => {
    const { spec } = buildSpec(1);
    const dir = mkdtempSync(join(tmpdir(), 'phase47-'));
    const path = join(dir, 'genesis.json');
    writeFileSync(path, JSON.stringify(spec, null, 2), 'utf8');

    const loaded = loadGenesisSpec(path);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.accounts.length, 1);
    assert.equal(loaded.accounts[0].publicKey, spec.accounts[0].publicKey);
  });

  it('loadGenesisSpec throws on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase47-bad-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not valid', 'utf8');
    assert.throws(() => loadGenesisSpec(path), /not valid JSON/);
  });

  it('loadGenesisSpec throws on schema violation with a useful message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase47-schema-'));
    const path = join(dir, 'wrong-version.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 99, genesisTimestamp: 1, genesisDay: 0, accounts: [] }),
      'utf8',
    );
    assert.throws(() => loadGenesisSpec(path), /version must be 2/);
  });
});
