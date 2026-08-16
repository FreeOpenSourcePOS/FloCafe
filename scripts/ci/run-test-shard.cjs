#!/usr/bin/env node
/*
 * CI test sharding for the FloCafe "Core test suite" (`npm test`).
 *
 * The canonical, ordered suite list lives in package.json's "test" script as a
 * chain of `bash tests/run-test.sh npm run test:<name>` invocations. This helper
 * reads that script at run time (so there is no second list to drift), assigns
 * suites to shards round-robin by position, and runs this shard's subset with
 * the same `run-test.sh` wrapper that `npm test` uses.
 *
 * Usage:
 *   SHARD_TOTAL=2 SHARD_INDEX=0 node scripts/ci/run-test-shard.cjs
 *
 * The `pretest` hook (test:payment-methods-split) is intentionally NOT run here;
 * CI runs it as its own step before the shards, mirroring `npm test`'s pretest.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseIntEnv(name, value, fallback, min) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    console.error(`Invalid ${name}=${value}: expected an integer >= ${min}.`);
    process.exit(2);
  }
  return n;
}

const total = parseIntEnv('SHARD_TOTAL', process.env.SHARD_TOTAL, 2, 1);
const index = parseIntEnv('SHARD_INDEX', process.env.SHARD_INDEX, 0, 0);
if (index >= total) {
  console.error(`Invalid SHARD_INDEX=${index}: must be < SHARD_TOTAL=${total}.`);
  process.exit(2);
}

const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const testScript = pkg.scripts && pkg.scripts.test;
if (typeof testScript !== 'string' || testScript.length === 0) {
  console.error('package.json has no "test" script to shard.');
  process.exit(2);
}

const suitePattern = /(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test:[\w-]+)/g;
const suites = [];
let match;
while ((match = suitePattern.exec(testScript)) !== null) {
  if (!suites.includes(match[1])) suites.push(match[1]);
}

if (suites.length === 0) {
  console.error('Could not extract any test suites from package.json "test" script.');
  process.exit(2);
}

const mine = suites.filter((_, i) => i % total === index);
console.log(
  `[test-shard] shard ${index}/${total}: ${mine.length}/${suites.length} suites (total across shards).`,
);

let failed = false;
for (const suite of mine) {
  console.log(`\n=== [shard ${index}] ${suite} ===`);
  const result = spawnSync('bash', ['tests/run-test.sh', 'npm', 'run', suite], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`[shard ${index}] FAILED: ${suite}`);
    failed = true;
    break;
  }
}

process.exit(failed ? 1 : 0);
