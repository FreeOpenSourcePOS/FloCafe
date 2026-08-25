#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { findReleaseByTag } = require('./candidate-manifest.cjs');

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

async function uploadAsset(release, name, bytes) {
  if (typeof release.upload_url !== 'string' || release.upload_url === '') throw new Error('release has no upload URL');
  const uploadUrl = release.upload_url.replace(/\{\?name,label\}$/, '');
  const response = await request(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (response.status !== 201) throw new Error(`GitHub asset upload returned unexpected status ${response.status} for ${name}`);
  return response.json();
}

async function ensureReleaseAssets({ release, files, readFile = fs.readFile, fetchExistingAsset = fetchAssetBytes, upload = uploadAsset } = {}) {
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
    const uploaded = await upload(release, name, bytes);
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
  const results = await ensureReleaseAssets({ release, files });
  for (const result of results) console.log(`${result.action} ${result.name}${result.id ? ` (${result.id})` : ''}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { ensureReleaseAssets };
