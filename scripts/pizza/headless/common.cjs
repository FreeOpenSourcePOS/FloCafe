// Shared pieces of the headless kit: configuration from the environment, the app's own
// database module without Electron, and an online SQLite copy stamped like the app's backups.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

// The database holds the JWT signing secret, PIN hashes and customer phone numbers, so nothing
// the kit writes is readable by another account, from the first byte of a copy.
process.umask(0o077);

// The app opens this path instead of the data folder's database when it is set (its own
// end-to-end tests use it). Headless, the database is the one in the data folder, always.
if (process.env.FLO_E2E_DB_PATH) {
  console.error(`[headless] ignored FLO_E2E_DB_PATH=${process.env.FLO_E2E_DB_PATH}`);
  delete process.env.FLO_E2E_DB_PATH;
}

function config(...names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')}. Load the kit's settings first: set -a; . ~/.config/pizza-pos/headless.env; set +a`,
    );
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

/** Only names the kit writes; a file an operator copies in is never counted or deleted. */
const BACKUP_NAME = /^pizza-pos-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

function backupDir(dataDir) {
  return path.join(dataDir, 'headless-backups');
}

/** Creates the backup folder owner-only, and closes one an earlier version left open. */
function privateBackupDir(dataDir) {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The backup timer's schedule and its period; the health check allows one period between backups. */
const BACKUP_TIMER = { onCalendar: 'daily', periodHours: 24 };

let heldLock;

/**
 * The kernel's lock on a small SQLite file in the data folder, held until this process ends
 * however it ends. The service and a backup hold it shared, so they run side by side; a restore
 * holds it exclusive, so it runs alone and the service cannot open the database meanwhile. A
 * command that cannot have it stops at once.
 */
function dataLock(dataDir, mode) {
  const Database = require('better-sqlite3');
  const lockPath = path.join(dataDir, 'headless-lock.db');
  // Two restores that start in the same instant can each stop the other from taking the lock.
  // A wait of a tenth of a second lets one of them through; the other is still refused, because
  // a restore holds the lock far longer than that.
  const lock = new Database(lockPath, { timeout: mode === 'exclusive' ? 100 : 0 });
  try {
    // In WAL mode a reader does not keep a writer out, so the lock would not hold. A new lock
    // database is in rollback mode; one that is not is refused, never used.
    const journal = lock.pragma('journal_mode', { simple: true });
    if (journal !== 'delete')
      throw new Error(
        `The lock database ${lockPath} is in ${String(journal).toUpperCase()} mode, in which it cannot keep a restore and the POS apart. Stop the POS, delete ${lockPath} and any ${lockPath}-wal and ${lockPath}-shm, then start it again`,
      );
    if (mode === 'exclusive') lock.exec('BEGIN EXCLUSIVE');
    else lock.exec('BEGIN; SELECT count(*) FROM sqlite_master');
  } catch (error) {
    lock.close();
    if (error.code !== 'SQLITE_BUSY') throw error;
    throw new Error(
      mode === 'exclusive'
        ? `${dataDir} is in use by the POS, a backup or another restore. Stop the POS first (systemctl --user stop pizza-pos.service), let a backup finish, then try again`
        : `A restore is replacing the database in ${dataDir}. Try again when it has finished`,
    );
  }
  // Kept for the life of the process: a connection that is collected gives the lock up.
  heldLock = lock;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

let electronMocked = false;

/** Loads a compiled backend module with an Electron stand-in, as dev-server.js does. */
function appModule(relativePath) {
  const { FLO_DEV_USER_DATA } = config('FLO_DEV_USER_DATA');
  if (!electronMocked) {
    const originalLoad = Module._load;
    const app = {
      isPackaged: true,
      getPath: (name) =>
        name === 'userData' ? FLO_DEV_USER_DATA : name === 'documents' ? os.homedir() : os.tmpdir(),
      getVersion: () => require(path.join(repoRoot, 'package.json')).version,
      getName: () => 'Flo (headless)',
    };
    Module._load = function (request, ...rest) {
      if (request === 'electron') return { app, dialog: {}, shell: {} };
      return originalLoad.call(this, request, ...rest);
    };
    electronMocked = true;
  }
  return require(path.join(repoRoot, 'dist', relativePath));
}

function fsync(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copies a database that may be open in another process through SQLite's online backup, then
 * prepares the copy as the app's own createBackup does: one self-contained file, the same safe
 * schema fixes, and the _flo_meta stamp.
 */
async function onlineCopy(sourcePath, targetPath) {
  const Database = require('better-sqlite3');
  if (fs.existsSync(targetPath)) throw new Error(`Refusing to overwrite ${targetPath}`);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 10_000 });
  try {
    // After the first step, copy every remaining page in one step, so a write from the server
    // cannot restart the copy part-way through.
    await source.backup(targetPath, { progress: () => 0x7fffffff });
  } finally {
    source.close();
  }
  const copy = new Database(targetPath);
  try {
    copy.pragma('journal_mode = DELETE');
    const schemaVersion = copy.pragma('user_version', { simple: true });
    // The safe fixes compare against this code's schema, so they apply only at its version.
    if (schemaVersion === appModule('main/db').getLatestSupportedSchemaVersion()) {
      const { applySafeFixes } = appModule('main/services/schema-health');
      const fixes = applySafeFixes(undefined, copy);
      if (fixes.applied.length > 0) console.log(`repaired ${fixes.applied.join(', ')}`);
      for (const { id, error } of fixes.errors) console.error(`could not repair ${id}: ${error}`);
    }
    copy.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
    const stamp = copy.prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)');
    stamp.run('schema_version', String(schemaVersion));
    stamp.run('backup_created_at', new Date().toISOString());
    stamp.run('app_version', require(path.join(repoRoot, 'package.json')).version);
  } finally {
    copy.close();
  }
  fsync(targetPath);
}

/** One checked backup of the live database in the backup folder; returns its path. */
async function takeBackup(dataDir) {
  const dir = privateBackupDir(dataDir);
  const finalPath = path.join(dir, `pizza-pos-${timestamp()}.db`);
  const partialPath = path.join(dir, `.${path.basename(finalPath)}.partial`);
  try {
    await onlineCopy(path.join(dataDir, 'flo.db'), partialPath);
    if (!appModule('main/db').isHealthyDatabaseFile(partialPath)) {
      throw new Error('The copy failed the app health check (integrity, foreign keys or schema)');
    }
    if (fs.existsSync(finalPath)) throw new Error(`Refusing to overwrite ${finalPath}`);
    fs.renameSync(partialPath, finalPath);
    fsync(dir);
  } finally {
    fs.rmSync(partialPath, { force: true });
  }
  return finalPath;
}

function main(run) {
  run().then(
    () => process.exit(0),
    (error) => {
      console.error(`ERROR: ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}

module.exports = {
  repoRoot,
  config,
  BACKUP_NAME,
  BACKUP_TIMER,
  dataLock,
  takeBackup,
  backupDir,
  privateBackupDir,
  timestamp,
  appModule,
  fsync,
  onlineCopy,
  main,
};
