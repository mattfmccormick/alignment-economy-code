// Snapshot sync: bring a new node to the chain head by copying verified state
// instead of replaying every block from genesis.
//
//   node scripts/snapshot.mjs export [--db path] [--out file]
//   node scripts/snapshot.mjs verify <file> [--peer http://host:3000 ...]
//   node scripts/snapshot.mjs import <file> [--db path] [--force]
//
// Why this exists
// ---------------
// Catch-up sync is O(chain length) and it never gets faster. Every block has to
// be fetched, its transactions replayed, its day cycle applied. At a 10-second
// block interval that is 8,640 blocks a day and about 3.1 million a year, so
// the wall-clock cost of joining the network grows without bound. Bringing a
// new machine online already took hours at five thousand blocks. It is the one
// problem on the list that gets strictly worse with time, which is why it is
// worth solving while the chain is short rather than after it is long.
//
// What this is, precisely
// -----------------------
// An operator-assisted snapshot, the same shape as Bitcoin's assumeutxo and
// Solana's snapshot download: you obtain state from somebody, then check it
// against what the rest of the network says before you trust it. It is NOT
// trustless peer-to-peer state sync. The distinction matters and is not
// hedging:
//
//   - The snapshot carries its own state root, so `verify` catches truncation,
//     corruption, a bad copy, a mid-write export. It cannot catch a donor who
//     fabricated both the state and the root, because nothing in the chain
//     commits to the root yet (see core/state-root.ts on why folding it into
//     the block hash deadlocks the chain today).
//   - So the check that actually carries weight is `--peer`: ask independent
//     nodes for their recorded root at the snapshot's height and require them
//     to agree with it. A donor would have to control every node you ask.
//
// Trust the snapshot as far as you trust the peers you checked it against.
// Verifying against one node run by the same person who gave you the file is
// not verification.
//
// Whole-file, not state-only
// --------------------------
// The snapshot is the entire SQLite database, block history included, rather
// than a compact state-only extract. Two reasons, and the second is the real
// one:
//
//   - The cost being removed is replay time, not disk. Copying more bytes to
//     skip hours of transaction replay is a good trade.
//   - A state-only snapshot leaves the node with no blocks below the snapshot
//     height, which breaks parent lookups, chain validation, and its ability to
//     serve sync to anyone else. Supporting that properly means a "this chain
//     starts at height H" concept threaded through the whole store layer. That
//     is a real feature, and shipping a truncated database while calling it one
//     would be the worse kind of shortcut.
//
// Export uses SQLite's VACUUM INTO, which produces a consistent single-file
// copy from a live WAL database. Copying ae-node.db by hand does not: the
// recent writes are sitting in the -wal sidecar, so you get a torn snapshot
// that looks fine until it does not.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argv, exit } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- argument parsing ------------------------------------------------------

const args = argv.slice(2);
const command = args[0];

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  exit(1);
}

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`--${name} needs a value`);
  return v;
}

function flagAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--')) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

function usage() {
  console.log(`
Snapshot sync - join the chain by copying verified state, not by replaying it.

  node scripts/snapshot.mjs export [--db <path>] [--out <file>]
      Write a consistent copy of this node's database. Safe while running.

  node scripts/snapshot.mjs verify <file> [--peer <url>]...
      Check a snapshot's internal consistency, and (with --peer) check its
      state root against what independent nodes report at that height.
      Run this BEFORE import. Repeat --peer for each node you want to ask.

  node scripts/snapshot.mjs import <file> [--db <path>] [--force]
      Install a snapshot as this node's database. Refuses to clobber an
      existing database unless --force, and always keeps a backup.

Defaults: --db ./data/ae-node.db   (run from the ae-node directory)
`);
}

// --- shared helpers --------------------------------------------------------

// Reuse the node's own state-root implementation rather than reimplementing it
// here. A second copy that drifted by one field would report agreement between
// databases that genuinely differ, which is worse than having no check at all.
async function loadComputeStateRoot() {
  const p = join(HERE, '..', 'dist', 'core', 'state-root.js');
  if (!existsSync(p)) {
    fail(
      'Run "npm run build" in ae-node first.\n' +
        "  This script reuses the node's own state-root code, so the verification\n" +
        '  below is meaningful rather than a second opinion from a copy.',
    );
  }
  return (await import(pathToFileURL(p).href)).computeStateRoot;
}

function openExisting(path, readonly) {
  if (!existsSync(path)) {
    fail(`No database at ${path}\n  Run this from the ae-node directory, or pass --db <path>.`);
  }
  // DatabaseSync creates missing files, so the guard above is what turns a
  // wrong working directory into a clear message instead of a stray empty
  // database and a confusing "no such table: accounts".
  return new DatabaseSync(path, readonly ? { readOnly: true } : undefined);
}

function head(db) {
  const row = db.prepare('SELECT MAX(number) AS h FROM blocks').get();
  return row?.h ?? 0;
}

function blockAt(db, n) {
  return db
    .prepare('SELECT number, hash, timestamp, state_root FROM blocks WHERE number = ?')
    .get(n);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// --- export ----------------------------------------------------------------

async function doExport() {
  const dbPath = resolve(flag('db', './data/ae-node.db'));
  const db = openExisting(dbPath, /* readonly */ true);

  const h = head(db);
  const tip = blockAt(db, h);
  const computeStateRoot = await loadComputeStateRoot();
  const liveRoot = computeStateRoot(db);

  const outPath = resolve(flag('out', `./data/ae-snapshot-${h}-${stamp()}.db`));
  mkdirSync(dirname(outPath), { recursive: true });
  if (existsSync(outPath)) fail(`${outPath} already exists. Pick another --out.`);

  // VACUUM INTO, not a file copy. On a live WAL database the newest committed
  // pages live in the -wal sidecar; copying ae-node.db alone silently omits
  // them and produces a snapshot that is stale or internally inconsistent.
  // VACUUM INTO reads through a proper transaction and writes one compacted,
  // consistent file. It also rebuilds the file, dropping the free pages that
  // accumulate on a long-running node.
  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  db.close();

  const size = statSync(outPath).size;
  const digest = sha256File(outPath);

  console.log(`
  Snapshot written

    file        ${outPath}
    size        ${human(size)}
    sha256      ${digest}

    height      ${h}
    block hash  ${tip?.hash ?? '(none)'}
    state root  ${tip?.state_root ?? '(not recorded at this height)'}
    live root   ${liveRoot}
`);

  if (tip?.state_root && tip.state_root !== liveRoot) {
    // Expected while the node is running: the recorded root describes state at
    // the end of block h, and the node has kept working since. Worth saying out
    // loud, because anyone comparing the two lines above will otherwise wonder
    // which one is wrong.
    console.log(
      `  The live root differs from the recorded one because this node has\n` +
        `  applied work since block ${h} committed (a newer block, or the day\n` +
        `  cycle). Verification uses the recorded root, so this is fine.\n`,
    );
  }
  if (tip && !tip.state_root) {
    console.log(
      '  No state root recorded at the head block, so `verify` cannot check this\n' +
        '  snapshot against the network. That happens on a chain whose head predates\n' +
        '  state-root recording (schema v16). Let the node commit a few more blocks\n' +
        '  and export again.\n',
    );
  }

  console.log('  Next: send the file, then on the receiving machine run\n');
  console.log('    node scripts/snapshot.mjs verify <file> --peer http://<a-node>:3000\n');
}

// --- verify ----------------------------------------------------------------

async function doVerify() {
  const file = args[1];
  if (!file || file.startsWith('--')) fail('verify needs a snapshot file: verify <file>');
  const path = resolve(file);
  if (!existsSync(path)) fail(`No such file: ${path}`);

  const db = openExisting(path, /* readonly */ true);
  const computeStateRoot = await loadComputeStateRoot();

  console.log(`\n  Verifying ${path}\n`);

  let problems = 0;
  const bad = (m) => {
    problems++;
    console.log(`  FAIL  ${m}`);
  };
  const ok = (m) => console.log(`  ok    ${m}`);

  // 1. Is it even our database?
  let h;
  let tip;
  try {
    h = head(db);
    tip = blockAt(db, h);
  } catch (e) {
    fail(`Not readable as an ae-node database: ${e.message}`);
  }
  if (!tip) fail('Snapshot contains no blocks.');
  ok(`readable, head is block ${h} (${tip.hash.slice(0, 16)}...)`);

  const accounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
  const txs = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
  ok(`${accounts} accounts, ${txs} transactions, ${human(statSync(path).size)}`);

  // 2. Internal consistency: does the state in the file actually hash to the
  //    root the file records for its own head? This catches a truncated
  //    transfer, a torn copy taken with cp on a live WAL database, or bit rot.
  //    It does NOT catch a donor who made both up.
  const recorded = tip.state_root;
  if (!recorded) {
    bad(
      `no state root recorded at block ${h}, so the file cannot be checked\n` +
        '        against anything. Ask for a snapshot taken at a later height.',
    );
  } else {
    const actual = computeStateRoot(db);
    if (actual === recorded) {
      ok(`state hashes to the recorded root ${recorded.slice(0, 16)}...`);
    } else {
      bad(
        'state does NOT match the root recorded in the file.\n' +
          `        recorded ${recorded}\n` +
          `        actual   ${actual}\n` +
          '        The file is corrupt, or was copied from a running node without\n' +
          '        VACUUM INTO. Do not import it. Ask for a fresh export.',
      );
    }
  }
  db.close();

  // 3. The check that carries the weight: do independent nodes agree that this
  //    is the root at this height?
  const peers = flagAll('peer');

  // Skip the peer stage entirely once the file has already failed its own
  // internal check. Printing "only that the file is internally consistent"
  // under a FAIL that says it is not would be actively wrong, and asking peers
  // about a root the file does not match answers nothing.
  if (problems > 0) {
    console.log(`
  ${problems} problem(s). Do not import this snapshot.
`);
    exit(1);
  }

  if (peers.length === 0) {
    console.log(`
  No --peer given, so nothing has confirmed this is the REAL state at block
  ${h} - only that the file is internally consistent. Anyone who can hand you
  a file can hand you a consistent fake.

  Re-run with the nodes you want to ask:
    node scripts/snapshot.mjs verify ${file} --peer http://<node>:3000
`);
  } else if (recorded) {
    console.log('');
    let agree = 0;
    for (const peer of peers) {
      const url = `${peer.replace(/\/$/, '')}/api/v1/network/state-root?height=${h}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const code = body?.error?.code ?? res.status;
          if (code === 'NOT_FOUND') {
            console.log(`  ?     ${peer} has not reached block ${h} yet`);
          } else if (code === 'ROOT_NOT_RECORDED') {
            console.log(`  ?     ${peer} committed block ${h} before it recorded roots`);
          } else {
            console.log(`  ?     ${peer} returned ${code}`);
          }
          continue;
        }
        const theirs = body?.data?.stateRoot;
        if (theirs === recorded) {
          agree++;
          ok(`${peer} agrees at block ${h}`);
        } else {
          bad(
            `${peer} DISAGREES at block ${h}\n` +
              `        theirs ${theirs}\n` +
              `        file   ${recorded}`,
          );
        }
      } catch (e) {
        console.log(`  ?     ${peer} unreachable (${e.message})`);
      }
    }
    console.log('');
    if (agree === 0) {
      // Deliberately distinct from a disagreement: nobody confirmed is not the
      // same as somebody contradicting. Both mean "do not import", for
      // different reasons, and conflating them would mislead whoever is
      // debugging it at 11pm.
      bad(
        `no peer confirmed the root at block ${h}. Unreachable or behind is not\n` +
          '        the same as agreeing.',
      );
    } else {
      ok(`${agree} of ${peers.length} peer(s) confirm the state at block ${h}`);
    }
  }

  if (problems > 0) {
    console.log(`\n  ${problems} problem(s). Do not import this snapshot.\n`);
    exit(1);
  }

  // Deliberately different wording for the two passing outcomes. "Looks good"
  // after a peerless run would quietly undo the warning printed above it, and
  // the whole point of that warning is that internal consistency is the weaker
  // of the two checks by a wide margin.
  if (peers.length === 0) {
    console.log(`
  The file is intact but UNVERIFIED against the network. To install it anyway:

    node scripts/snapshot.mjs import ${file}

  That would put this node at block ${h} holding state nobody else confirmed.
`);
    return;
  }

  console.log(`
  Verified. Install it with

    node scripts/snapshot.mjs import ${file}

  then start the node normally - it will sync forward from block ${h}.
`);
}

// --- import ----------------------------------------------------------------

function doImport() {
  const file = args[1];
  if (!file || file.startsWith('--')) fail('import needs a snapshot file: import <file>');
  const src = resolve(file);
  if (!existsSync(src)) fail(`No such file: ${src}`);

  const dbPath = resolve(flag('db', './data/ae-node.db'));
  const force = args.includes('--force');

  // Refuse to run against a live node. Overwriting the file a running process
  // holds open leaves it reading pages that no longer describe the same
  // database, which fails later and somewhere else.
  const wal = `${dbPath}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0 && !force) {
    fail(
      `${wal} is non-empty, which usually means a node is running against\n` +
        `  ${dbPath}.\n\n` +
        '  Stop the node first. Importing under a running node corrupts it.\n' +
        '  If the node is definitely stopped, re-run with --force.',
    );
  }

  if (existsSync(dbPath)) {
    if (!force) {
      const existing = new DatabaseSync(dbPath, { readOnly: true });
      let h = 0;
      try {
        h = head(existing);
      } catch {
        h = 0;
      }
      existing.close();
      fail(
        `${dbPath} already exists (head block ${h}).\n\n` +
          "  Importing replaces this node's entire state. If that is what you want:\n" +
          `    node scripts/snapshot.mjs import ${file} --force\n\n` +
          '  A timestamped backup is kept either way.',
      );
    }
    // Rename rather than delete. If the import turns out to be wrong, the only
    // copy of this node's state should not be something we destroyed for
    // tidiness.
    const backup = `${dbPath}.before-snapshot-${stamp()}`;
    renameSync(dbPath, backup);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, backup + suffix);
    }
    console.log(`\n  Previous database moved to\n    ${backup}`);
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(src, dbPath);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const h = head(db);
  db.close();

  console.log(`
  Imported snapshot at block ${h} into
    ${dbPath}

  Start the node the usual way:

    npm run dev -- --config=./node-config.json

  It will connect to its seed peers and sync forward from ${h}, which is the
  part that is fast. Watch for "Synced historical block" lines climbing toward
  the network head.

  This node keeps its own identity - the keystore is a separate file and the
  snapshot did not touch it. If this machine is a validator it is still that
  validator.
`);
}

// --- dispatch --------------------------------------------------------------

switch (command) {
  case 'export':
    await doExport();
    break;
  case 'verify':
    await doVerify();
    break;
  case 'import':
    doImport();
    break;
  default:
    usage();
    exit(command === undefined || command === '--help' || command === '-h' ? 0 : 1);
}
