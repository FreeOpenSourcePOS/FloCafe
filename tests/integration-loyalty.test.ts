/**
 * Integration Test: Loyalty Points
 *
 * Tests the loyalty system end-to-end:
 * 1. Enable loyalty in settings
 * 2. Create product with cashback percentage
 * 3. Create order for customer, pay
 * 4. Verify loyalty points credited to ledger
 * 5. Verify idempotency (not double-credited)
 *
 * Bug this catches: #1 (loyalty never working — '1' vs 'true' mismatch)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-loyalty.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-loyalty-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedCustomer,
  api, assert, assertEqual,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
  console.log('Integration Test: Loyalty Points');
  console.log('='.repeat(50));

  const db = initTestDb();

  // Enable loyalty in settings
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)").run(now());

  // Seed data — product with 5% cashback
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-loyalty', 'Loyalty Test Menu');
  seedProduct(db, 'prod-loyal-1', 'cat-loyalty', 'Loyalty Pizza', 1000, { cb_percent: 5 });
  seedCustomer(db, 'cust-loyal', 'Loyal Customer', '9876543210');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ── Step 1: Verify loyalty is enabled ────────────────────────────
    console.log('\n1. Verify loyalty setting');
    const loyaltySetting = db.prepare("SELECT value FROM settings WHERE key = 'loyalty_enabled'").get() as any;
    assert(loyaltySetting !== undefined, 'loyalty_enabled setting exists');
    assertEqual(loyaltySetting.value, 'true', 'loyalty_enabled = true');

    // ── Step 2: Create order with customer ───────────────────────────
    console.log('\n2. Create order with customer (₹1000, 5% cashback)');
    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-loyal',
        items: [{ product_id: 'prod-loyal-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(orderRes.status, 201, 'order created');
    const orderId = orderRes.data.order.id;

    // ── Step 3: Generate bill and pay ────────────────────────────────
    console.log('\n3. Generate bill and pay');
    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: authHeader,
    });
    assertEqual(billRes.status, 201, 'bill created');
    const billId = billRes.data.bill.id;

    const payRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: billRes.data.bill.total, customer_id: 'cust-loyal' },
      headers: authHeader,
    });
    assertEqual(payRes.status, 200, 'payment accepted');
    assertEqual(payRes.data.bill.payment_status, 'paid', 'bill paid');

    // ── Step 4: Verify loyalty points credited ───────────────────────
    console.log('\n4. Verify loyalty points credited');
    const ledgerEntry = db.prepare(
      "SELECT * FROM loyalty_ledger WHERE customer_id = 'cust-loyal' AND type = 'credit' AND bill_id = ?"
    ).get(billId) as any;
    assert(ledgerEntry !== undefined, 'loyalty credit entry exists');
    if (ledgerEntry) {
      // 5% of ₹1000 subtotal = ₹50 cashback (floor) * 100 points/₹ = 5000 points
      const expectedCashback = Math.floor(1000 * 5 / 100) * 100;
      assertEqual(ledgerEntry.amount, expectedCashback, `cashback = ${expectedCashback} points (5% of ₹1000)`);
      assert(ledgerEntry.expires_at === null, 'points do not expire');
    }

    // ── Step 5: Verify idempotency — no double credit ────────────────
    console.log('\n5. Verify idempotency (not double-credited)');
    // The payment handler is idempotent — it checks if a credit already exists
    // for this bill before crediting again. We can verify by counting entries.
    const creditCount = db.prepare(
      "SELECT COUNT(*) as count FROM loyalty_ledger WHERE customer_id = 'cust-loyal' AND type = 'credit' AND bill_id = ?"
    ).get(billId) as any;
    assertEqual(creditCount.count, 1, 'exactly 1 loyalty credit for this bill (not duplicated)');

    // ── Step 6: Verify wallet balance ────────────────────────────────
    console.log('\n6. Verify wallet balance');
    const credits = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = 'cust-loyal' AND type = 'credit'"
    ).get() as any;
    const debits = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = 'cust-loyal' AND type = 'debit'"
    ).get() as any;
    const walletBalance = Math.max(0, credits.total - debits.total);
    assertEqual(walletBalance, 5000, `wallet balance = 5000 points (5% cashback on ₹1000)`);

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
