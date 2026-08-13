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
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
  console.log('[DevServer] Loaded .env');
}

const path = require('path');
const os = require('os');
const devUserDataPath = process.env.FLO_DEV_USER_DATA || __dirname;

// ── Mock Electron's `app` module ──────────────────────────────────────────────
const mockApp = {
  isPackaged: Boolean(process.env.FLO_DEV_USER_DATA),
  getPath: (name) => {
    if (name === 'userData') return devUserDataPath;
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
  return originalLoad.call(this, request, parent, isMain);
};

// ── Now load and start the compiled backend ───────────────────────────────────
const { initDatabase, closeDatabase, beginDatabaseShutdown, waitForDatabaseRequests } = require('./dist/db');
const { createExitCodeAwareShutdown } = require('./dist/shutdown');
const { startServer, stopServer, getServerPort } = require('./dist/server');
const { startKdsServer, stopKdsServer, getKdsPort } = require('./dist/kds-server');
const { startServerApp, stopServerApp, getServerAppPort } = require('./dist/server-app');

let exitRequested = false;
const requestShutdown = createExitCodeAwareShutdown(async () => {
  let cleanupFailed = false;
  try { await stopServerApp(); } catch (err) { console.error('[DevServer] Server App shutdown failed:', err); cleanupFailed = true; }
  try { await stopServer(); } catch (err) { console.error('[DevServer] Main server shutdown failed:', err); cleanupFailed = true; }
  try { await stopKdsServer(); } catch (err) { console.error('[DevServer] KDS server shutdown failed:', err); cleanupFailed = true; }
  try { beginDatabaseShutdown(); await waitForDatabaseRequests(); } catch (err) { console.error('[DevServer] Database request drain failed:', err); cleanupFailed = true; }
  try { closeDatabase(); } catch (err) { console.error('[DevServer] Database shutdown failed:', err); cleanupFailed = true; }
  Module._load = originalLoad;
  return cleanupFailed ? 1 : 0;
});

async function shutdown(exitCode = 0) {
  const finalExitCode = await requestShutdown(exitCode);
  if (!exitRequested) {
    exitRequested = true;
    process.exit(finalExitCode);
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('uncaughtException', (err) => {
  console.error('[DevServer] Uncaught exception:', err);
  void shutdown(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[DevServer] Unhandled rejection:', err);
  void shutdown(1);
});

(async () => {
  try {
    console.log('[DevServer] Initializing database...');
    initDatabase();

    console.log('[DevServer] Starting Express, KDS, and Server App servers...');
    await startServer();
    await startKdsServer();
    await startServerApp();

    console.log(`[DevServer] ✅ Main API running on http://localhost:${getServerPort()}`);
    console.log(`[DevServer] ✅ KDS Server running on http://localhost:${getKdsPort()}`);
    console.log(`[DevServer] ✅ Server App running on http://localhost:${getServerAppPort()}`);
    console.log('[DevServer]    Frontend dev server: http://localhost:3000');
    console.log('[DevServer]    API health: http://localhost:3001/api/health');
  } catch (err) {
    console.error('[DevServer] Failed to start:', err);
    await shutdown(1);
  }
})();
