const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertCandidateManifest,
  classifyAsset,
  createCandidateManifest,
  findReleaseByTag,
  manifestSha256,
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
const { ensureReleaseAssets } = require('../scripts/release-gate/ensure-release-assets.cjs');
const { verifyStablePromotion } = require('../scripts/release-gate/verify-stable-promotion.cjs');
const { validateReleaseRef } = require('../scripts/release-gate/validate-release-ref.cjs');
const { expectedArtifactNames, expectedManifestNames } = require('../scripts/verify-release-assets.cjs');

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

function releaseRefRequest({
  tag = '3.4.0',
  mainVersion = tag,
  behindBy = 0,
  tagType = 'tag',
  tagVerified = true,
  commitVerified = true,
} = {}) {
  const apiBase = 'https://api.github.com/repos/example/repo';
  const commit = 'a'.repeat(40);
  const tagObject = 'b'.repeat(40);
  const mainCommit = 'c'.repeat(40);
  const file = (version) => ({
    encoding: 'base64',
    content: Buffer.from(JSON.stringify({ version })).toString('base64'),
  });
  const fixtures = new Map([
    [`${apiBase}/git/ref/tags/${tag}`, { object: { type: tagType, sha: tagObject } }],
    [`${apiBase}/git/tags/${tagObject}`, {
      object: { type: 'commit', sha: commit },
      verification: { verified: tagVerified, reason: tagVerified ? 'valid' : 'unsigned' },
    }],
    [`${apiBase}/commits/${commit}`, {
      commit: { verification: { verified: commitVerified, reason: commitVerified ? 'valid' : 'unsigned' } },
    }],
    [`${apiBase}/contents/package.json?ref=${tag}`, file(tag)],
    [`${apiBase}/git/ref/heads/main`, { object: { type: 'commit', sha: mainCommit } }],
    [`${apiBase}/compare/${commit}...${mainCommit}`, { behind_by: behindBy }],
    [`${apiBase}/contents/package.json?ref=main`, file(mainVersion)],
  ]);
  return async (url) => {
    if (!fixtures.has(url)) throw new Error(`unexpected fixture request ${url}`);
    return fixtures.get(url);
  };
}

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
  const unverifiedSigned = JSON.parse(JSON.stringify(manifest));
  unverifiedSigned.assets.find((entry) => entry.name.endsWith('.exe')).signing = {
    status: 'signed',
    smartScreen: 'not-run',
    verification: 'not-run',
  };
  assert.throws(() => assertCandidateManifest(unverifiedSigned), /cannot claim signed status without release-build verification/);

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
    x64: { ...snapEvidence.x64, architecture: 'arm64' },
    arm64: snapEvidence.arm64,
  }, '3.3.0'), /architecture/);
  assert.throws(() => assertStableSnapEvidence({
    x64: snapEvidence.x64,
    arm64: { ...snapEvidence.arm64, status: 'failed' },
  }, '3.3.0'), /status=published/);
  assert.throws(() => assertStableSnapEvidence({
    x64: { ...snapEvidence.x64, snapName: 'other-snap' },
    arm64: snapEvidence.arm64,
  }, '3.3.0'), /snapName/);
  assert.throws(() => assertStableSnapEvidence({
    x64: { ...snapEvidence.x64, type: 'other-type' },
    arm64: snapEvidence.arm64,
  }, '3.3.0'), /type/);

  assertOrdering(['draft-verified', 'published', 'readiness-verified'], { channel: 'beta' });
  assertOrdering(['draft-verified', 'published', 'readiness-verified', 'matrix-started', 'matrix-completed'], { channel: 'beta', requireMatrix: true });
  assert.throws(() => assertOrdering(['draft-verified', 'published', 'readiness-verified', 'matrix-completed'], { channel: 'beta', requireMatrix: true }), /readiness-verified.*matrix-started/);
  assertOrdering(['draft-verified', 'snap-published', 'published', 'promoted-latest'], { channel: 'stable' });
  assert.throws(() => assertOrdering(['draft-verified', 'published', 'promoted-latest'], { channel: 'stable' }), /snap-published.*published/);

  const summary = createReleaseSummary({ manifest, candidateManifestBytes: Buffer.from('manifest') });
  assertReleaseSummary(summary, { manifest, candidateManifestBytes: Buffer.from('manifest') });
  assert.throws(() => assertReleaseSummary({
    ...summary,
    release: { ...summary.release, candidateManifestSha256: '0'.repeat(64) },
  }, { manifest, candidateManifestBytes: Buffer.from('manifest') }), /candidate manifest digest/);
  assert.equal(summary.retention.sanitizedWorkflowArtifactsDays, RETENTION_DAYS);
  assert.equal(summary.automated.snapStorePublication, 'PASS (x64 and arm64 publication evidence recorded)');
  assert.equal(summary.automated.installedArtifactMatrix, 'NOT-RUN');
  const betaWithoutSnapSummary = createReleaseSummary({
    manifest: {
      ...manifest,
      assets: manifest.assets.filter((entry) => !entry.name.startsWith('snap-publication-')),
    },
    candidateManifestBytes: Buffer.from('manifest'),
  });
  assert.equal(betaWithoutSnapSummary.automated.snapStorePublication, 'NOT-RUN (beta Snap Store publication is optional or permission-limited)');
  assertRetentionPolicy(summary.retention);
  const passedMatrixSummary = createReleaseSummary({
    manifest,
    candidateManifestBytes: Buffer.from('manifest'),
    matrix: { status: 'PASS' },
  });
  assert.equal(passedMatrixSummary.automated.installedArtifactMatrix, 'PASS');
  assert.throws(() => assertReleaseSummary({
    ...summary,
    residualRisk: { ...summary.residualRisk, windowsDirectDownloadSigning: 'SIGNED (artifact signature verification recorded)' },
  }, { manifest, candidateManifestBytes: Buffer.from('manifest') }), /residualRisk/);
  const incompleteSummary = JSON.parse(JSON.stringify(summary));
  delete incompleteSummary.manual.masReview;
  assert.throws(() => assertReleaseSummary(incompleteSummary, {
    manifest,
    candidateManifestBytes: Buffer.from('manifest'),
  }), /manual/);
  assert.throws(() => assertSanitized({ password: 'nope' }), /sensitive field/);
  assert.throws(() => assertSanitized({ note: 'Bearer abc123' }), /credential-like/);

  const stableVersion = '3.3.0';
  const stablePayloads = new Map(expectedArtifactNames(stableVersion).map((name) => [name, Buffer.from(`stable:${name}`)]));
  const stableManifestFiles = {
    'latest.yml': [`flocafe-${stableVersion}-win-x64.exe`],
    'latest-mac.yml': [`flocafe-${stableVersion}-mac-x64.zip`, `flocafe-${stableVersion}-mac-arm64.zip`],
    'latest-linux.yml': [`flocafe-${stableVersion}-linux-x64.appimage`],
    'latest-linux-arm64.yml': [`flocafe-${stableVersion}-linux-arm64.appimage`],
  };
  for (const [manifestName, fileNames] of Object.entries(stableManifestFiles)) {
    const manifestText = [
      `version: ${stableVersion}`,
      `path: ${fileNames[0]}`,
      `sha512: ${crypto.createHash('sha512').update(stablePayloads.get(fileNames[0])).digest('base64')}`,
      'files:',
      ...fileNames.flatMap((name) => [
        `  - url: ${name}`,
        `    sha512: ${crypto.createHash('sha512').update(stablePayloads.get(name)).digest('base64')}`,
      ]),
      '',
    ].join('\n');
    stablePayloads.set(manifestName, Buffer.from(manifestText));
  }
  stablePayloads.set('snap-publication-x64.json', Buffer.from(JSON.stringify(createSnapEvidence({ tag: stableVersion, channel: 'stable', architecture: 'x64' }))));
  stablePayloads.set('snap-publication-arm64.json', Buffer.from(JSON.stringify(createSnapEvidence({ tag: stableVersion, channel: 'stable', architecture: 'arm64' }))));
  const stableAssetNames = [
    ...expectedManifestNames('latest'),
    ...expectedArtifactNames(stableVersion),
    'snap-publication-x64.json',
    'snap-publication-arm64.json',
  ];
  const stableAssets = stableAssetNames.map((name, index) => ({
    name,
    id: 201 + index,
    size: stablePayloads.get(name).length,
    url: `https://assets.test/stable-${name}`,
  }));
  const stableDraft = { draft: true, tag_name: '3.3.0', assets: stableAssets };
  const stableManifest = await createCandidateManifest({
    release: stableDraft,
    commit: 'b'.repeat(40),
    channel: 'stable',
    requestAsset: async (entry) => stablePayloads.get(entry.name),
    signingStatuses: { windows: 'not-verified', mac: 'signed', linux: 'not-applicable' },
  });
  const stableCandidateBytes = Buffer.from(`${JSON.stringify(stableManifest, null, 2)}\n`);
  const stableSummary = createReleaseSummary({
    manifest: stableManifest,
    candidateManifestBytes: stableCandidateBytes,
  });
  const incompleteStableSummary = createReleaseSummary({
    manifest: {
      ...stableManifest,
      assets: stableManifest.assets.filter((entry) => entry.name !== 'snap-publication-arm64.json'),
    },
    candidateManifestBytes: stableCandidateBytes,
  });
  assert.equal(incompleteStableSummary.automated.snapStorePublication, 'FAIL (stable Snap Store publication evidence is incomplete; promotion is blocked)');
  stablePayloads.set('candidate-manifest.json', stableCandidateBytes);
  const stableSummaryBytes = Buffer.from(`${JSON.stringify(stableSummary, null, 2)}\n`);
  stablePayloads.set('release-summary.json', stableSummaryBytes);
  const stablePublished = {
    draft: false,
    prerelease: false,
    tag_name: '3.3.0',
    assets: [
      ...stableAssets,
      { name: 'candidate-manifest.json', id: 299, size: stableCandidateBytes.length, url: 'https://assets.test/stable-candidate-manifest.json' },
      { name: 'release-summary.json', id: 300, size: stableSummaryBytes.length, url: 'https://assets.test/stable-release-summary.json' },
    ],
  };
  const stablePromotionArgs = {
    release: stablePublished,
    tag: '3.3.0',
    expectedManifestAssetId: 299,
    expectedManifestSha256: manifestSha256(stableCandidateBytes),
    resolveCommit: async () => 'b'.repeat(40),
    fetchAssetBytes: async (entry) => stablePayloads.get(entry.name),
  };
  await assert.doesNotReject(() => verifyStablePromotion(stablePromotionArgs));
  await assert.rejects(
    () => verifyStablePromotion({
      ...stablePromotionArgs,
      release: {
        ...stablePublished,
        assets: stablePublished.assets.filter((entry) => entry.name !== 'snap-publication-arm64.json'),
      },
    }),
    /missing:.*snap-publication-arm64/,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flocafe-release-assets-'));
  try {
    const reusableFile = path.join(tempDir, 'reusable.bin');
    fs.writeFileSync(reusableFile, 'same bytes');
    const draftAsset = { name: 'reusable.bin', id: 401, url: 'https://assets.test/reusable.bin' };
    let uploads = 0;
    const draftResult = await ensureReleaseAssets({
      release: { draft: true, assets: [draftAsset] },
      files: [reusableFile],
      fetchExistingAsset: async () => Buffer.from('same bytes'),
      upload: async () => { uploads += 1; },
    });
    assert.deepEqual(draftResult, [{ name: 'reusable.bin', id: 401, action: 'reused' }]);
    assert.equal(uploads, 0);
    fs.writeFileSync(reusableFile, 'changed bytes');
    await assert.rejects(
      () => ensureReleaseAssets({
        release: { draft: true, assets: [draftAsset] },
        files: [reusableFile],
        fetchExistingAsset: async () => Buffer.from('same bytes'),
      }),
      /already exists with different bytes/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

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
      candidate_commit: { required: true, type: string }
      candidate_manifest_asset_id: { required: true, type: string }
      candidate_manifest_sha256: { required: true, type: string }
      matrix_dispatch_id: { required: true, type: string }
jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      COMMIT: \${{ inputs.candidate_commit }}
      FROM_VERSION: \${{ inputs.from_version }}
      TAG: \${{ inputs.candidate_tag }}
      ASSET_ID: \${{ inputs.candidate_manifest_asset_id }}
      MANIFEST_SHA: \${{ inputs.candidate_manifest_sha256 }}
      DISPATCH_ID: \${{ inputs.matrix_dispatch_id }}
    steps:
      - name: Validate exact candidate binding
        run: |
          echo "::notice::Candidate matrix dispatch $DISPATCH_ID"
          node scripts/release-gate/candidate-manifest.cjs \
            --verify --repo example/repo --tag "$TAG" --commit "$COMMIT" \
            --channel beta --candidate-asset-id "$ASSET_ID" \
            --manifest-sha256 "$MANIFEST_SHA"
          node scripts/upgrade-matrix/run-upgrade.cjs seed \
            --expected-version "$TAG" --from-version "$FROM_VERSION"
`;
  assert.doesNotThrow(() => assertMatrixContract(integratedMatrix));
  assert.throws(() => assertMatrixContract(integratedMatrix.replace('TAG: ${{ inputs.candidate_tag }}', 'TAG: candidate')), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replace('node scripts/upgrade-matrix/run-upgrade.cjs seed', 'echo ready')), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replace('node scripts/release-gate/candidate-manifest.cjs', 'echo candidate-manifest.cjs')), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replace(
    'node scripts/upgrade-matrix/run-upgrade.cjs seed',
    'echo "$FROM_VERSION $TAG $ASSET_ID $MANIFEST_SHA $DISPATCH_ID"',
  )), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replaceAll('"$TAG"', '"$TAG_SUFFIX"')), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replace(
    'node scripts/release-gate/candidate-manifest.cjs',
    'test -n "$TAG" && echo candidate-manifest.cjs',
  )), /exact candidate inputs/);
  assert.throws(() => assertMatrixContract(integratedMatrix.replace(
    'node scripts/release-gate/candidate-manifest.cjs',
    'uses: example/runtime-matrix@main',
  )), /exact candidate inputs/);
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
    candidateCommit: 'a'.repeat(40),
    candidateManifestAssetId: 115,
    candidateManifestSha256: 'B'.repeat(64),
    dispatchId,
  }), {
    from_version: '3.3.0',
    to_version: '3.3.1-beta.1',
    candidate_tag: '3.3.1-beta.1',
    candidate_commit: 'a'.repeat(40),
    candidate_manifest_asset_id: '115',
    candidate_manifest_sha256: 'b'.repeat(64),
    matrix_dispatch_id: dispatchId,
  });

  const releaseLookupUrls = [];
  const draftRelease = await findReleaseByTag(
    'https://api.github.test/repos/example/repo',
    '3.3.1-beta.1',
    async (url) => {
      releaseLookupUrls.push(url);
      return new Response(JSON.stringify([{ tag_name: '3.3.1-beta.1', draft: true, assets: [] }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(draftRelease.draft, true);
  assert.deepEqual(releaseLookupUrls, ['https://api.github.test/repos/example/repo/releases?per_page=100&page=1']);

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

  await assert.doesNotReject(() => validateReleaseRef({
    repo: 'example/repo',
    tag: '3.4.0',
    commit: 'a'.repeat(40),
    request: releaseRefRequest(),
  }));
  await assert.doesNotReject(() => validateReleaseRef({
    repo: 'example/repo',
    tag: '3.4.0',
    commit: 'a'.repeat(40),
    requireMain: false,
    request: releaseRefRequest({ behindBy: 1, mainVersion: '3.3.9' }),
  }), 'promotion validation must allow an older signed release outside current main');
  await assert.rejects(
    () => validateReleaseRef({
      repo: 'example/repo',
      tag: '3.4.0',
      commit: 'a'.repeat(40),
      request: releaseRefRequest({ behindBy: 1 }),
    }),
    /not in main history/,
    'release tags not reachable from main must be rejected',
  );
  await assert.rejects(
    () => validateReleaseRef({
      repo: 'example/repo',
      tag: '3.4.0',
      commit: 'a'.repeat(40),
      request: releaseRefRequest({ mainVersion: '3.3.9' }),
    }),
    /package\.json at main reports version 3\.3\.9/,
    'release tags with a different main package version must be rejected',
  );
  await assert.rejects(
    () => validateReleaseRef({
      repo: 'example/repo',
      tag: '3.4.0',
      commit: 'a'.repeat(40),
      request: releaseRefRequest({ commitVerified: false }),
    }),
    /release commit .* is not cryptographically verified/,
    'unsigned release commits must be rejected',
  );
  await assert.rejects(
    () => validateReleaseRef({
      repo: 'example/repo',
      tag: '3.4.0',
      commit: 'a'.repeat(40),
      request: releaseRefRequest({ tagVerified: false }),
    }),
    /release tag .* is not cryptographically verified/,
    'unsigned release tags must be rejected',
  );
  await assert.rejects(
    () => validateReleaseRef({
      repo: 'example/repo',
      tag: '3.4.0',
      commit: 'a'.repeat(40),
      request: releaseRefRequest({ tagType: 'commit' }),
    }),
    /annotated signed tag/,
    'lightweight release tags must be rejected',
  );

  console.log('✅ Release candidate manifest, channel, stable-Snap, retention, ordering, and #512-boundary contracts passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
