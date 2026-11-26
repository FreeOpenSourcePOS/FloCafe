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
import { headlessEnv, occupyPort, runCases, runKit, startHeadless } from './helpers/headless';

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
          'skip backups: no backup folder yet',
          'the backup age check says it was skipped before the first backup',
        );
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
