/**
 * A print failure must reach PostHog as `printer_failed`, with the fields a fix needs, and only
 * while error sending is on. The spec asks for make and model, but nothing upstream of the failure
 * report knows them, so the event carries none and this suite pins that.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-posthog-printer-'));

interface RecordedClient {
  options: { before_send?: (event: unknown) => unknown };
  events: Array<{ event: string; properties?: Record<string, unknown> }>;
  scrubbed: Array<Record<string, unknown>>;
}

const clients: RecordedClient[] = [];

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

const { initDatabase, upsertSettings } = require('../main/db');
const { capturePostHogPrintFailure } = require('../main/services/posthog');
const { scrubPostHogEvent } = require('../shared/posthog-scrub');

// The app's own write path, so the cached consent sees each change.
function setSetting(key: string, value: string): void {
  upsertSettings({ [key]: value });
}

const failure = {
  kind: 'receipt',
  connection_type: 'network',
  failure_class: 'queue_unavailable',
  correlation_id: 'print-4711-abcdef',
  detail: 'lp: The printer or class does not exist.',
};

function latestEvent() {
  return clients.at(-1)?.scrubbed.at(-1);
}

async function mainTest(): Promise<void> {
  delete process.env.CI;
  process.env.FLO_POSTHOG_DEV = '1';
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
  initDatabase();
  setSetting('posthog_host', 'https://us.i.posthog.com');
  setSetting('posthog_project_token', 'phc_test');
  // Usage stays off, so only the diagnostics consent can let this event out.
  setSetting('product_analytics_level', 'off');
  setSetting('diagnostics_transmission_enabled', 'false');

  capturePostHogPrintFailure(failure);
  assert.equal(clients.length, 0, 'no capture without error-sending consent');

  // Usage consent alone must not let a print failure out.
  setSetting('product_analytics_level', 'full');
  setSetting('diagnostics_transmission_enabled', 'false');
  capturePostHogPrintFailure(failure);
  assert.equal(clients.length, 0, 'usage consent alone sends no print failure');

  setSetting('product_analytics_level', 'off');
  setSetting('diagnostics_transmission_enabled', 'true');
  capturePostHogPrintFailure(failure);
  const event = latestEvent();
  assert.ok(event, 'the printer event is sent');
  assert.equal(latestEvent() && clients.at(-1)?.events.length, 1);
  assert.equal(event?.capture_point, 'printer');
  assert.equal(event?.failure_class, 'queue_unavailable');
  assert.equal(event?.connection_type, 'network');
  assert.equal(event?.kind, 'receipt');
  assert.equal(event?.correlation_id, failure.correlation_id);
  assert.equal(typeof event?.install_source, 'string');
  assert.equal(typeof event?.app_version, 'string');
  assert.equal(typeof event?.platform, 'string');
  assert.equal(typeof event?.$os, 'string');
  assert.equal(typeof event?.$os_version, 'string');
  assert.equal(event?.process_type, 'main');
  assert.equal(typeof event?.error_text, 'string', 'the error text reaches PostHog');
  assert.ok(String(event?.error_text).length > 0);
  assert.equal('printer_make_model' in (event ?? {}), false, 'make and model are not known here');

  // The queue the till prints to never leaves the machine, in the text or on its own.
  capturePostHogPrintFailure({
    kind: 'kot',
    connection_type: 'usb',
    failure_class: 'not_configured',
    correlation_id: 'print-4711-abcdef',
    detail: 'lp: Error - unable to access "EPSON_TM-T20III" - No such file or directory',
    printer_name: 'EPSON_TM-T20III',
  });
  const queued = latestEvent();
  assert.equal(String(queued?.error_text).includes('EPSON'), false, 'the queue name is scrubbed');
  assert.equal(JSON.stringify(queued).includes('EPSON'), false, 'no property carries the queue');
  assert.ok(String(queued?.error_text).includes('No such file or directory'), 'the reason stays');

  // The gate itself scrubs the text, whatever the caller passed.
  const gated = scrubPostHogEvent(
    {
      event: 'printer_failed',
      properties: {
        capture_point: 'printer',
        error_text: 'Error: connect ECONNREFUSED 192.168.1.50:9100 at /var/spool/cups/d00471-001',
      },
    },
    { telemetryEnabled: false, accountLinked: false, allowExceptions: true },
  );
  const gatedText = String(gated?.properties?.error_text);
  assert.ok(gatedText.includes('ECONNREFUSED'), 'the reason stays');
  assert.equal(gatedText.includes('192.168'), false, 'the gate drops the host address');
  assert.equal(gatedText.includes('spool'), false, 'the gate drops the spool path');

  // The queue diagnostics ride on the failure event, as closed sets only.
  capturePostHogPrintFailure({
    ...failure,
    diagnostics: {
      port_kind: 'tcp_raw',
      queue_refusal: 'offline',
      failure_step: 'pre_spool',
      bypass: 'failed',
      snmp_enabled: 'yes',
      win32_error: 1801,
    },
  });
  const diagnosed = latestEvent();
  assert.equal(diagnosed?.port_kind, 'tcp_raw', 'the port kind reaches PostHog');
  assert.equal(diagnosed?.win32_error, 1801, 'the Win32 error reaches PostHog');
  assert.equal(diagnosed?.bypass, 'failed', 'the bypass outcome reaches PostHog');

  // A print the bypass saved is one event, under the same consent.
  const { capturePostHogPrintRecovered } = require('../main/services/posthog');
  const saved = {
    kind: 'receipt',
    transport: 'direct_tcp_fallback' as const,
    detail: 'Exception calling "SendRaw" with "2" argument(s): "printer is offline"',
    queuePort: { kind: 'tcp_raw' },
  };
  capturePostHogPrintRecovered(saved);
  const recovered = latestEvent();
  assert.equal(clients.at(-1)?.events.at(-1)?.event, 'printer_recovered');
  assert.equal(recovered?.capture_point, 'printer');
  assert.equal(recovered?.via, 'direct_tcp');
  assert.equal(recovered?.port_kind, 'tcp_raw');
  assert.equal(recovered?.queue_refusal, 'offline');
  const before = clients.at(-1)?.events.length;
  capturePostHogPrintRecovered({ ...saved, transport: undefined });
  assert.equal(clients.at(-1)?.events.length, before, 'a plain success sends no recovery event');
  setSetting('diagnostics_transmission_enabled', 'false');
  capturePostHogPrintRecovered(saved);
  assert.equal(clients.at(-1)?.events.length, before, 'no consent, no recovery event');
  setSetting('diagnostics_transmission_enabled', 'true');

  // Unknown values and a foreign event name never pass the allowlist.
  const dropped = scrubPostHogEvent(
    { event: 'printer_failed', properties: { capture_point: 'printer', kind: 'whatever' } },
    { telemetryEnabled: true, accountLinked: false, allowExceptions: false },
  );
  assert.equal(dropped, null, 'error sending off drops the printer event');
  const unknownKind = scrubPostHogEvent(
    {
      event: 'printer_failed',
      properties: { capture_point: 'printer', kind: 'customer Ada', failure_class: 'nope' },
    },
    { telemetryEnabled: false, accountLinked: false, allowExceptions: true },
  );
  assert.ok(unknownKind, 'a valid capture point keeps the event');
  assert.equal('kind' in (unknownKind?.properties ?? {}), false, 'an unknown kind is dropped');
  assert.equal(
    'failure_class' in (unknownKind?.properties ?? {}),
    false,
    'an unknown failure class is dropped',
  );

  console.log('posthog printer failure: all assertions passed');
}

mainTest().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
