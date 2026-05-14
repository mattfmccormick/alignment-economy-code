// SDK platform client smoke test.
//
// Boots a real platform-server (the custody service we built in Phases
// 1-4) over an ephemeral port, exercises the full signup -> signin ->
// signout cycle, then runs the recovery flow end to end (start ->
// verify -> peek + complete -> signin with the new password). Lock-in
// for what the wallet UI will rely on.
//
// Why a full integration test and not unit tests: the whole point of
// the platform client is to glue the wire calls to the right crypto.
// The crypto pieces are individually correct (Phase 1 platform-server
// tests proved that). What matters is the end-to-end shape: a fresh
// signup yields a session that lets you sign in, decrypt your vault,
// recover, and end up with a valid new session under the new password.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PlatformClient, PlatformError } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformRoot = resolvePath(here, '..', '..', 'platform-server');

let serverProc: ChildProcess | null = null;
let baseUrl = '';

before(async () => {
  // Pick a random ephemeral port to avoid collision with any running
  // platform-server. We do the bind ourselves by handing the port to
  // the child via env.
  const net = await import('node:net');
  const port = await new Promise<number>((resolve, reject) => {
    const sock = net.createServer().listen(0, () => {
      const p = (sock.address() as { port: number }).port;
      sock.close((e) => (e ? reject(e) : resolve(p)));
    });
  });

  const dataDir = mkdtempSync(join(tmpdir(), 'sdk-platform-test-'));
  // Use npx tsx to launch — same way the package's `npm run dev` does.
  // Cross-platform: on Windows npx resolves to npx.cmd; shell: true picks
  // that up. Inheriting cwd to platformRoot ensures the relative
  // src/index.ts path resolves correctly.
  serverProc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', 'src/index.ts'],
    {
      cwd: platformRoot,
      env: {
        ...process.env,
        AE_PLATFORM_PORT: String(port),
        AE_PLATFORM_DB_PATH: join(dataDir, 'platform.db'),
        AE_PLATFORM_EMAIL_MODE: 'dev',
        AE_PLATFORM_ALLOW_TEST_NOW: '1',
        AE_PLATFORM_RECOVERY_COOLDOWN_SECONDS: '86400',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    },
  );
  serverProc.stdout?.on('data', (chunk) => process.stdout.write(`[platform-server] ${chunk}`));
  serverProc.stderr?.on('data', (chunk) => process.stderr.write(`[platform-server ERR] ${chunk}`));

  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  // Wait for /health to respond.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('platform-server did not start within 15s');
});

after(async () => {
  if (!serverProc || serverProc.killed) return;
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    serverProc!.once('exit', onExit);
    serverProc!.kill('SIGTERM');
    // SIGKILL fallback if SIGTERM doesn't take within 2s (Windows often
    // ignores SIGTERM on Node child processes spawned with shell:true).
    setTimeout(() => {
      try { if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL'); } catch { /* */ }
      // belt + suspenders: resolve even if exit never fired
      resolve();
    }, 2000);
  });
  // Detach stdio so node:test doesn't keep waiting on the buffered streams.
  try { serverProc.stdout?.destroy(); } catch { /* */ }
  try { serverProc.stderr?.destroy(); } catch { /* */ }
});

function freshUser() {
  return {
    email: `alice+${randomBytes(6).toString('hex')}@example.com`,
    password: 'correct horse battery staple',
  };
}

describe('SDK platform client', () => {
  it('getRecoveryPublicKey returns a 64-char hex string', async () => {
    const client = new PlatformClient({ baseUrl });
    const pk = await client.getRecoveryPublicKey();
    assert.equal(typeof pk, 'string');
    assert.equal(pk.length, 64);
    assert.match(pk, /^[0-9a-f]+$/);
  });

  it('signup -> signin returns the same accountId and a usable session', async () => {
    const client = new PlatformClient({ baseUrl });
    const u = freshUser();

    const signup = await client.signup(u);
    assert.ok(signup.sessionToken);
    assert.ok(signup.accountId.startsWith('') && signup.accountId.length >= 40);
    assert.ok(signup.privateKey.length > 16);

    const me1 = await client.me(signup.sessionToken);
    assert.equal(me1.accountId, signup.accountId);
    assert.equal(me1.email, u.email);

    const signin = await client.signin(u);
    assert.equal(signin.accountId, signup.accountId, 'sign-in should return the same accountId');
    assert.equal(signin.privateKey, signup.privateKey, 'sign-in should recover the same privateKey');
  });

  it('signin with wrong password throws PlatformError 401', async () => {
    const client = new PlatformClient({ baseUrl });
    const u = freshUser();
    await client.signup(u);
    await assert.rejects(
      () => client.signin({ email: u.email, password: 'totally wrong password' }),
      (err: unknown) => err instanceof PlatformError && err.httpStatus === 401,
    );
  });

  it('signout revokes the session: subsequent /me fails', async () => {
    const client = new PlatformClient({ baseUrl });
    const u = freshUser();
    const session = await client.signup(u);
    await client.signout(session.sessionToken);
    await assert.rejects(
      () => client.me(session.sessionToken),
      (err: unknown) => err instanceof PlatformError && err.httpStatus === 401,
    );
  });

  it('full recovery flow: start -> verify -> complete -> sign in with new password', async () => {
    const client = new PlatformClient({ baseUrl });
    const u = freshUser();
    const original = await client.signup(u);

    const startRes = await client.recoverStart({ email: u.email });
    assert.equal(startRes.sent, true);
    assert.ok(startRes.devToken, 'dev mode should return the token');
    const token = startRes.devToken!;

    await client.recoverVerify({ token });

    const newPassword = 'completely different password 12345';
    const future = Math.floor(Date.now() / 1000) + 86400 + 60; // past the cooldown
    const recovered = await client.recoverComplete({
      email: u.email,
      token,
      newPassword,
      now: future,
    });
    // After recoverComplete, we should have a brand-new session AND the
    // SAME accountId AND the SAME privateKey (because the AE keypair
    // itself didn't change; only the encryption-at-rest changed).
    assert.equal(recovered.accountId, original.accountId);
    assert.equal(recovered.privateKey, original.privateKey);

    // Old password no longer works.
    await assert.rejects(
      () => client.signin({ email: u.email, password: u.password }),
      (err: unknown) => err instanceof PlatformError && err.httpStatus === 401,
    );

    // New password works AND returns the same private key.
    const reSignin = await client.signin({ email: u.email, password: newPassword });
    assert.equal(reSignin.accountId, original.accountId);
    assert.equal(reSignin.privateKey, original.privateKey);
  });

  it('signup with an existing keypair preserves it (import path)', async () => {
    const client = new PlatformClient({ baseUrl });
    const u = freshUser();
    const { generateKeyPair } = await import('../src/crypto.js');
    const existing = generateKeyPair();

    const session = await client.signup({ ...u, existingKeypair: existing });
    assert.equal(session.privateKey, existing.privateKey);
    assert.equal(session.publicKey, existing.publicKey);

    // Sign in again and the same private key comes back.
    const reSignin = await client.signin(u);
    assert.equal(reSignin.privateKey, existing.privateKey);
  });
});
