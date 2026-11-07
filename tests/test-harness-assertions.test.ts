/**
 * Regression test for the test harness itself.
 *
 * The shared assertion helpers used to only print and count, so a suite that
 * never read getResults() exited 0 with failing assertions. This test pins the
 * contract both halves of the fix depend on:
 *   1. the counting variants still report without throwing (the ~72 suites that
 *      aggregate failures through getResults() must keep working), and
 *   2. the `*OrThrow` variants abort a suite, proven end to end by spawning a
 *      deliberately failing fixture and requiring a non-zero exit.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/test-harness-assertions.test.ts
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Nothing here touches the database; stub the module so this test is
  // independent of the better-sqlite3 native ABI.
  if (request.endsWith('/main/db')) {
    return {
      initDatabase() {},
      getDatabase() {},
      closeDatabase() {},
      now: () => '1970-01-01T00:00:00.000Z',
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  assert: assertReports,
  assertEqual,
  assertIncludes,
  assertGreaterThan,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  assertGreaterThanOrThrow,
  api,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');

function threw(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error as Error;
  }
}

async function run() {
  console.log('Test harness assertion contract');

  // ── Counting variants report, never throw ──────────────────────────────────
  const countingFailures: Array<[string, () => void]> = [
    ['assert', () => assertReports(false, 'deliberate counting failure')],
    ['assertEqual', () => assertEqual(1, 2, 'deliberate counting failure')],
    ['assertIncludes', () => assertIncludes('abc', 'z', 'deliberate counting failure')],
    ['assertGreaterThan', () => assertGreaterThan(1, 2, 'deliberate counting failure')],
  ];
  resetCounters();
  for (const [name, fn] of countingFailures) {
    const error = threw(fn);
    assert.equal(error, null, `${name} reports a failure without throwing`);
  }
  assert.deepEqual(
    getResults(),
    { passed: 0, failed: countingFailures.length, total: countingFailures.length },
    'counting variants still record every assertion in getResults()',
  );

  // ── Throwing variants record the failure and abort ─────────────────────────
  const throwingFailures: Array<[string, () => void, string]> = [
    [
      'assertOrThrow',
      () => assertOrThrow(false, 'deliberate throwing failure'),
      'deliberate throwing failure',
    ],
    [
      'assertEqualOrThrow',
      () => assertEqualOrThrow(1, 2, 'deliberate throwing failure'),
      'expected 2, got 1',
    ],
    [
      'assertIncludesOrThrow',
      () => assertIncludesOrThrow('abc', 'z', 'deliberate throwing failure'),
      'does not contain',
    ],
    [
      'assertGreaterThanOrThrow',
      () => assertGreaterThanOrThrow(1, 2, 'deliberate throwing failure'),
      'expected > 2, got 1',
    ],
  ];
  resetCounters();
  for (const [name, fn, detail] of throwingFailures) {
    const error = threw(fn);
    assert.ok(error, `${name} throws on a failing assertion`);
    assert.match(
      error!.message,
      new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${name} reports why it failed`,
    );
  }
  assert.deepEqual(
    getResults(),
    { passed: 0, failed: throwingFailures.length, total: throwingFailures.length },
    'throwing variants keep the failure counters accurate for callers that catch',
  );

  // ── A failing suite exits non-zero ─────────────────────────────────────────
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('ts-node/dist/bin.js'),
      '--transpile-only',
      '-P',
      'tests/tsconfig.json',
      'tests/fixtures/failing-assertion-suite.ts',
    ],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
  );
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  assert.notEqual(result.status, 0, 'a suite whose assertion fails must exit non-zero');
  assert.ok(
    stdout.includes('REACHED_AFTER_COUNTING'),
    'the counting assertions ran first, so they do not throw',
  );
  assert.ok(
    !stdout.includes('UNREACHABLE_AFTER_THROWING_ASSERT'),
    'execution stops at the failing assertion',
  );
  assert.ok(
    `${stdout}${stderr}`.includes('THROWING_ASSERT_DID_NOT_THROW'),
    'the failure is reported with its message before the process dies',
  );

  // ── api() closes loopback connections and retries transient ECONNRESET ─────
  const savedFetch = globalThis.fetch;
  try {
    let attempts = 0;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_input: any, init?: any) => {
      attempts += 1;
      capturedHeaders = init?.headers;
      if (attempts === 1) {
        const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw new TypeError('fetch failed', { cause });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const recovered = await api('http://127.0.0.1:39999', '/api/settings/offline-mode', {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(attempts, 2, 'api() retries once after a transient ECONNRESET fetch error');
    assert.equal(recovered.status, 200, 'api() returns the retried response status');
    assert.deepEqual(recovered.data, { ok: true }, 'api() returns the retried response body');
    assert.equal(
      capturedHeaders?.Connection,
      'close',
      'api() sends Connection: close by default to avoid stale loopback keep-alive sockets',
    );
    assert.equal(
      capturedHeaders?.Authorization,
      'Bearer test-token',
      'api() preserves caller headers alongside default headers',
    );

    let persistentResetAttempts = 0;
    globalThis.fetch = (async () => {
      persistentResetAttempts += 1;
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw new TypeError('fetch failed', { cause });
    }) as typeof fetch;
    await assert.rejects(
      () => api('http://127.0.0.1:39999', '/api/settings/offline-mode'),
      /fetch failed/,
      'api() rethrows if the retry also fails with ECONNRESET',
    );
    assert.equal(persistentResetAttempts, 2, 'api() stops after one retry');

    let nonResetAttempts = 0;
    globalThis.fetch = (async () => {
      nonResetAttempts += 1;
      const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      throw new TypeError('fetch failed', { cause });
    }) as typeof fetch;
    await assert.rejects(
      () => api('http://127.0.0.1:39999', '/api/settings/offline-mode'),
      /fetch failed/,
      'api() does not mask non-ECONNRESET failures',
    );
    assert.equal(nonResetAttempts, 1, 'api() does not retry non-ECONNRESET errors');

    let postResetAttempts = 0;
    globalThis.fetch = (async () => {
      postResetAttempts += 1;
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw new TypeError('fetch failed', { cause });
    }) as typeof fetch;
    await assert.rejects(
      () =>
        api('http://127.0.0.1:39999', '/api/addon-groups', {
          method: 'POST',
          body: { name: 'Toppings' },
        }),
      /fetch failed/,
      'api() does not automatically retry non-idempotent POST requests on ECONNRESET',
    );
    assert.equal(postResetAttempts, 1, 'POST requests fail without automatic retry on ECONNRESET');

    let putOptInAttempts = 0;
    globalThis.fetch = (async () => {
      putOptInAttempts += 1;
      if (putOptInAttempts === 1) {
        const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw new TypeError('fetch failed', { cause });
      }
      return new Response(JSON.stringify({ offline_mode: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const optedInWrite = await api('http://127.0.0.1:39999', '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: true },
      retryOnReset: true,
    });
    assert.equal(putOptInAttempts, 2, 'api() retries opted-in write requests once on ECONNRESET');
    assert.equal(
      optedInWrite.status,
      200,
      'opted-in write retry returns the second attempt status',
    );
  } finally {
    globalThis.fetch = savedFetch;
  }

  console.log('  ✓ harness contract verified');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
