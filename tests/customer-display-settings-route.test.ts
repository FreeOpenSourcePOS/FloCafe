/**
 * Customer display settings route tests
 *
 * Mounts the real settings router against a real SQLite DB (Electron-ABI test,
 * run via run-electron-node-test.cjs) and asserts the permission split, input
 * validation, defaults, and persistence of GET/PUT /api/settings/customer-display.
 *
 * Run: npm run test:customer-display-settings-route
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

const Module = require('module');
const originalLoad = Module._load;
const express = require('express');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-display-route-'));

Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getName: () => 'FloCafe', getVersion: () => '0.0.0-test' },
      ipcMain: { on: () => {}, handle: () => {} },
      dialog: {},
      BrowserWindow: class {},
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const ROUTE = '/api/settings/customer-display';
const VALID = { statuses: ['pending', 'ready'], refresh_seconds: 5, show_updated: false };

function request(baseUrl: string, urlPath: string, options: any = {}): Promise<{ status: number; data: any }> {
  const url = new URL(urlPath, baseUrl);
  const headers: any = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: options.method || 'GET', headers },
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

const put = (baseUrl: string, body: unknown, headers: any = {}) =>
  request(baseUrl, ROUTE, { method: 'PUT', body: JSON.stringify(body), headers });

async function main() {
  const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
  const { settingsRoutes } = require('../main/routes/settings');

  try {
    initDatabase();
  } catch (e: any) {
    if (e?.message?.includes('ABI')) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw e;
  }

  const db = getDatabase();
  const seedUser = (id: string, role: string) =>
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'unused', ?, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(id, id, `${id}@test.local`, role, now(), now());
  const deny = (userId: string, permission: string) =>
    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, ?, 'deny', 'cd-owner', ?, ?)
    `).run(userId, permission, now(), now());

  seedUser('cd-owner', 'owner');
  seedUser('cd-server', 'server');
  deny('cd-server', 'settings.view');
  seedUser('cd-locked', 'server');
  for (const permission of ['settings.view', 'orders.read', 'orders.create']) deny('cd-locked', permission);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId: String(req.headers['x-test-user'] || 'cd-owner'), role: 'owner', name: 'Test' };
    next();
  });
  app.use('/api/settings', settingsRoutes);

  const readStored = () =>
    (db.prepare("SELECT value FROM settings WHERE key = 'customer_display'").get() as { value: string } | undefined)?.value;

  let server: any;
  try {
    const baseUrl: string = await new Promise((resolve) => {
      server = app.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as any).port}`));
    });

    console.log('1. GET with nothing stored returns defaults');
    {
      const res = await request(baseUrl, ROUTE);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { statuses: ['pending', 'preparing', 'ready'], refresh_seconds: 3, show_updated: true });
    }

    console.log('2. PUT rejects malformed bodies and persists nothing');
    {
      const bad: unknown[] = [
        {},
        { ...VALID, statuses: [] },
        { ...VALID, statuses: ['cancelled'] },
        { ...VALID, refresh_seconds: 1 },
        { ...VALID, refresh_seconds: 61 },
        { ...VALID, refresh_seconds: 2.5 },
        { ...VALID, refresh_seconds: '5' },
        { ...VALID, show_updated: 'yes' },
      ];
      for (const body of bad) {
        const res = await put(baseUrl, body);
        assert.equal(res.status, 400, `rejects ${JSON.stringify(body)}`);
      }
      assert.equal(readStored(), undefined, 'no rejected body reached SQLite');
    }

    console.log('3. PUT accepts a valid body, normalizes it, and GET returns it');
    {
      const res = await put(baseUrl, { ...VALID, statuses: ['ready', 'pending'] });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, VALID);
      assert.deepEqual(JSON.parse(readStored() as string), VALID, 'persisted canonical config');
      const read = await request(baseUrl, ROUTE);
      assert.deepEqual(read.data, VALID);
    }

    console.log('4. A corrupt stored row falls back to defaults');
    {
      db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'customer_display'").run();
      const res = await request(baseUrl, ROUTE);
      assert.equal(res.status, 200);
      assert.equal(res.data.refresh_seconds, 3);
    }

    console.log('5. A role without settings.view can read but not write');
    {
      const headers = { 'x-test-user': 'cd-server' };
      const read = await request(baseUrl, ROUTE, { headers });
      assert.equal(read.status, 200, 'orders.read is enough to read');
      const write = await put(baseUrl, VALID, headers);
      assert.equal(write.status, 403, 'writes require settings.manage');
    }

    console.log('6. A role with no settings or order access cannot read');
    {
      const read = await request(baseUrl, ROUTE, { headers: { 'x-test-user': 'cd-locked' } });
      assert.equal(read.status, 403);
    }

    console.log('7. The generic wildcard cannot write the key directly');
    {
      const res = await request(baseUrl, '/api/settings/customer_display', {
        method: 'PUT',
        body: JSON.stringify({ value: '{"statuses":[]}' }),
      });
      assert.equal(res.status, 403, 'customer_display is not an allowlisted wildcard key');
    }

    console.log('\ncustomer-display-settings-route: all assertions passed');
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
