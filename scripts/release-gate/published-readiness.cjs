#!/usr/bin/env node

const { assertCandidateReadiness, assertPublishedRelease, assertStableLatestUnchanged } = require('./release-state.cjs');
const { assertRetentionPolicy, assertSanitized } = require('./evidence.cjs');
const { manifestSha256, verifyCandidateManifest } = require('./candidate-manifest.cjs');

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function arg(argv, name, { allowEmpty = false } = {}) {
  const index = argv.indexOf(name);
  if (index === -1 || (!allowEmpty && !argv[index + 1])) throw new Error(`missing required argument ${name}`);
  return argv[index + 1] || '';
}

function authHeaders(accept = 'application/vnd.github+json') {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
  };
}

async function request(url, accept) {
  const response = await fetch(url, { headers: authHeaders(accept) });
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function json(url) { return (await request(url)).json(); }

async function bytes(url) {
  const response = await request(url, 'application/octet-stream');
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length === 0) throw new Error(`empty release asset response from ${url}`);
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = arg(argv, '--repo');
  const tag = arg(argv, '--tag');
  const commit = arg(argv, '--commit').toLowerCase();
  const channel = arg(argv, '--channel');
  const expectedLatest = arg(argv, '--expected-latest', { allowEmpty: true });
  if (!SEMVER.test(tag)) throw new Error(`invalid release tag ${tag}`);

  const apiBase = `https://api.github.com/repos/${repo}`;
  const release = await json(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`);
  assertPublishedRelease(release, { tag, channel });
  const candidateAsset = (release.assets || []).find((asset) => asset.name === 'candidate-manifest.json');
  const summaryAsset = (release.assets || []).find((asset) => asset.name === 'release-summary.json');
  if (!candidateAsset) throw new Error(`published release ${tag} is missing candidate-manifest.json`);
  if (!summaryAsset) throw new Error(`published release ${tag} is missing release-summary.json`);
  const candidateBytes = await bytes(candidateAsset.url);
  const summaryBytes = await bytes(summaryAsset.url);
  const manifest = JSON.parse(candidateBytes.toString('utf8'));
  const summary = JSON.parse(summaryBytes.toString('utf8'));
  assertSanitized(summary);
  assertRetentionPolicy(summary.retention);
  let latest = { tag_name: '' };
  try {
    latest = await json(`${apiBase}/releases/latest`);
  } catch (error) {
    if (expectedLatest !== '' || !String(error.message).includes('(404)')) throw error;
  }
  assertStableLatestUnchanged(expectedLatest, latest.tag_name || '');
  await verifyCandidateManifest(manifest, release, {
    requestAsset: (asset) => request(asset.url, 'application/octet-stream'),
    tag,
    commit,
    channel,
  });
  assertCandidateReadiness({
    release,
    tag,
    channel,
    expectedAssetIds: manifest.assets.map((asset) => asset.id),
    availableAssetIds: manifest.assets.map((asset) => asset.id),
    stableLatestBefore: expectedLatest,
    stableLatestAfter: latest.tag_name || '',
  });
  console.log(`published ${channel} release ${tag} is ready; candidate manifest SHA-256 ${manifestSha256(candidateBytes)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
