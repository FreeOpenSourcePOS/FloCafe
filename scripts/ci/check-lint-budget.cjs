#!/usr/bin/env node
// Fails CI if lint warning counts exceed the recorded budget in lint-budget.json,
// if either scope reports an error-severity diagnostic, or if a linter run cannot
// be read. Per docs' stabilization plan Phase 4: no cleanup campaign — the budget
// only ratchets down manually as warnings are fixed incidentally while touching a file.
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const BUDGET_PATH = path.join(__dirname, 'lint-budget.json');
const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));

const SCOPES = [
  { name: 'backend', cwd: ROOT, args: ['main/', 'shared/'] },
  { name: 'frontend', cwd: path.join(ROOT, 'frontend'), args: ['.'] },
];

for (const scope of SCOPES) {
  const limit = budget?.[scope.name];
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`Lint warning budget for ${scope.name} must be a finite non-negative number.`);
  }
}

function countDiagnostics(scope) {
  const result = spawnSync('npx', ['oxlint', ...scope.args, '--format', 'json'], {
    cwd: scope.cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.error) {
    throw new Error(`oxlint could not run for ${scope.name}: ${result.error.message}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().slice(0, 1000);
    throw new Error(
      `oxlint did not report valid JSON for ${scope.name} (exit ${result.status}).\n${details}`,
    );
  }
  if (!Array.isArray(report.diagnostics)) {
    throw new Error(`oxlint reported no diagnostics list for ${scope.name}.`);
  }
  if (report.diagnostics.some((diagnostic) => !['error', 'warning'].includes(diagnostic?.severity))) {
    throw new Error(`oxlint reported an invalid diagnostic severity for ${scope.name}.`);
  }
  return {
    errors: report.diagnostics.filter((d) => d.severity === 'error').length,
    warnings: report.diagnostics.filter((d) => d.severity === 'warning').length,
    exitCode: result.status,
  };
}

let failed = false;
for (const scope of SCOPES) {
  let counts;
  try {
    counts = countDiagnostics(scope);
  } catch (err) {
    console.error(err.message);
    failed = true;
    continue;
  }
  const limit = budget[scope.name];
  if (counts.errors > 0) {
    console.error(`Lint errors in ${scope.name}: ${counts.errors} error-severity diagnostics.`);
    failed = true;
  }
  if (counts.exitCode !== 0 && counts.errors === 0) {
    console.error(`oxlint exited ${counts.exitCode} for ${scope.name} without reporting a lint error.`);
    failed = true;
  }
  if (counts.warnings > limit) {
    console.error(`Lint warning budget exceeded for ${scope.name}: ${counts.warnings} warnings (budget: ${limit}).`);
    failed = true;
  } else {
    console.log(`Lint warning budget OK for ${scope.name}: ${counts.warnings} warnings (budget: ${limit}).`);
  }
}

if (failed) {
  console.error('\nLower this by fixing warnings, not by raising the budget, unless the increase is a deliberate, reviewed tradeoff.');
  process.exit(1);
}
