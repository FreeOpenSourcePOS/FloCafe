#!/usr/bin/env node

const { assertPublishedRelease, assertStableSnapEvidence } = require('./release-state.cjs');

function arg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`missing required argument ${name}`);
  return argv[index + 1];
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

async function main() {
  const argv = process.argv.slice(2);
  const repo = arg(argv, '--repo');
  const tag = arg(argv, '--tag');
  const apiBase = `https://api.github.com/repos/${repo}`;
  const release = await (await request(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`)).json();
  assertPublishedRelease(release, { tag, channel: 'stable' });

  const evidenceByArch = {};
  for (const architecture of ['x64', 'arm64']) {
    const asset = (release.assets || []).find((entry) => entry.name === `snap-publication-${architecture}.json`);
    if (!asset) throw new Error(`stable release ${tag} is missing Snap publication evidence for ${architecture}; refusing Latest promotion`);
    let evidence;
    try { evidence = JSON.parse(Buffer.from(await (await request(asset.url, 'application/octet-stream')).arrayBuffer()).toString('utf8')); }
    catch (error) { throw new Error(`Snap publication evidence for ${architecture} is malformed: ${error.message}`); }
    evidenceByArch[architecture] = evidence;
  }
  assertStableSnapEvidence(evidenceByArch, tag);
  if (!(release.assets || []).some((asset) => asset.name === 'candidate-manifest.json')) {
    throw new Error(`stable release ${tag} is missing the immutable candidate manifest; refusing promotion`);
  }
  if (!(release.assets || []).some((asset) => asset.name === 'release-summary.json')) {
    throw new Error(`stable release ${tag} is missing the permanent sanitized release summary; refusing promotion`);
  }
  console.log(`stable release ${tag} passed Snap publication and permanent-evidence promotion checks`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
