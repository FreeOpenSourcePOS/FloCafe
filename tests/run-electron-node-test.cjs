const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');
const tsNodeBin = require.resolve('ts-node/dist/bin.js');
const rebuildCli = path.join(path.dirname(require.resolve('@electron/rebuild')), 'cli.js');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node tests/run-electron-node-test.cjs <test-file> [args...]');
  process.exit(1);
}

function runElectronNode(extraArgs, stdio = 'inherit') {
  return spawnSync(
    electronPath,
    extraArgs,
    {
      stdio,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      encoding: stdio === 'pipe' ? 'utf8' : undefined,
    },
  );
}

function verifyBetterSqlite3() {
  const result = runElectronNode(['-e', "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();"], 'pipe');
  return {
    ok: result.status === 0 && !result.error,
    error: result.error || result.stderr || result.stdout,
  };
}

function rebuildBetterSqlite3() {
  console.log('[test-runner] Rebuilding better-sqlite3 for the installed Electron runtime...');
  return spawnSync(
    process.execPath,
    [rebuildCli, '-f', '-w', 'better-sqlite3'],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
}

let sqliteCheck = verifyBetterSqlite3();
if (!sqliteCheck.ok) {
  console.warn('[test-runner] better-sqlite3 failed to load in Electron.');
  if (sqliteCheck.error) console.warn(String(sqliteCheck.error).trim());

  const rebuild = rebuildBetterSqlite3();
  if (rebuild.error || rebuild.status !== 0) {
    if (rebuild.error) console.error(rebuild.error);
    process.exit(rebuild.status ?? 1);
  }

  sqliteCheck = verifyBetterSqlite3();
  if (!sqliteCheck.ok) {
    console.error('[test-runner] better-sqlite3 still cannot load after rebuild.');
    if (sqliteCheck.error) console.error(String(sqliteCheck.error).trim());
    process.exit(1);
  }
}

const result = spawnSync(
  electronPath,
  [
    tsNodeBin,
    '--transpile-only',
    '-P',
    'tests/tsconfig.json',
    ...args,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
