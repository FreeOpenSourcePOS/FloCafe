'use strict';

const fs = require('node:fs');
const path = require('node:path');

fs.copyFileSync(
  path.join(__dirname, '../main/baileys-loader.cjs'),
  // Compiled main output lives at dist/main/ (rootDir is the repo root since
  // shared/print was added, #441); whatsapp.js requires this sibling file.
  path.join(__dirname, '../dist/main/baileys-loader.cjs'),
);
