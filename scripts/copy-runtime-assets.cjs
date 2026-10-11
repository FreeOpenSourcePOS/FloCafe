'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function buildIdentity() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) return { schema_version: 1, build_id: 'unknown', source_commit: null };
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
    if (status.trim()) return { schema_version: 1, build_id: 'custom', source_commit: null };
    return { schema_version: 1, build_id: commit, source_commit: commit };
  } catch {
    return { schema_version: 1, build_id: 'unknown', source_commit: null };
  }
}

fs.copyFileSync(
  path.join(__dirname, '../main/baileys-loader.cjs'),
  // Compiled main output lives at dist/main/ (rootDir is the repo root since
  // shared/print was added, #441); whatsapp.js requires this sibling file.
  path.join(__dirname, '../dist/main/baileys-loader.cjs'),
);

fs.writeFileSync(
  path.join(root, 'dist/main/build-identity.json'),
  JSON.stringify(buildIdentity()),
  'utf8',
);

// Runtime modules resolve the app version from this sibling package manifest.
fs.copyFileSync(
  path.join(__dirname, '../package.json'),
  path.join(__dirname, '../dist/package.json'),
);

const driveClientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
const driveClientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
if (driveClientId && driveClientSecret) {
  fs.writeFileSync(
    path.join(__dirname, '../dist/google-drive-client.json'),
    JSON.stringify({ clientId: driveClientId, clientSecret: driveClientSecret }, null, 2),
    'utf8',
  );
}
