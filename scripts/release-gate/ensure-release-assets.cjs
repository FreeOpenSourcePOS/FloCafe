#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { findReleaseByTag } = require('./candidate-manifest.cjs');

try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
    connectTimeout: 60000,
  }));
} catch {
  // undici dispatcher optional
}

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`missing required argument ${name}`);
  return args[index + 1];
}

function fileArgs(args) {
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--file') {
      if (!args[index + 1]) throw new Error('missing file path after --file');
      files.push(args[++index]);
    }
  }
  if (files.length === 0) throw new Error('at least one --file is required');
  return files;
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

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function fetchAssetBytes(asset) {
  const response = await request(asset.url, { headers: authHeaders('application/octet-stream') });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${asset.name} returned an empty body`);
  return bytes;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assetName(filePath) {
  const name = path.basename(filePath);
  if (!/^[a-z0-9.-]+$/.test(name)) throw new Error(`unsafe release asset name ${name}`);
  return name;
}

async function deleteAsset(assetUrl, requestFn = request) {
  try {
    await requestFn(assetUrl, { method: 'DELETE' });
  } catch (error) {
    if (!/404/.test(error.message)) {
      throw error;
    }
  }
}

function tryUploadWithGh(release, filePath, repo) {
  if (!filePath || typeof release.tag_name !== 'string') return null;
  const targetRepo = repo || (release.url && release.url.match(/repos\/([^/]+\/[^/]+)/)?.[1]);
  const args = ['release', 'upload', release.tag_name, filePath, '--clobber'];
  if (targetRepo) args.push('--repo', targetRepo);
  execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  return { name: path.basename(filePath) };
}

async function uploadAsset(release, name, bytes, { maxRetries = 3, retryDelayMs = 3000, requestFn = request, filePath, repo } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      if (filePath && typeof release.tag_name === 'string') {
        try {
          return tryUploadWithGh(release, filePath, repo);
        } catch (ghError) {
          if (ghError.code !== 'ENOENT') {
            console.warn(`gh release upload failed (${ghError.message.slice(0, 200)}), falling back to HTTP request...`);
          }
        }
      }
      if (typeof release.upload_url !== 'string' || release.upload_url === '') throw new Error('release has no upload URL');
      const uploadUrl = release.upload_url.replace(/\{\?name,label\}$/, '');
      const response = await requestFn(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
        },
        body: bytes,
      });
      if (response.status !== 201) throw new Error(`GitHub asset upload returned unexpected status ${response.status} for ${name}`);
      return await response.json();
    } catch (error) {
      const isRetryable = /408|422|500|502|503|504|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed/i.test(error.message);
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      console.warn(`upload ${name} attempt ${attempt} failed (${error.message}); cleaning up and retrying in ${Math.round((retryDelayMs * attempt) / 1000)}s...`);
      if (typeof release.assets_url === 'string' && release.assets_url !== '') {
        try {
          const assetsResponse = await requestFn(release.assets_url);
          const assetsList = await assetsResponse.json();
          if (Array.isArray(assetsList)) {
            const stale = assetsList.find((a) => a.name === name);
            if (stale && stale.url) {
              await deleteAsset(stale.url, requestFn);
            }
          }
        } catch {
          // ignore lookup/cleanup errors and proceed to retry
        }
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

async function ensureReleaseAssets({ release, files, readFile = fs.readFile, fetchExistingAsset = fetchAssetBytes, upload = uploadAsset, repo } = {}) {
  if (!release || release.draft !== true) throw new Error('release asset reuse requires a draft release');
  if (!Array.isArray(files) || files.length === 0) throw new Error('release asset reuse requires files');
  const existing = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  const requested = new Set();
  const results = [];
  for (const filePath of files) {
    const name = assetName(filePath);
    if (requested.has(name)) throw new Error(`release asset ${name} was requested more than once`);
    requested.add(name);
    const bytes = Buffer.from(await readFile(filePath));
    if (bytes.length === 0) throw new Error(`${name} is empty`);
    const current = existing.get(name);
    if (current) {
      const currentBytes = Buffer.from(await fetchExistingAsset(current));
      if (!currentBytes.equals(bytes)) {
        throw new Error(`release asset ${name} already exists with different bytes (${digest(currentBytes)} != ${digest(bytes)})`);
      }
      results.push({ name, id: current.id, action: 'reused' });
      continue;
    }
    const uploaded = await upload(release, name, bytes, { filePath, repo });
    results.push({ name, id: uploaded && uploaded.id, action: 'uploaded' });
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = requiredArg(argv, '--repo');
  const tag = requiredArg(argv, '--tag');
  const files = fileArgs(argv);
  const apiBase = `https://api.github.com/repos/${repo}`;
  const release = await findReleaseByTag(apiBase, tag);
  const results = await ensureReleaseAssets({ release, files, repo });
  for (const result of results) console.log(`${result.action} ${result.name}${result.id ? ` (${result.id})` : ''}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { ensureReleaseAssets, uploadAsset };
