/**
 * Pizza fork, headless kit: restoring an older backup with the service stopped brings the store
 * back to that backup, keeps a healthy safety copy of what it replaced, refuses while the server or
 * its systemd units are running, leaves nothing behind when the app refuses the backup, and
 * recovers a store whose live database is missing.
 *
 * Usage: npm run test:pizza-headless-restore
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
const {
  assertEqualOrThrow,
  assertIncludesOrThrow,
  assertOrThrow,
} = require('./helpers/test-setup');
import {
  appDb,
  backupDir,
  headlessEnv,
  holdLock,
  kitDir,
  repoRoot,
  liveDbPath,
  runCases,
  runKit,
  scratchDir,
  startHeadless,
  type HeadlessEnv,
} from './helpers/headless';

function withLiveDb(env: HeadlessEnv, run: (db: Database.Database) => void) {
  const db = new Database(liveDbPath(env), { timeout: 5000 });
  try {
    run(db);
  } finally {
    db.close();
  }
}

function insertCategory(env: HeadlessEnv, id: string) {
  withLiveDb(env, (db) =>
    db
      .prepare(
        "INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      )
      .run(id, id),
  );
}

function hasCategory(file: string, id: string): boolean {
  const db = new Database(file, { readonly: true });
  try {
    return Boolean(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id));
  } finally {
    db.close();
  }
}

/** A store with 'cat-before' in its backup and 'cat-after' written later; the server is stopped. */
async function storeWithBackup(): Promise<{ env: HeadlessEnv; backup: string }> {
  const env = await headlessEnv({ BACKUP_KEEP: '5' });
  const server = await startHeadless(env);
  try {
    insertCategory(env, 'cat-before');
    const result = await runKit('backup.cjs', [], env);
    assertEqualOrThrow(result.status, 0, `backup exits 0: ${result.output}`);
    insertCategory(env, 'cat-after');
    return { env, backup: result.stdout.trim().split('\n').pop()! };
  } finally {
    await server.stop();
  }
}

const lockPath = (env: HeadlessEnv) => path.join(env.FLO_DEV_USER_DATA, 'headless-lock.db');
const IN_USE = 'is in use by the POS, a backup or another restore';

const drivePending = (env: HeadlessEnv) =>
  path.join(env.FLO_DEV_USER_DATA, 'google-drive-restore.pending');

async function assertServerHealthy(env: HeadlessEnv, label: string) {
  const server = await startHeadless(env);
  try {
    const health = await runKit('health.cjs', [], env);
    assertEqualOrThrow(health.status, 0, `${label}: ${health.output}`);
  } finally {
    await server.stop();
  }
}

async function assertRefused(env: HeadlessEnv, backup: string, expected: string) {
  const result = await runKit('restore.cjs', [backup], env);
  console.log(result.output);
  assertOrThrow(result.status !== 0, 'restore exits non-zero');
  assertIncludesOrThrow(result.stderr, expected, 'the error says why');
  assertOrThrow(hasCategory(liveDbPath(env), 'cat-after'), 'the live database is untouched');
}

void runCases('Pizza headless kit: restore', [
  [
    'restoring an older backup drops the later row and keeps a healthy safety copy',
    async () => {
      const { env, backup } = await storeWithBackup();
      const result = await runKit('restore.cjs', [backup], env);
      console.log(result.output);
      assertEqualOrThrow(result.status, 0, 'restore exits 0');

      assertOrThrow(hasCategory(liveDbPath(env), 'cat-before'), 'the backed-up row is back');
      assertOrThrow(!hasCategory(liveDbPath(env), 'cat-after'), 'the later row is gone');

      const safety = fs
        .readdirSync(backupDir(env))
        .filter((name) => name.startsWith('pre-restore-'))
        .map((name) => path.join(backupDir(env), name));
      assertEqualOrThrow(safety.length, 1, 'one safety copy was written');
      assertOrThrow(
        hasCategory(safety[0], 'cat-after'),
        'the safety copy holds the database as it was before the restore',
      );
      assertOrThrow(appDb().isHealthyDatabaseFile(safety[0]), 'the safety copy is healthy');
      const modeOf = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);
      assertEqualOrThrow(modeOf(safety[0]), '600', 'the safety copy is owner-only');
      assertEqualOrThrow(modeOf(backupDir(env)), '700', 'the backup folder is owner-only');
      assertOrThrow(!fs.existsSync(drivePending(env)), 'no Drive restore intent is left behind');
      await assertServerHealthy(env, 'the server is healthy on the restored database');
    },
  ],
  [
    'of two restores started together, exactly one runs',
    async () => {
      const { env, backup } = await storeWithBackup();
      const results = await Promise.all([
        runKit('restore.cjs', [backup], env),
        runKit('restore.cjs', [backup], env),
      ]);
      for (const result of results) console.log(result.output);
      const refused = results.filter((result) => result.status !== 0);
      assertEqualOrThrow(results.length - refused.length, 1, 'one restore exits 0');
      assertEqualOrThrow(refused.length, 1, 'and the other is refused');
      assertIncludesOrThrow(refused[0].stderr, IN_USE, 'the refusal names the reason');
      const safety = fs.readdirSync(backupDir(env)).filter((name) => name.startsWith('pre-'));
      assertEqualOrThrow(safety.length, 1, 'only the one that ran took a safety copy');
      assertOrThrow(!hasCategory(liveDbPath(env), 'cat-after'), 'the backup was restored');
      await assertServerHealthy(env, 'the server is healthy on the restored database');
    },
  ],
  [
    "a restore is refused while a process holds the service's lock, whatever the clock says",
    async () => {
      const { env, backup } = await storeWithBackup();
      const service = await holdLock(env, 'shared');
      try {
        await assertRefused(env, backup, IN_USE);
        // The lock is the kernel's, not a date: a lock file dated long ago or ahead changes nothing.
        for (const date of [new Date(0), new Date(Date.now() + 365 * 24 * 3600 * 1000)]) {
          fs.utimesSync(lockPath(env), date, date);
          await assertRefused(env, backup, IN_USE);
        }
        const copies = fs.readdirSync(backupDir(env)).length;
        const beside = await runKit('backup.cjs', [], env);
        assertEqualOrThrow(beside.status, 0, `a backup runs beside the service: ${beside.output}`);
        assertEqualOrThrow(fs.readdirSync(backupDir(env)).length, copies + 1, 'and is kept');
      } finally {
        await service.kill();
      }
      const result = await runKit('restore.cjs', [backup], env);
      assertEqualOrThrow(
        result.status,
        0,
        `with the holder gone the restore runs: ${result.output}`,
      );
    },
  ],
  [
    'while a restore holds the data folder, the service and a backup stop at once',
    async () => {
      const { env } = await storeWithBackup();
      const restore = await holdLock(env, 'exclusive');
      try {
        const copies = fs.readdirSync(backupDir(env)).length;
        const backup = await runKit('backup.cjs', [], env);
        assertOrThrow(backup.status !== 0, 'a backup exits non-zero');
        assertIncludesOrThrow(backup.stderr, 'A restore is replacing the database', 'and says why');
        assertEqualOrThrow(fs.readdirSync(backupDir(env)).length, copies, 'and writes nothing');

        const before = fs.statSync(liveDbPath(env)).mtimeMs;
        const service = await runKit('serve.cjs', [], env);
        assertOrThrow(service.status !== 0, 'the service exits non-zero');
        assertIncludesOrThrow(
          service.stderr,
          'A restore is replacing the database',
          'and says why',
        );
        assertOrThrow(!service.output.includes('[DB]'), 'before it opens the database');
        assertEqualOrThrow(fs.statSync(liveDbPath(env)).mtimeMs, before, 'which it leaves alone');
      } finally {
        await restore.kill();
      }
    },
  ],
  [
    'a .env in the repository folder cannot move the service off the folder it locked',
    async () => {
      const { env, backup } = await storeWithBackup();
      // A copy of the repository's entry points beside a .env, so the real folder is not touched.
      const root = scratchDir('flo-pizza-headless-root-');
      const kit = path.join(root, 'scripts', 'pizza', 'headless');
      fs.mkdirSync(kit, { recursive: true });
      for (const name of ['serve.cjs', 'common.cjs'])
        fs.copyFileSync(path.join(kitDir, name), path.join(kit, name));
      for (const name of ['dev-server.js', 'package.json'])
        fs.copyFileSync(path.join(repoRoot, name), path.join(root, name));
      for (const name of ['dist', 'node_modules', 'frontend'])
        fs.symlinkSync(path.join(repoRoot, name), path.join(root, name));
      const elsewhere = scratchDir('flo-pizza-headless-elsewhere-');
      fs.writeFileSync(
        path.join(root, '.env'),
        `FLO_DEV_USER_DATA=${elsewhere}\nFLO_E2E_DB_PATH=${path.join(elsewhere, 'flo.db')}\nHOME=${elsewhere}\n`,
      );

      const before = fs.statSync(liveDbPath(env)).mtimeMs;
      const server = await startHeadless(env, kit);
      try {
        assertOrThrow(
          server.output().includes('[DevServer] Loaded .env'),
          'the server read the .env beside it',
        );
        assertEqualOrThrow(fs.readdirSync(elsewhere).length, 0, 'the other folder is not used');
        assertOrThrow(
          server.output().includes(`Opening database at: ${liveDbPath(env)}`),
          "the server opened the database in the unit's folder",
        );
        assertOrThrow(fs.statSync(liveDbPath(env)).mtimeMs >= before, 'which is still there');
        await assertRefused(env, backup, IN_USE);
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'an inherited FLO_E2E_DB_PATH cannot move the service or a restore to another database',
    async () => {
      const { env, backup } = await storeWithBackup();
      const elsewhere = scratchDir('flo-pizza-headless-elsewhere-');
      const redirected = { ...env, FLO_E2E_DB_PATH: path.join(elsewhere, 'flo.db') };
      const server = await startHeadless(redirected);
      try {
        assertOrThrow(
          server.output().includes(`Opening database at: ${liveDbPath(env)}`),
          "the server opened the database in the unit's folder",
        );
        assertOrThrow(
          server.output().includes('ignored FLO_E2E_DB_PATH'),
          'and its log says the variable was ignored',
        );
        assertEqualOrThrow(fs.readdirSync(elsewhere).length, 0, 'the other folder is untouched');
        await assertRefused(env, backup, IN_USE);
      } finally {
        await server.stop();
      }
      const result = await runKit('restore.cjs', [backup], redirected);
      assertEqualOrThrow(result.status, 0, `a restore exits 0: ${result.output}`);
      assertOrThrow(!hasCategory(liveDbPath(env), 'cat-after'), "it restored the unit's folder");
      assertEqualOrThrow(fs.readdirSync(elsewhere).length, 0, 'and left the other folder alone');
    },
  ],
  [
    'a lock database in WAL mode, where the lock would not hold, stops every command',
    async () => {
      const { env, backup } = await storeWithBackup();
      const lock = new Database(lockPath(env));
      lock.pragma('journal_mode = WAL');
      lock.exec('CREATE TABLE made_wal (id)');
      lock.close();
      const refusal = 'is in WAL mode';
      await assertRefused(env, backup, refusal);
      for (const script of ['backup.cjs', 'serve.cjs']) {
        const result = await runKit(script, [], env);
        assertOrThrow(result.status !== 0, `${script} exits non-zero`);
        assertIncludesOrThrow(result.stderr, refusal, `${script} says why`);
      }
      for (const name of fs.readdirSync(env.FLO_DEV_USER_DATA))
        if (name.startsWith('headless-lock.db')) fs.rmSync(path.join(env.FLO_DEV_USER_DATA, name));
      const result = await runKit('restore.cjs', [backup], env);
      assertEqualOrThrow(
        result.status,
        0,
        `with the lock database removed it runs: ${result.output}`,
      );
    },
  ],
  [
    'a holder that is killed leaves nothing to clean up',
    async () => {
      const { env, backup } = await storeWithBackup();
      const restore = await holdLock(env, 'exclusive');
      await assertRefused(env, backup, IN_USE);
      await restore.kill('SIGKILL');
      const result = await runKit('restore.cjs', [backup], env);
      assertEqualOrThrow(result.status, 0, `the next restore runs: ${result.output}`);
      assertOrThrow(!hasCategory(liveDbPath(env), 'cat-after'), 'the backup was restored');
      await assertServerHealthy(env, 'and the service starts');
    },
  ],
  [
    'after restoring an old backup the store is healthy without another step',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '5' });
      const first = await startHeadless(env);
      let backup: string;
      try {
        // The store was set up long ago, and its only backup is older than a day.
        withLiveDb(env, (db) =>
          db.prepare("UPDATE settings SET updated_at = '2000-01-01 00:00:00'").run(),
        );
        const taken = await runKit('backup.cjs', [], env);
        assertEqualOrThrow(taken.status, 0, `backup exits 0: ${taken.output}`);
        backup = taken.stdout.trim().split('\n').pop()!;
        const old = new Date(Date.now() - 48 * 3600 * 1000);
        fs.utimesSync(backup, old, old);
      } finally {
        await first.stop();
      }
      const result = await runKit('restore.cjs', [backup], env);
      console.log(result.output);
      assertEqualOrThrow(result.status, 0, 'restore exits 0');
      assertIncludesOrThrow(result.stdout, 'fresh backup: ', 'and says it took a fresh backup');
      await assertServerHealthy(env, 'health passes on the restored store');
    },
  ],
  [
    'restore refuses while the server is running and changes nothing',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '5' });
      const server = await startHeadless(env);
      try {
        insertCategory(env, 'cat-before');
        const backup = await runKit('backup.cjs', [], env);
        insertCategory(env, 'cat-after');
        await assertRefused(
          env,
          backup.stdout.trim().split('\n').pop()!,
          'systemctl --user stop pizza-pos.service',
        );
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'restore refuses while systemd reports the POS service active, even with the ports free',
    async () => {
      const { env, backup } = await storeWithBackup();
      env.FAKE_SYSTEMCTL_ACTIVE = 'pizza-pos.service';
      await assertRefused(env, backup, 'pizza-pos.service is active');
    },
  ],
  [
    'restore refuses while a backup is running',
    async () => {
      const { env, backup } = await storeWithBackup();
      env.FAKE_SYSTEMCTL_ACTIVE = 'pizza-pos-backup.service';
      await assertRefused(env, backup, 'pizza-pos-backup.service is active');
    },
  ],
  [
    'without systemctl, restore says so and relies on the port check',
    async () => {
      const { env, backup } = await storeWithBackup();
      env.PATH = scratchDir('flo-pizza-headless-nopath-');
      const result = await runKit('restore.cjs', [backup], env);
      console.log(result.output);
      assertEqualOrThrow(result.status, 0, 'restore exits 0');
      assertIncludesOrThrow(result.output, 'systemctl not found', 'the output says so');
      assertOrThrow(!hasCategory(liveDbPath(env), 'cat-after'), 'the backup was restored');
    },
  ],
  [
    'a backup the app refuses leaves the store unchanged and nothing behind',
    async () => {
      const { env, backup } = await storeWithBackup();
      const bad = path.join(path.dirname(backup), 'stamp-mismatch.db');
      fs.copyFileSync(backup, bad);
      const db = new Database(bad);
      try {
        const version = Number(db.pragma('user_version', { simple: true }));
        db.prepare("UPDATE _flo_meta SET value = ? WHERE key = 'schema_version'").run(
          String(version - 1),
        );
      } finally {
        db.close();
      }
      await assertRefused(env, bad, 'Restore failed');
      assertOrThrow(!fs.existsSync(drivePending(env)), 'no Drive restore intent is left behind');
      await assertServerHealthy(env, 'the next start is clean');
    },
  ],
  [
    'restore refuses when the safety copy of the live database is not healthy',
    async () => {
      const { env, backup } = await storeWithBackup();
      withLiveDb(env, (db) => {
        db.pragma('foreign_keys = OFF');
        db.prepare(
          "INSERT INTO kitchen_stations (id, name, printer_id) VALUES ('stn-broken', 'Broken', 'no-such-printer')",
        ).run();
      });
      await assertRefused(env, backup, 'safety copy');
    },
  ],
  [
    'a store whose live database is missing is recovered with the documented steps',
    async () => {
      const { env, backup } = await storeWithBackup();
      const aside = path.join(env.FLO_DEV_USER_DATA, 'broken');
      fs.mkdirSync(aside);
      const move = (name: string) => {
        const from = path.join(env.FLO_DEV_USER_DATA, name);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(aside, name));
      };
      for (const name of ['flo.db', 'flo.db-wal', 'flo.db-shm']) move(name);

      let refused = '';
      await startHeadless(env).then(
        (server) => server.stop(),
        (error) => (refused = String(error)),
      );
      assertIncludesOrThrow(
        refused,
        'exited before ready',
        'with the marker still in place the server will not create a new database',
      );

      move('.flo-db-initialized');
      const fresh = await startHeadless(env);
      await fresh.stop();
      const result = await runKit('restore.cjs', [backup], env);
      console.log(result.output);
      assertEqualOrThrow(result.status, 0, 'restore exits 0');
      assertOrThrow(hasCategory(liveDbPath(env), 'cat-before'), 'the backed-up row is back');
      await assertServerHealthy(env, 'the server is healthy on the recovered store');
    },
  ],
]);
