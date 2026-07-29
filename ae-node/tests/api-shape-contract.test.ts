// API shape contract — the exact JSON shapes the frontends (ae-app, ae-miner,
// explorer) hand-declare in their local type files. The frontends do NOT share
// types with this package, so nothing stops their declared shapes drifting
// from what these routes actually send. That drift is not hypothetical: the
// miner Dashboard/Income/Audit pages once declared `account.balances.{active}`
// (nested) while GET /accounts/:id sends flat `activeBalance` fields, and
// `evidenceScore.score` as a number while the route sends a breakdown object.
// Both mismatches blanked every authenticated miner screen while all unit
// tests stayed green.
//
// This suite pins the wire shapes. If a route's response shape changes, a
// failure here is the reminder to update ae-app/src/lib/types.ts and
// ae-miner/src/lib/api.ts in the same commit.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { createAccount } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import { createApp } from '../src/api/server.js';

let db: DatabaseSync;
let server: Server;
let base: string;
let account: ReturnType<typeof createAccount>;

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path} should 200`);
  return res.json();
}

// Assert `obj` has exactly the expected typeof for each key. `expected` maps
// key -> 'string' | 'number' | 'boolean' | 'object' | 'array'.
function assertShape(obj: any, expected: Record<string, string>, label: string): void {
  for (const [key, type] of Object.entries(expected)) {
    assert.ok(key in obj, `${label}: missing key "${key}"`);
    if (type === 'array') {
      assert.ok(Array.isArray(obj[key]), `${label}.${key} should be an array`);
    } else {
      assert.equal(typeof obj[key], type, `${label}.${key} should be ${type}`);
    }
  }
}

describe('API shape contract (frontend type drift guard)', () => {
  before(async () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    initializeSchema(db);
    seedParams(db);
    createGenesisBlock(db);
    account = createAccount(db, 'individual', 1, 100);
    registerMiner(db, account.account.id);

    server = createServer(createApp(db));
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    base = `http://127.0.0.1:${port}/api/v1`;
  });

  after(() => { server.close(); });

  it('GET /accounts/:id — flat balance fields, never a nested `balances` object', async () => {
    const body = await getJson(`/accounts/${account.account.id}`);
    assert.equal(body.success, true);
    assertShape(body.data, {
      id: 'string',
      type: 'string',
      // The five balances are FLAT base-unit strings. The miner app once
      // declared them as a nested `balances` object and crashed on load.
      activeBalance: 'string',
      supportiveBalance: 'string',
      ambientBalance: 'string',
      earnedBalance: 'string',
      lockedBalance: 'string',
      percentHuman: 'number',
      joinedDay: 'number',
      isActive: 'boolean',
      isEscrowed: 'boolean',
      percentOfEconomy: 'number',
      dailyAllocationEligible: 'boolean',
      spendMultiplier: 'number',
    }, 'account');
    assert.ok(!('balances' in body.data), 'account must NOT have a nested `balances` key');
  });

  it('GET /miners/evidence/score/:id — score is a breakdown object, not a number', async () => {
    const body = await getJson(`/miners/evidence/score/${account.account.id}`);
    // Unwrapped route (miner api client wraps it): { score, vouchCount }.
    assertShape(body, { score: 'object', vouchCount: 'number' }, 'evidenceScore');
    // The miner Dashboard/Audit once rendered `score` directly as a React
    // child. Pin the object shape it must instead read totalScore from.
    assertShape(body.score, { totalScore: 'number', breakdown: 'object' }, 'evidenceScore.score');
    assertShape(body.score.breakdown, { tierA: 'number', tierB: 'number', tierC: 'number' }, 'breakdown');
  });

  it('GET /miners/status/:id — isMiner flag plus camelCase miner row', async () => {
    const body = await getJson(`/miners/status/${account.account.id}`);
    assert.equal(body.isMiner, true);
    // camelCase, registeredAt is a unix-seconds NUMBER. The miner app once
    // declared snake_case (`is_active`, `registered_at`) here, which made the
    // Dashboard show "Inactive / Registered --" and a 0% uptime gauge for a
    // real active miner.
    assertShape(body.miner, {
      id: 'string',
      accountId: 'string',
      tier: 'number',
      isActive: 'boolean',
      registeredAt: 'number',
    }, 'miner');
    assert.ok(!('account_id' in body.miner), 'miner row is camelCase, not snake_case');

    const none = await getJson(`/miners/status/does-not-exist`);
    assert.equal(none.isMiner, false);
  });

  it('GET /network/status — the stats grid fields both apps render', async () => {
    const body = await getJson('/network/status');
    assert.equal(body.success, true);
    assertShape(body.data, {
      currentDay: 'number',
      blockHeight: 'number',
      participantCount: 'number',
      minerCount: 'number',
      totalEarnedPool: 'string',
      targetTotal: 'string',
      transactionsToday: 'number',
      feePoolBalance: 'string',
    }, 'networkStatus');
  });

  it('GET /accounts/:id/ledger — snake_case entries with string amounts', async () => {
    const body = await getJson(`/accounts/${account.account.id}/ledger`);
    assert.equal(body.success, true);
    assertShape(body.data, { entries: 'array', total: 'number', page: 'number', limit: 'number' }, 'ledger');
    // Entry shape is pinned by ledger-endpoint.test.ts when entries exist;
    // here we only pin the envelope the Income/Audit pages paginate on.
  });

  it('GET /accounts/:id/share-history — points of {day, date, percentOfEconomy}', async () => {
    const body = await getJson(`/accounts/${account.account.id}/share-history`);
    assert.equal(body.success, true);
    assertShape(body.data, { points: 'array', currentDay: 'number', joinedDay: 'number' }, 'shareHistory');
    assert.ok(body.data.points.length >= 1, 'at least today\'s point');
    assertShape(body.data.points[0], { day: 'number', date: 'string', percentOfEconomy: 'number' }, 'sharePoint');
    assert.match(body.data.points[0].date, /^\d{4}-\d{2}-\d{2}$/, 'date is YYYY-MM-DD');
  });
});
