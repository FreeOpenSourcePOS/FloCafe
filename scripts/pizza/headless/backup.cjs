#!/usr/bin/env node
// Takes an online backup of the live database, checks it with the app's own health predicate,
// and keeps the newest BACKUP_KEEP copies. Prints the new backup's path last.
const fs = require('node:fs');
const path = require('node:path');
const {
  config,
  BACKUP_NAME,
  backupDir,
  timestamp,
  appModule,
  fsync,
  onlineCopy,
  main,
} = require('./common.cjs');

main(async () => {
  const { FLO_DEV_USER_DATA, BACKUP_KEEP } = config('FLO_DEV_USER_DATA', 'BACKUP_KEEP');
  const keep = Number(BACKUP_KEEP);
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(`BACKUP_KEEP must be a whole number of at least 1, got ${BACKUP_KEEP}`);

  const dir = backupDir(FLO_DEV_USER_DATA);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir).filter((n) => /^\.pizza-pos-.*\.partial$/.test(n))) {
    fs.unlinkSync(path.join(dir, name));
    console.log(`removed stale ${name}`);
  }
  const finalPath = path.join(dir, `pizza-pos-${timestamp()}.db`);
  const partialPath = path.join(dir, `.${path.basename(finalPath)}.partial`);
  try {
    await onlineCopy(path.join(FLO_DEV_USER_DATA, 'flo.db'), partialPath);
    if (!appModule('main/db').isHealthyDatabaseFile(partialPath)) {
      throw new Error('The copy failed the app health check (integrity, foreign keys or schema)');
    }
    if (fs.existsSync(finalPath)) throw new Error(`Refusing to overwrite ${finalPath}`);
    fs.renameSync(partialPath, finalPath);
    fsync(dir);
  } finally {
    fs.rmSync(partialPath, { force: true });
  }

  const backups = fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort();
  for (const name of backups.slice(0, -keep)) {
    fs.unlinkSync(path.join(dir, name));
    console.log(`removed ${name}`);
  }
  console.log(finalPath);
});
