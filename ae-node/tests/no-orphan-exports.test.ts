// Guard against the single most common defect shape in this codebase.
//
// Six separate bugs found in one audit were all the same thing: an exported
// function that exists, is correct, has passing unit tests, and which no
// production code ever calls.
//
//   withdrawVouch            - WP Â§7.2 said vouchers may withdraw; no route
//   resolveAppeal            - appeals settled through the wrong function
//   markAssignmentMissed     - panel deadlines never enforced
//   markAssignmentComplete   - miner reliability stuck at zero for everyone
//   finalizeSupportiveTags   - two of the four point types never paid out
//   finalizeAmbientTags      - same
//
// Every one had a green test. Unit tests prove a function works; nothing was
// checking that anything reaches it. This test does.
//
// It is deliberately a report-and-compare rather than a hard "zero orphans"
// rule: plenty of exports are legitimately unreferenced inside src/ because
// they are the public surface (API route factories, SDK-facing helpers, CLI
// entry points). Those live in KNOWN_ORPHANS with a reason. A NEW orphan fails
// the test, which is the moment to ask "did I just build something and forget
// to wire it in?"

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Exports with no in-src caller that are fine. Each needs a reason, and the
 * reason has to be "something outside src/ calls it", not "we might need it".
 */
const KNOWN_ORPHANS: Record<string, string> = {
  // â”€â”€ Genuine external surface: called from outside src/ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  createApp: 'server entry, started by cli.ts / tests',
  buildOpenApiSpec: 'served at /api/v1/openapi.json',
  signPayload: 'client-side signing; ae-node only ever verifies',
  signVouchCreate: 'client-side (ae-miner) + test signing of a vouch operation',
  signVouchWithdraw: 'client-side (ae-miner) + test signing of a vouch operation',
  pendingVouchOperationCount: 'test/observability helper for the vouch-op queue',
  signMinerRegister: 'client-side (both apps) + test signing of a miner operation',
  signMinerDeregister: 'client-side + test signing of a miner operation',
  pendingMinerOperationCount: 'test/observability helper for the miner-op queue',
  signPanelCreate: 'client-side (ae-app) + test signing of a panel operation',
  signPanelScore: 'client-side (ae-miner) + test signing of a panel operation',
  pendingPanelOperationCount: 'test/observability helper for the panel-op queue',
  generateVRFProof: 'used through the IVrfProvider interface, not by name',
  proposalId: 'helper used by consensus tests and callers outside src',
  resetRateLimits: 'test-only reset hook for a module-level map',
  resetRoundRobin: 'test-only reset hook for a module-level cursor',
  clearBanList: 'admin/test helper on PeerManager',
  checkpointWAL: 'operator helper, invoked manually',
  pruneChain: 'operator helper, invoked manually',

  // -- Superseded in production, but still exercised by tests ------------
  // I first listed these as "delete". That was wrong: production no longer
  // reaches them, but the test suite does (validateChain has 8 references,
  // validateBlock 2, each initialize*Schema 1). Removing them would delete
  // real coverage of block-validation and schema-setup behaviour. Whether
  // block-validator.ts and db/schema.ts already cover the same ground needs
  // checking before anything is deleted, not assuming.
  initializeCourtSchema: 'superseded by db/schema.ts in production; tests still use it',
  initializeMiningSchema: 'superseded by db/schema.ts in production; tests still use it',
  initializeVerificationSchema: 'superseded by db/schema.ts in production; tests still use it',
  validateBlock: 'superseded by network/block-validator.ts in production; 2 test refs',
  createPanel: 'legacy node-local panel path, superseded by verification/panel-operation.ts on-chain; tests still cover its semantics',
  submitPanelScore: 'legacy node-local scoring, superseded by verification/panel-operation.ts on-chain; tests still cover deadline/idempotency/fractional-score semantics',
  validateChain: 'superseded by network/block-validator.ts in production; 8 test refs',

  // â”€â”€ UNWIRED: real gaps, documented in CLAUDE.md â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Each of these implements a white-paper mechanism that therefore does not
  // happen on a running network. Listed so the guard protects against NEW
  // orphans; removing an entry from this list is the definition of done.
  runDecayForAll: 'UNWIRED â€” percentHuman decay never runs',
  claimInheritance: 'UNWIRED â€” inheritance cannot be claimed',
  distributeFees: 'UNWIRED â€” check against commitBlockSideEffects',
  distributeFromFeePool: 'UNWIRED â€” companion to distributeFees',
  setPolicy: 'UNWIRED â€” verification policy cannot be changed at runtime',
  linkManufacturer: 'UNWIRED â€” products cannot be linked to a manufacturer',
  createSmartContract: 'UNWIRED â€” smart-contract layer is a documented placeholder',
  overrideContract: 'UNWIRED â€” same',
  resetDailyOverrides: 'UNWIRED â€” same',
  getPanelForAccount: 'UNWIRED â€” no route exposes it',
  getVouchesGivenBy: 'UNWIRED â€” route uses the store directly',
  getEvidenceType: 'UNWIRED â€” no caller',
  getAccountByPublicKey: 'UNWIRED â€” no caller',
  isInProtectionWindow: 'UNWIRED â€” fileChallenge inlines the check',
  pendingValidatorChangeCount: 'UNWIRED â€” diagnostics only',
  signValidatorChangeRegister: 'client-side signing for validator onboarding',
  signValidatorChangeDeregister: 'client-side signing for validator onboarding',
  signNodeMessage: 'network handshake signing, reached via messages.ts helpers',
  verifyNodeMessage: 'network handshake verification, reached via messages.ts',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('no orphaned exports', () => {
  test('every exported function has a caller inside src/', () => {
    const files = walk(SRC);
    const sources = files.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

    // name -> file that declares it
    const declared = new Map<string, string>();
    const declRe = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm;
    for (const { path, text } of sources) {
      for (const m of text.matchAll(declRe)) declared.set(m[1], path);
    }

    const orphans: string[] = [];
    for (const [name, declPath] of declared) {
      if (name in KNOWN_ORPHANS) continue;

      let referenced = false;
      for (const { path, text } of sources) {
        // Count references that are not the declaration itself. A call, a
        // re-export, or being passed as a value all count as "reachable".
        const uses = text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
        const declsHere =
          path === declPath
            ? text.match(new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'gm'))?.length ?? 0
            : 0;
        if (uses - declsHere > 0) {
          referenced = true;
          break;
        }
      }

      if (!referenced) orphans.push(`${name}  (${relative(SRC, declPath)})`);
    }

    assert.deepEqual(
      orphans.sort(),
      [],
      'These exported functions are never referenced anywhere in src/.\n' +
        'That is how six separate bugs shipped: the function was written and\n' +
        'tested, and nothing ever called it. Either wire it up, delete it, or\n' +
        'add it to KNOWN_ORPHANS in this file WITH a reason.\n\n' +
        orphans.map((o) => `  - ${o}`).join('\n') +
        '\n',
    );
  });
});
