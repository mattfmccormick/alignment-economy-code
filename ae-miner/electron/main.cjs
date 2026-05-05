// Electron main process for the Alignment Economy Miner desktop app.
//
// Boot sequence (production):
//   1. Locate the bundled ae-node (resourcesPath/ae-node/dist/node/cli.js)
//   2. Spawn it with Electron's built-in Node (ELECTRON_RUN_AS_NODE=1) on
//      AE_API_PORT=3001 — the wallet's bundled node defaults to 3000, so a
//      machine running both apps gets two independent nodes instead of a
//      port collision. The DB lives under userData/ae-miner-data so the
//      miner has its own state, not the wallet's.
//   3. Poll /api/v1/health until 200 (timeout: 30s)
//   4. Create the miner window pointing at the bundled React build
//   5. On window-all-closed, send SIGTERM to the ae-node child
//
// Dev mode (ELECTRON_DEV=1):
//   - Skip the spawn. Assume the developer is running `npm run dev` in ae-node
//     manually. Window points at the Vite dev server (localhost:5174).
//
// This mirrors ae-app/electron/main.cjs almost line-for-line. The only
// real differences are: a different default port, a different userData
// subdirectory, the dev Vite URL (5174 vs 5173), and the BrowserWindow
// dimensions (the miner is a desktop dashboard, not a phone-shaped wallet).

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  console.warn('[updater] electron-updater not available:', err.message);
}

const isDev = process.env.ELECTRON_DEV === '1';
const NODE_PORT = 3001;
const HEALTH_URL = `http://localhost:${NODE_PORT}/api/v1/health`;

let nodeChild = null;
let mainWindow = null;

// Same network-config layout as the wallet, scoped to the miner's userData
// so the two installed apps don't trample each other.
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

function findAeNodeEntry() {
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
  if (isDev) return Promise.resolve();

  const entry = findAeNodeEntry();
  const cwd = findAeNodeWorkdir();
  if (!entry || !cwd) {
    return Promise.reject(new Error('Bundled ae-node not found. Resources missing from build.'));
  }

  // Persist the SQLite database under userData so it survives reinstalls and
  // doesn't pollute the read-only resources directory. Separate from the
  // wallet's `ae-node-data` directory so two installed apps don't share state.
  const dataDir = path.join(app.getPath('userData'), 'ae-miner-data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Spawn env mirrors the wallet's: solo by default, BFT when a saved
  // network config is present. Note the miner's userData is separate from
  // the wallet's, so each app has its own network choice; running both
  // apps on the same network requires configuring each individually.
  const cfg = readNetworkConfig();
  const np = networkPaths();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    AE_API_PORT: String(NODE_PORT),
    // P2P port: miner uses 9001 so it doesn't collide with the wallet's
    // bundled node on 9000 when both apps are installed on the same machine.
    AE_P2P_PORT: '9001',
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
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Alignment Economy Miner',
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
    mainWindow.loadURL('http://localhost:5174');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // F12 / Ctrl+Shift+I toggles DevTools in the packaged build. See
  // ae-app/electron/main.cjs for the rationale.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const isToggleDevtools =
      input.key === 'F12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (isToggleDevtools) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

// Same IPC handler as the wallet. The miner doesn't yet ship a network
// picker UI of its own, but exposing this lets advanced setups (or a
// future picker added to ae-miner) push a config in without touching the
// filesystem from the renderer.
ipcMain.handle('aeNetwork:saveConfig', async (_event, opts) => {
  if (!opts || typeof opts !== 'object') return { ok: false, error: 'opts required' };
  const { mode, spec, keystore } = opts;
  if (mode !== 'solo' && mode !== 'bft') return { ok: false, error: "mode must be 'solo' or 'bft'" };
  const np = networkPaths();
  fs.mkdirSync(np.dir, { recursive: true });
  if (mode === 'solo') {
    if (fs.existsSync(np.config)) fs.unlinkSync(np.config);
    if (fs.existsSync(np.genesis)) fs.unlinkSync(np.genesis);
    if (fs.existsSync(np.keystore)) fs.unlinkSync(np.keystore);
    return { ok: true, mode: 'solo' };
  }
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

ipcMain.handle('aeNetwork:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(async () => {
  try {
    await startAeNode();
  } catch (err) {
    dialog.showErrorBox(
      'Alignment Economy Miner',
      `Could not start the local network node:\n\n${err.message || err}\n\nThe miner UI will open but verifications and votes won't work until the node is running.`,
    );
  }

  createWindow();

  if (autoUpdater && app.isPackaged && !isDev) {
    autoUpdater.on('error', (err) => console.warn('[updater] error:', err && err.message));
    autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info && info.version));
    autoUpdater.on('update-downloaded', (info) => console.log('[updater] downloaded, will install on quit:', info && info.version));
    try { autoUpdater.checkForUpdatesAndNotify(); } catch (err) { console.warn('[updater] check failed:', err && err.message); }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAeNode();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopAeNode);
