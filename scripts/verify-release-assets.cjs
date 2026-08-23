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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  };
  const repositoryParts = result.repo.split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !/^[a-zA-Z0-9.-]+$/.test(part))) {
    throw new Error(`invalid repository ${result.repo}`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(result.tag)) {
    throw new Error(`invalid release tag ${result.tag}`);
  }
  if (!['latest', 'beta', 'nightly'].includes(result.channel)) {
    throw new Error(`unsupported release channel ${result.channel}`);
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

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseManifest(text, name) {
  const files = [];
  let version = null;
  let current = null;
  let topLevelPath = null;
  let topLevelSha512 = null;

  for (const line of text.split(/\r?\n/)) {
    const versionValue = line.match(/^version:\s*(.+?)\s*$/);
    if (versionValue) {
      version = unquoteYamlScalar(versionValue[1]);
      continue;
    }

    const listUrl = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    const scalarUrl = line.match(/^\s+url:\s*(.+?)\s*$/);
    if (listUrl || scalarUrl) {
      current = { url: unquoteYamlScalar((listUrl || scalarUrl)[1]), sha512: null };
      files.push(current);
      continue;
    }

    const nestedSha = line.match(/^\s+sha512:\s*(.+?)\s*$/);
    if (nestedSha && current) {
      current.sha512 = unquoteYamlScalar(nestedSha[1]);
      continue;
    }

    const pathValue = line.match(/^path:\s*(.+?)\s*$/);
    if (pathValue) {
      topLevelPath = unquoteYamlScalar(pathValue[1]);
      continue;
    }

    const topSha = line.match(/^sha512:\s*(.+?)\s*$/);
    if (topSha) topLevelSha512 = unquoteYamlScalar(topSha[1]);
  }

  if (!version) throw new Error(`${name} does not declare a release version`);
  if (topLevelPath && !files.some((file) => file.url === topLevelPath)) {
    files.push({ url: topLevelPath, sha512: topLevelSha512 });
  }
  if (files.length === 0) throw new Error(`${name} does not reference any update artifact`);
  for (const file of files) {
    if (!file.url || !file.sha512) {
      throw new Error(`${name} has an update artifact without both url and sha512`);
    }
  }
  return { version, files };
}

function expectedManifestNames(channel) {
  return [
    `${channel}.yml`,
    `${channel}-mac.yml`,
    `${channel}-linux.yml`,
    `${channel}-linux-arm64.yml`,
  ];
}

function assertManifestPlatformMapping(manifestName, version, files) {
  const base = `flocafe-${version}`;
  const urls = files.map((file) => file.url);
  let allowed;
  let required;

  if (/^(latest|beta|nightly)\.yml$/.test(manifestName)) {
    allowed = new Set([`${base}-win-x64.exe`]);
    required = [`${base}-win-x64.exe`];
  } else if (/^(latest|beta|nightly)-mac\.yml$/.test(manifestName)) {
    allowed = new Set([
      `${base}-mac-x64.dmg`,
      `${base}-mac-arm64.dmg`,
      `${base}-mac-x64.zip`,
      `${base}-mac-arm64.zip`,
    ]);
    required = [`${base}-mac-x64.zip`, `${base}-mac-arm64.zip`];
  } else if (/^(latest|beta|nightly)-linux\.yml$/.test(manifestName)) {
    allowed = new Set([`${base}-linux-x64.appimage`]);
    required = [`${base}-linux-x64.appimage`];
  } else if (/^(latest|beta|nightly)-linux-arm64\.yml$/.test(manifestName)) {
    allowed = new Set([`${base}-linux-arm64.appimage`]);
    required = [`${base}-linux-arm64.appimage`];
  } else {
    throw new Error(`unsupported release manifest ${manifestName}`);
  }

  const mismatched = urls.filter((url) => !allowed.has(url));
  if (mismatched.length > 0) {
    throw new Error(`${manifestName} references artifacts for another platform or architecture: ${mismatched.join(', ')}`);
  }
  const missing = required.filter((url) => !urls.includes(url));
  if (missing.length > 0) {
    throw new Error(`${manifestName} is missing required platform artifacts: ${missing.join(', ')}`);
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

function assertReleaseAssetInventory(assets, manifestNames, version) {
  if (!version) throw new Error('release asset inventory requires an expected release version');
  const names = assets.map((asset) => asset.name);
  if (new Set(names).size !== names.length) {
    throw new Error('release asset inventory contains duplicate asset names');
  }

  const manifestSet = new Set(manifestNames);
  const expected = new Set([...manifestNames, ...expectedArtifactNames(version)]);
  const unexpected = names.filter((name) => !expected.has(name));
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

async function verifyAssetAvailability(asset) {
  const response = await githubRequest(asset.url, 'application/octet-stream');
  if (!response.body) throw new Error(`GitHub returned no body for ${asset.name}`);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
}

async function readAsset(asset) {
  const response = await githubRequest(asset.url, 'application/octet-stream');
  return response.arrayBuffer();
}

async function verifyArtifact(asset, expectedSha512) {
  const response = await githubRequest(asset.url, 'application/octet-stream');
  if (!response.body) throw new Error(`GitHub returned no body for ${asset.name}`);
  const hash = crypto.createHash('sha512');
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const actual = hash.digest('base64');
  if (actual !== expectedSha512.replace(/\s+/g, '')) {
    throw new Error(`SHA-512 mismatch for ${asset.name}: expected ${expectedSha512}, got ${actual}`);
  }
  return bytes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiBase = `https://api.github.com/repos/${options.repo}`;
  const release = await githubJson(`${apiBase}/releases/tags/${encodeURIComponent(options.tag)}`);
  if (release.draft !== true) {
    throw new Error(`release ${options.tag} is not a draft; refusing to verify a mutable published release`);
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetsByName = new Map(assets.map((asset) => [asset.name, asset]));
  const manifestNames = expectedManifestNames(options.channel);
  for (const name of manifestNames) {
    if (!assetsByName.has(name)) throw new Error(`release ${options.tag} is missing ${name}`);
  }
  assertReleaseAssetInventory(assets, manifestNames, options.tag);

  for (const asset of assets) {
    if (!manifestNames.includes(asset.name)) await verifyAssetAvailability(asset);
  }

  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flocafe-release-verify-'));
  try {
    for (const manifestName of manifestNames) {
      const manifestAsset = assetsByName.get(manifestName);
      const manifestBytes = Buffer.from(await readAsset(manifestAsset));
      const manifestPath = path.join(verifyDir, manifestName);
      fs.writeFileSync(manifestPath, manifestBytes);
      const manifest = parseManifest(manifestBytes.toString('utf8'), manifestName);
      if (manifest.version !== options.tag) {
        throw new Error(`${manifestName} declares version ${manifest.version}, expected ${options.tag}`);
      }
      assertManifestPlatformMapping(manifestName, options.tag, manifest.files);

      for (const file of manifest.files) {
        if (path.basename(file.url) !== file.url || !/^[a-z0-9.-]+$/.test(file.url)) {
          throw new Error(`${manifestName} references unsafe artifact URL ${file.url}`);
        }
        if (!file.url.includes(options.tag)) {
          throw new Error(`${manifestName} references ${file.url}, which is not part of release ${options.tag}`);
        }
        const artifact = assetsByName.get(file.url);
        if (!artifact) {
          throw new Error(`${manifestName} references ${file.url}, which is not an asset in release ${options.tag}`);
        }
        const bytes = await verifyArtifact(artifact, file.sha512);
        console.log(`verified ${manifestName}: ${file.url} (${bytes} bytes, SHA-512 ok)`);
      }
    }
  } finally {
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }

  console.log(`release ${options.tag} channel ${options.channel} passed draft asset verification`);
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
};
