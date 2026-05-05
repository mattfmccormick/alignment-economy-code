#!/usr/bin/env node
/**
 * Generate the branded app icon set for electron-builder.
 *
 * Inputs:  public/icon.svg  (the AE "A" logo, navy background, teal strokes)
 * Outputs: build/icon.ico   (Windows installer + .exe icon)
 *          build/icon.png   (Linux AppImage + macOS fallback)
 *          build/icons/*    (NSIS sidebar + header bitmaps, optional)
 *
 * Run automatically as part of `npm run electron:build:win`. If you change
 * the SVG and want to regenerate without a full installer build, run:
 *   node scripts/build-icons.mjs
 *
 * electron-builder picks up build/icon.ico and build/icon.png by convention
 * (no extra config needed in package.json's `build` block).
 */

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const svgPath = join(root, 'public', 'icon.svg');
const buildDir = join(root, 'build');
mkdirSync(buildDir, { recursive: true });

const svg = readFileSync(svgPath);

// .ico needs at least 16, 32, 48, 256. Including 64, 128 makes the icon
// look crisp at every size Windows uses (taskbar, file explorer, alt-tab).
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

async function rasterize(size) {
  return sharp(svg).resize(size, size).png().toBuffer();
}

async function main() {
  // 1) Generate every size as a PNG buffer in parallel.
  const pngs = await Promise.all(ICO_SIZES.map(rasterize));

  // 2) Concatenate into a single .ico (multi-resolution).
  const ico = await pngToIco(pngs);
  writeFileSync(join(buildDir, 'icon.ico'), ico);
  console.log(`✓ wrote build/icon.ico (${ICO_SIZES.length} sizes, ${ico.length} bytes)`);

  // 3) Write the largest PNG as the cross-platform fallback.
  const png512 = await sharp(svg).resize(512, 512).png().toBuffer();
  writeFileSync(join(buildDir, 'icon.png'), png512);
  console.log(`✓ wrote build/icon.png (512x512, ${png512.length} bytes)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
