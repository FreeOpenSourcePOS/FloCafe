'use strict';

const assert = require('node:assert/strict');
const { extractExecutedTestScripts } = require('../scripts/ci/validate-test-script-coverage.cjs');

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

console.log('Test-script command parsing verified.');
