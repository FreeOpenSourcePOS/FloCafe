/**
 * Real historical legacy tax-pack digest test (issue #220 item #9).
 *
 * main/routes/tax-packs.ts's LEGACY_TRUSTED_PACK_DIGESTS keeps only the
 * SHA-256 digest of the exact unsigned India/Thailand pack JSON that used to
 * ship bundled in main/tax-packs/in.json and th.json, removed in commit
 * a51e828 ("remove bundled India/Thailand tax data, use digest-based legacy
 * trust") once those digests were extracted. Every other test that exercises
 * that legacy-trust path (tests/tax-pack-management.test.ts) uses a
 * synthetic stand-in pack with its digest injected into the map at runtime —
 * useful for covering the *mechanism*, but it never actually proves the
 * real, shipped `official-india`/`official-thailand` digests documented in
 * that constant still validate against the real bytes they were computed
 * from.
 *
 * tests/fixtures/legacy-tax-packs/official-{india,thailand}.json are that
 * real content, recovered from git history (`git show a51e828~1:main/
 * tax-packs/in.json`), and are what this test validates against — the
 * actual byte-level compatibility boundary a real pre-signing-era customer
 * database still depends on.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/legacy-tax-pack-digest.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-legacy-digest-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '2.9.5' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { LEGACY_TRUSTED_PACK_DIGESTS, validationChecklist } = require('../main/routes/tax-packs');
const { taxPackSha256 } = require('../main/tax-packs/catalog');

const realIndiaPack = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-tax-packs/official-india.json'), 'utf8'));
const realThailandPack = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-tax-packs/official-thailand.json'), 'utf8'));

function main() {
  console.log('Legacy Tax Pack Digest Tests (real historical artifacts)');
  console.log('='.repeat(56));

  initTestDb();

  try {
    console.log('\n1. Real fixture content hashes to the exact shipped LEGACY_TRUSTED_PACK_DIGESTS values');
    assertEqual(realIndiaPack.id, 'official-india', 'India fixture carries its real pre-rename id');
    assertEqual(realThailandPack.id, 'official-thailand', 'Thailand fixture carries its real pre-rename id');
    assertEqual(
      taxPackSha256(JSON.stringify(realIndiaPack)),
      LEGACY_TRUSTED_PACK_DIGESTS['official-india'],
      'the real official-india artifact hashes to the exact digest documented in LEGACY_TRUSTED_PACK_DIGESTS',
    );
    assertEqual(
      taxPackSha256(JSON.stringify(realThailandPack)),
      LEGACY_TRUSTED_PACK_DIGESTS['official-thailand'],
      'the real official-thailand artifact hashes to the exact digest documented in LEGACY_TRUSTED_PACK_DIGESTS',
    );

    console.log('\n2. validationChecklist trusts the real, exact historical artifacts without a signature');
    for (const pack of [realIndiaPack, realThailandPack]) {
      const packJson = JSON.stringify(pack);
      const version = {
        id: `${pack.id}@${pack.version}`,
        pack_id: pack.id,
        version: pack.version,
        schema_version: 1,
        manifest_json: JSON.stringify({
          id: pack.id, publisher: pack.publisher, country: pack.country, jurisdiction: pack.jurisdiction,
          version: pack.version, publishedAt: pack.publishedAt,
        }),
        pack_json: packJson,
        digest: taxPackSha256(packJson),
        signature: null,
        effective_from: pack.effectiveFrom,
        effective_to: null,
        min_flo_version: pack.minFloVersion,
        published_at: pack.publishedAt,
        status: 'installed',
        created_at: new Date().toISOString(),
      };
      const validation = validationChecklist(version);
      const failedChecks = validation.checks.filter((check: any) => !check.passed).map((check: any) => check.id);
      assertEqual(failedChecks.join(','), '', `${pack.id} (real artifact) passes all 25 activation checks unsigned`);
      assertEqual(validation.valid, true, `${pack.id} (real artifact) is trusted end-to-end`);
    }

    console.log('\n3. A single byte of drift from the real artifact breaks legacy trust');
    const tamperedJson = JSON.stringify({ ...realIndiaPack, currency: 'USD' });
    const tamperedValidation = validationChecklist({
      id: `${realIndiaPack.id}@${realIndiaPack.version}`,
      pack_id: realIndiaPack.id,
      version: realIndiaPack.version,
      schema_version: 1,
      manifest_json: '{}',
      pack_json: tamperedJson,
      digest: taxPackSha256(tamperedJson),
      signature: null,
      effective_from: realIndiaPack.effectiveFrom,
      effective_to: null,
      min_flo_version: realIndiaPack.minFloVersion,
      published_at: realIndiaPack.publishedAt,
      status: 'installed',
      created_at: new Date().toISOString(),
    });
    assertEqual(
      tamperedValidation.checks.find((check: any) => check.id === 6)?.passed,
      false,
      'a tampered copy of the real official-india artifact is rejected — legacy trust is exact-bytes-only',
    );
  } finally {
    closeDatabase();
  }

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main();
