#!/usr/bin/env node
// Prepends a <release> entry to assets/com.flo.desktop.metainfo.xml at release
// time so the AppImage ships with an up-to-date AppStream release history.
// Reads version from package.json and release notes from RELEASE_NOTES_FILE,
// /tmp/release-notes.md, or CHANGELOG.md (via scripts/changelog-notes.sh). The
// on-disk source file is rewritten; the running pipeline does NOT auto-commit
// this change back to the repo.

const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const META_FILE = path.join(ROOT, 'assets/com.flo.desktop.metainfo.xml');
const NOTES_HELPER = path.join(ROOT, 'scripts/changelog-notes.sh');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const date = new Date().toISOString().slice(0, 10);

let notes = '';
if (process.env.RELEASE_NOTES_FILE && require('node:fs').existsSync(process.env.RELEASE_NOTES_FILE)) {
  notes = readFileSync(process.env.RELEASE_NOTES_FILE, 'utf8');
} else if (require('node:fs').existsSync('/tmp/release-notes.md')) {
  notes = readFileSync('/tmp/release-notes.md', 'utf8');
} else {
  try {
    notes = execFileSync('npx', ['--yes', 'git-cliff@2.8.0', '--latest', '--strip', 'header'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (_e) {
    try {
      notes = execFileSync(NOTES_HELPER, [version.split('-')[0]], { encoding: 'utf8' });
    } catch (_e2) {
      notes = `Flo Cafe ${version}`;
    }
  }
}
notes = notes
  .trim()
  .replace(/[\r\n]+/g, ' ')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const xml = readFileSync(META_FILE, 'utf8');
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (new RegExp(`<release\\b[^>]*\\bversion="${escapedVersion}"`).test(xml)) {
  console.log(`release ${version} already present in ${path.basename(META_FILE)} — skipping`);
  process.exit(0);
}

if (!/<releases\b[^>]*>/.test(xml)) {
  throw new Error(`${path.basename(META_FILE)} is missing its <releases> element`);
}

const entry = `
    <release version="${version}" date="${date}">
      <description>
        <p>${notes}</p>
      </description>
    </release>`;

const updated = xml.replace(/(\s*<releases\b[^>]*>)/, `$1${entry}`);
if (updated === xml) {
  throw new Error(`could not insert release ${version}: <releases> element was not recognized`);
}
writeFileSync(META_FILE, updated);
console.log(`prepended <release version="${version}" date="${date}"> to ${path.basename(META_FILE)}`);
