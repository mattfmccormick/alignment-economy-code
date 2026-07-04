// C2: the API serves a machine-readable OpenAPI contract generated from the
// same zod schemas the write routes enforce, and the checked-in docs/openapi.json
// is kept in sync.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { buildOpenApiSpec } from '../src/api/openapi.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function get(app: ReturnType<typeof createApp>, path: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      http
        .get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode!, data: JSON.parse(data) });
          });
        })
        .on('error', (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

describe('C2: OpenAPI contract', () => {
  it('serves a 3.1.0 spec at /api/v1/openapi.json', async () => {
    const app = createApp(freshDb());
    const r = await get(app, '/api/v1/openapi.json');
    assert.equal(r.status, 200);
    assert.equal(r.data.openapi, '3.1.0');
    assert.ok(r.data.paths['/api/v1/transactions'], 'spec should document /transactions');
  });

  it('documents the transaction amount as a base-unit integer string', async () => {
    const spec = buildOpenApiSpec() as any;
    const amount =
      spec.paths['/api/v1/transactions'].post.requestBody.content['application/json'].schema
        .properties.payload.properties.amount;
    assert.equal(amount.type, 'string');
    assert.equal(amount.pattern, '^[1-9]\\d*$');
  });

  it('checked-in docs/openapi.json matches the generated spec (run npm run gen:openapi if this fails)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = resolve(here, '../../docs/openapi.json');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, buildOpenApiSpec());
  });
});
