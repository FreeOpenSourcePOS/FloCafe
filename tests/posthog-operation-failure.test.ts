/**
 * A sealed v2 report of operation failures must reach PostHog as `operation_failed` once, with the
 * fields a fix needs (including the report's own release and platform), and only while error
 * sending is on. Correlation ids stay on the machine, and printer failures keep leaving as
 * `printer_failed`.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-posthog-operation-'));

interface RecordedClient {
  options: { before_send?: (event: unknown) => unknown };
  events: Array<{
    event: string;
    properties?: Record<string, unknown>;
    uuid?: string;
    timestamp?: Date;
  }>;
  scrubbed: Array<Record<string, unknown>>;
}

const clients: RecordedClient[] = [];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '1.2.3' } };
  }
  if (request === 'posthog-node') {
    return {
      PostHog: class {
        options: RecordedClient['options'];
        events: RecordedClient['events'] = [];
        scrubbed: RecordedClient['scrubbed'] = [];
        constructor(_token: string, options: RecordedClient['options']) {
          this.options = options;
          clients.push(this);
        }
        capture(payload: RecordedClient['events'][number]) {
          if (payload.uuid !== undefined && !UUID_RE.test(payload.uuid)) {
            throw new Error(`posthog-node rejects a non-UUID event id: ${payload.uuid}`);
          }
          const kept = this.options.before_send?.({
            event: payload.event,
            properties: { ...(payload.properties ?? {}) },
          }) as { properties?: Record<string, unknown> } | null | undefined;
          if (!kept) return;
          this.events.push(payload);
          this.scrubbed.push(kept.properties ?? {});
        }
        captureException() {}
        alias() {}
        async shutdown() {}
      },
    };
  }
  return originalLoad.apply(Module, arguments as never);
};

const { initDatabase, closeDatabase, upsertSettings } = require('../main/db');
const { capturePostHogOperationFailure } = require('../main/services/posthog');
const { scrubPostHogEvent } = require('../shared/posthog-scrub');

function setSetting(key: string, value: string): void {
  upsertSettings({ [key]: value });
}

const report = {
  schema_version: 2,
  report_id: '6f0a4c1e-1a77-4a1e-9a1e-1f5a1b9d2c31',
  reason_code: 'order.stock_insufficient',
  classification: 'expected_rejection',
  operation: 'order.create',
  stage: 'validation',
  outcome: 'not_applied',
  capture_point: 'fc.backend.order.create.stock_validation',
  count: 3,
  window_start: '2026-11-11T10:00:00Z',
  first_occurred_at: '2026-11-11T10:04:12Z',
  last_occurred_at: '2026-11-11T10:41:55Z',
  app_version: '1.1.0-beta.2',
  app_build: '20261111.4',
  platform: 'linux',
  examples: [{ correlation_id: 'op-4711-abcdef' }],
  facts: {
    stock_scope: 'product',
    stock_shortfall: 'partial',
  },
};

function latestEvent() {
  return clients.at(-1)?.scrubbed.at(-1);
}

function captureCount(): number {
  return clients.reduce((total, client) => total + client.events.length, 0);
}

function mainTest(): void {
  try {
    delete process.env.CI;
    process.env.FLO_POSTHOG_DEV = '1';
    Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
    initDatabase();
    setSetting('posthog_host', 'https://us.i.posthog.com');
    setSetting('posthog_project_token', 'phc_test');
    setSetting('product_analytics_level', 'off');
    setSetting('diagnostics_transmission_enabled', 'false');

    capturePostHogOperationFailure(report);
    assert.equal(clients.length, 0, 'no capture without error-sending consent');

    setSetting('product_analytics_level', 'full');
    capturePostHogOperationFailure(report);
    assert.equal(clients.length, 0, 'usage consent alone sends no operation failure');

    setSetting('product_analytics_level', 'off');
    setSetting('diagnostics_transmission_enabled', 'true');
    capturePostHogOperationFailure(report);
    assert.equal(captureCount(), 1, 'one report sends exactly one operation_failed event');
    assert.equal(clients.at(-1)?.events[0]?.event, 'operation_failed');
    const event = latestEvent();
    assert.equal(event?.capture_point, 'fc.backend.order.create.stock_validation');
    assert.equal(event?.reason_code, 'order.stock_insufficient');
    assert.equal(event?.operation, 'order.create');
    assert.equal(event?.stage, 'validation');
    assert.equal(event?.outcome, 'not_applied');
    assert.equal(event?.classification, 'expected_rejection');
    assert.equal(event?.count, 3);
    assert.deepEqual(event?.facts, report.facts, 'the validated facts reach PostHog');
    assert.equal(
      event?.app_version,
      '1.1.0-beta.2',
      'a sealed report from an older release keeps that release version',
    );
    assert.equal(
      event?.release_channel,
      'beta',
      'release_channel follows the sealed report version rather than the running app',
    );
    assert.equal(
      event?.platform,
      'linux',
      'a sealed report keeps the platform recorded on the aggregate',
    );
    assert.equal('correlation_id' in (event ?? {}), false, 'no correlation id in the event');
    assert.equal(JSON.stringify(event).includes('op-4711-abcdef'), false, 'no example ids either');
    assert.equal('report_id' in (event ?? {}), false, 'the report id stays on the machine');
    assert.equal(
      clients.at(-1)?.events.at(-1)?.uuid,
      report.report_id,
      'the report id is the event id, so a resend after a restart is one event',
    );
    assert.equal(
      clients.at(-1)?.events.at(-1)?.timestamp?.toISOString(),
      new Date(report.last_occurred_at).toISOString(),
      'the event carries the last occurrence time of the report',
    );
    assert.equal('window_start' in (event ?? {}), false);

    capturePostHogOperationFailure(report);
    assert.equal(captureCount(), 1, 'a retried report sends nothing again');

    capturePostHogOperationFailure({
      ...report,
      report_id: '6f0a4c1e-1a77-4a1e-9a1e-1f5a1b9d2c32',
      capture_point: 'fc.backend.printer.receipt.queue',
      reason_code: 'printer.queue_failed',
      operation: 'printer.print',
      stage: 'printing',
      facts: { failure_class: 'queue_unavailable' },
    });
    assert.equal(captureCount(), 1, 'a printer capture point is not sent twice');

    const gated = scrubPostHogEvent(
      {
        event: 'operation_failed',
        properties: {
          capture_point: 'fc.backend.order.create.stock_validation',
          reason_code: 'order.stock_insufficient',
          operation: 'order.create',
          stage: 'validation',
          outcome: 'not_applied',
          classification: 'expected_rejection',
          count: 3,
          correlation_id: 'op-4711-abcdef',
          facts: { stock_scope: 'product', customer: 'Ada Lovelace', note: 'table 4, Ana' },
        },
      },
      { telemetryEnabled: false, accountLinked: false, allowExceptions: true },
    );
    assert.ok(gated, 'a valid capture point keeps the event');
    assert.equal('correlation_id' in (gated?.properties ?? {}), false, 'the gate drops the id');
    assert.deepEqual(
      gated?.properties?.facts,
      { stock_scope: 'product' },
      'a fact key or value outside the bounds is dropped',
    );

    const off = scrubPostHogEvent(
      {
        event: 'operation_failed',
        properties: { capture_point: 'fc.backend.order.create.persistence' },
      },
      { telemetryEnabled: true, accountLinked: false, allowExceptions: false },
    );
    assert.equal(off, null, 'error sending off drops the operation event');

    const foreign = scrubPostHogEvent(
      { event: 'operation_failed', properties: { capture_point: 'customers/Ada Lovelace' } },
      { telemetryEnabled: false, accountLinked: false, allowExceptions: true },
    );
    assert.equal(foreign, null, 'a capture point outside the operation ids is dropped');

    console.log('posthog operation failure: all assertions passed');
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

mainTest();
