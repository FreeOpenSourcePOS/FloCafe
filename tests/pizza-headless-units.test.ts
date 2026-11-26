/**
 * Pizza fork, headless kit: the generated systemd user units and environment file carry the
 * configured ports, data folder, retention and the absolute Node path. Text only; no systemctl.
 *
 * Usage: npm run test:pizza-headless-units
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
const {
  assertEqualOrThrow,
  assertIncludesOrThrow,
  assertOrThrow,
} = require('./helpers/test-setup');
import { headlessEnv, kitDir, repoRoot, runCases, runKit } from './helpers/headless';

void runCases('Pizza headless kit: unit files', [
  [
    'writes the service, backup service, timer and environment file',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '7' });
      const envFile = path.join(env.HOME!, '.config', 'pizza-pos', 'headless.env');
      const unitDir = path.join(env.HOME!, '.config', 'systemd', 'user');
      const result = await runKit('write-units.cjs', [envFile, unitDir], env);
      console.log(result.output);
      assertEqualOrThrow(result.status, 0, 'write-units exits 0');

      const node = process.execPath;
      assertOrThrow(path.isAbsolute(node), `the Node path is absolute: ${node}`);
      const read = (file: string) => fs.readFileSync(file, 'utf8');

      const environment = read(envFile);
      assertIncludesOrThrow(environment, `PORT=${env.PORT}\n`, 'env file: API port');
      assertIncludesOrThrow(environment, `KDS_PORT=${env.KDS_PORT}\n`, 'env file: KDS port');
      assertIncludesOrThrow(
        environment,
        `SERVER_APP_PORT=${env.SERVER_APP_PORT}\n`,
        'env file: Server App port',
      );
      assertIncludesOrThrow(
        environment,
        `FLO_DEV_USER_DATA=${env.FLO_DEV_USER_DATA}\n`,
        'env file: data folder',
      );
      assertIncludesOrThrow(environment, 'BACKUP_KEEP=7\n', 'env file: retention');

      const service = read(path.join(unitDir, 'pizza-pos.service'));
      assertIncludesOrThrow(service, `EnvironmentFile=${envFile}\n`, 'service: environment file');
      assertIncludesOrThrow(
        service,
        `ExecStart=${node} ${path.join(repoRoot, 'dev-server.js')}\n`,
        'service: absolute Node runs dev-server.js',
      );
      assertIncludesOrThrow(
        service,
        `WorkingDirectory=${repoRoot}\n`,
        'service: working directory',
      );
      assertIncludesOrThrow(service, 'Restart=on-failure\n', 'service: restarts on failure');
      assertIncludesOrThrow(service, 'UMask=0077\n', 'service: files are private to the owner');
      assertIncludesOrThrow(
        service,
        'WantedBy=default.target\n',
        'service: starts with the user manager',
      );

      const backupService = read(path.join(unitDir, 'pizza-pos-backup.service'));
      assertIncludesOrThrow(
        backupService,
        `EnvironmentFile=${envFile}\n`,
        'backup: environment file',
      );
      assertIncludesOrThrow(
        backupService,
        `ExecStart=${node} ${path.join(kitDir, 'backup.cjs')}\n`,
        'backup: absolute Node runs backup.cjs',
      );
      assertIncludesOrThrow(backupService, 'Type=oneshot\n', 'backup: one-shot');
      assertIncludesOrThrow(
        backupService,
        'UMask=0077\n',
        'backup: files are private to the owner',
      );

      const timer = read(path.join(unitDir, 'pizza-pos-backup.timer'));
      assertIncludesOrThrow(timer, 'OnCalendar=daily\n', 'timer: daily');
      assertIncludesOrThrow(timer, 'Persistent=true\n', 'timer: catches up a missed run');
      assertIncludesOrThrow(timer, 'Unit=pizza-pos-backup.service\n', 'timer: runs the backup');
      assertIncludesOrThrow(timer, 'WantedBy=timers.target\n', 'timer: enabled with timers');
    },
  ],
  [
    'install.sh closes the data folder to other accounts',
    async () => {
      assertIncludesOrThrow(
        fs.readFileSync(path.join(kitDir, 'install.sh'), 'utf8'),
        'chmod 700 "$FLO_DEV_USER_DATA"\n',
        'install.sh: data folder mode 700',
      );
    },
  ],
  [
    'refuses a relative data folder',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '7', FLO_DEV_USER_DATA: 'data' });
      const unitDir = path.join(env.HOME!, 'units');
      const result = await runKit('write-units.cjs', [path.join(env.HOME!, 'env'), unitDir], env);
      console.log(result.output);
      assertOrThrow(result.status !== 0, 'write-units exits non-zero');
      assertIncludesOrThrow(result.stderr, 'FLO_DEV_USER_DATA', 'the error names the setting');
      assertOrThrow(!fs.existsSync(unitDir), 'no unit was written');
    },
  ],
  [
    'refuses a port that is not plain digits',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '7', KDS_PORT: '0x1F90' });
      const unitDir = path.join(env.HOME!, 'units');
      const result = await runKit('write-units.cjs', [path.join(env.HOME!, 'env'), unitDir], env);
      console.log(result.output);
      assertOrThrow(result.status !== 0, 'write-units exits non-zero');
      assertIncludesOrThrow(result.stderr, 'KDS_PORT', 'the error names the setting');
      assertOrThrow(!fs.existsSync(unitDir), 'no unit was written');
    },
  ],
  [
    'refuses two services on the same port',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '7' });
      env.SERVER_APP_PORT = env.KDS_PORT;
      const unitDir = path.join(env.HOME!, 'units');
      const result = await runKit('write-units.cjs', [path.join(env.HOME!, 'env'), unitDir], env);
      console.log(result.output);
      assertOrThrow(result.status !== 0, 'write-units exits non-zero');
      assertIncludesOrThrow(result.stderr, 'different', 'the error says the ports must differ');
      assertOrThrow(!fs.existsSync(unitDir), 'no unit was written');
    },
  ],
]);
