#!/usr/bin/env node
/**
 * Sign and submit an on-chain validator registration.
 *
 * This is the step `validator:setup` deliberately stops short of. Setup
 * generates the three keypairs and writes a keystore; this takes that keystore,
 * signs a register intent with the account's ML-DSA key, and POSTs it to a node
 * that can actually put it in a block.
 *
 *   npm run validator:register -- \
 *     --keystore ./my-validator/keystore.json \
 *     --node http://192.168.1.10:3000 \
 *     --stake 200
 *
 * Add --deregister to leave the set instead (same auth, unlocks the stake).
 *
 * The one thing that is not obvious
 * --------------------------------
 * `--node` must point at a node that is ALREADY an active validator, and it is
 * usually NOT the candidate's own node.
 *
 * A validator change does not travel as a gossiped transaction. The API writes
 * it to a local queue (`enqueueValidatorChange`), and that queue is drained in
 * exactly one place: when THAT node proposes a block. A candidate's own node is
 * not in the validator set yet, so it never proposes, so the change sits in its
 * queue forever. No error is raised anywhere — the POST returns 200, the queue
 * row is real, and nothing happens. That is a genuinely hard afternoon to debug
 * from the outside, so this CLI checks the target's /status before submitting
 * and refuses when the target cannot propose.
 *
 * What has to be true first
 * -------------------------
 *   1. The candidate's ACCOUNT exists on the chain the target node follows.
 *      Registration stakes earned points, so there must be an account to take
 *      them from.
 *   2. That account holds at least MIN_VALIDATOR_STAKE in earned points. Daily
 *      active/supportive/ambient points cannot be staked; they expire.
 *   3. The target node is up, in BFT mode, and in the active set.
 *
 * All three are checked before anything is signed, because a rejected POST
 * after the fact tells you far less than a named precondition does.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveAccountId } from '../core/crypto.js';
import {
  signValidatorChangeRegister,
  signValidatorChangeDeregister,
} from '../core/consensus/validator-change.js';
import { MIN_VALIDATOR_STAKE } from '../core/consensus/registration.js';
import { PRECISION } from '../core/constants.js';

interface Keystore {
  publicKey: string; // node Ed25519 public key
  secretKey: string; // node Ed25519 secret key
  name?: string;
  accountId?: string;
  account: { publicKey: string; privateKey: string };
  vrf: { publicKey: string; secretKey: string };
  networkId?: string;
}

interface ParsedArgs {
  keystore: string;
  node: string;
  stake: number;
  deregister: boolean;
  force: boolean;
}

const MIN_STAKE_DISPLAY = Number(MIN_VALIDATOR_STAKE) / Number(PRECISION);

/** Display points -> fixed-precision base units, the unit the protocol uses. */
function stakeFixed(displayPoints: number): bigint {
  return BigInt(Math.round(displayPoints * Number(PRECISION)));
}

function usage(): never {
  console.error(`Usage: npm run validator:register -- --keystore <file> --node <url> [options]

Options:
  --keystore <file>   REQUIRED. keystore.json produced by "npm run validator:setup".
  --node <url>        REQUIRED. Base URL of an ACTIVE VALIDATOR's node, e.g.
                      http://192.168.1.10:3000. Not your own node unless your
                      own node is already in the validator set - a change
                      submitted anywhere else queues locally and never reaches
                      a block.
  --stake <points>    Points to stake, in display units. Minimum ${MIN_STAKE_DISPLAY}.
                      Required for registration, ignored with --deregister.
  --deregister        Leave the validator set and unlock the stake.
  --force             Submit even if the pre-flight checks fail. For operators
                      who know something this script does not.
  --help, -h          Show this message.
`);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<ParsedArgs> = { deregister: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--keystore':
        out.keystore = next;
        i++;
        break;
      case '--node':
        out.node = next;
        i++;
        break;
      case '--stake':
        out.stake = Number(next);
        i++;
        break;
      case '--deregister':
        out.deregister = true;
        break;
      case '--force':
        out.force = true;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown flag: ${a}`);
        usage();
    }
  }
  if (!out.keystore) {
    console.error('--keystore is required');
    usage();
  }
  if (!out.node) {
    console.error('--node is required');
    usage();
  }
  if (!out.deregister) {
    if (out.stake === undefined || !Number.isFinite(out.stake) || out.stake <= 0) {
      console.error('--stake is required for registration and must be a positive number');
      usage();
    }
  }
  return {
    keystore: out.keystore,
    node: out.node.replace(/\/$/, ''),
    stake: out.stake ?? 0,
    deregister: out.deregister!,
    force: out.force!,
  };
}

function loadKeystore(path: string): Keystore {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), 'utf8');
  } catch (err) {
    console.error(`\nCannot read keystore at ${resolve(path)}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error('\nGenerate one with:  npm run validator:setup -- --network-id <id> --output <dir>\n');
    process.exit(1);
  }
  let ks: Keystore;
  try {
    ks = JSON.parse(raw) as Keystore;
  } catch {
    console.error(`\n${path} is not valid JSON.\n`);
    process.exit(1);
  }
  // Fail on the specific missing field rather than on a downstream undefined.
  // A keystore is edited by hand more often than anyone admits.
  for (const [label, value] of [
    ['account.privateKey', ks.account?.privateKey],
    ['account.publicKey', ks.account?.publicKey],
    ['publicKey (node)', ks.publicKey],
    ['vrf.publicKey', ks.vrf?.publicKey],
  ] as Array<[string, unknown]>) {
    if (typeof value !== 'string' || value.length === 0) {
      console.error(`\nKeystore is missing ${label}. It is not a validator keystore.\n`);
      process.exit(1);
    }
  }
  return ks;
}

async function getJson(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

interface PreflightResult {
  problems: string[];
  targetAccountId: string | null;
  height: number;
}

/**
 * Everything that can be known before signing. Each failure names the specific
 * precondition, because "REGISTER_FAILED: insufficient balance" arriving after
 * a signed POST is a much worse experience than being told up front which of
 * the three requirements is not met.
 */
async function preflight(node: string, accountId: string, deregister: boolean, stake: number): Promise<PreflightResult> {
  const problems: string[] = [];
  let targetAccountId: string | null = null;
  let height = 0;

  // 1. Is the node up, and can it propose?
  try {
    const status = await getJson(`${node}/api/v1/status`);
    const n = (status.body as { node?: Record<string, unknown>; chain?: Record<string, unknown> })
      ?.node;
    const chain = (status.body as { chain?: { blockHeight?: number } })?.chain;
    height = chain?.blockHeight ?? 0;
    targetAccountId = (n?.accountId as string | null) ?? null;

    if (n?.consensusMode !== 'bft') {
      problems.push(
        `${node} is running in ${String(n?.consensusMode ?? 'unknown')} mode, not bft. ` +
          'Validator registration only means something on a BFT chain.',
      );
    } else if (n?.isActiveValidator !== true) {
      problems.push(
        `${node} is not an active validator, so it never proposes blocks.\n` +
          '      A validator change submitted here is written to that node\'s local\n' +
          '      queue and drained only when it proposes, so it would sit there\n' +
          '      forever with no error. Point --node at a node that is already in\n' +
          '      the active set.',
      );
    }
  } catch (err) {
    problems.push(
      `${node} is unreachable (${err instanceof Error ? err.message : String(err)}). ` +
        'Check the node is running and the port is open.',
    );
    // Nothing else can be checked without it.
    return { problems, targetAccountId, height };
  }

  // 2. Does the candidate's account exist on this chain, with enough stake?
  const acct = await getJson(`${node}/api/v1/accounts/${accountId}`);
  if (!acct.ok) {
    problems.push(
      `Account ${accountId} does not exist on the chain ${node} follows (HTTP ${acct.status}).\n` +
        '      Create it in the wallet first, and wait for the block carrying its\n' +
        '      registration to commit. Registration stakes earned points, so the\n' +
        '      account has to be on-chain before it can stake anything.',
    );
  } else if (!deregister) {
    // serializeAccount in api/routes/accounts.ts returns balances as decimal
    // strings of the fixed-precision bigint, never numbers - going through
    // Number would lose precision above 2^53 on exactly the large balances a
    // validator is most likely to hold.
    const data = (acct.body as { data?: Record<string, unknown> })?.data ?? {};
    const earnedRaw = data.earnedBalance;
    const earned = typeof earnedRaw === 'string' ? BigInt(earnedRaw) : null;
    const wanted = stakeFixed(stake);

    if (wanted < MIN_VALIDATOR_STAKE) {
      problems.push(
        `--stake ${stake} is below the minimum of ${MIN_STAKE_DISPLAY} points.`,
      );
    }
    if (earned !== null && earned < wanted) {
      const have = Number(earned) / Number(PRECISION);
      problems.push(
        `Account holds ${have} earned points but ${stake} are being staked.\n` +
          '      Only EARNED points can be staked. Daily active, supportive and\n' +
          '      ambient points expire at 3:59 AM EST and are not stakeable.',
      );
    }
  }

  return { problems, targetAccountId, height };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ks = loadKeystore(args.keystore);

  // Derive rather than trust the stored accountId: a hand-edited keystore whose
  // accountId no longer matches its public key would produce a signature the
  // node checks against a different account's key, and the only symptom would
  // be an opaque AUTH_INVALID.
  const accountId = deriveAccountId(ks.account.publicKey);
  if (ks.accountId && ks.accountId !== accountId) {
    console.error(
      `\nKeystore accountId (${ks.accountId}) does not match its account public key\n` +
        `(which derives to ${accountId}). The file has been edited or merged.\n`,
    );
    process.exit(1);
  }

  const action = args.deregister ? 'deregister' : 'register';
  console.log('');
  console.log(`  Validator ${action}`);
  console.log('');
  console.log(`    account   ${accountId}`);
  console.log(`    node key  ${ks.publicKey.slice(0, 16)}...`);
  console.log(`    vrf key   ${ks.vrf.publicKey.slice(0, 16)}...`);
  if (!args.deregister) console.log(`    stake     ${args.stake} points`);
  console.log(`    target    ${args.node}`);
  console.log('');

  const pre = await preflight(args.node, accountId, args.deregister, args.stake);
  if (pre.problems.length > 0) {
    console.error('  Pre-flight checks failed:\n');
    for (const p of pre.problems) console.error(`    - ${p}`);
    console.error('');
    if (!args.force) {
      console.error('  Nothing was signed or submitted. Re-run with --force to submit anyway.\n');
      process.exit(1);
    }
    console.error('  --force given, submitting anyway.\n');
  } else {
    console.log(`  Pre-flight ok. Target is an active validator at block ${pre.height}.`);
    console.log('');
  }

  // POST to /propose-{register,deregister}, NOT to /{register,deregister}.
  //
  // This distinction is the whole correctness of this tool and it is not
  // obvious from the route names.
  //
  //   /register        calls registerValidator() directly. That does three
  //                    purely LOCAL writes - debit earned, credit locked,
  //                    INSERT into the validators table - inside one
  //                    runTransaction. It never enqueues, never gossips, never
  //                    rides a block. The receiving node's validator set now
  //                    differs from every peer's.
  //   /propose-register  enqueues a signed ValidatorChange that the proposer
  //                    drains into block.validatorChanges, so every node
  //                    applies it from the chain.
  //
  // Calling the local one against an active validator halts the chain almost
  // immediately: that node's quorumCount jumps (floor(2n/3)+1 with n now one
  // larger) while its peers' does not, so it demands more prevotes than can
  // exist and precommits NIL forever. Nothing reports an error, because the
  // state root that would notice the divergence is diagnostic only.
  //
  // Signed with the protocol's own signValidatorChange* helper rather than a
  // hand-built payload, so the canonical bytes match what verifyValidatorChange
  // recomputes on the far side.
  const timestamp = Math.floor(Date.now() / 1000);
  const change = args.deregister
    ? signValidatorChangeDeregister({
        accountId,
        timestamp,
        accountPrivateKey: ks.account.privateKey,
      })
    : signValidatorChangeRegister({
        accountId,
        nodePublicKey: ks.publicKey,
        vrfPublicKey: ks.vrf.publicKey,
        // Base-10 string of the fixed-precision bigint. The route parses it
        // with BigInt() and compares against MIN_VALIDATOR_STAKE directly, so
        // display units here would be wrong by a factor of 10^8.
        stake: stakeFixed(args.stake).toString(),
        timestamp,
        accountPrivateKey: ks.account.privateKey,
      });

  const url = `${args.node}/api/v1/validators/propose-${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ change }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: unknown; error?: { code?: string; message?: string } }
    | null;

  if (!res.ok || body?.success !== true) {
    console.error(`  Submission failed (HTTP ${res.status}).`);
    console.error(`    ${body?.error?.code ?? 'UNKNOWN'}: ${body?.error?.message ?? 'no message'}`);
    console.error('');
    process.exit(1);
  }

  console.log(`  Accepted and queued on ${args.node}.`);
  console.log('');
  console.log('  It is NOT on-chain yet. The change rides the next block that node');
  console.log('  proposes, so at a 10-second block interval expect it within a minute');
  console.log('  or two depending on how many validators are taking turns.');
  console.log('');
  console.log('  Confirm it landed:');
  console.log('');
  console.log(`    curl ${args.node}/api/v1/validators`);
  console.log('');
  console.log(`  Look for ${accountId} with isActive true. Once it appears, restart`);
  console.log('  the candidate node in BFT mode and it will start taking proposer turns.');
  console.log('');
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
