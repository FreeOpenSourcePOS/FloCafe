#!/usr/bin/env node
'use strict';

// lint-staged task: format files in a package's formatter scope and lint files in its lint scope.
// Selection happens here rather than in shell globs so excluded and generated
// artifacts never reach Oxfmt, where they would exit 2 as "no target files".

const { spawnSync } = require('node:child_process');
const scope = require('./scope.cjs');

const EMPTY_TARGET_HINT =
  'Oxfmt exited 2: every selected file was excluded by ignore rules. Update scripts/oxc/scope.cjs.';

function parse(argv) {
  const options = { packageName: null, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--package') {
      options.packageName = argv[index + 1];
      index += 1;
      continue;
    }
    options.files.push(argv[index]);
  }
  if (!options.packageName) throw new Error('Missing required --package <root|frontend> argument.');
  return options;
}

function run(invocation, label) {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  if (result.status === 0) return;
  if (result.status === 2) console.error(EMPTY_TARGET_HINT);
  console.error(`${label} failed for package "${invocation.cwd}" with exit ${result.status}.`);
  process.exit(result.status ?? 1);
}

function main() {
  const { packageName, files } = parse(process.argv.slice(2));
  const pkg = scope.packageByName(packageName);
  const { format, lint } = scope.selectFiles(pkg, files);
  if (format.length === 0 && lint.length === 0) {
    console.log(`No staged ${packageName} files are in the Oxc scope; nothing to check.`);
    return;
  }
  if (format.length > 0) {
    run(scope.oxfmtInvocation(pkg, format, { mode: 'write' }), 'oxfmt --write');
    console.log(`Formatted ${format.length} staged ${packageName} file(s).`);
  }
  if (lint.length > 0) {
    run(scope.oxlintInvocation(pkg, lint), 'oxlint');
    console.log(`Linted ${lint.length} staged ${packageName} file(s).`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
