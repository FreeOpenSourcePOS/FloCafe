#!/usr/bin/env node

/**
 * Verify the assets of a draft GitHub release through the GitHub API.
 *
 * This intentionally verifies the release, not the local electron-builder
 * output: manifests and every artifact they reference are fetched back from
 * the draft release, then each artifact is checked against its manifest's
 * SHA-512 value. The release can only be published after this script passes.
 */

const crypto = require('node:crypto');
const YAML = require('js-yaml');
const {
  assertSnapEvidence,
} = require('./release-gate/release-state.cjs');
const {
  assertRetentionPolicy,
  assertSanitized,
} = require('./release-gate/evidence.cjs');

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) {
    throw new Error(`missing required argument ${name}`);
  }
  return args[index + 1];
}

function parseArgs(argv) {
  const args = [...argv];
  const result = {
    repo: requiredArg(args, '--repo'),
    tag: requiredArg(args, '--tag'),
    channel: requiredArg(args, '--channel'),
    requireCandidateManifest: args.includes('--require-candidate-manifest'),
    requireReleaseSummary: args.includes('--require-release-summary'),
    requireSnapEvidence: args.includes('--require-snap-evidence'),
  };
  const repositoryParts = result.repo.split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !/^[a-zA-Z0-9.-]+$/.test(part))) {
    throw new Error(`invalid repository ${result.repo}`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(result.tag)) {
    throw new Error(`invalid release tag ${result.tag}`);
  }
  if (!['latest', 'beta'].includes(result.channel)) {
    throw new Error(`unsupported release channel ${result.channel} (nightlies are rejected by #503)`);
  }
  return result;
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

async function githubRequest(url, accept) {
  const response = await fetch(url, { headers: authHeaders(accept) });
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function githubJson(url) {
  return (await githubRequest(url)).json();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSha512(value) {
  return value.replace(/\s+/g, '');
}

function isSha512(value) {
  const normalized = normalizeSha512(value);
  return normalized.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
    && Buffer.from(normalized, 'base64').length === 64;
}

function parseManifest(text, name) {
  let document;
  try {
    document = YAML.load(text, { json: false });
  } catch (error) {
    throw new Error(`${name} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(document)) throw new Error(`${name} must contain a YAML mapping`);
  if (typeof document.version !== 'string' || document.version.trim() === '') {
    throw new Error(`${name} does not declare a release version`);
  }
  if (!Array.isArray(document.files) || document.files.length === 0) {
    throw new Error(`${name} does not reference any update artifact`);
  }

  const files = document.files.map((file, index) => {
    if (!isRecord(file)) throw new Error(`${name} has an invalid files[${index}] entry`);
    if (typeof file.url !== 'string' || file.url.trim() === '') {
      throw new Error(`${name} has an update artifact without a url`);
    }
    if (typeof file.sha512 !== 'string' || !isSha512(file.sha512)) {
      throw new Error(`${name} has an update artifact without a valid SHA-512`);
    }
    return { url: file.url.trim(), sha512: normalizeSha512(file.sha512) };
  });

  const duplicateUrls = files
    .map((file) => file.url)
    .filter((url, index, urls) => urls.indexOf(url) !== index);
  if (duplicateUrls.length > 0) {
    throw new Error(`${name} references the same update artifact more than once: ${duplicateUrls.join(', ')}`);
  }

  let topLevelPath = null;

  // electron-builder repeats the preferred update artifact as top-level
  // path/sha512. Keep that contract checked too: a disagreement here would
  // make the updater use a different checksum than the files entry we verify.
  if (document.path !== undefined || document.sha512 !== undefined) {
    if (typeof document.path !== 'string' || document.path.trim() === '') {
      throw new Error(`${name} has a top-level sha512 without a valid path`);
    }
    if (typeof document.sha512 !== 'string' || !isSha512(document.sha512)) {
      throw new Error(`${name} has a top-level path without a valid SHA-512`);
    }
    topLevelPath = document.path.trim();
    const topLevelSha512 = normalizeSha512(document.sha512);
    const matchingFile = files.find((file) => file.url === topLevelPath);
    if (matchingFile) {
      if (matchingFile.sha512 !== topLevelSha512) {
        throw new Error(`${name} has different SHA-512 values for ${topLevelPath}`);
      }
    } else {
      files.push({ url: topLevelPath, sha512: topLevelSha512 });
    }
  }

  return { version: document.version.trim(), path: topLevelPath, files };
}

function expectedManifestNames(channel) {
  return [
    `${channel}.yml`,
    `${channel}-mac.yml`,
    `${channel}-linux.yml`,
    `${channel}-linux-arm64.yml`,
  ];
}

function assertManifestPlatformMapping(manifestName, version, files, selectedPath) {
  const base = `flocafe-${version}`;
  const urls = files.map((file) => file.url);
  let allowed;
  let required;

  if (/^(latest|beta)\.yml$/.test(manifestName)) {
    allowed = new Set([`${base}-win-x64.exe`]);
    required = [`${base}-win-x64.exe`];
  } else if (/^(latest|beta)-mac\.yml$/.test(manifestName)) {
    allowed = new Set([
      `${base}-mac-x64.dmg`,
      `${base}-mac-arm64.dmg`,
      `${base}-mac-x64.zip`,
      `${base}-mac-arm64.zip`,
    ]);
    required = [`${base}-mac-x64.zip`, `${base}-mac-arm64.zip`];
  } else if (/^(latest|beta)-linux\.yml$/.test(manifestName)) {
    // electron-builder lists every Linux target from the same build
    // invocation in this manifest; electron-updater ignores those extra
    // `files` entries and downloads the one named by `path`. Observed on a
    // real draft in #468: beta-linux.yml carries the x64 deb and rpm.
    allowed = new Set([
      `${base}-linux-x64.appimage`,
      `${base}-linux-x64.deb`,
      `${base}-linux-x64.rpm`,
      `${base}-linux-x64.snap`,
    ]);
    required = [`${base}-linux-x64.appimage`];
  } else if (/^(latest|beta)-linux-arm64\.yml$/.test(manifestName)) {
    allowed = new Set([
      `${base}-linux-arm64.appimage`,
      `${base}-linux-arm64.deb`,
      `${base}-linux-arm64.rpm`,
      `${base}-linux-arm64.snap`,
    ]);
    required = [`${base}-linux-arm64.appimage`];
  } else {
    throw new Error(`unsupported release manifest ${manifestName}`);
  }

  const requiredUpdaterPath = required[0];

  const mismatched = urls.filter((url) => !allowed.has(url));
  if (mismatched.length > 0) {
    throw new Error(`${manifestName} references artifacts for another platform or architecture: ${mismatched.join(', ')}`);
  }
  const missing = required.filter((url) => !urls.includes(url));
  if (missing.length > 0) {
    throw new Error(`${manifestName} is missing required platform artifacts: ${missing.join(', ')}`);
  }
  if (requiredUpdaterPath && selectedPath !== requiredUpdaterPath) {
    throw new Error(`${manifestName} updater path must be ${requiredUpdaterPath}, got ${selectedPath ?? '(missing)'}`);
  }
}

function expectedArtifactNames(version) {
  const base = `flocafe-${version}`;
  return [
    'uninstall-macos.sh',
    'uninstall-windows.ps1',
    `${base}-win-x64.exe`,
    `${base}-win-x64.exe.blockmap`,
    `${base}-win-x64.appx`,
    `${base}-win-arm64.appx`,
    `${base}-mac-x64.dmg`,
    `${base}-mac-arm64.dmg`,
    `${base}-mac-x64.zip`,
    `${base}-mac-arm64.zip`,
    `${base}-mac-x64.zip.blockmap`,
    `${base}-mac-arm64.zip.blockmap`,
    `${base}-linux-x64.appimage`,
    `${base}-linux-arm64.appimage`,
    `${base}-linux-x64.deb`,
    `${base}-linux-arm64.deb`,
    `${base}-linux-x64.rpm`,
    `${base}-linux-arm64.rpm`,
    `${base}-linux-x64.snap`,
    `${base}-linux-arm64.snap`,
  ];
}

function assertReleaseAssetInventory(assets, manifestNames, version, { requiredEvidence = [] } = {}) {
  if (!version) throw new Error('release asset inventory requires an expected release version');
  const names = assets.map((asset) => asset.name);
  const optionalEvidence = new Set([
    'candidate-manifest.json',
    'release-summary.json',
    'snap-publication-x64.json',
    'snap-publication-arm64.json',
  ]);
  const requiredEvidenceSet = new Set(requiredEvidence);
  for (const name of requiredEvidenceSet) {
    if (!optionalEvidence.has(name)) throw new Error(`unsupported required release evidence asset ${name}`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error('release asset inventory contains duplicate asset names');
  }

  const manifestSet = new Set(manifestNames);
  const expected = new Set([...manifestNames, ...expectedArtifactNames(version), ...requiredEvidenceSet]);
  const allowed = new Set([...expected, ...optionalEvidence]);
  const unexpected = names.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`release asset inventory contains unexpected assets: ${unexpected.join(', ')}`);
  }
  const missing = [...expected].filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`release asset inventory is incomplete; missing: ${missing.join(', ')}`);
  }

  for (const asset of assets) {
    if (!/^[a-z0-9.-]+$/.test(asset.name)) {
      throw new Error(`release contains unsafe uploaded asset name ${asset.name}`);
    }
    if (!Number.isInteger(asset.size) || asset.size <= 0) {
      throw new Error(`release asset ${asset.name} has no positive uploaded size`);
    }
    if (manifestSet.has(asset.name)) continue;
  }
}

function defaultAssetRequest(asset) {
  if (typeof asset.url !== 'string' || asset.url.trim() === '') {
    throw new Error(`release asset ${asset.name} has no GitHub download URL`);
  }
  return githubRequest(asset.url, 'application/octet-stream');
}

function assertHttp200(response, asset) {
  if (Buffer.isBuffer(response) || response instanceof Uint8Array) return;
  if (!response || response.status !== 200) {
    const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
    throw new Error(`release asset ${asset.name} was not available at HTTP 200 (got ${status})`);
  }
}

async function responseToBuffer(response, asset) {
  assertHttp200(response, asset);
  if (Buffer.isBuffer(response)) return response;
  if (response instanceof Uint8Array) return Buffer.from(response);
  if (typeof response.arrayBuffer !== 'function') {
    throw new Error(`release asset ${asset.name} response has no readable body`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`release asset ${asset.name} returned an empty body`);
  return bytes;
}

async function verifyAssetAvailability(asset, requestAsset) {
  const response = await requestAsset(asset);
  assertHttp200(response, asset);
  if (Buffer.isBuffer(response) || response instanceof Uint8Array) {
    if (response.length === 0) throw new Error(`release asset ${asset.name} returned an empty body`);
    return;
  }
  if (response.body) {
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    await reader.cancel();
    if (firstChunk.done) throw new Error(`release asset ${asset.name} returned an empty body`);
    return;
  }
  await responseToBuffer(response, asset);
}

async function readAsset(asset, requestAsset) {
  return responseToBuffer(await requestAsset(asset), asset);
}

async function verifyArtifact(asset, expectedSha512, requestAsset) {
  const response = await requestAsset(asset);
  assertHttp200(response, asset);
  const hash = crypto.createHash('sha512');
  let bytes = 0;
  if (Buffer.isBuffer(response) || response instanceof Uint8Array) {
    const buffer = Buffer.from(response);
    hash.update(buffer);
    bytes = buffer.length;
  } else if (response.body) {
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  } else {
    const buffer = await responseToBuffer(response, asset);
    hash.update(buffer);
    bytes = buffer.length;
  }
  if (bytes === 0) throw new Error(`release asset ${asset.name} returned an empty body`);
  const actual = hash.digest('base64');
  if (actual !== normalizeSha512(expectedSha512)) {
    throw new Error(`SHA-512 mismatch for ${asset.name}: expected ${expectedSha512}, got ${actual}`);
  }
  return bytes;
}

async function verifyReleaseAssets(release, {
  channel,
  tag = release && release.tag_name,
  requestAsset = defaultAssetRequest,
  requireCandidateManifest = false,
  requireReleaseSummary = false,
  requireSnapEvidence = false,
} = {}) {
  if (!release || release.draft !== true) {
    throw new Error(`release ${tag || '(unknown)'} is not a draft; refusing to verify a mutable published release`);
  }
  if (typeof tag !== 'string' || tag === '') throw new Error('release verification requires a release tag');
  if (release.tag_name && release.tag_name !== tag) {
    throw new Error(`release metadata tag ${release.tag_name} does not match expected ${tag}`);
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetsByName = new Map(assets.map((asset) => [asset.name, asset]));
  const manifestNames = expectedManifestNames(channel);
  const requiredEvidence = [];
  if (requireCandidateManifest) requiredEvidence.push('candidate-manifest.json');
  if (requireReleaseSummary) requiredEvidence.push('release-summary.json');
  if (requireSnapEvidence) requiredEvidence.push('snap-publication-x64.json', 'snap-publication-arm64.json');
  for (const name of manifestNames) {
    if (!assetsByName.has(name)) throw new Error(`release ${tag} is missing ${name}`);
  }
  assertReleaseAssetInventory(assets, manifestNames, tag, { requiredEvidence });

  // Inventory-only assets (store packages, blockmaps, and uninstall helpers)
  // still have to be reachable from the uploaded draft, but do not have an
  // independent checksum contract. Manifest references below are always read
  // fully and hash-checked.
  for (const asset of assets) {
    if (!manifestNames.includes(asset.name)) await verifyAssetAvailability(asset, requestAsset);
  }

  const releaseChannel = channel === 'latest' ? 'stable' : channel;
  if (requireSnapEvidence) {
    for (const architecture of ['x64', 'arm64']) {
      const evidenceAsset = assetsByName.get(`snap-publication-${architecture}.json`);
      const evidenceBytes = await readAsset(evidenceAsset, requestAsset);
      let evidence;
      try { evidence = JSON.parse(evidenceBytes.toString('utf8')); } catch (error) {
        throw new Error(`snap-publication-${architecture}.json is not valid JSON: ${error.message}`);
      }
      assertSnapEvidence(evidence, { tag, channel: releaseChannel });
    }
  }
  if (requireReleaseSummary) {
    const summaryBytes = await readAsset(assetsByName.get('release-summary.json'), requestAsset);
    let summary;
    try { summary = JSON.parse(summaryBytes.toString('utf8')); } catch (error) {
      throw new Error(`release-summary.json is not valid JSON: ${error.message}`);
    }
    assertSanitized(summary);
    assertRetentionPolicy(summary.retention);
  }

  for (const manifestName of manifestNames) {
    const manifestAsset = assetsByName.get(manifestName);
    const manifestBytes = await readAsset(manifestAsset, requestAsset);
    const manifest = parseManifest(manifestBytes.toString('utf8'), manifestName);
    if (manifest.version !== tag) {
      throw new Error(`${manifestName} declares version ${manifest.version}, expected ${tag}`);
    }
    assertManifestPlatformMapping(manifestName, tag, manifest.files, manifest.path);

    for (const file of manifest.files) {
      if (file.url !== file.url.split('/').pop() || !/^[a-z0-9.-]+$/.test(file.url)) {
        throw new Error(`${manifestName} references unsafe artifact URL ${file.url}`);
      }
      const artifact = assetsByName.get(file.url);
      if (!artifact) {
        throw new Error(`${manifestName} references ${file.url}, which is not an asset in release ${tag}`);
      }
      const bytes = await verifyArtifact(artifact, file.sha512, requestAsset);
      console.log(`verified ${manifestName}: ${file.url} (${bytes} bytes, SHA-512 ok)`);
    }
  }

  console.log(`release ${tag} channel ${channel} passed draft asset verification`);
  return { tag, channel, manifests: manifestNames };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiBase = `https://api.github.com/repos/${options.repo}`;
  // GET /releases/tags/{tag} only resolves published releases; this verifier
  // runs against a DRAFT before the publish job flips it, so look the release
  // up through the releases list instead (drafts are included for tokens
  // with push access). Found while cutting 3.3.1-beta.1 (#468): the first
  // real run of this step 404'd because no release had ever been verified
  // as a draft before.
  const release = await findReleaseByTag(apiBase, options.tag);
  await verifyReleaseAssets(release, {
    channel: options.channel,
    tag: options.tag,
    requireCandidateManifest: options.requireCandidateManifest,
    requireReleaseSummary: options.requireReleaseSummary,
    requireSnapEvidence: options.requireSnapEvidence,
  });
}

async function findReleaseByTag(apiBase, tag) {
  const perPage = 100;
  for (let page = 1; page <= 10; page++) {
    const releases = await githubJson(`${apiBase}/releases?per_page=${perPage}&page=${page}`);
    if (!Array.isArray(releases) || releases.length === 0) break;
    const match = releases.find((release) => release.tag_name === tag);
    if (match) return match;
  }
  throw new Error(`No draft or published release found for tag ${tag}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertReleaseAssetInventory,
  assertManifestPlatformMapping,
  expectedArtifactNames,
  expectedManifestNames,
  parseManifest,
  verifyReleaseAssets,
};
