#!/usr/bin/env node
// Fails unless each service answers its own health check on its configured port, and the newest
// daily backup is recent. The server moves to the next port without failing when one is taken,
// so the port is checked, not assumed.
const fs = require('node:fs');
const path = require('node:path');
const { config, BACKUP_NAME, backupDir, main } = require('./common.cjs');

const SERVICES = [
  ['PORT', 'Flo Local API'],
  ['KDS_PORT', 'Flo KDS Server'],
  ['SERVER_APP_PORT', 'Flo Server App'],
];
const MAX_BACKUP_AGE_HOURS = 26;

function checkBackups(dataDir) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) {
    console.log(`skip backups: no backup folder yet (${dir}); the first daily backup has not run`);
    return true;
  }
  const newest = fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) {
    console.error(`FAIL backups: no pizza-pos-*.db backup in ${dir}`);
    return false;
  }
  const hours = (Date.now() - newest.mtime) / 3_600_000;
  const line = `backups: newest ${newest.name} is ${hours.toFixed(1)} h old (limit ${MAX_BACKUP_AGE_HOURS} h)`;
  if (hours > MAX_BACKUP_AGE_HOURS) {
    console.error(`FAIL ${line}`);
    return false;
  }
  console.log(`ok   ${line}`);
  return true;
}

main(async () => {
  const settings = config(...SERVICES.map(([name]) => name), 'FLO_DEV_USER_DATA');
  let failed = 0;
  for (const [name, service] of SERVICES) {
    const label = `${name}=${settings[name]} (${service})`;
    try {
      const res = await fetch(`http://127.0.0.1:${settings[name]}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json();
      if (res.ok && body.status === 'ok' && body.service === service) {
        console.log(`ok   ${label}`);
        continue;
      }
      console.error(`FAIL ${label}: HTTP ${res.status} ${JSON.stringify(body)}`);
    } catch (error) {
      console.error(`FAIL ${label}: ${error?.cause?.code ?? error?.message ?? error}`);
    }
    failed++;
  }
  if (!checkBackups(settings.FLO_DEV_USER_DATA)) failed++;
  if (failed > 0) throw new Error(`${failed} health check(s) failed`);
});
