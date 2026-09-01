/**
 * Integration Test: Payment Integrity
 *
 * Tests payment edge cases that protect against money bugs:
 * A) Split payments (cash + UPI)
 * B) Wallet double-spend prevention
 * C) Zero-amount rejection
 * D) No loyalty credit without customer
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-payments.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payments-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedCustomer, seedWalletCredit,
  api, assert, assertEqual, assertIncludes,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { customerRoutes } = require('../main/routes/customers');

async function main() {
  console.log('Integration Test: Payment Integrity');
  console.log('='.repeat(50));

  const db = initTestDb();
  db.prepare("INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES ('UPI', 1, 10, ?, ?)").run(now(), now());

  // Seed base data
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-pay', 'Payment Test Menu');
  seedProduct(db, 'prod-pay-1', 'cat-pay', 'Burger', 500);
  seedProduct(db, 'prod-pay-2', 'cat-pay', 'Fries', 200);
  seedCustomer(db, 'cust-wallet', 'Wallet User', '9876543210');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/customers': customerRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Scenario A: Split Payment (cash + UPI)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario A: Split Payment ───');

    // Create order
    const orderA = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-pay-1', quantity: 2 }] },
      headers: authHeader,
    });
    assertEqual(orderA.status, 201, 'order A created');
    const orderAId = orderA.data.order.id;
    const orderATotal = orderA.data.order.total;

    // Generate bill
    const billA = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderAId },
      headers: authHeader,
    });
    assertEqual(billA.status, 201, 'bill A created');
    const billAId = billA.data.bill.id;
    const billATotal = billA.data.bill.total;

    // First payment: 60% with cash
    const partialAmount = Math.floor(billATotal * 0.6);
    const pay1 = await api(baseUrl, `/api/bills/${billAId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: partialAmount },
      headers: authHeader,
    });
    assertEqual(pay1.status, 200, 'first payment accepted');
    assertEqual(pay1.data.bill.payment_status, 'partial', 'status = partial after first payment');
    assertEqual(pay1.data.bill.balance, billATotal - partialAmount, `balance = ${billATotal - partialAmount}`);

    // Second payment: remaining with UPI
    const remainingAmount = billATotal - partialAmount;
    const pay2 = await api(baseUrl, `/api/bills/${billAId}/payment`, {
      method: 'POST',
      body: { method: 'upi', amount: remainingAmount },
      headers: authHeader,
    });
    assertEqual(pay2.status, 200, 'second payment accepted');
    assertEqual(pay2.data.bill.payment_status, 'paid', 'status = paid after second payment');
    assertEqual(pay2.data.bill.balance, 0, 'balance = 0');

    // Verify both payments recorded
    const payments = Array.isArray(pay2.data.bill.payment_details)
      ? pay2.data.bill.payment_details
      : JSON.parse(pay2.data.bill.payment_details);
    assertEqual(payments.length, 2, 'two payments recorded');
    assertEqual(payments[0].method, 'cash', 'first payment is cash');
    assertEqual(payments[1].method, 'UPI', 'second payment is UPI');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario B: Wallet Double-Spend Prevention
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B: Wallet Double-Spend ───');

    // Disable loyalty so cashback isn't credited during payment —
    // this test verifies wallet balance depletion, not loyalty earn
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'false', ?)").run(now());

    // Redemption rate is fixed at 1 point = ₹1 (see LOYALTY_REDEMPTION_RATE in bills.ts).
    // Give customer ₹600 wallet balance (600 points) — enough for first order (₹500 + tax ≈ ₹525)
    // but NOT enough for second order (₹200 + tax ≈ ₹210)
    seedWalletCredit(db, 'cust-wallet', 600);

    // Create first order (₹500)
    const orderB1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-wallet',
        items: [{ product_id: 'prod-pay-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(orderB1.status, 201, 'order B1 created');
    const orderB1Total = orderB1.data.order.total;

    // Generate bill and pay with wallet
    const billB1 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderB1.data.order.id },
      headers: authHeader,
    });
    const payB1 = await api(baseUrl, `/api/bills/${billB1.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: billB1.data.bill.total, customer_id: 'cust-wallet' },
      headers: authHeader,
    });
    assertEqual(payB1.status, 200, 'wallet payment B1 succeeded');

    // Create second order
    const orderB2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-wallet',
        items: [{ product_id: 'prod-pay-2', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(orderB2.status, 201, 'order B2 created');

    // Generate bill and try to pay with wallet (should fail — balance depleted)
    const billB2 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderB2.data.order.id },
      headers: authHeader,
    });
    const payB2 = await api(baseUrl, `/api/bills/${billB2.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: billB2.data.bill.total, customer_id: 'cust-wallet' },
      headers: authHeader,
    });
    assertEqual(payB2.status, 400, 'wallet payment B2 rejected (400)');
    assertIncludes(payB2.data.error, 'Insufficient', 'error mentions insufficient balance');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario C: Zero-Amount Rejection
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario C: Zero-Amount Rejection ───');

    // Create order and bill
    const orderC = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-pay-1', quantity: 1 }] },
      headers: authHeader,
    });
    const billC = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderC.data.order.id },
      headers: authHeader,
    });

    // Try to pay ₹0 — should be rejected, not treated as "pay full amount"
    const payC = await api(baseUrl, `/api/bills/${billC.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 0 },
      headers: authHeader,
    });
    assertEqual(payC.status, 400, 'amount=0 rejected with 400');
    assertIncludes(payC.data.error, 'greater than zero', 'error mentions amount must be positive');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario D: No Loyalty Credit Without Customer
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario D: No Loyalty Without Customer ───');

    // Enable loyalty
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)").run(now());

    // Create order WITHOUT customer_id
    const orderD = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-pay-1', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqual(orderD.status, 201, 'order D created (no customer)');

    const billD = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderD.data.order.id },
      headers: authHeader,
    });

    const payD = await api(baseUrl, `/api/bills/${billD.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: billD.data.bill.total },
      headers: authHeader,
    });
    assertEqual(payD.status, 200, 'payment accepted');
    assertEqual(payD.data.loyaltyPointsEarned, 0, 'no loyalty points earned (no customer)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario E: Paying a Fully Paid Bill (Idempotency)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario E: Paying a Fully Paid Bill ───');

    // Create order and bill, pay it fully
    const orderE = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-pay-1', quantity: 1 }] },
      headers: authHeader,
    });
    const billE = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderE.data.order.id },
      headers: authHeader,
    });
    const payE1 = await api(baseUrl, `/api/bills/${billE.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: billE.data.bill.total },
      headers: authHeader,
    });
    assertEqual(payE1.status, 200, 'first payment accepted');
    assertEqual(payE1.data.bill.payment_status, 'paid', 'bill is paid');

    // Try to pay again — should be rejected
    const payE2 = await api(baseUrl, `/api/bills/${billE.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 100 },
      headers: authHeader,
    });
    assertEqual(payE2.status, 400, 'second payment rejected (already paid)');
    assertIncludes(payE2.data.error, 'already paid', 'error mentions already paid');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario F: Missing Payment Method
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario F: Missing Payment Method ───');

    const orderF = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-pay-1', quantity: 1 }] },
      headers: authHeader,
    });
    const billF = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderF.data.order.id },
      headers: authHeader,
    });

    // Try to pay without method
    const payF = await api(baseUrl, `/api/bills/${billF.data.bill.id}/payment`, {
      method: 'POST',
      body: { amount: 500 },
      headers: authHeader,
    });
    assertEqual(payF.status, 400, 'missing method rejected (400)');
    assertIncludes(payF.data.error, 'method', 'error mentions payment method');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario G: Wallet Balance State After Split Payments
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario G: Wallet Balance After Split ───');

    // Keep loyalty disabled (redemption rate is fixed at 1 point = ₹1)
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'false', ?)").run(now());

    seedCustomer(db, 'cust-split', 'Split Payment Customer', '9999999999');
    // Give 1000 points (₹1000 at 1:1 — plenty for half of ₹525 bill)
    seedWalletCredit(db, 'cust-split', 1000);

    // Create order for ₹500 + tax
    const orderG = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-split',
        items: [{ product_id: 'prod-pay-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    const billG = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderG.data.order.id },
      headers: authHeader,
    });
    const billGTotal = Number(billG.data.bill.total);

    // Pay half with wallet
    const walletPayG = Math.floor(billGTotal / 2);
    const payG1 = await api(baseUrl, `/api/bills/${billG.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: walletPayG, customer_id: 'cust-split' },
      headers: authHeader,
    });
    assertEqual(payG1.status, 200, 'wallet payment accepted');
    assertEqual(payG1.data.bill.payment_status, 'partial', 'bill is partially paid');

    // Verify wallet balance decreased by walletPayG points (1:1 rate)
    const walletAfterG1 = await api(baseUrl, '/api/customers/cust-split/wallet', { headers: authHeader });
    const expectedBalanceG1 = 1000 - walletPayG;
    assertEqual(walletAfterG1.data.balance, expectedBalanceG1, `wallet balance = ${expectedBalanceG1} after first wallet payment`);

    // Pay remaining with cash
    const cashPayG = billGTotal - walletPayG;
    const payG2 = await api(baseUrl, `/api/bills/${billG.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: cashPayG },
      headers: authHeader,
    });
    assertEqual(payG2.status, 200, 'cash payment accepted');
    assertEqual(payG2.data.bill.payment_status, 'paid', 'bill is fully paid');

    // Wallet balance should remain the same (cash payment doesn't affect wallet)
    const walletAfterG2 = await api(baseUrl, '/api/customers/cust-split/wallet', { headers: authHeader });
    assertEqual(walletAfterG2.data.balance, expectedBalanceG1, 'wallet balance unchanged after cash payment');

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
