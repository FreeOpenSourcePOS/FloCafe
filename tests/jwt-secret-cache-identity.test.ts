/**
 * JWT secret cache identity and single-owner import audit.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/jwt-secret-cache-identity.test.ts
 *
 * The signing secret and its module-level cache live in exactly one module
 * (main/security/jwt-secret.ts). Two things could silently break that:
 *
 *   1. The cache being split across two modules. A database restore clears
 *      one copy while token issuance reads the other, so tokens minted before
 *      the restore keep validating after it. Nothing asserted this identity
 *      before; the first half of this file now does.
 *   2. The secret being re-imported through a second module. main/routes/auth.ts
 *      re-exports it for one release, so a file that mixes `../security/jwt-
 *      secret` and `../routes/auth` would silently fork the cache the moment
 *      the shim is removed. The second half is a static import audit.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-jwt-secret-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const {
  assertOrThrow, assertEqualOrThrow, getResults, resetCounters,
} = require('./helpers/test-setup');
const { getJWTSecret, clearJWTSecretCache } = require('../main/security/jwt-secret');
const authReExport = require('../main/routes/auth');

const SECRET_EXPORTS = ['getJWTSecret', 'clearJWTSecretCache'];
// Forward-slash literals, not path.join: every path this suite compares is
// normalised to posix form first, and mixing platforms must not decide whether
// an assertion runs at all.
const OWNER_MODULE = 'main/security/jwt-secret';
const LEGACY_SHIM_MODULE = 'main/routes/auth';
const PRODUCTION_PREFIX = 'main/';

/** Normalise a repo-relative path to forward slashes on every platform. */
function toPosix(p: string): string {
  return p.split(/[\\/]/).join('/');
}

const isProductionFile = (file: string): boolean => toPosix(file).startsWith(PRODUCTION_PREFIX);

/** Recursively collect .ts/.tsx source files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Every module specifier a file pulls `getJWTSecret`/`clearJWTSecretCache` from,
 * covering both the ESM (`import { ... } from '...'`) and the CommonJS
 * (`const { ... } = require('...')`) forms the test suites use, in either quote
 * style. A single-quote-only pattern would let a double-quoted importer bypass
 * this audit entirely, which is the exact false negative it exists to catch.
 */
function secretImportSpecifiersIn(source: string): string[] {
  const specifiers = new Set<string>();

  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (SECRET_EXPORTS.some((name) => new RegExp(`\\b${name}\\b`).test(match[1]))) specifiers.add(match[2]);
  }
  for (const match of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (SECRET_EXPORTS.some((name) => new RegExp(`\\b${name}\\b`).test(match[1]))) specifiers.add(match[2]);
  }
  return [...specifiers];
}

function secretImportSpecifiers(file: string): string[] {
  return secretImportSpecifiersIn(fs.readFileSync(file, 'utf8'));
}

function relativeToRepo(file: string): string {
  // path.relative() emits platform-native separators, so a win32 host would
  // hand back 'main\ipc.ts' and every startsWith('main/') below would silently
  // skip. Normalise here so the comparison below is platform-independent.
  return toPosix(path.relative(path.resolve(__dirname, '..'), file));
}

function main() {
  resetCounters();

  // ── 1. The re-export shim is the same function object, not a copy ──────────
  assertOrThrow(authReExport.getJWTSecret === getJWTSecret, 'auth.ts re-exports the very same getJWTSecret function');
  assertOrThrow(authReExport.clearJWTSecretCache === clearJWTSecretCache, 'auth.ts re-exports the very same clearJWTSecretCache function');

  // ── 2. Cache identity across clearJWTSecretCache ───────────────────────────
  // The env override short-circuits before the database, so it has to be out
  // of the way for this to observe the settings row and the cache.
  const previousEnvSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;

  try {
    initDatabase();
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('jwt_secret', 'secret-one', ?)")
      .run(now());

    clearJWTSecretCache();
    assertEqualOrThrow(getJWTSecret(), 'secret-one', 'first read populates the cache from settings.jwt_secret');
    assertEqualOrThrow(getJWTSecret(), 'secret-one', 'second read is served by the cache');

    // Rotate the stored secret the way a restore or a forced re-key would.
    db.prepare("UPDATE settings SET value = 'secret-two', updated_at = ? WHERE key = 'jwt_secret'").run(now());
    assertEqualOrThrow(getJWTSecret(), 'secret-one', 'a cached secret survives a database rotation until the cache is cleared');

    // The failure this pins: if clearJWTSecretCache() nulled a different
    // module's copy than getJWTSecret() reads, this read would still return
    // 'secret-one' and pre-rotation tokens would keep validating.
    clearJWTSecretCache();
    assertEqualOrThrow(getJWTSecret(), 'secret-two', 'clearJWTSecretCache() invalidates the same cache getJWTSecret() reads');

    closeDatabase();
  } finally {
    if (previousEnvSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousEnvSecret;
    fs.rmSync(activeTestDir, { recursive: true, force: true });
  }

  // ── 3. Cross-platform guard: the audit must not be decided by path separators ──
  // A win32 host runs path.relative() with backslashes, which is exactly how
  // this suite was caught making the production check a no-op there. These
  // cases are pure string operations, so they are exercisable on any host
  // rather than only on the platform that surfaced the bug.
  for (const separator of ['/', '\\']) {
    const winStyleFile = `main${separator}ipc.ts`;
    const winStyleOwner = `main${separator}security${separator}jwt-secret`;
    assertOrThrow(
      toPosix(winStyleFile) === 'main/ipc.ts',
      `toPosix normalises a ${separator === '\\' ? 'backslash' : 'posix'} path`,
    );
    assertOrThrow(
      isProductionFile(winStyleFile),
      `a ${separator === '\\' ? 'backslash' : 'posix'}-separated main/ path is classified as production`,
    );
    assertOrThrow(
      toPosix(winStyleOwner) === OWNER_MODULE,
      `a ${separator === '\\' ? 'backslash' : 'posix'}-separated owner path equals the owner constant`,
    );
  }
  assertOrThrow(!isProductionFile('tests/security-hardening.test.ts'), 'a tests/ path is not classified as production');
  assertOrThrow(!isProductionFile('shared/role-permissions.ts'), 'a shared/ path is not classified as production');

  // ── 4. Both quote styles are audited ────────────────────────────────────────
  // A single-quote-only pattern let a double-quoted importer slip through the
  // one guard that exists to catch a second source for the secret.
  const quoteCases: Array<[string, string]> = [
    ['import { getJWTSecret } from "../security/jwt-secret";', '../security/jwt-secret'],
    ['const { clearJWTSecretCache } = require("../routes/auth");', '../routes/auth'],
    ["import { getJWTSecret } from '../security/jwt-secret';", '../security/jwt-secret'],
    ["const { clearJWTSecretCache } = require('../routes/auth');", '../routes/auth'],
    ['import { getJWTSecret, parseCategoryIds } from "../routes/auth";', '../routes/auth'],
  ];
  for (const [source, expected] of quoteCases) {
    const found = secretImportSpecifiersIn(source);
    assertEqualOrThrow(
      found.length,
      1,
      `quote audit finds exactly one source in: ${source.slice(0, 46)}...`,
    );
    assertEqualOrThrow(found[0], expected, `quote audit resolves the right specifier in: ${source.slice(0, 46)}...`);
  }
  assertEqualOrThrow(
    secretImportSpecifiersIn('const { isValidEmail } from "./auth";').length,
    0,
    'quote audit ignores destructurings that do not pull the secret',
  );

  // ── 5. Static import audit: one owner, no split sources ────────────────────
  const repoRoot = path.resolve(__dirname, '..');
  const files = [
    ...collectSourceFiles(path.join(repoRoot, 'main')),
    ...collectSourceFiles(path.join(repoRoot, 'tests')),
    ...collectSourceFiles(path.join(repoRoot, 'shared')),
  ];

  const resolvedImporters: Array<{ file: string; resolved: string[] }> = [];
  for (const file of files) {
    // This file embeds the import patterns it searches for as quote fixtures, so
    // it necessarily "imports" the secret from several modules as text. Auditing
    // it would be a false positive, not a finding; it is the audit.
    if (path.resolve(file) === __filename) continue;
    const specifiers = secretImportSpecifiers(file);
    if (specifiers.length === 0) continue;
    const resolved = specifiers.map((specifier) => relativeToRepo(path.resolve(path.dirname(file), specifier)));
    resolvedImporters.push({ file: relativeToRepo(file), resolved });
  }

  assertOrThrow(resolvedImporters.length > 0, 'the audit found files importing the JWT secret');

  for (const { file, resolved } of resolvedImporters) {
    assertEqualOrThrow(resolved.length, 1, `${file} imports the JWT secret from a single module (found ${resolved.join(', ')})`);
    const [owner] = resolved;
    if (owner === OWNER_MODULE || owner === LEGACY_SHIM_MODULE) continue;
    assertOrThrow(false, `${file} imports the JWT secret from unknown module "${owner}"`);
  }

  // Production code must not reach the secret through the router shim; only
  // tests may, and only until the follow-on removes it.
  for (const { file, resolved } of resolvedImporters) {
    if (isProductionFile(file)) {
      assertEqualOrThrow(
        resolved[0],
        OWNER_MODULE,
        `${file} imports the JWT secret from ${OWNER_MODULE}, not from the router (found ${resolved[0]})`,
      );
    }
  }

  const productionImporters = resolvedImporters.filter(({ file }) => isProductionFile(file));
  assertOrThrow(productionImporters.length > 0, 'production modules import the secret from the security module');

  const legacyTestImporters = resolvedImporters.filter(({ file, resolved }) => !isProductionFile(file) && resolved[0] === LEGACY_SHIM_MODULE);
  console.log(`  · ${resolvedImporters.length} importers audited; ${productionImporters.length} production, ${legacyTestImporters.length} tests still on the auth.ts shim`);

  const results = getResults();
  console.log(`\nJWT secret cache identity: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main();
