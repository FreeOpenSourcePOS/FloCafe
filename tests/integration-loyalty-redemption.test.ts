/**
 * Integration Test: Loyalty Points Redemption
 *
 * Tests the loyalty redemption workflow end-to-end:
 * 1. Redemption rate is applied correctly during wallet payment
 * 2. Points are deducted at the correct rate (currency × redemption_rate)
 * 3. Cashback is only earned on non-wallet portions
 * 4. Insufficient wallet balance is rejected
 *
 * Bug this catches: redemption_rate was stored but never used —
 * wallet debits were in currency, not points, so customers got
 * way more value than they should.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-loyalty-redemption.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-loyalty-redemption-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedCustomer, seedWalletCredit,
  api, assert, assertEqual, assertGreaterThan,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { customerRoutes } = require('../main/routes/customers');
const { settingsRoutes } = require('../main/routes/settings');

async function main() {
  console.log('Integration Test: Loyalty Points Redemption');
  console.log('='.repeat(50));

  const db = initTestDb();

  // Enable loyalty. Earning comes solely from each product's cb_percent;
  // redemption uses the fixed in-code rate (100 points = 1 currency unit).
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)").run(now());

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-redeem', 'Redemption Test Menu');
  seedProduct(db, 'prod-redeem-1', 'cat-redeem', 'Coffee', 100, { cb_percent: 0 }); // No cashback
  seedProduct(db, 'prod-redeem-2', 'cat-redeem', 'Sandwich', 200, { cb_percent: 5 }); // 5% cashback
  seedCustomer(db, 'cust-redeem', 'Redemption Customer', '1111111111');
  seedCustomer(db, 'cust-redeem-2', 'Redemption Customer 2', '2222222222');
  seedCustomer(db, 'cust-redeem-3', 'Redemption Customer 3', '3333333333');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/customers': customerRoutes,
    '/api/settings': settingsRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Scenario 1: Redemption rate applied correctly
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 1: Redemption rate applied correctly ───');

    // Give customer 500 points (worth ₹5 at 100:1 rate)
    seedWalletCredit(db, 'cust-redeem', 500);

    // Verify wallet balance
    const wallet1 = await api(baseUrl, '/api/customers/cust-redeem/wallet', { headers: authHeader });
    assertEqual(wallet1.status, 200, 'wallet endpoint returns 200');
    assertEqual(wallet1.data.balance, 500, 'wallet balance = 500 points');

    // Create order for ₹100
    const order1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem',
        items: [{ product_id: 'prod-redeem-1', quantity: 1 }],
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
    const bill1Total = Number(bill1.data.bill.total);

    // Pay ₹5 with wallet (should debit 500 points = 5 × 100 redemption rate)
    const pay1 = await api(baseUrl, `/api/bills/${bill1.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: 5, customer_id: 'cust-redeem' },
      headers: authHeader,
    });
    assertEqual(pay1.status, 200, 'wallet payment accepted');
    assertEqual(pay1.data.bill.payment_status, 'partial', 'bill is partially paid');

    // Verify wallet balance is now 0 (500 - 500 = 0)
    const wallet1After = await api(baseUrl, '/api/customers/cust-redeem/wallet', { headers: authHeader });
    assertEqual(wallet1After.data.balance, 0, 'wallet balance = 0 after ₹5 redemption');

    // Verify debit entry in ledger
    const debitEntry1 = db.prepare(
      "SELECT * FROM loyalty_ledger WHERE customer_id = 'cust-redeem' AND type = 'debit' AND bill_id = ?"
    ).get(bill1.data.bill.id) as any;
    assert(debitEntry1 !== undefined, 'debit entry exists');
    assertEqual(debitEntry1.amount, 500, 'debit = 500 points (₹5 × 100 rate)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 2: Insufficient wallet balance rejected
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 2: Insufficient wallet balance rejected ───');

    // Give customer only 100 points (worth ₹1)
    seedWalletCredit(db, 'cust-redeem-2', 100);

    const order2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem-2',
        items: [{ product_id: 'prod-redeem-1', quantity: 1 }], // ₹100
      },
      headers: authHeader,
    });
    assertEqual(order2.status, 201, 'order 2 created');

    const bill2 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order2.data.order.id },
      headers: authHeader,
    });
    const bill2Total = Number(bill2.data.bill.total);

    // Try to pay full bill with wallet (need bill2Total × 100 points, only have 100)
    // 100 points can only cover ₹1, so trying to pay full bill should fail
    const pay2 = await api(baseUrl, `/api/bills/${bill2.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: bill2Total, customer_id: 'cust-redeem-2' },
      headers: authHeader,
    });
    assertEqual(pay2.status, 400, 'wallet payment rejected (400)');
    assert(pay2.data.error.includes('Insufficient'), 'error mentions insufficient balance');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 3: Cashback only on non-wallet portion
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 3: Cashback only on non-wallet portion ───');

    // Give customer 50000 points (worth ₹500 at 100:1 rate — plenty for half of ₹210 bill)
    seedWalletCredit(db, 'cust-redeem', 50000);

    // Create order for ₹200 (Sandwich with 5% cashback = 10 points)
    const order3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem',
        items: [{ product_id: 'prod-redeem-2', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(order3.status, 201, 'order 3 created');

    const bill3 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order3.data.order.id },
      headers: authHeader,
    });
    const bill3Total = Number(bill3.data.bill.total);

    // Pay half with wallet — requires half × 100 points
    const walletPay3 = Math.floor(bill3Total / 2);
    const pay3Wallet = await api(baseUrl, `/api/bills/${bill3.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: walletPay3, customer_id: 'cust-redeem' },
      headers: authHeader,
    });
    assertEqual(pay3Wallet.status, 200, 'wallet payment accepted');

    // Pay remaining with cash
    const cashPay3 = bill3Total - walletPay3;
    const pay3Cash = await api(baseUrl, `/api/bills/${bill3.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: cashPay3, customer_id: 'cust-redeem' },
      headers: authHeader,
    });
    assertEqual(pay3Cash.status, 200, 'cash payment accepted');
    assertEqual(pay3Cash.data.bill.payment_status, 'paid', 'bill is fully paid');

    // Cashback should be proportional to cash-paid portion
    // Full cashback: 5% of ₹200 (subtotal) = 10 currency units = 1000 points
    // Cash-paid proportion: cashPay3 / bill3Total
    // Actual cashback: floor(10 * (cashPay3 / bill3Total)) * 100
    const expectedCashback3 = Math.floor(10 * (cashPay3 / bill3Total)) * 100;
    const creditEntry3 = db.prepare(
      "SELECT amount FROM loyalty_ledger WHERE customer_id = 'cust-redeem' AND type = 'credit' AND bill_id = ?"
    ).get(bill3.data.bill.id) as any;
    assert(creditEntry3 !== undefined, 'credit entry exists');
    assertEqual(creditEntry3.amount, expectedCashback3, `cashback = ${expectedCashback3} points (${Math.round(cashPay3/bill3Total*100)}% paid with cash)`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 4: Full wallet payment — no cashback
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 4: Full wallet payment — no cashback ───');

    // Give customer 50000 points (worth ₹500 at 100:1 rate — enough for any bill)
    seedWalletCredit(db, 'cust-redeem', 50000);

    // Create order for ₹100 (Coffee, cb_percent=0 — would earn nothing anyway)
    const order4 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem',
        items: [{ product_id: 'prod-redeem-1', quantity: 1 }],
      },
      headers: authHeader,
    });

    const bill4 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order4.data.order.id },
      headers: authHeader,
    });
    const bill4Total = Number(bill4.data.bill.total);

    // Pay full amount with wallet — requires bill4Total × 100 points
    const pay4 = await api(baseUrl, `/api/bills/${bill4.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: bill4Total, customer_id: 'cust-redeem' },
      headers: authHeader,
    });
    assertEqual(pay4.status, 200, 'full wallet payment accepted');
    assertEqual(pay4.data.bill.payment_status, 'paid', 'bill is fully paid');

    // No cashback should be credited (100% paid with wallet)
    const creditEntry4 = db.prepare(
      "SELECT * FROM loyalty_ledger WHERE customer_id = 'cust-redeem' AND type = 'credit' AND bill_id = ?"
    ).get(bill4.data.bill.id) as any;
    assert(creditEntry4 === undefined, 'no credit entry for full wallet payment');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 5: Mixed payment — partial wallet, partial cash
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 5: Mixed payment — partial wallet + partial cash ───');

    // Give customer 50000 points (worth ₹500 at 100:1 rate)
    seedWalletCredit(db, 'cust-redeem-3', 50000);

    // Create order for ₹200 (Sandwich, 5% cashback)
    const order5 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem-3',
        items: [{ product_id: 'prod-redeem-2', quantity: 1 }],
      },
      headers: authHeader,
    });

    const bill5 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order5.data.order.id },
      headers: authHeader,
    });
    const bill5Total = Number(bill5.data.bill.total);

    // Pay 10% with wallet
    const walletPay5 = Math.floor(bill5Total * 0.1);
    const pay5Wallet = await api(baseUrl, `/api/bills/${bill5.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: walletPay5, customer_id: 'cust-redeem-3' },
      headers: authHeader,
    });
    assertEqual(pay5Wallet.status, 200, 'wallet payment accepted');

    // Pay remaining with cash
    const cashPay5 = bill5Total - walletPay5;
    const pay5Cash = await api(baseUrl, `/api/bills/${bill5.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: cashPay5, customer_id: 'cust-redeem-3' },
      headers: authHeader,
    });
    assertEqual(pay5Cash.status, 200, 'cash payment accepted');

    // Cashback: proportional to cash-paid portion
    // Full cashback: 5% of ₹200 (subtotal) = 10 currency units = 1000 points
    // Cash-paid proportion: cashPay5 / bill5Total
    const expectedCashback5 = Math.floor(10 * (cashPay5 / bill5Total)) * 100;
    const creditEntry5 = db.prepare(
      "SELECT amount FROM loyalty_ledger WHERE customer_id = 'cust-redeem-3' AND type = 'credit' AND bill_id = ?"
    ).get(bill5.data.bill.id) as any;
    assert(creditEntry5 !== undefined, 'credit entry exists');
    assertEqual(creditEntry5.amount, expectedCashback5, `cashback = ${expectedCashback5} points (${Math.round(cashPay5/bill5Total*100)}% paid with cash)`);

    // Final wallet balance: 50000 (seeded) - walletPay5*100 (debit) + expectedCashback5 (cashback)
    const expectedBalance5 = 50000 - (walletPay5 * 100) + expectedCashback5;
    const wallet5After = await api(baseUrl, '/api/customers/cust-redeem-3/wallet', { headers: authHeader });
    assertEqual(wallet5After.data.balance, expectedBalance5, `final wallet balance = ${expectedBalance5} points`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 6: Legacy expires_at no longer affects wallet balance (#78)
    // ═══════════════════════════════════════════════════════════════════
    // The loyalty system is a single on/off switch now — points never expire.
    // A leftover expires_at on an old ledger row (from before that simplification)
    // must not make its credit vanish from the balance: since debits aren't paired
    // to specific credits, dropping an expired credit while its spend stays in the
    // debit sum silently collapses the customer's balance. Legacy rows also get
    // expires_at cleared by migration v21, but the balance query itself must not
    // depend on the column either.
    console.log('\n─── Scenario 6: legacy expires_at ignored in wallet balance ───');

    seedCustomer(db, 'cust-redeem-4', 'Legacy Expiry Customer', '4444444444');

    seedWalletCredit(db, 'cust-redeem-4', 1000);
    // Manually insert a credit with a past expires_at, simulating a pre-migration row.
    db.prepare(
      `INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, expires_at, created_at, updated_at)
       VALUES (?, NULL, 'credit', ?, 'Legacy credit with stale expiry', datetime('now', '-1 month'), datetime('now', '-2 month'), datetime('now', '-2 month'))`
    ).run('cust-redeem-4', 500);

    // Wallet balance must include all credits regardless of expires_at.
    const wallet6 = await api(baseUrl, '/api/customers/cust-redeem-4/wallet', { headers: authHeader });
    assertEqual(wallet6.status, 200, 'wallet endpoint returns 200');
    assertEqual(wallet6.data.balance, 1500, 'wallet balance = 1500 (legacy expires_at ignored)');
    assert(wallet6.data.next_expiry === undefined, 'next_expiry field no longer exists on the wallet payload');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 7: Wallet payment when loyalty is disabled
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 7: Wallet payment when loyalty disabled ───');

    // Disable loyalty earning (but wallet should still work for existing points)
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'false', ?)").run(now());

    seedCustomer(db, 'cust-redeem-5', 'Disabled Loyalty Customer', '5555555555');
    seedWalletCredit(db, 'cust-redeem-5', 50000); // 50000 points = ₹500 (enough for bill with tax)

    const order7 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem-5',
        items: [{ product_id: 'prod-redeem-1', quantity: 1 }], // ₹100 + tax
      },
      headers: authHeader,
    });
    assertEqual(order7.status, 201, 'order 7 created');

    const bill7 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order7.data.order.id },
      headers: authHeader,
    });
    const bill7Total = Number(bill7.data.bill.total);

    // Wallet payment should still work even when loyalty earning is disabled
    const pay7 = await api(baseUrl, `/api/bills/${bill7.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: bill7Total, customer_id: 'cust-redeem-5' },
      headers: authHeader,
    });
    assertEqual(pay7.status, 200, 'wallet payment accepted even with loyalty disabled');
    assertEqual(pay7.data.bill.payment_status, 'paid', 'bill is fully paid');
    // No cashback should be earned since loyalty is disabled
    assertEqual(pay7.data.loyaltyPointsEarned, 0, 'no cashback earned (loyalty disabled)');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 8: Negative wallet amount rejected
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 8: Negative wallet amount rejected ───');

    seedCustomer(db, 'cust-redeem-6', 'Negative Amount Customer', '6666666666');
    seedWalletCredit(db, 'cust-redeem-6', 5000);

    const order8 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem-6',
        items: [{ product_id: 'prod-redeem-1', quantity: 1 }],
      },
      headers: authHeader,
    });

    const bill8 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order8.data.order.id },
      headers: authHeader,
    });

    // Try to pay with negative amount
    const pay8 = await api(baseUrl, `/api/bills/${bill8.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: -100, customer_id: 'cust-redeem-6' },
      headers: authHeader,
    });
    assertEqual(pay8.status, 400, 'negative amount rejected with 400');
    assert(pay8.data.error.includes('greater than zero'), 'error mentions amount must be positive');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario 9: Overpayment capped at remaining balance
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario 9: Overpayment capped at remaining balance ───');

    seedCustomer(db, 'cust-redeem-7', 'Overpayment Customer', '7777777777');
    seedWalletCredit(db, 'cust-redeem-7', 100000); // Plenty of points

    const order9 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-redeem-7',
        items: [{ product_id: 'prod-redeem-1', quantity: 1 }],
      },
      headers: authHeader,
    });

    const bill9 = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order9.data.order.id },
      headers: authHeader,
    });
    const bill9Total = Number(bill9.data.bill.total);

    // Try to pay more than the bill total
    const pay9 = await api(baseUrl, `/api/bills/${bill9.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'wallet', amount: bill9Total + 1000, customer_id: 'cust-redeem-7' },
      headers: authHeader,
    });
    assertEqual(pay9.status, 200, 'overpayment accepted (capped internally)');
    assertEqual(pay9.data.bill.payment_status, 'paid', 'bill is fully paid');
    assertEqual(pay9.data.bill.balance, 0, 'balance = 0');
    // Verify only the correct amount was debited (bill9Total × 100 rate)
    const expectedDebit9 = Math.ceil(bill9Total * 100);
    const debitEntry9 = db.prepare(
      "SELECT amount FROM loyalty_ledger WHERE customer_id = 'cust-redeem-7' AND type = 'debit' AND bill_id = ?"
    ).get(bill9.data.bill.id) as any;
    assert(debitEntry9 !== undefined, 'debit entry exists');
    assertEqual(debitEntry9.amount, expectedDebit9, `debit = ${expectedDebit9} points (capped at bill total)`);

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
