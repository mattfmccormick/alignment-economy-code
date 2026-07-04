// C1: every response carries a request id (X-Request-Id header), error bodies
// echo it so a user can quote it, and an incoming id is honored for tracing
// across services.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method, headers: { ...(bodyStr ? { 'Content-Type': 'application/json' } : {}), ...headers } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, data: JSON.parse(data), headers: res.headers });
            } catch {
              resolve({ status: res.statusCode!, data, headers: res.headers });
            }
          });
        },
      );
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

describe('C1: request id + structured errors', () => {
  it('sets an X-Request-Id header on every response', async () => {
    const app = createApp(freshDb());
    const r = await request(app, 'GET', '/api/v1/health');
    assert.ok(r.headers['x-request-id'], 'expected an x-request-id header');
  });

  it('echoes an error response body requestId that matches the header', async () => {
    const app = createApp(freshDb());
    // A malformed transaction body triggers the validation gate -> 400.
    const r = await request(app, 'POST', '/api/v1/transactions', {
      accountId: 'x',
      timestamp: Math.floor(Date.now() / 1000),
      signature: 'x',
      payload: { to: 'y', amount: 'not-a-number', pointType: 'active' },
    });
    assert.equal(r.status, 400);
    assert.ok(r.data?.error?.requestId, 'error body should carry a requestId');
    assert.equal(r.data.error.requestId, r.headers['x-request-id']);
  });

  it('honors an incoming X-Request-Id for cross-service tracing', async () => {
    const app = createApp(freshDb());
    const traceId = 'trace-abc-123';
    const r = await request(app, 'GET', '/api/v1/health', undefined, { 'X-Request-Id': traceId });
    assert.equal(r.headers['x-request-id'], traceId);
  });
});
