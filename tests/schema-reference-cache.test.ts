/**
 * Regression and validation tests for FloCafe Issue #1177:
 * Database recovery rebuilds reference schema at most once per process lifetime.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/schema-reference-cache.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-schema-cache-test-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function main() {
  console.log('Test: Recovery schema reference caching and invalidation (#1177)');
  console.log('='.repeat(60));

  const dbModule = await import('../main/db');
  const {
    initDatabase,
    getDatabase,
    closeDatabase,
    createBackup,
    restoreBackup,
    isHealthyDatabaseFile,
    clearRecoverySchemaReference,
    MIGRATIONS,
  } = dbModule;

  try {
    initDatabase();
    const dbPath = path.join(testDir, 'flo.db');
    const backupPath = path.join(testDir, 'test-backup.db');

    // Create a valid same-schema backup to test restores
    await createBackup(backupPath);

    const { getRecoverySchemaBuildCount } = dbModule;

    // ── 1. Cold health check builds the reference exactly once ──
    console.log('[1/5] Testing cold health check builds reference at most once...');
    clearRecoverySchemaReference();
    const countBeforeCold = getRecoverySchemaBuildCount();

    const healthyFirst = isHealthyDatabaseFile(backupPath);
    assert.equal(healthyFirst, true, 'valid backup file is reported healthy');
    assert.equal(getRecoverySchemaBuildCount() - countBeforeCold, 1, 'cold check must build ideal schema exactly once');

    // Second check must reuse the cached reference without building again
    const healthySecond = isHealthyDatabaseFile(backupPath);
    assert.equal(healthySecond, true, 'second check reports healthy');
    assert.equal(getRecoverySchemaBuildCount() - countBeforeCold, 1, 'second check reuses cache without building again');

    // Live db without metadata is also healthy when requireMetadata = false
    const healthyLive = isHealthyDatabaseFile(dbPath, undefined, false);
    assert.equal(healthyLive, true, 'live database without metadata is healthy when requireMetadata = false');
    assert.equal(getRecoverySchemaBuildCount() - countBeforeCold, 1, 're-uses cached schema reference');

    // ── 2. Same-version direct restore builds at most once across all checks ──
    console.log('[2/5] Testing same-version direct restore caching...');
    clearRecoverySchemaReference();
    const countBeforeRestore = getRecoverySchemaBuildCount();

    await restoreBackup(backupPath);
    assert.equal(
      getRecoverySchemaBuildCount() - countBeforeRestore,
      1,
      'direct restore executes at most one ideal schema build across all pre/post health checks',
    );

    // Subsequent direct restore reuses the cache completely (0 new builds)
    const countBeforeSecondRestore = getRecoverySchemaBuildCount();
    await restoreBackup(backupPath);
    assert.equal(
      getRecoverySchemaBuildCount(),
      countBeforeSecondRestore,
      'subsequent direct restore reuses the cached reference without re-building',
    );

    // ── 3. Migration registry mutation invalidates and updates cache ──
    console.log('[3/5] Testing migration registry identity change invalidation...');
    const countBeforeMutation = getRecoverySchemaBuildCount();

    // Mutate MIGRATIONS registry by appending a synthetic migration
    const dummyVersion = (MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0) + 1;
    MIGRATIONS.push({
      version: dummyVersion,
      name: 'synthetic_test_migration',
      up: () => {},
    });

    try {
      // The candidate db does not have this new version, but isHealthyDatabaseFile will
      // detect the changed registry identity, rebuild the reference, and evaluate
      isHealthyDatabaseFile(backupPath);
      assert.equal(
        getRecoverySchemaBuildCount() - countBeforeMutation,
        1,
        'altering migration registry identity forces cache rebuild',
      );
    } finally {
      // Restore original MIGRATIONS registry
      MIGRATIONS.pop();
    }

    // Now identity has changed back to the original registry
    const countBeforeRestoreRegistry = getRecoverySchemaBuildCount();
    const healthyAfterRestoreRegistry = isHealthyDatabaseFile(backupPath);
    assert.equal(healthyAfterRestoreRegistry, true, 'healthy after registry restored');
    assert.equal(
      getRecoverySchemaBuildCount() - countBeforeRestoreRegistry,
      1,
      'restoring original registry identity triggers cache rebuild matching current code',
    );

    // ── 4. Explicit clearRecoverySchemaReference() resets cache ──
    console.log('[4/5] Testing clearRecoverySchemaReference()...');
    clearRecoverySchemaReference();
    const countBeforeClear = getRecoverySchemaBuildCount();
    isHealthyDatabaseFile(backupPath);
    assert.equal(getRecoverySchemaBuildCount() - countBeforeClear, 1, 'cache rebuilt after explicit clear');

    // ── 5. Schema verification still rejects malformed/incomplete databases ──
    console.log('[5/5] Testing detection of invalid candidate databases...');
    const corruptedDbPath = path.join(testDir, 'corrupted.db');
    fs.copyFileSync(dbPath, corruptedDbPath);

    const corruptDb = new Database(corruptedDbPath);
    // Alter schema: drop a required table
    corruptDb.exec('DROP TABLE IF EXISTS orders');
    corruptDb.close();

    const isCorruptedHealthy = isHealthyDatabaseFile(corruptedDbPath);
    assert.equal(isCorruptedHealthy, false, 'database missing a table is correctly rejected');

    console.log('='.repeat(60));
    console.log('All schema reference cache tests passed successfully!');
  } finally {
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error('Test failed with error:', error);
  process.exit(1);
});
