/**
 * Regression Test: Issue #252 — Order Lifecycle and One-Time Inventory Restoration
 *
 * Tests:
 * 1. Repeated whole-order cancellation is idempotent (stock is restored exactly once).
 * 2. Order lifecycle transition matrix enforcement (monotonic active state progress & terminal state lock).
 * 3. Completed-order item cancellation is rejected without changing order, item, or stock state.
 * 4. Transaction-boundary state/PIN and monetary fields use the current database snapshot.
 * 5. Whole-order cancellation excludes voided items and void_adjustment rows from restocking in multi-item orders.
 * 6. Pending item in a preparing order follows pending cancellation/restock contract (not voided).
 * 7. Item cancellation & restoration are idempotent and state-conditional.
 * 8. Repeated void cancellation is idempotent and insufficient-stock restore is atomic.
 * 9. Auto-cancellation and concurrent whole-order cancellation do not double-restock inventory.
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

// Deterministically model a second writer landing after a route's initial
// lookup but before its transaction. Assertions remain at the public HTTP and
// database-state boundaries; this only makes the transaction seam schedulable
// in a single-process integration test.
function installOrderBoundaryMutation(db: any, orderId: number | string, mutate: () => void): () => void {
  const originalPrepare = db.prepare.bind(db);
  let fired = false;
  db.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (fired || sql !== 'SELECT * FROM orders WHERE id = ?') return statement;

    const originalGet = statement.get.bind(statement);
    statement.get = (...args: any[]) => {
      const row = originalGet(...args);
      if (!fired && row && String(row.id) === String(orderId)) {
        fired = true;
        mutate();
      }
      return row;
    };
    return statement;
  };

  return () => {
    db.prepare = originalPrepare;
  };
}

async function waitForOutboxCount(db: any, expected: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = db.prepare('SELECT COUNT(*) AS count FROM cloud_sync_outbox').get();
    if (row.count >= expected) return row.count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return db.prepare('SELECT COUNT(*) AS count FROM cloud_sync_outbox').get().count;
}

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
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'preparing', 'pending -> preparing persists preparing');

    const toReady = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'ready' } });
    assertEqual(toReady.status, 200, 'preparing -> ready is valid');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'ready', 'preparing -> ready persists ready');

    // Backward transition rejections:
    const readyToPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(readyToPrep.status, 400, 'ready -> preparing rejected (backward transition)');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'ready', 'rejected ready -> preparing leaves ready state intact');

    const toServed = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'served' } });
    assertEqual(toServed.status, 200, 'ready -> served is valid');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'served', 'ready -> served persists served');

    const servedToPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(servedToPrep.status, 400, 'served -> preparing rejected (backward transition)');

    const servedToReady = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'ready' } });
    assertEqual(servedToReady.status, 400, 'served -> ready rejected (backward transition)');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'served', 'rejected served backward transitions leave served state intact');

    // Same-state idempotent request
    const sameServed = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'served' } });
    assertEqual(sameServed.status, 200, 'same-state served -> served is idempotent 200');
    assert(typeof sameServed.data.order.tax_breakdown !== 'string', 'same-state status response parses tax breakdown');
    assert(typeof sameServed.data.order.tax_snapshot !== 'string', 'same-state status response parses tax snapshot');

    const toComp = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'completed' } });
    assertEqual(toComp.status, 200, 'served -> completed is valid');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'completed', 'served -> completed persists completed');

    // Terminal state locks (completed & cancelled)
    const compToPrep = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'preparing' } });
    assertEqual(compToPrep.status, 400, 'completed -> preparing rejected');

    const compToCancel = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'cancelled', override_pin: '1234' } });
    assertEqual(compToCancel.status, 400, 'completed -> cancelled rejected even with a valid PIN');

    const sameComp = await api(baseUrl, `/api/orders/${fwdId}/status`, { method: 'PATCH', headers: authHeader, body: { status: 'completed' } });
    assertEqual(sameComp.status, 200, 'completed -> completed is idempotent 200');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(fwdId).status, 'completed', 'terminal transitions leave completed state intact');

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
    // 3. Terminal item cancellation and transaction-local snapshots
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 3. Terminal item cancellation and transaction-local snapshots ───');

    const completedOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-track-1', quantity: 1 }] },
    });
    const completedOrderId = completedOrder.data.order.id;
    const completedItemId = completedOrder.data.order.items[0].id;
    const completedStockBeforeCancel = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;

    const completeRes = await api(baseUrl, `/api/orders/${completedOrderId}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'completed' },
    });
    assertEqual(completeRes.status, 200, 'completed-order fixture reaches completed state');

    const terminalCancel = await api(baseUrl, `/api/orders/${completedOrderId}/items/${completedItemId}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: { override_pin: '1234' },
    });
    assertEqual(terminalCancel.status, 400, 'completed-order item cancellation is rejected');
    const completedState = db.prepare(`
      SELECT o.status AS order_status, i.status AS item_status
      FROM orders o JOIN order_items i ON i.order_id = o.id
      WHERE o.id = ? AND i.id = ?
    `).get(completedOrderId, completedItemId);
    assertEqual(completedState.order_status, 'completed', 'completed parent status is unchanged after rejected item cancel');
    assertEqual(completedState.item_status, 'served', 'completed item status is unchanged after rejected item cancel');
    assertEqual(
      db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity,
      completedStockBeforeCancel,
      'completed-order item cancellation does not restore stock',
    );

    const pinRaceOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-untrack', quantity: 1 }] },
    });
    const pinRaceOrderId = pinRaceOrder.data.order.id;
    const removePinRaceHook = installOrderBoundaryMutation(db, pinRaceOrderId, () => {
      db.prepare("UPDATE orders SET status = 'preparing', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), pinRaceOrderId);
    });
    let pinRaceCancel;
    try {
      pinRaceCancel = await api(baseUrl, `/api/orders/${pinRaceOrderId}/status`, {
        method: 'PATCH',
        headers: authHeader,
        body: { status: 'cancelled' },
      });
    } finally {
      removePinRaceHook();
    }
    assertEqual(pinRaceCancel.status, 400, 'transaction-local status requires the current cancellation PIN policy');
    assertEqual(
      db.prepare('SELECT status FROM orders WHERE id = ?').get(pinRaceOrderId).status,
      'preparing',
      'state changed at the transaction boundary is not overwritten by an unauthorized cancel',
    );

    const staleTotalsOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'delivery',
        delivery_charge: 25,
        items: [
          { product_id: 'prod-untrack', quantity: 1 },
          { product_id: 'prod-track-2', quantity: 1 },
        ],
      },
    });
    const staleTotalsOrderId = staleTotalsOrder.data.order.id;
    const staleTotalsItemId = staleTotalsOrder.data.order.items.find((item: any) => item.product_id === 'prod-untrack').id;
    const removeTotalsHook = installOrderBoundaryMutation(db, staleTotalsOrderId, () => {
      db.prepare('UPDATE orders SET delivery_charge = ?, updated_at = ? WHERE id = ?')
        .run(99, new Date().toISOString(), staleTotalsOrderId);
    });
    let staleTotalsCancel;
    try {
      staleTotalsCancel = await api(baseUrl, `/api/orders/${staleTotalsOrderId}/items/${staleTotalsItemId}/cancel`, {
        method: 'PATCH',
        headers: authHeader,
        body: {},
      });
    } finally {
      removeTotalsHook();
    }
    assertEqual(staleTotalsCancel.status, 200, 'item cancellation with a boundary order update succeeds');
    const staleTotalsState = db.prepare('SELECT subtotal, delivery_charge, total FROM orders WHERE id = ?').get(staleTotalsOrderId);
    assertEqual(staleTotalsState.subtotal, 50, 'recalculation uses the current active-item subtotal');
    assertEqual(staleTotalsState.delivery_charge, 99, 'recalculation preserves the current delivery charge');
    assertEqual(staleTotalsState.total, 149, 'recalculation uses the current delivery charge, not the stale outer value');

    // ═══════════════════════════════════════════════════════════════════
    // 4. Whole-Order Cancel with Voided Item in Multi-Item Order
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 4. Whole-Order Cancel with Voided Items in Multi-Item Order ───');

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
    db.prepare("UPDATE settings SET value = '1', updated_at = ? WHERE key = 'cloud_orders_enabled'").run(new Date().toISOString());
    db.prepare('DELETE FROM cloud_sync_outbox').run();
    const voidRes = await api(baseUrl, `/api/orders/${order3Id}/items/${itemA.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: { override_pin: '1234' },
    });
    assertEqual(voidRes.status, 200, 'Void item A status code');
    const voidOutboxCount = await waitForOutboxCount(db, 1);
    assertEqual(voidOutboxCount, 1, 'First void cancellation creates one cloud event');
    assertEqual(
      db.prepare('SELECT event_type FROM cloud_sync_outbox ORDER BY created_at LIMIT 1').get().event_type,
      'order.item_voided',
      'First void cancellation is classified as a void event',
    );

    const itemARow = db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemA.id);
    assertEqual(itemARow.status, 'voided', 'Item A is marked voided');

    const voidAdjustCount = db.prepare("SELECT COUNT(*) as count FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(order3Id).count;
    assertEqual(voidAdjustCount, 1, 'Exactly one void_adjustment row exists');

    const stockA_afterFirstVoid = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    const repeatedVoidRes = await api(baseUrl, `/api/orders/${order3Id}/items/${itemA.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: { override_pin: '1234' },
    });
    assertEqual(repeatedVoidRes.status, 200, 'Repeated void cancellation is an idempotent no-op');
    assertEqual(
      db.prepare("SELECT COUNT(*) as count FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(order3Id).count,
      1,
      'Repeated void cancellation does not add another adjustment row',
    );
    assertEqual(
      db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemA.id).status,
      'voided',
      'Repeated void cancellation keeps the original item voided',
    );
    assertEqual(
      db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity,
      stockA_afterFirstVoid,
      'Repeated void cancellation does not restore stock',
    );
    assertEqual(await waitForOutboxCount(db, 1), 1, 'Repeated void cancellation creates no cloud event');
    assertEqual(
      db.prepare("SELECT COUNT(*) AS count FROM cloud_sync_outbox WHERE event_type = 'order.item_cancelled'").get().count,
      0,
      'Repeated void cancellation is not misclassified as item cancellation',
    );

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
    // 5. Pending Item in Preparing Order follows Pending Restock Contract
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 5. Pending Item in Preparing Order ───');

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
    // 6. Item Cancel & Restore Idempotency
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 6. Item Cancel & Restore Idempotency ───');

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

    const insufficientOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-track-1', quantity: 1 },
          { product_id: 'prod-untrack', quantity: 1 },
        ],
      },
    });
    const insufficientOrderId = insufficientOrder.data.order.id;
    const insufficientItemId = insufficientOrder.data.order.items.find((item: any) => item.product_id === 'prod-track-1').id;
    const cancelForInsufficientRestore = await api(baseUrl, `/api/orders/${insufficientOrderId}/items/${insufficientItemId}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(cancelForInsufficientRestore.status, 200, 'insufficient-stock restore fixture cancels the tracked item');
    const stockBeforeInsufficientRestore = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity;
    db.prepare('UPDATE products SET stock_quantity = 0 WHERE id = ?').run('prod-track-1');

    const insufficientRestore = await api(baseUrl, `/api/orders/${insufficientOrderId}/items/${insufficientItemId}/restore`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(insufficientRestore.status, 400, 'restore rejects when tracked stock is insufficient');
    assertEqual(
      db.prepare('SELECT status FROM order_items WHERE id = ?').get(insufficientItemId).status,
      'cancelled',
      'insufficient-stock restore leaves the item cancelled',
    );
    assertEqual(
      db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-1').stock_quantity,
      0,
      'insufficient-stock restore leaves stock unchanged',
    );
    assertEqual(
      db.prepare('SELECT status FROM orders WHERE id = ?').get(insufficientOrderId).status,
      'pending',
      'insufficient-stock restore leaves the parent order active',
    );
    db.prepare('UPDATE products SET stock_quantity = ? WHERE id = ?').run(stockBeforeInsufficientRestore, 'prod-track-1');

    // ═══════════════════════════════════════════════════════════════════
    // 7. Final Item Cancellation / Auto-Cancel
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 7. Final Item Cancellation / Auto-Cancel ───');

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
    // 8. Concurrent Whole-Order Cancellation
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── 8. Concurrent Whole-Order Cancellation ───');

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
    fs.rmSync(testDir, { recursive: true, force: true });
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
