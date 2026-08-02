#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, createPrivateKey, sign } = require('crypto');

const REPOSITORY = 'FreeOpenSourcePOS/FloCafe-Plugins';
const TAG_PATTERN = /^tax-pack-([a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d+)$/;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument: ${name || ''}`);
    args[name.slice(2)] = value;
  }
  return args;
}

function loadSigningKey(value) {
  if (!value) throw new Error('TAX_PACK_SIGNING_KEY is required');
  let key;
  if (value.includes('BEGIN PRIVATE KEY')) {
    key = createPrivateKey(value);
  } else {
    const decoded = Buffer.from(value, 'base64');
    const decodedText = decoded.toString('utf8');
    key = decodedText.includes('BEGIN PRIVATE KEY')
      ? createPrivateKey(decodedText)
      : createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('TAX_PACK_SIGNING_KEY must be an Ed25519 private key');
  }
  return key;
}

function readPackForTag(tag, packsDirectory) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) throw new Error('Tag must match tax-pack-<pack-id>-vX.Y.Z');
  const [, packId, version] = match;
  const files = fs.readdirSync(packsDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of files) {
    const filePath = path.join(packsDirectory, file);
    const packJson = fs.readFileSync(filePath, 'utf8');
    const pack = JSON.parse(packJson);
    if (pack.id !== packId) continue;
    if (pack.version !== version) {
      throw new Error(`Tag version ${version} does not match ${file}'s version ${pack.version}`);
    }
    if (pack.publisher === 'local') throw new Error('Local packs cannot be published');
    return { pack, packJson };
  }
  throw new Error(`No country pack JSON has id ${packId}`);
}

function loadExistingCatalog(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), packs: [] };
  }
  const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.packs)) {
    throw new Error('Existing catalog has an unsupported schema');
  }
  return catalog;
}

function prepareRelease({
  tag,
  packsDirectory,
  outputDirectory,
  existingCatalogPath,
  signingKeyValue,
  generatedAt = new Date().toISOString(),
}) {
  const { pack, packJson } = readPackForTag(tag, packsDirectory);
  const signingKey = loadSigningKey(signingKeyValue);
  const digest = createHash('sha256').update(packJson, 'utf8').digest('hex');
  const signature = sign(null, Buffer.from(packJson, 'utf8'), signingKey).toString('base64');
  const packAssetName = `${pack.id}-v${pack.version}.json`;
  const signatureAssetName = `${packAssetName}.sig`;
  const releaseBaseUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
  const entry = {
    id: pack.id,
    publisher: pack.publisher,
    country: pack.country,
    jurisdiction: pack.jurisdiction,
    version: pack.version,
    publishedAt: pack.publishedAt,
    minFloVersion: pack.minFloVersion,
    downloadUrl: `${releaseBaseUrl}/${packAssetName}`,
    signatureUrl: `${releaseBaseUrl}/${signatureAssetName}`,
    digest,
  };

  const existingCatalog = loadExistingCatalog(existingCatalogPath);
  const previousEntries = existingCatalog.packs.filter((candidate) => candidate.id !== pack.id);
  const catalog = {
    schemaVersion: 1,
    generatedAt,
    packs: [...previousEntries, entry].sort((left, right) => left.id.localeCompare(right.id)),
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, packAssetName), packJson);
  fs.writeFileSync(path.join(outputDirectory, signatureAssetName), `${signature}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { packAssetName, signatureAssetName, catalog, entry };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const result = prepareRelease({
    tag: args.tag,
    packsDirectory: path.join(repositoryRoot, 'main', 'tax-packs'),
    outputDirectory: path.resolve(args.output),
    existingCatalogPath: args.catalog ? path.resolve(args.catalog) : undefined,
    signingKeyValue: process.env.TAX_PACK_SIGNING_KEY,
  });
  console.log(`Prepared signed tax pack ${result.entry.id}@${result.entry.version}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  TAG_PATTERN,
  loadSigningKey,
  prepareRelease,
  readPackForTag,
};
