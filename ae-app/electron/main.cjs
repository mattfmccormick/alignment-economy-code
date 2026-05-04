// Electron main process for the Alignment Economy Wallet desktop app.
//
// Boot sequence (production):
//   1. Locate the bundled ae-node (resourcesPath/ae-node/dist/node/cli.js)
//   2. Spawn it with Electron's built-in Node (ELECTRON_RUN_AS_NODE=1)
//   3. Poll /api/v1/health until 200 (timeout: 30s)
//   4. Create the wallet window pointing at the bundled React build
//   5. On window-all-closed, send SIGTERM to the ae-node child
//
// Dev mode (ELECTRON_DEV=1):
//   - Skip the spawn. Assume the developer is running `npm run dev` in ae-node
//     manually. Window points at the Vite dev server (localhost:5173).

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const isDev = process.env.ELECTRON_DEV === '1';
const NODE_PORT = 3000;
const HEALTH_URL = `http://localhost:${NODE_PORT}/api/v1/health`;

// Network config layout. When the user finishes the Start-new or Join-existing
// onboarding flow, the renderer pushes the spec + keystore + chosen mode here
// via aeNetwork:saveConfig (preload bridge). Next time main starts ae-node it
// reads these and switches from solo authority mode into real BFT mode with
// the right genesis + keys. None of these files are touched on a Solo wallet.
const networkPaths = () => {
  const dir = path.join(app.getPath('userData'), 'ae-network');
  return {
    dir,
    config: path.join(dir, 'network-config.json'),
    genesis: path.join(dir, 'genesis.json'),
    keystore: path.join(dir, 'keystore.json'),
  };
};

function readNetworkConfig() {
  try {
    const p = networkPaths();
    if (!fs.existsSync(p.config)) return null;
    const raw = fs.readFileSync(p.config, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && (cfg.mode === 'bft' || cfg.mode === 'solo')) return cfg;
    return null;
  } catch (err) {
    console.error('[ae-network] failed to read network-config.json:', err && err.message);
    return null;
  }
}

let nodeChild = null;
let mainWindow = null;

function findAeNodeEntry() {
  // In packaged builds, electron-builder copies extraResources to:
  //   - process.resourcesPath/ae-node/...    (when asar packed)
  // In development running `electron .`, prefer the workspace layout:
  //   - <repoRoot>/ae-node/dist/node/cli.js
  const candidates = [
    path.join(process.resourcesPath || '', 'ae-node', 'dist', 'node', 'cli.js'),
    path.join(__dirname, '..', '..', 'ae-node', 'dist', 'node', 'cli.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findAeNodeWorkdir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'ae-node'),
    path.join(__dirname, '..', '..', 'ae-node'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function startAeNode() {
  if (isDev) return Promise.resolve(); // assume dev server is running externally

  const entry = findAeNodeEntry();
  const cwd = findAeNodeWorkdir();
  if (!entry || !cwd) {
    return Promise.reject(new Error('Bundled ae-node not found. Resources missing from build.'));
  }

  // Persist the SQLite database under userData so it survives reinstalls and
  // doesn't pollute the read-only resources directory.
  const dataDir = path.join(app.getPath('userData'), 'ae-node-data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Pick spawn env based on the saved network config. Solo (or no config)
  // keeps today's authority single-validator behavior. BFT loads the
  // genesis + keystore the user persisted during Start-new/Join-existing
  // onboarding so the node boots into real multi-validator mode and is
  // able to peer with other operators on the same network.
  const cfg = readNetworkConfig();
  const np = networkPaths();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    AE_API_PORT: String(NODE_PORT),
    // P2P port 9000 (default). Wallet uses 9000, miner uses 9001 so that
    // both installed apps on one machine each get their own listening port.
    AE_P2P_PORT: '9000',
    AE_DB_PATH: path.join(dataDir, 'ae-node.db'),
    AE_LOG_LEVEL: 'info',
  };
  if (cfg && cfg.mode === 'bft' && cfg.accountId) {
    Object.assign(env, {
      AE_CONSENSUS_MODE: 'bft',
      AE_GENESIS_CONFIG_PATH: np.genesis,
      AE_NODE_KEY_PATH: np.keystore,
      AE_BFT_LOCAL_ACCOUNT_ID: cfg.accountId,
      AE_NODE_ID: cfg.accountId,
    });
    console.log(`[ae-network] booting in BFT mode for ${cfg.networkId || '(unknown network)'} as ${cfg.accountId}`);
  } else {
    Object.assign(env, {
      AE_NODE_ID: 'desktop-authority',
      AE_AUTHORITY_NODE_ID: 'desktop-authority',
    });
    console.log('[ae-network] booting in solo authority mode');
  }

  nodeChild = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  nodeChild.stdout.on('data', (chunk) => process.stdout.write(`[ae-node] ${chunk}`));
  nodeChild.stderr.on('data', (chunk) => process.stderr.write(`[ae-node] ${chunk}`));

  nodeChild.on('exit', (code) => {
    nodeChild = null;
    if (code !== 0 && code !== null) {
      console.error(`[ae-node] exited with code ${code}`);
    }
  });

  // Poll /health every 500ms until it returns 200, max 30 seconds.
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = () => {
      const req = http.get(HEALTH_URL, { timeout: 1000 }, (res) => {
        if (res.statusCode === 200) return resolve();
        scheduleNext();
      });
      req.on('error', scheduleNext);
      req.on('timeout', () => { req.destroy(); scheduleNext(); });
    };
    const scheduleNext = () => {
      if (Date.now() > deadline) {
        return reject(new Error('ae-node did not respond on /api/v1/health within 30s'));
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

function stopAeNode() {
  if (nodeChild && !nodeChild.killed) {
    nodeChild.kill('SIGTERM');
    setTimeout(() => { if (nodeChild && !nodeChild.killed) nodeChild.kill('SIGKILL'); }, 3000);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 820,
    minWidth: 360,
    minHeight: 600,
    title: 'Alignment Economy Wallet',
    backgroundColor: '#0f1a2e',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

// Renderer asks main to write the active network config + spec + keystore to
// userData. We validate the shape just enough to keep junk off disk; the
// renderer is the source of truth for what's a valid spec/keystore.
ipcMain.handle('aeNetwork:saveConfig', async (_event, opts) => {
  if (!opts || typeof opts !== 'object') return { ok: false, error: 'opts required' };
  const { mode, spec, keystore } = opts;
  if (mode !== 'solo' && mode !== 'bft') return { ok: false, error: "mode must be 'solo' or 'bft'" };
  const np = networkPaths();
  fs.mkdirSync(np.dir, { recursive: true });
  if (mode === 'solo') {
    // Reset to default authority behavior on next boot.
    if (fs.existsSync(np.config)) fs.unlinkSync(np.config);
    if (fs.existsSync(np.genesis)) fs.unlinkSync(np.genesis);
    if (fs.existsSync(np.keystore)) fs.unlinkSync(np.keystore);
    return { ok: true, mode: 'solo' };
  }
  // BFT: spec + keystore both required.
  if (!spec || typeof spec !== 'object' || typeof spec.networkId !== 'string') {
    return { ok: false, error: 'BFT mode requires a valid spec' };
  }
  if (!keystore || typeof keystore !== 'object' || typeof keystore.accountId !== 'string') {
    return { ok: false, error: 'BFT mode requires a valid keystore' };
  }
  fs.writeFileSync(np.genesis, JSON.stringify(spec, null, 2));
  fs.writeFileSync(np.keystore, JSON.stringify(keystore, null, 2), { mode: 0o600 });
  fs.writeFileSync(np.config, JSON.stringify({
    mode: 'bft',
    networkId: spec.networkId,
    accountId: keystore.accountId,
    savedAt: new Date().toISOString(),
  }, null, 2));
  return { ok: true, mode: 'bft', configPath: np.config };
});

app.whenReady().then(async () => {
  try {
    await startAeNode();
  } catch (err) {
    dialog.showErrorBox(
      'Alignment Economy Wallet',
      `Could not start the local network node:\n\n${err.message || err}\n\nThe wallet will open but transactions won't work until the node is running.`,
    );
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAeNode();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopAeNode);
