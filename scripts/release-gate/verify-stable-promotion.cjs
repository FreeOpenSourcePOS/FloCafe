#!/usr/bin/env node

const { assertReleaseSummary } = require('./evidence.cjs');
const { manifestSha256, resolveTagCommit, verifyCandidateManifest } = require('./candidate-manifest.cjs');
const { assertPublishedRelease, assertStableSnapEvidence } = require('./release-state.cjs');

function arg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`missing required argument ${name}`);
  return argv[index + 1];
}

function optionalArg(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] || null);
}

function headers(accept = 'application/vnd.github+json') {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  return { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' };
}

async function request(url, accept) {
  const response = await fetch(url, { headers: headers(accept) });
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function assetBytes(asset, description) {
  const bytes = Buffer.from(await (await request(asset.url, 'application/octet-stream')).arrayBuffer());
  if (bytes.length === 0) throw new Error(`${description} returned an empty body`);
  return bytes;
}

function parseJson(bytes, description) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${description} is malformed: ${error.message}`); }
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = arg(argv, '--repo');
  const tag = arg(argv, '--tag');
  const expectedManifestAssetId = optionalArg(argv, '--candidate-asset-id');
  const expectedManifestSha256 = optionalArg(argv, '--manifest-sha256');
  if (!expectedManifestAssetId || !expectedManifestSha256) {
    throw new Error('stable promotion requires the immutable candidate manifest asset ID and SHA-256');
  }
  if (!/^\d+$/.test(expectedManifestAssetId)) throw new Error('candidate manifest asset ID must be a positive integer');
  if (!/^[0-9a-f]{64}$/i.test(expectedManifestSha256)) throw new Error('candidate manifest SHA-256 must be a 64-character hexadecimal digest');
  const apiBase = `https://api.github.com/repos/${repo}`;
  const release = await (await request(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`)).json();
  assertPublishedRelease(release, { tag, channel: 'stable' });

  const candidateAsset = (release.assets || []).find((entry) => entry.name === 'candidate-manifest.json');
  const summaryAsset = (release.assets || []).find((entry) => entry.name === 'release-summary.json');
  if (!candidateAsset) throw new Error(`stable release ${tag} is missing the immutable candidate manifest; refusing promotion`);
  if (!summaryAsset) throw new Error(`stable release ${tag} is missing the permanent sanitized release summary; refusing promotion`);
  if (String(candidateAsset.id) !== String(expectedManifestAssetId)) {
    throw new Error(`candidate manifest asset ID ${candidateAsset.id} does not match expected ${expectedManifestAssetId}`);
  }

  const candidateBytes = await assetBytes(candidateAsset, 'candidate-manifest.json');
  const actualManifestSha256 = manifestSha256(candidateBytes);
  if (actualManifestSha256 !== expectedManifestSha256.toLowerCase()) {
    throw new Error(`candidate manifest SHA-256 mismatch: expected ${expectedManifestSha256}, got ${actualManifestSha256}`);
  }
  const manifest = parseJson(candidateBytes, 'candidate-manifest.json');
  const resolvedCommit = await resolveTagCommit(apiBase, tag);
  if (manifest.commit?.sha !== resolvedCommit) {
    throw new Error(`candidate manifest commit does not match stable tag ${tag}: expected ${resolvedCommit}`);
  }
  await verifyCandidateManifest(manifest, release, {
    requestAsset: (asset) => request(asset.url, 'application/octet-stream'),
    tag,
    commit: resolvedCommit,
    channel: 'stable',
  });

  const summary = parseJson(await assetBytes(summaryAsset, 'release-summary.json'), 'release-summary.json');
  assertReleaseSummary(summary, { manifest, candidateManifestBytes: candidateBytes });

  const evidenceByArch = {};
  for (const architecture of ['x64', 'arm64']) {
    const asset = (release.assets || []).find((entry) => entry.name === `snap-publication-${architecture}.json`);
    if (!asset) throw new Error(`stable release ${tag} is missing Snap publication evidence for ${architecture}; refusing Latest promotion`);
    evidenceByArch[architecture] = parseJson(await assetBytes(asset, `Snap publication evidence for ${architecture}`), `Snap publication evidence for ${architecture}`);
  }
  assertStableSnapEvidence(evidenceByArch, tag);
  console.log(`stable release ${tag} passed immutable manifest, asset, Snap publication, and permanent-evidence promotion checks`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
