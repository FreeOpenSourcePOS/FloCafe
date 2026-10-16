import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-posthog-'));

interface RecordedClient {
  token: string;
  options: {
    host?: string;
    isServer?: boolean;
    personalApiKey?: string;
    before_send?: (event: unknown) => unknown;
  };
  events: Array<{ distinctId?: string; event?: string; properties?: Record<string, unknown> }>;
  exceptions: Array<{
    message: string;
    name: string;
    stack: string;
    distinctId?: string;
    properties?: Record<string, unknown>;
  }>;
  shutdowns: number;
  aliases: Array<{ distinctId: string; alias: string }>;
  shutdownTimeouts: Array<number | undefined>;
}

const clients: RecordedClient[] = [];

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => '9.9.9-test',
      },
    };
  }
  if (request === 'posthog-node') {
    return {
      PostHog: class {
        token: string;
        options: RecordedClient['options'];
        events: RecordedClient['events'];
        exceptions: RecordedClient['exceptions'];
        shutdowns = 0;
        shutdownTimeouts: Array<number | undefined> = [];
        aliases: Array<{ distinctId: string; alias: string }> = [];
        constructor(token: string, options: RecordedClient['options']) {
          this.token = token;
          this.options = options;
          this.events = [];
          this.exceptions = [];
          clients.push(this);
        }
        capture(payload: RecordedClient['events'][number]) {
          this.events.push(payload);
        }
        captureException(error: Error, distinctId?: string, properties?: Record<string, unknown>) {
          this.exceptions.push({
            message: error.message,
            name: error.name,
            stack: error.stack ?? '',
            distinctId,
            properties,
          });
        }
        alias(payload: { distinctId: string; alias: string }) {
          this.aliases.push(payload);
        }
        async shutdown(shutdownTimeoutMs?: number) {
          this.shutdowns += 1;
          this.shutdownTimeouts.push(shutdownTimeoutMs);
        }
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const {
  capturePostHogApiFailure,
  capturePostHogException,
  capturePostHogUsage,
  checkPostHogMilestones,
  readDailyUsageSummary,
  readPostHogBootstrap,
  readSuperProperties,
  stopPostHog,
  syncPostHogIdentity,
} = require('../main/services/posthog');
const { buildCspHeader } = require('../main/csp');
const { resolveOfficialRelease } = require('../main/services/build-identity');
const { readPostHogConfig } = require('../main/services/posthog-config');
const {
  accountRefForEmail,
  parseMachineId,
  readInstallRef,
  resolvePostHogIdentity,
} = require('../main/services/posthog-identity');
const { SHUTDOWN_TIMEOUT_MS } = require('../main/shutdown');
const { createScreenViewThrottle, screenKey } = require('../shared/posthog-screen-views');
const { shellArgs, sourceMapsConfigured } = require('../scripts/posthog-sourcemaps.cjs');
const {
  redactExceptionMessage,
  scrubPostHogEvent,
  stackFrameLines,
} = require('../shared/posthog-scrub');

const SEEDED_POSTHOG_TOKEN = 'phc_oQZWkdonPzTrDdgfYhNzjjAqWkRHjYWTdjHr2meQCTwB';
const SEEDED_POSTHOG_HOST = 'https://eu.i.posthog.com';
const priorCi = process.env.CI;
const priorMatrixOffline = process.env.FLO_MATRIX_OFFLINE;
const priorE2ePorts = process.env.E2E_TASK_LOCAL_PORTS;

function restorePostHogNetworkEnv(): void {
  if (priorCi === undefined) delete process.env.CI;
  else process.env.CI = priorCi;
  if (priorMatrixOffline === undefined) delete process.env.FLO_MATRIX_OFFLINE;
  else process.env.FLO_MATRIX_OFFLINE = priorMatrixOffline;
  if (priorE2ePorts === undefined) delete process.env.E2E_TASK_LOCAL_PORTS;
  else process.env.E2E_TASK_LOCAL_PORTS = priorE2ePorts;
}

function setSetting(key: string, value: string) {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now());
}

function readSetting(key: string): string | null {
  const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value?: string | null }
    | undefined;
  return row?.value ?? null;
}

function deleteSetting(key: string) {
  getDatabase().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function insertUser(id: string, name: string, email: string) {
  const ts = now();
  getDatabase()
    .prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'hashed', 'owner', 1, ?, ?)`,
    )
    .run(id, name, email, ts, ts);
}

/** The exact connect-src sources of a CSP header. */
function connectSources(header: string): string[] {
  const directive = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('connect-src '));
  return directive ? directive.split(/\s+/).slice(1) : [];
}

function latest() {
  return clients[clients.length - 1];
}

async function main() {
  delete process.env.CI;
  delete process.env.FLO_MATRIX_OFFLINE;
  delete process.env.E2E_TASK_LOCAL_PORTS;

  const on = { telemetryEnabled: true, allowExceptions: true };

  assert.equal(
    parseMachineId('darwin', '  "IOPlatformUUID" = "A1B2C3D4-0000-1111-2222-333344445555"'),
    'a1b2c3d4-0000-1111-2222-333344445555',
  );
  assert.equal(
    parseMachineId('win32', '    MachineGuid    REG_SZ    5b1c7e2a-1111-2222-3333-444455556666'),
    '5b1c7e2a-1111-2222-3333-444455556666',
  );
  assert.equal(
    parseMachineId('linux', 'f3c4b2a19d8e47f6a5b4c3d2e1f00123\n'),
    'f3c4b2a19d8e47f6a5b4c3d2e1f00123',
  );
  assert.equal(
    parseMachineId('linux', '00000000000000000000000000000000'),
    null,
    'blank ids are ignored',
  );
  assert.equal(parseMachineId('darwin', 'nothing here'), null);
  assert.equal(accountRefForEmail('Owner@Shop.com'), accountRefForEmail(' owner@shop.com '));
  assert.notEqual(accountRefForEmail('a@shop.com'), accountRefForEmail('b@shop.com'));
  assert.equal(accountRefForEmail('not an email'), undefined);

  const alias = (properties: Record<string, unknown>, telemetryEnabled = true) =>
    scrubPostHogEvent(
      { event: '$create_alias', properties },
      { telemetryEnabled, allowExceptions: true },
    );
  const goodAlias = {
    distinct_id: 'acct_0123456789abcdef',
    alias: 'inst_fedcba9876543210',
    token: 'phc',
    $current_url: 'http://localhost:3001/pos?x=1',
  };
  assert.deepEqual(alias(goodAlias)?.properties, {
    distinct_id: 'acct_0123456789abcdef',
    alias: 'inst_fedcba9876543210',
    token: 'phc',
  });
  assert.equal(alias(goodAlias, false), null, 'aliases follow telemetry');
  assert.equal(alias({ ...goodAlias, alias: 'ada@example.com' }), null, 'only FloCafe ids alias');

  const throttle = createScreenViewThrottle(1_000);
  assert.deepEqual(throttle('a|/pos/', 0), { send: true, repeatViews: 0 });
  assert.deepEqual(throttle('a|/pos/', 10), { send: false, repeatViews: 0 }, 'same screen');
  assert.deepEqual(throttle('a|/orders/', 20), { send: true, repeatViews: 0 });
  assert.deepEqual(throttle('a|/pos/', 30), { send: false, repeatViews: 0 }, 'inside the window');
  assert.deepEqual(throttle('b|/pos/', 40), { send: true, repeatViews: 0 }, 'other staff');
  throttle('a|/orders/', 50);
  assert.deepEqual(throttle('a|/pos/', 2_000), { send: true, repeatViews: 1 }, 'folded views');
  assert.equal(screenKey('/settings/', 'kds'), '/settings/?tab=kds');
  assert.equal(screenKey('/settings', 'Bad Tab'), '/settings/');
  assert.equal(screenKey('/orders/', 'kds'), '/orders/');

  assert.deepEqual(
    shellArgs(['--directory', 'C:\\a b\\out', 'flocafe'], 'win32'),
    ['--directory', '"C:\\a b\\out"', 'flocafe'],
    'Windows paths with spaces stay one argument',
  );
  assert.deepEqual(shellArgs(['--directory', '/a b/out'], 'darwin'), ['--directory', '/a b/out']);

  const linkedWhileOff = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'renderer-autocapture',
        install_ref: '0123456789abcdef',
        store_ref: 'fedcba9876543210',
        staff_ref: '00112233445566aa',
        $exception_list: [{ type: 'TypeError' }],
      },
    },
    { telemetryEnabled: false, allowExceptions: true },
  );
  for (const key of ['install_ref', 'store_ref', 'staff_ref']) {
    assert.equal(key in (linkedWhileOff?.properties ?? {}), false, `telemetry off drops ${key}`);
  }

  assert.equal(sourceMapsConfigured({}), false);
  assert.equal(
    sourceMapsConfigured({ POSTHOG_CLI_API_KEY: 'phx', POSTHOG_CLI_PROJECT_ID: ' ' }),
    false,
  );
  assert.equal(
    sourceMapsConfigured({ POSTHOG_CLI_API_KEY: 'phx', POSTHOG_CLI_PROJECT_ID: '1' }),
    true,
  );

  const tagged = scrubPostHogEvent(
    {
      event: '$pageview',
      properties: {
        $current_url: 'http://localhost:3001/settings/?tab=kds',
        screen: '/settings/',
        settings_tab: 'kds',
        repeat_views: 3,
        staff_role: 'cashier',
        staff_ref: '0123456789abcdef',
        store_ref: 'not-a-hash',
      },
    },
    on,
  );
  assert.equal(tagged.properties.settings_tab, 'kds');
  assert.equal(tagged.properties.repeat_views, 3);
  assert.equal(tagged.properties.staff_role, 'cashier');
  assert.equal(tagged.properties.staff_ref, '0123456789abcdef');
  assert.equal('store_ref' in tagged.properties, false, 'refs must be opaque hashes');

  assert.equal(
    redactExceptionMessage("Cannot read properties of undefined (reading 'name')"),
    "Cannot read properties of undefined (reading 'name')",
  );
  const redacted = redactExceptionMessage(
    'Customer "Ada Lovelace" ada@example.com +54 11 5555-1234 order 4471 at https://x.test/o?id=9 \'Ada Lovelace\'',
  );
  for (const leak of ['Ada', 'ada@example.com', '5555', '4471', 'x.test']) {
    assert.equal(redacted.includes(leak), false, `message keeps no ${leak}`);
  }
  assert.equal(redactExceptionMessage('first line\nsecond line Ada'), 'first line');

  assert.deepEqual(
    stackFrameLines(
      'TypeError: order 55 for customer Ada\nsecond Ada line\n    at submit (main/x.ts:1:2)',
    ),
    ['    at submit (main/x.ts:1:2)'],
  );

  const poisoned = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'uncaughtException',
        route: '/orders/55',
        digest: 'd1',
        message: 'customer Ada',
        $exception_message: 'customer Ada',
        $current_url: 'https://store.example/orders/55',
        email: 'ada@example.com',
        app_version: '3.13.0',
        $exception_list: [
          {
            type: 'TypeError',
            value: 'order 55123 for customer "Ada"',
            mechanism: { handled: false, type: 'onerror', source: 'Ada' },
            stacktrace: {
              frames: [
                { filename: '/Users/ada/node_modules/leftpad/index.js', lineno: 1, colno: 1 },
                {
                  filename: '/Users/ada/FloCafe/main/index.ts',
                  function: 'placeOrder',
                  lineno: 4,
                  colno: 2,
                  in_app: true,
                  context_line: 'customer Ada',
                  pre_context: ['Ada'],
                  vars: { customer: 'Ada' },
                },
                {
                  filename:
                    'http://192.168.1.20:3001/_next/static/chunks/app/(dashboard)/orders/page-0a1b.js?v=1',
                  function: 'customer Ada',
                  lineno: 1,
                  colno: 48211,
                  chunk_id: 'f00d-1',
                  platform: 'web:javascript',
                },
              ],
            },
          },
        ],
      },
    },
    on,
  );
  const encoded = JSON.stringify(poisoned);
  for (const leak of ['Ada', '/orders/55', '55123', '/Users/', '192.168', 'leftpad']) {
    assert.equal(encoded.includes(leak), false, `exception keeps no ${leak}`);
  }
  assert.equal(poisoned.properties.capture_point, 'uncaughtException');
  assert.equal(poisoned.properties.app_version, '3.13.0');
  assert.equal(poisoned.properties.$exception_type, 'TypeError');
  assert.equal(poisoned.properties.$exception_message, 'order <n> for customer "<redacted>"');
  assert.deepEqual(poisoned.properties.$exception_list[0].mechanism, {
    handled: false,
    type: 'onerror',
  });
  assert.deepEqual(poisoned.properties.$exception_list[0].stacktrace.frames, [
    { filename: 'main/index.ts', lineno: 4, colno: 2, function: 'placeOrder', in_app: true },
    {
      filename: '_next/static/chunks/app/(dashboard)/orders/page-0a1b.js',
      lineno: 1,
      colno: 48211,
      platform: 'web:javascript',
      chunk_id: 'f00d-1',
    },
  ]);

  const autocaptured = scrubPostHogEvent(
    { event: '$exception', properties: { $exception_list: [{ type: 'RangeError' }] } },
    { ...on, defaultCapturePoint: 'renderer-autocapture' },
  );
  assert.equal(autocaptured.properties.capture_point, 'renderer-autocapture');
  assert.equal(
    scrubPostHogEvent(
      { event: '$exception', properties: { capture_point: 'render', $exception_list: [] } },
      on,
    ),
    null,
    'unknown capture points are dropped',
  );
  assert.equal(
    scrubPostHogEvent(
      { event: '$exception', properties: { capture_point: 'uncaughtException' } },
      {
        telemetryEnabled: true,
        allowExceptions: false,
      },
    ),
    null,
    'exceptions follow diagnostics transmission',
  );
  const apiFailure = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'api-5xx',
        http_method: 'POST',
        http_route: '/api/orders/:id/items',
        http_status: 500,
        http_body: 'Ada',
      },
    },
    on,
  );
  assert.equal(apiFailure.properties.http_route, '/api/orders/:id/items');
  assert.equal(apiFailure.properties.http_status, 500);
  assert.equal(JSON.stringify(apiFailure).includes('Ada'), false);

  const pageview = scrubPostHogEvent(
    {
      event: '$pageview',
      properties: {
        distinct_id: 'anon-install',
        $current_url: 'http://localhost:3001/orders/4471/?customer=ada#x',
        $pathname: '/orders/4471/',
        $host: 'localhost:3001',
        $referrer: 'http://localhost:3001/pos?tab=ada',
        $title: 'Ada',
        $browser: 'Chrome',
        $session_id: 'sess',
        app_version: '3.13.0',
      },
    },
    on,
  );
  assert.deepEqual(pageview.properties, {
    app_version: '3.13.0',
    distinct_id: 'anon-install',
    $browser: 'Chrome',
    $session_id: 'sess',
    $pathname: '/orders/:id/',
    $current_url: '/orders/:id/',
  });
  assert.equal(
    scrubPostHogEvent(
      { event: '$pageview', properties: { $pathname: '/pos' } },
      {
        telemetryEnabled: false,
        allowExceptions: true,
      },
    ),
    null,
    'pageviews follow telemetry',
  );
  assert.equal(
    scrubPostHogEvent({ event: '$autocapture', properties: {} }, on),
    null,
    'events outside the allowlist are dropped',
  );
  const usage = scrubPostHogEvent(
    {
      event: 'daily_ping',
      properties: {
        orders_24h: 42,
        kds_enabled: true,
        service_model: 'qsr',
        owner_email: 'ada@example.com',
        phone: '541155551234',
        nested: { a: 1 },
        'Bad Key': 1,
      },
    },
    on,
  );
  assert.deepEqual(usage.properties, { orders_24h: 42, kds_enabled: true, service_model: 'qsr' });
  assert.equal(
    scrubPostHogEvent(
      { event: 'feature_used', properties: {} },
      {
        telemetryEnabled: false,
        allowExceptions: true,
      },
    ),
    null,
    'usage events follow telemetry',
  );

  const identified = scrubPostHogEvent(
    { event: '$identify', properties: { $set: { email: 'a@b.c', name: 'A', plan: 'secret' } } },
    { telemetryEnabled: false, allowExceptions: true },
  );
  assert.deepEqual(identified, { event: '$identify', properties: {} });
  const named = scrubPostHogEvent(
    {
      event: '$identify',
      properties: { $set: { email: 'a@b.c', name: 'A', country: 'AR', plan: 'secret' } },
    },
    { telemetryEnabled: true, allowExceptions: false },
  );
  assert.deepEqual(named, {
    event: '$identify',
    properties: { $set: { email: 'a@b.c', country: 'AR' } },
  });
  const browserIdentify = scrubPostHogEvent(
    {
      event: '$identify',
      uuid: 'event-uuid',
      $set: { email: 'a@b.c', name: 'A' },
      $set_once: { $initial_current_url: 'https://store.example/orders/55' },
      properties: {
        token: 'phc_public',
        distinct_id: 'anon-install',
        $current_url: 'https://store.example/orders/55?tab=secret#token=abc',
        $referrer: 'https://secret.example/from',
        $session_entry_url: 'http://localhost:3001/settings?tab=privacy',
        $initial_person_info: { u: 'http://localhost:3001/settings?tab=privacy' },
        $set_once: { $referrer: 'https://secret.example' },
        $geoip_disable: true,
      },
    },
    on,
  );
  assert.deepEqual(browserIdentify, {
    event: '$identify',
    uuid: 'event-uuid',
    properties: {
      token: 'phc_public',
      distinct_id: 'anon-install',
      $geoip_disable: true,
      $set: { email: 'a@b.c' },
    },
  });

  initDatabase();
  assert.equal(readSetting('posthog_project_token'), SEEDED_POSTHOG_TOKEN);
  assert.equal(readSetting('posthog_host'), SEEDED_POSTHOG_HOST);
  deleteSetting('posthog_project_token');
  deleteSetting('posthog_host');
  getDatabase().pragma('user_version = 114');
  closeDatabase();
  initDatabase();
  assert.equal(readSetting('posthog_project_token'), SEEDED_POSTHOG_TOKEN);
  assert.equal(readSetting('posthog_host'), SEEDED_POSTHOG_HOST);
  setSetting('posthog_project_token', 'phc_keep');
  setSetting('posthog_host', 'https://example.test');
  getDatabase().pragma('user_version = 114');
  closeDatabase();
  initDatabase();
  assert.equal(
    readSetting('posthog_project_token'),
    'phc_keep',
    'an existing token survives the seed',
  );
  assert.equal(
    readSetting('posthog_host'),
    'https://example.test',
    'an existing host survives the seed',
  );
  setSetting('posthog_project_token', SEEDED_POSTHOG_TOKEN);
  setSetting('posthog_host', SEEDED_POSTHOG_HOST);

  setSetting('telemetry_enabled', 'true');
  setSetting('diagnostics_consent', 'true');
  setSetting('diagnostics_transmission_enabled', 'true');
  setSetting('telemetry_anon_id', 'anon-install');
  const preSetup = resolvePostHogIdentity(true);
  assert.match(preSetup.distinctId, /^inst_[0-9a-f]{16}$/, 'before setup the device is anonymous');
  assert.equal(preSetup.identified, false);
  assert.equal(resolvePostHogIdentity(false).installRef, undefined);
  insertUser('owner-1', 'Owner One', 'owner@example.com');
  insertUser('cashier-2', 'Cashier Two', 'cashier@example.com');

  delete process.env.CI;
  delete process.env.FLO_MATRIX_OFFLINE;
  delete process.env.E2E_TASK_LOCAL_PORTS;
  syncPostHogIdentity();
  capturePostHogUsage('app_launch');
  assert.equal(clients.length, 0, 'a test suite, even with isPackaged stubbed, never connects');
  assert.deepEqual(readPostHogBootstrap(), { enabled: false });
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
  syncPostHogIdentity();
  assert.equal(clients.length, 0, 'a packaged build without the release stamp never connects');
  assert.equal(resolveOfficialRelease({ schema_version: 1, official_release: true }, true), true);
  assert.equal(resolveOfficialRelease({ schema_version: 1, official_release: true }, false), false);
  assert.equal(resolveOfficialRelease({ schema_version: 1, build_id: 'abc' }, true), false);
  assert.equal(resolveOfficialRelease({ official_release: 'true' }, true), false);
  process.env.FLO_POSTHOG_DEV = '1';
  assert.equal(readSuperProperties().environment, 'development');

  const suppressed: Array<[string, () => void]> = [
    [
      'CI',
      () => {
        process.env.CI = 'true';
      },
    ],
    [
      'FLO_MATRIX_OFFLINE',
      () => {
        process.env.FLO_MATRIX_OFFLINE = '1';
      },
    ],
    [
      'E2E_TASK_LOCAL_PORTS',
      () => {
        process.env.E2E_TASK_LOCAL_PORTS = '1';
      },
    ],
  ];
  for (const [name, enable] of suppressed) {
    delete process.env.CI;
    delete process.env.FLO_MATRIX_OFFLINE;
    delete process.env.E2E_TASK_LOCAL_PORTS;
    enable();
    const before = clients.length;
    syncPostHogIdentity();
    capturePostHogException('uncaughtException', new Error('must not send'));
    assert.equal(clients.length, before, `${name} does not open a PostHog client`);
    assert.deepEqual(readPostHogBootstrap(), { enabled: false });
    const header = buildCspHeader({ get: () => 'localhost:3001' });
    assert.equal(
      connectSources(header).some((source) => source === SEEDED_POSTHOG_HOST),
      false,
      `${name} does not allow the capture host`,
    );
    assert.equal(header.includes(SEEDED_POSTHOG_TOKEN), false);
  }
  delete process.env.CI;
  delete process.env.FLO_MATRIX_OFFLINE;
  delete process.env.E2E_TASK_LOCAL_PORTS;
  assert.equal(
    clients.some((client) => client.options.host === SEEDED_POSTHOG_HOST),
    false,
    'capture checks never target the EU capture host',
  );

  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete process.env.POSTHOG_HOST;
  deleteSetting('posthog_project_token');
  deleteSetting('posthog_host');
  process.env.POSTHOG_PROJECT_TOKEN = 'phc_test';
  process.env.POSTHOG_HOST = 'https://us.i.posthog.com';
  syncPostHogIdentity();
  capturePostHogException('uncaughtException', new Error('should not send'));
  assert.equal(clients.length, 0, 'environment variables do not configure PostHog');
  assert.deepEqual(readPostHogBootstrap(), { enabled: false });
  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete process.env.POSTHOG_HOST;

  setSetting('posthog_project_token', 'phc_test');
  syncPostHogIdentity();
  assert.equal(clients.length, 0, 'a token without a host sends nothing');
  setSetting('posthog_host', 'not a url');
  syncPostHogIdentity();
  assert.equal(clients.length, 0, 'an unparseable host sends nothing');
  deleteSetting('posthog_project_token');
  setSetting('posthog_host', 'https://us.i.posthog.com');
  syncPostHogIdentity();
  assert.equal(clients.length, 0, 'a host without a token sends nothing');

  setSetting('posthog_project_token', 'phc_test');
  setSetting('posthog_host', 'https://us.i.posthog.com/e/');
  setSetting('email', 'store@example.com');
  setSetting('service_model', 'qsr');
  syncPostHogIdentity();
  assert.equal(clients.length, 1);
  assert.equal(latest().options.host, 'https://us.i.posthog.com');
  assert.equal(latest().options.isServer, false);
  assert.equal(
    (latest().options as { disableGeoip?: boolean }).disableGeoip,
    false,
    'GeoIP enrichment is on',
  );
  assert.equal(latest().options.personalApiKey, undefined);
  // The account key was first derived before the store email existed; the first key is kept.
  const account = `acct_${accountRefForEmail('Owner@Example.com ')}`;
  const device = `inst_${readInstallRef()}`;
  assert.equal(latest().events.length, 1);
  assert.equal(latest().events[0].distinctId, account, 'the person is the customer account');
  assert.equal(latest().events[0].event, '$identify');
  assert.deepEqual(latest().aliases, [{ distinctId: account, alias: device }]);
  syncPostHogIdentity();
  assert.equal(latest().aliases.length, 1, 'a device is aliased into its account once');
  const personSet = latest().events[0].properties?.$set as Record<string, unknown>;
  assert.equal(personSet.email, 'store@example.com', 'the store email cloud registration uses');
  assert.equal(personSet.service_model, 'qsr');
  assert.equal(typeof personSet.app_version, 'string');
  assert.equal('name' in personSet, false, 'names are never sent');
  assert.equal(JSON.stringify(personSet).includes('Owner One'), false);
  const bootstrap = readPostHogBootstrap();
  assert.equal(bootstrap.enabled, true);
  assert.equal('person' in bootstrap, false, 'main identifies; the renderer only reuses the id');
  assert.equal(bootstrap.distinctId, account);
  assert.equal(bootstrap.identified, true);
  assert.equal(bootstrap.superProperties.store_ref, account.slice('acct_'.length));
  assert.equal(bootstrap.superProperties.install_ref, device.slice('inst_'.length));
  assert.equal(typeof bootstrap.superProperties.app_version, 'string');
  assert.equal(JSON.stringify(bootstrap).includes('cashier@example.com'), false);

  deleteSetting('email');
  syncPostHogIdentity();
  assert.equal(
    (latest().events.at(-1).properties?.$set as Record<string, unknown>).email,
    'owner@example.com',
    'falls back to the account setup created',
  );
  assert.equal(latest().events.at(-1).distinctId, account, 'an email edit keeps the person');

  capturePostHogUsage('feature_used', { feature: 'split_checks', action: 'enabled' });
  const mirrored = latest().events.at(-1);
  assert.equal(mirrored.event, 'feature_used');
  assert.equal(mirrored.properties?.feature, 'split_checks');
  assert.equal(typeof mirrored.properties?.app_version, 'string');
  const summary = readDailyUsageSummary();
  assert.equal(summary.orders_24h, 0);
  assert.equal(summary.active_staff_count, 2);
  assert.equal(summary.service_model, 'qsr');
  assert.equal(summary.staff_with_orders_24h, 0);

  setSetting('cloud_store_id', 'store-42');
  const storeRef = readSuperProperties().store_ref;
  assert.match(storeRef, /^[0-9a-f]{16}$/);
  assert.notEqual(storeRef, 'store-42');
  deleteSetting('cloud_store_id');

  const milestoneEvents = () =>
    latest()
      .events.filter((event) => event.event.startsWith('first_'))
      .map((event) => event.event);
  checkPostHogMilestones();
  assert.deepEqual(milestoneEvents(), [], 'no milestone before the first order');
  const ts = now();
  getDatabase()
    .prepare(
      `INSERT INTO orders (order_number, type, status, user_id, created_at, updated_at)
       VALUES ('M-1', 'takeaway', 'completed', 'owner-1', ?, ?)`,
    )
    .run(ts, ts);
  checkPostHogMilestones();
  checkPostHogMilestones();
  assert.deepEqual(milestoneEvents(), ['first_order_created'], 'each milestone is sent once');
  assert.equal(typeof latest().events.at(-1).properties?.hours_since_setup, 'number');
  assert.equal(readDailyUsageSummary().staff_with_orders_24h, 1);
  getDatabase().prepare("DELETE FROM orders WHERE order_number = 'M-1'").run();
  assert.equal(JSON.stringify(summary).includes('@'), false);

  capturePostHogException('uncaughtException', new Error('order 55123 for customer "Ada"'));
  const recorded = latest().exceptions.at(-1);
  assert.ok(recorded);
  assert.equal(recorded.message, 'order <n> for customer "<redacted>"');
  assert.equal(recorded.stack.includes('Ada'), false);
  assert.equal(recorded.stack.includes('55123'), false);
  assert.equal(recorded.stack.includes('posthog-client.test'), true, 'real frames are kept');
  assert.equal(recorded.distinctId, account);
  assert.equal(recorded.properties?.capture_point, 'uncaughtException');
  assert.equal(typeof recorded.properties?.app_version, 'string');

  capturePostHogException('unhandledRejection', 'customer Ada phone');
  const rejection = latest().exceptions.at(-1);
  assert.equal(rejection.message, '');
  assert.equal(rejection.stack.includes('Ada'), false);
  assert.equal(rejection.name, 'Error');

  capturePostHogApiFailure('POST', '/api/orders/:id/items', 500);
  const apiCaptured = latest().exceptions.at(-1);
  assert.equal(apiCaptured.name, 'ApiServerError');
  assert.equal(apiCaptured.message, 'POST /api/orders/:id/items');
  assert.equal(apiCaptured.properties?.capture_point, 'api-5xx');
  assert.equal(apiCaptured.properties?.http_status, 500);

  setSetting('telemetry_enabled', 'false');
  const before = latest().events.length;
  const exceptionsBefore = latest().exceptions.length;
  syncPostHogIdentity();
  capturePostHogUsage('app_launch');
  assert.equal(latest().events.length, before, 'no identify and no usage while telemetry is off');
  const quiet = readPostHogBootstrap();
  assert.equal(quiet.telemetryEnabled, false);
  capturePostHogException('unhandledRejection', new TypeError('still report'));
  assert.equal(
    latest().exceptions.length,
    exceptionsBefore + 1,
    'diagnostics stay on when telemetry is off',
  );
  const offline = latest().exceptions.at(-1);
  assert.match(offline.distinctId ?? '', /^anon_/, 'telemetry off never links to the account');
  assert.equal(offline.properties?.$process_person_profile, false);
  assert.equal('install_ref' in (offline.properties ?? {}), false);
  assert.equal('store_ref' in (offline.properties ?? {}), false);
  assert.equal(quiet.distinctId, offline.distinctId);
  assert.equal(quiet.identified, false);

  setSetting('diagnostics_transmission_enabled', 'false');
  const blocked = latest().exceptions.length;
  capturePostHogException('uncaughtException', new Error('no diagnostics'));
  assert.equal(
    latest().exceptions.length,
    blocked,
    'exceptions stop when diagnostics transmission is off',
  );
  syncPostHogIdentity();
  assert.equal(readPostHogBootstrap().enabled, false);

  setSetting('telemetry_enabled', 'false');
  const constructed = clients.length;
  syncPostHogIdentity();
  capturePostHogException('uncaughtException', new Error('both off'));
  assert.equal(clients.length, constructed);
  assert.equal(latest().exceptions.at(-1)?.message === 'both off', false);

  getDatabase().prepare('DELETE FROM users').run();
  setSetting('telemetry_enabled', 'true');
  setSetting('diagnostics_transmission_enabled', 'true');
  syncPostHogIdentity();
  assert.equal('email' in (latest().events.at(-1).properties?.$set as object), false);

  process.env.FLO_POSTHOG_DEV_TOKEN = 'phc_dev_project';
  assert.equal(readPostHogConfig().token, 'phc_dev_project', 'development can use its own project');
  delete process.env.FLO_POSTHOG_DEV;
  assert.notEqual(readPostHogConfig()?.token, 'phc_dev_project', 'the dev token is dev-only');
  assert.equal(readPostHogBootstrap().enabled, false, 'outside development nothing connects');
  process.env.FLO_POSTHOG_DEV = '1';
  delete process.env.FLO_POSTHOG_DEV_TOKEN;

  const csp = buildCspHeader({ get: () => 'localhost:3001' });
  assert.equal(
    connectSources(csp).some((source) => source === 'https://us.i.posthog.com'),
    true,
  );
  assert.equal(csp.includes('phc_test'), false);
  setSetting('posthog_host', 'https://user:pass@us.i.posthog.com');
  const rejected = buildCspHeader({ get: () => 'localhost:3001' });
  assert.equal(rejected.includes('user:pass'), false);
  assert.equal(
    connectSources(rejected).some((source) => source.startsWith('https://')),
    false,
    'a host with credentials adds no source',
  );

  await stopPostHog();
  assert.equal(latest().shutdowns, 1);
  const [shutdownTimeout] = latest().shutdownTimeouts;
  assert.ok(
    typeof shutdownTimeout === 'number' && shutdownTimeout < SHUTDOWN_TIMEOUT_MS,
    'an offline flush cannot hit the fatal shutdown timeout and skip closing the database',
  );
  console.log('PostHog client checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete process.env.POSTHOG_PROJECT_TOKEN;
    delete process.env.POSTHOG_HOST;
    restorePostHogNetworkEnv();
    delete process.env.FLO_POSTHOG_DEV;
    delete process.env.FLO_POSTHOG_DEV_TOKEN;
    try {
      closeDatabase();
    } catch {
      // The database may already be closed.
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });
