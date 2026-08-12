/**
 * Regression Test: Issue #252 — Order Lifecycle and One-Time Inventory Restoration
 *
 * Tests:
 * 1. Repeated whole-order cancellation is idempotent (stock is restored exactly once).
 * 2. Order lifecycle transition matrix enforcement (monotonic active state progress & terminal state lock).
 * 3. Whole-order cancellation excludes voided items and void_adjustment rows from restocking in multi-item orders.
 * 4. Pending item in a preparing order follows pending cancellation/restock contract (not voided).
 * 5. Item cancellation & restoration are idempotent and state-conditional.
 * 6. Auto-cancellation when cancelling the final active item does not double-restock.
 * 7. Concurrent whole-order cancellation requests execute safely without double restocking inventory.
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
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct, seedTable,
  api, assertEqual, assert, getResults, resetCounters, closeDatabase,
} = require('./helpers/test-setup');

const { registerRoutes } = require('../main/routes/index');

async function main() {
  console.log('Regression Test: Issue #252 Order Lifecycle & Inventory Safety');
  console.log('='.repeat(65));
  resetCounters();

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedManagerUser(db);
  seedCategory(db, 'cat-252', 'Lifecycle Test Category');

  seedProduct(db, 'prod-track-1', 'cat-252', 'Burger', 100, { track_inventory: true, stock_quantity: 10 });
  seedProduct(db, 'prod-track-2', 'cat-252', 'Fries', 50, { track_inventory: true, stock_quantity: 10 });
  seedProduct(db, 'prod-untrack', 'cat-252', 'Water', 20, { track_inventory: false, stock_quantity: 999 });

  seedTable(db, 'tbl-252-1', 1, 4);
  seedTable(db, 'tbl-252-2', 2, 2);

  const { orderRoutes } = require('../main/routes/orders');
  const { orderItemRoutes } = require('../main/routes/order-items');
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/order-items': orderItemRoutes,
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
    // 2. Order Lifecycle Transition Matrix Enforcement
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 2. Order Lifecycle Transition Matrix Enforcement ───');

    // Valid forward transitions: pending -> preparing -> ready -> served -> completed
    const orderFwd = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'dine_in', table_id: 'tbl-252-2', items: [{ product_id: 'prod-untrack', quantity: 1 }] },
    });
    const fwdId = orderFwd.data.order.id;

    const toPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(toPrep.status, 200, 'pending -> preparing is valid');

    const toReady = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'ready' } });
    assertEqual(toReady.status, 200, 'preparing -> ready is valid');

    // Backward transition rejections:
    const readyToPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(readyToPrep.status, 400, 'ready -> preparing rejected (backward transition)');

    const toServed = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'served' } });
    assertEqual(toServed.status, 200, 'ready -> served is valid');

    const servedToPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(servedToPrep.status, 400, 'served -> preparing rejected (backward transition)');

    const servedToReady = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'ready' } });
    assertEqual(servedToReady.status, 400, 'served -> ready rejected (backward transition)');

    // Same-state idempotent request
    const sameServed = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'served' } });
    assertEqual(sameServed.status, 200, 'same-state served -> served is idempotent 200');

    const toComp = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'completed' } });
    assertEqual(toComp.status, 200, 'served -> completed is valid');

    // Terminal state locks (completed & cancelled)
    const compToPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(compToPrep.status, 400, 'completed -> preparing rejected');

    const compToCancel = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'cancelled' } });
    assertEqual(compToCancel.status, 400, 'completed -> cancelled rejected');

    const sameComp = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'completed' } });
    assertEqual(sameComp.status, 200, 'completed -> completed is idempotent 200');

    // Cancellation supported from every active state (pending, preparing, ready, served)
    for (const activeState of ['pending', 'preparing', 'ready', 'served']) {
      const activeOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: authHeader,
        body: { type: 'takeaway', items: [{ product_id: 'prod-untrack', quantity: 1 }] },
      });
      const aId = activeOrder.data.order.id;
      if (activeState !== 'pending') {
        await api(baseUrl, `/api/orders/${aId}/status`, { method: 'PATCH', headers: authHeader, body: { status: activeState } });
      }
      const canRes = await api(baseUrl, `/api/orders/${aId}/status`, {
        method: 'PATCH',
        headers: authHeader,
        body: { status: 'cancelled', override_pin: '1234' },
      });
      assertEqual(canRes.status, 200, `cancellation from ${activeState} is supported`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 3. Whole-Order Cancel with Voided Item in Multi-Item Order
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 3. Whole-Order Cancel with Voided Items in Multi-Item Order ───');

    // Order 3 has Item A (prod-track-1, qty 1) and Item B (prod-track-2, qty 1)
    const order3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-252-2',
        items: [
          { product_id: 'prod-track-1', quantity: 1 },
          { product_id: 'prod-track-2', quantity: 1 },
        ],
      },
    });
    const order3Id = order3.data.order.id;
    const itemA = order3.data.order.items.find((i: any) => i.product_id === 'prod-track-1');
    const itemB = order3.data.order.items.find((i: any) => i.product_id === 'prod-track-2');

    // Establish that Item A itself is in preparing status using order-items API
    const itemAStatusRes = await api(baseUrl, `/api/order-items/${itemA.id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'preparing' },
    });
    assertEqual(itemAStatusRes.status, 200, 'Item A moved to preparing via order-items API');

    // Void Item A (in progress void requires PIN)
    const voidRes = await api(baseUrl, `/api/orders/${order3Id}/items/${itemA.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: { override_pin: '1234' },
    });
    assertEqual(voidRes.status, 200, 'Void item A status code');

    const itemARow = db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemA.id);
    assertEqual(itemARow.status, 'voided', 'Item A is marked voided');

    const voidAdjustCount = db.prepare("SELECT COUNT(*) as count FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(order3Id).count;
    assertEqual(voidAdjustCount, 1, 'Exactly one void_adjustment row exists');

    const itemBRow = db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemB.id);
    assertEqual(itemBRow.status, 'pending', 'Item B remains active (pending)');

    const stockA_beforeCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    const stockB_beforeCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-2').stock_quantity;

    // Cancel whole order 3
    const cancelOrder3Res = await api(baseUrl, `/api/orders/${order3Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', override_pin: '1234' },
    });
    assertEqual(cancelOrder3Res.status, 200, 'Order 3 cancel status code');

    const stockA_afterCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    const stockB_afterCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-2').stock_quantity;

    assertEqual(stockA_afterCancel, stockA_beforeCancel, 'Item A (voided) stock MUST NOT be restored on whole-order cancel');
    assertEqual(stockB_afterCancel, stockB_beforeCancel + 1, 'Item B (active) stock MUST be restored on whole-order cancel');

    // Repeat whole order cancellation on Order 3
    await api(baseUrl, `/api/orders/${order3Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', override_pin: '1234' },
    });

    const stockA_afterRepeat = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    const stockB_afterRepeat = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-2').stock_quantity;
    assertEqual(stockA_afterRepeat, stockA_afterCancel, 'Item A stock unchanged after repeated order cancel');
    assertEqual(stockB_afterRepeat, stockB_afterCancel, 'Item B stock unchanged after repeated order cancel');

    // ═══════════════════════════════════════════════════════════════════
    // 4. Pending Item in Preparing Order follows Pending Restock Contract
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 4. Pending Item in Preparing Order ───');

    const order4Pre = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-252-1',
        items: [
          { product_id: 'prod-track-1', quantity: 1 },
          { product_id: 'prod-track-2', quantity: 1 },
        ],
      },
    });
    const order4PreId = order4Pre.data.order.id;
    const itemPending = order4Pre.data.order.items.find((i: any) => i.product_id === 'prod-track-1');

    // Move parent order to preparing, but item status remains pending
    await api(baseUrl, `/api/orders/${order4PreId}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'preparing' },
    });

    const itemPendingStatus = db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemPending.id).status;
    assertEqual(itemPendingStatus, 'pending', 'Item status is still pending while order is preparing');

    const stockBeforePendingCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;

    // Cancel pending item
    const cancelPendingItemRes = await api(baseUrl, `/api/orders/${order4PreId}/items/${itemPending.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(cancelPendingItemRes.status, 200, 'Cancel pending item in preparing order HTTP status');

    const itemStatusAfterCancel = db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemPending.id).status;
    assertEqual(itemStatusAfterCancel, 'cancelled', 'Pending item in preparing order becomes cancelled (not voided)');

    const stockAfterPendingCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockAfterPendingCancel, stockBeforePendingCancel + 1, 'Pending item in preparing order restores stock (+1)');

    const voidAdjustCount4 = db.prepare("SELECT COUNT(*) as count FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(order4PreId).count;
    assertEqual(voidAdjustCount4, 0, 'No void_adjustment created for pending item');

    // ═══════════════════════════════════════════════════════════════════
    // 5. Item Cancel & Restore Idempotency
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 5. Item Cancel & Restore Idempotency ───');

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

    let stockTrack1 = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;

    // Cancel pending item 1
    const itemCancel1 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemCancel1.status, 200, 'Pending item cancel HTTP status');

    const stockTrack1_afterCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1_afterCancel, stockTrack1 + 1, 'Pending item cancel restores stock (+1)');

    // Repeat cancel of already cancelled item
    const itemCancel2 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemCancel2.status, 200, 'Repeated pending item cancel HTTP status');

    const stockTrack1_afterRepeatCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1_afterRepeatCancel, stockTrack1_afterCancel, 'Repeated pending item cancel MUST NOT restore stock again');

    // Restore item 1
    const itemRestore1 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/restore`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemRestore1.status, 200, 'Item restore HTTP status');

    const stockTrack1_afterRestore = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1_afterRestore, stockTrack1_afterCancel - 1, 'Item restore re-deducts stock (-1)');

    // Repeat restore of active item
    const itemRestore2 = await api(baseUrl, `/api/orders/${order4Id}/items/${itemTrack1Id}/restore`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(itemRestore2.status, 200, 'Repeated item restore HTTP status');

    const stockTrack1_afterRepeatRestore = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    assertEqual(stockTrack1_afterRepeatRestore, stockTrack1_afterRestore, 'Repeated item restore MUST NOT deduct stock again');

    // ═══════════════════════════════════════════════════════════════════
    // 6. Final Item Cancellation / Auto-Cancel
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 6. Final Item Cancellation / Auto-Cancel ───');

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

    // Cancel final item (triggers order auto-cancel)
    await api(baseUrl, `/api/orders/${order5Id}/items/${item5Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });

    const order5Status = db.prepare('SELECT status FROM orders WHERE id = ?').get(order5Id).status;
    assertEqual(order5Status, 'cancelled', 'Order auto-cancelled when final item cancelled');

    const stockTrack2_afterAutoCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-2').stock_quantity;
    assertEqual(stockTrack2_afterAutoCancel, stockTrack2 + 1, 'Stock track-2 restored exactly once on auto-cancel (+1)');

    // ═══════════════════════════════════════════════════════════════════
    // 7. Concurrent Whole-Order Cancellation
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 7. Concurrent Whole-Order Cancellation ───');

    seedProduct(db, 'prod-concurrent', 'cat-252', 'Concurrent Burger', 120, { track_inventory: true, stock_quantity: 10 });

    const orderConc = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'dine_in', table_id: 'tbl-252-2', items: [{ product_id: 'prod-concurrent', quantity: 2 }] },
    });
    const concOrderId = orderConc.data.order.id;

    let stockConc = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-concurrent').stock_quantity;
    assertEqual(stockConc, 8, 'Stock deducted on creation (10 -> 8)');

    // Send two real HTTP whole-order cancellation requests concurrently
    const [resConcA, resConcB] = await Promise.all([
      api(baseUrl, `/api/orders/${concOrderId}/status`, {
        method: 'PATCH',
        headers: authHeader,
        body: { status: 'cancelled', reason: 'Concurrent cancellation request A' },
      }),
      api(baseUrl, `/api/orders/${concOrderId}/status`, {
        method: 'PATCH',
        headers: authHeader,
        body: { status: 'cancelled', reason: 'Concurrent cancellation request B' },
      }),
    ]);

    assertEqual(resConcA.status, 200, 'Concurrent cancel request A returned 200');
    assertEqual(resConcB.status, 200, 'Concurrent cancel request B returned 200');

    const finalOrderConc = db.prepare('SELECT status FROM orders WHERE id = ?').get(concOrderId);
    assertEqual(finalOrderConc.status, 'cancelled', 'Final order status is cancelled');

    stockConc = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-concurrent').stock_quantity;
    assertEqual(stockConc, 10, 'Inventory restored exactly once (8 -> 10, NOT 12) under concurrent requests');

  } finally {
    server.close();
    closeDatabase();
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(65)}`);
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
