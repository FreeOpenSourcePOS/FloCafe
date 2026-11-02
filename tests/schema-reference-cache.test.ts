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
    buildIdealSchemaDb,
    closeDatabase,
    createBackup,
    restoreBackup,
    isHealthyDatabaseFile,
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
    console.log('[1/4] Testing cold health check builds reference at most once...');
    const countBeforeCold = getRecoverySchemaBuildCount();

    const healthyFirst = isHealthyDatabaseFile(backupPath);
    assert.equal(healthyFirst, true, 'valid backup file is reported healthy');
    assert.equal(
      getRecoverySchemaBuildCount() - countBeforeCold,
      1,
      'cold check must build ideal schema exactly once',
    );

    // Second check must reuse the cached reference without building again
    const healthySecond = isHealthyDatabaseFile(backupPath);
    assert.equal(healthySecond, true, 'second check reports healthy');
    assert.equal(
      getRecoverySchemaBuildCount() - countBeforeCold,
      1,
      'second check reuses cache without building again',
    );

    // Live db without metadata is also healthy when requireMetadata = false
    const healthyLive = isHealthyDatabaseFile(dbPath, undefined, false);
    assert.equal(
      healthyLive,
      true,
      'live database without metadata is healthy when requireMetadata = false',
    );
    assert.equal(
      getRecoverySchemaBuildCount() - countBeforeCold,
      1,
      're-uses cached schema reference',
    );

    // ── 2. Same-version direct restore reuses the cached reference ──
    console.log('[2/4] Testing same-version direct restore caching...');
    const countBeforeRestore = getRecoverySchemaBuildCount();

    await restoreBackup(backupPath);
    assert.equal(
      getRecoverySchemaBuildCount(),
      countBeforeRestore,
      'direct restore reuses the cached reference without re-building',
    );

    // ── 3. Migration registry mutation invalidates and updates cache ──
    console.log('[3/4] Testing migration registry identity change invalidation...');
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

    // ── 4. Schema verification still rejects malformed/incomplete databases ──
    console.log('[4/4] Testing detection of invalid candidate databases...');
    const corruptedDbPath = path.join(testDir, 'corrupted.db');
    fs.copyFileSync(dbPath, corruptedDbPath);

    const corruptDb = new Database(corruptedDbPath);
    // Alter schema: drop a required table
    corruptDb.exec('DROP TABLE IF EXISTS orders');
    corruptDb.close();

    const isCorruptedHealthy = isHealthyDatabaseFile(corruptedDbPath);
    assert.equal(isCorruptedHealthy, false, 'database missing a table is correctly rejected');

    const preIndexBackupPath = path.join(testDir, 'pre-runtime-index-backup.db');
    fs.copyFileSync(backupPath, preIndexBackupPath);
    const preIndexDb = new Database(preIndexBackupPath);
    preIndexDb.exec('DROP INDEX IF EXISTS idx_order_items_active_kds');
    preIndexDb.close();

    assert.equal(
      isHealthyDatabaseFile(preIndexBackupPath),
      true,
      'same-version backup without runtime index remains healthy',
    );
    const preIndexRestore = await restoreBackup(preIndexBackupPath);
    assert.equal(preIndexRestore.success, true, 'direct restore accepts pre-index v121 backup');
    assert.equal(preIndexRestore.mode, 'direct', 'pre-index v121 backup uses direct restore');
    assert.ok(
      getDatabase()
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_order_items_active_kds'",
        )
        .get(),
      'direct restore recreates idx_order_items_active_kds during re-initialization',
    );

    const tamperedIndexBackupPath = path.join(testDir, 'tampered-runtime-index-backup.db');
    fs.copyFileSync(backupPath, tamperedIndexBackupPath);
    const tamperedIndexDb = new Database(tamperedIndexBackupPath);
    tamperedIndexDb.exec('DROP INDEX IF EXISTS idx_order_items_active_kds');
    tamperedIndexDb.exec('CREATE INDEX idx_order_items_active_kds ON order_items(order_id)');
    tamperedIndexDb.close();

    assert.equal(
      isHealthyDatabaseFile(tamperedIndexBackupPath),
      false,
      'candidate with mismatched idx_order_items_active_kds SQL is rejected',
    );
    const tamperedRestore = await restoreBackup(tamperedIndexBackupPath);
    assert.equal(
      tamperedRestore.success,
      false,
      'direct restore rejects mismatched idx_order_items_active_kds SQL',
    );

    const v114SnapshotPath = path.join(testDir, 'historical-v114.db');
    const v114Ideal = buildIdealSchemaDb(114);
    try {
      assert.equal(
        v114Ideal
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_order_items_active_kds'",
          )
          .get(),
        undefined,
        'historical ideal schema before v121 omits idx_order_items_active_kds',
      );
      await v114Ideal.backup(v114SnapshotPath);
    } finally {
      v114Ideal.close();
    }
    assert.equal(
      isHealthyDatabaseFile(v114SnapshotPath, undefined, false),
      true,
      'historical v114 snapshot without idx_order_items_active_kds is healthy',
    );

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
