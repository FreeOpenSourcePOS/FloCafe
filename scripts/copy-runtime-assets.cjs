'use strict';

const fs = require('node:fs');
const path = require('node:path');

fs.copyFileSync(
  path.join(__dirname, '../main/baileys-loader.cjs'),
  // Compiled main output lives at dist/main/ (rootDir is the repo root since
  // shared/print was added, #441); whatsapp.js requires this sibling file.
  path.join(__dirname, '../dist/main/baileys-loader.cjs'),
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
