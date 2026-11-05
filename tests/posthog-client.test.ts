import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    scrubbed?: Record<string, unknown>;
    cause?: Error;
  }>;
  shutdowns: number;
  aliases: Array<{ distinctId: string; alias: string }>;
  shutdownTimeouts: Array<number | undefined>;
}

const clients: RecordedClient[] = [];

interface StackFrame {
  filename: string;
  lineno: number;
  colno: number;
  function: string;
}

/** The frames posthog-node parses from a stack, so the mock sends the same shape it would. */
function stackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stackFrameLines(stack)) {
    const text = line.trim().slice(3);
    const open = text.lastIndexOf('(');
    const location = open === -1 ? text : text.slice(open + 1).replace(/\)$/, '');
    const match = /^(.*):(\d+):(\d+)$/.exec(location);
    if (match) {
      frames.push({
        filename: match[1],
        lineno: Number(match[2]),
        colno: Number(match[3]),
        function: 'frame',
      });
    }
  }
  return frames;
}

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
          if (this.options.before_send) {
            const scrubbed = this.options.before_send({
              event: payload.event ?? '',
              properties: { ...(payload.properties ?? {}), distinct_id: payload.distinctId },
            });
            if (!scrubbed) return;
          }
          this.events.push(payload);
        }
        captureException(error: Error, distinctId?: string, properties?: Record<string, unknown>) {
          const event = {
            event: '$exception',
            properties: {
              ...(properties ?? {}),
              distinct_id: distinctId,
              $exception_list: [
                {
                  type: error.name,
                  value: error.message,
                  stacktrace: { type: 'raw', frames: stackFrames(error.stack ?? '') },
                },
              ],
            },
          };
          let scrubbed: Record<string, unknown> | undefined;
          if (this.options.before_send) {
            const kept = this.options.before_send(event);
            if (!kept) return;
            scrubbed = (kept as { properties?: Record<string, unknown> }).properties;
          }
          this.exceptions.push({
            message: error.message,
            name: error.name,
            stack: error.stack ?? '',
            distinctId,
            properties,
            scrubbed,
            cause: error.cause instanceof Error ? error.cause : undefined,
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

const {
  initDatabase,
  getDatabase,
  closeDatabase,
  getSettingsRevision,
  now,
} = require('../main/db');
const {
  apiRoutePattern,
  apiSlowRequestMiddleware,
  capturePostHogApiFailure,
  capturePostHogException,
  capturePostHogUsage,
  checkPostHogMilestones,
  invalidatePostHogConsentCache,
  maybeSendPostHogDailyPing,
  postHogApiFailureMiddleware,
  readDailyUsageSummary,
  readPostHogBootstrap,
  readProductAnalyticsChoice,
  readSuperProperties,
  stopPostHog,
  syncPostHogIdentity,
} = require('../main/services/posthog');
const { buildCspHeader } = require('../main/csp');
const {
  resolveBuildPostHogSettings,
  resolveOfficialRelease,
} = require('../main/services/build-identity');
const { DEFAULT_POSTHOG_HOST, readPostHogConfig } = require('../main/services/posthog-config');
const {
  accountRefForEmail,
  productAnalyticsChoicePending,
  readInstallRef,
  readProductAnalyticsLevel,
  resolvePostHogIdentity,
} = require('../main/services/posthog-identity');
const { SHUTDOWN_TIMEOUT_MS } = require('../main/shutdown');
const { createScreenViewThrottle, screenKey } = require('../shared/posthog-screen-views');
const { cliEnv, shellArgs, sourceMapsConfigured } = require('../scripts/posthog-sourcemaps.cjs');
const {
  POSTHOG_USAGE_PROPERTY_KEYS,
  redactExceptionMessage,
  scrubPostHogEvent,
  scrubRequestPath,
  stackFrameLines,
} = require('../shared/posthog-scrub');

const RELEASE_POSTHOG_TOKEN = 'phc_release_build';
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

  const on = { telemetryEnabled: true, accountLinked: true, allowExceptions: true };

  assert.deepEqual(
    resolveBuildPostHogSettings({
      schema_version: 1,
      posthog_project_token: ' phc_release ',
      posthog_host: 'https://eu.i.posthog.com',
    }),
    { token: 'phc_release', host: 'https://eu.i.posthog.com' },
  );
  assert.deepEqual(
    resolveBuildPostHogSettings({ schema_version: 1, posthog_project_token: null }),
    { token: undefined, host: undefined },
    'a build without the release secret carries no token',
  );
  assert.deepEqual(resolveBuildPostHogSettings(null), {});
  assert.equal(accountRefForEmail('Owner@Shop.com'), accountRefForEmail(' owner@shop.com '));
  assert.notEqual(accountRefForEmail('a@shop.com'), accountRefForEmail('b@shop.com'));
  assert.equal(accountRefForEmail('not an email'), undefined);

  const alias = (properties: Record<string, unknown>, telemetryEnabled = true) =>
    scrubPostHogEvent(
      { event: '$create_alias', properties },
      { telemetryEnabled, accountLinked: telemetryEnabled, allowExceptions: true },
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
  assert.deepEqual(
    cliEnv({
      PATH: '/usr/bin',
      Path: 'C:\\bin',
      POSTHOG_CLI_API_KEY: 'phx_key',
      POSTHOG_CLI_PROJECT_ID: '7',
      POSTHOG_CLI_HOST: '',
      CSC_LINK: 'cert',
      CSC_KEY_PASSWORD: 'secret',
      APPLE_API_KEY: '/key.p8',
      GITHUB_TOKEN: 'ghs',
    }),
    {
      PATH: '/usr/bin',
      Path: 'C:\\bin',
      POSTHOG_CLI_API_KEY: 'phx_key',
      POSTHOG_CLI_PROJECT_ID: '7',
      POSTHOG_CLI_HOST: 'https://eu.posthog.com',
    },
    'the CLI never sees signing or store credentials',
  );

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
    { telemetryEnabled: false, accountLinked: false, allowExceptions: true },
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
        accountLinked: true,
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

  // A 5xx from app-level middleware has no matched route, and `requestRoute` says so.
  const unmatchedFailure = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'api-5xx',
        http_method: 'GET',
        http_route: '<unmatched>',
        http_status: 500,
      },
    },
    on,
  );
  assert.equal(
    unmatchedFailure.properties.http_route,
    '<unmatched>',
    'the unmatched-route sentinel survives the scrub and is reported',
  );
  const otherSentinel = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'api-5xx',
        http_method: 'GET',
        http_route: '<customer Ada>',
        http_status: 500,
      },
    },
    on,
  );
  assert.equal(
    otherSentinel.properties.http_route,
    undefined,
    'only the exact sentinel passes; any other non-path value is still dropped',
  );

  const located = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'api-5xx',
        process_type: 'api',
        $release_id: '0192f0c4-7d1e-7000-8000-000000000000',
        $current_url: 'http://localhost:3001/orders/4471/?customer=ada#x',
        $exception_list: [
          {
            type: 'TypeError',
            value: 'order 55123 could not be read',
            stacktrace: {
              type: 'raw',
              frames: [
                { filename: 'main/routes/orders.ts', lineno: 42, colno: 7, function: 'read' },
              ],
            },
          },
        ],
      },
    },
    on,
  );
  assert.equal(located.properties.process_type, 'api', 'the failing process survives the scrub');
  assert.equal(located.properties.$release_id, '0192f0c4-7d1e-7000-8000-000000000000');
  assert.equal(located.properties.$pathname, '/orders/:id/', 'the route is a pattern');
  assert.equal(JSON.stringify(located).includes('ada'), false);
  assert.equal(JSON.stringify(located).includes('localhost'), false);
  assert.deepEqual(located.properties.$exception_list[0].stacktrace.frames, [
    { filename: 'main/routes/orders.ts', lineno: 42, colno: 7, function: 'read' },
  ]);

  const chained = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'uncaughtException',
        $exception_list: [
          {
            type: 'Error',
            value: 'ledger write failed',
            mechanism: { type: 'generic', handled: false, exception_id: 0, source: 'cause' },
            stacktrace: { type: 'raw', frames: [{ filename: 'main/db.ts', lineno: 20 }] },
          },
          {
            type: 'TypeError',
            value: 'chained failure',
            mechanism: {
              type: 'chained',
              handled: false,
              exception_id: 1,
              parent_id: 0,
              source: 'cause',
              data: 'Customer Juan Perez',
            },
            stacktrace: { type: 'raw', frames: [{ filename: 'main/db.ts', lineno: 30 }] },
          },
        ],
      },
    },
    on,
  );
  const list = chained.properties.$exception_list as Array<Record<string, any>>;
  assert.equal(list.length, 2, 'a cause stays in the list');
  assert.deepEqual(
    list[1].mechanism,
    { handled: false, type: 'chained', exception_id: 1, parent_id: 0, source: 'cause' },
    'the mechanism keeps the cause link and its source',
  );
  assert.deepEqual(
    list[0].mechanism,
    { handled: false, type: 'generic', exception_id: 0, source: 'cause' },
    'the first cause index is 0, not dropped',
  );
  assert.equal(JSON.stringify(chained).includes('Juan'), false, 'no mechanism data leaves');

  const axiosFailure = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'react-error-boundary',
        process_type: 'renderer',
        http_method: 'GET',
        http_route: 'http://localhost:3001/api/orders/4471?expand=ada',
        http_status: 502,
        $exception_list: [{ type: 'AxiosError', value: 'Network Error' }],
      },
    },
    on,
  );
  assert.equal(axiosFailure.properties.$exception_type, 'AxiosError');
  assert.equal(axiosFailure.properties.http_method, 'GET');
  assert.equal(axiosFailure.properties.http_route, '/api/orders/:id', 'the request is a pattern');
  assert.equal(axiosFailure.properties.http_status, 502);
  assert.equal(JSON.stringify(axiosFailure).includes('localhost'), false);
  assert.equal(JSON.stringify(axiosFailure).includes('ada'), false);

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
        accountLinked: false,
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
  const unlisted = scrubPostHogEvent(
    {
      event: 'feature_used',
      properties: { feature: 'split_checks', customer_name: 'Ada', order_id: 1234 },
    },
    on,
  );
  assert.deepEqual(unlisted?.properties, { feature: 'split_checks' }, 'unlisted keys are dropped');
  const slow = scrubPostHogEvent(
    {
      event: 'api_slow_request',
      properties: {
        http_method: 'GET',
        http_route: '/api/orders/:id',
        http_status: 200,
        duration_ms: 1420,
        db_ms: 900,
        db_queries: 12,
        slowest_query_ms: 320,
        slowest_query: 'SELECT * FROM orders WHERE id = ? AND status = ?',
        order_id: 1234,
      },
    },
    on,
  );
  assert.deepEqual(
    slow?.properties,
    {
      http_method: 'GET',
      http_route: '/api/orders/:id',
      http_status: 200,
      duration_ms: 1420,
      db_ms: 900,
      db_queries: 12,
      slowest_query_ms: 320,
      slowest_query: 'SELECT * FROM orders WHERE id = ? AND status = ?',
    },
    'a slow request keeps its counters and the normalized SQL',
  );
  const rawSql = scrubPostHogEvent(
    {
      event: 'api_slow_request',
      properties: { slowest_query: "SELECT * FROM orders WHERE name = 'Ada'" },
    },
    on,
  );
  assert.deepEqual(rawSql?.properties, {}, 'SQL that still holds a literal is dropped');
  const namedSql = 'SELECT o.id || ? FROM orders o WHERE o.status != @status AND o.total / ? > [x]';
  const namedParams = scrubPostHogEvent(
    { event: 'api_slow_request', properties: { slowest_query: namedSql } },
    on,
  );
  assert.deepEqual(
    namedParams?.properties,
    { slowest_query: namedSql },
    'normalized SQL with named parameters and operators is kept',
  );
  const quotedSql = 'SELECT * FROM items WHERE name = "OMELETTE"';
  const quoted = scrubPostHogEvent(
    { event: 'api_slow_request', properties: { slowest_query: quotedSql } },
    on,
  );
  assert.deepEqual(
    quoted?.properties,
    {},
    'SQL that still holds a double-quoted string is dropped',
  );

  const anonymous = { telemetryEnabled: true, accountLinked: false, allowExceptions: true };
  const anonymousIdentify = scrubPostHogEvent(
    {
      event: '$set',
      properties: {
        distinct_id: 'inst_fedcba9876543210',
        $set: { email: 'a@b.c', country: 'AR', store_ref: '0123456789abcdef' },
      },
    },
    anonymous,
  );
  assert.deepEqual(anonymousIdentify?.properties?.$set, { country: 'AR' }, 'no email or store_ref');
  assert.equal(
    scrubPostHogEvent(
      { event: 'feature_used', properties: { distinct_id: 'acct_0123456789abcdef' } },
      anonymous,
    ),
    null,
    'an account id is dropped below the full level',
  );
  assert.equal(
    scrubPostHogEvent({ event: '$create_alias', properties: goodAlias }, anonymous),
    null,
    'only the full level aliases',
  );
  const anonymousUsage = scrubPostHogEvent(
    {
      event: 'feature_used',
      properties: {
        distinct_id: 'inst_fedcba9876543210',
        store_ref: '0123456789abcdef',
        install_ref: 'fedcba9876543210',
        feature: 'split_checks',
      },
    },
    anonymous,
  );
  assert.deepEqual(anonymousUsage?.properties, {
    distinct_id: 'inst_fedcba9876543210',
    install_ref: 'fedcba9876543210',
    feature: 'split_checks',
  });
  assert.equal(
    scrubPostHogEvent(
      { event: 'feature_used', properties: {} },
      {
        telemetryEnabled: false,
        accountLinked: false,
        allowExceptions: true,
      },
    ),
    null,
    'usage events follow telemetry',
  );

  const identified = scrubPostHogEvent(
    { event: '$identify', properties: { $set: { email: 'a@b.c', name: 'A', plan: 'secret' } } },
    { telemetryEnabled: false, accountLinked: false, allowExceptions: true },
  );
  assert.deepEqual(identified, { event: '$identify', properties: {} });
  const named = scrubPostHogEvent(
    {
      event: '$identify',
      properties: { $set: { email: 'a@b.c', name: 'A', country: 'AR', plan: 'secret' } },
    },
    { telemetryEnabled: true, accountLinked: true, allowExceptions: false },
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
  assert.equal(readSetting('posthog_project_token'), null, 'no token is seeded');
  assert.equal(readSetting('posthog_host'), null, 'no host is seeded');
  assert.equal(readPostHogConfig(), null, 'a fresh database without a release token sends nothing');

  const nodeFs = require('fs') as { readFileSync: (...args: unknown[]) => unknown };
  const originalReadFileSync = nodeFs.readFileSync;
  const withBuildIdentity = <T>(metadata: Record<string, unknown>, run: () => T): T => {
    nodeFs.readFileSync = function (file: unknown, ...rest: unknown[]) {
      if (typeof file === 'string' && path.basename(file) === 'build-identity.json') {
        return JSON.stringify(metadata);
      }
      return originalReadFileSync(file, ...rest);
    };
    try {
      return run();
    } finally {
      nodeFs.readFileSync = originalReadFileSync;
    }
  };
  const releaseBuild = {
    schema_version: 1,
    posthog_project_token: RELEASE_POSTHOG_TOKEN,
    posthog_host: 'https://us.i.posthog.com',
  };
  assert.deepEqual(
    withBuildIdentity(releaseBuild, () => readPostHogConfig()),
    { token: RELEASE_POSTHOG_TOKEN, host: 'https://us.i.posthog.com' },
    'the release build supplies the token and host',
  );
  assert.deepEqual(
    withBuildIdentity({ ...releaseBuild, posthog_host: null }, () => readPostHogConfig()),
    { token: RELEASE_POSTHOG_TOKEN, host: DEFAULT_POSTHOG_HOST },
    'a build without a host uses EU Cloud',
  );
  setSetting('posthog_host', 'https://example.test');
  assert.equal(
    withBuildIdentity(releaseBuild, () => readPostHogConfig())?.host,
    'https://example.test',
    'a settings host overrides the build host',
  );
  deleteSetting('posthog_host');
  setSetting('posthog_project_token', 'phc_settings');
  assert.equal(
    withBuildIdentity(releaseBuild, () => readPostHogConfig())?.token,
    'phc_settings',
    'a settings token overrides the build token',
  );
  setSetting('posthog_project_token', RELEASE_POSTHOG_TOKEN);

  assert.equal(readSetting('posthog_install_seed'), null);
  const installRef = readInstallRef();
  const installSeed = readSetting('posthog_install_seed');
  assert.match(
    installSeed ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(
    installRef,
    createHash('sha256').update(`flocafe-install:${installSeed}`).digest('hex').slice(0, 16),
    'the device id is derived from the stored random seed',
  );
  assert.equal(readInstallRef(), installRef);
  assert.equal(readSetting('posthog_install_seed'), installSeed, 'the seed is generated once');
  deleteSetting('posthog_install_seed');
  assert.notEqual(readInstallRef(), installRef, 'a replaced database gets its own device id');
  setSetting('posthog_install_seed', installSeed ?? '');

  setSetting('telemetry_enabled', 'true');
  setSetting('product_analytics_level', 'full');
  setSetting('diagnostics_consent', 'true');
  setSetting('diagnostics_transmission_enabled', 'true');
  setSetting('telemetry_anon_id', 'anon-install');
  const preSetup = resolvePostHogIdentity('full');
  assert.match(preSetup.distinctId, /^inst_[0-9a-f]{16}$/, 'before setup the device is anonymous');
  assert.equal(preSetup.identified, false);
  assert.equal(resolvePostHogIdentity('off').installRef, undefined);
  insertUser('owner-1', 'Owner One', 'owner@example.com');
  insertUser('cashier-2', 'Cashier Two', 'cashier@example.com');

  deleteSetting('product_analytics_level');
  assert.equal(readProductAnalyticsLevel(), 'off', 'before setup nothing is shared');
  assert.equal(productAnalyticsChoicePending(), false);
  setSetting('onboarding_completed', 'true');
  assert.equal(readProductAnalyticsLevel(), 'anonymous', 'an upgraded store shares anonymously');
  assert.equal(productAnalyticsChoicePending(), true, 'and the owner is asked once');
  assert.equal(
    readProductAnalyticsChoice().choice_pending,
    false,
    'the question is only asked where PostHog can send',
  );
  const anonymousDevice = resolvePostHogIdentity('anonymous');
  assert.match(anonymousDevice.distinctId, /^inst_[0-9a-f]{16}$/);
  assert.equal(anonymousDevice.accountRef, undefined, 'anonymous never derives the account');
  assert.equal(readSetting('posthog_account_ref'), null);
  setSetting('product_analytics_level', 'off');
  assert.equal(
    readProductAnalyticsLevel(),
    'anonymous',
    'telemetry back on is anonymous, not full',
  );
  assert.equal(productAnalyticsChoicePending(), false);
  setSetting('telemetry_enabled', 'false');
  setSetting('product_analytics_level', 'full');
  assert.equal(readProductAnalyticsLevel(), 'off', 'telemetry off always wins');
  setSetting('telemetry_enabled', 'true');

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
      connectSources(header).some((source) => source === DEFAULT_POSTHOG_HOST),
      false,
      `${name} does not allow the capture host`,
    );
    assert.equal(header.includes(RELEASE_POSTHOG_TOKEN), false);
  }
  delete process.env.CI;
  delete process.env.FLO_MATRIX_OFFLINE;
  delete process.env.E2E_TASK_LOCAL_PORTS;
  assert.equal(
    clients.some((client) => client.options.host === DEFAULT_POSTHOG_HOST),
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

  setSetting('posthog_host', 'not a url');
  setSetting('posthog_project_token', 'phc_test');
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

  deleteSetting('posthog_account_ref');
  capturePostHogUsage('feature_used', { feature: 'split_checks', action: 'enabled' });
  const mirrored = latest().events.at(-1);
  assert.equal(mirrored.event, 'feature_used');
  assert.equal(mirrored.properties?.feature, 'split_checks');
  assert.equal(typeof mirrored.properties?.app_version, 'string');

  const dbForCount = getDatabase();
  const originalPrepare = dbForCount.prepare.bind(dbForCount);
  let capturePrepareCalls = 0;
  dbForCount.prepare = ((sql: string) => {
    capturePrepareCalls += 1;
    return originalPrepare(sql);
  }) as typeof dbForCount.prepare;
  try {
    capturePostHogUsage('feature_used', { feature: 'split_checks', action: 'disabled' });
    capturePostHogException('uncaughtException', new Error('cached exception check'));
  } finally {
    dbForCount.prepare = originalPrepare;
  }
  assert.equal(
    capturePrepareCalls,
    0,
    'subsequent capturePostHogUsage and capturePostHogException reuse cached consent, diagnostics, and identity without synchronous SQLite reads',
  );
  setSetting('diagnostics_consent', 'false');
  const exceptionsBeforeDirectDisable = latest().exceptions.length;
  capturePostHogException('uncaughtException', new Error('blocked by direct SQLite write'));
  assert.equal(
    latest().exceptions.length,
    exceptionsBeforeDirectDisable,
    'direct SQLite settings mutation invalidates cached diagnostics consent via trigger',
  );
  setSetting('diagnostics_consent', 'true');
  invalidatePostHogConsentCache();
  const revisionBeforeReopen = getSettingsRevision();
  closeDatabase();
  assert.equal(getSettingsRevision() > revisionBeforeReopen, true);
  const revisionAfterClose = getSettingsRevision();
  initDatabase(false, true);
  assert.equal(getSettingsRevision() > revisionAfterClose, true);
  const summary = readDailyUsageSummary();
  assert.equal(summary.orders_24h, 0);
  assert.equal(summary.active_staff_count, 2);
  assert.equal(summary.service_model, 'qsr');
  assert.equal(summary.staff_with_orders_24h, 0);
  for (const key of Object.keys(summary)) {
    assert.ok(
      (POSTHOG_USAGE_PROPERTY_KEYS as readonly string[]).includes(key),
      `daily_ping key ${key} is on the usage allowlist`,
    );
  }

  setSetting('product_analytics_level', 'anonymous');
  const beforeAnonymous = latest().events.length;
  syncPostHogIdentity();
  capturePostHogUsage('feature_used', { feature: 'split_checks', action: 'enabled' });
  const anonymousEvents = latest().events.slice(beforeAnonymous);
  assert.deepEqual(
    anonymousEvents.map((event) => [event.event, event.distinctId]),
    [
      ['$set', device],
      ['feature_used', device],
    ],
    'anonymous events belong to the device',
  );
  const anonymousPerson = anonymousEvents[0].properties?.$set as Record<string, unknown>;
  assert.equal('email' in anonymousPerson, false, 'anonymous never sends the email');
  assert.equal('store_ref' in anonymousPerson, false);
  assert.equal(anonymousPerson.service_model, 'qsr', 'store configuration is still shared');
  assert.equal('store_ref' in (anonymousEvents[1].properties ?? {}), false);
  assert.equal(anonymousEvents[1].properties?.install_ref, device.slice('inst_'.length));
  assert.equal(latest().aliases.length, 1, 'anonymous adds no alias');
  const anonymousBootstrap = readPostHogBootstrap();
  assert.equal(anonymousBootstrap.distinctId, device);
  assert.equal(anonymousBootstrap.accountLinked, false);
  assert.equal(anonymousBootstrap.identified, true, 'renderer events join the device person');
  assert.equal(anonymousBootstrap.superProperties.store_ref, undefined);
  deleteSetting('product_analytics_level');
  assert.deepEqual(
    readProductAnalyticsChoice(),
    {
      level: 'anonymous',
      choice_pending: true,
      email: 'owner@example.com',
      diagnostics_enabled: true,
    },
    'a configured release asks the owner once',
  );
  setSetting('product_analytics_level', 'full');
  assert.equal(readProductAnalyticsChoice().choice_pending, false);
  assert.equal(readPostHogBootstrap().accountLinked, true);

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
  assert.equal('backfilled' in (latest().events.at(-1).properties ?? {}), false);
  deleteSetting('posthog_milestones_sent');
  getDatabase()
    .prepare(
      `INSERT INTO orders (order_number, type, status, user_id, created_at, updated_at)
       VALUES ('M-0', 'online', 'completed', 'owner-1', '2020-01-01 00:00:00', '2020-01-01 00:00:00')`,
    )
    .run();
  checkPostHogMilestones();
  assert.equal(
    latest().events.at(-1).properties?.backfilled,
    true,
    'a first order from before the upgrade is tagged backfilled',
  );
  getDatabase().prepare("DELETE FROM orders WHERE order_number = 'M-0'").run();

  getDatabase().prepare("UPDATE orders SET type = 'online' WHERE order_number = 'M-1'").run();
  const dailyPings = () => latest().events.filter((event) => event.event === 'daily_ping');
  const pingsBefore = dailyPings().length;
  maybeSendPostHogDailyPing();
  maybeSendPostHogDailyPing();
  assert.equal(dailyPings().length, pingsBefore + 1, 'one ping a day, without the collector');
  assert.equal(dailyPings().at(-1)?.properties?.orders_online_24h, 1);
  maybeSendPostHogDailyPing(Date.now() + 25 * 60 * 60_000);
  assert.equal(dailyPings().length, pingsBefore + 2);
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
  assert.equal(recorded.properties?.process_type, 'main');
  assert.equal(typeof recorded.properties?.app_version, 'string');
  const frames = recorded.scrubbed?.$exception_list as Array<Record<string, any>> | undefined;
  const firstFrame = (frames?.[0]?.stacktrace?.frames ?? [])[0];
  assert.match(
    String(firstFrame?.filename),
    /tests\/posthog-client\.test\.ts$/,
    'the file and line of the failing frame reach PostHog',
  );
  assert.ok(Number(firstFrame?.lineno) > 0);

  const cause = new Error('ledger 4411 unreadable');
  capturePostHogException(
    'uncaughtException',
    Object.assign(new Error('order save failed'), { cause }),
  );
  assert.equal(latest().exceptions.at(-1)?.cause?.message, 'ledger <n> unreadable');
  assert.equal(
    latest().exceptions.at(-1)?.cause?.stack?.includes('posthog-client.test'),
    true,
    'the cause keeps its own frames',
  );

  capturePostHogException('unhandledRejection', 'customer Ada phone');
  const rejection = latest().exceptions.at(-1);
  assert.equal(rejection.message, 'customer Ada phone', 'a string reason keeps its message');
  assert.equal(rejection.name, 'Error');

  capturePostHogException('unhandledRejection', 'customer 55123 at "Ada"');
  assert.equal(
    latest().exceptions.at(-1)?.message,
    'customer <n> at "<redacted>"',
    'a string reason is redacted like any message',
  );

  capturePostHogApiFailure('POST', '/api/orders/:id/items', 500);
  const apiCaptured = latest().exceptions.at(-1);
  assert.equal(apiCaptured.name, 'ApiServerError');
  assert.equal(apiCaptured.message, 'POST /api/orders/:id/items');
  assert.equal(apiCaptured.properties?.capture_point, 'api-5xx');
  assert.equal(apiCaptured.properties?.http_status, 500);
  assert.equal(apiCaptured.properties?.process_type, 'api');
  assert.match(
    apiCaptured.stack,
    /main[\\/]services[\\/]posthog\.ts/,
    'a 5xx without a thrown error still carries frames, never a bare name',
  );

  capturePostHogApiFailure(
    'PATCH',
    '/api/orders/:id/notes',
    500,
    new Error('Customer Juan Perez not found'),
  );
  const thrownCaptured = latest().exceptions.at(-1);
  assert.equal(thrownCaptured.name, 'Error', 'the thrown error names the issue');
  assert.equal(
    thrownCaptured.message,
    'PATCH /api/orders/:id/notes',
    'the message is the route pattern, never the text of the route error',
  );
  assert.equal(
    JSON.stringify(thrownCaptured).includes('Juan'),
    false,
    'a customer name in the thrown error never leaves the machine',
  );
  assert.equal(
    thrownCaptured.stack.includes('posthog-client.test'),
    true,
    'a thrown error brings its own frames',
  );

  const caused = new Error('ledger write failed');
  caused.cause = new TypeError('Customer Juan Perez not found');
  capturePostHogApiFailure('GET', '/api/reports/ledger', 500, caused);
  const causedCaptured = latest().exceptions.at(-1);
  assert.equal(causedCaptured.cause?.name, 'TypeError', 'the cause keeps its type');
  assert.equal(causedCaptured.cause?.message, '', 'the cause carries no message');
  assert.equal(
    causedCaptured.cause?.stack.includes('posthog-client.test'),
    true,
    'the cause keeps its frames',
  );
  assert.equal(JSON.stringify(causedCaptured).includes('Juan'), false);
  assert.equal(JSON.stringify(causedCaptured).includes('ledger write'), false);

  const beforeCloud = latest().exceptions.length;
  capturePostHogApiFailure('GET', '/api/settings/cloud/account', 502, new Error('no subscription'));
  capturePostHogApiFailure('GET', '/api/settings/cloud/account', 502);
  capturePostHogApiFailure(
    'POST',
    '/api/products/fetch-url',
    502,
    new Error('getaddrinfo ENOTFOUND'),
  );
  capturePostHogApiFailure(
    'GET',
    '/api/mobile/devices',
    502,
    new Error('Could not reach FloAdmin'),
  );
  assert.equal(
    latest().exceptions.length,
    beforeCloud,
    'a route that answers 5xx while offline sends no exception',
  );
  capturePostHogApiFailure('POST', '/api/products/fetch-url', 500, new Error('bug'));
  assert.equal(
    latest().exceptions.length,
    beforeCloud + 1,
    'a real 500 on an offline-gateway route is still reported',
  );

  const beforeRepeat = latest().exceptions.length;
  capturePostHogApiFailure('GET', '/api/reports/summary', 500);
  capturePostHogApiFailure('GET', '/api/reports/summary', 500);
  assert.equal(latest().exceptions.length, beforeRepeat + 1, 'one route sends once an hour');
  capturePostHogApiFailure('GET', '/api/reports/other', 500);
  assert.equal(
    latest().exceptions.length,
    beforeRepeat + 2,
    'another route still sends its own exception',
  );

  // Consent off and then on inside the window: the dropped send must not have taken the slot.
  setSetting('diagnostics_transmission_enabled', 'false');
  syncPostHogIdentity();
  const beforeConsentWindow = latest().exceptions.length;
  capturePostHogApiFailure('DELETE', '/api/reports/consent-window/:id', 500);
  assert.equal(
    latest().exceptions.length,
    beforeConsentWindow,
    'a 5xx with diagnostics transmission off sends nothing',
  );
  setSetting('diagnostics_transmission_enabled', 'true');
  syncPostHogIdentity();
  capturePostHogApiFailure('DELETE', '/api/reports/consent-window/:id', 500);
  assert.equal(
    latest().exceptions.length,
    beforeConsentWindow + 1,
    'consent on inside the window still sends that 5xx, once',
  );
  capturePostHogApiFailure('DELETE', '/api/reports/consent-window/:id', 500);
  assert.equal(
    latest().exceptions.length,
    beforeConsentWindow + 1,
    'and from then on the hour holds',
  );

  assert.equal(apiRoutePattern('/api/orders/42/?q=Ada', '/:id'), '/api/orders/:id');
  assert.equal(apiRoutePattern('/api/orders/42/items', '/:id/items'), '/api/orders/:id/items');
  assert.equal(apiRoutePattern('/api/health', '/api/health'), '/api/health');
  assert.equal(apiRoutePattern('/api/x', /x/), '<unmatched>');

  assert.equal(
    scrubRequestPath('/customers/juan-perez'),
    '/customers/*',
    'a name after the first segment of a request path is dropped',
  );
  assert.equal(
    scrubRequestPath('/tables/floors/Patio'),
    '/tables/*',
    'a floor name in a request path is dropped',
  );
  assert.equal(
    scrubRequestPath('/customers-search?q=juan'),
    '/customers-search',
    'a search term is dropped with the query',
  );
  const express = require('express');
  const api = express();
  api.use(postHogApiFailureMiddleware);
  const orders = express.Router();
  orders.put('/:id', (_req: unknown, _res: unknown, next: (error: Error) => void) =>
    next(new Error('boom')),
  );
  orders.post('/:id', async () => {
    throw new Error('boom');
  });
  orders.get('/:id', (_req: unknown, res: any) => res.status(503).json({ error: 'busy' }));
  // The shape of a route catch after this change: hand the error over, then send the 5xx.
  orders.post('/:id/handoff', (_req: unknown, res: any) => {
    try {
      throw new RangeError('boom');
    } catch (error) {
      res.locals.postHogError = error;
      res.status(500).json({ error: 'failed' });
    }
  });
  // The same catch without the handoff, for the contrast.
  orders.post('/:id/no-handoff', (_req: unknown, res: any) => {
    try {
      throw new RangeError('boom');
    } catch {
      res.status(500).json({ error: 'failed' });
    }
  });
  api.use('/api/orders', orders);
  // Mirrors the global error handler in main/server.ts: the thrown error rides along.
  api.use((error: Error, _req: unknown, res: any, _next: unknown) => {
    res.locals.postHogError = error;
    res.status(500).end();
  });
  const server = api.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    for (const method of ['PUT', 'POST']) {
      await fetch(`http://127.0.0.1:${port}/api/orders/42?customer=Ada`, { method });
      await new Promise((resolve) => setImmediate(resolve));
      const routed = latest().exceptions.at(-1);
      assert.equal(
        routed.properties?.http_route,
        '/api/orders/:id',
        `${method} errors from the global handler keep the mount prefix`,
      );
      assert.equal(routed.properties?.http_method, method);
      assert.equal(routed.properties?.http_route?.includes('customer'), false);
      assert.equal(routed.name, 'Error', 'the caught error names the issue');
      assert.equal(
        routed.message,
        `${method} /api/orders/:id`,
        'the message is the route pattern, never the text of the error the route caught',
      );
      assert.match(
        String(
          (routed.scrubbed?.$exception_list as Array<Record<string, any>>)?.[0]?.stacktrace
            ?.frames?.[0]?.filename,
        ),
        /tests\/posthog-client\.test\.ts$/,
        `${method} keeps the frames of the error the route caught`,
      );
      assert.equal(
        routed.stack.includes('posthog-client.test'),
        true,
        `${method} keeps real frames`,
      );
    }
    await fetch(`http://127.0.0.1:${port}/api/orders/42`, { method: 'GET' });
    await new Promise((resolve) => setImmediate(resolve));
    const bare = latest().exceptions.at(-1);
    assert.equal(bare.properties?.http_status, 503);
    assert.equal(
      bare.stack.includes('posthog-client.test'),
      true,
      'a 5xx sent without a thrown error keeps the frames of its sender',
    );

    // A catch that sets the handoff carries the real error type; one that does not cannot.
    await fetch(`http://127.0.0.1:${port}/api/orders/42/handoff`, { method: 'POST' });
    await new Promise((resolve) => setImmediate(resolve));
    const handedOff = latest().exceptions.at(-1);
    assert.equal(handedOff.name, 'RangeError', 'the caught error keeps its type');
    assert.equal(handedOff.properties?.http_route, '/api/orders/:id/handoff');
    assert.equal(handedOff.stack.includes('posthog-client.test'), true, 'and its own frames');
    await fetch(`http://127.0.0.1:${port}/api/orders/42/no-handoff`, { method: 'POST' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      latest().exceptions.at(-1)?.name,
      'ApiServerError',
      'a catch that sends a 5xx without the handoff reports no error type',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  // A request whose time is mostly SQL is logged and sent, with the statement normalized.
  const Database = require('better-sqlite3');
  const { instrumentDatabase } = require('../main/services/db-timing');
  const slowDb = new Database(':memory:');
  instrumentDatabase(slowDb);
  const slowApi = express();
  slowApi.use(apiSlowRequestMiddleware);
  const slowQuery = () =>
    // Recursion long enough to pass 200 ms on a fast machine, so the threshold is not the test.
    slowDb
      .prepare(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT COUNT(*) AS total FROM c',
      )
      .get();
  slowApi.get('/api/slow/:id', (_req: unknown, res: any) => {
    slowQuery();
    res.json({ ok: true });
  });
  slowApi.get('/api/slow-consent/:id', (_req: unknown, res: any) => {
    slowQuery();
    res.json({ ok: true });
  });
  const slowServer = slowApi.listen(0, '127.0.0.1');
  await new Promise((resolve) => slowServer.once('listening', resolve));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const eventsBefore = latest().events.length;
    const { port: slowPort } = slowServer.address();
    await fetch(`http://127.0.0.1:${slowPort}/api/slow/7`);
    await new Promise((resolve) => setImmediate(resolve));
    const slowWarnings = warnings.filter((line) => line.startsWith('[API] slow request'));
    assert.equal(slowWarnings.length, 1, 'one warn line for the slow request');
    assert.match(slowWarnings[0], /db=\d+ms/);
    assert.equal(latest().events.length, eventsBefore + 1, 'one api_slow_request is sent');
    const slowEvent = latest().events.at(-1);
    assert.equal(slowEvent?.event, 'api_slow_request');
    assert.equal(slowEvent?.properties?.http_route, '/api/slow/:id');
    assert.ok(Number(slowEvent?.properties?.db_ms) >= 200, 'db_ms carries the SQL time');
    assert.match(String(slowEvent?.properties?.slowest_query), /^WITH RECURSIVE c\(x\)/);
    assert.equal(
      String(slowEvent?.properties?.slowest_query).includes('10000000'),
      false,
      'the statement carries no literal',
    );

    // Telemetry off and then on inside the window: the dropped slow request must not hold the slot.
    const slowConsentEvents = () =>
      latest().events.filter(
        (event) =>
          event.event === 'api_slow_request' &&
          event.properties?.http_route === '/api/slow-consent/:id',
      ).length;
    assert.equal(slowConsentEvents(), 0, 'no slow-request event for that route yet');
    setSetting('telemetry_enabled', 'false');
    syncPostHogIdentity();
    await fetch(`http://127.0.0.1:${slowPort}/api/slow-consent/9`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(slowConsentEvents(), 0, 'a slow request with telemetry off sends nothing');
    setSetting('telemetry_enabled', 'true');
    syncPostHogIdentity();
    await fetch(`http://127.0.0.1:${slowPort}/api/slow-consent/9`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      slowConsentEvents(),
      1,
      'telemetry on inside the window still sends that slow request, once',
    );
    assert.equal(
      latest().events.at(-1)?.properties?.occurrences,
      1,
      'the slow request sent while telemetry was off did not count as suppressed',
    );
  } finally {
    console.warn = originalWarn;
    slowServer.closeAllConnections();
    await new Promise((resolve) => slowServer.close(resolve));
    slowDb.close();
  }

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
