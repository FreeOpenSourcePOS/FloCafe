/**
 * Integration Test: Bill Reconciliation
 *
 * Tests that discount applied AFTER bill generation correctly updates the bill.
 * In a real restaurant, the cashier might generate the bill first, then a manager
 * applies a discount — the bill must reflect the discount.
 *
 * Bug this catches: #5 (order discount not syncing to existing unpaid bill)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-bill-reconciliation.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reconcile-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
  console.log('Integration Test: Bill Reconciliation');
  console.log('='.repeat(50));

  const db = initTestDb();

  // Seed data
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-recon', 'Reconciliation Test Menu');
  seedProduct(db, 'prod-recon-1', 'cat-recon', 'Steak', 1000);
  seedProduct(db, 'prod-recon-2', 'cat-recon', 'Wine', 500);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ── Step 1: Create order ─────────────────────────────────────────
    console.log('\n1. Create order (₹1000)');
    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-recon-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(orderRes.status, 201, 'order created');
    const orderId = orderRes.data.order.id;
    const originalTotal = orderRes.data.order.total;
    assert(originalTotal >= 1000, `order total >= ₹1000 (got ₹${originalTotal})`);

    // ── Step 2: Generate bill BEFORE discount ────────────────────────
    console.log('\n2. Generate bill (before discount)');
    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: authHeader,
    });
    assertEqual(billRes.status, 201, 'bill created');
    const billId = billRes.data.bill.id;
    assertEqual(billRes.data.bill.total, originalTotal, `bill total = ₹${originalTotal} (no discount yet)`);
    assertEqual(billRes.data.bill.payment_status, 'unpaid', 'bill is unpaid');

    // ── Step 3: Apply 15% discount AFTER bill creation ───────────────
    console.log('\n3. Apply 15% discount (after bill was generated)');
    const discountRes = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 15 },
      headers: authHeader,
    });
    assertEqual(discountRes.status, 200, 'discount applied to order');
    const orderAfterDiscount = discountRes.data.order;
    assertEqual(orderAfterDiscount.discount_amount, 150, 'discount = ₹150 (15% of ₹1000)');

    // ── Step 4: Re-generate bill — should sync discounted totals ─────
    console.log('\n4. Re-generate bill — verify bill synced with discounted order');
    const billResync = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: authHeader,
    });
    assertEqual(billResync.status, 200, 'bill re-generated (200, not 201 — existing bill)');
    const updatedBill = billResync.data.bill;

    // The bill should now reflect the discount
    assertEqual(updatedBill.discount_amount, 150, 'bill discount_amount = ₹150');
    assertEqual(updatedBill.total, orderAfterDiscount.total, `bill total matches order total (₹${orderAfterDiscount.total})`);
    assertEqual(updatedBill.balance, orderAfterDiscount.total, `bill balance = ₹${orderAfterDiscount.total}`);

    // ── Step 5: Pay the discounted bill ──────────────────────────────
    console.log('\n5. Pay discounted bill');
    const payRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: updatedBill.total },
      headers: authHeader,
    });
    assertEqual(payRes.status, 200, 'payment accepted');
    assertEqual(payRes.data.bill.payment_status, 'paid', 'bill paid in full');
    assertEqual(payRes.data.bill.balance, 0, 'balance = 0');

    // Verify the order is completed
    const finalOrder = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
    assertEqual(finalOrder.data.order.status, 'completed', 'order completed after payment');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario B: Add Items to Order After Bill Was Generated
    // This is the real bug hitting your 3-4 users — items added to an
    // order don't sync to the existing bill.
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B: Add Items After Bill ───');

    // Create order with 1 item
    const orderB = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-recon-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(orderB.status, 201, 'order B created');
    const orderIdB = orderB.data.order.id;
    const orderBTotal = orderB.data.order.total;

    // Generate bill BEFORE adding more items
    const billB = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderIdB },
      headers: authHeader,
    });
    assertEqual(billB.status, 201, 'bill B created');
    const billIdB = billB.data.bill.id;
    assertEqual(billB.data.bill.total, orderBTotal, `bill total = ₹${orderBTotal} (before adding items)`);

    // Add a second item to the existing order
    const addItemsRes = await api(baseUrl, `/api/orders/${orderIdB}/items`, {
      method: 'POST',
      body: { items: [{ product_id: 'prod-recon-2', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqual(addItemsRes.status, 200, 'item added to order');
    const orderAfterAdd = addItemsRes.data.order;
    assert(orderAfterAdd.total > orderBTotal, `order total increased (₹${orderBTotal} → ₹${orderAfterAdd.total})`);

    // The existing unpaid bill must stay in sync before it is re-generated.
    const billAfterAddBeforeRegeneration = await api(baseUrl, `/api/bills/${billIdB}`, { headers: authHeader });
    assertEqual(billAfterAddBeforeRegeneration.status, 200, 'existing bill remains readable after adding items');
    assertEqual(
      billAfterAddBeforeRegeneration.data.bill.subtotal,
      orderAfterAdd.subtotal,
      `bill subtotal (₹${billAfterAddBeforeRegeneration.data.bill.subtotal}) matches order subtotal (₹${orderAfterAdd.subtotal}) after adding items`,
    );

    // Re-generate bill — it should sync with the updated order total
    const billAfterAdd = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderIdB },
      headers: authHeader,
    });
    assertEqual(billAfterAdd.status, 200, 'bill re-generated (existing bill)');

    // Verify the bill reflects the added items
    const syncedBill = billAfterAdd.data.bill;
    assertEqual(syncedBill.total, orderAfterAdd.total, `bill total (₹${syncedBill.total}) matches order total (₹${orderAfterAdd.total}) after adding items`);

    // ═══ Scenario C: Item Discount After Bill Was Generated ═══
    console.log('\n─── Scenario C: Item Discount After Bill ───');
    const orderC = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-recon-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(orderC.status, 201, 'order C created');
    const orderIdC = orderC.data.order.id;
    const itemC = orderC.data.order.items[0];

    const billC = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderIdC },
      headers: authHeader,
    });
    assertEqual(billC.status, 201, 'bill C created before item discount');

    const itemDiscountRes = await api(baseUrl, `/api/orders/${orderIdC}/items/${itemC.id}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(itemDiscountRes.status, 200, 'item discount applied after bill creation');
    const orderAfterItemDiscount = (await api(baseUrl, `/api/orders/${orderIdC}`, { headers: authHeader })).data.order;
    const billAfterItemDiscount = await api(baseUrl, `/api/bills/${billC.data.bill.id}`, { headers: authHeader });
    assertEqual(billAfterItemDiscount.status, 200, 'existing bill remains readable after item discount');
    assertEqual(
      billAfterItemDiscount.data.bill.subtotal,
      orderAfterItemDiscount.subtotal,
      `bill subtotal (₹${billAfterItemDiscount.data.bill.subtotal}) matches order subtotal (₹${orderAfterItemDiscount.subtotal}) after item discount`,
    );

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
