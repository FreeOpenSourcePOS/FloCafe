/**
 * Restore refusal + pre-restore safety copy tests.
 *
 * Two things this pins that nothing else did:
 *  1. a restore refuses a file that is not a usable Flo database, and a file
 *     from a newer schema version, WITHOUT touching the live database; and
 *  2. a *successful* restore keeps a recoverable copy of the data it replaced,
 *     visible through the same listBackups() listing the settings screen uses.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/restore-safety-copy.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-safety-copy-'));
const backupDir = path.join(testDir, 'backups');

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import Database from 'better-sqlite3';
import {
  closeDatabase,
  createBackup,
  getCurrentSchemaVersion,
  getDatabase,
  initDatabase,
  isManagedBackupFile,
  listBackups,
  restoreBackup,
} from '../main/db';

function stampVersion(sourcePath: string, destinationPath: string, schemaVersion: number): void {
  fs.copyFileSync(sourcePath, destinationPath);
  const stamped = new Database(destinationPath);
  stamped.pragma('foreign_keys = OFF');
  stamped.prepare("UPDATE _flo_meta SET value = ? WHERE key = 'schema_version'").run(String(schemaVersion));
  stamped.pragma(`user_version = ${schemaVersion}`);
  stamped.close();
}

function safetyCopies(): string[] {
  return fs.readdirSync(backupDir).filter((name) => name.includes('-pre-restore-'));
}

async function run() {
  fs.mkdirSync(backupDir, { recursive: true });
  initDatabase();
  const currentVersion = getCurrentSchemaVersion();

  getDatabase().prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('safe-category', 'Survivor');

  const validBackup = (await createBackup()).path;

  // --- 1. a file that is not a usable database is refused -------------------
  const notADatabase = path.join(testDir, 'not-a-database.db');
  fs.writeFileSync(notADatabase, 'this is definitely not a sqlite file');
  const refusedGarbage = restoreBackup(notADatabase, true);
  assert.equal(refusedGarbage.success, false, 'a non-database file is refused');
  assert.equal(
    (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get('safe-category') as { name: string }).name,
    'Survivor',
    'refusing a non-database file leaves live data untouched',
  );

  // A truncated copy of a genuine backup must be refused too, not half-applied.
  const truncated = path.join(testDir, 'truncated.db');
  const validBytes = fs.readFileSync(validBackup);
  fs.writeFileSync(truncated, validBytes.subarray(0, Math.floor(validBytes.length / 3)));
  const refusedTruncated = restoreBackup(truncated, true);
  assert.equal(refusedTruncated.success, false, 'a truncated backup is refused');
  assert.equal(
    (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get('safe-category') as { name: string }).name,
    'Survivor',
    'refusing a truncated backup leaves live data untouched',
  );

  // A directory is not a restorable source.
  const refusedDirectory = restoreBackup(backupDir, true);
  assert.equal(refusedDirectory.success, false, 'a directory is refused as a restore source');

  // --- 2. a newer schema version is refused, live data untouched ------------
  const newerSchema = path.join(testDir, 'newer-schema.db');
  stampVersion(validBackup, newerSchema, currentVersion + 1);
  const refusedNewer = restoreBackup(newerSchema, true);
  assert.equal(refusedNewer.success, false, 'a newer-schema backup is refused in direct mode');
  assert.equal(getCurrentSchemaVersion(), currentVersion, 'live schema version is unchanged after a newer-schema refusal');
  assert.equal(
    (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get('safe-category') as { name: string }).name,
    'Survivor',
    'refusing a newer-schema backup leaves live data untouched',
  );

  // --- 3. a successful restore keeps a discoverable pre-restore copy --------
  // Take the backup first, then change the data, so the restore replaces rows
  // that the retained copy must still contain.
  const restoreSource = (await createBackup()).path;
  getDatabase().prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('post-backup-category', 'Added After Backup');

  const succeeded = restoreBackup(restoreSource, true);
  assert.equal(succeeded.success, true, 'same-schema direct restore succeeds');

  assert.equal(
    (getDatabase().prepare('SELECT id FROM categories WHERE id = ?').get('post-backup-category') as { id: string } | undefined)?.id,
    undefined,
    'the restore replaced the data added after the backup was taken',
  );

  const retained = safetyCopies();
  assert.equal(retained.length, 1, `a successful restore retains exactly one pre-restore copy (found: ${JSON.stringify(retained)})`);

  // The whole point of retention: the copy is discoverable through the normal
  // listing, not just present on disk.
  const listed = listBackups();
  const listedSafetyCopy = listed.find((entry) => entry.fileName === retained[0]);
  assert.ok(listedSafetyCopy, 'the pre-restore copy appears in listBackups()');
  assert.equal(listedSafetyCopy?.kind, 'auto', 'the pre-restore copy is classified as an automatic backup');
  assert.ok(listedSafetyCopy && listedSafetyCopy.sizeBytes > 0, 'the pre-restore copy reports a size');

  // ...and it is restorable through the same preset-path route the settings
  // screen uses, because it is a managed backup file.
  assert.equal(isManagedBackupFile(path.join(backupDir, retained[0])), true, 'the pre-restore copy is a restorable managed backup file');

  // It really does contain the replaced data, so the customer can undo.
  const undo = restoreBackup(path.join(backupDir, retained[0]), true);
  assert.equal(undo.success, true, 'the retained pre-restore copy can itself be restored');
  assert.equal(
    (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get('post-backup-category') as { name: string }).name,
    'Added After Backup',
    'restoring the pre-restore copy brings the replaced data back',
  );

  // --- 4. retention is bounded ---------------------------------------------
  for (let attempt = 0; attempt < 6; attempt++) {
    getDatabase().prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(`bounded-${attempt}`, `Bounded ${attempt}`);
    const roundSource = (await createBackup()).path;
    assert.equal(restoreBackup(roundSource, true).success, true, `bounded-retention round ${attempt} restores`);
  }
  const bounded = safetyCopies();
  assert.ok(bounded.length > 0, 'bounded retention still keeps recent pre-restore copies');
  assert.ok(bounded.length <= 3, `bounded retention caps pre-restore copies at 3 (found ${bounded.length})`);

  console.log('✅ Restore refusal and pre-restore safety copy tests passed');
}

run()
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
