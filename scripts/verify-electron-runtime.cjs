#!/usr/bin/env node
// Cross-platform postinstall sanity check for the Electron package.
// Only macOS has the quarantine/ad-hoc-signature checks; other platforms
// intentionally return success without requiring Bash, xattr, or codesign.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') process.exit(0);

const electronDir = path.join(process.cwd(), 'node_modules', 'electron');
if (!fs.existsSync(electronDir)) process.exit(0);

const distDir = path.join(electronDir, 'dist');
const app = fs.existsSync(distDir)
  ? fs.readdirSync(distDir, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  : null;

function fail(message) {
  console.error(`::error::${message}`);
  console.error('Do NOT disable Gatekeeper system-wide to work around this.');
  console.error('Approved remediation: remove node_modules/electron and run npm install again.');
  process.exit(1);
}

if (!app) fail('node_modules/electron is installed but no dist/*.app bundle was found.');

const appPath = path.join(distDir, app.name);
let quarantine = '';
try {
  quarantine = execFileSync('xattr', ['-p', 'com.apple.quarantine', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch { /* no quarantine attribute */ }
if (quarantine) fail(`${appPath} is marked com.apple.quarantine (${quarantine.trim()}).`);

try {
  execFileSync('codesign', ['-dv', appPath], { stdio: 'ignore' });
} catch {
  fail(`${appPath} has no expected ad-hoc code signature and may be corrupted.`);
}

console.log(`verify-electron-runtime: ${appPath} present, unquarantined, ad-hoc signed as expected.`);
