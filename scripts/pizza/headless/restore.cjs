#!/usr/bin/env node
// Restores a backup with the service stopped: copies the current database aside first, then runs
// the same restoreBackup() sequence as the app's restore-from-file route.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  config,
  privateBackupDir,
  dataLock,
  takeBackup,
  timestamp,
  appModule,
  fsync,
  onlineCopy,
  main,
} = require('./common.cjs');

const UNITS = ['pizza-pos.service', 'pizza-pos-backup.service'];
const STOP_FIRST = 'Stop the POS first: systemctl --user stop pizza-pos.service';

/** A server between crash-loop restarts holds no port but may open the database at any moment. */
function refuseWhileUnitsRun() {
  const result = spawnSync('systemctl', ['--user', 'is-active', ...UNITS], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT' || /Failed to connect to .*bus/.test(result.stderr ?? '')) {
    console.log('systemctl not found or no user service manager: relying on the port check alone');
    return;
  }
  if (result.error) throw result.error;
  const states = result.stdout.trim().split('\n');
  UNITS.forEach((unit, i) => {
    // A failed unit has stopped for good; the owner restores precisely after a crash loop.
    if (states[i] !== 'inactive' && states[i] !== 'failed') {
      throw new Error(
        `${unit} is ${states[i] ?? `unknown (${result.stderr.trim()})`}. ${STOP_FIRST}`,
      );
    }
  });
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    socket.setTimeout(2000);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

main(async () => {
  const settings = config('FLO_DEV_USER_DATA', 'PORT', 'KDS_PORT', 'SERVER_APP_PORT');
  if (process.argv.length !== 3) throw new Error('Usage: restore.cjs <backup file>');
  const backupPath = path.resolve(process.argv[2]);
  if (!fs.statSync(backupPath).isFile()) throw new Error(`${backupPath} is not a file`);

  // Held from before the checks until this process ends: the service takes the same lock before
  // it opens the database, so one started after the checks below waits out the restore.
  dataLock(settings.FLO_DEV_USER_DATA, 'exclusive');
  refuseWhileUnitsRun();
  for (const name of ['PORT', 'KDS_PORT', 'SERVER_APP_PORT']) {
    if (await listening(settings[name])) {
      throw new Error(`Something is listening on ${name}=${settings[name]}. ${STOP_FIRST}`);
    }
  }

  const livePath = path.join(settings.FLO_DEV_USER_DATA, 'flo.db');
  const dir = privateBackupDir(settings.FLO_DEV_USER_DATA);
  const safetyPath = path.join(dir, `pre-restore-${timestamp()}.db`);
  await onlineCopy(livePath, safetyPath);
  fsync(dir);
  const db = appModule('main/db');
  if (!db.isHealthyDatabaseFile(safetyPath)) {
    throw new Error(
      `The safety copy ${safetyPath} failed the app health check, so nothing was changed. If the live database is damaged, follow "The live database is missing or will not open" in pizza/headless.md.`,
    );
  }
  console.log(`safety copy: ${safetyPath}`);

  const { googleDrive } = appModule('main/services/google-drive');
  db.initDatabase();
  try {
    const backupVersion = db.getSchemaVersionFromBackup(backupPath);
    if (backupVersion === null) throw new Error(`${backupPath} has no schema version stamp`);
    const versionMismatch = backupVersion !== db.getCurrentSchemaVersion();
    await googleDrive.prepareForDatabaseRestore();
    try {
      const result = await db.withDatabaseMaintenanceLock((signal) =>
        db.restoreBackup(backupPath, !versionMismatch, signal),
      );
      if (!result.success) throw new Error(`Restore failed: ${result.error}`);
      googleDrive.completeDatabaseRestore();
      console.log(`restored ${backupPath} (${result.mode}, schema v${backupVersion})`);
    } finally {
      googleDrive.releaseDatabaseRestore();
    }
  } finally {
    db.closeDatabase();
  }
  // What was restored and every kept backup may be days old; health asks for a recent backup.
  try {
    console.log(`fresh backup: ${await takeBackup(settings.FLO_DEV_USER_DATA)}`);
  } catch (error) {
    console.error(`The restore is done, but a fresh backup failed: ${error?.message ?? error}`);
    console.error(
      'Take one once the POS is running: systemctl --user start pizza-pos-backup.service',
    );
  }
});
