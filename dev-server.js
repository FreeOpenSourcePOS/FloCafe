/**
 * Standalone dev server — runs the Express + SQLite backend WITHOUT Electron.
 * Mocks only the Electron APIs used by db.ts and server.ts.
 * Usage: node dev-server.js
 */

// Load .env before anything else
const fs = require('fs');
const envPath = require('path').join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
  console.log('[DevServer] Loaded .env');
}

const path = require('path');
const os = require('os');

// ── Mock Electron's `app` module ──────────────────────────────────────────────
const mockApp = {
  isPackaged: false,
  getPath: (name) => {
    if (name === 'userData') return path.join(__dirname);
    if (name === 'documents') return os.homedir();
    return os.tmpdir();
  },
  getVersion: () => require('./package.json').version,
  getName: () => 'Flo (dev)',
};

require('module').Module._resolveFilename = (function (original) {
  return function (request, ...args) {
    if (request === 'electron') {
      return __filename; // will be intercepted below
    }
    return original.call(this, request, ...args);
  };
})(require('module').Module._resolveFilename);

// Intercept `require('electron')` before any dist file loads it
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: mockApp,
      // Stub anything else that might be imported at module level
      BrowserWindow: class {},
      ipcMain: { handle: () => {}, on: () => {} },
      dialog: {},
      shell: {},
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
      Tray: class {},
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    };
  }
  return originalLoad.apply(this, arguments);
};

// ── Now load and start the compiled backend ───────────────────────────────────
const { initDatabase } = require('./dist/db');
const { startServer } = require('./dist/server');

(async () => {
  try {
    console.log('[DevServer] Initializing database...');
    initDatabase();

    console.log('[DevServer] Starting Express server...');
    await startServer();

    console.log('[DevServer] ✅ Backend running on http://localhost:3001');
    console.log('[DevServer]    Frontend dev server: http://localhost:3000');
    console.log('[DevServer]    API health: http://localhost:3001/api/health');
  } catch (err) {
    console.error('[DevServer] Failed to start:', err);
    process.exit(1);
  }
})();
