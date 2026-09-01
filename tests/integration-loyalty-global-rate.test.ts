/**
 * Integration Test: Loyalty Global Earning Rate
 *
 * Scenarios:
 * 1. Product with cb_percent=null inherits global_cashback_percent
 * 2. Product with cb_percent=0 earns nothing (explicit override)
 * 3. Product with cb_percent>0 earns its custom rate
 * 4. Update global rate and test inheritance dynamically
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-loyalty-global-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedCustomer,
  api, assert, assertEqual,
  getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { customerRoutes } = require('../main/routes/customers');
const { settingsRoutes } = require('../main/routes/settings');
const { menuCsvRoutes } = require('../main/routes/menu-csv');
const { productRoutes } = require('../main/routes/products');
const { MIGRATIONS } = require('../main/db');

async function main() {
  console.log('Integration Test: Loyalty Global Earning Rate');
  console.log('='.repeat(50));

  const db = initTestDb();

  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('global_cashback_percent', '5', ?)").run(now());

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-global', 'Global Rate Menu');

  // Product A: cb_percent=null (inherits global 5%)
  seedProduct(db, 'prod-null', 'cat-global', 'Coffee', 100, { cb_percent: null });

  // Product B: cb_percent=0 (explicit no earning)
  seedProduct(db, 'prod-zero', 'cat-global', 'Water', 50, { cb_percent: 0 });

  // Product C: cb_percent=15 (custom override)
  seedProduct(db, 'prod-custom', 'cat-global', 'Sandwich', 200, { cb_percent: 15 });

  seedCustomer(db, 'cust-1', 'Global Test Customer', '1111111111');
  seedCustomer(db, 'cust-2', 'Discount Customer', '2222222222');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/customers': customerRoutes,
    '/api/settings': settingsRoutes,
    '/api/menu/csv': menuCsvRoutes,
    '/api/products': productRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Scenario 1: Mixed cart inherits global rate (5%), respects 0% and 15%
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 1: Mixed cart (null=global, 0=none, custom) ───');

    const order1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-1',
        items: [
          { product_id: 'prod-null', quantity: 2 },   // 2×100 = 200 @ 5% global = 10
          { product_id: 'prod-zero', quantity: 1 },   // 1×50 = 50 @ 0% = 0
          { product_id: 'prod-custom', quantity: 1 }, // 1×200 = 200 @ 15% custom = 30
        ], // Total cashback = 40 points (1 point = 1 currency unit)
      },
      headers: authHeader,
    });
    assertEqual(order1.status, 201, 'order 1 created');

    const bill1 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order1.data.order.id },
      headers: authHeader,
    });

    const pay1 = await api(baseUrl, `/api/bills/${bill1.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: bill1.data.bill.total, customer_id: 'cust-1' },
      headers: authHeader,
    });
    assertEqual(pay1.status, 200, 'payment accepted');
    assertEqual(pay1.data.loyaltyPointsEarned, 40, 'earned 40 points');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 2: Change global rate to 10%
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 2: Update global rate and test inheritance ───');

    const updateRes = await api(baseUrl, '/api/settings/loyalty', {
      method: 'PUT',
      body: { loyalty_enabled: true, global_cashback_percent: 2.5 },
      headers: authHeader,
    });
    assertEqual(updateRes.status, 200, 'updated global cashback percent to fractional value 2.5');
    assertEqual(updateRes.data.global_cashback_percent, 2.5, 'API returns fractional rate 2.5');

    const order2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-2',
        items: [
          { product_id: 'prod-null', quantity: 2 },   // 2×100 = 200 @ 2.5% global = 5
        ], // Total cashback = 5 points (1 point = 1 currency unit)
      },
      headers: authHeader,
    });

    const bill2 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order2.data.order.id },
      headers: authHeader,
    });

    const pay2 = await api(baseUrl, `/api/bills/${bill2.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: bill2.data.bill.total, customer_id: 'cust-2' },
      headers: authHeader,
    });
    assertEqual(pay2.status, 200, 'payment accepted');
    assertEqual(pay2.data.loyaltyPointsEarned, 5, 'earned 5 points after fractional global rate update (2.5%)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 3: Negative validation tests
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 3: Negative validation tests ───');

    // Settings API
    const badSetting1 = await api(baseUrl, '/api/settings/loyalty', {
      method: 'PUT',
      body: { loyalty_enabled: true, global_cashback_percent: null },
      headers: authHeader,
    });
    assertEqual(badSetting1.status, 400, 'settings API rejects null global rate');

    const badSetting2 = await api(baseUrl, '/api/settings/loyalty', {
      method: 'PUT',
      body: { loyalty_enabled: true, global_cashback_percent: true },
      headers: authHeader,
    });
    assertEqual(badSetting2.status, 400, 'settings API rejects boolean global rate');

    const badSetting3 = await api(baseUrl, '/api/settings/loyalty', {
      method: 'PUT',
      body: { loyalty_enabled: true, global_cashback_percent: -5 },
      headers: authHeader,
    });
    assertEqual(badSetting3.status, 400, 'settings API rejects negative global rate');

    // Product API
    const badProduct = await api(baseUrl, '/api/products', {
      method: 'POST',
      body: {
        name: 'Bad Product',
        price: 100,
        cb_percent: '10' // String instead of number
      },
      headers: authHeader,
    });
    assertEqual(badProduct.status, 400, 'products API rejects string cb_percent');

    const badProduct2 = await api(baseUrl, '/api/products', {
      method: 'POST',
      body: {
        name: 'Bad Product',
        price: 100,
        cb_percent: 150 // > 100
      },
      headers: authHeader,
    });
    assertEqual(badProduct2.status, 400, 'products API rejects >100 cb_percent');

    // CSV API
    const badCsv1 = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: 'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active\n' +
             ',,Bad Product,Global Rate Menu,100,Desc,50,,,10abc,veg,yes'
      },
      headers: authHeader,
    });
    assertEqual(badCsv1.status, 200, 'csv API processes request');
    assert(badCsv1.data.errors.some((e: string) => e.includes('invalid cashback_percent "10abc"')), 'csv rejects 10abc string');

    const badCsv2 = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: 'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active\n' +
             ',,Bad Product,Global Rate Menu,100,Desc,50,,,-5,veg,yes'
      },
      headers: authHeader,
    });
    assertEqual(badCsv2.status, 200, 'csv API processes negative-rate row');
    assert(badCsv2.data.errors.some((e: string) => e.includes('invalid cashback_percent "-5"')), 'csv rejects negative cashback percent');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 4: the migration must NOT rewrite legacy cb_percent = 0
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 4: Legacy migration test ───');

    // Simulate a legacy product inserted before this migration, with cb_percent = 0
    db.prepare("INSERT INTO products (id, name, price, cb_percent, is_active, created_at, updated_at) VALUES ('prod-legacy', 'Legacy Product', 100, 0, 1, ?, ?)").run(now(), now());

    // Execute the actual add_global_cashback_percent migration's up() handler exported
    // from main/db.ts — looked up by name, not a hardcoded version number, since the
    // version this shipped as can shift if it's renumbered past another migration.
    const cbMigration = MIGRATIONS.find((m: any) => m.name === 'add_global_cashback_percent');
    assert(cbMigration !== undefined, 'add_global_cashback_percent migration registered in db.ts');
    cbMigration.up();

    // 0 means "earns nothing" and NULL means "inherit the global rate". The old
    // schema default was 0, so rewriting it here would silently opt every
    // excluded product back into earning the moment an owner sets a global
    // rate. The migration leaves the data alone; the owner opts in explicitly.
    const legacyProd = db.prepare("SELECT cb_percent FROM products WHERE id = 'prod-legacy'").get() as any;
    assertEqual(legacyProd.cb_percent, 0, 'migration preserves an existing cb_percent = 0 instead of rewriting it to NULL');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 5: the explicit bulk opt-in is what moves 0 → NULL
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 5: bulk apply global rate ───');

    const candidates = await api(baseUrl, '/api/products/loyalty/global-rate-candidates', {
      method: 'GET',
      headers: authHeader,
    });
    assertEqual(candidates.status, 200, 'candidate count endpoint responds');
    assert(candidates.data.count >= 1, 'legacy zero-rate product is counted as a candidate');

    const applied = await api(baseUrl, '/api/products/loyalty/apply-global-rate', {
      method: 'POST',
      body: {},
      headers: authHeader,
    });
    assertEqual(applied.status, 200, 'bulk apply endpoint responds');
    assert(applied.data.updated >= 1, 'bulk apply reports the rows it changed');

    const afterApply = db.prepare("SELECT cb_percent FROM products WHERE id = 'prod-legacy'").get() as any;
    assertEqual(afterApply.cb_percent, null, 'bulk apply switches a zero-rate product to inherit the global rate');

    const afterCount = await api(baseUrl, '/api/products/loyalty/global-rate-candidates', {
      method: 'GET',
      headers: authHeader,
    });
    assertEqual(afterCount.data.count, 0, 'no candidates remain after the bulk apply');

  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: any) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
