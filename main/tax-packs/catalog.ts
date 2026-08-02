import { createHash, verify, type KeyLike } from 'crypto';
import type { CountryPack } from './types';
import { TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY } from './trusted-signing-key';

const RELEASES_API_URL = 'https://api.github.com/repos/FreeOpenSourcePOS/FloCafe-Plugins/releases';
const RELEASE_DOWNLOAD_PATH_PREFIX = '/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RELEASE_PAGES = 10;
const MAX_CATALOG_BYTES = 1_000_000;
const MAX_PACK_BYTES = 2_000_000;
const MAX_SIGNATURE_BYTES = 4_096;

export interface TaxPackCatalogEntry {
  id: string;
  publisher: string;
  country: string;
  jurisdiction: string;
  version: string;
  publishedAt: string;
  minFloVersion: string;
  downloadUrl: string;
  signatureUrl: string;
  digest: string;
}

export interface TaxPackCatalog {
  schemaVersion: 1;
  generatedAt: string;
  packs: TaxPackCatalogEntry[];
}

export interface RemoteTaxPackCatalog {
  releaseTag: string;
  releaseUrl: string;
  catalog: TaxPackCatalog;
}

export interface VerifiedTaxPackArtifact {
  entry: TaxPackCatalogEntry;
  pack: CountryPack;
  packJson: string;
  signature: string;
}

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  assets?: unknown;
}

type FetchLike = typeof fetch;

export function taxPackSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function trustedReleaseDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && !url.username
      && !url.password
      && url.pathname.startsWith(RELEASE_DOWNLOAD_PATH_PREFIX);
  } catch {
    return false;
  }
}

function validCatalogEntry(value: unknown): value is TaxPackCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.id)
    && typeof entry.publisher === 'string' && entry.publisher.length > 0
    && typeof entry.country === 'string' && /^([A-Z]{2}|\*)$/.test(entry.country)
    && typeof entry.jurisdiction === 'string' && entry.jurisdiction.length > 0
    && typeof entry.version === 'string' && /^\d+\.\d+\.\d+$/.test(entry.version)
    && typeof entry.publishedAt === 'string' && Number.isFinite(Date.parse(entry.publishedAt))
    && typeof entry.minFloVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(entry.minFloVersion)
    && typeof entry.digest === 'string' && /^[a-f0-9]{64}$/.test(entry.digest)
    && typeof entry.downloadUrl === 'string' && trustedReleaseDownloadUrl(entry.downloadUrl)
    && typeof entry.signatureUrl === 'string' && trustedReleaseDownloadUrl(entry.signatureUrl);
}

export function parseTaxPackCatalog(value: unknown): TaxPackCatalog {
  if (!value || typeof value !== 'object') throw new Error('Tax pack catalog is not an object');
  const catalog = value as Record<string, unknown>;
  if (catalog.schemaVersion !== 1) throw new Error('Unsupported tax pack catalog schema');
  if (typeof catalog.generatedAt !== 'string' || !Number.isFinite(Date.parse(catalog.generatedAt))) {
    throw new Error('Tax pack catalog generatedAt is invalid');
  }
  if (!Array.isArray(catalog.packs) || !catalog.packs.every(validCatalogEntry)) {
    throw new Error('Tax pack catalog contains an invalid entry');
  }
  const identities = catalog.packs.map((entry) => `${entry.id}@${entry.version}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('Tax pack catalog contains duplicate pack versions');
  }
  return catalog as unknown as TaxPackCatalog;
}

async function fetchText(
  url: string,
  maxBytes: number,
  fetchImpl: FetchLike,
  headers?: Record<string, string>,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': 'FloCafe-Tax-Pack-Manager',
      Accept: 'application/json',
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error('Downloaded artifact exceeds the size limit');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('Downloaded artifact exceeds the size limit');
  return bytes.toString('utf8');
}

export async function fetchRemoteTaxPackCatalog(
  fetchImpl: FetchLike = fetch,
): Promise<RemoteTaxPackCatalog> {
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const releasesJson = await fetchText(
      `${RELEASES_API_URL}?per_page=100&page=${page}`,
      MAX_CATALOG_BYTES,
      fetchImpl,
      { Accept: 'application/vnd.github+json' },
    );
    let releases: GitHubRelease[];
    try {
      releases = JSON.parse(releasesJson) as GitHubRelease[];
    } catch {
      throw new Error('GitHub Releases returned invalid JSON');
    }
    if (!Array.isArray(releases)) throw new Error('GitHub Releases response is invalid');

    for (const release of releases) {
      if (release.draft === true
        || typeof release.tag_name !== 'string'
        || !/^tax-pack-[a-z0-9][a-z0-9-]*-v\d+\.\d+\.\d+$/.test(release.tag_name)
        || !Array.isArray(release.assets)) {
        continue;
      }
      const catalogAsset = (release.assets as GitHubReleaseAsset[]).find(
        (asset) => asset.name === 'catalog.json' && typeof asset.browser_download_url === 'string',
      );
      if (!catalogAsset || typeof catalogAsset.browser_download_url !== 'string'
        || !trustedReleaseDownloadUrl(catalogAsset.browser_download_url)) {
        continue;
      }
      const catalogJson = await fetchText(
        catalogAsset.browser_download_url,
        MAX_CATALOG_BYTES,
        fetchImpl,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(catalogJson);
      } catch {
        throw new Error('Tax pack catalog JSON is invalid');
      }
      return {
        releaseTag: release.tag_name,
        releaseUrl: typeof release.html_url === 'string' ? release.html_url : '',
        catalog: parseTaxPackCatalog(parsed),
      };
    }
    if (releases.length < 100) break;
  }
  throw new Error('No published tax pack catalog is available');
}

function decodeSignature(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('Tax pack signature is not valid base64');
  }
  const signature = Buffer.from(normalized, 'base64');
  if (signature.length !== 64) throw new Error('Tax pack signature has an invalid length');
  return signature;
}

export function verifyTaxPackSignature(
  packJson: string,
  signature: string,
  publicKey: KeyLike = TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY,
): boolean {
  try {
    // Ed25519 selects its signing algorithm from the key, so Node requires a
    // null digest algorithm here rather than a separate hash name.
    return verify(null, Buffer.from(packJson, 'utf8'), publicKey, decodeSignature(signature));
  } catch {
    return false;
  }
}

export async function downloadAndVerifyTaxPack(
  entry: TaxPackCatalogEntry,
  fetchImpl: FetchLike = fetch,
  publicKey: KeyLike = TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY,
): Promise<VerifiedTaxPackArtifact> {
  if (!validCatalogEntry(entry)) throw new Error('Tax pack catalog entry is invalid');
  const [packJson, signature] = await Promise.all([
    fetchText(entry.downloadUrl, MAX_PACK_BYTES, fetchImpl),
    fetchText(entry.signatureUrl, MAX_SIGNATURE_BYTES, fetchImpl, { Accept: 'text/plain' }),
  ]);
  if (taxPackSha256(packJson) !== entry.digest) {
    throw new Error('Tax pack digest does not match the catalog');
  }
  if (!verifyTaxPackSignature(packJson, signature, publicKey)) {
    throw new Error('Tax pack signature verification failed');
  }

  let pack: CountryPack;
  try {
    pack = JSON.parse(packJson) as CountryPack;
  } catch {
    throw new Error('Tax pack JSON is invalid');
  }
  if (pack.id !== entry.id
    || pack.version !== entry.version
    || pack.publisher !== entry.publisher
    || pack.country !== entry.country
    || pack.jurisdiction !== entry.jurisdiction
    || pack.publishedAt !== entry.publishedAt
    || pack.minFloVersion !== entry.minFloVersion) {
    throw new Error('Tax pack identity does not match the signed catalog entry');
  }
  if (pack.publisher === 'local') {
    throw new Error('Local tax packs cannot be installed from the public catalog');
  }
  return {
    entry,
    pack,
    packJson,
    signature: signature.trim(),
  };
}
