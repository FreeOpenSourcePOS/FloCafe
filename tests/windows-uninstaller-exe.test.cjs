'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const strings = read('scripts', 'uninstallers', 'windows-exe', 'Strings.cs');
const entries = [...strings.matchAll(/^\s+Add\("([a-z-]+)",((?:.|\n)*?)\);\n/gm)];
const entryLocales = entries.map((match) => match[1]);

const uiLocales = fs
  .readdirSync(path.join(root, 'frontend', 'src', 'lib', 'i18n', 'messages'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''));

assert.deepEqual(
  [...entryLocales].sort(),
  [...uiLocales].sort(),
  'uninstall-windows.exe must carry exactly the UI locales',
);

for (const [, locale, body] of entries) {
  const literals = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  assert.equal(
    literals.length,
    4,
    `${locale} must define title, warning, done and incomplete text`,
  );
  for (const literal of literals)
    assert.ok(literal.trim().length > 0, `${locale} has an empty string`);
  assert.ok(literals[1].includes('Flo Cafe'), `${locale} warning must name the product`);
  assert.ok(literals[1].includes('\\n\\n'), `${locale} warning must keep its paragraph breaks`);
}

for (const rtl of ['ar', 'fa', 'ur']) {
  assert.match(strings, new RegExp(`locale == "${rtl}"`), `${rtl} must be rendered right-to-left`);
}

const program = read('scripts', 'uninstallers', 'windows-exe', 'Program.cs');
assert.match(
  program,
  /-PurgeData/,
  'the launcher confirms deletion, so it must purge data non-interactively',
);
assert.match(
  program,
  /MessageBoxDefaultButton\.Button2/,
  'the destructive prompt must default to No',
);

const build = read('scripts', 'uninstallers', 'windows-exe', 'build.ps1');
assert.match(
  build,
  /\/resource:.*uninstall-windows\.ps1/,
  'the exe must embed the PowerShell uninstaller',
);

const release = read('.github', 'workflows', 'release.yml');
assert.match(
  release,
  /scripts\/uninstallers\/windows-exe\/build\.ps1/,
  'release-windows must build the exe',
);
assert.match(
  release,
  /uninstaller-out\\uninstall-windows\.exe/,
  'release-windows must upload the exe',
);

console.log('windows uninstaller exe tests passed');
