/**
 * #278 (AC 4): production installs must not silently start over with a new,
 * empty database when the real one has gone missing (deleted, unmounted
 * drive, wrong path). Covers:
 *  - fresh install (no prior init marker) still creates a database normally
 *  - a missing db file on an already-initialized production install fails
 *    closed instead of silently recreating a blank one
 *  - the disposable E2E db-path override (FLO_E2E_DB_PATH) bypasses the
 *    guard, same as it bypasses every other path-dependent production check
 *  - internal maintenance call sites (resetDatabaseWithBackup) that
 *    deliberately recreate the db file are unaffected by the new guard
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fail-closed-missing-db-'));
const mockApp = { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' };

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: mockApp };
  }
  return originalLoad.apply(this, arguments as any);
};

import { closeDatabase, getDatabase, getDbPath, initDatabase, resetDatabaseWithBackup } from '../main/db';

function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

async function run() {
  console.log('Testing fail-closed behavior for a missing production database...');
  const dbPath = getDbPath();
  const markerPath = path.join(testDir, '.flo-db-initialized');

  try {
    // 1. Fresh install: no marker yet, no db yet — must succeed normally and
    //    leave a marker behind for future boots to check against.
    assert.equal(fs.existsSync(markerPath), false, 'no init marker before first boot');
    initDatabase();
    assert.equal(fs.existsSync(dbPath), true, 'fresh install creates the database');
    assert.equal(fs.existsSync(markerPath), true, 'successful production init writes the marker');

    // Keep a pristine snapshot of the healthy db so later steps can restore it.
    closeDatabase();
    const snapshotPath = path.join(testDir, 'snapshot.db');
    fs.copyFileSync(dbPath, snapshotPath);

    // 2. Simulate the db file disappearing on an already-initialized install
    //    (deleted, wrong mount, etc.) — must fail closed, not recreate blank.
    removeDbFiles(dbPath);
    assert.throws(
      () => initDatabase(),
      (err: any) => err?.code === 'ERR_DATABASE_MISSING',
      'missing db on an initialized production install throws ERR_DATABASE_MISSING',
    );
    assert.equal(fs.existsSync(dbPath), false, 'refusing to start does not create a new blank database file');

    // 3. The disposable E2E db-path override bypasses the guard entirely,
    //    same as it bypasses getDbPath()'s normal production resolution.
    const e2eDbPath = path.join(testDir, 'e2e-flo.db');
    process.env.FLO_E2E_DB_PATH = e2eDbPath;
    try {
      initDatabase();
      assert.equal(fs.existsSync(e2eDbPath), true, 'FLO_E2E_DB_PATH override may still create a fresh database');
      closeDatabase();
    } finally {
      delete process.env.FLO_E2E_DB_PATH;
    }

    // 4. Restore the pristine snapshot and confirm the internal maintenance
    //    path (resetDatabaseWithBackup) — which deliberately deletes and
    //    recreates the db file itself via initDatabase(false, true) — is
    //    unaffected by the new guard.
    fs.copyFileSync(snapshotPath, dbPath);
    initDatabase();
    const { backupPath } = await resetDatabaseWithBackup();
    assert.equal(fs.existsSync(backupPath), true, 'reset takes a safety backup before wiping');
    assert.equal(fs.existsSync(dbPath), true, 'reset recreates the database file');
    assert.equal(
      (getDatabase().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count,
      0,
      'reset produces a genuinely blank database',
    );

    console.log('✅ Fail-closed missing-database tests passed');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
