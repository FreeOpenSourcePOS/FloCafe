import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadAndVerifyTaxPack,
  fetchRemoteTaxPackCatalog,
  parseTaxPackCatalog,
  taxPackSha256,
  verifyTaxPackSignature,
  type TaxPackCatalog,
  type TaxPackCatalogEntry,
} from '../main/tax-packs/catalog';
import dualRatePack from './fixtures/synthetic-dual-rate-pack.json';

const releaseTag = 'tax-pack-test-dual-rate-pack-v1.1.0';
const releaseBase = `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${releaseTag}`;

function response(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(value)) },
  });
}

function signedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pack = {
    ...dualRatePack,
    version: '1.1.0',
    publishedAt: '2026-07-30',
  };
  const packJson = JSON.stringify(pack, null, 2);
  const signature = sign(null, Buffer.from(packJson), privateKey).toString('base64');
  const entry: TaxPackCatalogEntry = {
    id: pack.id,
    publisher: pack.publisher,
    country: pack.country,
    jurisdiction: pack.jurisdiction,
    version: pack.version,
    publishedAt: pack.publishedAt,
    minFloVersion: pack.minFloVersion,
    downloadUrl: `${releaseBase}/${pack.id}-v${pack.version}.json`,
    signatureUrl: `${releaseBase}/${pack.id}-v${pack.version}.json.sig`,
    digest: taxPackSha256(packJson),
  };
  const catalog: TaxPackCatalog = {
    schemaVersion: 1,
    generatedAt: '2026-07-30T00:00:00.000Z',
    packs: [entry],
  };
  return { privateKey, publicKey, pack, packJson, signature, entry, catalog };
}

test('catalog discovery finds the newest tax-pack release and verifies its detached signature', async () => {
  const fixture = signedFixture();
  const catalogUrl = `${releaseBase}/catalog.json`;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/FreeOpenSourcePOS/FloCafe-Plugins/releases')) {
      return response(JSON.stringify([
        {
          tag_name: releaseTag,
          html_url: `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/tag/${releaseTag}`,
          draft: false,
          assets: [{ name: 'catalog.json', browser_download_url: catalogUrl }],
        },
      ]));
    }
    if (url === catalogUrl) return response(JSON.stringify(fixture.catalog));
    if (url === fixture.entry.downloadUrl) return response(fixture.packJson);
    if (url === fixture.entry.signatureUrl) return response(`${fixture.signature}\n`);
    return response('', 404);
  };

  const remote = await fetchRemoteTaxPackCatalog(fetchImpl);
  assert.equal(remote.releaseTag, releaseTag);
  assert.deepEqual(remote.catalog, fixture.catalog);
  const artifact = await downloadAndVerifyTaxPack(fixture.entry, fetchImpl, fixture.publicKey);
  assert.equal(artifact.pack.id, 'test-dual-rate-pack');
  assert.equal(artifact.pack.version, '1.1.0');
  assert.equal(artifact.signature, fixture.signature);
  assert.equal(verifyTaxPackSignature(fixture.packJson, fixture.signature, fixture.publicKey), true);
});

test('download rejects digest mismatches, signature tampering, and non-release URLs', async () => {
  const fixture = signedFixture();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === fixture.entry.downloadUrl) return response(`${fixture.packJson}\n`);
    if (url === fixture.entry.signatureUrl) return response(fixture.signature);
    return response('', 404);
  };
  await assert.rejects(
    downloadAndVerifyTaxPack(fixture.entry, fetchImpl, fixture.publicKey),
    /digest does not match/,
  );

  const tamperedSignature = Buffer.alloc(64, 7).toString('base64');
  const validBytesFetch: typeof fetch = async (input) => response(
    String(input) === fixture.entry.downloadUrl ? fixture.packJson : tamperedSignature,
  );
  await assert.rejects(
    downloadAndVerifyTaxPack(fixture.entry, validBytesFetch, fixture.publicKey),
    /signature verification failed/,
  );

  assert.throws(
    () => parseTaxPackCatalog({
      ...fixture.catalog,
      packs: [{ ...fixture.entry, downloadUrl: 'https://example.com/pack.json' }],
    }),
    /invalid entry/,
  );
  assert.throws(
    () => parseTaxPackCatalog({
      ...fixture.catalog,
      packs: [{
        ...fixture.entry,
        downloadUrl: `https://github.com/FreeOpenSourcePOS/FloCafe/releases/download/${releaseTag}/pack.json`,
      }],
    }),
    /invalid entry/,
  );
});

test('release builder signs exact pack bytes and preserves other catalog entries', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tax-pack-release-'));
  const packsDir = path.join(tempDir, 'packs');
  const outputDir = path.join(tempDir, 'out');
  fs.mkdirSync(packsDir);
  const pack = { ...dualRatePack, version: '1.1.0', publishedAt: '2026-07-30' };
  fs.writeFileSync(path.join(packsDir, 'dual-rate.json'), `${JSON.stringify(pack, null, 2)}\n`);
  const existingCatalogPath = path.join(tempDir, 'catalog.json');
  fs.writeFileSync(existingCatalogPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-29T00:00:00.000Z',
    packs: [{
      id: 'test-flat-rate-pack',
      publisher: 'FreeOpenSourcePOS',
      country: 'YY',
      jurisdiction: '*',
      version: '1.0.0',
      publishedAt: '2026-01-01',
      minFloVersion: '2.4.0',
      downloadUrl: 'https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/tax-pack-test-flat-rate-pack-v1.0.0/test-flat-rate-pack-v1.0.0.json',
      signatureUrl: 'https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/tax-pack-test-flat-rate-pack-v1.0.0/test-flat-rate-pack-v1.0.0.json.sig',
      digest: '0'.repeat(64),
    }],
  }));

  const { prepareRelease } = require('../scripts/tax-packs/prepare-release.cjs');
  const result = prepareRelease({
    tag: releaseTag,
    packsDirectory: packsDir,
    outputDirectory: outputDir,
    existingCatalogPath,
    signingKeyValue: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    generatedAt: '2026-07-30T00:00:00.000Z',
  });
  const emittedPack = fs.readFileSync(path.join(outputDir, result.packAssetName), 'utf8');
  const emittedSignature = fs.readFileSync(path.join(outputDir, result.signatureAssetName), 'utf8').trim();
  const emittedCatalog = JSON.parse(fs.readFileSync(path.join(outputDir, 'catalog.json'), 'utf8'));
  assert.equal(verifyTaxPackSignature(emittedPack, emittedSignature, publicKey), true);
  assert.deepEqual(emittedCatalog.packs.map((entry: TaxPackCatalogEntry) => entry.id), [
    'test-dual-rate-pack',
    'test-flat-rate-pack',
  ]);
  assert.equal(emittedCatalog.packs[0].digest, taxPackSha256(emittedPack));
  assert.throws(
    () => prepareRelease({
      tag: 'tax-pack-test-dual-rate-pack-v9.9.9',
      packsDirectory: packsDir,
      outputDirectory: outputDir,
      signingKeyValue: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    /does not match/,
  );
  const derKey = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  assert.equal(
    prepareRelease({
      tag: releaseTag,
      packsDirectory: packsDir,
      outputDirectory: path.join(tempDir, 'der-out'),
      signingKeyValue: derKey,
    }).entry.version,
    '1.1.0',
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});
