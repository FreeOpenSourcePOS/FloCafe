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

// Suite files that a real script runs but that `pretest`/`test` does not reach.
// Every file the closure does cover - including everything `pretest` pulls in via
// test:release-regressions - must be absent from this list.
const TEST_FILE_EXCLUSIONS = {
  'tests/db-audit.test.ts': 'Run by the dedicated `npm run audit:db` command, not by the default suite.',
  'tests/whatsapp-shutdown-timeout.test.ts': 'Parked on a production bug: waitForWhatsAppWork() in main/services/whatsapp.ts spreads a Map where promises are expected, so the drain loop starves the event loop and the suite hangs instead of failing. Restored and parked pending the fix task for that behaviour; do not delete.',
};

// Splits on top-level `&&`, `||`, and `;`, leaving text inside '...' or "..."
// quotes untouched so a quoted operator can't fake a command boundary.
function splitTopLevelCommands(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function extractExecutedTestScripts(command) {
  const commandStartPattern = /^(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test(?::[\w:-]+)?)(?:\s|$)/;
  return splitTopLevelCommands(command)
    .map((segment) => segment.trim().match(commandStartPattern))
    .filter(Boolean)
    .map((match) => match[1]);
}

// Transitive closure of the default run: `pretest` and `test` plus everything
// they invoke. Suite files wired only through `pretest` (test:release-
// regressions, test:payment-methods-split) or through another reachable
// `test:*` script are covered, which is why the orphan check below does not
// accept "named by any script" as proof a test file actually runs.
function collectReachableScripts(scripts) {
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
  return reachable;
}

// Suite files a command actually executes, e.g.
// `node tests/run-electron-node-test.cjs tests/held-orders.test.ts`.
function extractReferencedTestFiles(command) {
  const pattern = /(?:^|[\s'"])(tests\/[\w.\/-]+\.test\.(?:ts|cjs|js|mjs))/g;
  // match[1], not match.slice(1): the boundary alternates a real character with
  // the zero-width `^`, so slicing by one drops the leading `t` on a match that
  // anchors at the start of the command.
  return [...new Set([...command.matchAll(pattern)].map((match) => match[1]))];
}

function listTestFiles() {
  const testsDir = path.join(__dirname, '..', '..', 'tests');
  return fs.readdirSync(testsDir)
    .filter((name) => /\.test\.(ts|cjs|js|mjs)$/.test(name))
    .sort()
    .map((name) => `tests/${name}`);
}

function main() {
  const packagePath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts || {};
  const reachable = collectReachableScripts(scripts);

  const testScripts = Object.keys(scripts).filter((name) => name.startsWith('test:'));
  const missing = testScripts.filter((name) => !reachable.has(name) && !TEST_EXCLUSIONS[name]);
  const stale = Object.keys(TEST_EXCLUSIONS).filter((name) => !scripts[name] || reachable.has(name));
  const invalidReasons = Object.entries(TEST_EXCLUSIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 12)
    .map(([name]) => name);

  const referencedTestFiles = new Set();
  for (const name of reachable) {
    for (const file of extractReferencedTestFiles(scripts[name] || '')) {
      referencedTestFiles.add(file);
    }
  }
  const testFiles = listTestFiles();
  const orphaned = testFiles
    .filter((file) => !referencedTestFiles.has(file))
    .filter((file) => !TEST_FILE_EXCLUSIONS[file]);
  const staleFileExclusions = Object.keys(TEST_FILE_EXCLUSIONS)
    .filter((file) => !testFiles.includes(file) || referencedTestFiles.has(file));
  const invalidFileReasons = Object.entries(TEST_FILE_EXCLUSIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 12)
    .map(([file]) => file);

  if (missing.length || stale.length || invalidReasons.length || orphaned.length || staleFileExclusions.length || invalidFileReasons.length) {
    if (missing.length) console.error(`Uncovered test scripts: ${missing.join(', ')}`);
    if (stale.length) console.error(`Stale test exclusions: ${stale.join(', ')}`);
    if (invalidReasons.length) console.error(`Test exclusions without a useful reason: ${invalidReasons.join(', ')}`);
    if (orphaned.length) console.error(`Test files no reachable script runs: ${orphaned.join(', ')}`);
    if (staleFileExclusions.length) console.error(`Stale test-file exclusions: ${staleFileExclusions.join(', ')}`);
    if (invalidFileReasons.length) console.error(`Test-file exclusions without a useful reason: ${invalidFileReasons.join(', ')}`);
    process.exit(1);
  }

  console.log(`Test script coverage OK: ${testScripts.length - Object.keys(TEST_EXCLUSIONS).length} reachable, ${Object.keys(TEST_EXCLUSIONS).length} explicitly excluded.`);
  console.log(`Test file coverage OK: ${testFiles.length - Object.keys(TEST_FILE_EXCLUSIONS).length} run by the default suite, ${Object.keys(TEST_FILE_EXCLUSIONS).length} by a dedicated command.`);
}

if (require.main === module) main();

module.exports = {
  extractExecutedTestScripts,
  extractReferencedTestFiles,
  collectReachableScripts,
  listTestFiles,
  TEST_FILE_EXCLUSIONS,
};
