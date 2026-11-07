/**
 * Schema Health Check Tests
 *
 * Usage: node tests/run-electron-node-test.cjs tests/schema-health.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-schema-health-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

let memoryDbOpenCount = 0;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  if (request === 'better-sqlite3') {
    const RealDatabase = originalLoad.apply(this, arguments as any);
    function WrappedDatabase(filename?: string, options?: unknown) {
      if (filename === ':memory:') memoryDbOpenCount += 1;
      return new RealDatabase(filename, options);
    }
    Object.setPrototypeOf(WrappedDatabase, RealDatabase);
    WrappedDatabase.prototype = RealDatabase.prototype;
    return WrappedDatabase;
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getDbPath,
  closeDatabase,
  getCurrentSchemaVersion,
  buildIdealSchemaDb,
  isHealthyDatabaseFile,
} = require('../main/db');
const { runHealthCheck, applySafeFixes } = require('../main/services/schema-health');

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

function main() {
  console.log('🧪 FloDesktop Schema Health Check Tests');
  console.log('='.repeat(60));

  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('   ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
      process.exit(77);
    }
    throw error;
  }

  // ── buildIdealSchemaDb tracks MIGRATIONS automatically ──────────────────
  const idealDb = buildIdealSchemaDb();
  assert.equal(
    idealDb.pragma('user_version', { simple: true }),
    getCurrentSchemaVersion(),
    'ideal schema db reaches the same version as a fresh real install',
  );
  idealDb.close();
  console.log('   ✓ buildIdealSchemaDb() tracks the live MIGRATIONS array');

  // ── Fresh install matches its own ideal schema (no false positives) ─────
  const memoryDbBeforeCold = memoryDbOpenCount;
  let report = runHealthCheck();
  assert.equal(
    report.findings.length,
    0,
    'fresh database has zero findings against its own ideal schema',
  );
  assert.equal(report.summary.safeCount, 0);
  assert.equal(report.summary.manualReviewCount, 0);
  assert.ok(
    memoryDbOpenCount - memoryDbBeforeCold <= 1,
    'runHealthCheck() builds the ideal schema snapshot at most once (startup repair may have built it)',
  );
  const memoryDbBeforeWarm = memoryDbOpenCount;
  const warmReport = runHealthCheck();
  assert.equal(warmReport.findings.length, 0);
  assert.equal(
    memoryDbOpenCount - memoryDbBeforeWarm,
    0,
    'subsequent runHealthCheck() reuses the cached ideal schema snapshot without rebuilding :memory: DB',
  );
  console.log(
    '   ✓ runHealthCheck() reports zero findings on a fresh install and caches ideal schema',
  );

  const db = getDatabase();

  const requiredTaxTables = [
    'country_packs',
    'country_pack_versions',
    'tax_categories',
    'tax_rules',
    'tax_overrides',
    'tax_config_audit',
  ];
  for (const table of requiredTaxTables) {
    assert.ok(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
      `${table} exists on a fresh install`,
    );
  }
  const expectedTaxColumns: Record<string, string[]> = {
    products: ['tax_category_id', 'tax_behavior', 'tax_type', 'tax_rate'],
    addons: ['tax_category_id', 'tax_behavior', 'inherit_parent_tax_category'],
    orders: [
      'tax_snapshot',
      'packaging_tax_category_id',
      'delivery_tax_category_id',
      'service_charge_tax_category_id',
      'service_charge',
    ],
    order_items: ['tax_snapshot'],
    bills: ['tax_snapshot', 'service_charge'],
  };
  for (const [table, expected] of Object.entries(expectedTaxColumns)) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column: any) => column.name);
    for (const column of expected) {
      assert.ok(columns.includes(column), `${table}.${column} exists on a fresh install`);
    }
  }
  console.log('   ✓ fresh installs include every Phase 1 tax table and column');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM country_packs').get() as { count: number }).count,
    1,
    'fresh installs register only the generic tax pack',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM country_pack_versions').get() as { count: number })
      .count,
    1,
    'fresh installs register only the generic tax pack version',
  );
  assert.ok(
    db
      .prepare(`
      SELECT 1 FROM country_pack_versions
      WHERE pack_id = 'local-generic' AND version = '1.0.0' AND status = 'active'
    `)
      .get(),
    'fresh installs activate the generic no-tax pack version',
  );
  console.log('   ✓ fresh installs register only the generic pack artifact used by Settings');

  // ── Extra column is flagged manual_review, never auto-applicable ────────
  db.exec(`ALTER TABLE products ADD COLUMN __test_extra_col TEXT`);
  report = runHealthCheck();
  const extraColFinding = report.findings.find(
    (f: any) => f.id === 'extra_column:products.__test_extra_col',
  );
  assert.ok(extraColFinding, 'unexpected column is detected');
  assert.equal(
    extraColFinding.risk,
    'manual_review',
    'extra column is manual_review, never auto-applied',
  );
  assert.equal(extraColFinding.autoApplicable, false);
  console.log('   ✓ an unexpected extra column is flagged manual_review, not auto-fixed');

  // ── Missing table is flagged safe with a suggested CREATE TABLE ─────────
  db.exec(`DROP TABLE IF EXISTS held_orders`);
  report = runHealthCheck();
  const missingTableFinding = report.findings.find(
    (f: any) => f.id === 'missing_table:held_orders',
  );
  assert.ok(missingTableFinding, 'missing table is detected');
  assert.equal(missingTableFinding.risk, 'safe');
  assert.equal(missingTableFinding.autoApplicable, true);
  assert.match(missingTableFinding.suggestedDdl, /CREATE TABLE IF NOT EXISTS held_orders/i);
  console.log('   ✓ a missing table is flagged safe with a CREATE TABLE IF NOT EXISTS fix');

  // ── applySafeFixes recreates the missing table; a second check is clean ─
  const fixResult = applySafeFixes(['missing_table:held_orders']);
  assert.ok(
    fixResult.applied.includes('missing_table:held_orders'),
    'the missing table fix was applied',
  );
  assert.equal(fixResult.errors.length, 0);

  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='held_orders'`)
    .get();
  assert.ok(tableExists, 'held_orders table exists again after applying the safe fix');

  report = runHealthCheck();
  assert.ok(
    !report.findings.some((f: any) => f.id === 'missing_table:held_orders'),
    'missing_table finding is gone after the fix',
  );
  console.log('   ✓ applySafeFixes() recreates a missing table and a re-check no longer flags it');

  // extra column finding is untouched by applySafeFixes (never targeted, never auto-applicable)
  assert.ok(
    report.findings.some((f: any) => f.id === 'extra_column:products.__test_extra_col'),
    'extra column finding persists — applySafeFixes never removes columns',
  );
  console.log('   ✓ applySafeFixes() never touches manual_review findings');

  // ── Foreign-key ON DELETE/ON UPDATE actions are compared ────────────────
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const addonRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_item_addons'")
      .get() as { sql: string };
    assert.ok(addonRow?.sql, 'order_item_addons has a CREATE TABLE statement to rebuild');
    const modified = addonRow.sql.replace(
      'REFERENCES order_items(id) ON DELETE CASCADE',
      'REFERENCES order_items(id) ON DELETE RESTRICT',
    );
    assert.notEqual(modified, addonRow.sql, 'the FK action replacement actually changed the DDL');
    db.exec('ALTER TABLE order_item_addons RENAME TO order_item_addons_old');
    db.exec(modified);
    db.exec('INSERT INTO order_item_addons SELECT * FROM order_item_addons_old');
    db.exec('DROP TABLE order_item_addons_old');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  report = runHealthCheck();
  const fkFinding = report.findings.find(
    (f: any) => f.id === 'foreign_key_mismatch:order_item_addons',
  );
  assert.ok(fkFinding, 'an ON DELETE action difference is reported as a foreign_key_mismatch');
  assert.match(
    fkFinding.currentState,
    /RESTRICT/,
    'current state surfaces the live ON DELETE action',
  );
  assert.match(
    fkFinding.idealState,
    /CASCADE/,
    'ideal state surfaces the expected ON DELETE action',
  );
  console.log('   ✓ foreign-key ON DELETE/ON UPDATE actions are compared');

  // ── a skipped migration's column (with its foreign key) and trigger are restored ──
  db.exec('DROP TRIGGER clear_table_reservation_customer_on_status_change');
  db.exec('ALTER TABLE tables DROP COLUMN reservation_customer_id');
  report = runHealthCheck();
  assert.ok(
    report.findings.some((f: any) => f.id === 'missing_column:tables.reservation_customer_id'),
    'a missing column is reported',
  );
  assert.ok(
    report.findings.some(
      (f: any) => f.id === 'missing_trigger:clear_table_reservation_customer_on_status_change',
    ),
    'a missing trigger is reported as safe to restore',
  );
  const triggerFix = applySafeFixes();
  assert.equal(triggerFix.errors.length, 0, 'restoring the column and trigger raises no errors');
  report = runHealthCheck();
  assert.equal(
    report.findings.filter((f: any) => f.table === 'tables').length,
    0,
    'the restored column keeps its foreign key, so no drift remains on tables',
  );
  console.log('   ✓ missing columns (with foreign keys) and triggers are restored');

  // ── a recreated table also gets its indexes in the same repair ──
  db.exec('DROP TABLE product_variants');
  report = runHealthCheck();
  assert.ok(
    report.findings.some((f: any) => f.id === 'missing_table:product_variants'),
    'a missing table is reported',
  );
  const tableFix = applySafeFixes();
  assert.equal(tableFix.errors.length, 0, 'recreating the table raises no errors');
  assert.ok(
    tableFix.applied.some((id: string) => id.startsWith('missing_index:')) ||
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_product_variants_product'",
        )
        .get(),
    'the table indexes are restored in the same repair',
  );
  assert.equal(
    runHealthCheck().findings.filter((f: any) => f.table === 'product_variants').length,
    0,
    'no drift remains on the recreated table after one repair',
  );
  console.log('   ✓ recreated tables get their indexes in one repair');

  // ── a search trigger is not restored while its FTS table is missing ──
  const ftsTriggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_orders_search_%'",
    )
    .all()
    .map((row: any) => row.name);
  assert.ok(ftsTriggers.length > 0, 'fixture has orders search triggers');
  for (const name of ftsTriggers) db.exec(`DROP TRIGGER ${name}`);
  db.exec('DROP TABLE orders_search_fts');
  const ftsReport = runHealthCheck();
  assert.ok(
    !ftsReport.findings.some((f: any) => f.id.startsWith('missing_trigger:trg_orders_search_')),
    'no search trigger is offered while orders_search_fts is missing',
  );
  console.log('   ✓ triggers that depend on a missing FTS table are not restored');

  // ── applySafeFixes is atomic: a failed fix rolls back the whole batch ──
  db.exec('DROP TABLE IF EXISTS held_orders');
  db.exec('DROP INDEX IF EXISTS idx_customers_phone_digits_unique');
  // phone_digits is a VIRTUAL generated column, so seed duplicate phones and
  // let the generated digits collide to make the unique index rebuild fail.
  db.prepare(
    "INSERT INTO customers (id, name, phone) VALUES ('atomic-a', 'Atomic A', '+1 555 000 1111')",
  ).run();
  db.prepare(
    "INSERT INTO customers (id, name, phone) VALUES ('atomic-b', 'Atomic B', '+1 555 000 1111')",
  ).run();

  const atomicResult = applySafeFixes([
    'missing_table:held_orders',
    'missing_index:customers.idx_customers_phone_digits_unique',
  ]);
  assert.ok(
    atomicResult.errors.some(
      (e: any) => e.id === 'missing_index:customers.idx_customers_phone_digits_unique',
    ),
    'the duplicate-data unique index fix fails',
  );
  assert.equal(
    atomicResult.applied.length,
    0,
    'no fix is reported applied when the batch rolls back',
  );
  assert.ok(
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='held_orders'").get(),
    'held_orders is NOT left behind when a later fix fails (batch rolled back)',
  );
  console.log('   ✓ applySafeFixes() rolls back the whole batch when any fix fails');

  // ── Missing users table does not block initDatabase() and applySafeFixes() restores revision triggers ──
  const { getSettingsRevision } = require('../main/db');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DROP TABLE users');
  db.exec('PRAGMA foreign_keys = ON');
  closeDatabase();
  initDatabase();
  const reopenedDb = getDatabase();
  const repairUsers = applySafeFixes(['missing_table:users']);
  assert.deepEqual(
    repairUsers.applied,
    ['missing_table:users'],
    'applySafeFixes() recreates missing users table after startup',
  );
  const revBeforeUserInsert = getSettingsRevision();
  reopenedDb
    .prepare(
      "INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('repaired-owner', 'Owner', 'owner@test.local', 'hash', 'owner', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
    )
    .run();
  assert.ok(
    getSettingsRevision() > revBeforeUserInsert,
    'applySafeFixes() installs missing revision triggers on repaired users table',
  );
  console.log(
    '   ✓ initDatabase() tolerates missing users table and applySafeFixes() installs revision triggers',
  );

  // ── Upgraded / applySafeFixes-healed databases pass isHealthyDatabaseFile and journal recovery ──
  closeDatabase();
  const liveDbPath = getDbPath();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${liveDbPath}${suffix}`, { force: true });
  }
  fs.rmSync(path.join(testDir, '.flo-db-initialized'), { force: true });
  fs.rmSync(path.join(testDir, 'backups'), { recursive: true, force: true });
  const preUpgradeV98Db = buildIdealSchemaDb(98);
  try {
    preUpgradeV98Db.exec('ALTER TABLE orders DROP COLUMN charges_breakdown');
    fs.writeFileSync(liveDbPath, preUpgradeV98Db.serialize());
  } finally {
    preUpgradeV98Db.close();
  }
  initDatabase();
  const upgradedDb = getDatabase();
  upgradedDb.exec('ALTER TABLE products DROP COLUMN cb_percent');
  const healedCols = applySafeFixes(['missing_column:products.cb_percent']);
  assert.deepEqual(
    healedCols.applied,
    ['missing_column:products.cb_percent'],
    'applySafeFixes() re-adds column via ALTER TABLE ADD COLUMN',
  );
  assert.equal(healedCols.errors.length, 0);
  assert.equal(runHealthCheck().findings.length, 0, 'upgraded database has zero schema drift');
  upgradedDb
    .prepare("INSERT INTO categories (id, name) VALUES ('cat-upgraded-rec', 'Upgraded Recovery')")
    .run();
  const freshCheckDb = buildIdealSchemaDb();
  try {
    const upgradedOrdersSql = (
      upgradedDb
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'")
        .get() as { sql: string }
    ).sql;
    const freshOrdersSql = (
      freshCheckDb
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'")
        .get() as { sql: string }
    ).sql;
    assert.notEqual(
      upgradedOrdersSql.replace(/\s+/g, ' ').trim().toLowerCase(),
      freshOrdersSql.replace(/\s+/g, ' ').trim().toLowerCase(),
      'upgraded database has different raw sqlite_master CREATE TABLE text than a fresh install',
    );
  } finally {
    freshCheckDb.close();
  }
  upgradedDb.pragma('wal_checkpoint(TRUNCATE)');
  closeDatabase();

  assert.equal(
    isHealthyDatabaseFile(liveDbPath, undefined, false),
    true,
    'upgraded database with ALTER TABLE column order is recognized as healthy',
  );

  const backupDir = path.join(testDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const preparedRecoveryName = 'flo-restore-recovery-upgraded-prepared';
  const preparedRecoveryPath = path.join(backupDir, `${preparedRecoveryName}.db`);
  const preparedJournalPath = path.join(backupDir, `${preparedRecoveryName}.json`);
  fs.copyFileSync(liveDbPath, preparedRecoveryPath);
  fs.writeFileSync(
    preparedJournalPath,
    JSON.stringify({
      phase: 'prepared',
      recoveryPath: preparedRecoveryPath,
      dbPath: liveDbPath,
    }),
  );
  fs.writeFileSync(liveDbPath, 'interrupted replacement partial write');

  initDatabase();
  assert.equal(
    (
      getDatabase().prepare("SELECT name FROM categories WHERE id = 'cat-upgraded-rec'").get() as
        | { name: string }
        | undefined
    )?.name,
    'Upgraded Recovery',
    'recoverInterruptedDatabaseReplacement restores healthy upgraded snapshot from prepared journal',
  );
  assert.equal(
    fs.existsSync(preparedJournalPath),
    false,
    'prepared recovery journal is cleaned up',
  );
  getDatabase().pragma('wal_checkpoint(TRUNCATE)');
  closeDatabase();

  const committedRecoveryName = 'flo-restore-recovery-upgraded-committed';
  const committedRecoveryPath = path.join(backupDir, `${committedRecoveryName}.db`);
  const committedJournalPath = path.join(backupDir, `${committedRecoveryName}.json`);
  fs.writeFileSync(
    committedJournalPath,
    JSON.stringify({
      phase: 'committed',
      recoveryPath: committedRecoveryPath,
      dbPath: liveDbPath,
      driveInvalidationRequired: false,
    }),
  );

  initDatabase();
  assert.equal(
    (
      getDatabase().prepare("SELECT name FROM categories WHERE id = 'cat-upgraded-rec'").get() as
        | { name: string }
        | undefined
    )?.name,
    'Upgraded Recovery',
    'recoverInterruptedDatabaseReplacement finalizes committed journal for healthy upgraded database',
  );
  assert.equal(
    fs.existsSync(committedJournalPath),
    false,
    'committed recovery journal is finalized and removed',
  );
  console.log(
    '   ✓ upgraded / applySafeFixes-healed databases pass isHealthyDatabaseFile and journal recovery',
  );

  // ── Column collation ownership and constraint ON CONFLICT policies are enforced ──
  const collationMovedDb = buildIdealSchemaDb();
  const collationMovedPath = path.join(testDir, 'collation-moved.db');
  try {
    const paymentMethodsSql = (
      collationMovedDb
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_methods'")
        .get() as { sql: string }
    ).sql;
    const movedSql = paymentMethodsSql
      .replace('name TEXT NOT NULL COLLATE NOCASE UNIQUE', 'name TEXT NOT NULL UNIQUE')
      .replace(
        'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        'created_at TEXT NOT NULL COLLATE NOCASE DEFAULT CURRENT_TIMESTAMP',
      )
      .replace(
        /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+payment_methods/i,
        'CREATE TABLE payment_methods_rebuilt',
      );
    assert.notEqual(movedSql, paymentMethodsSql, 'collation move modified payment_methods DDL');
    collationMovedDb.exec('PRAGMA foreign_keys = OFF');
    collationMovedDb.exec(movedSql);
    collationMovedDb.exec(
      'INSERT INTO payment_methods_rebuilt SELECT * FROM payment_methods; DROP TABLE payment_methods; ALTER TABLE payment_methods_rebuilt RENAME TO payment_methods; CREATE INDEX IF NOT EXISTS idx_payment_methods_active_sort ON payment_methods(is_active, sort_order, id);',
    );
    collationMovedDb.exec('PRAGMA foreign_keys = ON');
    fs.writeFileSync(collationMovedPath, collationMovedDb.serialize());
  } finally {
    collationMovedDb.close();
  }
  assert.equal(
    isHealthyDatabaseFile(collationMovedPath, undefined, false),
    false,
    'isHealthyDatabaseFile rejects database where COLLATE NOCASE moved off payment_methods.name',
  );

  for (const [label, transform] of [
    [
      'column-level UNIQUE ON CONFLICT REPLACE',
      (sql: string) =>
        sql.replace(
          'name TEXT NOT NULL COLLATE NOCASE UNIQUE',
          'name TEXT NOT NULL COLLATE NOCASE UNIQUE ON CONFLICT REPLACE',
        ),
    ],
    [
      'table-level UNIQUE ON CONFLICT REPLACE',
      (sql: string) =>
        sql
          .replace('name TEXT NOT NULL COLLATE NOCASE UNIQUE', 'name TEXT NOT NULL COLLATE NOCASE')
          .replace(/\)\s*$/, ', UNIQUE(name) ON CONFLICT REPLACE)'),
    ],
  ] as const) {
    const conflictChangedDb = buildIdealSchemaDb();
    const conflictChangedPath = path.join(
      testDir,
      `conflict-changed-${label.replace(/\s+/g, '-')}.db`,
    );
    try {
      const paymentMethodsSql = (
        conflictChangedDb
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_methods'",
          )
          .get() as { sql: string }
      ).sql;
      const modifiedSql = transform(paymentMethodsSql).replace(
        /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+payment_methods/i,
        'CREATE TABLE payment_methods_rebuilt',
      );
      assert.notEqual(modifiedSql, paymentMethodsSql, `${label} modified payment_methods DDL`);
      conflictChangedDb.exec('PRAGMA foreign_keys = OFF');
      conflictChangedDb.exec(modifiedSql);
      conflictChangedDb.exec(
        'INSERT INTO payment_methods_rebuilt SELECT * FROM payment_methods; DROP TABLE payment_methods; ALTER TABLE payment_methods_rebuilt RENAME TO payment_methods; CREATE INDEX IF NOT EXISTS idx_payment_methods_active_sort ON payment_methods(is_active, sort_order, id);',
      );
      conflictChangedDb.exec('PRAGMA foreign_keys = ON');
      fs.writeFileSync(conflictChangedPath, conflictChangedDb.serialize());
    } finally {
      conflictChangedDb.close();
    }
    assert.equal(
      isHealthyDatabaseFile(conflictChangedPath, undefined, false),
      false,
      `isHealthyDatabaseFile rejects database with ${label} on payment_methods.name`,
    );
  }
  console.log(
    '   ✓ isHealthyDatabaseFile enforces per-column collation ownership and UNIQUE ON CONFLICT policies',
  );
}

try {
  main();
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n✅ Schema health check tests passed');
} catch (error) {
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
}
