/**
 * Contributor-facing Oxc checks: the optional pre-commit hook and the changed-file CI gate.
 *
 * These run against temporary standalone repositories, never the checkout under test: hook
 * installation writes repository Git configuration, which is shared between linked worktrees.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Electron must be mocked before the shared helper pulls in main/db.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => os.tmpdir(), getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as unknown as [string, ...unknown[]]);
};

const {
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
} = require('./helpers/test-setup');

const rootDir = path.resolve(__dirname, '..');

const TOOLING_FILES = [
  '.husky/install.mjs',
  '.husky/pre-commit',
  '.oxfmtrc.json',
  '.oxlintrc.json',
  'lint-staged.config.mjs',
  'scripts/ci/check-changed-format.cjs',
  'scripts/oxc/format-staged.cjs',
  'scripts/oxc/probe/root-scope.ts',
  'scripts/oxc/scope.cjs',
];

const TEMP_PREFIX = 'flo-oxc-checks-';
const tempDirs: string[] = [];

function tempDir(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${label}-`));
  tempDirs.push(dir);
  return dir;
}

// Isolated Git environment: a developer's global hooksPath or user identity must not leak in.
function gitEnv(dir: string) {
  const xdg = path.join(dir, '.xdg-config');
  fs.mkdirSync(xdg, { recursive: true });
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: xdg,
  };
}

function run(command: string, args: string[], dir: string, stdin?: string) {
  const result = spawnSync(command, args, {
    cwd: dir,
    env: gitEnv(dir),
    encoding: 'utf8',
    input: stdin,
  });
  if (result.error) throw new Error(`${command} could not run in ${dir}: ${result.error.message}`);
  return result;
}

function git(dir: string, args: string[]) {
  return run(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Oxc Tests', ...args],
    dir,
  );
}

function commit(dir: string, message: string) {
  return git(dir, ['commit', '-m', message]);
}

function write(dir: string, relative: string, content: string) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function read(dir: string, relative: string) {
  return fs.readFileSync(path.join(dir, relative), 'utf8');
}

function gitShow(dir: string, revision: string) {
  return git(dir, ['show', revision]).stdout;
}

// A standalone contributor checkout with the tooling under test and the real Oxc installs.
function createContributorRepo(label: string) {
  const dir = tempDir(label);
  for (const file of TOOLING_FILES) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(rootDir, file), target);
  }
  fs.symlinkSync(path.join(rootDir, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests', 'fixtures'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  fs.symlinkSync(
    path.join(rootDir, 'frontend', 'node_modules'),
    path.join(dir, 'frontend', 'node_modules'),
    'dir',
  );
  fs.copyFileSync(
    path.join(rootDir, 'frontend', '.oxfmtrc.json'),
    path.join(dir, 'frontend', '.oxfmtrc.json'),
  );
  fs.copyFileSync(
    path.join(rootDir, 'frontend', '.oxlintrc.json'),
    path.join(dir, 'frontend', '.oxlintrc.json'),
  );
  // The frontend fixture config differs from the root one, so a formatted result proves which
  // package config was applied. Its owned probe follows that fixture formatting.
  write(
    dir,
    'frontend/.oxfmtrc.json',
    '{ "$schema": "../node_modules/oxfmt/configuration_schema.json", "singleQuote": false }\n',
  );
  write(
    dir,
    'frontend/e2e/helpers/format-scope-probe.ts',
    '// Owned fixture for the changed-file formatting gate.\nexport const FRONTEND_SCOPE_PROBE = "frontend scope probe";\n',
  );
  write(
    dir,
    'package.json',
    '{"name":"oxc-temp-repo","private":true,"scripts":{"prepare":"node .husky/install.mjs"}}\n',
  );
  write(dir, 'README.md', '# temporary repository\n');
  run('git', ['init', '-q', '.'], dir);
  git(dir, ['add', '-A']);
  commit(dir, 'seed');
  return dir;
}

function installHooks(dir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['.husky/install.mjs'], {
    cwd: dir,
    env: { ...gitEnv(dir), ...env },
    encoding: 'utf8',
  });
}

function hooksPath(dir: string) {
  const result = git(dir, ['config', '--get', 'core.hooksPath']);
  return result.status === 0 ? result.stdout.trim() : '';
}

// ── Scope policy ─────────────────────────────────────────────────────────────

console.log('Testing the selected-file Oxc scope policy...');

const scope = require('../scripts/oxc/scope.cjs');

const rootPackage = scope.packageByName('root');
const frontendPackage = scope.packageByName('frontend');

const rootSelection = scope.selectFiles(rootPackage, [
  'main/service.ts',
  'shared/print/kernel.ts',
  'scripts/ci/check-changed-format.cjs',
  'tests/oxc-contributor-checks.test.ts',
  'tests/fixtures/golden.ts',
  'main/print/print-labels.generated.ts',
  'README.md',
  'docs/architecture/frontend.md',
  'package.json',
  path.join(rootDir, 'main', 'absolute-path.ts'),
]);

assertEqualOrThrow(
  rootSelection.format.join(','),
  'main/absolute-path.ts,main/service.ts,scripts/ci/check-changed-format.cjs,shared/print/kernel.ts,tests/oxc-contributor-checks.test.ts',
  'root formatting must cover main/, shared/, scripts/ and tests/, and drop excluded or unsupported files',
);
assertEqualOrThrow(
  rootSelection.lint.join(','),
  'main/absolute-path.ts,main/service.ts,shared/print/kernel.ts',
  'root linting must stay on main/ and shared/ without expanding to scripts/ or tests/',
);

const frontendSelection = scope.selectFiles(frontendPackage, [
  'frontend/src/app/page.tsx',
  'frontend/e2e/helpers/urls.ts',
  'frontend/next.config.ts',
  'frontend/src/lib/i18n/messages/en.json',
  'frontend/src/types/receipt-printer-encoder.d.ts',
  'main/service.ts',
  'frontend/README.md',
]);

assertEqualOrThrow(
  frontendSelection.format.join(','),
  'frontend/e2e/helpers/urls.ts,frontend/next.config.ts,frontend/src/app/page.tsx,frontend/src/types/receipt-printer-encoder.d.ts',
  'frontend formatting must cover the renderer, e2e and maintained config files',
);
assertEqualOrThrow(
  frontendSelection.lint.join(','),
  'frontend/e2e/helpers/urls.ts,frontend/next.config.ts,frontend/src/app/page.tsx',
  'the ambient declaration Oxlint ignores must be formatted but not linted',
);

const policyProbes = scope.selectFiles(rootPackage, [
  'scripts/oxc/probe/root-scope.ts',
  'frontend/e2e/helpers/format-scope-probe.ts',
]);
assertEqualOrThrow(
  policyProbes.format.join(','),
  'scripts/oxc/probe/root-scope.ts',
  'the root scope must select its owned probe fixture',
);
const frontendPolicyProbes = scope.selectFiles(frontendPackage, [
  'scripts/oxc/probe/root-scope.ts',
  'frontend/e2e/helpers/format-scope-probe.ts',
]);
assertEqualOrThrow(
  frontendPolicyProbes.format.join(','),
  'frontend/e2e/helpers/format-scope-probe.ts',
  'the frontend scope must select its owned probe fixture',
);

for (const probe of [
  'scripts/oxc/probe/root-scope.ts',
  'frontend/e2e/helpers/format-scope-probe.ts',
]) {
  const absolute = path.join(rootDir, probe);
  const packageDir = probe.startsWith('frontend/') ? frontendPackage.dir : rootPackage.dir;
  const check = spawnSync(
    process.execPath,
    [
      path.join(packageDir, 'node_modules', 'oxfmt', 'bin', 'oxfmt'),
      '--check',
      '--',
      path.relative(packageDir, absolute),
    ],
    { cwd: packageDir, encoding: 'utf8' },
  );
  assertEqualOrThrow(
    check.status,
    0,
    `owned probe fixture ${probe} must stay formatted: ${check.stdout}${check.stderr}`,
  );
}

// ── Contributor pre-commit hook ──────────────────────────────────────────────

console.log('Testing the pre-commit hook in a temporary contributor repository...');

const hookRepo = createContributorRepo('hook');
const installResult = installHooks(hookRepo);
assertEqualOrThrow(
  installResult.status,
  0,
  `hook installation must succeed: ${installResult.stderr}`,
);
assertEqualOrThrow(
  hooksPath(hookRepo),
  '.husky/_',
  'contributor install must point Git at .husky/_',
);
assertOrThrow(
  fs.existsSync(path.join(hookRepo, '.husky', '_', 'pre-commit')),
  'contributor install must create the husky pre-commit shim',
);

write(hookRepo, 'main/thing.ts', 'export const  value={a:1}\n');
git(hookRepo, ['add', 'main/thing.ts']);
const formattedCommit = commit(hookRepo, 'add thing');
assertEqualOrThrow(
  formattedCommit.status,
  0,
  `a valid staged change must commit through the hook: ${formattedCommit.stdout}${formattedCommit.stderr}`,
);
assertIncludesOrThrow(
  gitShow(hookRepo, 'HEAD:main/thing.ts'),
  'export const value = { a: 1 };',
  'the hook must format the staged file and stage the formatted result',
);

write(hookRepo, 'main/lint-error.ts', 'export namespace Bad { export const value = 1; }\n');
git(hookRepo, ['add', 'main/lint-error.ts']);
const beforeLintError = git(hookRepo, ['rev-parse', 'HEAD']).stdout.trim();
const lintErrorCommit = commit(hookRepo, 'lint error');
assertOrThrow(lintErrorCommit.status !== 0, 'a staged lint error must block the commit');
assertEqualOrThrow(
  git(hookRepo, ['rev-parse', 'HEAD']).stdout.trim(),
  beforeLintError,
  'a blocked commit must not create a commit',
);
assertIncludesOrThrow(
  `${lintErrorCommit.stdout}${lintErrorCommit.stderr}`,
  'no-namespace',
  'the blocked commit must report the lint error that blocked it',
);
git(hookRepo, ['reset', '-q', '--hard', 'HEAD']);

write(hookRepo, 'main/partial.ts', 'export const first = 1;\n');
git(hookRepo, ['add', 'main/partial.ts']);
write(hookRepo, 'main/partial.ts', 'export const first = 1;\nexport const  unstagedEdit={b:2}\n');
const partialBefore = read(hookRepo, 'main/partial.ts');
const partialCommit = commit(hookRepo, 'partial staging');
assertEqualOrThrow(partialCommit.status, 0, `partial staging must commit: ${partialCommit.stderr}`);
assertEqualOrThrow(
  read(hookRepo, 'main/partial.ts'),
  partialBefore,
  'unstaged edits must survive the hook byte-for-byte',
);
assertIncludesOrThrow(
  gitShow(hookRepo, 'HEAD:main/partial.ts'),
  'export const first = 1;',
  'the commit must contain the staged content',
);
assertOrThrow(
  git(hookRepo, ['status', '--short']).stdout.includes('M main/partial.ts'),
  'the unstaged edit must stay unstaged after the hook',
);
git(hookRepo, ['reset', '-q', '--hard', 'HEAD']);

write(hookRepo, 'tests/fixtures/golden.ts', 'export const  fixture={c:3}\n');
git(hookRepo, ['add', 'tests/fixtures/golden.ts']);
const fixtureCommit = commit(hookRepo, 'excluded fixture');
assertEqualOrThrow(
  fixtureCommit.status,
  0,
  `an excluded fixture must commit: ${fixtureCommit.stderr}`,
);
assertEqualOrThrow(
  gitShow(hookRepo, 'HEAD:tests/fixtures/golden.ts'),
  'export const  fixture={c:3}\n',
  'excluded generated and fixture paths must stay byte-identical',
);

const oddNames = [
  'main/odd/with space.ts',
  'main/odd/unicode-日本語-é.ts',
  'main/odd/brackets[1].ts',
  'main/odd/quote\'s-"double.ts',
  'main/odd/--check.ts',
  'main/odd/semi;touch pwned|&&.ts',
];
for (const name of oddNames) write(hookRepo, name, 'export const  odd={x:1}\n');
git(hookRepo, ['add', 'main/odd']);
const oddCommit = commit(hookRepo, 'odd file names');
assertEqualOrThrow(oddCommit.status, 0, `odd file names must commit: ${oddCommit.stderr}`);
for (const name of oddNames) {
  assertIncludesOrThrow(
    gitShow(hookRepo, `HEAD:${name}`),
    'export const odd = { x: 1 };',
    `${name} must be formatted by argument passing, not shell interpolation`,
  );
}
assertOrThrow(
  !fs.existsSync(path.join(hookRepo, 'pwned')),
  'metacharacters in file names must never reach a shell',
);

git(hookRepo, ['mv', 'main/odd/with space.ts', 'main/odd/renamed file.ts']);
git(hookRepo, ['rm', '-q', 'main/odd/--check.ts']);
const renameCommit = commit(hookRepo, 'rename and delete');
assertEqualOrThrow(renameCommit.status, 0, `rename and delete must commit: ${renameCommit.stderr}`);

write(hookRepo, 'frontend/src/app/page.ts', 'export const  page={label:"frontend"}\n');
write(hookRepo, 'main/quotes.ts', 'export const  quotes={label:"root"}\n');
git(hookRepo, ['add', 'frontend/src/app/page.ts', 'main/quotes.ts']);
const perPackageCommit = commit(hookRepo, 'per package config');
assertEqualOrThrow(
  perPackageCommit.status,
  0,
  `per-package formatting must commit: ${perPackageCommit.stderr}`,
);
assertIncludesOrThrow(
  gitShow(hookRepo, 'HEAD:frontend/src/app/page.ts'),
  'export const page = { label: "frontend" };',
  'frontend files must be formatted with the frontend config',
);
assertIncludesOrThrow(
  gitShow(hookRepo, 'HEAD:main/quotes.ts'),
  "export const quotes = { label: 'root' };",
  'root files must be formatted with the root config',
);

// react-js is a jsPlugin in frontend/.oxlintrc.json, so only a run in the frontend package with
// that config can report it: the hook must not fall back to native Oxlint rules alone.
write(
  hookRepo,
  'frontend/src/app/bridge.tsx',
  "import React from 'react';\nexport function Widget() {\n  React.render(React.createElement('div'), document.body);\n  return null;\n}\n",
);
git(hookRepo, ['add', 'frontend/src/app/bridge.tsx']);
const bridgeCommit = commit(hookRepo, 'frontend bridge rule');
assertOrThrow(bridgeCommit.status !== 0, 'a frontend bridge lint error must block the commit');
assertIncludesOrThrow(
  `${bridgeCommit.stdout}${bridgeCommit.stderr}`,
  'no-deprecated',
  'the hook must lint frontend files with the frontend jsPlugin bridges, not native rules only',
);
git(hookRepo, ['reset', '-q', '--hard', 'HEAD']);

write(hookRepo, '.oxfmtrc.json', '{ not json\n');
write(hookRepo, 'main/broken-config.ts', 'export const  broken={f:6}\n');
git(hookRepo, ['add', '.oxfmtrc.json', 'main/broken-config.ts']);
const brokenConfigCommit = commit(hookRepo, 'invalid formatter config');
assertOrThrow(
  brokenConfigCommit.status !== 0,
  'an unusable formatter configuration must fail the hook instead of silently passing',
);
assertIncludesOrThrow(
  `${brokenConfigCommit.stdout}${brokenConfigCommit.stderr}`,
  'oxfmt',
  'the failing hook must report which tool failed',
);
git(hookRepo, ['reset', '-q', '--hard', 'HEAD']);

// Both root tooling files are named in the root formatter scope, so the hook must format them
// even though they sit outside main/, shared/, scripts/ and tests/.
write(
  hookRepo,
  'lint-staged.config.mjs',
  "const  root='node scripts/oxc/format-staged.cjs --package root';export default {'*':root};\n",
);
write(hookRepo, '.husky/install.mjs', 'export const  install={i:2}\n');
git(hookRepo, ['add', 'lint-staged.config.mjs', '.husky/install.mjs']);
const toolingFilesCommit = commit(hookRepo, 'tooling files');
assertEqualOrThrow(
  toolingFilesCommit.status,
  0,
  `tooling files must commit: ${toolingFilesCommit.stdout}${toolingFilesCommit.stderr}`,
);
assertIncludesOrThrow(
  gitShow(hookRepo, 'HEAD:lint-staged.config.mjs'),
  "const root = 'node scripts/oxc/format-staged.cjs --package root';",
  'the root lint-staged configuration must be formatted by the hook that loads it',
);
assertIncludesOrThrow(
  gitShow(hookRepo, 'HEAD:.husky/install.mjs'),
  'export const install = { i: 2 };',
  'the hook installation gate must be formatted by the hook',
);

write(hookRepo, 'README.md', '# temporary repository\n\nnotes\n');
git(hookRepo, ['add', 'README.md']);
const noWorkCommit = commit(hookRepo, 'documentation only');
assertEqualOrThrow(
  noWorkCommit.status,
  0,
  `a change with no eligible files must commit: ${noWorkCommit.stderr}`,
);

// ── Hook installation environments ───────────────────────────────────────────

console.log('Testing which environments install Git hooks...');

function createInstallScene(label: string, { gitInit = true } = {}) {
  const dir = tempDir(`install-${label}`);
  fs.mkdirSync(path.join(dir, '.husky'), { recursive: true });
  fs.copyFileSync(
    path.join(rootDir, '.husky', 'install.mjs'),
    path.join(dir, '.husky', 'install.mjs'),
  );
  if (gitInit) run('git', ['init', '-q', '.'], dir);
  fs.symlinkSync(path.join(rootDir, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

const skippedEnvironments: Array<{ label: string; env: NodeJS.ProcessEnv; expected: string }> = [
  { label: 'ci', env: { CI: 'true' }, expected: 'non-contributor environment' },
  { label: 'production', env: { NODE_ENV: 'production' }, expected: 'non-contributor environment' },
  { label: 'husky-disabled', env: { HUSKY: '0' }, expected: 'HUSKY=0' },
];

for (const { label, env, expected } of skippedEnvironments) {
  const dir = createInstallScene(label);
  const result = installHooks(dir, env);
  assertEqualOrThrow(
    result.status,
    0,
    `${label} installs must succeed without hooks: ${result.stderr}`,
  );
  assertIncludesOrThrow(
    result.stdout,
    expected,
    `${label} installs must report why hooks were skipped`,
  );
  assertEqualOrThrow(hooksPath(dir), '', `${label} installs must not change Git configuration`);
  assertOrThrow(
    !fs.existsSync(path.join(dir, '.husky', '_')),
    `${label} installs must not create hook shims`,
  );
}

const noWorkTreeDir = createInstallScene('no-work-tree', { gitInit: false });
const noWorkTreeResult = installHooks(noWorkTreeDir);
assertEqualOrThrow(
  noWorkTreeResult.status,
  0,
  `a source archive without a work tree must install: ${noWorkTreeResult.stderr}`,
);
assertIncludesOrThrow(
  noWorkTreeResult.stdout,
  'no Git work tree',
  'a source archive without a work tree must skip hook installation',
);

const foreignHooksDir = createInstallScene('foreign-hooks');
git(foreignHooksDir, ['config', 'core.hooksPath', '.my-hooks']);
const foreignHooksResult = installHooks(foreignHooksDir);
assertEqualOrThrow(
  foreignHooksResult.status,
  0,
  `a foreign hooks path must not fail installs: ${foreignHooksResult.stderr}`,
);
assertIncludesOrThrow(
  foreignHooksResult.stdout,
  'core.hooksPath is already set to .my-hooks',
  'an existing hooks path must be reported instead of replaced',
);
assertEqualOrThrow(
  hooksPath(foreignHooksDir),
  '.my-hooks',
  "another tool's hooks path must survive hook installation",
);

const frontendScripts = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'frontend', 'package.json'), 'utf8'),
).scripts;
assertOrThrow(
  !frontendScripts.prepare && !frontendScripts.postinstall,
  'frontend-only installs must not run hook installation',
);
const rootScripts = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
assertEqualOrThrow(
  rootScripts.scripts.prepare,
  'node .husky/install.mjs',
  'contributor installs must go through the hook installation gate',
);
assertIncludesOrThrow(
  rootScripts.scripts.postinstall,
  'electron-builder install-app-deps',
  'the Electron postinstall must stay intact',
);

// ── Changed-file formatting gate ─────────────────────────────────────────────

console.log('Testing the changed-file formatting gate...');

function runGate(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, ['scripts/ci/check-changed-format.cjs', ...args], {
    cwd: dir,
    env: gitEnv(dir),
    encoding: 'utf8',
  });
}

function gateOutput(result: { stdout: string; stderr: string }) {
  return `${result.stdout}${result.stderr}`;
}

function commitAll(dir: string, message: string) {
  git(dir, ['add', '-A']);
  return commit(dir, message);
}

const gateRepo = createContributorRepo('gate');
const gateBase = git(gateRepo, ['rev-parse', 'HEAD']).stdout.trim();

write(gateRepo, 'main/changed.ts', 'export const  changed={c:3}\n');
commitAll(gateRepo, 'unformatted change');
const changedBytes = read(gateRepo, 'main/changed.ts');
const unformattedGate = runGate(gateRepo, ['--base', gateBase]);
assertEqualOrThrow(
  unformattedGate.status,
  1,
  `an unformatted changed file must fail the gate: ${gateOutput(unformattedGate)}`,
);
assertIncludesOrThrow(
  gateOutput(unformattedGate),
  'main/changed.ts',
  'the gate must name the file that needs formatting',
);
assertEqualOrThrow(
  read(gateRepo, 'main/changed.ts'),
  changedBytes,
  'the gate must run Oxfmt in check mode only',
);

run(
  process.execPath,
  ['scripts/oxc/format-staged.cjs', '--package', 'root', 'main/changed.ts'],
  gateRepo,
);
commitAll(gateRepo, 'formatted change');
const formattedGate = runGate(gateRepo, ['--base', gateBase]);
assertEqualOrThrow(
  formattedGate.status,
  0,
  `a formatted changed file must pass the gate: ${gateOutput(formattedGate)}`,
);

write(gateRepo, 'main/middle-commit.ts', 'export const  middle={m:8}\n');
commitAll(gateRepo, 'middle commit');
write(gateRepo, 'main/last-commit.ts', 'export const last = { l: 9 };\n');
commitAll(gateRepo, 'last commit');
const rangeGate = runGate(gateRepo, ['--base', gateBase]);
assertEqualOrThrow(
  rangeGate.status,
  1,
  `a multi-commit range must fail on its unformatted file: ${gateOutput(rangeGate)}`,
);
assertIncludesOrThrow(
  gateOutput(rangeGate),
  'main/middle-commit.ts',
  'the gate must compare the whole change range, not only the last commit',
);
assertIncludesOrThrow(
  gateOutput(rangeGate),
  'Format issues found in above 1 files',
  'only the unformatted file in the range may be reported',
);

const deleteRepo = createContributorRepo('gate-delete');
const deleteBase = git(deleteRepo, ['rev-parse', 'HEAD']).stdout.trim();
write(deleteRepo, 'main/removed.ts', 'export const  removed={r:1}\n');
commitAll(deleteRepo, 'add unformatted file');
git(deleteRepo, ['rm', '-q', 'main/removed.ts']);
commit(deleteRepo, 'remove file');
const deleteGate = runGate(deleteRepo, ['--base', deleteBase]);
assertEqualOrThrow(
  deleteGate.status,
  0,
  `deleted files must be skipped by the gate: ${gateOutput(deleteGate)}`,
);

const renameRepo = createContributorRepo('gate-rename');
const renameBase = git(renameRepo, ['rev-parse', 'HEAD']).stdout.trim();
write(renameRepo, 'main/keep.ts', 'export const keep = { k: 1 };\n');
write(renameRepo, 'main/old-name.ts', 'export const  renamed={n:2}\n');
commitAll(renameRepo, 'add files');
git(renameRepo, ['mv', 'main/keep.ts', 'main/keep-renamed.ts']);
git(renameRepo, ['mv', 'main/old-name.ts', 'main/new-name.ts']);
commit(renameRepo, 'rename files');
const renameGate = runGate(renameRepo, ['--base', renameBase]);
assertEqualOrThrow(
  renameGate.status,
  1,
  `a renamed unformatted file must fail the gate: ${gateOutput(renameGate)}`,
);
assertIncludesOrThrow(
  gateOutput(renameGate),
  'main/new-name.ts',
  'a renamed file must be checked at its new path',
);
assertIncludesOrThrow(
  gateOutput(renameGate),
  'Format issues found in above 1 files',
  'a renamed formatted file must stay unreported',
);

const oddGateRepo = createContributorRepo('gate-odd');
const oddGateBase = git(oddGateRepo, ['rev-parse', 'HEAD']).stdout.trim();
const oddGateNames = [
  'main/odd/with space.ts',
  'main/odd/unicode-日本語-é.ts',
  'main/odd/brackets[1].ts',
  'main/odd/quote\'s-"-double.ts',
  'main/odd/--check.ts',
  'main/odd/newline-\nname.ts',
];
for (const name of oddGateNames) write(oddGateRepo, name, 'export const  odd={x:1}\n');
commitAll(oddGateRepo, 'odd file names');
const oddGate = runGate(oddGateRepo, ['--base', oddGateBase]);
assertEqualOrThrow(
  oddGate.status,
  1,
  `odd file names must fail the gate while unformatted: ${gateOutput(oddGate)}`,
);
assertIncludesOrThrow(
  gateOutput(oddGate),
  'newline-',
  'NUL-delimited Git output must survive newlines in file names',
);
assertIncludesOrThrow(
  gateOutput(oddGate),
  'quote\'s-"-double.ts',
  'quoted file names must reach the formatter unquoted and unescaped',
);
run(
  process.execPath,
  ['scripts/oxc/format-staged.cjs', '--package', 'root', ...oddGateNames],
  oddGateRepo,
);
commitAll(oddGateRepo, 'format odd file names');
const oddGateFixed = runGate(oddGateRepo, ['--base', oddGateBase]);
assertEqualOrThrow(
  oddGateFixed.status,
  0,
  `formatted odd file names must pass: ${gateOutput(oddGateFixed)}`,
);

const frontendGateRepo = createContributorRepo('gate-frontend');
const frontendGateBase = git(frontendGateRepo, ['rev-parse', 'HEAD']).stdout.trim();
write(frontendGateRepo, 'frontend/src/app/page.ts', 'export const  page={label:"frontend"}\n');
commitAll(frontendGateRepo, 'unformatted frontend change');
const frontendGate = runGate(frontendGateRepo, ['--base', frontendGateBase]);
assertEqualOrThrow(
  frontendGate.status,
  1,
  `an unformatted frontend file must fail: ${gateOutput(frontendGate)}`,
);
assertIncludesOrThrow(
  gateOutput(frontendGate),
  'frontend file',
  'the gate must split the frontend scope',
);
run(
  process.execPath,
  ['scripts/oxc/format-staged.cjs', '--package', 'frontend', 'frontend/src/app/page.ts'],
  frontendGateRepo,
);
assertIncludesOrThrow(
  read(frontendGateRepo, 'frontend/src/app/page.ts'),
  'export const page = { label: "frontend" };',
  'the gate must check frontend files with the frontend config',
);
commitAll(frontendGateRepo, 'formatted frontend change');
const frontendGateFixed = runGate(frontendGateRepo, ['--base', frontendGateBase]);
assertEqualOrThrow(
  frontendGateFixed.status,
  0,
  `formatted frontend change must pass: ${gateOutput(frontendGateFixed)}`,
);

const policyRepo = createContributorRepo('gate-policy');
const policyBase = git(policyRepo, ['rev-parse', 'HEAD']).stdout.trim();
write(policyRepo, 'package.json', '{"name":"oxc-temp-repo","version":"1.0.1"}\n');
commitAll(policyRepo, 'formatter policy change');
const policyGate = runGate(policyRepo, ['--base', policyBase]);
assertEqualOrThrow(
  policyGate.status,
  0,
  `a formatter policy change must check the owned fixtures: ${gateOutput(policyGate)}`,
);
assertIncludesOrThrow(
  policyGate.stdout,
  'owned',
  'a policy-only change must exercise an owned fixture instead of reporting no work',
);

const brokenPolicyRepo = createContributorRepo('gate-policy-broken');
const brokenPolicyBase = git(brokenPolicyRepo, ['rev-parse', 'HEAD']).stdout.trim();
fs.rmSync(path.join(brokenPolicyRepo, 'scripts/oxc/probe/root-scope.ts'));
write(brokenPolicyRepo, 'package.json', '{"name":"oxc-temp-repo","version":"1.0.2"}\n');
commitAll(brokenPolicyRepo, 'policy change without its fixture');
const brokenPolicyGate = runGate(brokenPolicyRepo, ['--base', brokenPolicyBase]);
assertEqualOrThrow(
  brokenPolicyGate.status,
  1,
  `a policy change with a missing fixture must fail: ${gateOutput(brokenPolicyGate)}`,
);
assertIncludesOrThrow(
  gateOutput(brokenPolicyGate),
  'scripts/oxc/probe/root-scope.ts are missing',
  'a policy-only change without its owned fixture must be reported, never treated as no work',
);

const noBaseRepo = createContributorRepo('gate-no-base');
const noBaseGate = runGate(noBaseRepo);
assertEqualOrThrow(noBaseGate.status, 1, 'a run without a comparison base must fail');
assertIncludesOrThrow(
  gateOutput(noBaseGate),
  '--base',
  'a run without a comparison base must explain how to provide one',
);
const unknownBaseGate = runGate(noBaseRepo, ['--base', '0000000000000000000000000000000000000000']);
assertEqualOrThrow(
  unknownBaseGate.status,
  1,
  'an unavailable comparison base must fail, never report zero files',
);
assertIncludesOrThrow(
  gateOutput(unknownBaseGate),
  'Cannot compare against',
  'an unavailable comparison base must fail with a clear message',
);

const malformedRepo = createContributorRepo('gate-malformed');
const malformedBase = git(malformedRepo, ['rev-parse', 'HEAD']).stdout.trim();
write(malformedRepo, '.oxfmtrc.json', '{ not json\n');
write(malformedRepo, 'main/malformed.ts', 'export const  malformed={z:1}\n');
commitAll(malformedRepo, 'malformed formatter config');
const malformedGate = runGate(malformedRepo, ['--base', malformedBase]);
assertEqualOrThrow(
  malformedGate.status,
  1,
  `a formatter failure must fail the gate: ${gateOutput(malformedGate)}`,
);
assertIncludesOrThrow(
  gateOutput(malformedGate),
  'main/malformed.ts',
  'a formatter failure must still name the selected file',
);

const emptyRepo = createContributorRepo('gate-empty');
const emptyBase = git(emptyRepo, ['rev-parse', 'HEAD']).stdout.trim();
const emptyGate = runGate(emptyRepo, ['--base', emptyBase]);
assertEqualOrThrow(emptyGate.status, 0, `an empty change set must pass: ${gateOutput(emptyGate)}`);
assertIncludesOrThrow(
  emptyGate.stdout,
  'nothing to check',
  'an empty change set must be reported explicitly',
);

// ── Workflow wiring and cross-platform invocation ───────────────────────────

console.log('Testing the CI workflow wiring and Windows-safe invocation...');

const YAML = require('js-yaml') as { load: (text: string) => any };
const workflow = YAML.load(
  fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8'),
);
const lintJobSteps = workflow.jobs['linux-baseline'].steps as Array<Record<string, string>>;

const stepIndex = (pattern: string) =>
  lintJobSteps.findIndex((step) => (step.run ?? '').includes(pattern));
const frontendInstallIndex = () =>
  lintJobSteps.findIndex(
    (step) => step['working-directory'] === 'frontend' && step.run === 'npm ci',
  );

const gateIndex = stepIndex('scripts/ci/check-changed-format.cjs');
assertOrThrow(gateIndex >= 0, 'CI must run the changed-file formatting gate');
assertOrThrow(
  stepIndex('npm ci') >= 0 && stepIndex('npm ci') < gateIndex,
  'the gate must run after the root dependency install',
);
assertOrThrow(
  frontendInstallIndex() >= 0 && frontendInstallIndex() < gateIndex,
  'the gate must run after the frontend dependency install it formats against',
);
for (const required of ['npm run lint:backend', 'npm run lint', 'npm run lint:budget']) {
  assertOrThrow(stepIndex(required) >= 0, `the ${required} gate must stay in the lint job`);
}

const filterStep = workflow.jobs.changes.steps.find(
  (step: { id?: string }) => step.id === 'filter',
);
const backendFilter = JSON.parse(
  String(filterStep.with.filters)
    .split('\n')
    .find((line: string) => line.trim().startsWith('backend:'))
    ?.trim()
    .replace(/^backend:\s*/, '')
    .replace(/'/g, '"') ?? '[]',
) as string[];
for (const pattern of [
  '.oxfmtrc.json',
  'frontend/.oxfmtrc.json',
  'scripts/oxc/**',
  'scripts/ci/check-changed-format.cjs',
  '.husky/**',
]) {
  assertOrThrow(
    backendFilter.includes(pattern),
    `a change to ${pattern} must not skip the job that runs the formatting gate`,
  );
}

assertEqualOrThrow(
  rootScripts.scripts['format:check:changed'],
  lintJobSteps[gateIndex].run,
  'the contributor command and the CI step must run the same gate',
);

for (const pkg of [rootPackage, frontendPackage]) {
  const invocation = scope.oxfmtInvocation(pkg, ['main/-leading-dash.ts'], { mode: 'check' });
  assertEqualOrThrow(
    invocation.command,
    process.execPath,
    'the formatter must be spawned as a Node shim, never through a shell or a Windows .cmd launcher',
  );
  assertEqualOrThrow(
    invocation.args[0],
    path.join(pkg.dir, 'node_modules', 'oxfmt', 'bin', 'oxfmt'),
    `the ${pkg.name} package must use its own installed formatter`,
  );
  assertEqualOrThrow(
    invocation.args[invocation.args.length - 2],
    '--',
    'a file name starting with a dash must be terminated by -- to stay a path',
  );
  assertEqualOrThrow(
    invocation.cwd,
    pkg.dir,
    `the ${pkg.name} package must run its tools from its own directory`,
  );
}

for (const dir of tempDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Oxc contributor checks (hook and changed-file gate) verified.');
