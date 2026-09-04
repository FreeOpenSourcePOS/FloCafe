/**
 * Migration v80 coverage.
 *
 * Cash-drawer-pulse-on-print moved from a per-printer flag (v75,
 * "add_printer_cash_drawer_pulse") to a global setting with a selectable
 * payment-method list. printReceipt (main/printers/thermal.ts) only falls
 * back to the legacy per-printer flag while the global setting is unset —
 * and the settings page writes 'false' to it the first time the printing
 * tab is saved for any reason, regardless of what was being changed. A
 * store that already had the flag enabled on a printer would silently stop
 * getting a drawer kick the next time anyone touched printing settings,
 * with no error or indication anything changed (flagged by Greptile review
 * on PR #640).
 *
 * v80 ("migrate_cash_drawer_pulse_to_global_setting") seeds the global
 * setting to 'true' during the upgrade itself, for any store with the
 * legacy flag already enabled on a printer, so the setting is never
 * observed unset for those stores. This test simulates that upgrade path
 * directly: apply migrations up to v79, set the legacy flag as if an
 * earlier app version had, then apply v80 alone and assert the global
 * setting is seeded — and that a store without the legacy flag enabled
 * gets no such setting (preserving the "unset means check legacy" default).
 *
 * The legacy flag also pulsed unconditionally, for every payment method —
 * shouldPulseForPayment's new method filter defaults to ['cash', 'card'],
 * which would silently stop pulsing for UPI or a custom method on a
 * migrated store (also flagged by CodeRabbit on PR #640). v80 seeds
 * cash_drawer_pulse_methods with thermal.ts's CASH_DRAWER_PULSE_ALL_METHODS
 * sentinel ('all') alongside the enabled flag, which this test also asserts.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
// Two independent DB files — each "store" in this test needs its own,
// since initDatabase()'s user_version check would otherwise see store A's
// already-migrated (v80) database when store B reopens the same path.
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v80-a-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase, now } = require('../main/db');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function runPendingMigrations() {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

function settingValue(db: any, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;
}

function main() {
  const originalMigrations = MIGRATIONS.slice();
  const testDirA = activeTestDir;

  // ── Store A: had the legacy per-printer flag enabled ──────────────────
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 79));
  initDatabase();
  let db = getDatabase();
  assert(getCurrentSchemaVersion() === 79, 'setup: store A starts at schema v79');

  db.prepare(`
    INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, is_default, cash_drawer_pulse_enabled, created_at, updated_at)
    VALUES ('legacy-drawer', 'Legacy Drawer Printer', 'network', '192.168.1.50', 9100, 'cols-42', 1, 1, ?, ?)
  `).run(now(), now());
  assert(settingValue(db, 'cash_drawer_pulse_enabled') === undefined, 'setup: global setting not yet present');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();

  assert(getCurrentSchemaVersion() === originalMigrations[originalMigrations.length - 1].version, 'store A upgrade reaches latest schema');
  assert(settingValue(db, 'cash_drawer_pulse_enabled') === 'true', 'store A: legacy per-printer flag migrates to the global setting');
  assert(settingValue(db, 'cash_drawer_pulse_methods') === 'all', 'store A: legacy unconditional pulse preserved via the "all methods" sentinel, not narrowed to cash/card');

  closeDatabase();

  // ── Store B: never enabled cash-drawer pulse ───────────────────────────
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v80-b-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 79));
  initDatabase();
  db = getDatabase();
  db.prepare(`
    INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, is_default, cash_drawer_pulse_enabled, created_at, updated_at)
    VALUES ('no-drawer', 'Plain Printer', 'network', '192.168.1.51', 9100, 'cols-42', 1, 0, ?, ?)
  `).run(now(), now());

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();

  assert(settingValue(db, 'cash_drawer_pulse_enabled') === undefined, 'store B: no legacy flag means no global setting is seeded (unset default preserved)');
  assert(settingValue(db, 'cash_drawer_pulse_methods') === undefined, 'store B: no legacy flag means no methods sentinel is seeded either');

  closeDatabase();
  fs.rmSync(testDirA, { recursive: true, force: true });
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  console.log(`\n${passed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
