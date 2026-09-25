/**
 * Migration registry invariant guard.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-registry.test.ts
 *
 * runMigrations() takes its target from the array tail, not from the maximum
 * version (main/db.ts), and nothing asserted that the array is well formed. A
 * registry that is duplicated, out of order, or missing its tail entry is an
 * unrecoverable upgrade-bricking mode: the tail target is what the app reports
 * as its supported version, and the run loop applies only entries above the
 * database's current version, so a bad registry silently produces a
 * half-migrated database.
 *
 * The obvious runtime fix — targeting Math.max — is deliberately NOT what this
 * change does. If the array were ever non-monotonic, Math.max would select a
 * target no migration reaches and the run would silently no-op, replacing
 * today's loud SchemaVersionMismatchError with a quiet half-migrated database.
 * The assertion is the fix; the execution change is a separate decision.
 *
 * The snapshot below is taken at module load, before anything can mutate the
 * exported array. That matters: tests/inventory-ledger.test.ts reassigns
 * MIGRATIONS in place to build upgrade fixtures, which is precisely why this
 * invariant must not also be enforced from inside runMigrations(), where it
 * would run against a truncated registry.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-registry-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, getCurrentSchemaVersion, closeDatabase } = require('../main/db');
const {
  assert, assertEqual, assertGreaterThan, getResults, resetCounters,
} = require('./helpers/test-setup');

// Pristine module-load snapshot: the shape runMigrations() reads, captured
// before initDatabase() and before any suite can push into the live array.
const PRISTINE_REGISTRY = require('../main/db').MIGRATIONS.map((m: any) => ({ version: m.version, name: m.name }));

function main() {
  resetCounters();

  assert(PRISTINE_REGISTRY.length > 0, 'the migration registry is non-empty');

  assertEqual(PRISTINE_REGISTRY[0].version, 1, 'the registry starts at version 1');

  const seen = new Map<number, string>();
  let previous = 0;
  for (const { version, name } of PRISTINE_REGISTRY) {
    assert(
      Number.isInteger(version),
      `migration ${name} declares an integer version (got ${JSON.stringify(version)})`,
    );
    assertGreaterThan(version, previous, `migration v${version} (${name}) sorts after v${previous}`);
    const firstSeenAt = seen.get(version);
    assert(
      firstSeenAt === undefined,
      firstSeenAt === undefined
        ? `version ${version} (${name}) is unique`
        : `version ${version} is declared twice (${firstSeenAt} and ${name})`,
    );
    if (firstSeenAt === undefined) seen.set(version, name);
    previous = version;
  }

  assert(
    previous === PRISTINE_REGISTRY[PRISTINE_REGISTRY.length - 1].version,
    'the tail entry carries the highest version, so the array tail is a valid migration target',
  );

  // The tail is what runMigrations() reports as the app's supported version,
  // so a migrated store and a fresh install must agree on the same number.
  initDatabase();
  try {
    assertEqual(
      getCurrentSchemaVersion(),
      PRISTINE_REGISTRY[PRISTINE_REGISTRY.length - 1].version,
      'a freshly initialized database reaches the last registry version',
    );
    const userVersion = getDatabase().pragma('user_version', { simple: true });
    assertEqual(
      userVersion,
      PRISTINE_REGISTRY[PRISTINE_REGISTRY.length - 1].version,
      'user_version matches the registry tail',
    );
  } finally {
    closeDatabase();
    fs.rmSync(activeTestDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(
    `\nMigration registry: ${results.passed}/${results.total} checks passed ` +
    `(${PRISTINE_REGISTRY.length} migrations, v${PRISTINE_REGISTRY[0].version}..v${PRISTINE_REGISTRY[PRISTINE_REGISTRY.length - 1].version}).`,
  );
  if (results.failed > 0) process.exit(1);
}

main();
