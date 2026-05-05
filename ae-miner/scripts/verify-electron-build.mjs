#!/usr/bin/env node
/**
 * Build-time sanity check for the packaged Electron build.
 *
 * Catches the class of "looks fine in `npm run dev`, blank in the .exe"
 * bugs we hit on first install. The original symptom (blank dark window
 * with branded title bar) was caused by Vite emitting an index.html that
 * referenced assets at /assets/index-abc.js (absolute path). Electron
 * loads via file://, so / resolved to the user's filesystem root, no JS
 * loaded, React never mounted. Fix was `base: './'` in vite.config.ts.
 *
 * This script runs after `vite build` and asserts:
 *   1. dist/index.html exists
 *   2. every asset URL in dist/index.html is relative ("./", not "/")
 *   3. each referenced asset actually exists on disk
 *
 * Failure exits non-zero so electron-builder doesn't package a broken
 * dist. Add new checks here as we find new shapes of "first-install
 * blank screen" bugs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const distDir = join(root, 'dist');
const indexPath = join(distDir, 'index.html');

let failed = 0;
function fail(msg) {
  console.error(`✗ ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

// 1) dist/index.html exists.
if (!existsSync(indexPath)) {
  fail(`dist/index.html missing at ${indexPath}. Did vite build run?`);
  process.exit(1);
}
ok('dist/index.html exists');

const html = readFileSync(indexPath, 'utf8');

// 2) Every src/href on a <script>, <link>, or <img> uses a relative path
//    (./, ../, or a full URL). Anything starting with a single / would
//    resolve to filesystem root under file:// and break the page.
//
//    We accept absolute URLs (https://, data:, blob:) because those
//    reach the network or inline data, not the local filesystem.
const ATTR_RE = /\b(?:src|href)\s*=\s*"([^"]+)"/g;
const violations = [];
let m;
while ((m = ATTR_RE.exec(html)) !== null) {
  const url = m[1];
  if (
    url.startsWith('./') ||
    url.startsWith('../') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('mailto:') ||
    url.startsWith('#')
  ) {
    continue;
  }
  // Anything starting with `/` is the bug we're catching.
  if (url.startsWith('/')) {
    violations.push(url);
  }
}

if (violations.length > 0) {
  fail(
    `dist/index.html contains absolute asset paths that will 404 under file://:\n  - ${violations.join('\n  - ')}\n\n` +
    `Fix: set \`base: './'\` in vite.config.ts. See ae-app/vite.config.ts for the comment.`,
  );
} else {
  ok('all asset paths in dist/index.html are relative');
}

// 3) Every referenced relative asset actually exists on disk.
const referencedAssets = [];
ATTR_RE.lastIndex = 0;
while ((m = ATTR_RE.exec(html)) !== null) {
  const url = m[1];
  if (url.startsWith('./') || (!url.includes(':') && !url.startsWith('/') && !url.startsWith('#'))) {
    // strip query/fragment for the existence check
    const cleanUrl = url.split('?')[0].split('#')[0];
    referencedAssets.push(cleanUrl);
  }
}

const missing = [];
for (const asset of referencedAssets) {
  // Resolve from the location of index.html.
  const assetPath = normalize(join(distDir, asset.replace(/^\.\//, '')));
  if (!existsSync(assetPath)) {
    missing.push({ url: asset, expectedAt: assetPath });
  }
}

if (missing.length > 0) {
  fail(
    `dist/index.html references assets that don't exist on disk:\n` +
    missing.map((x) => `  - ${x.url}\n      expected at: ${x.expectedAt}`).join('\n'),
  );
} else if (referencedAssets.length > 0) {
  ok(`all ${referencedAssets.length} referenced asset(s) exist on disk`);
}

if (failed > 0) {
  console.error(`\nverify-electron-build: ${failed} check(s) failed. Build artifact is not Electron-packagable.`);
  process.exit(1);
}

console.log('\nverify-electron-build: all checks passed.');
