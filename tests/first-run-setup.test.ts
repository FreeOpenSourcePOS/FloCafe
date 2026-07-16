import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-first-run-'));

const mockApp = {
  isPackaged: true,
  getPath: (name: string) => {
    if (name === 'userData') return testDir;
    if (name === 'documents') return testDir;
    return testDir;
  },
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');

function count(table: string): number {
  const db = getDatabase();
  return (db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;
}

function setting(key: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

async function listen(app: any): Promise<http.Server> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function request(baseUrl: string, pathName: string, options: Record<string, any> = {}) {
  const response = await (globalThis as any).fetch(baseUrl + pathName, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  return { status: response.status, data };
}

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

async function main() {
  console.log('🧪 FloDesktop First-Run Setup Tests');
  console.log('='.repeat(60));

  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('   ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
      console.log(`     Node ${process.version} uses ABI ${process.versions.modules}; rebuild native modules for Node to run this test outside Electron.`);
      process.exit(77); // exit code 77 = skip (GNU convention)
    }
    throw error;
  }

  assert.equal(getCurrentSchemaVersion(), 22, 'fresh database migrates to latest schema');
  assert.equal(count('users'), 0, 'fresh install starts without users');
  assert.equal(count('categories'), 0, 'fresh install starts with no sample categories');
  assert.equal(count('products'), 0, 'fresh install starts with no sample products');
  assert.equal(count('tables'), 0, 'fresh install starts with no sample tables');
  assert.equal(count('printers'), 0, 'fresh install starts with no default printer');
  assert.equal(setting('cloud_server_url'), 'https://blue.flopos.com/', 'cloud server URL is seeded');
  assert.match(setting('cloud_pos_hash') || '', /^pos_[a-f0-9]{40}$/, 'fresh install has a POS hash');
  assert.ok((setting('cloud_device_secret') || '').length >= 32, 'fresh install has a local cloud secret');
  assert.equal(count('cloud_sync_outbox'), 0, 'fresh install starts with an empty cloud outbox');
  console.log('   ✓ fresh database has schema/default settings only and awaits setup');

  const api = express();
  api.use(express.json());
  api.use('/api/auth', authRoutes);
  let server: http.Server;
  try {
    server = await listen(api);
  } catch (error: any) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.log('   ⚠ Skipping setup API assertions: local port binding is blocked in this environment.');
      return;
    }
    throw error;
  }
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api/auth`;

  try {
    const before = await request(baseUrl, '/setup/status');
    assert.equal(before.status, 200);
    assert.equal(before.data.needsSetup, true, 'fresh install needs setup');
    assert.equal(before.data.initialRole, 'owner');
    console.log('   ✓ setup status reports setup is needed');

    const withoutTerms = await request(baseUrl, '/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({
        name: 'First Owner',
        email: 'owner@example.com',
        password: 'TestPass123',
        business_type: 'restaurant',
        business_name: 'First Cafe',
        setup_profile: 'express',
        service_model: 'qsr',
      }),
    });
    assert.equal(withoutTerms.status, 400, 'setup rejects account creation without terms acceptance');
    assert.equal(count('users'), 0, 'no user is created when terms are not accepted');
    console.log('   ✓ setup endpoint requires terms_accepted before creating the owner account');

    const first = await request(baseUrl, '/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({
        name: 'First Owner',
        email: 'owner@example.com',
        password: 'TestPass123',
        business_type: 'restaurant',
        business_name: 'First Cafe',
        setup_profile: 'express',
        service_model: 'qsr',
        terms_accepted: true,
      }),
    });

    assert.equal(first.status, 200);
    assert.equal(first.data.user.email, 'owner@example.com');
    assert.equal(first.data.user.role, 'owner');
    assert.equal(count('users'), 1, 'setup creates the first owner');
    const ownerRow = getDatabase().prepare('SELECT terms_accepted_at FROM users WHERE email = ?').get('owner@example.com') as { terms_accepted_at: string | null };
    assert.ok(ownerRow.terms_accepted_at, 'terms acceptance is stamped with a timestamp on the owner record');
    assert.equal(setting('business_name'), 'First Cafe');
    assert.equal(setting('business_type'), 'restaurant');
    assert.equal(setting('setup_profile'), 'express');
    assert.equal(setting('service_model'), 'qsr');
    assert.equal(setting('billing_type'), 'prepaid');
    assert.equal(setting('tables_required'), 'false');
    assert.equal(setting('onboarding_completed'), 'true');
    assert.equal(count('categories'), 2, 'express setup seeds minimal categories');
    assert.equal(count('products'), 4, 'express setup seeds minimal products');
    assert.equal(count('tables'), 0, 'qsr express setup does not seed dine-in tables');
    assert.equal(count('customers'), 0, 'express setup does not seed demo customers');
    console.log('   ✓ setup endpoint creates owner and applies express QSR setup');

    // Setup initialize should be disabled since a user already exists
    const second = await request(baseUrl, '/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Second Owner',
        email: 'second@example.com',
        password: 'TestPass123',
        business_type: 'restaurant',
        terms_accepted: true,
      }),
    });

    assert.equal(second.status, 403);
    assert.equal(count('users'), 1, 'setup cannot create a second owner');
    console.log('   ✓ setup endpoint is disabled after the first user exists');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\n✅ First-run setup tests passed');
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
