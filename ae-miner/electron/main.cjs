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

const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const isDev = process.env.ELECTRON_DEV === '1';
const NODE_PORT = 3001;
const HEALTH_URL = `http://localhost:${NODE_PORT}/api/v1/health`;

let nodeChild = null;
let mainWindow = null;

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

  nodeChild = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AE_API_PORT: String(NODE_PORT),
      AE_DB_PATH: path.join(dataDir, 'ae-node.db'),
      AE_LOG_LEVEL: 'info',
      AE_NODE_ID: 'desktop-authority',
      AE_AUTHORITY_NODE_ID: 'desktop-authority',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAeNode();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopAeNode);
