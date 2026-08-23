const assert = require('node:assert/strict');
const {
  assertReleaseAssetInventory,
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
const manifests = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];

assert.doesNotThrow(() => assertReleaseAssetInventory(assets, manifests));
assert.throws(
  () => assertReleaseAssetInventory(assets.filter((asset) => !asset.name.endsWith('.appx')), manifests),
  /\.appx/,
);

const manifest = parseManifest(`
version: 3.3.0
files:
  - url: flocafe-3.3.0-win-x64.exe
    sha512: abc123
path: flocafe-3.3.0-win-x64.exe
sha512: abc123
`, 'latest.yml');
assert.deepEqual(manifest, [{ url: 'flocafe-3.3.0-win-x64.exe', sha512: 'abc123' }]);

console.log('✅ Draft release asset inventory checks passed');
