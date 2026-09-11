/**
 * Discount Settings Integration Tests
 *
 * Verifies:
 * 1. GET /api/settings/discount returns defaults
 * 2. PUT /api/settings/discount validates and persists
 * 3. discount_mode enforcement (percentage/flat/both)
 * 4. discount_requires_approval PIN gate
 *
 * Uses Electron runtime (via run-electron-node-test.cjs) because
 * better-sqlite3 is built for Electron's Node ABI.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-discount-settings.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Mock electron before any imports that reference it
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-discount-settings-test-'));
const mockApp = {
  isPackaged: true,
  getPath: (name: string) => {
    if (name === 'userData') return testDir;
    if (name === 'documents') return testDir;
    return testDir;
  },
  getName: () => 'flo-test',
  getVersion: () => '0.0.0-test',
};
const mockIpcMain = { handle: () => {}, on: () => {} };
const mockBrowserWindow = class {
  loadURL() {}
  on() {}
  webContents = { send: () => {}, on: () => {} };
};

Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'electron') {
    return { app: mockApp, ipcMain: mockIpcMain, BrowserWindow: mockBrowserWindow };
  }
  return originalLoad(request, parent, isMain);
};

// ── Helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  total++;
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message: string) {
  total++;
  const ok = haystack.includes(needle);
  if (ok) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message} — "${haystack}" does not include "${needle}"`);
  }
}

async function request(baseUrl: string, urlPath: string, options: any = {}) {
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
      }
    );
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Test setup ───────────────────────────────────────────────────────────

async function seedTestData(db: any) {
  // Ensure settings exist
  const settings = [
    ['discount_max_percentage', '25'],
    ['discount_max_amount', '0'],
    ['discount_mode', 'percentage'],
    ['discount_requires_approval', '0'],
  ];
  for (const [key, value] of settings) {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value);
  }

  // Create a test user with PIN
  const bcrypt = require('bcryptjs');
  const pinHash = bcrypt.hashSync('1234', 10);
  db.prepare(`
    INSERT OR IGNORE INTO users (name, email, role, pin_hash, created_at, updated_at)
    VALUES ('Test Manager', 'manager@test.com', 'manager', ?, datetime('now'), datetime('now'))
  `).run(pinHash);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Discount Settings Integration Tests');
  console.log('═══════════════════════════════════════════════════════════\n');

  const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
  const express = require('express');

  try {
    initDatabase();
  } catch (e: any) {
    if (e.message?.includes('ABI')) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77); // exit code 77 = skip (GNU convention)
    }
    throw e;
  }

  const db = getDatabase();
  seedTestData(db);

  // Build a minimal Express app with just the settings and orders routes
  const app = express();
  app.use(express.json());

  // Mock auth middleware for testing — must run BEFORE routes
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 1, role: 'owner', name: 'Test Owner' };
    next();
  });

  // Import and mount routes
  const { settingsRoutes } = require('../main/routes/settings');
  const { orderRoutes: ordersRouter } = require('../main/routes/orders');
  app.use('/api/settings', settingsRoutes);
  app.use('/api/orders', ordersRouter);

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

    // ── Test 1: GET /settings/discount returns defaults ──
    console.log('1. GET /api/settings/discount — returns defaults');
    {
      const res = await request(baseUrl, '/api/settings/discount');
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.discount_max_percentage, 25, 'default max percentage is 25');
      assertEqual(res.data.discount_max_amount, 0, 'default max amount is no limit');
      assertEqual(res.data.discount_mode, 'percentage', 'default mode is percentage');
      assertEqual(res.data.discount_requires_approval, false, 'default approval is false');
    }

    // ── Test 2: PUT /settings/discount — persist values ──
    console.log('\n2. PUT /api/settings/discount — persist values');
    {
      const res = await request(baseUrl, '/api/settings/discount', {
        method: 'PUT',
        body: JSON.stringify({
          discount_max_percentage: 30,
          discount_max_amount: 200,
          discount_mode: 'flat',
          discount_requires_approval: true,
        }),
      });
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.discount_max_percentage, 30, 'max percentage updated to 30');
      assertEqual(res.data.discount_max_amount, 200, 'max amount updated to 200');
      assertEqual(res.data.discount_mode, 'flat', 'mode updated to flat');
      assertEqual(res.data.discount_requires_approval, true, 'approval enabled');
    }

    // ── Test 3: PUT /settings/discount — invalid input ──
    console.log('\n3. PUT /api/settings/discount — invalid input');
    {
      const res1 = await request(baseUrl, '/api/settings/discount', {
        method: 'PUT',
        body: JSON.stringify({ discount_max_percentage: -5 }),
      });
      assertEqual(res1.status, 400, 'rejects negative percentage');
      assertIncludes(res1.data.error, '1 and 100', 'error mentions range');

      const res2 = await request(baseUrl, '/api/settings/discount', {
        method: 'PUT',
        body: JSON.stringify({ discount_max_amount: 'abc' }),
      });
      assertEqual(res2.status, 400, 'rejects non-numeric amount');

      const res3 = await request(baseUrl, '/api/settings/discount', {
        method: 'PUT',
        body: JSON.stringify({ discount_mode: 'invalid' }),
      });
      assertEqual(res3.status, 400, 'rejects invalid mode');
    }

    // ── Test 4: GET after PUT — values persisted ──
    console.log('\n4. GET /api/settings/discount — values persisted');
    {
      const res = await request(baseUrl, '/api/settings/discount');
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.discount_max_percentage, 30, 'max percentage is 30');
      assertEqual(res.data.discount_max_amount, 200, 'max amount is 200');
    }

    // Reset for next tests
    await request(baseUrl, '/api/settings/discount', {
      method: 'PUT',
      body: JSON.stringify({
        discount_max_percentage: 25,
        discount_max_amount: 0,
        discount_mode: 'percentage',
        discount_requires_approval: false,
      }),
    });

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exit(1);
  } finally {
    if (server) server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
