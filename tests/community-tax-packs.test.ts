/**
 * Validates every community-sourced tax pack (main/tax-packs/community-*.json)
 * against the same activation checklist and tax engine real packs go through,
 * so a malformed or miscalculating pack fails CI instead of shipping.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/community-tax-packs.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Decimal from 'decimal.js';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-community-tax-packs-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '2.4.0' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, closeDatabase } = require('../main/db');
const { validationChecklist, LEGACY_TRUSTED_PACK_DIGESTS } = require('../main/routes/tax-packs');
const { taxPackSha256 } = require('../main/tax-packs/catalog');
const { TaxEngine } = require('../main/services/tax-engine');

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

const PACKS_DIR = path.join(__dirname, '..', 'main', 'tax-packs');

function loadCommunityPacks(): Array<{ file: string; pack: any }> {
  return fs.readdirSync(PACKS_DIR)
    .filter((name) => name.startsWith('community-') && name.endsWith('.json'))
    .sort()
    .map((name) => ({ file: name, pack: JSON.parse(fs.readFileSync(path.join(PACKS_DIR, name), 'utf8')) }));
}

function main() {
  console.log('Community Tax Pack Validation');
  console.log('='.repeat(56));

  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
      process.exit(77);
    }
    throw error;
  }

  const packs = loadCommunityPacks();
  assert.ok(packs.length >= 13, `expected at least 13 community packs, found ${packs.length}`);

  try {
    for (const { file, pack } of packs) {
      console.log(`\n${file}`);

      assert.equal(pack.schemaVersion, 1, `${file}: schemaVersion must be 1`);
      assert.equal(pack.sourceType, 'community', `${file}: sourceType must be "community"`);
      assert.equal(pack.publisher === 'local', false, `${file}: community packs must not use publisher "local"`);
      assert.ok(pack.id.startsWith('community-'), `${file}: id should use the community-<country> convention`);
      assert.match(pack.country, /^[A-Z]{2}$/, `${file}: country must be a 2-letter ISO code`);

      const packJson = JSON.stringify(pack);
      const digest = taxPackSha256(packJson);
      LEGACY_TRUSTED_PACK_DIGESTS[pack.id] = digest;
      const version = {
        id: `${pack.id}@${pack.version}`,
        pack_id: pack.id,
        version: pack.version,
        schema_version: pack.schemaVersion,
        manifest_json: '{}',
        pack_json: packJson,
        digest,
        signature: null,
        effective_from: pack.effectiveFrom,
        effective_to: pack.effectiveTo || null,
        min_flo_version: pack.minFloVersion,
        published_at: pack.publishedAt,
        status: 'installed',
        created_at: new Date().toISOString(),
      };

      const validation = validationChecklist(version);
      if (!validation.valid) {
        const failed = validation.checks.filter((check: any) => !check.passed);
        console.error(`  ✗ ${file} failed activation validation:`, failed);
      }
      assert.equal(validation.valid, true, `${file}: must pass activation validation`);
      console.log(`  ✓ passes all ${validation.checks.length} activation checks`);

      for (const category of pack.categories) {
        const result = TaxEngine.calculate({
          pack,
          country: pack.country,
          jurisdiction: pack.jurisdiction,
          businessType: 'restaurant',
          transactionDate: pack.effectiveFrom,
          lines: [{
            lineId: `sanity-${category.id}`,
            kind: 'product',
            quantity: '1',
            unitPrice: '100',
            productCategoryId: category.id,
            taxBehavior: 'exclusive',
          }],
        });
        const line = result.lines[0];
        const taxAmount = new Decimal(line.taxAmount);
        assert.ok(taxAmount.isFinite() && !taxAmount.isNegative(),
          `${file}/${category.id}: tax amount must be finite and non-negative, got ${line.taxAmount}`);
        if (category.ruleIds.length > 0) {
          assert.ok(line.components.length > 0,
            `${file}/${category.id}: a category with declared rules must produce at least one component`);
        }
        const expectedTotal = new Decimal(100).plus(taxAmount);
        assert.ok(new Decimal(result.totalBeforePayableRounding).eq(expectedTotal),
          `${file}/${category.id}: totalBeforePayableRounding should equal base + tax`);
        const payableTotal = new Decimal(result.payableTotal);
        assert.ok(payableTotal.isFinite() && !payableTotal.isNegative(),
          `${file}/${category.id}: payable total must be finite and non-negative`);
      }
      console.log(`  ✓ every category produces a sane, non-negative calculation`);
    }
  } finally {
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + '='.repeat(56));
  console.log(`✅ All ${packs.length} community tax packs validated`);
}

main();
