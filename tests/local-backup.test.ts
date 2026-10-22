import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-local-backup-'));
const documentsDir = path.join(testDir, 'documents');
const userDataDir = path.join(testDir, 'userData');
fs.mkdirSync(documentsDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: (name: string) => (name === 'documents' ? documentsDir : userDataDir),
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import Database from 'better-sqlite3';
import { closeDatabase, getDatabase, initDatabase } from '../main/db';
import {
  LOCAL_BACKUP_RETENTION,
  getLastLocalBackupAt,
  getLocalBackupDir,
  isLocalBackupDue,
  isLocalBackupEnabled,
  listLocalBackups,
  localBackup,
  localBackupFileName,
  parseLocalBackupTime,
  pruneLocalBackups,
  retainBackupLocally,
  setLocalBackupEnabled,
} from '../main/services/local-backup';

const HOUR = 60 * 60_000;

async function main(): Promise<void> {
  const backupDir = getLocalBackupDir();
  assert.equal(backupDir, path.join(documentsDir, 'FloCafe', 'Backups'));

  const stamp = new Date('2026-10-22T13:05:09.456Z');
  assert.equal(localBackupFileName(stamp), 'flo-backup-2026-10-22T13-05-09Z.db');
  assert.equal(parseLocalBackupTime(localBackupFileName(stamp)), Date.UTC(2026, 9, 22, 13, 5, 9));
  assert.equal(parseLocalBackupTime('flo-backup-2026-10-22T13-05-09Z.db.tmp'), null);
  assert.equal(parseLocalBackupTime('notes.db'), null);

  assert.equal(isLocalBackupDue(undefined), true, 'no backup yet is due');
  const newest = localBackupFileName(new Date(Date.now() - 23 * HOUR));
  assert.equal(isLocalBackupDue(newest), false, 'a backup under 24h old is not due');
  assert.equal(
    isLocalBackupDue(localBackupFileName(new Date(Date.now() - 25 * HOUR))),
    true,
    'a backup over 24h old is due',
  );

  initDatabase();
  const db = getDatabase();

  assert.equal(isLocalBackupEnabled(), true, 'enabled by default');

  await localBackup.runIfDue();
  assert.deepEqual(listLocalBackups(backupDir), [], 'a never-used database is not backed up');

  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('c1', 'Drinks');
  db.prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)').run(
    'p1',
    'c1',
    'Flat White',
    4.5,
  );

  setLocalBackupEnabled(false);
  assert.equal(isLocalBackupEnabled(), false);
  await localBackup.runIfDue();
  assert.deepEqual(listLocalBackups(backupDir), [], 'disabled setting creates no backup');

  setLocalBackupEnabled(true);
  await localBackup.runIfDue();
  const [first, ...rest] = listLocalBackups(backupDir);
  assert.ok(first, 'a backup is written when due');
  assert.equal(rest.length, 0);
  assert.ok(getLastLocalBackupAt(backupDir), 'last backup time is reported');
  const copy = new Database(path.join(backupDir, first), { readonly: true });
  try {
    const row = copy.prepare('SELECT name FROM products WHERE id = ?').get('p1') as { name: string };
    assert.equal(row.name, 'Flat White', 'the backup contains the data');
  } finally {
    copy.close();
  }
  assert.deepEqual(
    fs.readdirSync(backupDir).filter((name) => name.startsWith('.')),
    [],
    'no staging files are left behind',
  );

  await localBackup.runIfDue();
  assert.equal(listLocalBackups(backupDir).length, 1, 'a second run within 24h adds nothing');

  fs.unlinkSync(path.join(backupDir, first));
  const foreign = ['notes.txt', 'flo-backup-manual.db', 'flo-backup-2026-10-22T13-05-09Z.db.bak'];
  for (const name of foreign) fs.writeFileSync(path.join(backupDir, name), 'keep me');
  for (let day = 1; day <= 7; day++) {
    const name = localBackupFileName(new Date(Date.UTC(2026, 0, day, 3, 0, 0)));
    fs.writeFileSync(path.join(backupDir, name), 'old');
  }
  const removed = pruneLocalBackups(backupDir);
  assert.equal(removed.length, 7 - LOCAL_BACKUP_RETENTION);
  const kept = listLocalBackups(backupDir);
  assert.equal(kept.length, LOCAL_BACKUP_RETENTION);
  assert.equal(kept[0], localBackupFileName(new Date(Date.UTC(2026, 0, 7, 3, 0, 0))), 'newest kept');
  assert.ok(!kept.includes(localBackupFileName(new Date(Date.UTC(2026, 0, 1, 3, 0, 0)))), 'oldest dropped');
  for (const name of foreign) assert.ok(fs.existsSync(path.join(backupDir, name)), `${name} untouched`);

  await localBackup.runIfDue();
  const afterDue = listLocalBackups(backupDir);
  assert.equal(afterDue.length, LOCAL_BACKUP_RETENTION, 'a new backup pushes out the oldest');
  assert.ok(
    afterDue[0] > localBackupFileName(new Date(Date.UTC(2026, 0, 7, 3, 0, 0))),
    'the new backup is the newest',
  );

  const source = path.join(testDir, 'pre-reset.db');
  fs.writeFileSync(source, 'pre-reset snapshot');
  const retained = retainBackupLocally(source);
  assert.ok(retained && fs.readFileSync(retained, 'utf8') === 'pre-reset snapshot', 'copy is kept');
  assert.ok(listLocalBackups(backupDir).includes(path.basename(retained as string)));
  assert.equal(listLocalBackups(backupDir).length, LOCAL_BACKUP_RETENTION, 'retention still applies');
  setLocalBackupEnabled(false);
  assert.equal(retainBackupLocally(source), null, 'respects the off switch');

  await localBackup.stop();
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('local backup tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
