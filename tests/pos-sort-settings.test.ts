/**
 * POS catalog sort settings over HTTP: wildcard write validation, the dedicated read route's
 * defaults and role access, and the normalised fallback for corrupt stored values.
 *
 * Run: npm run test:pos-sort-settings
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

const Module = require('module');
const originalLoad = Module._load;
const express = require('express');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pos-sort-settings-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getName: () => 'FloCafe',
        getVersion: () => '0.0.0-test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

async function httpRequest(baseUrl: string, urlPath: string, options: any = {}): Promise<any> {
  const url = new URL(urlPath, baseUrl);
  const headers: any = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  return new Promise<any>((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method || 'GET',
        headers,
      },
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
    db
      .prepare(
        `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'unused', ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, id, `${id}@test.local`, role, now(), now());
  seedUser('pos-sort-owner', 'owner');
  seedUser('pos-sort-server', 'server');
  db.prepare("DELETE FROM user_permission_overrides WHERE user_id = 'pos-sort-server'").run();
  db.prepare(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
     VALUES ('pos-sort-server', 'settings.view', 'deny', 'pos-sort-owner', ?, ?)`,
  ).run(now(), now());

  const readStored = (key: string): string | undefined =>
    (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = {
      userId: String(req.headers['x-test-user'] || 'pos-sort-owner'),
      role: 'owner',
      name: 'Test',
    };
    next();
  });
  app.use('/api/settings', settingsRoutes);

  let server: any;
  try {
    const baseUrl: string = await new Promise((resolve) => {
      server = app.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as any).port}`));
    });
    const put = (key: string, value: unknown, headers?: Record<string, string>) =>
      httpRequest(baseUrl, `/api/settings/${key}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value }),
      });

    db.prepare("DELETE FROM settings WHERE key IN ('pos_category_sort','pos_item_sort')").run();

    console.log('1. Read route defaults to the saved order');
    let res = await httpRequest(baseUrl, '/api/settings/pos-sort');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { category_sort: 'saved', item_sort: 'saved' });

    console.log('2. Invalid values are refused and never persisted');
    for (const value of ['bogus', 'price_asc', '', 42, null]) {
      res = await put('pos_category_sort', value);
      assert.equal(res.status, 400, `category rejects ${JSON.stringify(value)}`);
    }
    for (const value of ['alpha', 'Name', '', 7]) {
      res = await put('pos_item_sort', value);
      assert.equal(res.status, 400, `item rejects ${JSON.stringify(value)}`);
    }
    assert.equal(readStored('pos_category_sort'), undefined);
    assert.equal(readStored('pos_item_sort'), undefined);

    console.log('3. Valid values persist and are served back');
    for (const value of ['saved', 'name']) {
      res = await put('pos_category_sort', value);
      assert.equal(res.status, 200, `category accepts ${value}`);
      assert.equal(readStored('pos_category_sort'), value);
    }
    for (const value of ['saved', 'name', 'price_asc', 'price_desc']) {
      res = await put('pos_item_sort', value);
      assert.equal(res.status, 200, `item accepts ${value}`);
      assert.equal(readStored('pos_item_sort'), value);
    }
    res = await httpRequest(baseUrl, '/api/settings/pos-sort');
    assert.deepEqual(res.data, { category_sort: 'name', item_sort: 'price_desc' });

    console.log('4. A role denied settings.view can read but not write');
    const restricted = { 'x-test-user': 'pos-sort-server' };
    res = await httpRequest(baseUrl, '/api/settings/pos-sort', { headers: restricted });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { category_sort: 'name', item_sort: 'price_desc' });
    res = await put('pos_item_sort', 'name', restricted);
    assert.equal(res.status, 403);
    assert.equal(readStored('pos_item_sort'), 'price_desc', 'refused write did not persist');

    console.log('5. Corrupt stored values fall back to the saved order');
    db.prepare(
      "UPDATE settings SET value = 'garbage' WHERE key IN ('pos_category_sort','pos_item_sort')",
    ).run();
    res = await httpRequest(baseUrl, '/api/settings/pos-sort');
    assert.deepEqual(res.data, { category_sort: 'saved', item_sort: 'saved' });

    console.log('\npos-sort-settings: all assertions passed');
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
