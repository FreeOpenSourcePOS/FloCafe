#!/usr/bin/env node
'use strict';

// Changed-file formatting gate.
//
// Verifies that the JS/TS files a change touches are Oxfmt-formatted. The repository-wide
// formatting backlog is deliberately not a CI failure, so each touched file is checked as a
// whole (never a modified hunk) and untouched legacy files stay out of scope.
//
// Usage: node scripts/ci/check-changed-format.cjs [--base <rev>]

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const scope = require('../oxc/scope.cjs');

const HISTORY_FETCH_DEPTH = 200;

const USAGE = 'Pass --base <rev> when there is no GitHub event payload.';

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed with exit ${result.status}.\n${details}`);
  }
  return result;
}

function commitExists(rev) {
  return git(['cat-file', '-e', `${rev}^{commit}`], { allowFailure: true }).status === 0;
}

// Shallow clones may not have the comparison commit yet; fetch exactly that commit.
function ensureCommit(rev) {
  if (!commitExists(rev)) {
    const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', rev], { allowFailure: true });
    if (!commitExists(rev)) {
      const details = (fetched.stderr || fetched.stdout || '').trim();
      throw new Error(
        `Cannot compare against ${rev}; the commit is unavailable locally.\n${details}`,
      );
    }
  }
  return git(['rev-parse', '--verify', `${rev}^{commit}`]).stdout.trim();
}

function parseArgs(argv) {
  const options = { base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') {
      options.base = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}. ${USAGE}`);
    }
  }
  return options;
}

function comparisonFromPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const base = event?.pull_request?.base?.sha;
    if (!base) throw new Error('The pull request payload has no base commit to compare against.');
    return {
      base,
      head: 'HEAD',
      strategy: 'merge-base',
      description: `pull request base ${base}`,
    };
  }
  if (eventName === 'push') {
    const before = event?.before;
    if (!before || /^0+$/.test(before)) {
      throw new Error(`This push has no previous commit to compare against. ${USAGE}`);
    }
    const after = event?.after;
    if (!after || /^0+$/.test(after)) {
      throw new Error(`This push has no new commit to compare against. ${USAGE}`);
    }
    return {
      base: before,
      head: after,
      strategy: 'range',
      description: `pushed range ${before}..${after}`,
    };
  }
  return null;
}

function resolveComparison(options) {
  if (options.base) {
    return {
      base: options.base,
      head: 'HEAD',
      strategy: 'merge-base',
      description: `explicit base ${options.base}`,
    };
  }
  const fromPayload = comparisonFromPayload();
  if (fromPayload) return fromPayload;
  throw new Error(`No comparison base was found for this run. ${USAGE}`);
}

function mergeBaseCommit(base, head) {
  let result = git(['merge-base', base, head], { allowFailure: true });
  if (result.status === 0) return result.stdout.trim();

  const fetched = git(
    ['fetch', '--no-tags', `--deepen=${HISTORY_FETCH_DEPTH}`, 'origin', base, head],
    { allowFailure: true },
  );
  result = git(['merge-base', base, head], { allowFailure: true });
  if (result.status === 0) return result.stdout.trim();

  const details = (result.stderr || result.stdout || fetched.stderr || fetched.stdout || '').trim();
  throw new Error(
    `Cannot determine the merge base between ${base} and ${head} after fetching up to ${HISTORY_FETCH_DEPTH} commits of history.\n${details}`,
  );
}

function changedFiles(base, head, strategy) {
  const from = strategy === 'merge-base' ? mergeBaseCommit(base, head) : base;
  const diff = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${from}..${head}`]);
  return diff.stdout.split('\0').filter(Boolean);
}

function runCheck(pkg, files) {
  const invocation = scope.oxfmtInvocation(pkg, files, { mode: 'check' });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`oxfmt could not run: ${result.error.message}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0) return;
  if (output) console.error(output);
  if (result.status === 2) {
    throw new Error(
      `Oxfmt excluded every selected ${pkg.name} file. Update scripts/oxc/scope.cjs to match ${pkg.configFile}.`,
    );
  }
  console.error(`Selected ${files.length} changed ${pkg.name} file(s): ${files.join(', ')}`);
  const repair =
    pkg.name === 'frontend'
      ? 'Run "npx oxfmt --write --" from frontend/ with only the selected frontend paths.'
      : 'Run "npx oxfmt --write --" from the repository root with only the selected root paths.';
  throw new Error(
    `Oxfmt failed for ${files.length} changed ${pkg.name} file(s) with exit ${result.status}. ${repair} Quote paths containing spaces.`,
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { base, head, strategy, description } = resolveComparison(options);
  const baseCommit = ensureCommit(base);
  const headCommit = ensureCommit(head);
  const changed = changedFiles(baseCommit, headCommit, strategy);
  console.log(`Changed-file format check (${description}): ${changed.length} changed file(s).`);

  const selections = scope.PACKAGES.map((pkg) => ({ pkg, ...scope.selectFiles(pkg, changed) }));
  const selectedCount = selections.reduce((total, entry) => total + entry.format.length, 0);

  if (selectedCount === 0) {
    console.log('No JS/TS files in the Oxc formatting scope changed; nothing to check.');
    return;
  }

  for (const entry of selections) {
    if (entry.format.length === 0) continue;
    console.log(`Checking ${entry.format.length} changed ${entry.pkg.name} file(s).`);
    runCheck(entry.pkg, entry.format);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
