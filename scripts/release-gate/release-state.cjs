#!/usr/bin/env node

/** Pure release-state assertions shared by workflow steps and focused tests. */

const CHANNELS = new Set(['stable', 'beta']);
const SNAP_ARCHES = ['x64', 'arm64'];

function assertPublishedRelease(release, { tag, channel }) {
  if (!release || release.tag_name !== tag) throw new Error(`published release tag does not match expected ${tag}`);
  if (release.draft !== false) throw new Error(`release ${tag} must be published before the candidate gate can start`);
  if (!CHANNELS.has(channel)) throw new Error(`unsupported release channel ${channel}`);
  if (channel === 'beta' && release.prerelease !== true) throw new Error(`beta release ${tag} must remain prerelease`);
  if (channel === 'stable' && release.prerelease !== false) throw new Error(`stable release ${tag} must not be prerelease`);
  return true;
}

function assertStableLatestUnchanged(beforeTag, afterTag) {
  if ((beforeTag || '') !== (afterTag || '')) {
    throw new Error(`Stable Latest changed during candidate publication: before=${beforeTag || '(none)'} after=${afterTag || '(none)'}`);
  }
  return true;
}

function assertCandidateReadiness({ release, tag, channel, expectedAssetIds, availableAssetIds, stableLatestBefore, stableLatestAfter }) {
  assertPublishedRelease(release, { tag, channel });
  if (stableLatestBefore !== undefined || stableLatestAfter !== undefined) {
    assertStableLatestUnchanged(stableLatestBefore, stableLatestAfter);
  }
  if (expectedAssetIds) {
    const expected = new Set(expectedAssetIds);
    const actual = new Set((release.assets || [])
      .filter((asset) => asset.name !== 'candidate-manifest.json' && asset.name !== 'release-summary.json')
      .map((asset) => asset.id));
    if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
      throw new Error('published candidate asset IDs do not match the immutable candidate manifest');
    }
  }
  if (availableAssetIds) {
    const available = new Set(availableAssetIds);
    for (const id of expectedAssetIds || []) {
      if (!available.has(id)) throw new Error(`candidate asset ${id} is not ready at HTTP 200`);
    }
  }
  return true;
}

function assertSnapEvidence(evidence, { tag, channel, requireBoth = true } = {}) {
  if (!evidence || evidence.status !== 'published') throw new Error('Snap publication evidence must have status=published');
  if (evidence.tag !== tag) throw new Error(`Snap publication evidence tag does not match ${tag}`);
  if (evidence.channel !== channel) throw new Error(`Snap publication evidence channel does not match ${channel}`);
  if (!SNAP_ARCHES.includes(evidence.architecture)) throw new Error(`Snap publication evidence has unsupported architecture ${evidence.architecture}`);
  if (requireBoth && evidence.architecture === 'both') throw new Error('Snap publication evidence must be one record per architecture');
  return true;
}

function assertStableSnapEvidence(evidenceByArch, tag) {
  for (const arch of SNAP_ARCHES) {
    const evidence = evidenceByArch[arch];
    if (!evidence) throw new Error(`stable Snap publication evidence is missing for ${arch}; refusing promotion`);
    assertSnapEvidence(evidence, { tag, channel: 'stable' });
  }
  return true;
}

function assertOrdering(events, { channel = 'beta', requireMatrix = false } = {}) {
  const positions = new Map();
  for (const [index, event] of events.entries()) {
    if (!positions.has(event)) positions.set(event, index);
  }
  const before = (left, right) => {
    if (!positions.has(left) || !positions.has(right) || positions.get(left) >= positions.get(right)) {
      throw new Error(`release ordering violation: ${left} must happen before ${right}`);
    }
  };
  before('draft-verified', 'published');
  before('snap-published', 'published');
  if (channel === 'beta') {
    before('published', 'readiness-verified');
    before('readiness-verified', 'matrix-started');
  }
  if (channel === 'stable') before('published', 'promoted-latest');
  if (requireMatrix) before('readiness-verified', 'matrix-completed');
  return true;
}

module.exports = {
  SNAP_ARCHES,
  assertCandidateReadiness,
  assertOrdering,
  assertPublishedRelease,
  assertSnapEvidence,
  assertStableLatestUnchanged,
  assertStableSnapEvidence,
};
