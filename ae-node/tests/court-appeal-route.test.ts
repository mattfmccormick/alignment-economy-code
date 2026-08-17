// POST /court/cases/:id/appeal — the route that makes appeals exist at all.
//
// fileAppeal had no production caller, so the entire appeal system was
// unreachable from both apps. A verdict was final regardless of what the white
// paper says, and the appeal settlement logic could never run because nothing
// could create an appeal to settle.
//
// fileAppeal checks the case is appealable but says nothing about WHO may
// appeal, so standing is enforced in the route: only the losing party has it.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, resolveCase, getCase,
} from '../src/court/court.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method, headers: bodyStr ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode!, data }); }
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

function keyed(db: DatabaseSync, percentHuman = 100) {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  updateBalance(db, r.account.id, 'earned_balance', pts(10_000));
  return { accountId: r.account.id, privateKey: kp.privateKey };
}

function miner(db: DatabaseSync, tier: 1 | 2 = 2) {
  const a = keyed(db);
  const m = registerMiner(db, a.accountId);
  if (tier === 2) setMinerTier(db, m.id, 2, 'setup');
  return { ...a, minerId: m.id };
}

function envelope(accountId: string, privateKey: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {};
  return { accountId, timestamp, signature: signPayload(payload, timestamp, privateKey), payload };
}

/** Run a case to a guilty verdict and return the parties. */
function guiltyCase(db: DatabaseSync) {
  const defendant = keyed(db, 80);
  const challenger = miner(db, 1);
  for (let i = 0; i < 26; i++) miner(db, 2);

  const c = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);
  escalateToFull(db, c.id);
  const jurors = selectJury(db, c.id, 'appeal-route');
  for (const j of jurors) submitVote(db, c.id, j, 'not_human');
  assert.equal(resolveCase(db, c.id), 'guilty');
  return { caseId: c.id, defendant, challenger };
}

describe('POST /court/cases/:id/appeal', () => {
  beforeEach(() => resetRateLimits());

  it('lets the losing defendant appeal a guilty verdict', async () => {
    const db = freshDb();
    const { caseId, defendant } = guiltyCase(db);

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/court/cases/${caseId}/appeal`,
      envelope(defendant.accountId, defendant.privateKey),
    );

    assert.equal(res.status, 200);
    assert.equal(res.data.data.appealOf, caseId);
    const appeal = getCase(db, res.data.data.case.id)!;
    assert.equal(appeal.level, 'appeal');
    assert.equal(appeal.appealOf, caseId);
    db.close();
  });

  it('refuses the winning challenger standing to appeal their own win', async () => {
    const db = freshDb();
    const { caseId, challenger } = guiltyCase(db);

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/court/cases/${caseId}/appeal`,
      envelope(challenger.accountId, challenger.privateKey),
    );

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'NO_STANDING');
    db.close();
  });

  it('refuses an uninvolved account', async () => {
    const db = freshDb();
    const { caseId } = guiltyCase(db);
    const stranger = keyed(db);

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/court/cases/${caseId}/appeal`,
      envelope(stranger.accountId, stranger.privateKey),
    );

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'NO_STANDING');
    db.close();
  });

  it('refuses an unsigned request', async () => {
    const db = freshDb();
    const { caseId } = guiltyCase(db);

    const res = await request(db && createApp(db), 'POST', `/api/v1/court/cases/${caseId}/appeal`, {
      accountId: 'nobody',
    });

    assert.equal(res.status, 401);
    db.close();
  });

  it('404s on an unknown case', async () => {
    const db = freshDb();
    const someone = keyed(db);
    const res = await request(
      createApp(db),
      'POST',
      '/api/v1/court/cases/does-not-exist/appeal',
      envelope(someone.accountId, someone.privateKey),
    );
    assert.equal(res.status, 404);
    db.close();
  });
});
