/**
 * Integration Test: Loyalty Earning Is Per-Item Only
 *
 * The loyalty program was simplified to a single on/off switch — there is no
 * more global "points per currency" fallback. Points earned come solely from
 * each product's own cb_percent; products with cb_percent=0 earn nothing.
 *
 * Scenarios:
 * 1. Product with cb_percent=0 earns zero cashback
 * 2. Mixed cart — only the item with cb_percent>0 earns cashback
 * 3. Discounted order — cashback on discounted subtotal
 * 4. Customer list API returns updated wallet_balance
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-loyalty-global-rate.test.ts
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
  api, assert, assertEqual, assertGreaterThan,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { customerRoutes } = require('../main/routes/customers');

async function main() {
  console.log('Integration Test: Loyalty Earning Is Per-Item Only');
  console.log('='.repeat(50));

  const db = initTestDb();

  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_max_percentage', '50', ?)").run(now());

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-global', 'Global Rate Menu');

  // Product A: cb_percent=0 (earns nothing — no global fallback anymore)
  seedProduct(db, 'prod-global-a', 'cat-global', 'Coffee', 100, { cb_percent: 0 });

  // Product B: cb_percent=10 (earns based on its own rate)
  seedProduct(db, 'prod-global-b', 'cat-global', 'Sandwich', 200, { cb_percent: 10 });

  seedCustomer(db, 'cust-global-1', 'Global Test Customer', '1111111111');
  seedCustomer(db, 'cust-global-2', 'Discount Customer', '2222222222');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/customers': customerRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Scenario 1: Product with cb_percent=0 earns zero cashback
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 1: cb_percent=0 earns nothing ───');

    const order1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-global-1',
        items: [{ product_id: 'prod-global-a', quantity: 2 }], // 2× ₹100 = ₹200
      },
      headers: authHeader,
    });
    assertEqual(order1.status, 201, 'order 1 created');

    const bill1 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order1.data.order.id },
      headers: authHeader,
    });
    assertEqual(bill1.status, 201, 'bill 1 created');

    const pay1 = await api(baseUrl, `/api/bills/${bill1.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: bill1.data.bill.total, customer_id: 'cust-global-1' },
      headers: authHeader,
    });
    assertEqual(pay1.status, 200, 'payment accepted');
    assertEqual(pay1.data.bill.payment_status, 'paid', 'bill paid');
    assertEqual(pay1.data.loyaltyPointsEarned, 0, 'no points earned for cb_percent=0 item');

    const ledger1 = db.prepare(
      "SELECT * FROM loyalty_ledger WHERE customer_id = 'cust-global-1' AND type = 'credit' AND bill_id = ?"
    ).get(bill1.data.bill.id) as any;
    assert(ledger1 === undefined, 'no loyalty credit entry created');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 2: Mixed cart — only the cb_percent>0 item earns
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 2: Mixed cart (cb_percent=0 item earns nothing) ───');

    const order2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-global-1',
        items: [
          { product_id: 'prod-global-a', quantity: 1 }, // ₹100, cb_percent=0 → 0
          { product_id: 'prod-global-b', quantity: 1 }, // ₹200, cb_percent=10 → 20
        ],
      },
      headers: authHeader,
    });
    assertEqual(order2.status, 201, 'order 2 created');

    const bill2 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order2.data.order.id },
      headers: authHeader,
    });

    const pay2 = await api(baseUrl, `/api/bills/${bill2.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: bill2.data.bill.total, customer_id: 'cust-global-1' },
      headers: authHeader,
    });
    assertEqual(pay2.status, 200, 'payment accepted');

    // Coffee: cb_percent=0 → 0, Sandwich: floor(200 × 10/100) = 20 → total = 20 * 100 = 2000
    const ledger2 = db.prepare(
      "SELECT amount FROM loyalty_ledger WHERE customer_id = 'cust-global-1' AND type = 'credit' AND bill_id = ?"
    ).get(bill2.data.bill.id) as any;
    assertEqual(ledger2.amount, 2000, 'cashback = 2000 points (only from the cb_percent=10 item)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 3: Discounted order — cashback on discounted subtotal
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 3: Discounted order ───');

    const order3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-global-2',
        items: [{ product_id: 'prod-global-b', quantity: 2 }], // 2× ₹200 = ₹400, cb_percent=10
      },
      headers: authHeader,
    });
    assertEqual(order3.status, 201, 'order 3 created');

    // Apply 50% discount
    const bill3Gen = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order3.data.order.id },
      headers: authHeader,
    });
    const discountRes = await api(baseUrl, `/api/bills/${bill3Gen.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 50, reason: 'Test discount' },
      headers: authHeader,
    });
    assertEqual(discountRes.status, 200, 'discount applied');

    // Pay — cashback should be on discounted subtotal (₹200, not ₹400)
    const pay3 = await api(baseUrl, `/api/bills/${bill3Gen.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: discountRes.data.bill.total, customer_id: 'cust-global-2' },
      headers: authHeader,
    });
    assertEqual(pay3.status, 200, 'payment accepted');

    // Discounted subtotal = ₹200, cb_percent = 10 → cashback = floor(200 × 10/100) = 20 * 100 = 2000
    const ledger3 = db.prepare(
      "SELECT amount FROM loyalty_ledger WHERE customer_id = 'cust-global-2' AND type = 'credit' AND bill_id = ?"
    ).get(bill3Gen.data.bill.id) as any;
    assertEqual(ledger3.amount, 2000, 'cashback = 2000 points (₹200 discounted × cb_percent 10)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 4: Customer list API returns updated wallet_balance
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 4: Customer API wallet_balance ───');

    const customers = await api(baseUrl, '/api/customers', { headers: authHeader });
    assertEqual(customers.status, 200, 'customers list returned');

    const cust1 = customers.data.data.find((c: any) => c.id === 'cust-global-1');
    assert(cust1 !== undefined, 'cust-global-1 found in list');
    // Total earned: 0 (scenario 1) + 2000 (scenario 2) = 2000
    assertEqual(cust1.wallet_balance, 2000, 'wallet_balance = 2000 points (0 + 2000)');

    const cust2 = customers.data.data.find((c: any) => c.id === 'cust-global-2');
    assert(cust2 !== undefined, 'cust-global-2 found in list');
    assertEqual(cust2.wallet_balance, 2000, 'wallet_balance = 2000 points (discounted order)');

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
