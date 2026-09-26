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
  assert: assertReports, assertEqual, assertIncludes, assertGreaterThan,
  assertOrThrow, assertEqualOrThrow, assertIncludesOrThrow, assertGreaterThanOrThrow,
  getResults, resetCounters,
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
    ['assertOrThrow', () => assertOrThrow(false, 'deliberate throwing failure'), 'deliberate throwing failure'],
    ['assertEqualOrThrow', () => assertEqualOrThrow(1, 2, 'deliberate throwing failure'), 'expected 2, got 1'],
    ['assertIncludesOrThrow', () => assertIncludesOrThrow('abc', 'z', 'deliberate throwing failure'), 'does not contain'],
    ['assertGreaterThanOrThrow', () => assertGreaterThanOrThrow(1, 2, 'deliberate throwing failure'), 'expected > 2, got 1'],
  ];
  resetCounters();
  for (const [name, fn, detail] of throwingFailures) {
    const error = threw(fn);
    assert.ok(error, `${name} throws on a failing assertion`);
    assert.match(error!.message, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} reports why it failed`);
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

  console.log('  ✓ harness contract verified');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
