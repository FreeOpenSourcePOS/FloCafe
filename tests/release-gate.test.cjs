const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  assertCandidateManifest,
  classifyAsset,
  createCandidateManifest,
  resolveTagCommit,
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
  assertReleaseSummary,
  assertRetentionPolicy,
  assertSanitized,
  createReleaseSummary,
} = require('../scripts/release-gate/evidence.cjs');
const { createSnapEvidence } = require('../scripts/release-gate/snap-evidence.cjs');
const { assertMatrixContract, buildDispatchInputs, createDispatchId } = require('../scripts/release-gate/matrix-contract.cjs');
const { assertCorrelatedRun } = require('../scripts/release-gate/matrix-dispatch.cjs');

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
  asset('flocafe-3.3.1-beta.1-win-x64.exe.blockmap', 108),
  asset('flocafe-3.3.1-beta.1-mac-x64.zip', 109),
  asset('flocafe-3.3.1-beta.1-mac-x64.zip.blockmap', 110),
  asset('flocafe-3.3.1-beta.1-linux-x64.appimage', 111),
  asset('flocafe-3.3.1-beta.1-linux-arm64.appimage', 112),
  asset('snap-publication-x64.json', 113),
  asset('snap-publication-arm64.json', 114),
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
  assert.equal(classifyAsset('flocafe-3.3.1-beta.1-win-x64.exe.blockmap').kind, 'blockmap');
  assert.equal(classifyAsset('flocafe-3.3.1-beta.1-mac-x64.zip.blockmap').kind, 'blockmap');
  assert.equal(windowsAsset.sha256, crypto.createHash('sha256').update(payloads.get(windowsAsset.name)).digest('hex'));
  assert.equal(windowsAsset.sha512.length, 128);

  const published = {
    draft: false,
    prerelease: true,
    tag_name: release.tag_name,
    assets: [
      ...releaseAssets,
      { name: 'candidate-manifest.json', id: 115, size: 1, url: 'https://assets.test/candidate-manifest.json' },
      { name: 'release-summary.json', id: 116, size: 1, url: 'https://assets.test/release-summary.json' },
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
  assertReleaseSummary(summary, { manifest, candidateManifestBytes: Buffer.from('manifest') });
  assert.throws(() => assertReleaseSummary({
    ...summary,
    release: { ...summary.release, candidateManifestSha256: '0'.repeat(64) },
  }, { manifest, candidateManifestBytes: Buffer.from('manifest') }), /candidate manifest digest/);
  assert.equal(summary.retention.sanitizedWorkflowArtifactsDays, RETENTION_DAYS);
  assert.equal(summary.automated.installedArtifactMatrix, 'NOT-RUN');
  assertRetentionPolicy(summary.retention);
  assert.throws(() => assertSanitized({ password: 'nope' }), /sensitive field/);
  assert.throws(() => assertSanitized({ note: 'Bearer abc123' }), /credential-like/);

  const currentMatrix = `name: Runtime upgrade matrix
run-name: Runtime upgrade matrix \${{ inputs.matrix_dispatch_id }}
on:
  workflow_dispatch:
    inputs:
      from_version: { required: true, type: string }
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo ready
`;
  assert.throws(() => assertMatrixContract(currentMatrix), /#512.*candidate_tag/);
  const integratedMatrix = `name: Runtime upgrade matrix
run-name: Runtime upgrade matrix \${{ inputs.matrix_dispatch_id }}
on:
  workflow_dispatch:
    inputs:
      from_version: { required: true, type: string }
      candidate_tag: { required: true, type: string }
      candidate_manifest_asset_id: { required: true, type: string }
      candidate_manifest_sha256: { required: true, type: string }
      matrix_dispatch_id: { required: true, type: string }
jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      TAG: \${{ inputs.candidate_tag }}
      ASSET_ID: \${{ inputs.candidate_manifest_asset_id }}
      MANIFEST_SHA: \${{ inputs.candidate_manifest_sha256 }}
      DISPATCH_ID: \${{ inputs.matrix_dispatch_id }}
    steps:
      - name: Validate exact candidate binding
        run: test -n "$TAG" -a -n "$ASSET_ID" -a -n "$MANIFEST_SHA" -a -n "$DISPATCH_ID"
`;
  assert.doesNotThrow(() => assertMatrixContract(integratedMatrix));
  assert.throws(() => assertMatrixContract(integratedMatrix.replace('TAG: ${{ inputs.candidate_tag }}', 'TAG: candidate')), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replace('test -n "$TAG" -a -n "$ASSET_ID" -a -n "$MANIFEST_SHA" -a -n "$DISPATCH_ID"', 'test -n ready')), /exact candidate inputs/);
  const dispatchId = createDispatchId();
  assert.doesNotThrow(() => assertCorrelatedRun({
    workflow_id: 12,
    event: 'workflow_dispatch',
    head_branch: 'main',
    display_title: `Runtime upgrade matrix ${dispatchId}`,
  }, { workflowId: 12, ref: 'main', dispatchId }));
  assert.throws(() => assertCorrelatedRun({
    workflow_id: 12,
    event: 'workflow_dispatch',
    head_branch: 'main',
    display_title: 'Runtime upgrade matrix another-run',
  }, { workflowId: 12, ref: 'main', dispatchId }), /correlation/);
  assert.deepEqual(buildDispatchInputs({
    fromVersion: '3.3.0',
    candidateTag: '3.3.1-beta.1',
    candidateManifestAssetId: 115,
    candidateManifestSha256: 'B'.repeat(64),
    dispatchId,
  }), {
    from_version: '3.3.0',
    to_version: '3.3.1-beta.1',
    candidate_tag: '3.3.1-beta.1',
    candidate_manifest_asset_id: '115',
    candidate_manifest_sha256: 'b'.repeat(64),
    matrix_dispatch_id: dispatchId,
  });

  const originalFetch = global.fetch;
  const originalGhToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  global.fetch = async (url) => {
    const body = url.endsWith('/git/ref/tags/3.3.1-beta.1')
      ? { object: { type: 'tag', sha: 'b'.repeat(40) } }
      : { object: { type: 'commit', sha: 'a'.repeat(40) } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal(await resolveTagCommit('https://api.github.test/repos/example/repo', '3.3.1-beta.1'), 'a'.repeat(40));
  } finally {
    global.fetch = originalFetch;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
  }

  console.log('✅ Release candidate manifest, channel, stable-Snap, retention, ordering, and #512-boundary contracts passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
