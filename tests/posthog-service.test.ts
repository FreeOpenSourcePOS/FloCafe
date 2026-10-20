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
  const originalSetInterval = globalThis.setInterval;
  let capturedIntervalCallback: (() => void) | null = null;
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
    if (typeof handler === 'function') {
      capturedIntervalCallback = handler as () => void;
    }
    return originalSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;

  const collectorRequests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    collectorRequests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    // Verify FLO_POSTHOG_DEV=1 forwards usage events and checks without collector traffic.
    console.log('Testing PostHog dev opt-in behavior...');

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

    const orderCreatedResult = await sendEvent('order_created', { order_type: 'dine_in' });
    assert.equal(orderCreatedResult, false, 'sendEvent returns false when collector is suppressed');

    await sendEvent('feature_used', { feature: 'split_checks', action: 'enabled' });

    telemetry.start();

    const events = allCapturedEvents();

    assert.equal(
      collectorRequests.length,
      0,
      'FloAdmin collector must receive 0 requests when FLO_TELEMETRY_DEV is unset in dev',
    );

    assert.ok(
      events.length > 0,
      'PostHog received 0 events because telemetry was suppressed in unpackaged dev with FLO_POSTHOG_DEV=1',
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

    // Test the hourly PostHog interval callback
    clearCapturedEvents();
    collectorRequests.length = 0;
    setSetting('posthog_last_daily_ping', '2020-01-01 00:00:00');
    setSetting('posthog_last_daily_ping_at', '2020-01-01 00:00:00');
    assert.ok(capturedIntervalCallback, 'Hourly interval callback should be registered');
    capturedIntervalCallback!();

    assert.ok(
      allCapturedEvents().some((e) => e.event === 'daily_ping'),
      'Hourly interval callback should send daily_ping to PostHog',
    );
    assert.equal(
      collectorRequests.length,
      0,
      'FloAdmin collector must receive 0 requests from hourly interval execution',
    );

    await telemetry.stop();

    // Verify PostHog and collector remain suppressed when any gate is closed.
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
    globalThis.setInterval = originalSetInterval;
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
