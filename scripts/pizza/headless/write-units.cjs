#!/usr/bin/env node
// Writes the kit's environment file and its systemd user units. The Node that runs this script
// is the Node the units run, by absolute path.
// Usage: write-units.cjs <environment file> <unit folder>
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, config, main } = require('./common.cjs');

const SAFE_PATH = /^\/[\w./-]*$/;

main(async () => {
  const settings = config(
    'PORT',
    'KDS_PORT',
    'SERVER_APP_PORT',
    'FLO_DEV_USER_DATA',
    'BACKUP_KEEP',
  );
  if (process.argv.length !== 4)
    throw new Error('Usage: write-units.cjs <environment file> <unit folder>');
  const [envFile, unitDir] = process.argv.slice(2).map((p) => path.resolve(p));
  const ports = ['PORT', 'KDS_PORT', 'SERVER_APP_PORT'];
  for (const name of ports) {
    const value = settings[name];
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      throw new Error(`${name} must be a port number from 1 to 65535, got ${value}`);
  }
  if (new Set(ports.map((name) => Number(settings[name]))).size !== ports.length)
    throw new Error(`PORT, KDS_PORT and SERVER_APP_PORT must be three different numbers`);
  if (!/^[1-9]\d*$/.test(settings.BACKUP_KEEP))
    throw new Error(
      `BACKUP_KEEP must be a whole number of at least 1, got ${settings.BACKUP_KEEP}`,
    );
  // systemd and the shell both read these unquoted, so only plain absolute paths are accepted.
  for (const [name, value] of [
    ['FLO_DEV_USER_DATA', settings.FLO_DEV_USER_DATA],
    ['the repository path', repoRoot],
    ['the Node path', process.execPath],
    ['the environment file', envFile],
  ]) {
    if (!SAFE_PATH.test(value))
      throw new Error(
        `${name} must be an absolute path of letters, digits, '.', '_', '-' and '/', got ${value}`,
      );
  }

  const node = process.execPath;
  const files = {
    [envFile]: Object.entries(settings)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    [path.join(unitDir, 'pizza-pos.service')]: `[Unit]
Description=Pizza POS server (headless)

[Service]
Type=simple
WorkingDirectory=${repoRoot}
EnvironmentFile=${envFile}
UMask=0077
ExecStart=${node} ${path.join(repoRoot, 'dev-server.js')}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
`,
    [path.join(unitDir, 'pizza-pos-backup.service')]: `[Unit]
Description=Pizza POS database backup

[Service]
Type=oneshot
WorkingDirectory=${repoRoot}
EnvironmentFile=${envFile}
UMask=0077
ExecStart=${node} ${path.join(__dirname, 'backup.cjs')}
`,
    [path.join(unitDir, 'pizza-pos-backup.timer')]: `[Unit]
Description=Daily Pizza POS database backup

[Timer]
OnCalendar=daily
Persistent=true
Unit=pizza-pos-backup.service

[Install]
WantedBy=timers.target
`,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${file}`);
  }
});
