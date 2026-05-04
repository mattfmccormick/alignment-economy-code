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

const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const isDev = process.env.ELECTRON_DEV === '1';
const NODE_PORT = 3000;
const HEALTH_URL = `http://localhost:${NODE_PORT}/api/v1/health`;

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

  nodeChild = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AE_API_PORT: String(NODE_PORT),
      AE_DB_PATH: path.join(dataDir, 'ae-node.db'),
      AE_LOG_LEVEL: 'info',
      // Authority node by default. Multi-validator consensus comes later.
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
