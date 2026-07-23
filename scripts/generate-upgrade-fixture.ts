/**
 * Generates an authentic "frozen at schema vN" database fixture for
 * tests/upgrade-path.test.ts, by running the real migration chain
 * (main/db.ts MIGRATIONS) but stopping partway through — exactly what an
 * install that hasn't been updated since schema vN would look like today.
 *
 * Usage:
 *   node tests/run-electron-node-test.cjs scripts/generate-upgrade-fixture.ts <version> <output-path>
 *
 * Example (the fixture behind the #133/country_code+tag_counts bug, see
 * commit 9c92409 — customers.country_code/tag_counts were added straight to
 * createSchema() without a paired migration for existing installs, so any
 * install still on schema v22 crashed once it reached migration v23):
 *   node tests/run-electron-node-test.cjs scripts/generate-upgrade-fixture.ts 22 \
 *     tests/fixtures/upgrade-snapshots/schema-v22-pre-customer-columns-fix.db
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const [, , versionArg, outPath] = process.argv;
if (!versionArg || !outPath) {
  console.error('Usage: generate-upgrade-fixture.ts <version> <output-path>');
  process.exit(1);
}
const capVersion = parseInt(versionArg, 10);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fixture-src-'));

const Module = require('module');
const originalLoad = Module._load;
const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => outDir,
  getVersion: () => 'fixture-gen',
};
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const dbModule = require('../main/db');

// MIGRATIONS is a top-level `export const` array — mutating it in place
// (rather than reassigning) keeps the same reference that runMigrations()
// closes over internally, so capping it here actually caps what
// initDatabase() applies.
const allMigrations = dbModule.MIGRATIONS.slice();
const capped = allMigrations.filter((m: { version: number }) => m.version <= capVersion);
if (capped.length === allMigrations.length) {
  console.error(`Version ${capVersion} is >= the latest migration; nothing would be capped.`);
  process.exit(1);
}
dbModule.MIGRATIONS.length = 0;
dbModule.MIGRATIONS.push(...capped);

dbModule.initDatabase();
const reached = dbModule.getCurrentSchemaVersion();
dbModule.closeDatabase();

if (reached !== capVersion) {
  console.error(`Expected to land on schema v${capVersion}, actually reached v${reached}.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.copyFileSync(path.join(outDir, 'flo.db'), outPath);
console.log(`Fixture written to ${outPath} (schema v${reached}, ${fs.statSync(outPath).size} bytes)`);
