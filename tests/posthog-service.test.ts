import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-posthog-service-'));
process.env.FLO_E2E_DB_PATH = path.join(testDir, 'flo.db');

interface CapturedEvent {
  distinctId?: string;
  event?: string;
  properties?: Record<string, unknown>;
}

interface RecordedClient {
  token: string;
  options: {
    host?: string;
  };
  events: CapturedEvent[];
  shutdowns: number;
}

const clients: RecordedClient[] = [];

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false, // Unpackaged development environment
        getPath: () => testDir,
        getVersion: () => '2.7.2-dev',
      },
    };
  }
  if (request === 'posthog-node') {
    return {
      PostHog: class {
        token: string;
        options: RecordedClient['options'];
        events: CapturedEvent[] = [];
        shutdowns = 0;
        constructor(token: string, options: RecordedClient['options']) {
          this.token = token;
          this.options = options;
          clients.push(this);
        }
        capture(payload: CapturedEvent) {
          this.events.push(payload);
        }
        captureException() {}
        alias() {}
        async shutdown() {
          this.shutdowns += 1;
        }
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

Object.defineProperty(process, 'type', { value: 'browser', configurable: true });

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { telemetry, sendEvent, TELEMETRY_URL } = require('../main/services/telemetry');

function setSetting(key: string, value: string) {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now());
}

function allCapturedEvents(): CapturedEvent[] {
  return clients.flatMap((c) => c.events);
}

function clearCapturedEvents(): void {
  for (const c of clients) {
    c.events.length = 0;
  }
}

async function main() {
  initDatabase();

  const originalFetch = globalThis.fetch;
  const collectorRequests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    collectorRequests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    // ------------------------------------------------------------------
    // F7 Reproduction Case:
    // In an unpackaged dev environment (NODE_ENV=development, FLO_POSTHOG_DEV=1,
    // FLO_TELEMETRY_DEV unset, FLO_OFFLINE_MATRIX unset, CI unset,
    // E2E_TASK_LOCAL_PORTS unset, FLO_E2E_SKIP_OPTIONAL_NETWORK unset)
    // with telemetry consent enabled (telemetry_enabled = 'true'):
    //
    // Call telemetry.sendEvent('order_created', { order_type: 'dine_in' })
    // and telemetry.start().
    //
    // On unfixed main, matrixOffline() (isTelemetrySuppressed()) is true
    // because FLO_TELEMETRY_DEV is unset, causing sendEvent(),
    // runPostHogDailyChecks(), and telemetry.start() to return early
    // before calling mirrorToPostHog or running PostHog daily checks.
    // ------------------------------------------------------------------
    console.log('Testing PostHog dev opt-in defect F7...');

    process.env.NODE_ENV = 'development';
    process.env.FLO_POSTHOG_DEV = '1';
    process.env.FLO_POSTHOG_DEV_TOKEN = 'phc_dev_test';
    delete process.env.FLO_TELEMETRY_DEV;
    delete process.env.FLO_MATRIX_OFFLINE;
    delete process.env.FLO_OFFLINE_MATRIX;
    delete process.env.CI;
    delete process.env.E2E_TASK_LOCAL_PORTS;
    delete process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK;

    setSetting('telemetry_enabled', 'true');
    setSetting('product_analytics_level', 'anonymous');

    collectorRequests.length = 0;
    clearCapturedEvents();

    // 1. sendEvent with an unmirrored event (order_created)
    const orderCreatedResult = await sendEvent('order_created', { order_type: 'dine_in' });
    assert.equal(orderCreatedResult, false, 'sendEvent returns false when collector is suppressed');

    // 2. sendEvent with a mirrored usage event (feature_used)
    await sendEvent('feature_used', { feature: 'split_checks', action: 'enabled' });

    // 3. telemetry.start() should mirror app_launch and run PostHog daily checks
    telemetry.start();

    const events = allCapturedEvents();

    // Verify anonymous FloAdmin collector was NOT contacted
    assert.equal(
      collectorRequests.length,
      0,
      'FloAdmin collector must receive 0 requests when FLO_TELEMETRY_DEV is unset in dev',
    );

    // Verify PostHog received the events
    assert.ok(
      events.length > 0,
      'F7 defect: PostHog received 0 events because matrixOffline() suppressed telemetry in unpackaged dev with FLO_POSTHOG_DEV=1',
    );
    assert.ok(
      events.some((e) => e.event === 'feature_used'),
      'PostHog should receive mirrored feature_used event',
    );
    assert.ok(
      events.some((e) => e.event === 'app_launch'),
      'PostHog should receive app_launch event from telemetry.start()',
    );
    assert.ok(
      events.some((e) => e.event === 'daily_ping'),
      'PostHog should receive daily_ping event from runPostHogDailyChecks()',
    );

    await telemetry.stop();

    // ------------------------------------------------------------------
    // Suppression Gates:
    // Verify that PostHog and collector remain completely suppressed when
    // any gate is closed.
    // ------------------------------------------------------------------
    console.log('Testing suppression gates...');

    // Gate 1: telemetry consent disabled
    setSetting('telemetry_enabled', 'false');
    collectorRequests.length = 0;
    clearCapturedEvents();
    telemetry.start();
    await sendEvent('feature_used', { feature: 'split_checks' });
    await telemetry.stop();
    assert.equal(allCapturedEvents().length, 0, 'No PostHog events when telemetry is disabled');
    assert.equal(collectorRequests.length, 0, 'No collector requests when telemetry is disabled');

    // Gate 2: FLO_MATRIX_OFFLINE=1
    setSetting('telemetry_enabled', 'true');
    process.env.FLO_MATRIX_OFFLINE = '1';
    collectorRequests.length = 0;
    clearCapturedEvents();
    telemetry.start();
    await sendEvent('feature_used', { feature: 'split_checks' });
    await telemetry.stop();
    assert.equal(allCapturedEvents().length, 0, 'No PostHog events under FLO_MATRIX_OFFLINE');
    assert.equal(collectorRequests.length, 0, 'No collector requests under FLO_MATRIX_OFFLINE');
    delete process.env.FLO_MATRIX_OFFLINE;

    // Gate 3: CI=true
    process.env.CI = 'true';
    collectorRequests.length = 0;
    clearCapturedEvents();
    telemetry.start();
    await sendEvent('feature_used', { feature: 'split_checks' });
    await telemetry.stop();
    assert.equal(allCapturedEvents().length, 0, 'No PostHog events under CI');
    assert.equal(collectorRequests.length, 0, 'No collector requests under CI');
    delete process.env.CI;

    // Gate 4: NODE_ENV=test
    process.env.NODE_ENV = 'test';
    collectorRequests.length = 0;
    clearCapturedEvents();
    telemetry.start();
    await sendEvent('feature_used', { feature: 'split_checks' });
    await telemetry.stop();
    assert.equal(allCapturedEvents().length, 0, 'No PostHog events under NODE_ENV=test');
    assert.equal(collectorRequests.length, 0, 'No collector requests under NODE_ENV=test');
    process.env.NODE_ENV = 'development';

    // Gate 5: FLO_POSTHOG_DEV unset in unpackaged dev
    delete process.env.FLO_POSTHOG_DEV;
    collectorRequests.length = 0;
    clearCapturedEvents();
    telemetry.start();
    await sendEvent('feature_used', { feature: 'split_checks' });
    await telemetry.stop();
    assert.equal(allCapturedEvents().length, 0, 'No PostHog events when FLO_POSTHOG_DEV is unset');
    assert.equal(
      collectorRequests.length,
      0,
      'No collector requests when FLO_POSTHOG_DEV is unset',
    );

    console.log('✅ PostHog dev opt-in and suppression checks passed');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FLO_POSTHOG_DEV;
    delete process.env.FLO_POSTHOG_DEV_TOKEN;
    delete process.env.FLO_E2E_DB_PATH;
    try {
      closeDatabase();
    } catch {}
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
