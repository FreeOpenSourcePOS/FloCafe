const assert = require('node:assert/strict');
const {
  assertReleaseAssetInventory,
  expectedManifestNames,
  parseManifest,
} = require('../scripts/verify-release-assets.cjs');

const names = [
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'uninstall-macos.sh',
  'uninstall-windows.ps1',
  'flocafe-3.3.0-win-x64.exe',
  'flocafe-3.3.0-win-x64.exe.blockmap',
  'flocafe-3.3.0-win-x64.appx',
  'flocafe-3.3.0-win-arm64.appx',
  'flocafe-3.3.0-mac-x64.dmg',
  'flocafe-3.3.0-mac-arm64.dmg',
  'flocafe-3.3.0-mac-x64.zip',
  'flocafe-3.3.0-mac-arm64.zip',
  'flocafe-3.3.0-mac-x64.zip.blockmap',
  'flocafe-3.3.0-mac-arm64.zip.blockmap',
  'flocafe-3.3.0-linux-x64.appimage',
  'flocafe-3.3.0-linux-arm64.appimage',
  'flocafe-3.3.0-linux-x64.deb',
  'flocafe-3.3.0-linux-arm64.deb',
  'flocafe-3.3.0-linux-x64.rpm',
  'flocafe-3.3.0-linux-arm64.rpm',
  'flocafe-3.3.0-linux-x64.snap',
  'flocafe-3.3.0-linux-arm64.snap',
];
const assets = names.map((name) => ({ name, size: 1 }));
const manifests = expectedManifestNames('latest');

assert.doesNotThrow(() => assertReleaseAssetInventory(assets, manifests, '3.3.0'));
assert.throws(
  () => assertReleaseAssetInventory(assets.filter((asset) => !asset.name.endsWith('.appx')), manifests, '3.3.0'),
  /missing:.*appx/,
);
assert.throws(
  () => assertReleaseAssetInventory([
    ...assets,
    { name: 'flocafe-3.2.9-win-x64.exe', size: 1 },
  ], manifests, '3.3.0'),
  /unexpected assets:.*3\.2\.9/,
);

const manifest = parseManifest(`
version: 3.3.0
files:
  - url: flocafe-3.3.0-win-x64.exe
    sha512: abc123
path: flocafe-3.3.0-win-x64.exe
sha512: abc123
`, 'latest.yml');
assert.deepEqual(manifest, {
  version: '3.3.0',
  files: [{ url: 'flocafe-3.3.0-win-x64.exe', sha512: 'abc123' }],
});
assert.throws(
  () => parseManifest('files:\n  - url: flocafe-3.3.0-win-x64.exe\n    sha512: abc123\n', 'latest.yml'),
  /does not declare a release version/,
);

console.log('✅ Draft release asset inventory checks passed');
