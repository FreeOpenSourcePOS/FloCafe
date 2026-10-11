import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
let telemetryEnabled = true;
let diagnosticsConsent = true;
let transmissionEnabled = true;
let responseBody: Record<string, unknown> | null = null;
let responseStatus = 200;
let sendCount = 0;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getVersion: () => '3.12.22' } };
  if (request.endsWith('/main/db') || request === '../db') {
    return {
      ensureTelemetryAnonId: () => 'anonymous-install-id',
      isTelemetryEnabled: () => telemetryEnabled,
      isDiagnosticsConsentEnabled: () => diagnosticsConsent,
      isDiagnosticsTransmissionEnabled: () => diagnosticsConsent && transmissionEnabled,
      getSettingValue: () => '',
      parseDbTimestamp: (value: string) => new Date(value),
      upsertTelemetryLastPing: () => {},
    };
  }
  if (request === './build-identity')
    return { getBuildIdentity: () => '0123456789abcdef0123456789abcdef01234567' };
  return originalLoad.apply(this, arguments as any);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  sendCount += 1;
  responseBody = JSON.parse(String(init?.body || '{}'));
  return new Response(
    JSON.stringify({
      schema_version: 2,
      report_id: 'a17b9c00-4a29-4b82-9e1a-729fb641e2bb',
      disposition: responseStatus === 422 ? 'rejected' : 'accepted',
    }),
    { status: responseStatus, headers: { 'Content-Type': 'application/json' } },
  );
}) as unknown as typeof fetch;

const { sendAnonymousDiagnosticReport } = require('../main/services/telemetry');

async function main() {
  const window = new Date();
  window.setUTCMinutes(0, 0, 0);
  const utc = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const report = {
    schema_version: 2,
    report_id: 'a17b9c00-4a29-4b82-9e1a-729fb641e2bb',
    reason_code: 'order.quantity_invalid',
    classification: 'expected_rejection',
    operation: 'order.create',
    stage: 'validation',
    outcome: 'not_applied',
    capture_point: 'fc.backend.order.create.quantity_validation',
    count: 2,
    window_start: utc(window),
    first_occurred_at: utc(new Date(window.getTime() + 10 * 60_000)),
    last_occurred_at: utc(new Date(window.getTime() + 15 * 60_000)),
    app_version: '3.12.21',
    app_build: 'fedcba9876543210fedcba9876543210fedcba98',
    platform: 'darwin',
    examples: [{ correlation_id: 'fbd08db0-9502-40a9-9e0a-d490221d9874' }],
    facts: {},
  };

  try {
    assert.equal((await sendAnonymousDiagnosticReport(report)).disposition, 'accepted');
    assert.equal(sendCount, 1);
    const payload = responseBody as any;
    assert.equal(payload.app, 'flocafe');
    assert.equal(payload.event_type, 'diagnostic_counts');
    assert.equal(
      payload.app_version,
      '3.12.22',
      'outer collector metadata identifies the current sender after an upgrade',
    );
    assert.equal(payload.app_build, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(
      payload.payload.report.app_version,
      report.app_version,
      'queued report keeps its immutable capture version',
    );
    assert.equal(
      payload.payload.report.app_build,
      report.app_build,
      'queued report keeps its immutable capture build',
    );
    assert.deepEqual(payload.payload, {
      schema_version: 2,
      report: {
        schema_version: 2,
        report_id: report.report_id,
        reason_code: report.reason_code,
        classification: report.classification,
        operation: report.operation,
        stage: report.stage,
        outcome: report.outcome,
        capture_point: report.capture_point,
        count: report.count,
        window_start: report.window_start,
        first_occurred_at: report.first_occurred_at,
        last_occurred_at: report.last_occurred_at,
        app_version: report.app_version,
        app_build: report.app_build,
        platform: report.platform,
        facts: {},
      },
    });
    assert.equal('country' in payload, false);
    assert.equal('currency' in payload, false);
    assert.equal('store_id' in payload, false);
    assert.equal(JSON.stringify(payload).includes('fbd08db0-9502-40a9-9e0a-d490221d9874'), false);

    responseStatus = 422;
    assert.equal((await sendAnonymousDiagnosticReport(report)).disposition, 'rejected');
    responseStatus = 200;
    responseBody = null;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          schema_version: 2,
          report_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          disposition: 'accepted',
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    assert.equal((await sendAnonymousDiagnosticReport(report)).disposition, 'report_id_mismatch');
    for (const ack of [
      {},
      { schema_version: 2, disposition: 'accepted' },
      { schema_version: 2, report_id: null, disposition: 'accepted' },
      { schema_version: 2, report_id: 7, disposition: 'accepted' },
      { schema_version: 2, report_id: {}, disposition: 'accepted' },
      { schema_version: 2, report_id: report.report_id, disposition: 'accepted', extra: true },
    ]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(ack), { status: 200 })) as unknown as typeof fetch;
      assert.equal(
        (await sendAnonymousDiagnosticReport(report)).disposition,
        'invalid_ack',
        `malformed acknowledgment is rejected: ${JSON.stringify(ack)}`,
      );
    }

    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '3600' },
      })) as unknown as typeof fetch;
    const throttled = await sendAnonymousDiagnosticReport(report);
    assert.equal(throttled.disposition, 'network_error');
    assert.equal(
      throttled.retry_after_ms,
      3_600_000,
      'anonymous delivery honors the collector one-hour Retry-After hint',
    );
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '999999999999' },
      })) as unknown as typeof fetch;
    assert.equal(
      (await sendAnonymousDiagnosticReport(report)).retry_after_ms,
      3_600_000,
      'extreme Retry-After values are bounded at one hour',
    );
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': 'not-a-date' },
      })) as unknown as typeof fetch;
    assert.equal(
      (await sendAnonymousDiagnosticReport(report)).retry_after_ms,
      undefined,
      'malformed Retry-After values are ignored',
    );
    const dateHint = new Date(Date.now() + 5_000).toUTCString();
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': dateHint },
      })) as unknown as typeof fetch;
    const dateRetry = (await sendAnonymousDiagnosticReport(report)).retry_after_ms;
    assert.equal(typeof dateRetry, 'number');
    assert.ok(
      (dateRetry as number) >= 0 && (dateRetry as number) <= 5_000,
      'HTTP-date Retry-After stays within its one-hour bound',
    );

    globalThis.fetch = (async () => {
      throw new Error('must not send');
    }) as unknown as typeof fetch;
    telemetryEnabled = false;
    assert.equal((await sendAnonymousDiagnosticReport(report)).disposition, 'network_error');
    telemetryEnabled = true;
    diagnosticsConsent = false;
    assert.equal((await sendAnonymousDiagnosticReport(report)).disposition, 'network_error');
    diagnosticsConsent = true;
    transmissionEnabled = false;
    assert.equal((await sendAnonymousDiagnosticReport(report)).disposition, 'network_error');
    transmissionEnabled = true;
    assert.equal(
      (await sendAnonymousDiagnosticReport({ ...report, platform: {} })).disposition,
      'invalid_ack',
    );
    assert.equal(
      (await sendAnonymousDiagnosticReport({ ...report, unexpected: 'private' })).disposition,
      'invalid_ack',
    );
  } finally {
    globalThis.fetch = originalFetch;
    Module._load = originalLoad;
  }
  console.log('✅ Anonymous diagnostics delivery checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
