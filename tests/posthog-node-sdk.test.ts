/**
 * Exercises `main/services/posthog.ts` against the real `posthog-node` SDK with an intercepted
 * `globalThis.fetch`, ensuring v6 capture-v1 payloads, `beforeSend` scrubbing, options-object
 * `captureException`, and flush-suppressed shutdown work with zero SDK warnings or errors.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-posthog-sdk-'));

Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => '3.14.12',
      },
    };
  }
  return originalLoad.apply(this, arguments as never);
};

interface WireEvent {
  event: string;
  uuid: string;
  distinct_id: string;
  timestamp: string;
  options: Record<string, unknown>;
  properties: Record<string, unknown>;
}

interface RecordedRequest {
  url: string;
  authorization: string | null;
  batch: WireEvent[];
}

const { initDatabase, closeDatabase, upsertSettings, getDatabase, now } = require('../main/db');
const {
  capturePostHogException,
  capturePostHogOperationFailure,
  capturePostHogPrintFailure,
  capturePostHogUsage,
  POSTHOG_SHUTDOWN_TIMEOUT_MS,
  stopPostHog,
  syncPostHogIdentity,
} = require('../main/services/posthog');

function decodeBody(body: BodyInit | null | undefined, encoding: string | null): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return encoding === 'gzip' ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  }
  throw new Error(`Unexpected capture body type: ${typeof body}`);
}

function getHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === lower);
    return match ? match[1] : null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function main(): Promise<void> {
  const priorCi = process.env.CI;
  const priorNodeEnv = process.env.NODE_ENV;
  const priorMatrixOffline = process.env.FLO_MATRIX_OFFLINE;
  const priorE2ePorts = process.env.E2E_TASK_LOCAL_PORTS;
  const priorSkipNetwork = process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK;
  const priorPostHogDev = process.env.FLO_POSTHOG_DEV;
  const priorProcessType = (process as NodeJS.Process & { type?: string }).type;
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;

  const sdkLogs: string[] = [];
  const captureLog =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.includes('[PostHog]')) sdkLogs.push(line);
      original(...args);
    };
  console.error = captureLog(originalError);
  console.warn = captureLog(originalWarn);

  const requests: RecordedRequest[] = [];
  let fetchMode: 'ok' | 'hold' | 'retry503' = 'ok';
  let holdStarted: (() => void) | null = null;
  let holdAborted = false;
  let retryFirstAttemptSeen: (() => void) | null = null;
  let retryFetchCount = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.ok(
      url.startsWith('https://posthog.example/'),
      `unexpected outbound fetch URL during test: ${url}`,
    );

    if (fetchMode === 'hold') {
      holdStarted?.();
      await new Promise<void>((resolve) => {
        if (init?.signal?.aborted) {
          holdAborted = true;
          resolve();
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => {
            holdAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (fetchMode === 'retry503') {
      retryFetchCount += 1;
      retryFirstAttemptSeen?.();
      retryFirstAttemptSeen = null;
      return new Response('temporarily unavailable', {
        status: 503,
        headers: { 'Retry-After': '30' },
      });
    }

    const encoding = getHeader(init?.headers, 'Content-Encoding');
    const decoded = decodeBody(init?.body, encoding);
    const parsed = JSON.parse(decoded) as { batch: WireEvent[] };
    requests.push({
      url,
      authorization: getHeader(init?.headers, 'Authorization'),
      batch: parsed.batch,
    });
    return new Response(JSON.stringify({ results: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    delete process.env.CI;
    delete process.env.NODE_ENV;
    delete process.env.FLO_MATRIX_OFFLINE;
    delete process.env.E2E_TASK_LOCAL_PORTS;
    delete process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK;
    process.env.FLO_POSTHOG_DEV = '1';
    Object.defineProperty(process, 'type', { value: 'browser', configurable: true });

    initDatabase();
    const ts = now();
    getDatabase()
      .prepare(
        `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
         VALUES ('owner-1', 'Owner One', 'owner@example.com', 'hashed', 'owner', 1, ?, ?)`,
      )
      .run(ts, ts);

    upsertSettings({
      posthog_host: 'https://posthog.example',
      posthog_project_token: 'phc_sdk_test',
      telemetry_enabled: 'true',
      product_analytics_level: 'full',
      diagnostics_consent: 'true',
      diagnostics_transmission_enabled: 'true',
      service_model: 'qsr',
    });

    const allEvents = (): WireEvent[] => requests.flatMap((req) => req.batch);

    // 1. Full sharing level: alias + identify + scrubbed usage event over capture v1.
    syncPostHogIdentity();
    capturePostHogUsage('feature_used', {
      feature: 'split_checks',
      action: 'enabled',
      customer_name: 'Ada Lovelace',
    });
    await waitFor(
      () =>
        allEvents().some((e) => e.event === '$create_alias') &&
        allEvents().some((e) => e.event === '$identify') &&
        allEvents().some((e) => e.event === 'feature_used'),
      'full-level events flushed',
    );

    assert.ok(
      requests.every((req) => req.url === 'https://posthog.example/i/v1/analytics/events'),
      'real SDK sends to capture v1 analytics endpoint',
    );
    assert.ok(
      requests.every((req) => req.authorization === 'Bearer phc_sdk_test'),
      'real SDK authenticates via Bearer project token',
    );

    const aliasEvent = allEvents().find((e) => e.event === '$create_alias');
    assert.ok(aliasEvent, '$create_alias sent');
    assert.equal(aliasEvent.options.process_person_profile, true);
    assert.match(String(aliasEvent.properties.distinct_id), /^acct_[0-9a-f]{16}$/);
    assert.match(String(aliasEvent.properties.alias), /^inst_[0-9a-f]{16}$/);

    const identifyEvent = allEvents().find((e) => e.event === '$identify');
    assert.ok(identifyEvent, '$identify sent');
    assert.equal(identifyEvent.options.process_person_profile, true);
    const personSet = identifyEvent.properties.$set as Record<string, unknown>;
    assert.equal(personSet.email, 'owner@example.com');
    assert.equal(personSet.service_model, 'qsr');
    assert.equal('name' in personSet, false);

    const usageEvent = allEvents().find((e) => e.event === 'feature_used');
    assert.ok(usageEvent, 'feature_used sent');
    assert.equal(usageEvent.properties.feature, 'split_checks');
    assert.equal(usageEvent.properties.action, 'enabled');
    assert.equal('customer_name' in usageEvent.properties, false, 'beforeSend strips unlisted PII');
    assert.equal(usageEvent.properties.$lib, 'posthog-node');
    assert.equal('$is_server' in usageEvent.properties, false, 'isServer: false omits $is_server');
    assert.equal(
      '$geoip_disable' in usageEvent.properties,
      false,
      'disableGeoip: false enables GeoIP',
    );

    // 2. Telemetry off + diagnostics on: personless exception, printer failure, operation failure.
    upsertSettings({ telemetry_enabled: 'false', product_analytics_level: 'off' });
    const countBeforeDiagnostics = allEvents().length;

    capturePostHogException('uncaughtException', new Error('order 55123 for customer "Ada"'));
    capturePostHogPrintFailure({
      kind: 'receipt',
      connection_type: 'network',
      failure_class: 'offline',
      correlation_id: 'print-4711-abcdef',
      detail: 'lp: Error - unable to access "EPSON_TM-T20III" - offline',
      printer_name: 'EPSON_TM-T20III',
    });
    const reportId = '6f0a4c1e-1a77-4a1e-9a1e-1f5a1b9d2c31';
    const occurredAt = '2026-11-11T10:41:55.000Z';
    capturePostHogOperationFailure({
      schema_version: 2,
      report_id: reportId,
      reason_code: 'order.stock_insufficient',
      classification: 'expected_rejection',
      operation: 'order.create',
      stage: 'validation',
      outcome: 'not_applied',
      capture_point: 'fc.backend.order.create.stock_validation',
      count: 2,
      last_occurred_at: occurredAt,
      app_version: '3.14.12',
      platform: 'darwin',
      facts: { stock_scope: 'product' },
    });

    await waitFor(
      () => allEvents().length >= countBeforeDiagnostics + 3,
      'personless diagnostic events flushed',
    );

    const exceptionEvent = allEvents().find((e) => e.event === '$exception');
    assert.ok(exceptionEvent, '$exception sent via options-object captureException');
    assert.match(exceptionEvent.distinct_id, /^anon_/);
    assert.equal(
      exceptionEvent.options.process_person_profile,
      false,
      '$exception sets capture-v1 process_person_profile: false',
    );
    assert.equal(
      exceptionEvent.properties.$exception_message,
      'order <n> for customer "<redacted>"',
    );
    assert.equal(exceptionEvent.properties.capture_point, 'uncaughtException');
    assert.equal('install_ref' in exceptionEvent.properties, false);
    assert.equal('store_ref' in exceptionEvent.properties, false);
    const exceptionList = exceptionEvent.properties.$exception_list as Array<{
      stacktrace?: { frames?: Array<{ platform?: string }> };
    }>;
    assert.ok(exceptionList.length > 0);
    for (const frame of exceptionList[0].stacktrace?.frames ?? []) {
      assert.equal(frame.platform, 'node:javascript');
    }

    const printerEvent = allEvents().find((e) => e.event === 'printer_failed');
    assert.ok(printerEvent, 'printer_failed sent');
    assert.equal(printerEvent.options.process_person_profile, false);
    assert.equal(String(printerEvent.properties.error_text).includes('EPSON'), false);

    const operationEvent = allEvents().find((e) => e.event === 'operation_failed');
    assert.ok(operationEvent, 'operation_failed sent');
    assert.equal(operationEvent.options.process_person_profile, false);
    assert.equal(operationEvent.uuid, reportId, 'operation_failed preserves report_id as uuid');
    assert.equal(
      operationEvent.timestamp,
      occurredAt,
      'operation_failed preserves last_occurred_at as RFC 3339 timestamp',
    );

    await stopPostHog();

    // 3. Flush-suppressed shutdown aborts an in-flight capture cleanly without HTTP 204 warnings.
    upsertSettings({ telemetry_enabled: 'true', product_analytics_level: 'anonymous' });
    fetchMode = 'hold';
    holdAborted = false;
    const inFlightStarted = new Promise<void>((resolve) => {
      holdStarted = resolve;
    });
    capturePostHogUsage('app_launch');
    await inFlightStarted;
    await stopPostHog({ flush: false });
    assert.equal(holdAborted, true, 'stopPostHog({ flush: false }) aborts in-flight fetch');

    // 4. Flush-suppressed shutdown during a long Retry-After backoff resolves immediately without retries.
    fetchMode = 'retry503';
    retryFetchCount = 0;
    const retryStarted = new Promise<void>((resolve) => {
      retryFirstAttemptSeen = resolve;
    });
    capturePostHogUsage('app_launch');
    await retryStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stopStartedAt = Date.now();
    await stopPostHog({ flush: false });
    const stopElapsedMs = Date.now() - stopStartedAt;
    assert.ok(
      stopElapsedMs < POSTHOG_SHUTDOWN_TIMEOUT_MS / 2,
      `stopPostHog({ flush: false }) during retry backoff should not wait on backoff (${stopElapsedMs}ms)`,
    );
    assert.equal(retryFetchCount, 1, 'no retry request fires after stopPostHog({ flush: false })');

    assert.deepEqual(
      sdkLogs,
      [],
      `real posthog-node SDK must emit zero warnings or deprecation errors, got: ${sdkLogs.join(' | ')}`,
    );

    console.log('posthog-node SDK integration: all assertions passed');
  } finally {
    await stopPostHog({ flush: false });
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
    if (priorCi === undefined) delete process.env.CI;
    else process.env.CI = priorCi;
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorMatrixOffline === undefined) delete process.env.FLO_MATRIX_OFFLINE;
    else process.env.FLO_MATRIX_OFFLINE = priorMatrixOffline;
    if (priorE2ePorts === undefined) delete process.env.E2E_TASK_LOCAL_PORTS;
    else process.env.E2E_TASK_LOCAL_PORTS = priorE2ePorts;
    if (priorSkipNetwork === undefined) delete process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK;
    else process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK = priorSkipNetwork;
    if (priorPostHogDev === undefined) delete process.env.FLO_POSTHOG_DEV;
    else process.env.FLO_POSTHOG_DEV = priorPostHogDev;
    if (priorProcessType === undefined) {
      delete (process as NodeJS.Process & { type?: string }).type;
    } else {
      Object.defineProperty(process, 'type', { value: priorProcessType, configurable: true });
    }
    try {
      closeDatabase();
    } catch {}
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
