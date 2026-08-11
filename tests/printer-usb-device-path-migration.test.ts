const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-usb-path-migration-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
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

function columnNames(): string[] {
  return getDatabase().prepare('PRAGMA table_info(printers)').all().map((column: any) => column.name);
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

function main() {
  const originalMigrations = MIGRATIONS.slice();
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 62));

  initDatabase();
  const db = getDatabase();
  assert(getCurrentSchemaVersion() === 62, 'setup: database starts at schema v62');

  db.exec('ALTER TABLE printers ADD COLUMN usb_device_path TEXT');
  db.prepare("UPDATE settings SET value = 'false', updated_at = ? WHERE key = 'bill_show_name'").run(now());
  db.prepare(`
    INSERT INTO printers (id, name, connection_type, usb_device_path, paper_width, is_default, created_at, updated_at)
    VALUES ('legacy-usb', 'Legacy USB', 'usb', '/dev/usb/lp0', 'cols-42', 1, ?, ?)
  `).run(now(), now());
  assert(columnNames().includes('usb_device_path'), 'setup: legacy printer table contains usb_device_path');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();

  assert(getCurrentSchemaVersion() === originalMigrations[originalMigrations.length - 1].version, 'upgrade reaches latest schema');
  assert(!columnNames().includes('usb_device_path'), 'upgrade drops ignored USB device path column');
  assert((db.prepare("SELECT value FROM settings WHERE key = 'bill_show_name'").get() as any)?.value === 'false', 'upgrade preserves an existing bill visibility choice');
  assert((db.prepare("SELECT value FROM settings WHERE key = 'bill_show_tax_breakdown'").get() as any)?.value === 'true', 'upgrade seeds the tax breakdown visibility setting');
  assert((db.prepare("SELECT value FROM settings WHERE key = 'bill_show_customer_phone'").get() as any)?.value === 'true', 'upgrade seeds the customer number visibility setting');
  const printer = db.prepare('SELECT id, name, connection_type, paper_width, is_default FROM printers WHERE id = ?').get('legacy-usb') as any;
  assert(printer?.name === 'Legacy USB' && printer.connection_type === 'usb' && printer.paper_width === 'cols-42' && printer.is_default === 1, 'legacy printer row survives the column removal');

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(`\n${passed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
