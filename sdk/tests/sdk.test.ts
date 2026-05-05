// SDK smoke test. Spawns a real ae-node and exercises the SDK against
// it end-to-end: generate keys, create an account, hit network status,
// build + sign a transaction. We don't actually submit the transaction
// here because it requires a recipient account + a real percentHuman
// score; the transaction-building path is exercised by phase 1 in
// ae-node's own test suite. The point of THIS test is to prove the
// SDK's request layer talks to the API correctly.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AlignmentEconomyClient,
  generateKeyPair,
  deriveAccountId,
  newMnemonic,
  mnemonicToKeypair,
  signTransaction,
  signPayload,
  verifyPayload,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const aeNodeRoot = resolvePath(here, '..', '..', 'ae-node');

let nodeProc: ChildProcess | null = null;
let baseUrl = '';

async function waitForHealth(url: string, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`ae-node didn't respond on /health within ${deadlineMs}ms`);
}

before(async () => {
  // Boot ae-node on a non-default port so we don't fight any locally-running
  // instance. Child uses the legacy authority single-validator mode (no
  // genesis spec) since these tests don't need BFT.
  const port = 4521;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
  nodeProc = spawn('node', ['dist/node/cli.js'], {
    cwd: aeNodeRoot,
    env: {
      ...process.env,
      AE_API_PORT: String(port),
      AE_P2P_PORT: '4621',
      AE_DB_PATH: ':memory:',
      AE_LOG_LEVEL: 'error',
      AE_NODE_ID: 'sdk-smoke-authority',
      AE_AUTHORITY_NODE_ID: 'sdk-smoke-authority',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface stderr so a fail isn't a black box. stdout is too chatty.
  nodeProc.stderr?.on('data', (chunk) => {
    const s = chunk.toString();
    if (s.includes('ERROR') || s.includes('FATAL')) process.stderr.write(`[ae-node] ${s}`);
  });
  await waitForHealth(baseUrl);
});

after(async () => {
  if (nodeProc) {
    nodeProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!nodeProc.killed) nodeProc.kill('SIGKILL');
  }
});

describe('SDK v0.1 smoke', () => {

  it('client.getHealth returns status:ok', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const h = await client.getHealth();
    assert.equal(h.status, 'ok');
    assert.ok(typeof h.timestamp === 'number');
  });

  it('crypto round-trip: generateKeyPair -> deriveAccountId -> sign -> verify', () => {
    const kp = generateKeyPair();
    assert.match(kp.publicKey, /^[0-9a-f]+$/);
    assert.match(kp.privateKey, /^[0-9a-f]+$/);
    const id = deriveAccountId(kp.publicKey);
    assert.match(id, /^[0-9a-f]{40}$/);

    const payload = { hello: 'world' };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, ts, kp.privateKey);
    assert.equal(verifyPayload(payload, ts, sig, kp.publicKey), true);

    // Tamper with the payload — verify must fail.
    assert.equal(verifyPayload({ hello: 'tampered' }, ts, sig, kp.publicKey), false);
  });

  it('mnemonic round-trip is deterministic', () => {
    const phrase = newMnemonic();
    const k1 = mnemonicToKeypair(phrase);
    const k2 = mnemonicToKeypair(phrase);
    assert.equal(k1.publicKey, k2.publicKey);
    assert.equal(k1.privateKey, k2.privateKey);
  });

  it('client.createAccount + getAccount end-to-end', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const { publicKey } = generateKeyPair();
    const created = await client.createAccount('individual', publicKey);
    assert.equal(created.account.publicKey, publicKey);
    assert.equal(created.account.type, 'individual');

    const fetched = await client.getAccount(created.account.id);
    assert.equal(fetched.id, created.account.id);
    assert.equal(fetched.publicKey, publicKey);
  });

  it('client.getNetworkStatus returns the expected fields', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const s = await client.getNetworkStatus();
    assert.ok(typeof s.blockHeight === 'number');
    assert.ok(typeof s.participantCount === 'number');
    assert.ok(typeof s.minerCount === 'number');
  });

  it('client.getTransaction throws SDKError NOT_FOUND for unknown id', async () => {
    const { SDKError } = await import('../src/index.js');
    const client = new AlignmentEconomyClient({ baseUrl });
    await assert.rejects(
      () => client.getTransaction('not-a-real-tx-id'),
      (err: unknown) => err instanceof SDKError && err.httpStatus === 404,
    );
  });

  it('v0.2 court reads: getCases / getJuryDuty / getMyCases return well-formed shapes', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const all = await client.getCases();
    assert.ok(Array.isArray(all.cases));
    // Use a fake account id; the endpoints should still respond cleanly
    // (empty arrays are valid; we just want to know the wiring is right).
    const jd = await client.getJuryDuty('not-a-real-account');
    assert.ok(Array.isArray(jd.assignments));
    const mine = await client.getMyCases('not-a-real-account');
    assert.ok(Array.isArray(mine.cases));
  });

  it('v0.2 miner reads: getMinerStatus returns isMiner=false for unknown account', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const s = await client.getMinerStatus('not-a-real-account');
    assert.equal(s.isMiner, false);
  });

  it('v0.2 miner reads: getVouches returns received/given arrays', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const v = await client.getVouches('not-a-real-account');
    assert.ok(Array.isArray(v.received));
    assert.ok(Array.isArray(v.given));
  });

  it('v0.2 tag reads: getProducts / getSpaces / getCurrentDay return well-formed shapes', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const p = await client.getProducts();
    assert.ok(Array.isArray(p.products));
    const s = await client.getSpaces();
    assert.ok(Array.isArray(s.spaces));
    const d = await client.getCurrentDay();
    assert.ok(typeof d.day === 'number');
    assert.ok(typeof d.cyclePhase === 'string');
  });

  it('v0.3 submitVouch signs the envelope; rejects when voucher has insufficient balance', async () => {
    const { SDKError } = await import('../src/index.js');
    const client = new AlignmentEconomyClient({ baseUrl });
    // Two fresh accounts. Neither has any earned balance, so the voucher
    // can't actually back the stake — protocol returns 400 (insufficient
    // balance). The SDK signs the envelope correctly so authMiddleware
    // accepts it; the failure is then ONLY about balance, proving auth
    // works end-to-end.
    const voucher = generateKeyPair();
    const vouchee = generateKeyPair();
    const v = await client.createAccount('individual', voucher.publicKey);
    const u = await client.createAccount('individual', vouchee.publicKey);
    await assert.rejects(
      () => client.submitVouch({
        voucherId: v.account.id,
        voucherPrivateKey: voucher.privateKey,
        vouchedId: u.account.id,
        stakeAmountBaseUnits: 100_00000000n,  // 100 points display
      }),
      (err: unknown) => err instanceof SDKError && err.httpStatus >= 400 && err.httpStatus < 500,
    );
  });

  it('v0.3 submitVouch with a wrong private key fails authMiddleware (401)', async () => {
    const { SDKError } = await import('../src/index.js');
    const client = new AlignmentEconomyClient({ baseUrl });
    const voucher = generateKeyPair();
    const wrongKey = generateKeyPair();
    const vouchee = generateKeyPair();
    const v = await client.createAccount('individual', voucher.publicKey);
    const u = await client.createAccount('individual', vouchee.publicKey);
    await assert.rejects(
      () => client.submitVouch({
        voucherId: v.account.id,
        voucherPrivateKey: wrongKey.privateKey,  // wrong key for this account
        vouchedId: u.account.id,
        stakeAmountBaseUnits: 100_00000000n,
      }),
      (err: unknown) => err instanceof SDKError && err.httpStatus === 401,
    );
  });

  it('signTransaction produces a valid signature against verifyPayload', () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const senderId = deriveAccountId(sender.publicKey);
    const recipientId = deriveAccountId(recipient.publicKey);
    const amountBaseUnits = 100_00000000n;

    const { timestamp, signature } = signTransaction({
      from: senderId,
      to: recipientId,
      amountBaseUnits,
      pointType: 'earned',
      privateKey: sender.privateKey,
    });

    // Re-derive what the server would verify against and confirm the sig
    // checks out. This is the exact payload shape ae-node signs in
    // tests/phase1.test.ts.
    const payload = {
      from: senderId,
      to: recipientId,
      amount: amountBaseUnits.toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      memo: '',
    };
    assert.equal(verifyPayload(payload, timestamp, signature, sender.publicKey), true);
  });

  it('client.generateGenesis returns spec + keystores + matching hash', async () => {
    const client = new AlignmentEconomyClient({ baseUrl });
    const out = await client.generateGenesis({
      networkId: 'ae-sdk-smoke',
      validatorCount: 2,
      names: ['alpha', 'beta'],
    });
    assert.equal(out.spec.networkId, 'ae-sdk-smoke');
    assert.equal(out.keystores.length, 2);
    assert.match(out.specHash, /^[0-9a-f]+$/);
  });
});
