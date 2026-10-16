// POST /court/cases/:id/appeal — the route that makes appeals exist at all.
//
// fileAppeal had no production caller, so the entire appeal system was
// unreachable from both apps. A verdict was final regardless of what the white
// paper says, and the appeal settlement logic could never run because nothing
// could create an appeal to settle.
//
// fileAppeal checks the case is appealable but says nothing about WHO may
// appeal, so standing is enforced in the route: only the losing party has it.
//
// Filing an appeal seats no jury. The appeal waits in `appeal_open` and the
// next day-cycle sweep draws a jury the same size as the first, from miners
// who did not sit on it, so the appellant cannot pick the block that seats it.
// An appeal is only possible while the verdict is still pending: once the
// window closes and the case settles, it is final.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, resolveCase, getCase,
  expireCourtDeadlines, courtStore,
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
const now = () => Math.floor(Date.now() / 1000);

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

/** Run a case to a (still pending) guilty verdict and return the parties. */
function guiltyCase(db: DatabaseSync) {
  const defendant = keyed(db, 80);
  const challenger = miner(db, 1);
  for (let i = 0; i < 26; i++) miner(db, 2);

  const c = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);
  escalateToFull(db, c.id);
  const jurors = selectJury(db, c.id, 'appeal-route');
  for (const j of jurors) submitVote(db, c.id, j, 'not_human');
  assert.equal(resolveCase(db, c.id), 'guilty');
  assert.equal(getCase(db, c.id)!.status, 'verdict_pending');
  return { caseId: c.id, defendant, challenger, jurors };
}

describe('POST /court/cases/:id/appeal', () => {
  beforeEach(() => resetRateLimits());

  it('lets the losing defendant appeal a guilty verdict; the next sweep seats a fresh jury of the same size', async () => {
    const db = freshDb();
    const { caseId, defendant, jurors } = guiltyCase(db);

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/court/cases/${caseId}/appeal`,
      envelope(defendant.accountId, defendant.privateKey),
    );

    assert.equal(res.status, 200);
    assert.equal(res.data.data.appealOf, caseId);
    const appealId = res.data.data.case.id;
    const appeal = getCase(db, appealId)!;
    assert.equal(appeal.level, 'appeal');
    assert.equal(appeal.appealOf, caseId);
    assert.equal(appeal.status, 'appeal_open');
    assert.equal(
      courtStore(db).findJurorsByCase(appealId).length,
      0,
      'filing the appeal must not seat a jury; the sweep does',
    );
    // Nothing has settled while the appeal is pending.
    assert.equal(getCase(db, caseId)!.status, 'verdict_pending');
    assert.equal(getAccount(db, defendant.accountId)!.isActive, true);
    assert.equal(getAccount(db, defendant.accountId)!.isEscrowed, true);

    const sweep = expireCourtDeadlines(db, now() + 60);
    assert.deepEqual(sweep.seated, [appealId]);
    assert.equal(getCase(db, appealId)!.status, 'court_voting');
    const appealJurors = courtStore(db).findJurorsByCase(appealId).map((j) => j.minerId);
    assert.equal(appealJurors.length, jurors.length, 'an appeal jury is the same size as the first');
    assert.equal(
      appealJurors.filter((m) => jurors.includes(m)).length,
      0,
      'nobody who sat on the first jury sits on the appeal',
    );
    db.close();
  });

  it('refuses an appeal once the verdict has settled', async () => {
    const db = freshDb();
    const { caseId, defendant } = guiltyCase(db);

    // No appeal inside the window: the next sweep after it settles the case.
    const out = expireCourtDeadlines(db, now() + 8 * 86400);
    assert.deepEqual(out.settled, [caseId]);
    assert.equal(getCase(db, caseId)!.status, 'court_verdict');

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/court/cases/${caseId}/appeal`,
      envelope(defendant.accountId, defendant.privateKey),
    );

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VERDICT_FINAL');
    assert.equal(courtStore(db).findAppealsOf(caseId).length, 0);
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
