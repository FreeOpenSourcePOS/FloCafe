/**
 * Pizza fork: the `pizza` setup profile configures a counter-service pizza shop, seeds no
 * menu, and leaves the install offline.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pizza-setup-profile.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-setup-profile-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-pizza-setup-profile';
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
// Every TCP connection starts here, whichever of http.request, https.request or net.connect opens it.
const net = require('net');
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args: any[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const target =
    typeof first === 'object'
      ? first
      : typeof first === 'number'
        ? { host: args[1] }
        : { path: first };
  if (target.path || target.host === '127.0.0.1') return realConnect.apply(this, args);
  outbound.push(`socket ${target.host ?? 'localhost'}:${target.port ?? first}`);
  return this.destroy(new Error('outbound connection refused by the test'));
};

const {
  createApp,
  startServer,
  api,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const { initDatabase, closeDatabase, getDatabase, getSettingValue } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { isOfflineMode } = require('../main/services/offline-mode');
const { cloudSync } = require('../main/services/cloud-sync');
const { telemetry } = require('../main/services/telemetry');

let registerCalls = 0;
const originalRegister = cloudSync.register.bind(cloudSync);
cloudSync.register = ((...args: unknown[]) => {
  registerCalls += 1;
  return originalRegister(...args);
}) as any;

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// 192.0.2.1 is a documentation address: nothing answers there, and the guard must stop the attempt first.
const attempt = (open: () => any) =>
  new Promise<void>((resolve) => open().once('error', resolve).once('close', resolve));

const setupBody = {
  name: 'Pizza Owner',
  email: 'owner@example.com',
  password: 'TestPass123',
  business_type: 'restaurant',
  business_name: 'Sample Pizza Shop',
  setup_profile: 'pizza',
  // The profile decides counter service, whatever the request asks for.
  service_model: 'finedine',
  terms_accepted: true,
  owner_approval_pin: '5678',
  owner_approval_pin_confirmation: '5678',
  country: 'CA',
  currency: 'CAD',
  timezone: 'America/Vancouver',
};

const MENU_TABLES = ['categories', 'products', 'addon_groups', 'addons'];
const UNSEEDED_TABLES = ['printers', 'kitchen_stations', 'role_permission_overrides', 'tables'];
const count = (table: string): number =>
  (getDatabase().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number })
    .total;

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
  console.log('Pizza fork: the pizza setup profile');
  console.log('='.repeat(60));
  resetCounters();
  initDatabase();
  const app = createApp({ '/api/auth': authRoutes, '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  const before = Object.fromEntries(UNSEEDED_TABLES.map((table) => [table, count(table)]));
  let ownerAuth: Record<string, string> = {};

  try {
    await testCase('0. The outbound guard stops http, https and raw sockets', async () => {
      const http = require('http');
      const https = require('https');
      await attempt(() => http.request('http://192.0.2.1/').end());
      await attempt(() => https.request('https://192.0.2.1/').end());
      await attempt(() => net.connect(9, '192.0.2.1'));
      assertEqualOrThrow(
        outbound.join(', '),
        'socket 192.0.2.1:80, socket 192.0.2.1:443, socket 192.0.2.1:9',
        'each attempt is recorded and refused',
      );
      outbound.length = 0;
    });

    const refused = async (name: string, region: Record<string, string>) => {
      const setup = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: { ...setupBody, ...region },
      });
      assertEqualOrThrow(setup.status, 400, `setup for ${name} is refused`);
      assertEqualOrThrow(
        setup.data.error,
        'The pizza shop profile sets up British Columbia tax. Choose Canada and British Columbia, or pick another profile.',
        'the owner is told what to change',
      );
      assertEqualOrThrow(count('users'), 0, 'no owner is created');
      assertEqualOrThrow(
        count("country_packs WHERE country != '*'"),
        0,
        'no tax configuration is installed',
      );
      assertEqualOrThrow(getSettingValue('taxes_enabled'), 'false', 'no setting is written');
      const status = await api(baseUrl, '/api/auth/setup/status');
      assertEqualOrThrow(status.data.needsSetup, true, 'setup is still to be done');
    };

    await testCase('1a. The pizza profile is refused outside Canada', () =>
      refused('the United States', {
        country: 'US',
        currency: 'USD',
        timezone: 'America/Los_Angeles',
      }),
    );

    await testCase('1b. The pizza profile is refused in another province', () =>
      refused('Ontario', { state_code: 'ON' }),
    );

    await testCase('1. Setup with the pizza profile succeeds', async () => {
      cloudSync.start();
      telemetry.start();
      const setup = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: { ...setupBody, state_code: 'BC' },
      });
      assertEqualOrThrow(setup.status, 200, 'the setup route accepts the pizza profile');
      ownerAuth = { Authorization: `Bearer ${setup.data.access_token}` };
      await settle();
      assertEqualOrThrow(getSettingValue('setup_profile'), 'pizza', 'the profile is recorded');
    });

    await testCase('2. The profile sets counter service and the shop settings', async () => {
      const expected: Record<string, string> = {
        service_model: 'qsr',
        tables_required: 'false',
        billing_type: 'prepaid',
        kds_enabled: 'false',
        server_app_enabled: 'false',
        auto_print_kot: 'true',
        cash_drawer_pulse_enabled: 'true',
        cash_drawer_pulse_methods: '["cash"]',
        kot_show_customer_contact: 'delivery',
        scheduled_orders_enabled: 'true',
        pos_order_types: 'takeaway,delivery',
        taxes_enabled: 'true',
      };
      for (const [key, value] of Object.entries(expected)) {
        assertEqualOrThrow(getSettingValue(key), value, `${key} is ${value}`);
      }

      const printing = await api(baseUrl, '/api/settings/printing', { headers: ownerAuth });
      assertEqualOrThrow(printing.status, 200, 'the printing settings load');
      assertEqualOrThrow(printing.data.auto_print_kot, true, 'kitchen tickets print by themselves');
      assertEqualOrThrow(printing.data.cash_drawer_pulse_enabled, true, 'the drawer pulse is on');
      assertEqualOrThrow(
        JSON.stringify(printing.data.cash_drawer_pulse_methods),
        '["cash"]',
        'the drawer opens for cash only',
      );
      assertEqualOrThrow(printing.data.kds_enabled, false, 'the kitchen display is off');

      const business = await api(baseUrl, '/api/settings/business', { headers: ownerAuth });
      assertEqualOrThrow(
        business.data.kot_show_customer_contact,
        'delivery',
        'the POS is told contact prints on delivery tickets only',
      );
      assertEqualOrThrow(
        JSON.stringify(business.data.pos_order_types),
        '["takeaway","delivery"]',
        'the POS is told to offer takeaway and delivery, takeaway first',
      );
    });

    await testCase('2a. Order types written with spaces are read without them', async () => {
      const write = (value: string) =>
        api(baseUrl, '/api/settings/pos_order_types', {
          method: 'PUT',
          headers: ownerAuth,
          body: { value },
        });
      assertEqualOrThrow((await write(' takeaway , delivery,, ')).status, 200, 'the list is saved');
      const business = await api(baseUrl, '/api/settings/business', { headers: ownerAuth });
      assertEqualOrThrow(
        JSON.stringify(business.data.pos_order_types),
        '["takeaway","delivery"]',
        'the POS is told takeaway and delivery',
      );
      await write('takeaway,delivery');
    });

    await testCase('2b. The manual Canada tax pack is the active one', () => {
      const packs = getDatabase()
        .prepare(
          `SELECT id, publisher, country, status, active_version_id IS NOT NULL AS has_version
           FROM country_packs WHERE country != '*'`,
        )
        .all();
      assertEqualOrThrow(
        JSON.stringify(packs),
        JSON.stringify([
          { id: 'manual-ca', publisher: 'local', country: 'CA', status: 'active', has_version: 1 },
        ]),
        'the store has one pack of its own: manual-ca, local, active',
      );
    });

    await testCase('3. The region is what the request carried', () => {
      assertEqualOrThrow(getSettingValue('country'), 'CA', 'country is Canada');
      assertEqualOrThrow(getSettingValue('currency'), 'CAD', 'currency is CAD');
      assertEqualOrThrow(
        getSettingValue('timezone'),
        'America/Vancouver',
        'time zone is America/Vancouver',
      );
    });

    await testCase('4. No menu, printers, stations or permission overrides are seeded', () => {
      for (const table of MENU_TABLES) {
        assertEqualOrThrow(count(table), 0, `${table} is empty`);
      }
      for (const table of UNSEEDED_TABLES) {
        assertEqualOrThrow(count(table), before[table], `${table} is as the install left it`);
      }
    });

    await testCase('5. Offline mode stays on and nothing outbound is attempted', () => {
      assertEqualOrThrow(getSettingValue('offline_mode'), 'true', 'offline_mode is still on');
      assertEqualOrThrow(isOfflineMode(), true, 'Offline mode is in effect');
      assertEqualOrThrow(getSettingValue('cloud_sync_enabled'), '0', 'cloud sync is off');
      assertEqualOrThrow(registerCalls, 0, 'setup does not register the install');
      assertEqualOrThrow(outbound.join(', '), '', 'no outbound request is attempted');
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
