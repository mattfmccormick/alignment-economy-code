// Page smoke test — loads every wallet (ae-app) and miner (ae-miner) route in
// a real headless browser against a running dev stack and fails on the failure
// mode unit tests can't see: a page that crashes on render.
//
// Why this exists: three shape-drift bugs (nested-vs-flat balances, evidence
// score object, snake_case miner row) blanked every authenticated miner screen
// while all unit tests stayed green. `tests/api-shape-contract.test.ts` in
// ae-node pins the wire shapes; this script pins the other end — every page
// actually renders content with a live node behind it.
//
// Prereqs (run each in its own terminal, or use your normal dev setup):
//   ae-node:  npm run dev            (API on :3000)
//   ae-app:   npm run dev            (wallet on :5173)
//   ae-miner: npm run dev            (miner on :5174)
//   ae-app:   npm install            (this script borrows its puppeteer-core)
//
// Run from the repo root:
//   node scripts/smoke-pages.mjs
//
// Exit code 0 = every route rendered; 1 = at least one blank/erroring page.
// A page FAILS if its <main>/body text is near-empty or a console error fired
// during load (React crashes surface as both).

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, 'ae-app', 'package.json'));

const API = process.env.SMOKE_API_URL || 'http://localhost:3000/api/v1';
const WALLET_ORIGIN = process.env.SMOKE_WALLET_URL || 'http://localhost:5173';
const MINER_ORIGIN = process.env.SMOKE_MINER_URL || 'http://localhost:5174';

// Routes under test. Keep in sync with each app's App.tsx route table.
const WALLET_ROUTES = ['/', '/share', '/send', '/receive', '/tag', '/verify', '/more', '/history', '/network', '/court', '/contacts', '/recurring'];
const MINER_ROUTES = ['/', '/verify', '/court', '/vouch', '/income', '/audit', '/network'];

// Console noise that is not a page crash. WS churn is expected in dev.
const IGNORED_ERRORS = [/WebSocket/i, /Failed to load resource.*40[34]/i, /favicon/i];

function findBrowser() {
  const candidates = [
    process.env.SMOKE_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const fs = require('fs');
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Edge/Chrome found. Set SMOKE_BROWSER to a browser executable path.');
}

// Make a throwaway client-custody account on the running node so authed pages
// have real data behind them. Uses ae-node's own build for ML-DSA keygen.
async function makeAccount() {
  try {
    execSync('npm run build --silent', { cwd: path.join(ROOT, 'ae-node'), stdio: 'ignore', timeout: 120_000 });
  } catch { /* a stale dist is fine; keygen API is stable */ }
  const { generateKeyPair } = await import(pathToFileUrl(path.join(ROOT, 'ae-node', 'dist', 'core', 'crypto.js')));
  const keys = generateKeyPair();
  const res = await fetch(`${API}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'individual', publicKey: keys.publicKey }),
  });
  const body = await res.json();
  if (!body?.success) throw new Error(`account create failed: ${JSON.stringify(body).slice(0, 200)}`);
  return { accountId: body.data.account.id, publicKey: keys.publicKey, privateKey: keys.privateKey };
}

function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

async function crawl(browser, origin, storageKey, wallet, routes, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const failures = [];
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_ERRORS.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate((k, w) => localStorage.setItem(k, JSON.stringify(w)), storageKey, wallet);
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1200));

  for (const route of routes) {
    consoleErrors.length = 0;
    await page.evaluate((p) => { window.location.hash = p; }, route);
    await new Promise((r) => setTimeout(r, 1400));
    try { await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }); } catch { /* busy pages are fine */ }

    const text = await page.evaluate(() => document.body.innerText.trim());
    const blank = text.length < 40; // a rendered page always has nav + content
    const errored = consoleErrors.length > 0;
    if (blank || errored) {
      failures.push({ route, blank, errors: [...consoleErrors] });
      console.log(`  FAIL  ${label}${route}  ${blank ? '(blank page)' : ''} ${errored ? consoleErrors[0].slice(0, 140) : ''}`);
    } else {
      console.log(`  ok    ${label}${route}  (${text.length} chars)`);
    }
  }
  await page.close();
  return failures;
}

const puppeteer = require('puppeteer-core');
// Spawn the browser ourselves and puppeteer.connect() to it instead of
// puppeteer.launch(). Recent Edge builds hand off from the launched pid to a
// child process and exit, which puppeteer.launch misreads as "Failed to
// launch the browser process!". Owning the spawn + polling /json/version is
// immune to that, and a dedicated user-data-dir avoids the profile lock when
// the user's real browser is open.
const os = await import('node:os');
const fsp = await import('node:fs/promises');
const { spawn } = await import('node:child_process');
const profileDir = path.join(os.tmpdir(), 'ae-smoke-profile');
await fsp.mkdir(profileDir, { recursive: true });
const DEBUG_PORT = Number(process.env.SMOKE_DEBUG_PORT || 9333);

const browserProc = spawn(findBrowser(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore', detached: false });

async function waitForDebugger() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Browser debugger never came up on :${DEBUG_PORT}`);
}
await waitForDebugger();
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null });

try {
  console.log('Creating throwaway account on', API);
  const wallet = await makeAccount();
  console.log('Account:', wallet.accountId, '\n');

  console.log('Wallet routes:');
  const walletFails = await crawl(browser, WALLET_ORIGIN, 'ae_wallet', wallet, WALLET_ROUTES, 'wallet');

  console.log('\nMiner routes:');
  const minerFails = await crawl(browser, MINER_ORIGIN, 'ae_miner_wallet', wallet, MINER_ROUTES, 'miner');

  const total = walletFails.length + minerFails.length;
  console.log(`\n${total === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'}: ${WALLET_ROUTES.length + MINER_ROUTES.length - total}/${WALLET_ROUTES.length + MINER_ROUTES.length} routes rendered`);
  process.exitCode = total === 0 ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
  browserProc.kill();
}
