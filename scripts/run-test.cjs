#!/usr/bin/env node
'use strict';

// Runs a test command and treats exit code 77 (ABI-mismatch skip) as success.
// Usage: node scripts/run-test.cjs npm run test:integration-happy

const { spawnSync } = require('node:child_process');

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/run-test.cjs <test command> [args...]');
  process.exit(2);
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === 77) {
  console.log('  ⏭ Skipped (ABI mismatch)');
  process.exit(0);
}
process.exit(result.status ?? 1);
