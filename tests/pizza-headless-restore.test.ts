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
