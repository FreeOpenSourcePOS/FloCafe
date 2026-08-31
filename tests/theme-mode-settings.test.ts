/**
 * theme_mode Write-Path Negative Tests (gh-513)
 *
 * Covers the two new rejection branches added for the `theme_mode` setting:
 *   - main/routes/settings.ts — the wildcard PUT /:key handler rejects
 *     values outside `'light' | 'dark' | 'system'` with HTTP 400.
 *   - main/ipc.ts — the IPC `set-setting` handler rejects the same values
 *     with `{ success: false, error: 'Invalid theme_mode value' }`.
 *
 * Plus positive controls so the allowlist registration is exercised
 * end-to-end on both surfaces.
 *
 * Pattern: Electron-ABI integration test (run via run-electron-node-test.cjs
 * because better-sqlite3 is built for Electron's Node ABI). Mocked electron
 * module captures `ipcMain.handle` registrations (printer-ipc.test.ts
 * pattern) AND the app.getPath() userData (integration-discount-settings
 * pattern); the real Express app + SQLite DB are mounted so both write
 * paths are exercised against the real branches.
 *
 * Run: npm run test:theme-mode-settings
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

const Module = require('module');
const originalLoad = Module._load;
const express = require('express');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-theme-mode-settings-'));

// Captured IPC handlers (printer-ipc pattern).
const registered = new Map<string, (...args: any[]) => any>();
const mockApp = {
  isPackaged: true,
  getPath: (name: string) => {
    if (name === 'userData') return testDir;
    if (name === 'documents') return testDir;
    return testDir;
  },
  getName: () => 'FloCafe',
  getVersion: () => '0.0.0-test',
};
const mockBrowserWindow = class {
  loadURL() {}
  on() {}
  webContents = { send: () => {}, on: () => {} };
};

Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: mockApp,
      ipcMain: {
        on: () => {},
        handle: (channel: string, listener: (...args: any[]) => any) => {
          registered.set(channel, listener);
        },
      },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
      BrowserWindow: mockBrowserWindow,
    };
  }
  // Stubs required by main/ipc.ts imports (mirrors tests/printer-ipc.test.ts).
  if (request === './middleware/security') {
    return { clearInMemoryRevokedTokens: () => {}, clearUserAuthCache: () => {} };
  }
  if (request === './routes/auth') return { clearJWTSecretCache: () => {} };
  if (request === './server') return { getLocalIP: () => '127.0.0.1' };
  if (request === './kds-server') return { getKdsPort: () => 3002 };
  if (request === './services/master-pin') {
    return {
      authorizeMasterPin: () => ({ ok: false, error: 'Invalid master PIN' }),
      isMasterPinAvailable: () => true,
      isMasterPinSet: () => true,
    };
  }
  if (request === './services/schema-health') {
    return {
      runHealthCheck: () => ({ status: 'healthy', findings: [] }),
      applySafeFixes: () => ({ applied: [], skipped: [], errors: [] }),
    };
  }
  if (request === './services/whatsapp') return { getStatus: () => ({ connected: false }) };
  if (request === './window-options') return { createKdsWindow: () => ({}) };
  return originalLoad.apply(this, arguments as any);
};

// ── Assert helpers ───────────────────────────────────────────────────────
//
// the runner exits non-zero on the first throw. Stdlib covers everything the
// hand-rolled counter block did.

async function httpRequest(baseUrl: string, urlPath: string, options: any = {}): Promise<any> {
  const url = new URL(urlPath, baseUrl);
  const method = options.method || 'GET';
  const headers: any = { 'Content-Type': 'application/json' };
  if (options.headers) Object.assign(headers, options.headers);

  return new Promise<any>((resolve) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
      (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: body });
          }
        });
      },
    );
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  theme_mode Write-Path Tests (gh-513)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
  const { settingsRoutes } = require('../main/routes/settings');
  const { registerIpcHandlers } = require('../main/ipc');

  try {
    initDatabase();
  } catch (e: any) {
    if (e?.message?.includes('ABI')) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw e;
  }

  // Register IPC handlers against the mocked ipcMain (printer-ipc pattern).
  registerIpcHandlers();

  // Mount a minimal Express app with the real settings router + auth-mock
  // (owner role satisfies requireRole(...ROLE_ACCESS.ownerManager)).
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 1, role: 'owner', name: 'Test Owner' };
    next();
  });
  app.use('/api/settings', settingsRoutes);

  let server: any;
  let baseUrl: string;
  try {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // ── HTTP wildcard PUT — negative path ──────────────────────────────
    console.log('1. PUT /api/settings/theme_mode with bogus value → HTTP 400');
    {
      const res = await httpRequest(baseUrl, '/api/settings/theme_mode', {
        method: 'PUT',
        body: JSON.stringify({ value: 'bogus' }),
      });
      assert.equal(res.status, 400, 'returns 400');
      assert.ok(String(res.data?.error).includes('Invalid theme_mode value'), 'error mentions theme_mode');
    }

    // ── HTTP wildcard PUT — also rejects non-string non-mode values ──
    console.log('\n2. PUT /api/settings/theme_mode with numeric value → HTTP 400');
    {
      const res = await httpRequest(baseUrl, '/api/settings/theme_mode', {
        method: 'PUT',
        body: JSON.stringify({ value: 42 }),
      });
      // 42 fails isThemeMode; route is the rejection point.
      assert.equal(res.status, 400, 'returns 400 for non-string invalid');
    }

    // ── HTTP wildcard PUT — positive control ───────────────────────────
    console.log('\n3. PUT /api/settings/theme_mode with "dark" → success and persists');
    {
      const res = await httpRequest(baseUrl, '/api/settings/theme_mode', {
        method: 'PUT',
        body: JSON.stringify({ value: 'dark' }),
      });
      assert.equal(res.status, 200, 'returns 200');
      const db = getDatabase();
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'theme_mode'")
        .get() as { value: string } | undefined;
      assert.equal(row?.value, 'dark', 'row persisted to SQLite as "dark"');
    }

    // ── IPC set-setting — negative path ─────────────────────────────────
    console.log('\n4. IPC set-setting("theme_mode", "bogus") → { success: false, error: ... }');
    {
      const handler = registered.get('set-setting');
      assert.ok(!!handler, 'set-setting IPC handler is registered');
      const trustedSender = { sender: { getURL: () => 'http://localhost:3001/' } };
      const result = await handler!(trustedSender, 'theme_mode', 'bogus');
      assert.equal(result?.success, false, 'returns success: false');
      assert.equal(result?.error, 'Invalid theme_mode value', 'returns the expected error');
    }

    // ── IPC set-setting — positive control ──────────────────────────────
    console.log('\n5. IPC set-setting("theme_mode", "light") → { success: true } and persists');
    {
      const handler = registered.get('set-setting');
      const trustedSender = { sender: { getURL: () => 'http://localhost:3001/' } };
      const result = await handler!(trustedSender, 'theme_mode', 'light');
      assert.equal(result?.success, true, 'returns success: true');
      const db = getDatabase();
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'theme_mode'")
        .get() as { value: string } | undefined;
      assert.equal(row?.value, 'light', 'IPC write also persisted (overwrote prior "dark")');
    }

    // ── IPC set-setting — also rejects non-mode values ─────────────────
    console.log('\n6. IPC set-setting("theme_mode", "DARK") → rejected (case-sensitive)');
    {
      const handler = registered.get('set-setting');
      const trustedSender = { sender: { getURL: () => 'http://localhost:3001/' } };
      const result = await handler!(trustedSender, 'theme_mode', 'DARK');
      assert.equal(result?.success, false, 'uppercase is not a valid ThemeMode');
    }


  } finally {
    if (server) server.close();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
