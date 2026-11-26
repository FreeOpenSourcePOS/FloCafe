/**
 * Pizza fork, headless kit: the health check passes against a running headless server and fails
 * loudly when a service is not on its configured port.
 *
 * Usage: npm run test:pizza-headless-health
 */
const {
  assertEqualOrThrow,
  assertIncludesOrThrow,
  assertOrThrow,
} = require('./helpers/test-setup');
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  backupDir,
  headlessEnv,
  liveDbPath,
  occupyPort,
  runCases,
  runKit,
  startHeadless,
  type HeadlessEnv,
} from './helpers/headless';

/** Makes the store look as if it was set up long ago: its settings carry an old date. */
function ageStore(env: HeadlessEnv, date = '2000-01-01 00:00:00') {
  const db = new Database(liveDbPath(env), { timeout: 5000 });
  try {
    db.prepare('UPDATE settings SET updated_at = ?').run(date);
  } finally {
    db.close();
  }
}

void runCases('Pizza headless kit: fixed-port health check', [
  [
    'passes when all three services answer on their configured ports',
    async () => {
      const env = await headlessEnv();
      const server = await startHeadless(env);
      try {
        const result = await runKit('health.cjs', [], env);
        console.log(result.output);
        assertEqualOrThrow(result.status, 0, 'health check exits 0');
        assertIncludesOrThrow(result.stdout, `ok   PORT=${env.PORT}`, 'API reported ok');
        assertIncludesOrThrow(result.stdout, `ok   KDS_PORT=${env.KDS_PORT}`, 'KDS reported ok');
        assertIncludesOrThrow(
          result.stdout,
          `ok   SERVER_APP_PORT=${env.SERVER_APP_PORT}`,
          'Server App reported ok',
        );
        assertIncludesOrThrow(
          result.stdout,
          'ok   backups: no pizza-pos-*.db backup in',
          'a store set up within the last day passes without a backup',
        );
        assertIncludesOrThrow(result.stdout, 'first daily backup is not due', 'and says why');
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'fails when the newest backup is older than 26 hours',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '3' });
      const server = await startHeadless(env);
      try {
        const backup = await runKit('backup.cjs', [], env);
        assertEqualOrThrow(backup.status, 0, `backup exits 0: ${backup.output}`);
        const backupPath = backup.stdout.trim().split('\n').pop()!;

        const fresh = await runKit('health.cjs', [], env);
        console.log(fresh.output);
        assertEqualOrThrow(fresh.status, 0, 'health passes with a fresh backup');
        assertIncludesOrThrow(fresh.stdout, 'ok   backups:', 'fresh backup reported ok');

        const old = new Date(Date.now() - 27 * 3600 * 1000);
        fs.utimesSync(backupPath, old, old);
        const young = await runKit('health.cjs', [], env);
        assertEqualOrThrow(young.status, 0, `a store set up today still passes: ${young.output}`);
        ageStore(env);
        const stale = await runKit('health.cjs', [], env);
        console.log(stale.output);
        assertOrThrow(stale.status !== 0, 'health fails with a 27-hour-old backup');
        assertIncludesOrThrow(stale.stderr, 'FAIL backups:', 'stale backup reported as failing');
        assertIncludesOrThrow(stale.stdout, `ok   PORT=${env.PORT}`, 'services still reported ok');
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'fails when a store older than a day has never been backed up',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '3' });
      const server = await startHeadless(env);
      try {
        ageStore(env);
        const never = await runKit('health.cjs', [], env);
        console.log(never.output);
        assertOrThrow(never.status !== 0, 'health fails with no backup folder');
        assertIncludesOrThrow(
          never.stderr,
          'FAIL backups: no pizza-pos-*.db backup in',
          'the missing backup is reported as failing',
        );
        assertIncludesOrThrow(never.stdout, `ok   PORT=${env.PORT}`, 'services still reported ok');

        fs.mkdirSync(backupDir(env));
        const empty = await runKit('health.cjs', [], env);
        assertOrThrow(empty.status !== 0, 'and with an empty backup folder');

        const backup = await runKit('backup.cjs', [], env);
        assertEqualOrThrow(backup.status, 0, `backup exits 0: ${backup.output}`);
        const backed = await runKit('health.cjs', [], env);
        assertEqualOrThrow(
          backed.status,
          0,
          `health passes once a backup exists: ${backed.output}`,
        );
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'a backup or a store dated in the future does not count as recent',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '3' });
      const server = await startHeadless(env);
      try {
        // After a clock rollback, what was written before it looks newer than now.
        ageStore(env, '2999-01-01 00:00:00');
        const futureStore = await runKit('health.cjs', [], env);
        console.log(futureStore.output);
        assertOrThrow(futureStore.status !== 0, 'a store dated in the future is not a new store');
        assertIncludesOrThrow(futureStore.stderr, 'FAIL backups:', 'the backup check fails');

        ageStore(env);
        const backup = await runKit('backup.cjs', [], env);
        assertEqualOrThrow(backup.status, 0, `backup exits 0: ${backup.output}`);
        const ahead = new Date(Date.now() + 3 * 3600 * 1000);
        const dated = backup.stdout.trim().split('\n').pop()!;
        fs.utimesSync(dated, ahead, ahead);
        const futureBackup = await runKit('health.cjs', [], env);
        console.log(futureBackup.output);
        assertOrThrow(futureBackup.status !== 0, 'a backup dated in the future is not recent');
        assertIncludesOrThrow(futureBackup.stderr, 'dated in the future', 'and the line says so');

        // A recent backup beside it counts: the future-dated one is reported, not put first.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await runKit('backup.cjs', [], env);
        assertEqualOrThrow(second.status, 0, `a second backup exits 0: ${second.output}`);
        const both = await runKit('health.cjs', [], env);
        console.log(both.output);
        assertEqualOrThrow(both.status, 0, 'health passes on the recent backup');
        assertIncludesOrThrow(
          both.stdout,
          `ok   backups: newest ${path.basename(second.stdout.trim().split('\n').pop()!)}`,
          'the recent backup is the one measured',
        );
        assertIncludesOrThrow(
          both.output,
          `not counted: ${path.basename(dated)} is dated in the future`,
          'and the future-dated one is reported',
        );
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'fails naming the KDS port when the server had to move off it',
    async () => {
      const env = await headlessEnv();
      const blocker = await occupyPort(Number(env.KDS_PORT));
      try {
        const server = await startHeadless(env);
        try {
          assertOrThrow(
            server.output().includes(`Port ${env.KDS_PORT} in use`),
            'the server moved the KDS off its configured port',
          );
          const result = await runKit('health.cjs', [], env);
          console.log(result.output);
          assertOrThrow(result.status !== 0, 'health check exits non-zero');
          assertIncludesOrThrow(result.stdout, `ok   PORT=${env.PORT}`, 'API still reported ok');
          assertIncludesOrThrow(
            result.stderr,
            `FAIL KDS_PORT=${env.KDS_PORT}`,
            'KDS reported as failing on its configured port',
          );
        } finally {
          await server.stop();
        }
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    },
  ],
]);
