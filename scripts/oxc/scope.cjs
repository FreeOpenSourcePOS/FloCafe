'use strict';

// Single source of truth for the selected-file Oxc checks shared by the pre-commit hook
// and the changed-file CI gate. Scope and exclusions mirror each package's .oxfmtrc.json
// and .oxlintrc.json; drift here shows up as an unexpected Oxfmt exit 2, so a new
// formatter exclusion belongs in both places.

const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

const PACKAGES = [
  {
    name: 'root',
    dir: REPO_ROOT,
    configFile: '.oxfmtrc.json',
    roots: ['main/', 'shared/', 'scripts/', 'tests/'],
    files: ['dev-server.js', 'kill-ports.js', 'lint-staged.config.mjs', '.husky/install.mjs'],
    // Formatter-excluded (generated labels, committed fixtures).
    excludes: ['main/print/print-labels.generated.ts', 'tests/fixtures/'],
    // Lint policy stays on main/ and shared/; scripts/, tests/ and root scripts are formatted only.
    lintRoots: ['main/', 'shared/'],
  },
  {
    name: 'frontend',
    dir: path.join(REPO_ROOT, 'frontend'),
    configFile: 'frontend/.oxfmtrc.json',
    roots: ['frontend/src/', 'frontend/e2e/'],
    files: [
      'frontend/next.config.ts',
      'frontend/playwright.config.ts',
      'frontend/playwright.electron.config.ts',
      'frontend/postcss.config.mjs',
    ],
    excludes: ['frontend/src/lib/i18n/messages/'],
    // Ignored by frontend/.oxlintrc.json, so Oxlint owns it as a formatted declaration only.
    lintExcludes: ['frontend/src/types/receipt-printer-encoder.d.ts'],
  },
];

function packageByName(name) {
  const found = PACKAGES.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown Oxc scope package: ${name}`);
  return found;
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

// Normalizes a repository-root-relative or absolute path to a repository-relative one.
function repoRelative(file) {
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(REPO_ROOT, file);
  const relative = path.relative(REPO_ROOT, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return toPosix(relative);
}

// Tools run in their package directory, so they receive package-relative arguments.
function withinPackage(pkg, file) {
  if (pkg.dir === REPO_ROOT) return file;
  return toPosix(path.relative(pkg.dir, path.resolve(REPO_ROOT, file)));
}

function matchesList(relative, entries, { prefix }) {
  return entries.some((entry) =>
    prefix ? relative === entry || relative.startsWith(entry) : relative === entry,
  );
}

function isEligible(pkg, relative) {
  if (!SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) return false;
  if (matchesList(relative, pkg.excludes ?? [], { prefix: true })) return false;
  return (
    matchesList(relative, pkg.files ?? [], { prefix: false }) ||
    matchesList(relative, pkg.roots ?? [], { prefix: true })
  );
}

function isLintEligible(pkg, relative) {
  if (matchesList(relative, pkg.lintExcludes ?? [], { prefix: false })) return false;
  if (pkg.lintRoots === undefined) return true;
  return matchesList(relative, pkg.lintRoots, { prefix: true });
}

// Splits a file list into the repository-relative paths each package owns. Deleted files,
// unsupported extensions and excluded artifacts are dropped, and each path is returned once.
function selectFiles(pkg, files) {
  const format = [];
  const lint = [];
  const seen = new Set();
  for (const file of files) {
    const relative = repoRelative(file);
    if (!relative || seen.has(relative) || !isEligible(pkg, relative)) continue;
    seen.add(relative);
    format.push(relative);
    if (isLintEligible(pkg, relative)) lint.push(relative);
  }
  format.sort();
  lint.sort();
  return { format, lint };
}

// Resolves the package's own installed binary. The CLI entrypoints are Node shims, so
// spawning `node <shim>` works on Windows too without a shell or a `.cmd` launcher.
function oxfmtInvocation(pkg, files, { mode }) {
  const entry = path.join(pkg.dir, 'node_modules', 'oxfmt', 'bin', 'oxfmt');
  const args = mode === 'check' ? ['--check'] : ['--write'];
  const targets = files.map((file) => withinPackage(pkg, file));
  return { command: process.execPath, args: [entry, ...args, '--', ...targets], cwd: pkg.dir };
}

function oxlintInvocation(pkg, files) {
  const entry = path.join(pkg.dir, 'node_modules', 'oxlint', 'bin', 'oxlint');
  const targets = files.map((file) => withinPackage(pkg, file));
  return { command: process.execPath, args: [entry, '--', ...targets], cwd: pkg.dir };
}

module.exports = {
  REPO_ROOT,
  SOURCE_EXTENSIONS,
  PACKAGES,
  packageByName,
  selectFiles,
  oxfmtInvocation,
  oxlintInvocation,
};
