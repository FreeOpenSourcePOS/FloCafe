import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
// `let` (not `const`) — the cloud-services setup scenario below re-points
// this at a second fresh temp dir so it can exercise a brand-new first-run
// database, independent of the owner already created in the primary scenario.
let testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-first-run-'));

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
const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion, MIGRATIONS } = require('../main/db');
const { cloudSync } = require('../main/services/cloud-sync');
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

  let profileRefreshes = 0;
  const originalRefreshRegistrationProfile = cloudSync.refreshRegistrationProfile.bind(cloudSync);
  cloudSync.refreshRegistrationProfile = () => { profileRefreshes++; };

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

assert.equal(getCurrentSchemaVersion(), MIGRATIONS[MIGRATIONS.length - 1].version, 'fresh database migrates to latest schema');
  assert.equal(count('users'), 0, 'fresh install starts without users');
  assert.equal(count('categories'), 0, 'fresh install starts with no sample categories');
  assert.equal(count('products'), 0, 'fresh install starts with no sample products');
  assert.equal(count('tables'), 0, 'fresh install starts with no sample tables');
  assert.equal(count('printers'), 0, 'fresh install starts with no default printer');
  assert.equal(setting('cloud_server_url'), 'https://blue.flopos.com/', 'cloud server URL is seeded');
  assert.match(setting('cloud_pos_hash') || '', /^pos_[a-f0-9]{40}$/, 'fresh install has a POS hash');
  assert.ok((setting('cloud_device_secret') || '').length >= 32, 'fresh install has a local cloud secret');
  assert.equal(count('cloud_sync_outbox'), 0, 'fresh install starts with an empty cloud outbox');
  assert.equal(count('country_packs'), 1, 'fresh install registers only the generic tax pack');
  assert.deepEqual(
    getDatabase().prepare(
      'SELECT id, country, status FROM country_packs ORDER BY id'
    ).all(),
    [{ id: 'local-generic', country: '*', status: 'active' }],
    'fresh setup does not preinstall a country-specific tax pack',
  );
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
    assert.equal(
      Object.prototype.hasOwnProperty.call(before.data, 'bundledTaxPackCountries'),
      false,
      'setup status contains no tax-catalog metadata',
    );
    console.log('   ✓ setup status reports setup is needed without tax catalog messaging');

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

    const invalidTimezone = await request(baseUrl, '/setup/initialize', {
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
        country: 'CA',
        currency: 'CAD',
        timezone: 'Not/A_Real_Zone',
      }),
    });
    assert.equal(invalidTimezone.status, 400, 'setup rejects an invalid IANA timezone');
    assert.equal(invalidTimezone.data.error, 'Invalid timezone', 'setup reports a timezone-specific validation error');
    assert.equal(count('users'), 0, 'no owner is created when the timezone is invalid');
    console.log('   ✓ setup rejects an invalid IANA timezone');

    const invalidCurrency = await request(baseUrl, '/setup/initialize', {
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
        country: 'CA',
        currency: 'US',
        timezone: 'America/Vancouver',
      }),
    });
    assert.equal(invalidCurrency.status, 400, 'setup rejects a currency that is not a three-letter code');
    assert.equal(invalidCurrency.data.error, 'Invalid currency', 'setup reports a currency-specific validation error');
    assert.equal(count('users'), 0, 'no owner is created when the currency is invalid');
    console.log('   ✓ setup rejects an invalid currency code');

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
        // A Canadian store on the west coast selects its true timezone rather
        // than the country profile's America/Toronto default (#389).
        country: 'CA',
        currency: 'cad',
        timezone: 'America/Vancouver',
        // Deliberately sent as false: first-run setup no longer asks about
        // telemetry, it discloses it. The route must ignore this field
        // entirely rather than let a stale client switch telemetry off.
        anonymous_data_consent: false,
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
    assert.equal(setting('country'), 'CA', 'setup persists the chosen country');
    assert.equal(setting('currency'), 'CAD', 'setup persists the chosen currency');
    assert.equal(setting('timezone'), 'America/Vancouver', 'setup persists a custom tenant timezone independently of the country default');
    assert.equal(setting('billing_type'), 'prepaid');
    assert.equal(setting('tables_required'), 'false');
    assert.equal(setting('onboarding_completed'), 'true');
    assert.equal(setting('anonymous_data_consent'), 'true', 'setup ignores a client-supplied consent field');
    assert.equal(setting('telemetry_enabled'), 'true', 'telemetry is on by default after setup');
    assert.equal(setting('telemetry_scope'), 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics');
    assert.equal(setting('diagnostics_consent'), 'true', 'store diagnostics are on by default for a new install');
    assert.equal(profileRefreshes, 1, 'setup immediately refreshes the completed store profile in FloAdmin');
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

    // A disabled setup endpoint must stay 403 even for a malformed payload —
    // an invalid timezone must not downgrade the completed-setup guard to 400
    // (regression for the Greptile review on #432).
    const disabledWithBadTimezone = await request(baseUrl, '/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Third Owner',
        email: 'third@example.com',
        password: 'TestPass123',
        business_type: 'restaurant',
        terms_accepted: true,
        timezone: 'Not/A_Real_Zone',
      }),
    });
    assert.equal(disabledWithBadTimezone.status, 403, 'disabled setup keeps 403 even with an invalid timezone');
    assert.equal(disabledWithBadTimezone.data.error, 'Setup already complete. This endpoint is disabled.');
    assert.equal(count('users'), 1, 'disabled setup still cannot create a third owner');
    console.log('   ✓ disabled setup returns 403 before timezone validation');

    // Cloud v2 coordination is automatic for new installs.
    // '1', not 'true' — cloud-sync.ts reads this key with a strict '1' check
    // everywhere, matching FloAdmin's own `stores` table.
    assert.equal(setting('cloud_sync_enabled'), '1', 'cloud coordination is enabled automatically on v2 setup');
    assert.equal(setting('cloud_server_url'), 'https://blue.flopos.com', 'cloud server URL keeps the default');
    console.log('   ✓ setup endpoint enables cloud coordination automatically');
  } finally {
    cloudSync.refreshRegistrationProfile = originalRefreshRegistrationProfile;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── Cloud services opt-in during first-run setup (#128) ──────────────────
  // Exercises a second, independent fresh install so we can complete
  // /setup/initialize with cloud_sync_enabled: true — the DB above already
  // has its one allowed owner.
  console.log('\n   Cloud services opt-in during setup');
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-first-run-cloud-'));
  initDatabase();

  const cloudApi = express();
  cloudApi.use(express.json());
  cloudApi.use('/api/auth', authRoutes);
  let cloudServer: http.Server;
  try {
    cloudServer = await listen(cloudApi);
  } catch (error: any) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.log('   ⚠ Skipping cloud opt-in assertions: local port binding is blocked in this environment.');
      return;
    }
    throw error;
  }
  const cloudAddress = cloudServer.address() as { port: number };
  const cloudBaseUrl = `http://127.0.0.1:${cloudAddress.port}/api/auth`;

  try {
    const badUrl = await request(cloudBaseUrl, '/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cloud Owner', email: 'cloud-owner@example.com', password: 'TestPass123',
        business_type: 'restaurant', setup_profile: 'empty', service_model: 'qsr',
        terms_accepted: true,
        cloud_sync_enabled: true, cloud_server_url: 'not-a-valid-url',
      }),
    });
    assert.equal(badUrl.status, 400, 'an invalid cloud server URL is rejected when cloud sync is enabled');
    assert.equal(count('users'), 0, 'no owner is created when the cloud server URL is invalid');
    console.log('   ✓ setup rejects an invalid cloud server URL when cloud sync is enabled');

    const enabled = await request(cloudBaseUrl, '/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cloud Owner', email: 'cloud-owner@example.com', password: 'TestPass123',
        business_type: 'restaurant', setup_profile: 'empty', service_model: 'qsr',
        terms_accepted: true,
        cloud_sync_enabled: true, cloud_server_url: 'https://cloud.example.test/relay',
      }),
    });
    assert.equal(enabled.status, 200, `setup succeeds with a valid custom cloud server URL (got ${enabled.status}, ${JSON.stringify(enabled.data)})`);
    assert.equal(setting('cloud_sync_enabled'), '1', 'cloud sync is enabled when requested at setup');
    assert.equal(setting('cloud_server_url'), 'https://cloud.example.test/relay', 'the custom cloud server URL is persisted, normalized');
    console.log('   ✓ setup persists an explicit cloud_sync_enabled + custom cloud_server_url');
  } finally {
    await new Promise<void>((resolve) => cloudServer.close(() => resolve()));
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
