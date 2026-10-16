#!/usr/bin/env node
/**
 * Release step between the builds and electron-builder: injects PostHog chunk ids into the
 * renderer export and the compiled main process, uploads their source maps, and deletes the
 * maps so they do not ship. Without POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID it does
 * nothing and exits 0. An upload failure warns and never fails the release.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLI = '@posthog/cli@latest';
const RELEASE_NAME = 'flocafe';
const DEFAULT_HOST = 'https://eu.posthog.com';
const ROOT = path.resolve(__dirname, '..');
const DIRECTORIES = ['frontend/out', 'dist'];
// What npx and the CLI need to run. Release jobs also hold signing certificates and store
// credentials, so nothing else is passed to a package fetched at build time.
const CLI_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_REGISTRY',
]);

function sourceMapsConfigured(env = process.env) {
  return Boolean(env.POSTHOG_CLI_API_KEY?.trim() && env.POSTHOG_CLI_PROJECT_ID?.trim());
}

function cliEnv(env = process.env) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && (CLI_ENV_KEYS.has(upper) || upper.startsWith('POSTHOG_CLI_'))) {
      next[key] = value;
    }
  }
  next.POSTHOG_CLI_HOST = env.POSTHOG_CLI_HOST || DEFAULT_HOST;
  return next;
}

function warn(message) {
  console.log(
    process.env.GITHUB_ACTIONS ? `::warning::${message}` : `[posthog-sourcemaps] ${message}`,
  );
}

function removeMaps(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.js.map')) {
      fs.rmSync(path.join(entry.parentPath ?? entry.path, entry.name), { force: true });
    }
  }
}

/** npx is a .cmd on Windows and runs through cmd, which does not quote; paths may contain spaces. */
function shellArgs(args, platform = process.platform) {
  if (platform !== 'win32') return args;
  return args.map((arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg));
}

function cli(args, env) {
  const result = spawnSync('npx', shellArgs(['--yes', CLI, ...args]), {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function main() {
  if (!sourceMapsConfigured()) {
    console.log(
      '[posthog-sourcemaps] POSTHOG_CLI_API_KEY or POSTHOG_CLI_PROJECT_ID is not set; skipping source map upload.',
    );
    return;
  }
  const env = cliEnv();
  const version = require(path.join(ROOT, 'package.json')).version;
  const release = ['--release-name', RELEASE_NAME, '--release-version', version];
  for (const relative of DIRECTORIES) {
    const directory = path.join(ROOT, relative);
    if (!fs.existsSync(directory)) {
      warn(`${relative} does not exist; build it before uploading source maps.`);
      continue;
    }
    const uploaded =
      cli(['sourcemap', 'inject', '--directory', directory, ...release], env) &&
      cli(['sourcemap', 'upload', '--directory', directory, ...release, '--delete-after'], env);
    if (!uploaded) warn(`PostHog source map upload failed for ${relative}; the release continues.`);
    removeMaps(directory);
  }
}

if (require.main === module) main();

module.exports = { cliEnv, shellArgs, sourceMapsConfigured };
