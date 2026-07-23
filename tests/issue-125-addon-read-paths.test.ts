/**
 * Integration Test: Issue #125 — order_item_addons is the sole source of
 * truth for selected addons
 *
 * order_items.addons (the old JSON column) has been fully removed —
 * migration v30 backfills any remaining legacy rows and drops the column
 * (see tests/order-item-addons.test.ts Test 4, and the migration itself in
 * main/db.ts). This covers every read path that resolves addons via
 * attachEffectiveAddons(), across every route file that touches order
 * items: orders.ts (list/detail), kds.ts, kitchen.ts, order-items.ts — plus
 * the item-discount route, which used to parse the JSON column directly to
 * fold addon prices into the discount base.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-125-addon-read-paths.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-125-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-125';

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { kdsRoutes } = require('../main/routes/kds');
const { kitchenRoutes } = require('../main/routes/kitchen');
const { orderItemRoutes } = require('../main/routes/order-items');
const { attachEffectiveAddons } = require('../main/db');

async function main() {
  console.log('Integration Test: Issue #125 — order_item_addons is the sole source of truth');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-125', 'Food');
  seedProduct(db, 'prod-125', 'cat-125', 'Tea', 50);
  db.prepare(`INSERT INTO addon_groups (id, name) VALUES ('ag-125', 'Extras')`).run();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-125-sugar', 'ag-125', 'Extra Sugar', 5, 1)`).run();

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/kds': kdsRoutes,
    '/api/kitchen': kitchenRoutes,
    '/api/order-items': orderItemRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    let orderId: number;
    let itemId: number;
    let bareOrderId: number;
    let bareItemId: number;

    console.log('\n─── Setup: create an order with an addon, and one without ───');
    {
      const res = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'takeaway', items: [{ product_id: 'prod-125', quantity: 1, addons: [{ id: 'addon-125-sugar', name: 'Extra Sugar', price: 5 }] }] },
        headers: authHeader,
      });
      assertEqual(res.status, 201, 'order with addon created');
      orderId = res.data.order.id;
      itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;

      const bareRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'takeaway', items: [{ product_id: 'prod-125', quantity: 1 }] },
        headers: authHeader,
      });
      bareOrderId = bareRes.data.order.id;
      bareItemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(bareOrderId) as any).id;

      const columns = db.prepare("PRAGMA table_info(order_items)").all().map((c: any) => c.name);
      assert(!columns.includes('addons'), 'setup: order_items.addons column does not exist');
    }

    console.log('\n─── Scenario A: GET /api/orders/:id resolves addons from order_item_addons ───');
    {
      const res = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
      assertEqual(res.status, 200, 'A: order detail fetched');
      const addons = res.data.order.items[0].addons;
      assertEqual(addons.length, 1, 'A: one addon returned');
      assertEqual(addons[0].name, 'Extra Sugar', 'A: correct addon name');
      assertEqual(addons[0].price, 5, 'A: correct addon price');
    }

    console.log('\n─── Scenario B: GET /api/orders (list) also resolves it ───');
    {
      const res = await api(baseUrl, '/api/orders', { headers: authHeader });
      const order = res.data.orders.find((o: any) => o.id === orderId);
      assert(!!order, 'B: order found in list');
      assertEqual(order.items[0].addons[0].name, 'Extra Sugar', 'B: list view shows the addon');
    }

    console.log('\n─── Scenario C: KDS GET /api/kds/orders resolves it ───');
    {
      const res = await api(baseUrl, '/api/kds/orders', { headers: authHeader });
      const order = res.data.orders.find((o: any) => o.id === orderId);
      assert(!!order, 'C: order found on KDS feed');
      const item = order.items.find((i: any) => i.id === itemId);
      assert(Array.isArray(item.addons), 'C: addons is a real array (kds.ts never called parseItemJson before)');
      assertEqual(item.addons[0].name, 'Extra Sugar', 'C: KDS /orders shows the addon');
    }

    console.log('\n─── Scenario D: GET /api/kitchen/orders resolves it (separate route file) ───');
    {
      const res = await api(baseUrl, '/api/kitchen/orders', { headers: authHeader });
      assertEqual(res.status, 200, 'D: kitchen orders fetched');
      const order = res.data.orders.find((o: any) => o.id === orderId);
      assert(!!order, 'D: order found on the legacy /api/kitchen feed');
      const item = order.items.find((i: any) => i.id === itemId);
      assertEqual(item.addons[0].name, 'Extra Sugar', 'D: /api/kitchen/orders shows the addon too');
    }

    console.log('\n─── Scenario E: PATCH /api/order-items/:id/status response resolves it ───');
    {
      const res = await api(baseUrl, `/api/order-items/${itemId}/status`, {
        method: 'PATCH',
        body: { status: 'preparing' },
        headers: authHeader,
      });
      assertEqual(res.status, 200, 'E: item status updated');
      const item = res.data.order.items.find((i: any) => i.id === itemId);
      assertEqual(item.addons[0].name, 'Extra Sugar', 'E: order-items.ts response includes the addon');
    }

    console.log('\n─── Scenario F: an item with no selected addons gets an empty array everywhere ───');
    {
      const detail = await api(baseUrl, `/api/orders/${bareOrderId}`, { headers: authHeader });
      assert(Array.isArray(detail.data.order.items[0].addons), 'F: order detail — addons is an array');
      assertEqual(detail.data.order.items[0].addons.length, 0, 'F: order detail — empty, not null');

      const kitchen = await api(baseUrl, '/api/kitchen/orders', { headers: authHeader });
      const bareOrder = kitchen.data.orders.find((o: any) => o.id === bareOrderId);
      assert(Array.isArray(bareOrder.items[0].addons), 'F: kitchen feed — addons is an array');
      assertEqual(bareOrder.items[0].addons.length, 0, 'F: kitchen feed — empty, not null');
    }

    console.log('\n─── Scenario G: item-discount calculation includes addon price via order_item_addons ───');
    {
      // itemBaseTotal should be unit_price*qty + addon price = 50 + 5 = 55.
      // A 10% discount on that base is 5.5.
      const res = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
        method: 'PATCH',
        body: { discount_type: 'percentage', discount_value: 10 },
        headers: authHeader,
      });
      assertEqual(res.status, 200, `G: discount applied (got ${res.status}, ${JSON.stringify(res.data)})`);
      const updatedItem = db.prepare('SELECT discount_amount FROM order_items WHERE id = ?').get(itemId) as any;
      assertEqual(updatedItem.discount_amount, 5.5, 'G: discount_amount correctly includes the addon price in its base (50+5=55, 10% = 5.5)');
    }

    console.log('\n─── Scenario H: attachEffectiveAddons unit behavior (no JSON fallback anymore) ───');
    {
      const withAddon = attachEffectiveAddons(db, [{ id: itemId }]);
      assertEqual(withAddon[0].addons.length, 1, 'H: item with a normalized row returns it');

      const withoutAddon = attachEffectiveAddons(db, [{ id: bareItemId }]);
      assert(Array.isArray(withoutAddon[0].addons), 'H: item with no normalized rows still gets an array');
      assertEqual(withoutAddon[0].addons.length, 0, 'H: ...and it is empty, not null');

      const empty = attachEffectiveAddons(db, []);
      assertEqual(empty.length, 0, 'H: empty input returns empty output without querying');
    }

  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
