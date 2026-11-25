/**
 * Pizza fork: a fresh install contacts nothing until the owner switches Offline mode off.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pizza-offline-default.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-offline-default-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-pizza-offline-default';
// Lift the test-environment suppression, so a telemetry send would really be attempted.
process.env.FLO_TELEMETRY_DEV = '1';
for (const key of ['FLO_MATRIX_OFFLINE', 'E2E_TASK_LOCAL_PORTS', 'FLO_E2E_SKIP_OPTIONAL_NETWORK']) {
  delete process.env[key];
}

// Every attempt to reach anything but this test's own server is recorded and refused.
const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input?.url ?? input);
  if (new URL(url).hostname === '127.0.0.1') return realFetch(input, init);
  outbound.push(`fetch ${url}`);
  throw new Error('outbound request refused by the test');
}) as typeof fetch;
const ws = require('ws');
ws.WebSocket = Object.setPrototypeOf(function (url: unknown) {
  outbound.push(`ws ${String(url)}`);
  throw new Error('outbound socket refused by the test');
}, ws.WebSocket);

const {
  createApp,
  startServer,
  api,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const { initDatabase, closeDatabase, getSettingValue, upsertSettings } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { isOfflineMode } = require('../main/services/offline-mode');
const { cloudSync } = require('../main/services/cloud-sync');
const { telemetry, isTelemetrySuppressed } = require('../main/services/telemetry');
const { fetchRemoteTaxPackCatalog } = require('../main/tax-packs/catalog');

let registerCalls = 0;
const originalRegister = cloudSync.register.bind(cloudSync);
cloudSync.register = ((...args: unknown[]) => {
  registerCalls += 1;
  return originalRegister(...args);
}) as any;

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const failedCases: string[] = [];
async function testCase(name: string, run: () => unknown) {
  console.log(`\n--- ${name} ---`);
  try {
    await run();
  } catch (error: any) {
    failedCases.push(name);
    console.error(`  case failed: ${error?.message ?? error}`);
  }
}

async function main() {
  console.log('Pizza fork: offline by default');
  console.log('='.repeat(60));
  resetCounters();
  initDatabase();
  const app = createApp({ '/api/auth': authRoutes, '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  let ownerAuth: Record<string, string> = {};

  try {
    await testCase('1. A fresh database has offline_mode on', () => {
      assertEqualOrThrow(getSettingValue('offline_mode'), 'true', 'offline_mode is seeded on');
      assertEqualOrThrow(isOfflineMode(), true, 'Offline mode is in effect');
    });

    await testCase('2. Install and setup contact nothing and leave cloud sync off', async () => {
      // What the desktop app runs on every launch, before and after setup.
      cloudSync.start();
      telemetry.start();
      await fetchRemoteTaxPackCatalog().catch(() => undefined);

      const setup = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: {
          name: 'Pizza Owner',
          email: 'owner@example.com',
          password: 'TestPass123',
          business_type: 'restaurant',
          business_name: 'Pizza Shop',
          setup_profile: 'express',
          service_model: 'qsr',
          terms_accepted: true,
          owner_approval_pin: '5678',
          owner_approval_pin_confirmation: '5678',
          country: 'CA',
          currency: 'CAD',
          timezone: 'America/Vancouver',
        },
      });
      assertEqualOrThrow(setup.status, 200, 'the setup route creates the owner');
      ownerAuth = { Authorization: `Bearer ${setup.data.access_token}` };
      await settle();

      assertEqualOrThrow(registerCalls, 0, 'setup does not register the install');
      assertEqualOrThrow(
        outbound.join(', '),
        '',
        'no outbound request is attempted during install and setup',
      );
      assertEqualOrThrow(getSettingValue('cloud_sync_enabled'), '0', 'setup leaves cloud sync off');
    });

    await testCase('3. Switching Offline mode off starts nothing by itself', async () => {
      outbound.length = 0;
      registerCalls = 0;
      const off = await api(baseUrl, '/api/settings/offline-mode', {
        method: 'PUT',
        body: { offline_mode: false },
        headers: ownerAuth,
      });
      assertEqualOrThrow(off.status, 200, 'the owner can switch Offline mode off');
      assertEqualOrThrow(isOfflineMode(), false, 'Offline mode is off');
      assertEqualOrThrow(isTelemetrySuppressed(), false, 'nothing else is holding telemetry back');
      await settle();

      assertEqualOrThrow(registerCalls, 0, 'no cloud registration starts');
      assertEqualOrThrow(
        outbound.join(', '),
        '',
        'no registration or telemetry collector request is sent',
      );
    });

    await testCase('4. An existing database keeps its own values', () => {
      upsertSettings({ offline_mode: 'false', cloud_sync_enabled: '1', telemetry_enabled: 'true' });
      closeDatabase();
      initDatabase();
      assertEqualOrThrow(getSettingValue('offline_mode'), 'false', 'offline_mode is kept');
      assertEqualOrThrow(getSettingValue('cloud_sync_enabled'), '1', 'cloud_sync_enabled is kept');
      assertEqualOrThrow(getSettingValue('telemetry_enabled'), 'true', 'telemetry_enabled is kept');
    });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (failedCases.length > 0) console.error(`Failed cases:\n  ${failedCases.join('\n  ')}`);
  process.exit(failedCases.length > 0 || results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
