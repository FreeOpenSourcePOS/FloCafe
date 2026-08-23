#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const releaseDir = path.resolve(process.argv[2] || 'release');
if (!fs.existsSync(releaseDir)) {
  console.error(`::error::release directory does not exist: ${releaseDir}`);
  process.exit(1);
}

const unsafe = fs.readdirSync(releaseDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => !/^[a-z0-9.-]+$/.test(name));

if (unsafe.length > 0) {
  console.error(`::error::unsafe release artifact filename(s): ${unsafe.join(', ')}`);
  console.error('Artifact filenames must match [a-z0-9.-]+; do not rename artifacts after electron-builder produces them.');
  process.exit(1);
}

console.log(`release artifact filenames passed [a-z0-9.-] assertion in ${releaseDir}`);
