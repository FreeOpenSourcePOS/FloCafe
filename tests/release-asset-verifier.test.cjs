const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  assertManifestPlatformMapping,
  assertReleaseAssetInventory,
  expectedManifestNames,
  parseManifest,
  verifyReleaseAssets,
} = require('../scripts/verify-release-assets.cjs');

const VERSION = '3.3.0';
const MANIFESTS = expectedManifestNames('latest');

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest('base64');
}

function manifestFor(files) {
  const first = files[0];
  return [
    `version: ${VERSION}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
    ]),
    `path: ${first.url}`,
    `sha512: ${first.sha512}`,
    'releaseDate: 2026-08-23T00:00:00.000Z',
    '',
  ].join('\n');
}

function makeFixture() {
  const names = [
    ...MANIFESTS,
    'uninstall-macos.sh',
    'uninstall-windows.ps1',
    `flocafe-${VERSION}-win-x64.exe`,
    `flocafe-${VERSION}-win-x64.exe.blockmap`,
    `flocafe-${VERSION}-win-x64.appx`,
    `flocafe-${VERSION}-win-arm64.appx`,
    `flocafe-${VERSION}-mac-x64.dmg`,
    `flocafe-${VERSION}-mac-arm64.dmg`,
    `flocafe-${VERSION}-mac-x64.zip`,
    `flocafe-${VERSION}-mac-arm64.zip`,
    `flocafe-${VERSION}-mac-x64.zip.blockmap`,
    `flocafe-${VERSION}-mac-arm64.zip.blockmap`,
    `flocafe-${VERSION}-linux-x64.appimage`,
    `flocafe-${VERSION}-linux-arm64.appimage`,
    `flocafe-${VERSION}-linux-x64.deb`,
    `flocafe-${VERSION}-linux-arm64.deb`,
    `flocafe-${VERSION}-linux-x64.rpm`,
    `flocafe-${VERSION}-linux-arm64.rpm`,
    `flocafe-${VERSION}-linux-x64.snap`,
    `flocafe-${VERSION}-linux-arm64.snap`,
  ];
  const payloads = new Map(names.map((name) => [name, Buffer.from(`uploaded:${name}`)]));
  const filesByManifest = {
    'latest.yml': [`flocafe-${VERSION}-win-x64.exe`],
    'latest-mac.yml': [
      `flocafe-${VERSION}-mac-x64.zip`,
      `flocafe-${VERSION}-mac-arm64.zip`,
    ],
    'latest-linux.yml': [`flocafe-${VERSION}-linux-x64.appimage`],
    'latest-linux-arm64.yml': [`flocafe-${VERSION}-linux-arm64.appimage`],
  };
  for (const [manifestName, fileNames] of Object.entries(filesByManifest)) {
    payloads.set(manifestName, Buffer.from(manifestFor(fileNames.map((url) => ({
      url,
      sha512: sha512(payloads.get(url)),
    })))));
  }

  const assets = names.map((name) => ({
    name,
    size: payloads.get(name).length,
    url: `https://assets.test/${name}`,
  }));
  return {
    release: { draft: true, tag_name: VERSION, assets },
    payloads,
    filesByManifest,
  };
}

function requestFor(fixture, unavailable = new Set()) {
  return async (asset) => {
    const payload = fixture.payloads.get(asset.name);
    if (!payload || unavailable.has(asset.name)) return new Response('unavailable', { status: 404 });
    return new Response(payload, { status: 200 });
  };
}

const fixture = makeFixture();
const assets = fixture.release.assets;
assert.doesNotThrow(() => assertReleaseAssetInventory(assets, MANIFESTS, VERSION));
assert.throws(
  () => assertReleaseAssetInventory(assets.filter((asset) => !asset.name.endsWith('.appx')), MANIFESTS, VERSION),
  /missing:.*appx/,
);
assert.throws(
  () => assertReleaseAssetInventory([
    ...assets,
    { name: `flocafe-3.2.9-win-x64.exe`, size: 1 },
  ], MANIFESTS, VERSION),
  /unexpected assets:.*3\.2\.9/,
);

const parsedManifest = parseManifest(fixture.payloads.get('latest.yml').toString('utf8'), 'latest.yml');
assert.deepEqual(parsedManifest, {
  version: VERSION,
  files: [{
    url: `flocafe-${VERSION}-win-x64.exe`,
    sha512: sha512(fixture.payloads.get(`flocafe-${VERSION}-win-x64.exe`)),
  }],
});
assert.throws(
  () => parseManifest('files: not-a-list\nversion: 3.3.0\n', 'latest.yml'),
  /does not reference any update artifact/,
);
assert.throws(
  () => parseManifest('files:\n  - url: artifact.exe\n    sha512: not-a-sha512\nversion: 3.3.0\n', 'latest.yml'),
  /valid SHA-512/,
);

assert.doesNotThrow(() => assertManifestPlatformMapping('latest.yml', VERSION, [
  { url: `flocafe-${VERSION}-win-x64.exe` },
]));
assert.doesNotThrow(() => assertManifestPlatformMapping('latest-mac.yml', VERSION, [
  { url: `flocafe-${VERSION}-mac-x64.zip` },
  { url: `flocafe-${VERSION}-mac-arm64.zip` },
  { url: `flocafe-${VERSION}-mac-x64.dmg` },
  { url: `flocafe-${VERSION}-mac-arm64.dmg` },
]));
assert.doesNotThrow(() => assertManifestPlatformMapping('latest-linux.yml', VERSION, [
  { url: `flocafe-${VERSION}-linux-x64.appimage` },
  // electron-builder lists every Linux target from the same invocation (#468).
  { url: `flocafe-${VERSION}-linux-x64.deb` },
  { url: `flocafe-${VERSION}-linux-x64.rpm` },
]));
assert.doesNotThrow(() => assertManifestPlatformMapping('latest-linux-arm64.yml', VERSION, [
  { url: `flocafe-${VERSION}-linux-arm64.appimage` },
  { url: `flocafe-${VERSION}-linux-arm64.deb` },
]));
assert.throws(
  () => assertManifestPlatformMapping('latest.yml', VERSION, [
    { url: `flocafe-${VERSION}-mac-x64.zip` },
  ]),
  /another platform or architecture/,
);
assert.throws(
  () => assertManifestPlatformMapping('latest-linux-arm64.yml', VERSION, [
    { url: `flocafe-${VERSION}-linux-x64.appimage` },
  ]),
  /another platform or architecture/,
);
assert.throws(
  () => assertManifestPlatformMapping('latest-mac.yml', VERSION, [
    { url: `flocafe-${VERSION}-mac-x64.zip` },
  ]),
  /missing required platform artifacts/,
);

(async () => {
  const requestedAssets = [];
  await verifyReleaseAssets(fixture.release, {
    channel: 'latest',
    requestAsset: async (asset) => {
      requestedAssets.push(asset.name);
      return requestFor(fixture)(asset);
    },
  });
  assert.ok(requestedAssets.includes('uninstall-macos.sh'), 'non-manifest assets must be availability-checked');
  assert.ok(requestedAssets.includes(`flocafe-${VERSION}-win-x64.exe`), 'Windows representative must be downloaded and hashed');
  assert.ok(requestedAssets.includes(`flocafe-${VERSION}-mac-x64.zip`), 'macOS representative must be downloaded and hashed');
  assert.ok(requestedAssets.includes(`flocafe-${VERSION}-linux-x64.appimage`), 'Linux representative must be downloaded and hashed');

  const missingManifest = makeFixture();
  missingManifest.release.assets = missingManifest.release.assets.filter((asset) => asset.name !== 'latest-linux-arm64.yml');
  await assert.rejects(
    () => verifyReleaseAssets(missingManifest.release, { channel: 'latest', requestAsset: requestFor(missingManifest) }),
    /missing latest-linux-arm64\.yml/,
  );

  const badUrl = makeFixture();
  const badUrlName = `flocafe-${VERSION}-win-x64.exe`;
  badUrl.payloads.set('latest.yml', Buffer.from(manifestFor([{
    url: badUrlName,
    sha512: sha512(badUrl.payloads.get(badUrlName)),
  }])));
  await assert.rejects(
    () => verifyReleaseAssets(badUrl.release, {
      channel: 'latest',
      requestAsset: requestFor(badUrl, new Set([badUrlName])),
    }),
    /HTTP 200.*404/,
  );

  const badHash = makeFixture();
  badHash.payloads.set('latest.yml', Buffer.from(manifestFor([{
    url: badUrlName,
    sha512: sha512(Buffer.from('different uploaded content')),
  }])));
  await assert.rejects(
    () => verifyReleaseAssets(badHash.release, { channel: 'latest', requestAsset: requestFor(badHash) }),
    /SHA-512 mismatch.*win-x64\.exe/,
  );

  console.log('✅ Draft release verifier success, missing-manifest, bad-URL, and bad-hash simulations passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
