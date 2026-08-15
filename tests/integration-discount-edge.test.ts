/**
 * Integration Test: Discount Edge Cases
 *
 * Tests discount combinations that caused bugs:
 * A) Item + order discount combined
 * B) Discount exceeds max limit
 * C) Percentage discount includes addon prices
 *
 * Bugs this catches: #6 (item discount overwriting order discount),
 * #7 (discount flow desynchronization), #10 (item discount ignoring addon prices)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-discount-edge.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-discount-edge-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, assertIncludes,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
  console.log('Integration Test: Discount Edge Cases');
  console.log('='.repeat(50));

  const db = initTestDb();

  // Seed data
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-edge', 'Edge Case Menu');
  seedProduct(db, 'prod-edge-1', 'cat-edge', 'Pizza', 500);
  seedProduct(db, 'prod-edge-2', 'cat-edge', 'Pasta', 500);
  seedProduct(db, 'prod-edge-3', 'cat-edge', 'Burger', 400);
  db.prepare(`INSERT INTO addon_groups (id, name) VALUES ('ag-edge', 'Extras')`).run();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-edge-cheese', 'ag-edge', 'Extra Cheese', 100, 1)`).run();
  db.prepare(`INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('prod-edge-3', 'ag-edge')`).run();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('discount_mode', 'both');
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('discount_max_amount', '100');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Scenario A: Item + Order Discount Combined
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario A: Item + Order Discount Combined ───');

    // Create order with 2 items (₹500 each)
    const orderA = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-edge-1', quantity: 1 },
          { product_id: 'prod-edge-2', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(orderA.status, 201, 'order created');
    const orderIdA = orderA.data.order.id;
    const items = orderA.data.order.items;
    assertEqual(items.length, 2, 'order has 2 items');

    // Apply ₹50 item-level discount to item 1
    const item1Id = items[0].id;
    const itemDiscountRes = await api(baseUrl, `/api/orders/${orderIdA}/items/${item1Id}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'amount', discount_value: 50 },
      headers: authHeader,
    });
    assertEqual(itemDiscountRes.status, 200, 'item discount applied');
    assertEqual(itemDiscountRes.data.item.discount_amount, 50, 'item 1 discount = ₹50');

    // Verify item 1 subtotal is now ₹450
    const item1After = itemDiscountRes.data.item;
    assertEqual(item1After.subtotal, 450, 'item 1 subtotal = ₹450 (500 - 50)');

    // Apply 10% order-level discount
    const orderDiscountRes = await api(baseUrl, `/api/orders/${orderIdA}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(orderDiscountRes.status, 200, 'order discount applied');

    // Order subtotal should be: item1(₹450) + item2(₹500) = ₹950
    const orderAfterDiscount = orderDiscountRes.data.order;
    assertEqual(orderAfterDiscount.subtotal, 950, 'order subtotal = ₹950 (450 + 500)');

    // Order-level discount should be 10% of ₹950 = ₹95
    assertEqual(orderAfterDiscount.discount_amount, 95, 'order discount = ₹95 (10% of ₹950)');

    // Verify the item-level discount is still preserved
    const item1Final = db.prepare('SELECT * FROM order_items WHERE id = ?').get(item1Id) as any;
    assertEqual(item1Final.discount_amount, 50, 'item 1 discount still ₹50 (not overwritten)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario B: Discount Exceeds Max Limit
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B: Discount Exceeds Max Limit ───');

    // Create a fresh order
    const orderB = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-edge-1', quantity: 1 }] },
      headers: authHeader,
    });
    const orderIdB = orderB.data.order.id;

    // Try to apply 60% discount (max is 25% by default)
    const tooHighDiscount = await api(baseUrl, `/api/orders/${orderIdB}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 60 },
      headers: authHeader,
    });
    assertEqual(tooHighDiscount.status, 400, '60% discount rejected (400)');
    assertIncludes(tooHighDiscount.data.error, 'maximum', 'error mentions maximum');

    // Try amount discount exceeding configured max (₹100)
    const tooHighAmount = await api(baseUrl, `/api/orders/${orderIdB}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'amount', discount_value: 999 },
      headers: authHeader,
    });
    assertEqual(tooHighAmount.status, 400, '₹999 amount discount rejected (400)');
    assertIncludes(tooHighAmount.data.error, 'maximum', 'error mentions maximum');

    // Verify valid discount still works (within limits)
    const validDiscount = await api(baseUrl, `/api/orders/${orderIdB}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 25 },
      headers: authHeader,
    });
    assertEqual(validDiscount.status, 200, '25% discount accepted (within limit)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario C: Percentage Discount Includes Addon Prices
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario C: Discount Includes Addon Prices ───');

    // Create order with item + addon (₹400 base + ₹100 addon = ₹500)
    const orderC = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{
          product_id: 'prod-edge-3',
          quantity: 1,
          addons: [{ id: 'addon-edge-cheese', quantity: 1 }],
        }],
      },
      headers: authHeader,
    });
    assertEqual(orderC.status, 201, 'order with addon created');
    const orderIdC = orderC.data.order.id;
    const itemCId = orderC.data.order.items[0].id;

    // Verify subtotal includes addon: ₹400 + ₹100 = ₹500
    assertEqual(orderC.data.order.subtotal, 500, 'order subtotal = ₹500 (400 + 100 addon)');

    // Apply 10% item-level discount
    const addonDiscountRes = await api(baseUrl, `/api/orders/${orderIdC}/items/${itemCId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(addonDiscountRes.status, 200, 'item discount applied');

    // Discount should be 10% of ₹500 = ₹50 (not 10% of ₹400 = ₹40)
    assertEqual(addonDiscountRes.data.item.discount_amount, 50, 'discount = ₹50 (10% of ₹500, including addon)');

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
