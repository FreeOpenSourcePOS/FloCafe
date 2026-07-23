/**
 * Regression: "SQLite error: no such column: country_code" on upgrade
 *
 * Reported on a fresh Windows install of v1.9.7: the app failed to start
 * entirely with "Initialization error: Failed to start Flo: SQLite error:
 * no such column: country_code".
 *
 * Root cause: country_code (and, found in the same sweep, tag_counts) were
 * added to createSchema()'s CREATE TABLE for `customers`, but since that
 * statement is CREATE TABLE IF NOT EXISTS, any install whose customers
 * table already existed before those columns were added never actually
 * gets them — no migration ever ran an ALTER TABLE ADD COLUMN for either.
 * Migration v23 (normalize_customer_phones) is the first thing that reads
 * country_code, so it crashed there on every such upgrade. tag_counts is
 * worse: it's read/written on every order placed for a returning customer
 * (main/routes/orders.ts), so an affected install wouldn't crash at
 * startup at all — it'd crash mid-use, on the first repeat-customer order.
 *
 * Fix: v23 now guards country_code with an ALTER TABLE before it's used
 * (can't add a new migration before it — version numbers are sequential
 * and migrations run in array order — so the guard has to live inside the
 * migration that first depends on it). A new v29 guards tag_counts the
 * same way.
 *
 * This test simulates the actual crash scenario: run only migrations up
 * through v22 for real, then hand-drop both columns from the customers
 * table (reproducing an old, pre-both-columns install), then run the rest
 * of the chain and confirm it does NOT crash and both columns exist
 * afterward, correctly populated.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-windows-country-code-crash.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-country-code-crash-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-country-code-crash';

const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, now } = require('../main/db');

let passed = 0, failed = 0, total = 0;
function assert(condition: boolean, message: string) {
  total++;
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}
function assertEqual(actual: any, expected: any, message: string) {
  total++;
  if (actual === expected) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function main() {
  console.log('Regression: Windows "no such column: country_code" crash on upgrade');
  console.log('='.repeat(60));

  const originalMigrations = MIGRATIONS.slice();
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((m: any) => m.version <= 22));

  initDatabase();
  const db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), 22, 'setup: ran only through v22 for real');

  // Simulate an old install: a customers table from before both columns existed.
  db.exec('ALTER TABLE customers DROP COLUMN country_code');
  db.exec('ALTER TABLE customers DROP COLUMN tag_counts');
  const preColumns = db.prepare('PRAGMA table_info(customers)').all().map((c: any) => c.name);
  assert(!preColumns.includes('country_code'), 'setup: country_code removed to simulate an old install');
  assert(!preColumns.includes('tag_counts'), 'setup: tag_counts removed to simulate an old install');

  db.prepare(`INSERT INTO customers (id, name, phone, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('cust-old', 'Old Customer', '9876543210', 1, now(), now());

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);

  let crashError: Error | null = null;
  try {
    for (const migration of originalMigrations) {
      if (migration.version <= getCurrentSchemaVersion()) continue;
      db.transaction(() => {
        migration.up();
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
  } catch (err: any) {
    crashError = err;
  }

  assert(crashError === null, `the rest of the migration chain runs without crashing${crashError ? ` (threw: ${crashError.message})` : ''}`);

  const postColumns = db.prepare('PRAGMA table_info(customers)').all().map((c: any) => c.name);
  assert(postColumns.includes('country_code'), 'country_code exists after the full chain runs');
  assert(postColumns.includes('tag_counts'), 'tag_counts exists after the full chain runs');

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get('cust-old') as any;
  assertEqual(customer.country_code, '+91', 'country_code was backfilled to the default and the phone normalized correctly');
  assertEqual(customer.phone, '+919876543210', 'phone was normalized to E.164 by v23, proving it ran to completion (not just avoided crashing)');

  // The exact hot path that was the worse of the two bugs: reading
  // tag_counts for a returning customer, as routes/orders.ts does on every
  // order. This must not throw "no such column: tag_counts".
  let tagCountsReadError: Error | null = null;
  try {
    db.prepare('SELECT tag_counts FROM customers WHERE id = ?').get('cust-old');
  } catch (err: any) {
    tagCountsReadError = err;
  }
  assert(tagCountsReadError === null, 'reading tag_counts (the routes/orders.ts hot path) does not throw');

  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
