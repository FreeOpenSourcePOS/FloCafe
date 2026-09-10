#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEST_EXCLUSIONS = {
  'test:e2e:server': 'Long-running server process used by the dedicated Playwright jobs.',
  'test:e2e:browser': 'Runs in the dedicated browser Playwright CI job.',
  'test:e2e:electron': 'Runs in the dedicated native Electron Playwright CI job.',
  'test:e2e': 'Alias for the dedicated browser Playwright job.',
  'test:upgrade-regression': 'Alias of test:upgrade-path, which is in the default suite.',
  'test:currency-split': 'Subset alias already executed by test:currency in the default suite.',
};

function extractExecutedTestScripts(command) {
  const commandPattern = /(?:^|&&|\|\||;)\s*(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test(?::[\w:-]+)?)(?=\s|$)/g;
  return [...command.matchAll(commandPattern)].map((match) => match[1]);
}

function main() {
  const packagePath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts || {};
  const reachable = new Set(['pretest', 'test']);
  const pending = ['pretest', 'test'];

  while (pending.length > 0) {
    const scriptName = pending.shift();
    const command = scripts[scriptName] || '';
    for (const dependency of extractExecutedTestScripts(command)) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }

  const testScripts = Object.keys(scripts).filter((name) => name.startsWith('test:'));
  const missing = testScripts.filter((name) => !reachable.has(name) && !TEST_EXCLUSIONS[name]);
  const stale = Object.keys(TEST_EXCLUSIONS).filter((name) => !scripts[name] || reachable.has(name));
  const invalidReasons = Object.entries(TEST_EXCLUSIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 12)
    .map(([name]) => name);

  if (missing.length || stale.length || invalidReasons.length) {
    if (missing.length) console.error(`Uncovered test scripts: ${missing.join(', ')}`);
    if (stale.length) console.error(`Stale test exclusions: ${stale.join(', ')}`);
    if (invalidReasons.length) console.error(`Test exclusions without a useful reason: ${invalidReasons.join(', ')}`);
    process.exit(1);
  }

  console.log(`Test script coverage OK: ${testScripts.length - Object.keys(TEST_EXCLUSIONS).length} reachable, ${Object.keys(TEST_EXCLUSIONS).length} explicitly excluded.`);
}

if (require.main === module) main();

module.exports = { extractExecutedTestScripts };
