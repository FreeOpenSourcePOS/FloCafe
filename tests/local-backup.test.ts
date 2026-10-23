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

let documentsThrows = false;
const ipcHandlers = new Map<string, (...args: any[]) => any>();
const mainFrame = {
  frameToken: 'main-frame-token',
  detached: false,
  url: 'http://localhost:3001/',
};
const mainWin = {
  isDestroyed: () => false,
  webContents: { mainFrame, getURL: () => 'http://localhost:3001/' },
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: (name: string) => {
          if (name === 'documents') {
            if (documentsThrows) throw new Error('Failed to get documents path');
            return documentsDir;
          }
          return userDataDir;
        },
        getVersion: () => 'test',
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8'),
      },
      ipcMain: {
        on: () => {},
        handle: (channel: string, listener: (...args: any[]) => any) => {
          ipcHandlers.set(channel, listener);
        },
        removeHandler: () => {},
      },
      BrowserWindow: {
        fromWebContents: (sender: unknown) => (sender === mainWin.webContents ? mainWin : null),
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
import Database from 'better-sqlite3';
import {
  closeDatabase,
  createBackup,
  getDatabase,
  initDatabase,
  now,
  resetDatabaseForCurrencyChange,
  resetDatabaseWithBackup,
  restoreBackup,
} from '../main/db';
import { registerIpcHandlers } from '../main/ipc';
import { databaseToolsRoutes } from '../main/routes/database-tools';
import { resetMasterPin } from '../main/services/master-pin';
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
  documentsThrows = true;
  try {
    assert.equal(
      getLocalBackupDir(),
      path.join(userDataDir, 'FloCafe', 'Backups'),
      'falls back to userData when documents path is unavailable',
    );
  } finally {
    documentsThrows = false;
  }

  const stamp = new Date('2026-10-22T13:05:09.456Z');
  assert.equal(localBackupFileName(stamp), 'flo-backup-2026-10-22T13-05-09-456Z.db');
  assert.equal(
    parseLocalBackupTime(localBackupFileName(stamp)),
    Date.UTC(2026, 9, 22, 13, 5, 9, 456),
  );
  assert.equal(
    parseLocalBackupTime('flo-backup-2026-10-22T13-05-09Z.db'),
    Date.UTC(2026, 9, 22, 13, 5, 9),
    'backups named before millisecond precision are still recognized',
  );
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
  assert.equal(
    isLocalBackupDue(localBackupFileName(new Date(Date.now() + 2 * HOUR))),
    true,
    'a future-dated backup from clock skew is due',
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
    const row = copy.prepare('SELECT name FROM products WHERE id = ?').get('p1') as {
      name: string;
    };
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
  assert.equal(
    kept[0],
    localBackupFileName(new Date(Date.UTC(2026, 0, 7, 3, 0, 0))),
    'newest kept',
  );
  assert.ok(
    !kept.includes(localBackupFileName(new Date(Date.UTC(2026, 0, 1, 3, 0, 0)))),
    'oldest dropped',
  );
  for (const name of foreign)
    assert.ok(fs.existsSync(path.join(backupDir, name)), `${name} untouched`);

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
  assert.equal(
    listLocalBackups(backupDir).length,
    LOCAL_BACKUP_RETENTION,
    'retention still applies',
  );

  assert.notEqual(
    localBackupFileName(new Date('2026-10-22T13:05:09.100Z')),
    localBackupFileName(new Date('2026-10-22T13:05:09.900Z')),
    'snapshots in the same second get distinct names',
  );
  const firstCopy = retainBackupLocally(source);
  const secondCopy = retainBackupLocally(source);
  assert.ok(
    firstCopy && secondCopy && firstCopy !== secondCopy,
    'back-to-back copies never share a name',
  );
  assert.ok(fs.existsSync(firstCopy as string) && fs.existsSync(secondCopy as string));

  for (const name of listLocalBackups(backupDir)) fs.unlinkSync(path.join(backupDir, name));
  for (let day = 1; day <= LOCAL_BACKUP_RETENTION; day++) {
    const name = localBackupFileName(new Date(Date.UTC(2026, 0, day, 3, 0, 0)));
    fs.writeFileSync(path.join(backupDir, name), 'old');
  }
  const realDateNow = Date.now;
  const pinnedNow = realDateNow() - 10_000;
  Date.now = () => pinnedNow;
  try {
    const burst: string[] = [];
    for (let idx = 0; idx < LOCAL_BACKUP_RETENTION + 2; idx++) {
      const copyPath = retainBackupLocally(source);
      assert.ok(copyPath, 'same-millisecond copy succeeds');
      burst.push(path.basename(copyPath));
      if (idx === 1) {
        assert.deepEqual(
          listLocalBackups(backupDir).slice(0, 2),
          [burst[1], burst[0]],
          'same-millisecond copies sort newest-first ahead of older backups',
        );
      }
    }
    assert.deepEqual(
      burst,
      Array.from({ length: LOCAL_BACKUP_RETENTION + 2 }, (_, idx) =>
        localBackupFileName(new Date(pinnedNow + idx)),
      ),
      'same-millisecond copies advance monotonically even after earlier slots are pruned',
    );
    assert.deepEqual(
      listLocalBackups(backupDir),
      burst.slice(-LOCAL_BACKUP_RETENTION).reverse(),
      'retention keeps the newest same-millisecond copies',
    );
    assert.equal(
      getLastLocalBackupAt(backupDir),
      new Date(pinnedNow + LOCAL_BACKUP_RETENTION + 1).toISOString(),
    );
    assert.equal(isLocalBackupDue(listLocalBackups(backupDir)[0]), false);
  } finally {
    Date.now = realDateNow;
  }

  for (const name of listLocalBackups(backupDir)) fs.unlinkSync(path.join(backupDir, name));
  const legacyName = 'flo-backup-2026-01-02T03-00-00Z.db';
  const precise = localBackupFileName(new Date('2026-01-02T03:00:00.500Z'));
  fs.writeFileSync(path.join(backupDir, legacyName), 'legacy');
  fs.writeFileSync(path.join(backupDir, precise), 'precise');
  assert.deepEqual(
    listLocalBackups(backupDir),
    [precise, legacyName],
    'legacy and current names are listed together in time order',
  );

  for (const name of listLocalBackups(backupDir)) fs.unlinkSync(path.join(backupDir, name));
  const futureNames = Array.from({ length: LOCAL_BACKUP_RETENTION }, (_, idx) =>
    localBackupFileName(new Date(Date.now() + (idx + 1) * 24 * HOUR)),
  );
  for (const name of futureNames) fs.writeFileSync(path.join(backupDir, name), 'future');
  await localBackup.runIfDue();
  const afterClockFix = listLocalBackups(backupDir);
  assert.equal(
    afterClockFix.length,
    LOCAL_BACKUP_RETENTION,
    'retention still applies after a clock fix',
  );
  const written = afterClockFix.filter((name) => !futureNames.includes(name));
  assert.equal(written.length, 1, 'the snapshot written after a clock fix is kept');
  assert.ok((parseLocalBackupTime(written[0]) as number) <= Date.now());
  assert.equal(afterClockFix[0], written[0], 'future-dated backups rank below the real one');
  assert.equal(
    getLastLocalBackupAt(backupDir),
    new Date(parseLocalBackupTime(written[0]) as number).toISOString(),
    'last backup time ignores future-dated files',
  );
  await localBackup.runIfDue();
  assert.deepEqual(
    listLocalBackups(backupDir),
    afterClockFix,
    'future-dated backups do not make a fresh real backup due again',
  );

  setLocalBackupEnabled(false);
  assert.equal(retainBackupLocally(source), null, 'respects the off switch');

  for (const name of listLocalBackups(backupDir)) {
    fs.unlinkSync(path.join(backupDir, name));
  }
  const ensureOwner = () =>
    getDatabase()
      .prepare(
        "INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('owner-1', 'Owner', 'hash', 'owner', 1)",
      )
      .run();
  ensureOwner();
  resetMasterPin('1234');
  setLocalBackupEnabled(false);

  const api = express();
  api.use(express.json());
  api.use((req: any, _res: any, next: any) => {
    req.user = { userId: 'owner-1', email: 'owner@flo.local', role: 'owner' };
    next();
  });
  api.use('/api/db-tools', databaseToolsRoutes);

  const initRes = await request(api)
    .post('/api/db-tools/initialize')
    .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });
  assert.equal(initRes.status, 200, 'initialize succeeds when local backup is disabled');
  assert.deepEqual(
    listLocalBackups(backupDir),
    [],
    'initialize does not copy backup to local backup dir when disabled',
  );
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after database initialize',
  );
  assert.equal(initRes.body.localBackupFailed, false, 'no warning when local backup is off');

  ensureOwner();
  setLocalBackupEnabled(true);
  const keptRes = await request(api)
    .post('/api/db-tools/initialize')
    .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });
  assert.equal(keptRes.status, 200);
  assert.equal(keptRes.body.localBackupFailed, false, 'no warning when the copy is kept');
  assert.equal(listLocalBackups(backupDir).length, 1, 'initialize keeps a local copy when enabled');

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.writeFileSync(backupDir, 'not a folder');
  ensureOwner();
  const failedRes = await request(api)
    .post('/api/db-tools/initialize')
    .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });
  assert.equal(failedRes.status, 200, 'the committed reset is still reported as done');
  assert.equal(failedRes.body.success, true);
  assert.equal(failedRes.body.localBackupFailed, true, 'a failed local copy is reported');
  fs.rmSync(backupDir, { force: true });

  // Currency reset: preserves local_backup_enabled = 'false' (including when products survive)
  // and retains the pre-reset backup locally when enabled.
  const seedStoreForCurrencyReset = (currencyCode: string) => {
    ensureOwner();
    const curDb = getDatabase();
    const stampValue = now();
    const writeSetting = curDb.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    );
    writeSetting.run('country', 'US', stampValue);
    writeSetting.run('currency', currencyCode, stampValue);
    writeSetting.run('timezone', 'America/New_York', stampValue);
    curDb
      .prepare('INSERT OR IGNORE INTO categories (id, name) VALUES (?, ?)')
      .run('c-reset', 'Coffee');
    curDb
      .prepare('INSERT OR IGNORE INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
      .run('p-reset', 'c-reset', 'Espresso', 3.5);
  };

  seedStoreForCurrencyReset('USD');
  setLocalBackupEnabled(false);
  const currencyResetDisabledRes = await request(api).post('/api/db-tools/currency-reset').send({
    currency: 'EUR',
    current_currency: 'USD',
    confirmation_phrase: 'CHANGE TO EUR',
    master_pin: '1234',
  });
  assert.equal(
    currencyResetDisabledRes.status,
    200,
    'currency-reset succeeds when local backup is disabled',
  );
  assert.equal(currencyResetDisabledRes.body.localBackupFailed, false);
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after POST /api/db-tools/currency-reset',
  );
  assert.deepEqual(
    listLocalBackups(backupDir),
    [],
    'currency-reset does not retain a local backup when disabled',
  );
  await localBackup.runIfDue();
  assert.deepEqual(
    listLocalBackups(backupDir),
    [],
    'runIfDue does not write a backup after currency-reset when opted out even with preserved products',
  );

  // Direct resetDatabaseForCurrencyChange call also preserves local_backup_enabled = 'false'
  seedStoreForCurrencyReset('EUR');
  setLocalBackupEnabled(false);
  await resetDatabaseForCurrencyChange('GBP', 'EUR');
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after direct resetDatabaseForCurrencyChange',
  );
  await localBackup.runIfDue();
  assert.deepEqual(listLocalBackups(backupDir), []);

  // Currency reset when local_backup_enabled = 'true' retains the pre-reset backup locally
  seedStoreForCurrencyReset('GBP');
  setLocalBackupEnabled(true);
  const currencyResetEnabledRes = await request(api).post('/api/db-tools/currency-reset').send({
    currency: 'CAD',
    current_currency: 'GBP',
    confirmation_phrase: 'CHANGE TO CAD',
    master_pin: '1234',
  });
  assert.equal(currencyResetEnabledRes.status, 200);
  assert.equal(currencyResetEnabledRes.body.localBackupFailed, false);
  assert.equal(
    listLocalBackups(backupDir).length,
    1,
    'POST /api/db-tools/currency-reset retains the pre-reset backup locally when enabled',
  );
  for (const name of listLocalBackups(backupDir)) {
    fs.unlinkSync(path.join(backupDir, name));
  }

  // Direct resetDatabaseWithBackup and Electron IPC db-initialize preserve opt-out and retain when enabled
  setLocalBackupEnabled(false);
  await resetDatabaseWithBackup();
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after direct resetDatabaseWithBackup',
  );

  registerIpcHandlers(undefined, () => mainWin as any);
  const dbInitializeHandler = ipcHandlers.get('db-initialize');
  assert.ok(dbInitializeHandler, 'db-initialize IPC handler is registered');
  const trustedIpcEvent = { sender: mainWin.webContents, senderFrame: mainFrame };

  setLocalBackupEnabled(false);
  getDatabase()
    .prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
    .run('c-ipc', 'Bakery');
  getDatabase()
    .prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
    .run('p-ipc', 'c-ipc', 'Croissant', 4);
  const ipcDisabledRes = await dbInitializeHandler(trustedIpcEvent, {
    pin: '1234',
    confirmationPhrase: 'INITIALIZE',
  });
  assert.equal(ipcDisabledRes.success, true, 'IPC db-initialize succeeds when disabled');
  assert.equal(ipcDisabledRes.localBackupFailed, false);
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after IPC db-initialize',
  );
  assert.deepEqual(
    listLocalBackups(backupDir),
    [],
    'IPC db-initialize does not retain a local backup when disabled',
  );
  getDatabase()
    .prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
    .run('c-ipc-after', 'Bakery');
  getDatabase()
    .prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
    .run('p-ipc-after', 'c-ipc-after', 'Croissant', 4);
  await localBackup.runIfDue();
  assert.deepEqual(
    listLocalBackups(backupDir),
    [],
    'runIfDue does not write a backup after IPC db-initialize when opted out',
  );

  setLocalBackupEnabled(true);
  const ipcEnabledRes = await dbInitializeHandler(trustedIpcEvent, {
    pin: '1234',
    confirmationPhrase: 'INITIALIZE',
  });
  assert.equal(ipcEnabledRes.success, true, 'IPC db-initialize succeeds when enabled');
  assert.equal(ipcEnabledRes.localBackupFailed, false);
  assert.equal(
    listLocalBackups(backupDir).length,
    1,
    'IPC db-initialize retains the pre-reset backup locally when enabled',
  );
  for (const name of listLocalBackups(backupDir)) {
    fs.unlinkSync(path.join(backupDir, name));
  }

  // Backup restore (direct and data-only) preserves local_backup_enabled = 'false'
  getDatabase()
    .prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
    .run('c-restore', 'Drinks');
  getDatabase()
    .prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
    .run('p-restore', 'c-restore', 'Americano', 3);
  setLocalBackupEnabled(true);
  const snapshotWithEnabled = await createBackup(path.join(testDir, 'snapshot-enabled.db'));

  setLocalBackupEnabled(false);
  const directRestoreRes = restoreBackup(snapshotWithEnabled.path, true);
  assert.equal(directRestoreRes.success, true, 'direct restore succeeds');
  assert.equal(directRestoreRes.mode, 'direct');
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after direct restoreBackup of an enabled backup',
  );
  await localBackup.runIfDue();
  assert.deepEqual(
    listLocalBackups(backupDir),
    [],
    'runIfDue does not write a backup after direct restoreBackup when opted out',
  );

  const snapshotWithoutRowPath = path.join(testDir, 'snapshot-no-row.db');
  fs.copyFileSync(snapshotWithEnabled.path, snapshotWithoutRowPath);
  const noRowDb = new Database(snapshotWithoutRowPath);
  try {
    noRowDb.prepare("DELETE FROM settings WHERE key = 'local_backup_enabled'").run();
  } finally {
    noRowDb.close();
  }
  const noRowRestoreRes = restoreBackup(snapshotWithoutRowPath, true);
  assert.equal(noRowRestoreRes.success, true, 'restore of backup without local_backup_enabled row succeeds');
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after restoring a backup that had no local_backup_enabled row',
  );

  const olderSnapshotPath = path.join(testDir, 'snapshot-older.db');
  fs.copyFileSync(snapshotWithEnabled.path, olderSnapshotPath);
  const olderDb = new Database(olderSnapshotPath);
  try {
    const olderVersion = Number(olderDb.pragma('user_version', { simple: true })) - 1;
    olderDb.pragma(`user_version = ${olderVersion}`);
    olderDb
      .prepare("UPDATE _flo_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(olderVersion));
  } finally {
    olderDb.close();
  }
  const dataOnlyRestoreRes = restoreBackup(olderSnapshotPath, false);
  assert.equal(dataOnlyRestoreRes.success, true, 'data-only restore succeeds');
  assert.equal(dataOnlyRestoreRes.mode, 'data_only');
  assert.equal(
    isLocalBackupEnabled(),
    false,
    'local_backup_enabled remains false after data-only restoreBackup of an enabled backup',
  );
  await localBackup.runIfDue();
  assert.deepEqual(listLocalBackups(backupDir), []);

  await localBackup.stop();
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('local backup tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
