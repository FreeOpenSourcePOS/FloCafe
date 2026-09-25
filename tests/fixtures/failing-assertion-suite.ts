/**
 * Deliberately failing suite, spawned as a child process by
 * tests/test-harness-assertions.test.ts.
 *
 * It must exit non-zero: that is the regression this fixture exists to prove.
 * The counting assertions run first and must NOT throw - a suite that migrates
 * one of them onto a throwing variant without wiring getResults() would abort
 * here instead of reporting, and every "tests protect X" claim downstream
 * would be false again.
 */

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // The assertion helpers never touch the database, so stub the module out and
  // stay independent of the better-sqlite3 native ABI.
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

const { assert, assertEqual, assertOrThrow } = require('../helpers/test-setup');

assert(false, 'COUNTING_ASSERT_DID_NOT_REPORT');
assertEqual(1, 2, 'COUNTING_EQUAL_DID_NOT_REPORT');
console.log('REACHED_AFTER_COUNTING');

assertOrThrow(false, 'THROWING_ASSERT_DID_NOT_THROW');
console.log('UNREACHABLE_AFTER_THROWING_ASSERT');
