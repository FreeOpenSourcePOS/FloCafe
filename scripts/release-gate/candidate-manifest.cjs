#!/usr/bin/env node

/**
 * Build and verify the immutable release candidate binding.
 *
 * The binding is deliberately made from bytes fetched back from the draft or
 * published GitHub release.  It is not a build-directory inventory: asset IDs,
 * names, sizes, platform/architecture classification, and both digests are
 * recorded for the exact bytes that the installed-artifact gate may consume.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMIT = /^[0-9a-f]{40,64}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const DIGEST512 = /^[0-9a-f]{128}$/i;
const CHANNELS = new Set(['stable', 'beta']);
const SIGNING_STATUSES = new Set(['signed', 'unsigned', 'not-applicable', 'not-verified']);
const SMARTSCREEN_STATUSES = new Set(['not-run', 'manual-not-run', 'not-applicable']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`missing required argument ${name}`);
  return args[index + 1];
}

function optionalArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] || fallback);
}

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.includes('--verify') ? 'verify' : 'create';
  const options = {
    mode,
    repo: requiredArg(args, '--repo'),
    tag: requiredArg(args, '--tag'),
    commit: requiredArg(args, '--commit'),
    channel: requiredArg(args, '--channel'),
    output: optionalArg(args, '--output', null),
    manifestSha256: optionalArg(args, '--manifest-sha256', null),
    candidateAssetId: optionalArg(args, '--candidate-asset-id', null),
    windowsSigning: optionalArg(args, '--windows-signing-status', 'unsigned'),
    macSigning: optionalArg(args, '--mac-signing-status', 'signed'),
    linuxSigning: optionalArg(args, '--linux-signing-status', 'not-applicable'),
  };
  const parts = options.repo.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9.-]+$/.test(part))) {
    throw new Error(`invalid repository ${options.repo}`);
  }
  if (!SEMVER.test(options.tag)) throw new Error(`invalid release tag ${options.tag}`);
  if (!COMMIT.test(options.commit)) throw new Error(`invalid release commit ${options.commit}`);
  if (!CHANNELS.has(options.channel)) throw new Error(`unsupported release channel ${options.channel}`);
  for (const [platform, status] of Object.entries({
    windows: options.windowsSigning,
    mac: options.macSigning,
    linux: options.linuxSigning,
  })) {
    if (!SIGNING_STATUSES.has(status)) throw new Error(`invalid ${platform} signing status ${status}`);
  }
  if (options.manifestSha256 !== null && !DIGEST.test(options.manifestSha256)) {
    throw new Error('--manifest-sha256 must be a 64-character hexadecimal digest');
  }
  if (options.candidateAssetId !== null && !/^\d+$/.test(options.candidateAssetId)) {
    throw new Error('--candidate-asset-id must be a positive integer');
  }
  return options;
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

async function findReleaseByTag(apiBase, tag, requestPage = githubRequest) {
  let url = `${apiBase}/releases?per_page=100&page=1`;
  while (url) {
    const response = await requestPage(url);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error(`GitHub releases response for ${tag} was not an array`);
    const match = releases.find((release) => release && release.tag_name === tag);
    if (match) return match;
    const link = typeof response.headers?.get === 'function' ? response.headers.get('link') || '' : '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/i);
    url = next ? next[1] : null;
  }
  throw new Error(`No draft or published release found for tag ${tag}`);
}

async function resolveTagCommit(apiBase, tag) {
  let object = (await githubJson(`${apiBase}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; depth < 4; depth++) {
    if (!isRecord(object) || typeof object.sha !== 'string' || typeof object.type !== 'string') {
      throw new Error(`GitHub tag ${tag} did not resolve to a Git object`);
    }
    if (object.type === 'commit') {
      if (!COMMIT.test(object.sha)) throw new Error(`GitHub tag ${tag} resolved to an invalid commit SHA`);
      return object.sha.toLowerCase();
    }
    if (object.type !== 'tag') throw new Error(`GitHub tag ${tag} resolved to unsupported object type ${object.type}`);
    object = (await githubJson(`${apiBase}/git/tags/${encodeURIComponent(object.sha)}`)).object;
  }
  throw new Error(`GitHub tag ${tag} has too many annotated-tag indirections`);
}

async function responseBytes(response, description) {
  if (Buffer.isBuffer(response)) return response;
  if (response instanceof Uint8Array) return Buffer.from(response);
  if (!response || response.status !== 200) {
    const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
    throw new Error(`${description} was not available at HTTP 200 (got ${status})`);
  }
  if (typeof response.arrayBuffer !== 'function') throw new Error(`${description} has no readable body`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${description} returned an empty body`);
  return bytes;
}

async function hashAsset(asset, requestAsset) {
  const response = await requestAsset(asset);
  const hash256 = crypto.createHash('sha256');
  const hash512 = crypto.createHash('sha512');
  let size = 0;
  if (Buffer.isBuffer(response) || response instanceof Uint8Array) {
    const bytes = Buffer.from(response);
    hash256.update(bytes);
    hash512.update(bytes);
    size = bytes.length;
  } else {
    if (!response || response.status !== 200) {
      const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
      throw new Error(`${asset.name} was not available at HTTP 200 (got ${status})`);
    }
    if (!response.body) {
      const bytes = await responseBytes(response, asset.name);
      hash256.update(bytes);
      hash512.update(bytes);
      size = bytes.length;
    } else {
      for await (const chunk of response.body) {
        hash256.update(chunk);
        hash512.update(chunk);
        size += chunk.length;
      }
    }
  }
  if (size === 0) throw new Error(`${asset.name} returned an empty body`);
  return {
    size,
    sha256: hash256.digest('hex'),
    sha512: hash512.digest('hex'),
  };
}

function classifyAsset(name) {
  if (name === 'candidate-manifest.json') return null;
  if (name === 'release-summary.json') return null;

  let platform = 'unknown';
  let architecture = 'unknown';
  let kind = 'artifact';

  if (/^(latest|beta)(?:-(mac|linux(?:-arm64)?))?\.yml$/.test(name)) {
    kind = 'update-manifest';
    platform = name.includes('-mac') ? 'mac' : name.includes('-linux') ? 'linux' : 'windows';
    architecture = name.includes('linux-arm64') ? 'arm64' : 'multi';
  } else if (name === 'uninstall-macos.sh') {
    platform = 'mac'; architecture = 'multi'; kind = 'utility';
  } else if (name === 'uninstall-windows.ps1') {
    platform = 'windows'; architecture = 'multi'; kind = 'utility';
  } else if (name.startsWith('snap-publication-') && name.endsWith('.json')) {
    const match = name.match(/^snap-publication-(x64|arm64)\.json$/);
    if (!match) throw new Error(`unrecognized Snap evidence asset ${name}`);
    platform = 'linux'; architecture = match[1]; kind = 'evidence';
  } else {
    const match = name.match(/^flocafe-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?-(win|mac|linux)-(x64|arm64)\.(.+)$/);
    if (!match) throw new Error(`cannot classify release asset ${name} by platform and architecture`);
    platform = match[1] === 'win' ? 'windows' : match[1];
    architecture = match[2];
    const extension = match[3];
    if (extension === 'blockmap' || extension.endsWith('.blockmap')) kind = 'blockmap';
    else if (extension === 'exe' || extension === 'dmg' || extension === 'appimage') kind = 'installer';
    else if (extension === 'appx') kind = 'store-package';
    else if (extension === 'deb' || extension === 'rpm' || extension === 'snap') kind = 'package';
    else if (extension === 'zip') kind = 'archive';
  }

  return { platform, architecture, kind };
}

function signingFor(platform, statuses, kind) {
  const status = ['update-manifest', 'evidence', 'blockmap', 'utility'].includes(kind)
    ? 'not-applicable'
    : platform === 'windows' ? statuses.windows
      : platform === 'mac' ? statuses.mac
        : platform === 'linux' ? statuses.linux : 'not-applicable';
  const smartScreen = platform === 'windows' ? 'not-run' : 'not-applicable';
  return {
    status,
    // A Windows signature is not evidence of SmartScreen reputation. That
    // reputation is explicitly outside the hosted mechanical gate.
    smartScreen,
    verification: status === 'signed' ? 'release-build-verification' : 'not-run',
  };
}

function assertSigningStatus(asset) {
  if (!isRecord(asset.signing) || !SIGNING_STATUSES.has(asset.signing.status)) {
    throw new Error(`${asset.name} must declare an explicit signing status`);
  }
  if (asset.signing.smartScreen === 'pass') {
    throw new Error(`${asset.name} cannot use signing metadata as SmartScreen evidence`);
  }
  if (!SMARTSCREEN_STATUSES.has(asset.signing.smartScreen)) {
    throw new Error(`${asset.name} has an invalid SmartScreen status`);
  }
  if (asset.platform === 'windows' && asset.signing.smartScreen === 'not-applicable') {
    throw new Error(`${asset.name} cannot mark SmartScreen not-applicable on Windows`);
  }
  if (asset.signing.status === 'unsigned' && asset.signing.verification === 'signed') {
    throw new Error(`${asset.name} cannot describe an unsigned asset as signed`);
  }
}

function assertCandidateManifest(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) throw new Error('candidate manifest schemaVersion must be 1');
  if (manifest.immutable !== true) throw new Error('candidate manifest must declare immutable=true');
  if (!isRecord(manifest.release) || !SEMVER.test(manifest.release.tag)) throw new Error('candidate manifest has an invalid release tag');
  if (!CHANNELS.has(manifest.release.channel)) throw new Error('candidate manifest has an invalid release channel');
  if (manifest.release.prerelease !== (manifest.release.channel === 'beta')) throw new Error('candidate manifest channel/prerelease state disagrees');
  if (manifest.release.draft !== true) throw new Error('candidate manifest must be created from a draft release');
  if (!isRecord(manifest.commit) || !COMMIT.test(manifest.commit.sha)) throw new Error('candidate manifest has an invalid commit SHA');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('candidate manifest has no bound assets');

  const names = new Set();
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!isRecord(asset) || !Number.isInteger(asset.id) || asset.id <= 0) throw new Error('candidate manifest asset IDs must be positive integers');
    if (ids.has(asset.id)) throw new Error(`candidate manifest repeats asset ID ${asset.id}`);
    ids.add(asset.id);
    if (typeof asset.name !== 'string' || !/^[a-z0-9.-]+$/.test(asset.name)) throw new Error(`candidate manifest has unsafe asset name ${asset.name}`);
    if (names.has(asset.name)) throw new Error(`candidate manifest repeats asset ${asset.name}`);
    names.add(asset.name);
    if (!Number.isInteger(asset.size) || asset.size <= 0) throw new Error(`candidate manifest asset ${asset.name} has invalid size`);
    if (!DIGEST.test(asset.sha256) || !DIGEST512.test(asset.sha512)) throw new Error(`candidate manifest asset ${asset.name} has invalid digests`);
    if (!['windows', 'mac', 'linux', 'manifest'].includes(asset.platform)) throw new Error(`${asset.name} has invalid platform ${asset.platform}`);
    if (!['x64', 'arm64', 'multi'].includes(asset.architecture)) throw new Error(`${asset.name} has invalid architecture ${asset.architecture}`);
    const classification = classifyAsset(asset.name);
    if (!classification || classification.platform !== asset.platform || classification.architecture !== asset.architecture) {
      throw new Error(`${asset.name} platform/architecture binding does not match its name`);
    }
    assertSigningStatus(asset);
  }
  return manifest;
}

async function createCandidateManifest({ release, commit, channel, requestAsset, signingStatuses = {
  windows: 'unsigned',
  mac: 'signed',
  linux: 'not-applicable',
} }) {
  if (!release || release.draft !== true) throw new Error('candidate manifest can only bind a draft release');
  if (!SEMVER.test(release.tag_name || '')) throw new Error('release has no valid tag');
  if (!COMMIT.test(commit || '')) throw new Error('candidate manifest requires the exact release commit SHA');
  if (!CHANNELS.has(channel)) throw new Error(`unsupported release channel ${channel}`);
  if (!isRecord(signingStatuses) || Object.values(signingStatuses).some((status) => !SIGNING_STATUSES.has(status))) {
    throw new Error('candidate manifest signing statuses are invalid');
  }
  const assets = Array.isArray(release.assets) ? [...release.assets].sort((a, b) => String(a.name).localeCompare(String(b.name))) : [];
  if (assets.length === 0) throw new Error(`release ${release.tag_name} has no assets`);

  const boundAssets = [];
  for (const asset of assets) {
    if (asset.name === 'candidate-manifest.json' || asset.name === 'release-summary.json') continue;
    if (!Number.isInteger(asset.id) || asset.id <= 0) throw new Error(`release asset ${asset.name} has no valid GitHub asset ID`);
    if (typeof asset.name !== 'string' || !/^[a-z0-9.-]+$/.test(asset.name)) throw new Error(`release contains unsafe uploaded asset name ${asset.name}`);
    const classification = classifyAsset(asset.name);
    if (!classification) continue;
    const digest = await hashAsset(asset, requestAsset);
    if (Number.isInteger(asset.size) && asset.size > 0 && asset.size !== digest.size) {
      throw new Error(`size mismatch for ${asset.name}: GitHub reports ${asset.size}, downloaded ${digest.size}`);
    }
    boundAssets.push({
      id: asset.id,
      name: asset.name,
      size: digest.size,
      platform: classification.platform,
      architecture: classification.architecture,
      kind: classification.kind,
      sha256: digest.sha256,
      sha512: digest.sha512,
      signing: signingFor(classification.platform, signingStatuses, classification.kind),
    });
  }

  const manifest = {
    schemaVersion: 1,
    immutable: true,
    release: {
      tag: release.tag_name,
      channel,
      draft: true,
      prerelease: channel === 'beta',
    },
    commit: { sha: commit.toLowerCase() },
    assets: boundAssets,
    installedArtifactGate: {
      sourceTagMustBeCapturedAtJobStart: true,
      targetTag: release.tag_name,
      exactAssetBindingRequired: true,
    },
  };
  return assertCandidateManifest(manifest);
}

async function verifyCandidateManifest(manifest, release, { requestAsset, tag, commit, channel } = {}) {
  assertCandidateManifest(manifest);
  if (!release || release.tag_name !== manifest.release.tag) throw new Error('candidate manifest release tag does not match the release');
  if (tag && manifest.release.tag !== tag) throw new Error(`candidate manifest tag ${manifest.release.tag} does not match expected ${tag}`);
  if (commit && manifest.commit.sha !== commit.toLowerCase()) throw new Error('candidate manifest commit does not match the exact candidate commit');
  if (channel && manifest.release.channel !== channel) throw new Error('candidate manifest channel does not match the expected channel');

  const current = new Map((release.assets || [])
    .filter((asset) => asset.name !== 'candidate-manifest.json' && asset.name !== 'release-summary.json')
    .map((asset) => [asset.id, asset]));
  if (current.size !== manifest.assets.length) throw new Error('release asset set changed after the candidate manifest was created');
  for (const expected of manifest.assets) {
    const asset = current.get(expected.id);
    if (!asset || asset.name !== expected.name) throw new Error(`candidate asset binding changed for ${expected.name}`);
    const digest = await hashAsset(asset, requestAsset);
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256 || digest.sha512 !== expected.sha512) {
      throw new Error(`candidate digest binding mismatch for ${expected.name}`);
    }
  }
  return { tag: manifest.release.tag, commit: manifest.commit.sha, assetCount: manifest.assets.length };
}

function defaultAssetRequest(asset) {
  if (typeof asset.url !== 'string' || asset.url.trim() === '') throw new Error(`release asset ${asset.name} has no API URL`);
  return githubRequest(asset.url, 'application/octet-stream');
}

function manifestSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function createFromGitHub(options) {
  const apiBase = `https://api.github.com/repos/${options.repo}`;
  const resolvedCommit = await resolveTagCommit(apiBase, options.tag);
  if (resolvedCommit !== options.commit.toLowerCase()) {
    throw new Error(`release tag ${options.tag} resolves to ${resolvedCommit}, not the supplied commit ${options.commit}`);
  }
  const release = await findReleaseByTag(apiBase, options.tag);
  const manifest = await createCandidateManifest({
    release,
    commit: resolvedCommit,
    channel: options.channel,
    requestAsset: defaultAssetRequest,
    signingStatuses: {
      windows: options.windowsSigning,
      mac: options.macSigning,
      linux: options.linuxSigning,
    },
  });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!options.output) throw new Error('candidate manifest creation requires --output');
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
  fs.writeFileSync(options.output, bytes, { mode: 0o600 });
  console.log(`candidate manifest ${options.tag}: ${manifestSha256(bytes)} (${manifest.assets.length} assets)`);
}

async function verifyFromGitHub(options) {
  const apiBase = `https://api.github.com/repos/${options.repo}`;
  const resolvedCommit = await resolveTagCommit(apiBase, options.tag);
  if (resolvedCommit !== options.commit.toLowerCase()) {
    throw new Error(`release tag ${options.tag} resolves to ${resolvedCommit}, not the supplied commit ${options.commit}`);
  }
  const release = await findReleaseByTag(apiBase, options.tag);
  const candidateAsset = (release.assets || []).find((asset) => asset.name === 'candidate-manifest.json');
  if (!candidateAsset) throw new Error(`release ${options.tag} is missing candidate-manifest.json`);
  if (options.candidateAssetId && String(candidateAsset.id) !== String(options.candidateAssetId)) {
    throw new Error(`candidate manifest asset ID ${candidateAsset.id} does not match expected ${options.candidateAssetId}`);
  }
  const bytes = await responseBytes(await defaultAssetRequest(candidateAsset), candidateAsset.name);
  const actualSha256 = manifestSha256(bytes);
  if (options.manifestSha256 && actualSha256 !== options.manifestSha256.toLowerCase()) {
    throw new Error(`candidate manifest SHA-256 mismatch: expected ${options.manifestSha256}, got ${actualSha256}`);
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`candidate-manifest.json is not valid JSON: ${error.message}`); }
  await verifyCandidateManifest(manifest, release, {
    requestAsset: defaultAssetRequest,
    tag: options.tag,
    commit: resolvedCommit,
    channel: options.channel,
  });
  console.log(`candidate manifest ${options.tag}: immutable asset binding verified (${manifest.assets.length} assets)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'verify') await verifyFromGitHub(options);
  else await createFromGitHub(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertCandidateManifest,
  classifyAsset,
  createCandidateManifest,
  findReleaseByTag,
  hashAsset,
  manifestSha256,
  resolveTagCommit,
  verifyCandidateManifest,
};
