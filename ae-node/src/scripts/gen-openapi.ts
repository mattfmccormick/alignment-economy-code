// Writes the generated OpenAPI spec to docs/openapi.json at the repo root.
// Run with `npm run gen:openapi` after changing any request schema so the
// checked-in contract stays in sync.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../api/openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/scripts -> repo root is three levels up (src/scripts -> src -> ae-node -> root).
const out = resolve(here, '../../../docs/openapi.json');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApiSpec(), null, 2) + '\n');
console.log(`Wrote OpenAPI spec to ${out}`);
