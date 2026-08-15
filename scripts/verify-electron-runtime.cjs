#!/usr/bin/env node
// Cross-platform postinstall sanity check for the Electron package.
// Only macOS has the quarantine/ad-hoc-signature checks; other platforms
// intentionally return success without requiring Bash, xattr, or codesign.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// macOS `xattr -p` exit semantics:
//   0                         -> attribute present (value on stdout)
//   1 + "No such xattr"       -> attribute absent (the documented clean state)
//   any other status / stderr -> unexpected failure (permission, tool missing,
//                                 I/O error, ...) and must NOT be treated as
//                                 clean (GHSA-wjr9-g33j-w22x).
function classifyQuarantine(status, stderr, stdout) {
  if (status === 0) {
    return { state: 'present', value: String(stdout || '') };
  }
  if (status === 1 && /no such xattr/i.test(String(stderr || ''))) {
    return { state: 'absent' };
  }
  return { state: 'error', message: String(stderr || '').trim() };
}

function readQuarantine(appPath) {
  let stdout = '';
  try {
    stdout = execFileSync('xattr', ['-p', 'com.apple.quarantine', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return classifyQuarantine(0, '', stdout);
  } catch (error) {
    return classifyQuarantine(error && error.status, error && error.stderr, '');
  }
}

function fail(message) {
  console.error(`::error::${message}`);
  console.error('Do NOT disable Gatekeeper system-wide to work around this.');
  console.error('Approved remediation: remove node_modules/electron and run npm install again.');
  process.exit(1);
}

function main() {
  if (process.platform !== 'darwin') process.exit(0);

  const electronDir = path.join(process.cwd(), 'node_modules', 'electron');
  if (!fs.existsSync(electronDir)) process.exit(0);

  const distDir = path.join(electronDir, 'dist');
  const app = fs.existsSync(distDir)
    ? fs.readdirSync(distDir, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    : null;

  if (!app) fail('node_modules/electron is installed but no dist/*.app bundle was found.');

  const appPath = path.join(distDir, app.name);
  const quarantine = readQuarantine(appPath);
  if (quarantine.state === 'present') {
    fail(`${appPath} is marked com.apple.quarantine (${quarantine.value.trim()}).`);
  }
  if (quarantine.state === 'error') {
    fail(`could not read the quarantine attribute of ${appPath}: ${quarantine.message || 'unexpected xattr failure'}`);
  }

  try {
    execFileSync('codesign', ['-dv', appPath], { stdio: 'ignore' });
  } catch {
    fail(`${appPath} has no expected ad-hoc code signature and may be corrupted.`);
  }

  console.log(`verify-electron-runtime: ${appPath} present, unquarantined, ad-hoc signed as expected.`);
}

if (require.main === module) {
  main();
}

module.exports = { classifyQuarantine, readQuarantine };
