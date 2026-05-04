// Phase 66: founder route — generate a genesis ceremony from the API.
//
// The desktop wallet's "Start a new network" flow calls
// POST /api/v1/founder/generate-genesis instead of dropping the user to
// the `npm run genesis:init` CLI. The route is a thin wrapper around
// the existing `buildGenesisSet` library function plus input validation.
//
// What this phase tests:
//   - Happy path: returns spec + keystores + specHash matching a direct
//     `genesisSpecHash(spec)` call (the wallet uses this hash for the
//     "compare out-of-band" UX, so it MUST match what other tooling
//     produces from the same spec).
//   - Schema: per-validator keystore has all the fields the wallet's
//     `saveFounderWallet` and the operator's `validator:setup` need.
//   - Validation rejects bad inputs (no networkId, malformed networkId,
//     wrong validator count, names/count mismatch).
//   - The wallet's first keystore is the founder's identity. Distinct
//     accountIds across the keystore set (no collisions).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { genesisSpecHash } from '../src/node/genesis-config.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function startServer(db: DatabaseSync): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const app = createApp(db);
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface GenesisResponse {
  success: boolean;
  data?: {
    spec: { networkId: string; validators: unknown[] };
    keystores: Array<{
      name: string;
      accountId: string;
      publicKey: string;
      secretKey: string;
      account: { publicKey: string; privateKey: string };
      vrf: { publicKey: string; secretKey: string };
    }>;
    specHash: string;
  };
  error?: { code: string; message: string };
}

async function postGenesis(port: number, body: unknown): Promise<{ status: number; json: GenesisResponse }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/founder/generate-genesis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as GenesisResponse;
  return { status: res.status, json };
}

describe('Phase 66: founder/generate-genesis route', () => {

  it('happy path: returns spec, keystores, and a specHash matching genesisSpecHash(spec)', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);

    const { status, json } = await postGenesis(port, {
      networkId: 'ae-devnet-test',
      validatorCount: 3,
      names: ['founder', 'invitee-1', 'invitee-2'],
    });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.ok(json.data);
    assert.equal(json.data.spec.networkId, 'ae-devnet-test');
    assert.equal(json.data.keystores.length, 3);

    // Spec hash matches an independent computation. The wallet UI surfaces
    // this hash so operators compare out-of-band; if the route's hash
    // diverged from the canonical one, that confirmation would be wrong.
    const expectedHash = genesisSpecHash(json.data.spec as never);
    assert.equal(json.data.specHash, expectedHash);

    await stopServer(server);
    db.close();
  });

  it('keystore shape includes everything the wallet + validator:setup need', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);

    const { json } = await postGenesis(port, { networkId: 'ae-devnet-shape', validatorCount: 2 });
    assert.equal(json.success, true);
    const ks = json.data!.keystores[0];

    assert.equal(typeof ks.name, 'string');
    assert.match(ks.accountId, /^[0-9a-f]{40}$/);
    assert.match(ks.publicKey, /^[0-9a-f]+$/);
    assert.match(ks.secretKey, /^[0-9a-f]+$/);
    assert.match(ks.account.publicKey, /^[0-9a-f]+$/);
    assert.match(ks.account.privateKey, /^[0-9a-f]+$/);
    assert.match(ks.vrf.publicKey, /^[0-9a-f]+$/);
    assert.match(ks.vrf.secretKey, /^[0-9a-f]+$/);

    await stopServer(server);
    db.close();
  });

  it('all keystore accountIds are distinct (no collisions across validators)', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);

    const { json } = await postGenesis(port, { networkId: 'ae-devnet-distinct', validatorCount: 5 });
    const ids = new Set(json.data!.keystores.map((k) => k.accountId));
    assert.equal(ids.size, 5);

    await stopServer(server);
    db.close();
  });

  it('rejects missing networkId', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { status, json } = await postGenesis(port, { validatorCount: 2 });
    assert.equal(status, 400);
    assert.equal(json.success, false);
    assert.equal(json.error?.code, 'INVALID_NETWORK_ID');
    await stopServer(server);
    db.close();
  });

  it('rejects malformed networkId (uppercase)', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { status, json } = await postGenesis(port, { networkId: 'AE-DEVNET' });
    assert.equal(status, 400);
    assert.equal(json.error?.code, 'INVALID_NETWORK_ID');
    await stopServer(server);
    db.close();
  });

  it('rejects validatorCount > MAX_VALIDATORS (50)', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { status, json } = await postGenesis(port, { networkId: 'ae-devnet-big', validatorCount: 51 });
    assert.equal(status, 400);
    assert.equal(json.error?.code, 'VALIDATOR_COUNT_TOO_LARGE');
    await stopServer(server);
    db.close();
  });

  it('rejects names/validatorCount mismatch', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { status, json } = await postGenesis(port, {
      networkId: 'ae-devnet-mismatch',
      validatorCount: 3,
      names: ['just-one'],
    });
    assert.equal(status, 400);
    assert.equal(json.error?.code, 'NAMES_LENGTH_MISMATCH');
    await stopServer(server);
    db.close();
  });
});
