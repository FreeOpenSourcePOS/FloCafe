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

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion, buildIdealSchemaDb,
} = require('../main/db');
const { runHealthCheck, applySafeFixes } = require('../main/services/schema-health');

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && String(error?.message || '').includes('NODE_MODULE_VERSION');
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
  assert.equal(idealDb.pragma('user_version', { simple: true }), getCurrentSchemaVersion(),
    'ideal schema db reaches the same version as a fresh real install');
  idealDb.close();
  console.log('   ✓ buildIdealSchemaDb() tracks the live MIGRATIONS array');

  // ── Fresh install matches its own ideal schema (no false positives) ─────
  let report = runHealthCheck();
  assert.equal(report.findings.length, 0, 'fresh database has zero findings against its own ideal schema');
  assert.equal(report.summary.safeCount, 0);
  assert.equal(report.summary.manualReviewCount, 0);
  console.log('   ✓ runHealthCheck() reports zero findings on a fresh install');

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
    ],
    order_items: ['tax_snapshot'],
    bills: ['tax_snapshot'],
  };
  for (const [table, expected] of Object.entries(expectedTaxColumns)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column: any) => column.name);
    for (const column of expected) {
      assert.ok(columns.includes(column), `${table}.${column} exists on a fresh install`);
    }
  }
  console.log('   ✓ fresh installs include every Phase 1 tax table and column');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM country_packs').get() as { count: number }).count,
    5,
    'fresh installs register all bundled tax packs (IN, TH, AR, BR, generic)',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM country_pack_versions').get() as { count: number }).count,
    5,
    'fresh installs register all bundled tax pack versions',
  );
  assert.ok(
    (db.prepare(`
      SELECT 1 FROM country_pack_versions
      WHERE pack_id = 'official-in' AND version = '1.0.0' AND status = 'active'
    `).get()),
    'fresh installs activate the bundled India pack version',
  );
  console.log('   ✓ fresh installs register the bundled pack artifacts used by Settings');

  // ── Extra column is flagged manual_review, never auto-applicable ────────
  db.exec(`ALTER TABLE products ADD COLUMN __test_extra_col TEXT`);
  report = runHealthCheck();
  const extraColFinding = report.findings.find((f: any) => f.id === 'extra_column:products.__test_extra_col');
  assert.ok(extraColFinding, 'unexpected column is detected');
  assert.equal(extraColFinding.risk, 'manual_review', 'extra column is manual_review, never auto-applied');
  assert.equal(extraColFinding.autoApplicable, false);
  console.log('   ✓ an unexpected extra column is flagged manual_review, not auto-fixed');

  // ── Missing table is flagged safe with a suggested CREATE TABLE ─────────
  db.exec(`DROP TABLE IF EXISTS held_orders`);
  report = runHealthCheck();
  const missingTableFinding = report.findings.find((f: any) => f.id === 'missing_table:held_orders');
  assert.ok(missingTableFinding, 'missing table is detected');
  assert.equal(missingTableFinding.risk, 'safe');
  assert.equal(missingTableFinding.autoApplicable, true);
  assert.match(missingTableFinding.suggestedDdl, /CREATE TABLE IF NOT EXISTS held_orders/i);
  console.log('   ✓ a missing table is flagged safe with a CREATE TABLE IF NOT EXISTS fix');

  // ── applySafeFixes recreates the missing table; a second check is clean ─
  const fixResult = applySafeFixes(['missing_table:held_orders']);
  assert.ok(fixResult.applied.includes('missing_table:held_orders'), 'the missing table fix was applied');
  assert.equal(fixResult.errors.length, 0);

  const tableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='held_orders'`).get();
  assert.ok(tableExists, 'held_orders table exists again after applying the safe fix');

  report = runHealthCheck();
  assert.ok(!report.findings.some((f: any) => f.id === 'missing_table:held_orders'), 'missing_table finding is gone after the fix');
  console.log('   ✓ applySafeFixes() recreates a missing table and a re-check no longer flags it');

  // extra column finding is untouched by applySafeFixes (never targeted, never auto-applicable)
  assert.ok(report.findings.some((f: any) => f.id === 'extra_column:products.__test_extra_col'),
    'extra column finding persists — applySafeFixes never removes columns');
  console.log('   ✓ applySafeFixes() never touches manual_review findings');
}

try {
  main();
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n✅ Schema health check tests passed');
} catch (error) {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
}
