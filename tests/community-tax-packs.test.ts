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
import { generateKeyPairSync, sign } from 'node:crypto';
import Decimal from 'decimal.js';

const Module = require('module');
const originalLoad = Module._load;
const floVersion = require('../package.json').version;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-community-tax-packs-'));
const testSigningKeyPair = generateKeyPairSync('ed25519');

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => floVersion } };
  }
  if (
    request.includes('trusted-signing-key') &&
    parent?.filename?.includes(`${path.sep}main${path.sep}`)
  ) {
    return { TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY: testSigningKeyPair.publicKey };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  installAndActivateTestTaxPack,
  api,
  closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const {
  installCatalogEntry,
  validationChecklist,
  LEGACY_TRUSTED_PACK_DIGESTS,
} = require('../main/routes/tax-packs');
const { taxPackSha256 } = require('../main/tax-packs/catalog');
const { validateTaxRegistrationNumber } = require('../main/services/tax');
const { TaxEngine } = require('../main/services/tax-engine');
const flatRatePackData = require('./fixtures/synthetic-flat-rate-pack.json');

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

const PACKS_DIR = path.join(__dirname, '..', 'main', 'tax-packs');

function loadCommunityPacks(): Array<{ file: string; pack: any }> {
  return fs
    .readdirSync(PACKS_DIR)
    .filter((name) => name.startsWith('community-') && name.endsWith('.json'))
    .sort()
    .map((name) => ({
      file: name,
      pack: JSON.parse(fs.readFileSync(path.join(PACKS_DIR, name), 'utf8')),
    }));
}

async function main() {
  console.log('Community Tax Pack Validation');
  console.log('='.repeat(56));

  try {
    initTestDb();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
      process.exit(77);
    }
    throw error;
  }

  const packs = loadCommunityPacks();
  assert.ok(packs.length >= 14, `expected at least 14 community packs, found ${packs.length}`);
  const db = require('../main/db').getDatabase();
  let server: any;

  try {
    for (const { file, pack } of packs) {
      console.log(`\n${file}`);

      assert.equal(pack.schemaVersion, 1, `${file}: schemaVersion must be 1`);
      assert.equal(pack.sourceType, 'community', `${file}: sourceType must be "community"`);
      assert.equal(
        pack.publisher === 'local',
        false,
        `${file}: community packs must not use publisher "local"`,
      );
      assert.ok(
        pack.id.startsWith('community-'),
        `${file}: id should use the community-<country> convention`,
      );
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
          lines: [
            {
              lineId: `sanity-${category.id}`,
              kind: 'product',
              quantity: '1',
              unitPrice: '100',
              productCategoryId: category.id,
              taxBehavior: 'exclusive',
            },
          ],
        });
        const line = result.lines[0];
        const taxAmount = new Decimal(line.taxAmount);
        assert.ok(
          taxAmount.isFinite() && !taxAmount.isNegative(),
          `${file}/${category.id}: tax amount must be finite and non-negative, got ${line.taxAmount}`,
        );
        if (category.ruleIds.length > 0) {
          assert.ok(
            line.components.length > 0,
            `${file}/${category.id}: a category with declared rules must produce at least one component`,
          );
        }
        const expectedTotal = new Decimal(100).plus(taxAmount);
        assert.ok(
          new Decimal(result.totalBeforePayableRounding).eq(expectedTotal),
          `${file}/${category.id}: totalBeforePayableRounding should equal base + tax`,
        );
        const payableTotal = new Decimal(result.payableTotal);
        assert.ok(
          payableTotal.isFinite() && !payableTotal.isNegative(),
          `${file}/${category.id}: payable total must be finite and non-negative`,
        );
      }
      console.log(`  ✓ every category produces a sane, non-negative calculation`);

      if (pack.country === 'SG') {
        assert.ok(
          pack.registrationNumberFormat?.pattern,
          `${file}: registration number format should be declared`,
        );
        const regex = new RegExp(pack.registrationNumberFormat.pattern, 'i');
        assert.equal(
          pack.inclusivePricingDefault,
          true,
          `${file}: Singapore default pricing should include GST`,
        );
        assert.equal(
          pack.registrationNumberLabel,
          'GST Registration No.',
          `${file}: the merchant field should identify the GST registration number`,
        );
        assert.equal(
          pack.effectiveFrom,
          '2024-01-01',
          `${file}: 9% GST should use its 1 January 2024 effective date`,
        );
        assert.ok(regex.test('12345678A'), `${file}: must accept 8-digit business UEN`);
        assert.ok(regex.test('52812345X'), `${file}: must accept 8-digit business UEN`);
        assert.ok(regex.test('123456'), `${file}: must accept 6-digit LLP or branch UEN`);
        assert.ok(regex.test('200812345A'), `${file}: must accept 9-digit company UEN`);
        assert.ok(regex.test('199912345Z'), `${file}: must accept 9-digit company UEN`);
        assert.ok(regex.test('T08LL1234A'), `${file}: must accept LLP UEN`);
        assert.ok(regex.test('S85FC1234B'), `${file}: must accept foreign company UEN`);
        assert.ok(regex.test('T20SS0001D'), `${file}: must accept society UEN`);
        assert.ok(
          regex.test('M21234567K'),
          `${file}: must accept a separate GST registration number`,
        );
        assert.ok(
          regex.test('M2-1234567-K'),
          `${file}: must accept the formatted GST registration number`,
        );
        assert.ok(
          regex.test('MR2345678A'),
          `${file}: must accept the IRAS vendor registration number format`,
        );
        assert.equal(regex.test('1234567A'), false, `${file}: must reject 7-digit UEN`);
        assert.equal(regex.test('1234567890A'), false, `${file}: must reject 10-digit numeric UEN`);
        assert.equal(regex.test('R08LL1234A'), false, `${file}: must reject R prefix`);
        assert.equal(
          regex.test('T08123456A'),
          false,
          `${file}: must reject missing entity type letters`,
        );

        const calculate = (lines: any[]) =>
          TaxEngine.calculate({
            pack,
            country: 'SG',
            jurisdiction: '*',
            businessType: 'restaurant',
            transactionDate: pack.effectiveFrom,
            currency: pack.currency,
            lines,
          });
        const inclusive = calculate([
          {
            lineId: 'sg-inclusive',
            kind: 'product',
            quantity: '1',
            unitPrice: '109',
          },
        ]);
        assert.equal(
          inclusive.lines[0].taxBehavior,
          'inclusive',
          `${file}: country default should be inclusive`,
        );
        assert.equal(
          inclusive.lines[0].taxableBase,
          '100.00',
          `${file}: inclusive GST base should be extracted`,
        );
        assert.equal(inclusive.taxAmount, '9.00', `${file}: 109 inclusive should contain 9 GST`);
        assert.equal(
          inclusive.payableTotal,
          '109',
          `${file}: inclusive total should remain unchanged`,
        );

        const explicitExclusive = calculate([
          {
            lineId: 'sg-exclusive',
            kind: 'product',
            quantity: '1',
            unitPrice: '100',
            taxBehavior: 'exclusive',
          },
        ]);
        assert.equal(
          explicitExclusive.lines[0].taxBehavior,
          'exclusive',
          `${file}: explicit merchant behavior should override the default`,
        );
        assert.equal(
          explicitExclusive.taxAmount,
          '9.00',
          `${file}: explicit exclusive GST should remain available`,
        );
        assert.equal(
          explicitExclusive.payableTotal,
          '109',
          `${file}: exclusive GST should add to the base`,
        );

        const serviceCharge = calculate([
          {
            lineId: 'sg-food',
            kind: 'product',
            quantity: '1',
            unitPrice: '100',
            taxBehavior: 'exclusive',
          },
          {
            lineId: 'sg-service',
            kind: 'service_charge',
            quantity: '1',
            unitPrice: '10',
            taxBehavior: 'exclusive',
          },
        ]);
        assert.equal(
          serviceCharge.taxAmount,
          '9.90',
          `${file}: GST should apply to food plus service charge`,
        );
        assert.equal(
          serviceCharge.payableTotal,
          '119.9',
          `${file}: service-charge example total should be 119.90`,
        );

        const additionalCharges = calculate([
          {
            lineId: 'sg-packaging',
            kind: 'packaging',
            quantity: '1',
            unitPrice: '10',
            taxBehavior: 'exclusive',
          },
          {
            lineId: 'sg-delivery',
            kind: 'delivery',
            quantity: '1',
            unitPrice: '10',
            taxBehavior: 'exclusive',
          },
          {
            lineId: 'sg-addon',
            kind: 'addon',
            quantity: '1',
            unitPrice: '10',
            taxBehavior: 'exclusive',
          },
        ]);
        assert.equal(
          additionalCharges.taxAmount,
          '2.70',
          `${file}: packaging, delivery, and add-ons should use the standard rate`,
        );

        const discounted = calculate([
          {
            lineId: 'sg-discount',
            kind: 'product',
            quantity: '1',
            unitPrice: '10',
            discount: '1',
            taxBehavior: 'exclusive',
          },
        ]);
        assert.equal(
          discounted.taxAmount,
          '0.81',
          `${file}: GST should apply to the discounted base`,
        );
        assert.equal(
          discounted.payableTotal,
          '9.81',
          `${file}: discounted net plus GST should be payable`,
        );

        const documentRounding = calculate([
          {
            lineId: 'sg-round-a',
            kind: 'product',
            quantity: '1',
            unitPrice: '0.05',
            taxBehavior: 'exclusive',
          },
          {
            lineId: 'sg-round-b',
            kind: 'product',
            quantity: '1',
            unitPrice: '0.05',
            taxBehavior: 'exclusive',
          },
        ]);
        assert.equal(
          documentRounding.taxAmount,
          '0.01',
          `${file}: document rounding should round aggregate GST to cents`,
        );

        const exempt = calculate([
          {
            lineId: 'sg-exempt',
            kind: 'product',
            quantity: '1',
            unitPrice: '100',
            taxBehavior: 'exempt',
          },
        ]);
        assert.equal(
          exempt.taxAmount,
          '0.00',
          `${file}: an explicitly exempt line should not receive GST`,
        );
        assert.equal(
          exempt.payableTotal,
          '100',
          `${file}: an explicitly exempt line should preserve its amount`,
        );
        console.log(`  ✓ Singapore GST defaults, registration formats, and calculation cases`);
      }
    }

    console.log('\nSingapore signed installation, owner activation, and stored-data preservation');
    const singapore = packs.find(({ pack }) => pack.country === 'SG')?.pack;
    assert.ok(singapore, 'Singapore community pack is present');
    const owner = seedOwnerUser(db);
    seedCategory(db, 'sg-test-products', 'Singapore Test Products');
    seedProduct(db, 'sg-historical-product', 'sg-test-products', 'Historical Product', 25.5, {
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
    });
    seedProduct(db, 'sg-default-product', 'sg-test-products', 'Default Pricing Product', 109, {
      tax_category_id: 'standard',
      tax_behavior: 'country_default',
    });
    seedProduct(db, 'sg-explicit-product', 'sg-test-products', 'Explicit Pricing Product', 109, {
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
    });
    const setSetting = (key: string, value: string) =>
      db
        .prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
        .run(key, value, new Date().toISOString());
    setSetting('country', 'SG');
    setSetting('currency', 'SGD');
    setSetting('taxes_enabled', 'true');
    installAndActivateTestTaxPack(db, {
      ...flatRatePackData,
      id: 'sg-historical-test-pack',
      country: 'SG',
      currency: 'SGD',
    });

    const app = createApp({});
    registerRoutes(app);
    const started = await startServer(app);
    server = started.server;
    const historicalOrder = await api(started.baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'sg-historical-product', quantity: 1 }] },
      headers: owner.authHeader,
    });
    assert.equal(
      historicalOrder.status,
      201,
      'a historical order is created before Singapore pack installation',
    );
    const historicalOrderId = historicalOrder.data.order.id;
    assert.ok(
      historicalOrder.data.order.tax_snapshot,
      'the prior order has a generated tax snapshot',
    );
    const historicalBill = await api(started.baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: historicalOrderId },
      headers: owner.authHeader,
    });
    assert.equal(
      historicalBill.status,
      201,
      'a historical bill is generated before Singapore pack installation',
    );
    const historicalBillId = historicalBill.data.bill.id;
    assert.ok(
      historicalBill.data.bill.tax_snapshot,
      'the generated bill carries the prior tax snapshot',
    );
    const productsBefore = db
      .prepare(`
      SELECT id, price, tax_category_id, tax_behavior
      FROM products WHERE id IN ('sg-historical-product', 'sg-default-product', 'sg-explicit-product')
      ORDER BY id
    `)
      .all();
    const priorOrderBefore = db
      .prepare(
        'SELECT id, subtotal, tax_amount, tax_breakdown, tax_snapshot, total FROM orders WHERE id = ?',
      )
      .get(historicalOrderId);
    const priorItemsBefore = db
      .prepare(`
      SELECT id, subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount
      FROM order_items WHERE order_id = ? ORDER BY id
    `)
      .all(historicalOrderId);
    const priorBillBefore = db
      .prepare(`
      SELECT id, subtotal, tax_amount, tax_breakdown, tax_snapshot, total, balance
      FROM bills WHERE id = ?
    `)
      .get(historicalBillId);
    const settingsBefore = db
      .prepare(`
      SELECT key, value FROM settings WHERE key IN ('country', 'currency', 'taxes_enabled') ORDER BY key
    `)
      .all();
    const assertStoredDataUnchanged = (stage: string) => {
      assert.deepEqual(
        db
          .prepare(`
        SELECT id, price, tax_category_id, tax_behavior
        FROM products WHERE id IN ('sg-historical-product', 'sg-default-product', 'sg-explicit-product')
        ORDER BY id
      `)
          .all(),
        productsBefore,
        `${stage}: product prices and configured tax behaviors are unchanged`,
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT id, subtotal, tax_amount, tax_breakdown, tax_snapshot, total FROM orders WHERE id = ?',
          )
          .get(historicalOrderId),
        priorOrderBefore,
        `${stage}: prior order tax snapshot is unchanged`,
      );
      assert.deepEqual(
        db
          .prepare(`
        SELECT id, subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount
        FROM order_items WHERE order_id = ? ORDER BY id
      `)
          .all(historicalOrderId),
        priorItemsBefore,
        `${stage}: prior item tax snapshots are unchanged`,
      );
      assert.deepEqual(
        db
          .prepare(`
        SELECT id, subtotal, tax_amount, tax_breakdown, tax_snapshot, total, balance
        FROM bills WHERE id = ?
      `)
          .get(historicalBillId),
        priorBillBefore,
        `${stage}: generated historical bill and tax snapshot are unchanged`,
      );
      assert.deepEqual(
        db
          .prepare(`
        SELECT key, value FROM settings WHERE key IN ('country', 'currency', 'taxes_enabled') ORDER BY key
      `)
          .all(),
        settingsBefore,
        `${stage}: existing country, currency, and tax-enabled settings are unchanged`,
      );
    };

    const artifactJson = fs.readFileSync(path.join(PACKS_DIR, 'community-singapore.json'), 'utf8');
    const releaseTag = `tax-pack-${singapore.id}-v${singapore.version}`;
    const releaseBaseUrl = `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${releaseTag}`;
    const packAssetUrl = `${releaseBaseUrl}/${singapore.id}-v${singapore.version}.json`;
    const signature = sign(
      null,
      Buffer.from(artifactJson, 'utf8'),
      testSigningKeyPair.privateKey,
    ).toString('base64');
    const entry = {
      id: singapore.id,
      publisher: singapore.publisher,
      country: singapore.country,
      jurisdiction: singapore.jurisdiction,
      version: singapore.version,
      publishedAt: singapore.publishedAt,
      minFloVersion: singapore.minFloVersion,
      downloadUrl: packAssetUrl,
      signatureUrl: `${packAssetUrl}.sig`,
      digest: taxPackSha256(artifactJson),
    };
    const fetchImpl = async (input: string | URL | Request) =>
      new Response(String(input) === entry.downloadUrl ? artifactJson : `${signature}\n`, {
        status: 200,
      });
    const installed = await installCatalogEntry(entry, {
      actorUserId: owner.userId,
      fetchImpl,
      publicKey: testSigningKeyPair.publicKey,
    });
    assert.equal(
      installed.validation.valid,
      true,
      'the exact Singapore candidate installs with a test-only signature',
    );
    assertStoredDataUnchanged('after signed installation');

    const activateUrl = `/api/tax-packs/${encodeURIComponent(installed.packId)}/versions/${encodeURIComponent(installed.versionId)}/activate`;
    const gatedActivation = await api(started.baseUrl, activateUrl, {
      method: 'POST',
      headers: owner.authHeader,
    });
    assert.equal(
      gatedActivation.status,
      200,
      'owner activation request without disclaimer acknowledgment is handled',
    );
    assert.equal(
      gatedActivation.data.changed,
      false,
      'community pack remains inactive without acknowledgment',
    );
    assert.equal(
      gatedActivation.data.requires_disclaimer,
      true,
      'community activation requires its disclaimer',
    );
    assertStoredDataUnchanged('after disclaimer-gated activation');

    const activated = await api(started.baseUrl, activateUrl, {
      method: 'POST',
      body: { acknowledge_community_disclaimer: true },
      headers: owner.authHeader,
    });
    assert.equal(
      activated.status,
      200,
      'owner can activate the pack after acknowledging the disclaimer',
    );
    assert.equal(activated.data.changed, true, 'acknowledged Singapore pack becomes active');
    assert.equal(
      validateTaxRegistrationNumber('SG', '123456').valid,
      true,
      'the active Singapore pack accepts a six-digit UEN in tax settings',
    );
    assertStoredDataUnchanged('after acknowledged activation');

    const defaultPricedOrder = await api(started.baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'sg-default-product', quantity: 1 }] },
      headers: owner.authHeader,
    });
    assert.equal(defaultPricedOrder.status, 201, 'country-default Singapore product checks out');
    assert.equal(
      defaultPricedOrder.data.order.tax_amount,
      9,
      'country-default 109 price remains GST-inclusive',
    );
    assert.equal(
      defaultPricedOrder.data.order.total,
      109,
      'country-default inclusive price remains 109',
    );
    const explicitPricedOrder = await api(started.baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'sg-explicit-product', quantity: 1 }] },
      headers: owner.authHeader,
    });
    assert.equal(
      explicitPricedOrder.status,
      201,
      'explicitly exclusive Singapore product checks out',
    );
    assert.equal(
      explicitPricedOrder.data.order.tax_amount,
      9.81,
      'explicit merchant exclusive behavior remains in force',
    );
    assert.equal(
      explicitPricedOrder.data.order.total,
      118.81,
      'explicitly exclusive price adds GST',
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n' + '='.repeat(56));
  console.log(`✅ All ${packs.length} community tax packs validated`);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
