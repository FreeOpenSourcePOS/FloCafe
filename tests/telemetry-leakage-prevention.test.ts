/**
 * Telemetry leakage prevention tests.
 *
 * Proves that:
 * 1. Automated tests, CI runs, and local dev runs cannot transmit anonymous
 *    diagnostics, telemetry pings, or PostHog events to production by default.
 * 2. Packaged official releases, beta builds, and custom builds preserve delivery
 *    support when user consent and transmission settings allow it.
 * 3. An explicit developer flag (FLO_TELEMETRY_DEV=1) permits local testing without
 *    enabling default leakage.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/telemetry-leakage-prevention.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-telemetry-leak-'));

let mockPackaged = true;
let mockVersion = '3.13.0';

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: mockPackaged,
        getPath: () => testDir,
        getVersion: () => mockVersion,
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { isTelemetrySuppressed, sendAnonymousDiagnosticReport, TELEMETRY_URL } = require('../main/services/telemetry');
const { postHogEnvironment } = require('../main/services/posthog-config');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

async function run() {
  console.log('Testing telemetry leakage prevention gates...');

  // Save current environment variables
  const envSnapshot = { ...process.env };

  try {
    // 1. In a standard test environment, test-setup initializes FLO_MATRIX_OFFLINE=1.
    process.env.NODE_ENV = 'test';
    process.env.FLO_MATRIX_OFFLINE = '1';
    delete process.env.FLO_TELEMETRY_DEV;
    mockVersion = '3.13.0';
    mockPackaged = true;

    assertOrThrow(isTelemetrySuppressed(), 'Standard test setup suppresses telemetry transmission');
    assertEqualOrThrow(postHogEnvironment(), null, 'Standard test setup suppresses PostHog connection');

    // 2. Offline matrix environment suppresses transmission regardless of NODE_ENV.
    process.env.NODE_ENV = 'production';
    process.env.FLO_MATRIX_OFFLINE = '1';
    assertOrThrow(isTelemetrySuppressed(), 'FLO_MATRIX_OFFLINE=1 suppresses telemetry');
    assertEqualOrThrow(postHogEnvironment(), null, 'FLO_MATRIX_OFFLINE=1 suppresses PostHog');

    // 3. Test runtime versions suppress transmission even when packaged.
    delete process.env.FLO_MATRIX_OFFLINE;
    mockVersion = 'test';
    assertOrThrow(isTelemetrySuppressed(), 'Version "test" suppresses telemetry');
    assertEqualOrThrow(postHogEnvironment(), null, 'Version "test" suppresses PostHog');

    // 4. E2E ports environment suppresses transmission.
    delete process.env.CI;
    process.env.E2E_TASK_LOCAL_PORTS = '1';
    assertOrThrow(isTelemetrySuppressed(), 'E2E_TASK_LOCAL_PORTS suppresses telemetry');
    assertEqualOrThrow(postHogEnvironment(), null, 'E2E_TASK_LOCAL_PORTS suppresses PostHog');

    // 5. Test version strings suppress transmission even in production mode.
    delete process.env.E2E_TASK_LOCAL_PORTS;
    for (const testVer of ['test', 'e2e', '1.0.0-test', '3.13.0-test.1']) {
      mockVersion = testVer;
      assertOrThrow(isTelemetrySuppressed(), `Version "${testVer}" suppresses telemetry`);
    }

    // 6. Development run (unpackaged / dev build) suppresses transmission by default.
    mockVersion = '3.13.0';
    mockPackaged = false;
    delete process.env.FLO_TELEMETRY_DEV;
    assertOrThrow(isTelemetrySuppressed(), 'Unpackaged dev run suppresses telemetry by default');

    // 7. Development run with FLO_TELEMETRY_DEV=1 allows telemetry.
    process.env.FLO_TELEMETRY_DEV = '1';
    assertOrThrow(!isTelemetrySuppressed(), 'FLO_TELEMETRY_DEV=1 unsuppresses dev telemetry');

    // 8. Packaged release with no test flags allows telemetry.
    delete process.env.FLO_TELEMETRY_DEV;
    mockPackaged = true;
    mockVersion = '3.13.0';
    assertOrThrow(!isTelemetrySuppressed(), 'Clean packaged build allows permitted telemetry');

    // 9. Beta releases allow telemetry when packaged.
    mockVersion = '3.14.0-beta.1';
    assertOrThrow(!isTelemetrySuppressed(), 'Packaged beta release allows permitted telemetry');

    // 10. Fixture version 2.7.2-test suppresses telemetry by default, but allows telemetry when FLO_TELEMETRY_DEV=1.
    mockVersion = '2.7.2-test';
    delete process.env.FLO_TELEMETRY_DEV;
    assertOrThrow(isTelemetrySuppressed(), 'Version "2.7.2-test" suppresses telemetry by default');
    process.env.FLO_TELEMETRY_DEV = '1';
    assertOrThrow(!isTelemetrySuppressed(), 'Version "2.7.2-test" is permitted when FLO_TELEMETRY_DEV=1');

    // 11. Conflicting environment variables: offline/e2e switches take precedence over FLO_TELEMETRY_DEV=1.
    process.env.FLO_MATRIX_OFFLINE = '1';
    assertOrThrow(isTelemetrySuppressed(), 'FLO_MATRIX_OFFLINE=1 takes precedence over FLO_TELEMETRY_DEV=1');
    delete process.env.FLO_MATRIX_OFFLINE;

    process.env.E2E_TASK_LOCAL_PORTS = '1';
    assertOrThrow(isTelemetrySuppressed(), 'E2E_TASK_LOCAL_PORTS takes precedence over FLO_TELEMETRY_DEV=1');
    delete process.env.E2E_TASK_LOCAL_PORTS;

    process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK = '1';
    assertOrThrow(isTelemetrySuppressed(), 'FLO_E2E_SKIP_OPTIONAL_NETWORK takes precedence over FLO_TELEMETRY_DEV=1');
    delete process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK;
    delete process.env.FLO_TELEMETRY_DEV;

    // 10. Proving fetch is never called when telemetry is suppressed.
    process.env.NODE_ENV = 'test';
    process.env.FLO_MATRIX_OFFLINE = '1';
    let fetchCalled = false;
    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string) => {
      fetchCalled = true;
      throw new Error(`Unexpected fetch to ${url}`);
    };

    try {
      const sampleReport = {
        schema_version: 2,
        report_id: 'e9825623-22d4-4221-a75f-5dcf578b42d1',
        reason_code: 'order.quantity_invalid',
        classification: 'expected_rejection',
        operation: 'order.create',
        stage: 'validation',
        outcome: 'not_applied',
        capture_point: 'fc.backend.order.create.quantity_validation',
        count: 1,
        window_start: '2026-10-18T04:00:00Z',
        first_occurred_at: '2026-10-18T04:55:06Z',
        last_occurred_at: '2026-10-18T04:55:06Z',
        app_version: '3.13.0',
        app_build: 'unknown',
        platform: 'darwin',
        facts: {},
      };

      const result = await sendAnonymousDiagnosticReport(sampleReport);
      assertEqualOrThrow(result.disposition, 'network_error', 'suppressed send returns network_error');
      assertEqualOrThrow(fetchCalled, false, 'fetch was never invoked while suppressed');
    } finally {
      global.fetch = originalFetch;
    }

    console.log('✓ All telemetry leakage prevention checks passed!');
  } finally {
    process.env = envSnapshot;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

void run().catch((err) => {
  console.error('Telemetry leakage test failed:', err);
  process.exit(1);
});
