import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostic-wire-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.12.22' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, closeDatabase, now } = require('./helpers/test-setup');
const { cloudSync } = require('../main/services/cloud-sync');

function setSetting(db: any, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, now());
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), message);
}

async function main() {
  const priorFetch = globalThis.fetch;
  const priorSignedFetch = (cloudSync as any).signedFetch;
  const priorOffline = process.env.FLO_MATRIX_OFFLINE;
  const db = initTestDb();
  let signedBytes: string | undefined;
  let anonymousBytes: string | undefined;
  try {
    delete process.env.FLO_MATRIX_OFFLINE;
    for (const [key, value] of [
      ['diagnostics_consent', 'true'],
      ['diagnostics_transmission_enabled', 'true'],
      ['diagnostics_consent_remote_initialized', 'true'],
      ['diagnostics_consent_sync_pending', 'false'],
      ['diagnostics_settings_explicit', 'false'],
      ['diagnostics_consent_revision', '1'],
      ['telemetry_enabled', 'false'],
      ['cloud_sync_enabled', '1'],
      ['cloud_api_key', 'synthetic-test-key'],
      ['cloud_server_url', 'https://example.invalid'],
      ['cloud_registration_status', 'registered'],
      ['cloud_services_disabled_by_user', 'false'],
    ]) setSetting(db, key, value);
    db.prepare('DELETE FROM local_diagnostics').run();
    db.prepare('DELETE FROM store_diagnostics_outbox').run();
    db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
    db.prepare('DELETE FROM diagnostics_delivery_gaps').run();

    (cloudSync as any).signedFetch = async (url: string, options: RequestInit = {}) => {
      if (url === '/api/pos/diagnostics-consent') {
        return new Response(JSON.stringify({ schema_version: 2, enabled: true, revision: 1, initialized: true }), { status: 200 });
      }
      assert.equal(url, '/api/pos/diagnostics/v2');
      signedBytes = String(options.body);
      const report = JSON.parse(signedBytes as string);
      return new Response(JSON.stringify({ schema_version: 2, report_id: report.report_id, disposition: 'accepted' }), { status: 200 });
    };

    cloudSync.captureOperationFailure({
      capture_point: 'fc.backend.order.create.stock_validation',
      outcome: 'not_applied',
      correlation_id: 'fbd08db0-9502-40a9-9e0a-d490221d9874',
    });
    await waitFor(() => Boolean(signedBytes), 'the signed aggregate reaches the v2 sender');
    const signed = JSON.parse(signedBytes as string);
    assert.deepEqual(Object.keys(signed).sort(), [
      'app_build', 'app_version', 'capture_point', 'classification', 'count', 'examples', 'facts',
      'first_occurred_at', 'last_occurred_at', 'operation', 'outcome', 'platform', 'reason_code',
      'report_id', 'schema_version', 'stage', 'window_start',
    ].sort());
    assert.equal(signed.schema_version, 2);
    assert.equal(signed.capture_point, 'fc.backend.order.create.stock_validation');
    assert.equal(signed.reason_code, 'order.stock_insufficient');
    assert.equal(signed.operation, 'order.create');
    assert.equal(signed.stage, 'validation');
    assert.equal(signed.classification, 'expected_rejection');
    assert.equal(signed.outcome, 'not_applied');
    assert.equal(signed.count, 1);
    assert.match(signed.window_start, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
    for (const timestamp of [signed.first_occurred_at, signed.last_occurred_at]) {
      assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(Math.floor(Date.parse(timestamp) / 3_600_000), Math.floor(Date.parse(signed.window_start) / 3_600_000));
    }
    assert.deepEqual(signed.examples, [{ correlation_id: 'fbd08db0-9502-40a9-9e0a-d490221d9874' }]);
    assert.deepEqual(signed.facts, {});
    assert.equal((db.prepare('SELECT status FROM store_diagnostics_outbox WHERE event_id = ?').get(signed.report_id) as { status: string }).status, 'delivered');

    setSetting(db, 'cloud_sync_enabled', '0');
    setSetting(db, 'cloud_api_key', '');
    setSetting(db, 'telemetry_enabled', 'true');
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      anonymousBytes = String(init?.body);
      const request = JSON.parse(anonymousBytes);
      const reportId = request.payload.report.report_id;
      return new Response(JSON.stringify({ schema_version: 2, report_id: reportId, disposition: 'accepted' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    cloudSync.captureOperationFailure({
      capture_point: 'fc.backend.order.create.quantity_validation',
      outcome: 'not_applied',
      correlation_id: 'c0931d6d-63f4-45d1-8b04-9cb3314966b7',
    });
    await waitFor(() => Boolean(anonymousBytes), 'the anonymous aggregate reaches the existing collector');
    const anonymous = JSON.parse(anonymousBytes as string);
    assert.equal(anonymous.app, 'flocafe');
    assert.equal(anonymous.event_type, 'diagnostic_counts');
    assert.deepEqual(Object.keys(anonymous).sort(), [
      'anon_id', 'app', 'app_build', 'app_version', 'event_type', 'install_source', 'payload', 'platform', 'run_mode',
    ].sort());
    assert.deepEqual(Object.keys(anonymous.payload).sort(), ['report', 'schema_version']);
    assert.equal(anonymous.payload.schema_version, 2);
    assert.equal(anonymous.payload.report.capture_point, 'fc.backend.order.create.quantity_validation');
    assert.equal(anonymous.payload.report.reason_code, 'order.quantity_invalid');
    assert.equal('examples' in anonymous.payload.report, false);
    assert.equal(JSON.stringify(anonymous).includes('c0931d6d-63f4-45d1-8b04-9cb3314966b7'), false);
    assert.equal('store_id' in anonymous, false);
    assert.equal('country' in anonymous, false);
    assert.equal('currency' in anonymous, false);

    console.log(`SIGNED_DIAGNOSTIC_BYTES=${signedBytes}`);
    console.log(`ANONYMOUS_DIAGNOSTIC_BYTES=${anonymousBytes}`);
    console.log('✅ FC diagnostics wire producer checks passed');
  } finally {
    globalThis.fetch = priorFetch;
    (cloudSync as any).signedFetch = priorSignedFetch;
    if (priorOffline === undefined) delete process.env.FLO_MATRIX_OFFLINE;
    else process.env.FLO_MATRIX_OFFLINE = priorOffline;
    cloudSync.stop();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
