/**
 * Regression Test: Issue #252 — Order Lifecycle and One-Time Inventory Restoration
 *
 * Tests:
 * 1. Repeated whole-order cancellation is idempotent (stock is restored exactly once).
 * 2. Terminal states (cancelled, completed) reject invalid outbound transitions.
 * 3. Whole-order cancellation excludes voided items and void_adjustment rows from restocking.
 * 4. Item cancellation & restoration are idempotent and state-conditional.
 * 5. Auto-cancellation when cancelling the final active item does not double-restock.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-252-order-lifecycle-inventory.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-252-test-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedTable,
  api, assertEqual, assert, closeDatabase,
} = require('./helpers/test-setup');

const { registerRoutes } = require('../main/routes/index');

async function main() {
  console.log('Regression Test: Issue #252 Order Lifecycle & Inventory Safety');
  console.log('='.repeat(65));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-252', 'Lifecycle Test Category');

  seedProduct(db, 'prod-track-1', 'cat-252', 'Burger', 100, { track_inventory: true, stock_quantity: 10 });
  seedProduct(db, 'prod-track-2', 'cat-252', 'Fries', 50, { track_inventory: true, stock_quantity: 10 });
  seedProduct(db, 'prod-untrack', 'cat-252', 'Water', 20, { track_inventory: false, stock_quantity: 999 });

  seedTable(db, 'tbl-252-1', 1, 4);
  seedTable(db, 'tbl-252-2', 2, 2);

  const { orderRoutes } = require('../main/routes/orders');
  const app = createApp({
    '/api/orders': orderRoutes,
  });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // 1. Repeated Whole-Order Cancellation (Idempotency)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 1. Repeated Whole-Order Cancellation ───');
    
    // Create order for 2 Burgers (stock 10 → 8)
    const order1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'dine_in', table_id: 'tbl-252-1', items: [{ product_id: 'prod-track-1', quantity: 2 }] },
    });
    const order1Id = order1.data.order.id;

    let stock1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stock1, 8, 'Stock deducted on order creation (10 -> 8)');

    // First cancel
    const cancel1 = await api(baseUrl, `/api/orders/${order1Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', reason: 'Customer left' },
    });
    assertEqual(cancel1.status, 200, 'First cancel HTTP status');

    stock1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stock1, 10, 'Stock restored on first cancellation (8 -> 10)');

    // Second cancel
    const cancel2 = await api(baseUrl, `/api/orders/${order1Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', reason: 'Repeated cancel attempt' },
    });
    assertEqual(cancel2.status, 200, 'Second cancel HTTP status (idempotent no-op)');

    stock1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stock1, 10, 'Stock MUST remain 10 after second cancel (no double-restock)');

    // ═══════════════════════════════════════════════════════════════════
    // 2. Terminal State Transitions Guard
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 2. Terminal State Transitions Guard ───');

    // Attempt to transition cancelled order to preparing
    const reopenCancel = await api(baseUrl, `/api/orders/${order1Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'preparing' },
    });
    assertEqual(reopenCancel.status, 400, 'Cancelled order cannot reopen to preparing');

    const order1Status = db.prepare('SELECT status FROM orders WHERE id = ?').get(order1Id).status;
    assertEqual(order1Status, 'cancelled', 'Order status remains cancelled');

    // Create completed order
    const order2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-track-1', quantity: 1 }] },
    });
    const order2Id = order2.data.order.id;

    await api(baseUrl, `/api/orders/${order2Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'completed' },
    });

    const stockBeforeCompletedCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;

    // Attempt to cancel completed order
    const cancelCompleted = await api(baseUrl, `/api/orders/${order2Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled' },
    });
    assertEqual(cancelCompleted.status, 400, 'Completed order cannot transition to cancelled');

    const order2Status = db.prepare('SELECT status FROM orders WHERE id = ?').get(order2Id).status;
    assertEqual(order2Status, 'completed', 'Order status remains completed');

    const stockAfterCompletedCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockAfterCompletedCancel, stockBeforeCompletedCancel, 'Stock unchanged when attempting to cancel completed order');

    // ═══════════════════════════════════════════════════════════════════
    // 3. Whole-Order Cancel with Voided Items & void_adjustment Rows
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 3. Whole-Order Cancel with Voided Items ───');

    // Stock before order 3: prod-track-1 = 9
    const order3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'dine_in', table_id: 'tbl-252-2', items: [{ product_id: 'prod-track-1', quantity: 1 }] },
    });
    const order3Id = order3.data.order.id;
    const item3Id = order3.data.order.items[0].id;

    // Stock is now 8
    let stock3 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stock3, 8, 'Stock after order 3 creation (9 -> 8)');

    // Move order to preparing
    await api(baseUrl, `/api/orders/${order3Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'preparing' },
    });

    // Void item in progress (ingredients were consumed, so voided item is not restocked)
    await api(baseUrl, `/api/orders/${order3Id}/items/${item3Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: { override_pin: '1234' },
    });

    stock3 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stock3, 8, 'In-progress voided item leaves stock unchanged (8)');

    // Cancel whole order3
    await api(baseUrl, `/api/orders/${order3Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', override_pin: '1234' },
    });

    stock3 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stock3, 8, 'Whole-order cancel MUST NOT restock in-progress voided items or void_adjustment rows');

    // ═══════════════════════════════════════════════════════════════════
    // 4. Pending Item Cancel & Restore Idempotency
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 4. Item Cancel & Restore Idempotency ───');

    const order4 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-track-1', quantity: 1 },
          { product_id: 'prod-track-2', quantity: 2 },
        ],
      },
    });
    const order4Id = order4.data.order.id;
    const itemTrack1Id = order4.data.order.items.find((i: any) => i.product_id === 'prod-track-1').id;

    // Stock track-1 = 7, track-2 = 8
    let stockTrack1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1, 7, 'Stock track-1 after order 4 creation');

    // Cancel pending item 1
    const itemCancel1 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemCancel1.status, 200, 'Pending item cancel HTTP status');

    stockTrack1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1, 8, 'Pending item cancel restores stock (7 -> 8)');

    // Repeat cancel of already cancelled item
    const itemCancel2 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemCancel2.status, 200, 'Repeated pending item cancel HTTP status');

    stockTrack1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1, 8, 'Repeated pending item cancel MUST NOT restore stock again');

    // Restore item 1
    const itemRestore1 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/restore`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemRestore1.status, 200, 'Item restore HTTP status');

    stockTrack1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1, 7, 'Item restore re-deducts stock (8 -> 7)');

    // Repeat restore of active item
    const itemRestore2 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/restore`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemRestore2.status, 200, 'Repeated item restore HTTP status');

    stockTrack1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1, 7, 'Repeated item restore MUST NOT deduct stock again');

    // ═══════════════════════════════════════════════════════════════════
    // 5. Final Item Cancellation / Auto-Cancel
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 5. Final Item Cancellation / Auto-Cancel ───');

    const order5 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-252-1',
        items: [{ product_id: 'prod-track-2', quantity: 1 }],
      },
    });
    const order5Id = order5.data.order.id;
    const item5Id = order5.data.order.items[0].id;

    let stockTrack2 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-2').stock_quantity;
    assertEqual(stockTrack2, 7, 'Stock track-2 after order 5 creation (8 -> 7)');

    // Cancel final item (triggers order auto-cancel)
    await api(baseUrl, `/api/orders/${order5Id}/items/${item5Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });

    const order5Status = db.prepare('SELECT status FROM orders WHERE id = ?').get(order5Id).status;
    assertEqual(order5Status, 'cancelled', 'Order auto-cancelled when final item cancelled');

    stockTrack2 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-2').stock_quantity;
    assertEqual(stockTrack2, 8, 'Stock track-2 restored exactly once on auto-cancel (7 -> 8)');

    console.log('\nAll Issue #252 regression tests passed!');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
