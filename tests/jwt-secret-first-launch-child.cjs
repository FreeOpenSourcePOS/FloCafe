/**
 * Child process for tests/jwt-secret-persist-before-cache.test.ts.
 *
 * Every scenario that has to observe a secret across a process boundary runs
 * here rather than in the suite's own process, because a module-level cache
 * cannot be reset by anything but a fresh process: an in-process test can only
 * ever see the first value the module ever produced.
 *
 * Usage: node tests/jwt-secret-first-launch-child.cjs <testDir> <mode> [coordinationDir] [id]
 *   crash       first launch, killed by SIGKILL after the secret is generated
 *               and its INSERT has been issued but before the module's cache is
 *               populated. Writes <testDir>/crash-evidence.json from inside
 *               that window and records whether the module could hand back a
 *               secret it had not just read back from the database.
 *   read        first launch on an already-initialised database; prints the
 *               secret the module returns, the row on disk, and that row's
 *               updated_at so the suite can prove no later start re-minted.
 *   concurrent  first launch held at a barrier so that every process has read
 *               the (empty) settings row before any of them INSERTs, which is
 *               how the KDS server and the main process race on a fresh install.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const [testDir, mode, coordinationDir, id] = process.argv.slice(2);
if (!testDir || !mode) {
  console.error('usage: node jwt-secret-first-launch-child.cjs <testDir> <mode> [coordinationDir] [id]');
  process.exit(2);
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments);
};

require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, 'tsconfig.json') });

const Database = require('better-sqlite3');
const dbModule = require('../main/db');
const { getJWTSecret } = require('../main/security/jwt-secret');

const JWT_INSERT = /INSERT\s+INTO\s+settings[\s\S]*'jwt_secret'/i;
const SETTINGS_READ = /SELECT[\s\S]*settings/i;
const evidencePath = path.join(testDir, 'crash-evidence.json');

let insertHookFired = false;
let failSettingsReads = false;
let readCount = 0;
let barrierPending = false;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Block every reader until all participating processes have read the row. */
function holdAtBarrier(participants) {
  fs.writeFileSync(path.join(coordinationDir, `sel-${id}`), String(Date.now()));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const arrived = fs.readdirSync(coordinationDir).filter((name) => name.startsWith('sel-')).length;
    if (arrived >= participants) return arrived;
    if (Date.now() > deadline) throw new Error(`read barrier timed out after ${arrived} of ${participants} processes`);
    sleepSync(10);
  }
}

/**
 * The kill window. It runs after the real INSERT has been issued and before
 * the module gets a chance to cache anything, which is the exact gap this
 * suite exists to pin.
 */
function onInsertIssued(inserted) {
  const evidence = { inserted, row: null, rowUpdatedAt: null, probe: 'not-reached' };

  // A second connection, so the observation is of what a different process
  // would see on disk rather than of the writing connection's own view.
  const reader = new Database(dbModule.getDbPath(), { readonly: true, fileMustExist: true });
  try {
    const row = reader.prepare("SELECT value, updated_at FROM settings WHERE key = 'jwt_secret'").get();
    evidence.row = row ? row.value : null;
    evidence.rowUpdatedAt = row ? row.updated_at : null;
  } finally {
    reader.close();
  }

  failSettingsReads = true;
  try {
    const served = getJWTSecret();
    evidence.probe = served === inserted ? 'served-the-offered-value' : 'served-another-value';
  } catch (error) {
    evidence.probe = 'threw';
    evidence.probeError = String(error && error.message);
  }

  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  process.kill(process.pid, 'SIGKILL');
}

const originalPrepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql, ...rest) {
  const statement = originalPrepare.call(this, sql, ...rest);
  const text = String(sql);

  if (mode === 'crash' && !insertHookFired && JWT_INSERT.test(text)) {
    return {
      run: (...params) => {
        const result = statement.run(...params);
        insertHookFired = true;
        onInsertIssued(params[0]);
        return result;
      },
    };
  }

  if (mode === 'crash' && insertHookFired && SETTINGS_READ.test(text)) {
    return {
      get: (...params) => {
        if (failSettingsReads) throw new Error('settings row is unreadable');
        return statement.get(...params);
      },
    };
  }

  if (mode === 'concurrent' && barrierPending && SETTINGS_READ.test(text)) {
    return {
      get: (...params) => {
        // Read first, then hold: the value handed back must be the pre-insert
        // one, or the two processes would not actually be racing.
        const value = statement.get(...params);
        barrierPending = false;
        holdAtBarrier(Number(process.env.FLO_JWT_BARRIER_PARTICIPANTS || 2));
        return value;
      },
    };
  }

  return statement;
};

function emit(payload) {
  console.log(`__JWT_CHILD__ ${JSON.stringify(payload)}`);
}

function readRow() {
  const row = dbModule.getDatabase()
    .prepare("SELECT value, updated_at FROM settings WHERE key = 'jwt_secret'")
    .get();
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}

dbModule.initDatabase();
if (coordinationDir && id) {
  fs.writeFileSync(path.join(coordinationDir, `init-${id}`), String(Date.now()));
}

try {
  if (mode === 'crash') {
    // The hook has to be armed before the first read; initDatabase above does
    // not write settings.jwt_secret, and the patch only matches that INSERT.
    getJWTSecret();
    console.log('reached the end of getJWTSecret without being killed in the write/cache window');
    process.exit(3);
  }

  if (mode === 'read') {
    const secret = getJWTSecret();
    const second = getJWTSecret();
    emit({ mode, secret, second, row: readRow() });
    process.exit(0);
  }

  if (mode === 'concurrent') {
    barrierPending = true;
    const first = (() => {
      try {
        return { outcome: 'served', secret: getJWTSecret() };
      } catch (error) {
        return { outcome: 'threw', error: String(error && error.message) };
      }
    })();
    const second = (() => {
      try {
        return { outcome: 'served', secret: getJWTSecret() };
      } catch (error) {
        return { outcome: 'threw', error: String(error && error.message) };
      }
    })();
    emit({ mode, first, second, row: readRow() });
    process.exit(0);
  }

  console.error(`unknown mode: ${mode}`);
  process.exit(2);
} catch (error) {
  emit({ mode, fatal: String(error && error.stack) });
  process.exit(1);
}
