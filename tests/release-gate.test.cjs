const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  assertCandidateManifest,
  createCandidateManifest,
  verifyCandidateManifest,
} = require('../scripts/release-gate/candidate-manifest.cjs');
const {
  assertCandidateReadiness,
  assertOrdering,
  assertPublishedRelease,
  assertStableLatestUnchanged,
  assertStableSnapEvidence,
} = require('../scripts/release-gate/release-state.cjs');
const {
  RETENTION_DAYS,
  assertRetentionPolicy,
  assertSanitized,
  createReleaseSummary,
} = require('../scripts/release-gate/evidence.cjs');
const { createSnapEvidence } = require('../scripts/release-gate/snap-evidence.cjs');
const { assertMatrixContract, buildDispatchInputs } = require('../scripts/release-gate/matrix-contract.cjs');

const payloads = new Map();
function asset(name, id) {
  const bytes = Buffer.from(`fixture:${name}`);
  payloads.set(name, bytes);
  return { name, id, size: bytes.length, url: `https://assets.test/${name}` };
}

const releaseAssets = [
  asset('beta.yml', 101),
  asset('beta-mac.yml', 102),
  asset('beta-linux.yml', 103),
  asset('beta-linux-arm64.yml', 104),
  asset('uninstall-macos.sh', 105),
  asset('uninstall-windows.ps1', 106),
  asset('flocafe-3.3.1-beta.1-win-x64.exe', 107),
  asset('flocafe-3.3.1-beta.1-mac-x64.zip', 108),
  asset('flocafe-3.3.1-beta.1-linux-x64.appimage', 109),
  asset('flocafe-3.3.1-beta.1-linux-arm64.appimage', 110),
  asset('snap-publication-x64.json', 111),
  asset('snap-publication-arm64.json', 112),
];
const release = { draft: true, tag_name: '3.3.1-beta.1', assets: releaseAssets };
const requestAsset = async (entry) => payloads.get(entry.name);

(async () => {
  const manifest = await createCandidateManifest({
    release,
    commit: 'a'.repeat(40),
    channel: 'beta',
    requestAsset,
    signingStatuses: { windows: 'unsigned', mac: 'signed', linux: 'not-applicable' },
  });
  assertCandidateManifest(manifest);
  assert.equal(manifest.release.tag, release.tag_name);
  assert.equal(manifest.commit.sha, 'a'.repeat(40));
  assert.equal(manifest.assets.length, releaseAssets.length);
  const windowsAsset = manifest.assets.find((entry) => entry.platform === 'windows' && entry.kind === 'installer');
  assert.equal(windowsAsset.signing.status, 'unsigned');
  assert.equal(windowsAsset.signing.smartScreen, 'not-run');
  assert.equal(windowsAsset.sha256, crypto.createHash('sha256').update(payloads.get(windowsAsset.name)).digest('hex'));
  assert.equal(windowsAsset.sha512.length, 128);

  const published = {
    draft: false,
    prerelease: true,
    tag_name: release.tag_name,
    assets: [
      ...releaseAssets,
      { name: 'candidate-manifest.json', id: 113, size: 1, url: 'https://assets.test/candidate-manifest.json' },
      { name: 'release-summary.json', id: 114, size: 1, url: 'https://assets.test/release-summary.json' },
    ],
  };
  await assert.doesNotReject(() => verifyCandidateManifest(manifest, published, {
    requestAsset,
    tag: release.tag_name,
    commit: 'a'.repeat(40),
    channel: 'beta',
  }));
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.assets[0].sha256 = '0'.repeat(64);
  await assert.rejects(
    () => verifyCandidateManifest(changed, published, { requestAsset, tag: release.tag_name, commit: 'a'.repeat(40), channel: 'beta' }),
    /digest binding mismatch/,
  );
  const dishonest = JSON.parse(JSON.stringify(manifest));
  dishonest.assets.find((entry) => entry.platform === 'windows').signing.smartScreen = 'pass';
  assert.throws(() => assertCandidateManifest(dishonest), /cannot use signing metadata as SmartScreen evidence/);

  assertPublishedRelease(published, { tag: release.tag_name, channel: 'beta' });
  assertStableLatestUnchanged('3.3.0', '3.3.0');
  assert.throws(() => assertStableLatestUnchanged('3.3.0', '3.3.1'), /Latest changed/);
  assertCandidateReadiness({
    release: published,
    tag: release.tag_name,
    channel: 'beta',
    expectedAssetIds: manifest.assets.map((entry) => entry.id),
    availableAssetIds: manifest.assets.map((entry) => entry.id),
    stableLatestBefore: '3.3.0',
    stableLatestAfter: '3.3.0',
  });
  assert.throws(() => assertCandidateReadiness({
    release: published,
    tag: release.tag_name,
    channel: 'beta',
    expectedAssetIds: [...manifest.assets.map((entry) => entry.id), 999],
  }), /asset IDs/);

  const snapEvidence = {
    x64: createSnapEvidence({ tag: '3.3.0', channel: 'stable', architecture: 'x64' }),
    arm64: createSnapEvidence({ tag: '3.3.0', channel: 'stable', architecture: 'arm64' }),
  };
  assertStableSnapEvidence(snapEvidence, '3.3.0');
  assert.throws(() => assertStableSnapEvidence({ x64: snapEvidence.x64 }, '3.3.0'), /missing.*arm64/);
  assert.throws(() => assertStableSnapEvidence({
    x64: snapEvidence.x64,
    arm64: { ...snapEvidence.arm64, status: 'failed' },
  }, '3.3.0'), /status=published/);

  assertOrdering(['draft-verified', 'snap-published', 'published', 'readiness-verified', 'matrix-started'], { channel: 'beta' });
  assert.throws(() => assertOrdering(['draft-verified', 'published', 'snap-published'], { channel: 'beta' }), /snap-published.*published/);
  assertOrdering(['draft-verified', 'snap-published', 'published', 'promoted-latest'], { channel: 'stable' });
  assert.throws(() => assertOrdering(['draft-verified', 'published', 'promoted-latest'], { channel: 'stable' }), /snap-published.*published/);

  const summary = createReleaseSummary({ manifest, candidateManifestBytes: Buffer.from('manifest') });
  assert.equal(summary.retention.sanitizedWorkflowArtifactsDays, RETENTION_DAYS);
  assert.equal(summary.automated.installedArtifactMatrix, 'NOT-RUN');
  assertRetentionPolicy(summary.retention);
  assert.throws(() => assertSanitized({ password: 'nope' }), /sensitive field/);
  assert.throws(() => assertSanitized({ note: 'Bearer abc123' }), /credential-like/);

  const currentMatrix = 'on:\n  workflow_dispatch:\n    inputs:\n      from_version:\n        required: true\n';
  assert.throws(() => assertMatrixContract(currentMatrix), /#512.*candidate_tag/);
  const integratedMatrix = `${currentMatrix}      candidate_tag:\n        required: true\n      candidate_manifest_asset_id:\n        required: true\n      candidate_manifest_sha256:\n        required: true\n# candidate_manifest_sha256 candidate_manifest_asset_id\n`;
  assert.doesNotThrow(() => assertMatrixContract(integratedMatrix));
  assert.deepEqual(buildDispatchInputs({
    fromVersion: '3.3.0',
    candidateTag: '3.3.1-beta.1',
    candidateManifestAssetId: 113,
    candidateManifestSha256: 'B'.repeat(64),
  }), {
    from_version: '3.3.0',
    to_version: '3.3.1-beta.1',
    candidate_tag: '3.3.1-beta.1',
    candidate_manifest_asset_id: '113',
    candidate_manifest_sha256: 'b'.repeat(64),
  });

  console.log('✅ Release candidate manifest, channel, stable-Snap, retention, ordering, and #512-boundary contracts passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
