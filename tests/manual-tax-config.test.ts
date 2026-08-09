/**
 * Integration tests for the manual tax builder endpoint (POST
 * /api/tax-packs/manual-config) — issue #220 follow-ups #1 and #7.
 *
 * Covers the bug fixed here: renaming/removing a category in the manual
 * builder previously only remapped products.tax_category_id and
 * addons.tax_category_id to the new default. Every tax_overrides row
 * (product/addon-specific overrides, and store-wide packaging/delivery/
 * service_charge overrides) kept pointing at the removed category id,
 * which made checkout throw "resolved unknown tax category" on any line
 * still covered by one of those overrides (resolveTaxCategory /
 * calculateRawLine in main/services/tax-engine.ts).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/manual-tax-config.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-manual-tax-config-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '2.9.5' } };
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
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');

async function main() {
  console.log('Manual Tax Configuration Integration Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'manual-tax-products', 'Manual Tax Products');
  const product = seedProduct(db, 'manual-tax-product', 'manual-tax-products', 'Manual Tax Product', 100, {
    tax_type: 'none',
    tax_category_id: null,
  });
  db.prepare(`INSERT INTO addon_groups (id, name) VALUES ('manual-tax-addon-group', 'Extras')`).run();
  db.prepare(`
    INSERT INTO addons (id, addon_group_id, name, price, tax_category_id)
    VALUES ('manual-tax-addon', 'manual-tax-addon-group', 'Extra Cheese', 20, NULL)
  `).run();

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. Owner creates a two-category manual config ("Standard" + "Reduced")');
    const createRes = await api(baseUrl, '/api/tax-packs/manual-config', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        inclusive: true,
        categories: [
          { tempId: 'standard', label: 'Standard', components: [{ label: 'Tax 1', type: 'percent', value: '5' }] },
          { tempId: 'reduced', label: 'Reduced', components: [{ label: 'Tax 1', type: 'percent', value: '2' }] },
        ],
        defaultProductCategoryTempId: 'standard',
        packagingCategoryTempId: 'standard',
        deliveryCategoryTempId: 'standard',
        serviceChargeCategoryTempId: 'standard',
      },
    });
    assertEqual(createRes.status, 200, 'owner can save an initial manual config');
    const packId = createRes.data.pack_id;

    console.log('\n2. Owner points every override type at the "Reduced" category');
    const overrideTargets = [
      { entity_type: 'product', entity_id: 'manual-tax-product' },
      { entity_type: 'addon', entity_id: 'manual-tax-addon' },
      { entity_type: 'packaging', entity_id: null },
      { entity_type: 'delivery', entity_id: null },
      { entity_type: 'service_charge', entity_id: null },
    ];
    for (const target of overrideTargets) {
      const res = await api(baseUrl, '/api/tax-packs/overrides', {
        method: 'POST',
        headers: owner.authHeader,
        body: { ...target, category_id: 'reduced' },
      });
      assertEqual(res.status, 201, `override created for ${target.entity_type}`);
    }
    assertEqual(
      db.prepare(`SELECT COUNT(*) AS c FROM tax_overrides`).get().c, 5,
      'five overrides exist before the category rename',
    );

    console.log('\n3. Owner removes "Reduced" from the manual config (resubmits with only "Standard")');
    const updateRes = await api(baseUrl, '/api/tax-packs/manual-config', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        override: true,
        inclusive: true,
        categories: [
          { tempId: 'standard', label: 'Standard', components: [{ label: 'Tax 1', type: 'percent', value: '5' }] },
        ],
        defaultProductCategoryTempId: 'standard',
        packagingCategoryTempId: 'standard',
        deliveryCategoryTempId: 'standard',
        serviceChargeCategoryTempId: 'standard',
      },
    });
    assertEqual(updateRes.status, 200, 'owner can remove a category by resubmitting without it');
    const remappedEntities = updateRes.data.remapped.map((entry: any) => entry.entity).sort();
    assertEqual(
      remappedEntities.join(','),
      ['addon_override', 'delivery_override', 'packaging_override', 'product_override', 'service_charge_override'].join(','),
      'the response reports all five override types as remapped (product/addon base columns were never set to "reduced", so they are correctly absent)',
    );
    console.log('   ✓ save response reports every override entity type as remapped');

    console.log('\n4. Every override in the database now points at a category that still exists');
    const survivingCategoryIds = new Set(
      (db.prepare(`
        SELECT category.category_id FROM tax_categories AS category
        JOIN country_packs AS pack ON pack.active_version_id = category.pack_version_id
        WHERE pack.id = ?
      `).all(packId) as Array<{ category_id: string }>).map((row) => row.category_id),
    );
    const overrideRows = db.prepare(`SELECT entity_type, value_json FROM tax_overrides`).all() as Array<{ entity_type: string; value_json: string }>;
    assertEqual(overrideRows.length, 5, 'all five overrides still exist (remapped, not deleted)');
    for (const row of overrideRows) {
      const categoryId = JSON.parse(row.value_json).categoryId;
      assert(
        survivingCategoryIds.has(categoryId),
        `${row.entity_type} override now points at a category that exists (got "${categoryId}")`,
      );
      assertEqual(categoryId, 'standard', `${row.entity_type} override was remapped to the new default category`);
    }
    console.log('   ✓ every override entity type (product, addon, packaging, delivery, service_charge) was remapped, none left dangling');

    console.log('\n5. Checkout-path tax calculation no longer throws for the remapped product override');
    const { calculateItemTax } = require('../main/services/tax');
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'taxes_enabled'").run();
    const tenant = {
      taxes_enabled: true,
      country: db.prepare("SELECT value FROM settings WHERE key = 'country'").get().value,
      business_type: db.prepare("SELECT value FROM settings WHERE key = 'business_type'").get()?.value || 'restaurant',
      state_code: '',
    };
    const result = calculateItemTax(tenant, { id: 'manual-tax-product', tax_category_id: null, tax_category: null }, 100, null);
    assertEqual(result.tax_type, 'inclusive', 'the previously-dangling product override resolves and calculates tax without throwing');
    assert(result.tax_amount > 0, 'a nonzero tax amount is computed against the remapped category');
    console.log('   ✓ calculateItemTax succeeds against the remapped override instead of throwing "resolved unknown tax category"');
  } finally {
    server.close();
    closeDatabase();
  }

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
