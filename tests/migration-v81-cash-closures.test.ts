/**
 * Migration v81 coverage.
 *
 * Day-close (cierre de caja, issue #649) adds the `cash_closures` table
 * and the `nextZNumber()` wrapper. The schema carries an extension door
 * for future drawer sessions: the unique-invariant for the "one close
 * per day" rule lives in the partial index, not on the column, so future
 * `scope='session'` rows for the same date do not collide.
 *
 * Money columns are INTEGER minor units to match the codebase convention
 * (`refunds.amount_cents`); display conversion happens at the API boundary.
 *
 * `nextZNumber()` is a per-install monotonic counter. The bucket key
 * `name='z_report', date='ALL'` keeps the counter outside the daily
 * sequences seen by bills/orders and preserves single-store-per-install
 * conventional Z numbering.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v81-a-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase, nextZNumber } = require('../main/db');

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

function tableInfo(db: any, table: string): Array<{ name: string }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
}

function columnType(db: any, table: string, column: string): string | undefined {
  return tableInfo(db, table).find((col) => col.name === column)?.type;
}

function main() {
  const originalMigrations = MIGRATIONS.slice();
  const testDirA = activeTestDir;

  // ── Fresh install: every migration applies ────────────────────────────
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  initDatabase();

  let db = getDatabase();
  assert(getCurrentSchemaVersion() === originalMigrations[originalMigrations.length - 1].version, 'fresh install: schema reaches latest');

  const cashClosuresCols = tableInfo(db, 'cash_closures').map((col) => col.name);
  assert(cashClosuresCols.length > 0, 'fresh install: cash_closures table present');
  assert(
    cashClosuresCols.includes('z_number'),
    'fresh install: cash_closures table has expected columns'
  );
  assert(
    ['opening_float_cents', 'expected_cash_cents', 'counted_cash_cents', 'variance_cents',
     'gross_collected_cents', 'refunded_cents', 'net_collected_cents'].every(
      (column) => columnType(db, 'cash_closures', column) === 'INTEGER'
    ),
    'fresh install: every money column is INTEGER cents'
  );

  const partialIndex = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND name='cash_closures_one_day'`
  ).get() as { sql: string } | undefined;
  assert(
    !!partialIndex && partialIndex.sql.includes('WHERE scope = \'day\''),
    'fresh install: partial unique index on business_date WHERE scope=\'day\' is created'
  );

  // ── nextZNumber(): per-install monotonic ──────────────────────────────
  const first = nextZNumber();
  const second = nextZNumber();
  assert(first === 1, 'nextZNumber returns 1 on first call');
  assert(second === 2, 'nextZNumber returns 2 on second call');

  closeDatabase();
  fs.rmSync(testDirA, { recursive: true, force: true });

  // ── Upgrade path: v80 → v81 ───────────────────────────────────────────
  const testDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v81-b-'));
  activeTestDir = testDirB;
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 80));
  initDatabase();
  db = getDatabase();
  assert(getCurrentSchemaVersion() === 80, 'setup: store B starts at schema v80');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cash_closures'").get(), 'setup: store B has no cash_closures yet');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();

  assert(getCurrentSchemaVersion() === originalMigrations[originalMigrations.length - 1].version, 'upgrade: store B reaches latest schema');
  assert(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cash_closures'").get(), 'upgrade: cash_closures created');
  assert(
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='cash_closures_one_day'").get(),
    'upgrade: partial index created'
  );

  closeDatabase();
  fs.rmSync(testDirB, { recursive: true, force: true });

  // ── Behavioral invariants: partial index + UNIQUE(z_number) ───────────
  const testDirC = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v81-c-'));
  activeTestDir = testDirC;
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  initDatabase();
  db = getDatabase();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('owner-1','Owner','o@t.local','x','owner',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
  const insertDay = db.prepare(`INSERT INTO cash_closures (scope,business_date,period_start,period_end,opening_float_cents,expected_cash_cents,counted_cash_cents,variance_cents,gross_collected_cents,refunded_cents,net_collected_cents,bill_count,refund_count,z_number,closed_by) VALUES ('day','2026-09-05','2026-09-05T00:00:00Z','2026-09-06T00:00:00Z',0,0,0,0,0,0,0,0,0,1,'owner-1')`);
  insertDay.run();
  let threw = false; try { insertDay.run(); } catch { threw = true; } assert(threw, 'invariant: second same-date day row throws');
  let ok = false; try { db.prepare(`INSERT INTO cash_closures (scope,business_date,period_start,period_end,opening_float_cents,expected_cash_cents,counted_cash_cents,variance_cents,gross_collected_cents,refunded_cents,net_collected_cents,bill_count,refund_count,z_number,closed_by) VALUES ('session','2026-09-05','2026-09-05T00:00:00Z','2026-09-06T00:00:00Z',0,0,0,0,0,0,0,0,0,2,'owner-1')`).run(); ok = true; } catch {} assert(ok, 'invariant: same-date scope=session row does NOT throw');
  threw = false; try { db.prepare(`INSERT INTO cash_closures (scope,business_date,period_start,period_end,opening_float_cents,expected_cash_cents,counted_cash_cents,variance_cents,gross_collected_cents,refunded_cents,net_collected_cents,bill_count,refund_count,z_number,closed_by) VALUES ('day','2026-9-5','2026-09-05T00:00:00Z','2026-09-06T00:00:00Z',0,0,0,0,0,0,0,0,0,3,'owner-1')`).run(); } catch { threw = true; } assert(threw, 'invariant: malformed business_date (GLOB CHECK) throws');
  threw = false; try { db.prepare(`INSERT INTO cash_closures (scope,business_date,period_start,period_end,opening_float_cents,expected_cash_cents,counted_cash_cents,variance_cents,gross_collected_cents,refunded_cents,net_collected_cents,bill_count,refund_count,z_number,closed_by) VALUES ('day','2026-09-06','2026-09-06T00:00:00Z','2026-09-07T00:00:00Z',0,0,0,0,0,0,0,0,0,1,'owner-1')`).run(); } catch { threw = true; } assert(threw, 'invariant: duplicate z_number throws');
  closeDatabase();
  fs.rmSync(testDirC, { recursive: true, force: true });

  console.log(`\n${passed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
