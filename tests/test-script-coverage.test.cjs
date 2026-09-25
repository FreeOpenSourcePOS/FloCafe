'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  extractExecutedTestScripts,
  extractReferencedTestFiles,
  collectReachableScripts,
  listTestFiles,
  TEST_FILE_EXCLUSIONS,
} = require('../scripts/ci/validate-test-script-coverage.cjs');

assert.deepEqual(
  extractExecutedTestScripts('npm run test:direct && bash tests/run-test.sh npm run test:wrapped'),
  ['test:direct', 'test:wrapped'],
);
assert.deepEqual(
  extractExecutedTestScripts('echo "npm run test:not-executed" && npm run test:executed'),
  ['test:executed'],
);
assert.deepEqual(
  extractExecutedTestScripts('node helper.cjs npm run test:argument'),
  [],
);
assert.deepEqual(
  extractExecutedTestScripts('echo "&& npm run test:phantom --note"'),
  [],
);
assert.deepEqual(
  extractExecutedTestScripts("echo '; npm run test:phantom' && npm run test:executed"),
  ['test:executed'],
);

assert.deepEqual(
  extractReferencedTestFiles(
    'node tests/run-electron-node-test.cjs tests/held-orders.test.ts && ts-node -P tests/tsconfig.json tests/db.test.cjs && node tests/helper.cjs',
  ),
  ['tests/held-orders.test.ts', 'tests/db.test.cjs'],
  'only suite files a command actually executes are extracted',
);
assert.deepEqual(
  extractReferencedTestFiles('node tests/run-electron-node-test.cjs tests/held-orders.test.ts tests/held-orders.test.ts'),
  ['tests/held-orders.test.ts'],
  'a file named twice is reported once',
);
assert.deepEqual(
  collectReachableScripts({
    pretest: 'npm run test:outer',
    test: 'npm run test:inner && npm run lint',
    'test:outer': 'npm run test:deepest && node x.cjs',
    'test:inner': 'node y.cjs',
    'test:deepest': 'node z.cjs',
    'test:unrelated': 'node orphan.cjs',
    'lint': 'eslint main/',
  }),
  new Set(['pretest', 'test', 'test:outer', 'test:inner', 'test:deepest']),
  'the closure follows nested test scripts and stops at non-test scripts',
);

// This repository, not a fixture: the eight suites that no script referenced must
// now be covered by the default run, and nothing may be allowlisted that the
// closure already reaches.
const pkg = require(path.join(__dirname, '..', 'package.json'));
const reachable = collectReachableScripts(pkg.scripts);
const referenced = new Set();
for (const name of reachable) {
  for (const file of extractReferencedTestFiles(pkg.scripts[name] || '')) referenced.add(file);
}
const testFiles = listTestFiles();
assert.deepEqual(
  testFiles.filter((file) => !referenced.has(file) && !TEST_FILE_EXCLUSIONS[file]),
  [],
  'every tests/*.test.* file is executed by a script the default run reaches',
);
assert.ok(
  reachable.has('test:release-regressions') && referenced.has('tests/browser-receipts.test.ts'),
  'suites reached only through pretest are covered without an allowlist entry',
);
for (const file of ['tests/issue-646-floor-management.test.ts', 'tests/windows-backup-unlink-ebusy.test.ts']) {
  assert.ok(referenced.has(file), `${file} is now wired into the default run`);
}
for (const [file, reason] of Object.entries(TEST_FILE_EXCLUSIONS)) {
  assert.ok(testFiles.includes(file), `allowlisted ${file} still exists`);
  assert.ok(!referenced.has(file), `allowlisted ${file} is not reachable (${reason})`);
}

console.log('Test-script command parsing verified.');
