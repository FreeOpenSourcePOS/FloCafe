/**
 * Hybrid service model: ready-made items skip the kitchen, and hybrid venues pay by order type.
 *
 * Covers:
 * - products.requires_kitchen create/update/serialize and validation
 * - order lines snapshot the flag; ready-made lines never wait on the kitchen
 * - KDS orders and items exclude ready-made lines; ready-made-only orders never reach the board
 * - order status derivation and KOT eligibility ignore ready-made lines
 * - later catalog edits do not rewrite existing lines
 * - service_model 'hybrid' settings validation and per-order-type billing
 *
 * Usage: node tests/run-electron-node-test.cjs tests/hybrid-service-model.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-hybrid-service-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      powerMonitor: { on: () => {} },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-hybrid-service-model';
process.env.KDS_PORT = '0';

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { stopKdsServer } = require('../main/kds-server');
const { stopScheduledOrderSweep } = require('../main/services/scheduled-orders');
const { orderHasKitchenWorkSql } = require('../main/db');
const { isOrderPrepaid } = require('../main/services/service-model');
const { deriveOrderStatusFromItems } = require('../shared/order-item-status');
const { isKotItemPending } = require('../shared/print/document');

function setStoreSetting(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

async function main() {
  console.log('='.repeat(66));
  console.log('Hybrid service model: ready-made items and per-order-type billing');
  console.log('='.repeat(66));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  setStoreSetting(db, 'country', 'US');
  setStoreSetting(db, 'currency', 'USD');
  setStoreSetting(db, 'timezone', 'America/New_York');
  setStoreSetting(db, 'kds_enabled', 'true');
  seedCategory(db, 'cat-hy', 'Hybrid Menu');
  seedTable(db, 'tbl-hy-1', 1, 4);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function req(options: { path: string; method?: string; body?: any }) {
    const { path: urlPath, ...rest } = options;
    const res = await api(baseUrl, urlPath, { ...rest, headers: owner.authHeader });
    return { status: res.status, body: res.data };
  }

  function itemsOf(orderId: string | number) {
    return db
      .prepare('SELECT product_id, status, requires_kitchen FROM order_items WHERE order_id = ?')
      .all(orderId) as Array<{ product_id: string; status: string; requires_kitchen: number }>;
  }

  try {
    console.log('\n--- 1. Catalog flag ---');
    const dish = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Grilled Fish', price: 18, category_id: 'cat-hy' },
    });
    assertEqualOrThrow(dish.status, 201, 'kitchen dish is created');
    assertEqualOrThrow(dish.body.product?.requires_kitchen, true, 'new products go to the kitchen');

    const cola = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Bottled Cola', price: 3, category_id: 'cat-hy', requires_kitchen: false },
    });
    assertEqualOrThrow(cola.status, 201, 'ready-made item is created');
    assertEqualOrThrow(cola.body.product?.requires_kitchen, false, 'ready-made flag is stored');
    const dishId = dish.body.product.id;
    const colaId = cola.body.product.id;

    const badFlag = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Bad Flag', price: 1, category_id: 'cat-hy', requires_kitchen: 'no' },
    });
    assertEqualOrThrow(badFlag.status, 400, 'non-boolean requires_kitchen is rejected');

    const listed = await req({ path: '/api/products', method: 'GET' });
    const listedCola = (listed.body.products ?? listed.body.data ?? listed.body).find?.(
      (p: any) => p.id === colaId,
    );
    assertEqualOrThrow(listedCola?.requires_kitchen, false, 'catalog list exposes the flag');

    console.log('\n--- 2. Orders snapshot the flag ---');
    const readyOnly = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: colaId, quantity: 2 }] },
    });
    assertEqualOrThrow(readyOnly.status, 201, 'ready-made-only order is created');
    const readyOnlyId = readyOnly.body.order.id;
    assertEqualOrThrow(
      JSON.stringify(itemsOf(readyOnlyId).map((i) => [i.status, i.requires_kitchen])),
      JSON.stringify([['served', 0]]),
      'ready-made line is served and not a kitchen line',
    );

    const kitchenOnly = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: dishId, quantity: 1 }] },
    });
    const kitchenOnlyId = kitchenOnly.body.order.id;
    assertEqualOrThrow(
      JSON.stringify(itemsOf(kitchenOnlyId).map((i) => [i.status, i.requires_kitchen])),
      JSON.stringify([['pending', 1]]),
      'kitchen line stays pending',
    );

    const mixed = await req({
      path: '/api/orders',
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: dishId, quantity: 1 },
          { product_id: colaId, quantity: 1 },
        ],
      },
    });
    const mixedId = mixed.body.order.id;
    assertEqualOrThrow(itemsOf(mixedId).length, 2, 'mixed order keeps both lines');

    console.log('\n--- 3. KDS excludes ready-made work ---');
    const kds = await req({ path: '/api/kds/orders', method: 'GET' });
    assertEqualOrThrow(kds.status, 200, 'KDS orders load');
    const kdsById = new Map<string, any>(kds.body.orders.map((o: any) => [String(o.id), o]));
    assertOrThrow(!kdsById.has(String(readyOnlyId)), 'ready-made-only order is not on the KDS');
    assertOrThrow(kdsById.has(String(kitchenOnlyId)), 'kitchen-only order is on the KDS');
    const mixedOnKds = kdsById.get(String(mixedId));
    assertOrThrow(!!mixedOnKds, 'mixed order is on the KDS');
    assertEqualOrThrow(
      JSON.stringify((mixedOnKds?.items ?? []).map((i: any) => i.product_id)),
      JSON.stringify([dishId]),
      'only the kitchen line is shown for a mixed order',
    );

    const kitchenSqlRows = db
      .prepare(`SELECT id FROM orders o WHERE ${orderHasKitchenWorkSql('o')}`)
      .all()
      .map((row: any) => String(row.id));
    assertOrThrow(
      !kitchenSqlRows.includes(String(readyOnlyId)),
      'kitchen-work filter drops the ready-made-only order',
    );
    assertOrThrow(
      kitchenSqlRows.includes(String(mixedId)) && kitchenSqlRows.includes(String(kitchenOnlyId)),
      'kitchen-work filter keeps orders with a kitchen line',
    );

    console.log('\n--- 4. Status derivation and KOT eligibility ---');
    assertEqualOrThrow(
      deriveOrderStatusFromItems(itemsOf(readyOnlyId)),
      null,
      'ready-made-only order derives no kitchen status',
    );
    assertEqualOrThrow(
      deriveOrderStatusFromItems(itemsOf(mixedId).map((i) => ({ ...i, quantity: 1 }))),
      'pending',
      'a served ready-made line does not start a mixed order',
    );
    assertEqualOrThrow(
      deriveOrderStatusFromItems([{ status: 'ready', quantity: 1 }]),
      'ready',
      'legacy rows without the flag still derive normally',
    );
    assertOrThrow(
      itemsOf(readyOnlyId).every((i) => !isKotItemPending(i.status)),
      'ready-made lines are never pending for a kitchen ticket',
    );
    assertOrThrow(
      itemsOf(kitchenOnlyId).every((i) => isKotItemPending(i.status)),
      'kitchen lines still print on the kitchen ticket',
    );

    console.log('\n--- 5. Catalog edits do not rewrite history ---');
    const flip = await req({
      path: `/api/products/${colaId}`,
      method: 'PUT',
      body: { requires_kitchen: true },
    });
    assertEqualOrThrow(flip.status, 200, 'flag can be flipped');
    assertEqualOrThrow(flip.body.product?.requires_kitchen, true, 'updated flag is returned');
    assertEqualOrThrow(
      itemsOf(readyOnlyId)[0].requires_kitchen,
      0,
      'an existing line keeps the flag it was sold with',
    );
    const afterFlip = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: colaId, quantity: 1 }] },
    });
    assertEqualOrThrow(
      itemsOf(afterFlip.body.order.id)[0].status,
      'pending',
      'new lines follow the current flag',
    );

    console.log('\n--- 6. Hybrid billing and settings ---');
    const badModel = await req({
      path: '/api/settings/business',
      method: 'PUT',
      body: { service_model: 'banquet' },
    });
    assertEqualOrThrow(badModel.status, 400, 'unknown service model is rejected');

    setStoreSetting(db, 'billing_type', 'postpaid');
    setStoreSetting(db, 'service_model', 'finedine');
    assertEqualOrThrow(isOrderPrepaid(db, 'takeaway'), false, 'postpaid venue stays postpaid');
    setStoreSetting(db, 'billing_type', 'prepaid');
    setStoreSetting(db, 'service_model', 'qsr');
    assertEqualOrThrow(isOrderPrepaid(db, 'dine_in'), true, 'prepaid venue stays prepaid');

    setStoreSetting(db, 'tables_required', 'false');
    const hybrid = await req({
      path: '/api/settings/business',
      method: 'PUT',
      body: { service_model: 'hybrid' },
    });
    assertEqualOrThrow(hybrid.status, 200, 'hybrid can be enabled');
    assertEqualOrThrow(hybrid.body.service_model, 'hybrid', 'service model is reported');
    assertEqualOrThrow(hybrid.body.tables_required, true, 'hybrid keeps tables for dine-in');
    assertEqualOrThrow(isOrderPrepaid(db, 'takeaway'), true, 'hybrid counter orders are prepaid');
    assertEqualOrThrow(isOrderPrepaid(db, 'delivery'), true, 'hybrid delivery orders are prepaid');
    assertEqualOrThrow(isOrderPrepaid(db, 'dine_in'), false, 'hybrid table orders are postpaid');

    const results = getResults();
    console.log('\n' + '='.repeat(66));
    console.log(`Hybrid service model results: Passed ${results.passed}/${results.total}`);
    assertEqualOrThrow(results.failed, 0, 'zero failed assertions');
  } finally {
    stopScheduledOrderSweep();
    await stopKdsServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Hybrid service model test failed:', err);
  process.exit(1);
});
