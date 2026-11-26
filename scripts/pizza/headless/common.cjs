// Shared pieces of the headless kit: configuration from the environment, the app's own
// database module without Electron, and an online SQLite copy stamped like the app's backups.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

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
  backupDir,
  timestamp,
  appModule,
  fsync,
  onlineCopy,
  main,
};
