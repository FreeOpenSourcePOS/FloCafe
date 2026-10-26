/**
 * Printer text_size column: fresh schema and upgrade from the previous schema version.
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-text-size-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  closeDatabase,
  now,
} = require('../main/db');
const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');

function textSizeColumn() {
  return (getDatabase().prepare('PRAGMA table_info(printers)').all() as any[]).find(
    (column) => column.name === 'text_size',
  );
}

function main() {
  const originalMigrations = MIGRATIONS.slice();
  const target = originalMigrations.find(
    (migration: any) => migration.name === 'add_printer_text_size',
  );
  assertOrThrow(Boolean(target), 'migration add_printer_text_size is registered');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(
    ...originalMigrations.filter((migration: any) => migration.version < target.version),
  );
  initDatabase();
  const db = getDatabase();
  const previousVersion = getCurrentSchemaVersion();
  assertEqualOrThrow(
    previousVersion,
    target.version - 1,
    'setup: database starts one version before text_size',
  );

  // Rebuild the pre-migration table shape and seed a legacy printer row.
  db.exec('DROP TABLE printers');
  db.exec(`CREATE TABLE printers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    connection_type TEXT NOT NULL CHECK (connection_type IN ('network', 'usb', 'webusb')),
    ip_address TEXT, port INTEGER DEFAULT 9100, is_default INTEGER DEFAULT 0,
    cash_drawer_pulse_enabled INTEGER NOT NULL DEFAULT 0, paper_width TEXT DEFAULT '80mm',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, paper_width, is_default, created_at, updated_at)
     VALUES ('legacy', 'Legacy', 'network', '10.0.0.5', 'cols-48', 1, ?, ?)`,
  ).run(now(), now());
  assertOrThrow(!textSizeColumn(), 'setup: legacy printers table has no text_size');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  for (const migration of originalMigrations) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  assertOrThrow(Boolean(textSizeColumn()), 'upgrade adds text_size');
  const legacy = db.prepare('SELECT * FROM printers WHERE id = ?').get('legacy') as any;
  assertEqualOrThrow(legacy.text_size, 'normal', 'existing printers default to normal');
  assertEqualOrThrow(legacy.name, 'Legacy', 'existing printer rows survive');
  assertEqualOrThrow(legacy.paper_width, 'cols-48', 'existing paper width survives');

  db.prepare("UPDATE printers SET text_size = 'extra_large' WHERE id = 'legacy'").run();
  let rejected = false;
  try {
    db.prepare("UPDATE printers SET text_size = 'huge' WHERE id = 'legacy'").run();
  } catch {
    rejected = true;
  }
  assertOrThrow(rejected, 'unknown text sizes are rejected by the schema');

  // Re-running is a no-op.
  target.up();
  closeDatabase();

  // Fresh database ships the column with the same default.
  fs.rmSync(path.join(testDir), { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  initDatabase();
  const fresh = textSizeColumn();
  assertOrThrow(Boolean(fresh), 'fresh database has text_size');
  assertEqualOrThrow(fresh.dflt_value, "'normal'", 'fresh default is normal');
  assertEqualOrThrow(fresh.notnull, 1, 'fresh column is NOT NULL');
  getDatabase()
    .prepare(
      `INSERT INTO printers (id, name, connection_type, created_at, updated_at) VALUES ('f', 'Fresh', 'usb', ?, ?)`,
    )
    .run(now(), now());
  assertEqualOrThrow(
    (getDatabase().prepare("SELECT text_size FROM printers WHERE id = 'f'").get() as any).text_size,
    'normal',
    'fresh printers default to normal',
  );

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('printer text_size migration: all checks passed');
}

main();
