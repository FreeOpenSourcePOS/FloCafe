/**
 * First-launch ordering for the installation's JWT signing secret.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/jwt-secret-persist-before-cache.test.ts
 *
 * `main/security/jwt-secret.ts` used to assign the freshly generated secret to
 * the module cache and only then write it to `settings`. Two reachable failures
 * follow from that ordering, and both leave a token in the wild that nothing can
 * verify:
 *
 *   1. Process death between the two steps. The cache held a value that never
 *      reached disk, so the next start found no row and minted a different
 *      secret - every session on the install logged out at once.
 *   2. A failed write, on a full or locked database. The surrounding catch
 *      rethrew, but it left the cache populated, so the same process kept
 *      serving a secret that existed nowhere on disk, and the KDS server -
 *      a genuinely separate process - would reject every token signed with it.
 *
 * Each scenario here kills a real process or fails a real write rather than
 * simulating one, and asserts stability across restarts rather than the mere
 * presence of a value.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const Module = require('module');
const originalLoad = Module._load;
const rootTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-jwt-secret-persist-'));
let activeUserData = rootTestDir;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => activeUserData, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const Database = require('better-sqlite3');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { getJWTSecret, clearJWTSecretCache } = require('../main/security/jwt-secret');
const {
  assertOrThrow, assertEqualOrThrow, assertIncludesOrThrow, resetCounters, getResults,
} = require('./helpers/test-setup');

const CHILD_RESULT = '__JWT_CHILD__';
const CHILD = path.join(__dirname, 'jwt-secret-first-launch-child.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const CHILD_TIMEOUT_MS = 180_000;
// Unchanged by this fix: a first launch still mints one 32-byte hex secret.
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

type ChildRun = { code: number | null; signal: NodeJS.Signals | null; output: string };

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !['JWT_SECRET', 'FLO_E2E_DB_PATH', 'FLO_JWT_BARRIER_PARTICIPANTS'].includes(key)) {
      env[key] = value;
    }
  }
  // The env override short-circuits getJWTSecret() before the database, and
  // FLO_E2E_DB_PATH would move a child's database out of its own directory.
  return { ...env, ELECTRON_RUN_AS_NODE: '1', ...extra };
}

function startChild(args: string[], extraEnv: Record<string, string> = {}): { child: ChildProcess; done: Promise<ChildRun> } {
  const child = spawn(process.execPath, [CHILD, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const done = new Promise<ChildRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`jwt-secret child [${args.join(' ')}] timed out: ${output}`));
    }, CHILD_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  return { child, done };
}

async function runChild(args: string[], extraEnv: Record<string, string> = {}): Promise<ChildRun> {
  return startChild(args, extraEnv).done;
}

function childResult(run: ChildRun, args: string[]): any {
  const line = run.output.split('\n').filter((entry) => entry.startsWith(CHILD_RESULT)).at(-1);
  if (!line) throw new Error(`jwt-secret child [${args.join(' ')}] printed no result (exit ${run.code}/${run.signal}): ${run.output}`);
  return JSON.parse(line.slice(CHILD_RESULT.length));
}

function readSecretRow(dbPath: string): { value: string; updatedAt: string } | null {
  const reader = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = reader.prepare("SELECT value, updated_at FROM settings WHERE key = 'jwt_secret'").get() as
      { value: string; updated_at: string } | undefined;
    return row ? { value: row.value, updatedAt: row.updated_at } : null;
  } finally {
    reader.close();
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Initialise (or reopen) this process's database inside its own directory. */
function initDatabaseAt(dir: string): any {
  closeDatabase();
  activeUserData = dir;
  initDatabase();
  return getDatabase();
}

/** Wait for a file the child writes to say it finished `initDatabase`. */
async function waitForFile(file: string, child: ChildProcess, args: string[]): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child [${args.join(' ')}] exited before it finished initialising its database`);
    }
    if (Date.now() > deadline) throw new Error(`child [${args.join(' ')}] never wrote ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Scenario 1: kill a process in the gap between the write and the cache.
 *
 * The child is SIGKILLed from inside its own INSERT hook, so the death lands
 * where a real crash would: after the secret exists on disk, before the module
 * has confirmed it. Every later start must then serve the row that is already
 * there rather than minting a second secret.
 */
async function scenarioCrashInTheWriteCacheWindow(): Promise<void> {
  const dir = tempDir('flo-jwt-secret-crash-');
  const run = await runChild([dir, 'crash']);

  // 3 is the child's "reached the end of getJWTSecret" exit code and 0 would
  // be a graceful exit. A cross-platform SIGKILL surfaces as a signal on POSIX
  // and as a non-zero exit code on Windows, so assert the death, not the
  // mechanism.
  assertOrThrow(
    (run.signal === 'SIGKILL') || (run.signal === null && run.code !== 0 && run.code !== 3),
    `the child died in the write/cache window (exit ${run.code}, signal ${run.signal})`,
  );

  const evidencePath = path.join(dir, 'crash-evidence.json');
  assertOrThrow(fs.existsSync(evidencePath), 'the killed child recorded evidence from inside the write/cache window');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assertOrThrow(SECRET_PATTERN.test(evidence.inserted), `the child generated one 32-byte hex secret (${evidence.inserted})`);
  assertEqualOrThrow(evidence.row, evidence.inserted, 'the secret reached disk before the process was killed');
  assertEqualOrThrow(
    evidence.probe,
    'threw',
    'at the moment of death the module could not serve a secret it had not read back from the database, so no token could be signed with a value that exists nowhere',
  );

  const dbPath = path.join(dir, 'flo.db');
  const rowAfterCrash = readSecretRow(dbPath);
  assertEqualOrThrow(rowAfterCrash?.value, evidence.inserted, 'the killed process left exactly one secret on disk');

  const firstRun = await runChild([dir, 'read']);
  assertEqualOrThrow(firstRun.code, 0, `the next start ran cleanly: ${firstRun.output}`);
  const first = childResult(firstRun, [dir, 'read']);
  assertEqualOrThrow(first.secret, rowAfterCrash?.value, 'the next start serves the secret already on disk instead of minting one');
  assertEqualOrThrow(first.second, first.secret, 'the second read in the next start is served by the cache');
  assertEqualOrThrow(
    first.row?.updatedAt,
    rowAfterCrash?.updatedAt,
    'the next start did not rewrite the row, so no second secret was minted',
  );

  const secondRun = await runChild([dir, 'read']);
  assertEqualOrThrow(secondRun.code, 0, `a further start ran cleanly: ${secondRun.output}`);
  const second = childResult(secondRun, [dir, 'read']);
  assertEqualOrThrow(second.secret, rowAfterCrash?.value, 'the secret is stable across restarts');
  assertEqualOrThrow(readSecretRow(dbPath)?.updatedAt, rowAfterCrash?.updatedAt, 'no restart ever rewrote the secret row');

  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Scenario 2: the write itself fails, and the read-back fails.
 *
 * Both must leave the cache empty so the next call retries. Otherwise the same
 * process keeps signing tokens with a secret that is not on disk, which is
 * precisely what the KDS server cannot verify.
 */
function scenarioFailedWriteLeavesNoCachedSecret(): void {
  const dir = tempDir('flo-jwt-secret-write-failure-');
  const db = initDatabaseAt(dir);
  clearJWTSecretCache();
  assertOrThrow(
    !db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get(),
    'the install starts with no stored secret',
  );

  // A real database-level refusal, not a double of the module under test.
  db.exec(`
    CREATE TRIGGER block_jwt_secret BEFORE INSERT ON settings
    WHEN NEW.key = 'jwt_secret'
    BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
  `);
  try {
    const first = (() => { try { getJWTSecret(); return null; } catch (error) { return error as Error; } })();
    assertOrThrow(!!first, 'a failed first-launch write refuses to hand back a secret');
    assertIncludesOrThrow(first!.message, 'Database not ready', 'the failure keeps the existing fail-closed message');
    assertOrThrow(
      !db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get(),
      'a failed first-launch write leaves no secret on disk',
    );

    const second = (() => { try { getJWTSecret(); return null; } catch { return new Error('refused'); } })();
    assertOrThrow(
      !!second,
      'the same process does not go on serving a secret that was never stored, so every later read retries instead',
    );
  } finally {
    db.exec('DROP TRIGGER block_jwt_secret');
  }

  // The read-back failing is the same failure one step later: the module has
  // already written, but it has not confirmed what the database stored.
  const originalPrepare = Database.prototype.prepare;
  let settingsReads = 0;
  Database.prototype.prepare = function (sql: string, ...rest: unknown[]) {
    const statement = originalPrepare.call(this, sql, ...rest);
    if (!/SELECT[\s\S]*settings/i.test(String(sql))) return statement;
    return {
      get: (...params: unknown[]) => {
        if (++settingsReads === 2) throw new Error('settings row is unreadable');
        return statement.get(...params);
      },
      all: (...params: unknown[]) => statement.all(...params),
    };
  };
  try {
    const readBack = (() => { try { getJWTSecret(); return null; } catch { return new Error('refused'); } })();
    assertOrThrow(
      !!readBack,
      'a secret is never handed back on the strength of the value offered to the write rather than the value the database stored',
    );
  } finally {
    Database.prototype.prepare = originalPrepare;
  }

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;
  assertOrThrow(!!stored, 'the write that the failed read-back followed did reach disk');
  assertOrThrow(SECRET_PATTERN.test(stored!.value), `the stored secret keeps its format and length (${stored!.value})`);

  const recovered = getJWTSecret();
  assertEqualOrThrow(recovered, stored!.value, 'a later call recovers and returns the secret the database stored');
  assertEqualOrThrow(getJWTSecret(), recovered, 'the recovered secret is then served from the cache');
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Scenario 3: two processes first-launching at once.
 *
 * The KDS server is a genuinely separate process that verifies tokens with this
 * same secret. When both find no row, one INSERT wins and the other fails on
 * the primary key; the loser has to fall back to reading the winner's row rather
 * than keeping the secret it had already cached.
 */
async function scenarioConcurrentFirstLaunchAgrees(): Promise<void> {
  const dir = tempDir('flo-jwt-secret-race-');
  const coordination = tempDir('flo-jwt-secret-race-coord-');
  const extraEnv = { FLO_JWT_BARRIER_PARTICIPANTS: '2' };
  const args = [dir, 'concurrent', coordination];

  // The database exists before the race, so the barrier - and not a pair of
  // concurrent migrations - is the only thing ordering these two processes.
  const seeded = initDatabaseAt(dir);
  assertOrThrow(
    !seeded.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get(),
    'the racing install starts with no stored secret',
  );
  closeDatabase();

  const processA = startChild([...args, 'a'], extraEnv);
  await waitForFile(path.join(coordination, 'init-a'), processA.child, [...args, 'a']);
  const processB = startChild([...args, 'b'], extraEnv);
  await waitForFile(path.join(coordination, 'init-b'), processB.child, [...args, 'b']);

  const [runA, runB] = await Promise.all([processA.done, processB.done]);
  assertEqualOrThrow(runA.code, 0, `process A ran cleanly: ${runA.output}`);
  assertEqualOrThrow(runB.code, 0, `process B ran cleanly: ${runB.output}`);
  const a = childResult(runA, [...args, 'a']);
  const b = childResult(runB, [...args, 'b']);

  const winners = [a, b].filter((entry: any) => entry.first.outcome === 'served');
  const losers = [a, b].filter((entry: any) => entry.first.outcome !== 'served');
  assertEqualOrThrow(winners.length, 1, 'exactly one of the two racing processes writes the secret');
  assertEqualOrThrow(losers.length, 1, 'the other racing process is refused rather than served a second secret');
  assertEqualOrThrow(losers[0].second.outcome, 'served', 'the losing process recovers on its next read');
  assertEqualOrThrow(
    losers[0].second.secret,
    winners[0].first.secret,
    'both processes end up signing and verifying with the same secret',
  );

  const stored = readSecretRow(path.join(dir, 'flo.db'));
  assertOrThrow(SECRET_PATTERN.test(stored!.value), `the raced secret keeps its format and length (${stored!.value})`);
  assertEqualOrThrow(stored?.value, winners[0].first.secret, 'the shared secret is the one the database stored');
  assertEqualOrThrow(winners[0].second.secret, winners[0].first.secret, 'the winning process keeps serving the secret it stored');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(coordination, { recursive: true, force: true });
}

async function run(): Promise<void> {
  resetCounters();
  // The env override short-circuits the database this suite observes.
  delete process.env.JWT_SECRET;
  delete process.env.FLO_E2E_DB_PATH;

  await scenarioCrashInTheWriteCacheWindow();
  scenarioFailedWriteLeavesNoCachedSecret();
  await scenarioConcurrentFirstLaunchAgrees();

  closeDatabase();
  fs.rmSync(rootTestDir, { recursive: true, force: true });

  const results = getResults();
  console.log(`\nJWT secret persist-before-cache: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
