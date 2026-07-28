'use strict';

const fs = require('node:fs');
const path = require('node:path');

fs.copyFileSync(
  path.join(__dirname, '../main/baileys-loader.cjs'),
  path.join(__dirname, '../dist/baileys-loader.cjs'),
);
