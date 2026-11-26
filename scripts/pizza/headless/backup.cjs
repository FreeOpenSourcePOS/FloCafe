#!/usr/bin/env node
// Takes an online backup of the live database, checks it with the app's own health predicate,
// and keeps the newest BACKUP_KEEP copies. Prints the new backup's path last.
const fs = require('node:fs');
const path = require('node:path');
const {
  config,
  BACKUP_NAME,
  privateBackupDir,
  dataLock,
  takeBackup,
  main,
} = require('./common.cjs');

main(async () => {
  const { FLO_DEV_USER_DATA, BACKUP_KEEP } = config('FLO_DEV_USER_DATA', 'BACKUP_KEEP');
  const keep = Number(BACKUP_KEEP);
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(`BACKUP_KEEP must be a whole number of at least 1, got ${BACKUP_KEEP}`);

  dataLock(FLO_DEV_USER_DATA, 'shared');
  const dir = privateBackupDir(FLO_DEV_USER_DATA);
  for (const name of fs.readdirSync(dir).filter((n) => /^\.pizza-pos-.*\.partial$/.test(n))) {
    fs.unlinkSync(path.join(dir, name));
    console.log(`removed stale ${name}`);
  }
  const finalPath = await takeBackup(FLO_DEV_USER_DATA);

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
