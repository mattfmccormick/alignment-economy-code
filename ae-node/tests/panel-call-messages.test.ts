// Live-call introduction: a miner sends the applicant of an open verification
// panel a note (usually a meeting link made on the miner's own call tool), and
// only the two of them can read it back. The platform hosts no call.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount } from '../src/core/account.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { registerMiner } from '../src/mining/registration.js';
import { verificationStore } from '../src/verification/panel.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';

type Keys = { accountId: string; privateKey: string };

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function makeAccount(db: DatabaseSync, percentHuman = 100): Keys {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  return { accountId: r.account.id, privateKey: kp.privateKey };
}

function signed(who: Keys, payload: object) {
  const timestamp = Math.floor(Date.now() / 1000);
  return { accountId: who.accountId, timestamp, signature: signPayload(payload, timestamp, who.privateKey), payload };
}

function post(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        `http://127.0.0.1:${port}/api/v1${path}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode!, data: JSON.parse(data) });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(bodyStr);
      req.end();
    });
  });
}

function setup() {
  const db = freshDb();
  const applicant = makeAccount(db, 0);
  const miner = makeAccount(db);
  registerMiner(db, miner.accountId);
  const outsider = makeAccount(db);
  const panelId = 'panel-1';
  verificationStore(db).insertPanel({ id: panelId, accountId: applicant.accountId, createdAt: 1 });
  return { db, app: createApp(db), applicant, miner, outsider, panelId };
}

describe('Panel call messages', () => {
  beforeEach(() => resetRateLimits());

  it('a miner sends a meeting link and only the applicant and miner can read it', async () => {
    const { db, app, applicant, miner, outsider, panelId } = setup();
    const link = 'Free at 3pm? https://meet.example.com/abc-123';

    const sent = await post(app, `/verification/panels/${panelId}/call-messages`, signed(miner, { text: `  ${link}  ` }));
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.data.message.text, link);
    assert.equal(sent.data.data.message.toId, applicant.accountId);

    const forApplicant = await post(app, '/verification/call-messages/mine', signed(applicant, {}));
    assert.equal(forApplicant.status, 200);
    assert.deepEqual(forApplicant.data.data.messages.map((m: { text: string }) => m.text), [link]);

    const forMiner = await post(app, '/verification/call-messages/mine', signed(miner, {}));
    assert.equal(forMiner.data.data.messages.length, 1);

    const forOutsider = await post(app, '/verification/call-messages/mine', signed(outsider, {}));
    assert.equal(forOutsider.data.data.messages.length, 0);
    db.close();
  });

  it('refuses a sender who is not a miner, and a finished review', async () => {
    const { db, app, outsider, miner, panelId } = setup();

    const notMiner = await post(app, `/verification/panels/${panelId}/call-messages`, signed(outsider, { text: 'https://x.test' }));
    assert.equal(notMiner.status, 403);
    assert.equal(notMiner.data.error.code, 'NOT_A_MINER');

    db.prepare("UPDATE verification_panels SET status = 'complete' WHERE id = ?").run(panelId);
    const done = await post(app, `/verification/panels/${panelId}/call-messages`, signed(miner, { text: 'https://x.test' }));
    assert.equal(done.status, 400);
    assert.equal(done.data.error.code, 'PANEL_COMPLETE');
    db.close();
  });

  it('refuses an unsigned read', async () => {
    const { db, app, applicant } = setup();
    const r = await post(app, '/verification/call-messages/mine', { accountId: applicant.accountId });
    assert.equal(r.status, 401);
    db.close();
  });
});
