/**
 * Integration Test: Issue #24 — Checkout after item cancellation
 *
 * Verifies that cancelling an item from an order and then calling
 * POST /bills/generate succeeds (previously returned 500).
 *
 * Root cause: cancel-item handler in index.ts was missing delivery_charge
 * in preRoundTotal, causing the order total to drift from what bill generation
 * expected when a delivery charge was present.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-24-cancel-item-checkout.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-24-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-24';

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct, seedTable,
  api, assert, assertEqual, assertIncludes,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { registerRoutes } = require('../main/routes/index');
const { billRoutes } = require('../main/routes/bills');
const { orderRoutes } = require('../main/routes/orders');

async function main() {
  console.log('Integration Test: Issue #24 — Cancel item then checkout');
  console.log('='.repeat(60));

  const db = initTestDb();

  const { authHeader } = seedOwnerUser(db);
  seedManagerUser(db);
  seedCategory(db, 'cat-24', 'Drinks');
  seedProduct(db, 'prod-24-a', 'cat-24', 'Latte', 200);
  seedProduct(db, 'prod-24-b', 'cat-24', 'Espresso', 150);
  seedProduct(db, 'prod-24-c', 'cat-24', 'Muffin', 100);

  // Mount all routes the same way as production
  const express = require('express');
  const app = express();
  app.use(express.json());

  const jwt = require('jsonwebtoken');
  const { getJWTSecret } = require('../main/routes/auth');
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) { next(); return; }
    if (req.path === '/api/health') { next(); return; }
    if (req.path.startsWith('/api/auth') && !req.path.includes('/api/auth/me')) { next(); return; }
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      (req as any).user = jwt.verify(h.split(' ')[1], getJWTSecret());
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  });

  app.use('/api/orders', orderRoutes);
  app.use('/api/bills', billRoutes);
  registerRoutes(app);

  const { baseUrl, server } = await startServer(app);

  try {
    // ── Scenario A: Cancel item (no delivery charge), then generate bill ──
    console.log('\n─── Scenario A: Cancel item (no delivery charge) ───');
    {
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'takeaway', items: [
          { product_id: 'prod-24-a', quantity: 1 },
          { product_id: 'prod-24-b', quantity: 1 },
        ]},
        headers: authHeader,
      });
      assertEqual(createRes.status, 201, 'A: order created');
      const orderId = createRes.data.order.id;
      const itemToCancel = createRes.data.order.items.find((i: any) => i.product_id === 'prod-24-b').id;

      const cancelRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemToCancel}/cancel`, {
        method: 'PATCH',
        headers: authHeader,
      });
      assertEqual(cancelRes.status, 200, 'A: item cancelled successfully');

      const billRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: authHeader,
      });
      assertEqual(billRes.status, 201, 'A: bill generated after item cancel (not 500)');
      assert(billRes.data.bill?.id > 0, 'A: bill has valid id');

      // Latte 200 + 5% GST = 210 total
      assertEqual(billRes.data.bill.total, 210, 'A: bill total = 210 (only Latte after cancel)');
    }

    // ── Scenario B: Cancel item WITH delivery charge, then generate bill ──
    console.log('\n─── Scenario B: Cancel item WITH delivery charge ───');
    {
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'delivery', delivery_charge: 50, items: [
          { product_id: 'prod-24-a', quantity: 1 },
          { product_id: 'prod-24-b', quantity: 1 },
          { product_id: 'prod-24-c', quantity: 1 },
        ]},
        headers: authHeader,
      });
      assertEqual(createRes.status, 201, 'B: order with delivery charge created');
      const orderId = createRes.data.order.id;

      const itemToCancel = createRes.data.order.items.find((i: any) => i.product_id === 'prod-24-c').id;

      const cancelRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemToCancel}/cancel`, {
        method: 'PATCH',
        headers: authHeader,
      });
      assertEqual(cancelRes.status, 200, 'B: item cancelled with delivery charge present');

      // Verify order total includes delivery_charge after cancel
      const orderAfterCancel = cancelRes.data.order;
      // Latte(200) + Espresso(150) = 350 subtotal, 5% GST = 17.5 → ~18 tax, + 50 delivery = 418
      assert(orderAfterCancel.delivery_charge === 50, 'B: delivery_charge preserved on order');
      assert(orderAfterCancel.total > 0, 'B: order total > 0 after cancel');

      const billRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: authHeader,
      });
      assertEqual(billRes.status, 201, 'B: bill generated after item cancel WITH delivery charge (not 500)');
      assert(billRes.data.bill?.id > 0, 'B: bill has valid id');
      assertEqual(billRes.data.bill.delivery_charge, 50, 'B: bill preserves delivery_charge = 50');
      assertEqual(billRes.data.bill.total, orderAfterCancel.total, 'B: bill total matches order total');
    }

    // ── Scenario C: Cancel ALL items from order, bill should handle gracefully ─
    console.log('\n─── Scenario C: Cancel all items ───');
    {
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'takeaway', items: [
          { product_id: 'prod-24-a', quantity: 1 },
        ]},
        headers: authHeader,
      });
      assertEqual(createRes.status, 201, 'C: order created');
      const orderId = createRes.data.order.id;
      const itemId = createRes.data.order.items[0].id;

      const cancelRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/cancel`, {
        method: 'PATCH',
        headers: authHeader,
      });
      assertEqual(cancelRes.status, 200, 'C: last item cancelled successfully');
      assertEqual(cancelRes.data.order.total, 0, 'C: order total = 0 after all items cancelled');
      // Issue #132: cancelling the last item must transition the order itself
      // to cancelled — otherwise it silently stays "active" with zero items,
      // cluttering the Active list and never freeing its table.
      assertEqual(cancelRes.data.order.status, 'cancelled', 'C: order status = cancelled after last item cancelled');
      assert(!!cancelRes.data.order.cancelled_at, 'C: cancelled_at is set');

      // Restoring an item on a now-cancelled order must be refused — same
      // rule that already applies to an explicitly whole-order-cancelled order.
      const restoreRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/restore`, {
        method: 'PATCH',
        headers: authHeader,
      });
      assertEqual(restoreRes.status, 400, 'C: cannot restore an item on a now-cancelled order');
    }

    // ── Issue #132 — Scenario D: cancelling the last item frees the table ──
    console.log('\n─── Scenario D: last item cancel frees the table (dine-in) ───');
    {
      seedTable(db, 'tbl-132-1', 132, 4);
      getDatabase().prepare("UPDATE tables SET status = 'occupied' WHERE id = ?").run('tbl-132-1');

      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'dine_in', table_id: 'tbl-132-1', items: [
          { product_id: 'prod-24-a', quantity: 1 },
        ]},
        headers: authHeader,
      });
      assertEqual(createRes.status, 201, 'D: dine-in order created');
      const orderId = createRes.data.order.id;
      const itemId = createRes.data.order.items[0].id;

      const cancelRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/cancel`, {
        method: 'PATCH',
        headers: authHeader,
      });
      assertEqual(cancelRes.status, 200, 'D: last item cancelled on dine-in order');
      assertEqual(cancelRes.data.order.status, 'cancelled', 'D: order status = cancelled');

      const tableRow = getDatabase().prepare('SELECT status FROM tables WHERE id = ?').get('tbl-132-1') as any;
      assertEqual(tableRow.status, 'available', 'D: table freed after last item cancelled');
    }

    // ── Issue #132 — Scenario E: cancelling a non-last item does NOT cancel the order ──
    console.log('\n─── Scenario E: cancelling one of several items leaves order active ───');
    {
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'takeaway', items: [
          { product_id: 'prod-24-a', quantity: 1 },
          { product_id: 'prod-24-b', quantity: 1 },
        ]},
        headers: authHeader,
      });
      const orderId = createRes.data.order.id;
      const itemToCancel = createRes.data.order.items.find((i: any) => i.product_id === 'prod-24-b').id;

      const cancelRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemToCancel}/cancel`, {
        method: 'PATCH',
        headers: authHeader,
      });
      assertEqual(cancelRes.status, 200, 'E: item cancelled');
      assert(cancelRes.data.order.status !== 'cancelled', 'E: order stays active — one item still active');
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
