#!/usr/bin/env node
'use strict';
// Runs every test:* suite named in package.json's "pretest" and "test" scripts,
// one after another, without stopping at the first failure, and records the
// result and time of each. A suite that scripts/run-test.cjs skipped for an ABI
// mismatch is recorded as "skip", not as a pass. A suite that times out stops
// the run, because its child processes may still hold ports.
// Usage: node run-suite-report.cjs <repoDir> <outDir>
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [repo, out] = process.argv.slice(2);
if (!repo || !out) {
  console.error('Usage: node run-suite-report.cjs <repoDir> <outDir>');
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const suites = [];
for (const key of ['pretest', 'test']) {
  const re = /npm\s+run\s+(test:[\w-]+)/g;
  let m;
  while ((m = re.exec(pkg.scripts[key] || '')) !== null) {
    if (!suites.includes(m[1])) suites.push(m[1]);
  }
}
if (suites.length === 0) {
  console.error('No test:* suites found in package.json "pretest"/"test".');
  process.exit(2);
}
fs.mkdirSync(path.join(out, 'suites'), { recursive: true });
const results = path.join(out, 'results.tsv');
fs.writeFileSync(results, '');
let failed = 0;
let skipped = 0;
for (const suite of suites) {
  const log = path.join(out, 'suites', suite.replace(/[^\w-]/g, '_') + '.log');
  const fd = fs.openSync(log, 'w');
  const started = Date.now();
  const r = spawnSync('node', ['scripts/run-test.cjs', 'npm', 'run', suite], {
    cwd: repo,
    stdio: ['ignore', fd, fd],
    env: process.env,
    timeout: 20 * 60 * 1000,
  });
  fs.closeSync(fd);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  let status = r.error
    ? `error:${r.error.code}`
    : r.signal
      ? `signal:${r.signal}`
      : String(r.status);
  if (status === '0' && fs.readFileSync(log, 'utf8').includes('Skipped (ABI mismatch)')) {
    status = 'skip';
    skipped += 1;
  } else if (status !== '0') {
    failed += 1;
  }
  fs.appendFileSync(results, `${suite}\t${status}\t${secs}\n`);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.error(`Stopped: ${suite} timed out; its child processes may still be running.`);
    process.exit(1);
  }
}
console.log(`${suites.length} suites, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
