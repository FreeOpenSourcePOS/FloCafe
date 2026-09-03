const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-currency-pay-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes, paymentAmountMinorUnits, getTenantCurrency } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { settingsRoutes } = require('../main/routes/settings');
const { getRefundableBalance, createRefund } = require('../main/services/refund');
const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } = require('../main/countries');

async function main() {
  console.log('--- Currency Minor-Unit Payments & Refunds Test Suite ---');

  // ── 1. Unit Tests: paymentAmountMinorUnits ────────────────────────
  console.log('\n1. Payment Amount Minor Unit Validation:');

  // JPY: 0 decimals, factor 1
  assertEqual(paymentAmountMinorUnits(1500, 'JPY'), 1500, 'JPY number 1500 returns 1500 minor units');
  assertEqual(paymentAmountMinorUnits('1500', 'JPY'), 1500, 'JPY string 1500 returns 1500 minor units');
  let errThrown = false;
  try {
    paymentAmountMinorUnits('1500.5', 'JPY');
  } catch (err: any) {
    errThrown = true;
    assertEqual(err.statusCode, 400, 'JPY fractional payment returns 400');
    assert(err.message.includes('without decimals'), 'Error message specifies without decimals for JPY');
  }
  assert(errThrown, 'JPY fractional amount was rejected');

  // USD: 2 decimals, factor 100
  assertEqual(paymentAmountMinorUnits(10.5, 'USD'), 1050, 'USD 10.5 returns 1050 minor units');
  assertEqual(paymentAmountMinorUnits('10.50', 'USD'), 1050, 'USD 10.50 returns 1050 minor units');
  assertEqual(paymentAmountMinorUnits('10', 'USD'), 1000, 'USD 10 returns 1000 minor units');
  errThrown = false;
  try {
    paymentAmountMinorUnits('10.555', 'USD');
  } catch (err: any) {
    errThrown = true;
    assertEqual(err.statusCode, 400, 'USD 3-decimal payment returns 400');
    assert(err.message.includes('at most 2 decimal places'), 'Error specifies at most 2 decimal places for USD');
  }
  assert(errThrown, 'USD >2 decimals was rejected');

  // KWD: 3 decimals, factor 1000
  assertEqual(paymentAmountMinorUnits(1.255, 'KWD'), 1255, 'KWD 1.255 returns 1255 minor units');
  assertEqual(paymentAmountMinorUnits('1.255', 'KWD'), 1255, 'KWD string 1.255 returns 1255 minor units');
  assertEqual(paymentAmountMinorUnits('1.25', 'KWD'), 1250, 'KWD string 1.25 returns 1250 minor units');
  errThrown = false;
  try {
    paymentAmountMinorUnits('1.2555', 'KWD');
  } catch (err: any) {
    errThrown = true;
    assertEqual(err.statusCode, 400, 'KWD 4-decimal payment returns 400');
    assert(err.message.includes('at most 3 decimal places'), 'Error specifies at most 3 decimal places for KWD');
  }
  assert(errThrown, 'KWD >3 decimals was rejected');

  // IRR: 2 decimals, factor 100 (Rial)
  assertEqual(paymentAmountMinorUnits(50000, 'IRR'), 5000000, 'IRR 50000 rials returns 5000000 minor units');
  assertEqual(paymentAmountMinorUnits('50000.00', 'IRR'), 5000000, 'IRR 50000.00 returns 5000000 minor units');

  // ── 2. Integration Tests with Test Database & HTTP Server ────────
  console.log('\n2. Full Payment & Refund Flow Verification:');
  const db = initTestDb();
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { authHeader: managerAuth } = seedManagerUser(db);

  seedCategory(db, 'cat-main', 'Main Category');
  seedProduct(db, 'prod-jpy', 'cat-main', 'JPY Item', 1500);
  seedProduct(db, 'prod-kwd', 'cat-main', 'KWD Item', 1.255);
  seedProduct(db, 'prod-usd', 'cat-main', 'USD Item', 10.50);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/settings': settingsRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ── Test A: JPY Payment & Refund Flow ────────────────────────────
    console.log('\n  Testing JPY Flow (0 decimals):');
    // Set tenant currency to JPY
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'JPY', ?)").run(now());
    assertEqual(getTenantCurrency(db), 'JPY', 'Tenant currency is JPY');

    // Create JPY order and bill
    const jpyOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-jpy', quantity: 1 }] },
      headers: ownerAuth,
    });
    assertEqual(jpyOrderRes.status, 201, 'JPY order created');
    const jpyBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: jpyOrderRes.data.order.id },
      headers: ownerAuth,
    });
    assertEqual(jpyBillRes.status, 201, 'JPY bill generated');
    const jpyBillId = jpyBillRes.data.bill.id;
    assertEqual(Number(jpyBillRes.data.bill.total), 1500, 'JPY bill total is 1500');

    // Attempt paying with fractional amount in JPY -> Must fail with 400
    const failJpyPay = await api(baseUrl, `/api/bills/${jpyBillId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 1500.5 },
      headers: ownerAuth,
    });
    assertEqual(failJpyPay.status, 400, 'Fractional JPY payment rejected with 400');

    // Pay with integer amount in JPY -> Succeeds
    const successJpyPay = await api(baseUrl, `/api/bills/${jpyBillId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 1500 },
      headers: ownerAuth,
    });
    assertEqual(successJpyPay.status, 200, 'Integer JPY payment accepted');
    assertEqual(Number(successJpyPay.data.bill.paid_amount), 1500, 'JPY paid_amount is 1500');
    assertEqual(Number(successJpyPay.data.bill.balance), 0, 'JPY balance is 0');
    assertEqual(successJpyPay.data.bill.payment_status, 'paid', 'JPY bill is paid');

    // Verify refundable balance for JPY
    const jpyBalanceBefore = getRefundableBalance(db, jpyBillId, 'JPY');
    assertEqual(jpyBalanceBefore.paidCents, 1500, 'JPY paid minor units is 1500');
    assertEqual(jpyBalanceBefore.refundableCents, 1500, 'JPY refundable minor units is 1500');

    // Attempt fractional refund in JPY -> Must fail with 400
    const failJpyRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: jpyBillId,
        amount: 500.25,
        method: 'cash',
        override_pin: '1234',
      },
      headers: managerAuth,
    });
    assertEqual(failJpyRefund.status, 400, 'Fractional JPY refund rejected with 400');

    // Advance order item status so it is refund eligible
    const jpyOrderItem = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(jpyOrderRes.data.order.id) as any;
    db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(jpyOrderItem.id);

    // Process item refund in JPY
    const successJpyRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: jpyBillId,
        order_item_id: jpyOrderItem.id,
        amount: 1500,
        method: 'cash',
        override_pin: '1234',
      },
      headers: managerAuth,
    });
    assertEqual(successJpyRefund.status, 201, 'JPY item refund succeeded');
    assertEqual(successJpyRefund.data.refund.amount_cents, 1500, 'JPY refund stored 1500 minor units');
    assertEqual(successJpyRefund.data.bill.payment_status, 'refunded', 'JPY bill payment status updated to refunded');

    const jpyBalanceAfter = getRefundableBalance(db, jpyBillId, 'JPY');
    assertEqual(jpyBalanceAfter.refundableCents, 0, 'JPY refundable balance is 0 after full refund');

    // ── Test B: KWD Payment & Refund Flow ────────────────────────────
    console.log('\n  Testing KWD Flow (3 decimals):');
    // Set tenant currency to KWD
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'KWD', ?)").run(now());
    assertEqual(getTenantCurrency(db), 'KWD', 'Tenant currency is KWD');

    // Create KWD order and bill
    const kwdOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-kwd', quantity: 1 }] },
      headers: ownerAuth,
    });
    assertEqual(kwdOrderRes.status, 201, 'KWD order created');
    const kwdBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: kwdOrderRes.data.order.id },
      headers: ownerAuth,
    });
    assertEqual(kwdBillRes.status, 201, 'KWD bill generated');
    const kwdBillId = kwdBillRes.data.bill.id;
    assertEqual(Number(kwdBillRes.data.bill.total), 1.255, 'KWD bill total is 1.255');

    // Attempt paying with 4 decimal places in KWD -> Must fail with 400
    const failKwdPay = await api(baseUrl, `/api/bills/${kwdBillId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 1.2555 },
      headers: ownerAuth,
    });
    assertEqual(failKwdPay.status, 400, '4-decimal KWD payment rejected with 400');

    // Pay exact 3-decimal amount in KWD -> Succeeds
    const successKwdPay = await api(baseUrl, `/api/bills/${kwdBillId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 1.255 },
      headers: ownerAuth,
    });
    assertEqual(successKwdPay.status, 200, '3-decimal KWD payment accepted');
    assertEqual(Number(successKwdPay.data.bill.paid_amount), 1.255, 'KWD paid_amount is exactly 1.255');
    assertEqual(Number(successKwdPay.data.bill.balance), 0, 'KWD balance is 0');
    assertEqual(successKwdPay.data.bill.payment_status, 'paid', 'KWD bill is paid');

    // Verify refundable balance in KWD minor units (fils)
    const kwdBalanceBefore = getRefundableBalance(db, kwdBillId, 'KWD');
    assertEqual(kwdBalanceBefore.paidCents, 1255, 'KWD paid minor units is 1255 fils');
    assertEqual(kwdBalanceBefore.refundableCents, 1255, 'KWD refundable minor units is 1255 fils');

    // Advance order item status
    const kwdOrderItem = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(kwdOrderRes.data.order.id) as any;
    db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(kwdOrderItem.id);

    // Process item refund in KWD for 1.255
    const successKwdRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: kwdBillId,
        order_item_id: kwdOrderItem.id,
        amount: 1.255,
        method: 'cash',
        override_pin: '1234',
      },
      headers: managerAuth,
    });
    assertEqual(successKwdRefund.status, 201, 'KWD item refund succeeded');
    assertEqual(successKwdRefund.data.refund.amount_cents, 1255, 'KWD refund stored 1255 minor units (fils)');
    assertEqual(successKwdRefund.data.bill.payment_status, 'refunded', 'KWD bill payment status updated to refunded');

    const kwdBalanceAfter = getRefundableBalance(db, kwdBillId, 'KWD');
    assertEqual(kwdBalanceAfter.refundableCents, 0, 'KWD refundable balance is 0 after full refund');

    // ── Test C: USD Regression Invariance (2 decimals) ───────────────
    console.log('\n  Testing USD Flow (2 decimals regression check):');
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'USD', ?)").run(now());
    assertEqual(getTenantCurrency(db), 'USD', 'Tenant currency is USD');

    const usdOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-usd', quantity: 1 }] },
      headers: ownerAuth,
    });
    assertEqual(usdOrderRes.status, 201, 'USD order created');
    const usdBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: usdOrderRes.data.order.id },
      headers: ownerAuth,
    });
    assertEqual(usdBillRes.status, 201, 'USD bill generated');
    const usdBillId = usdBillRes.data.bill.id;
    assertEqual(Number(usdBillRes.data.bill.total), 10.50, 'USD bill total is 10.50');

    // Pay with 2-decimal amount
    const successUsdPay = await api(baseUrl, `/api/bills/${usdBillId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 10.50 },
      headers: ownerAuth,
    });
    assertEqual(successUsdPay.status, 200, '2-decimal USD payment accepted');
    assertEqual(Number(successUsdPay.data.bill.paid_amount), 10.50, 'USD paid_amount is 10.50');
    assertEqual(successUsdPay.data.bill.payment_status, 'paid', 'USD bill is paid');

    const usdBalanceBefore = getRefundableBalance(db, usdBillId, 'USD');
    assertEqual(usdBalanceBefore.paidCents, 1050, 'USD paid minor units is 1050 cents');
    assertEqual(usdBalanceBefore.refundableCents, 1050, 'USD refundable minor units is 1050 cents');

    console.log('\n✓ All currency payment and refund minor-unit tests passed successfully!');
    const results = getResults();
    if (results.failed > 0) {
      throw new Error(`${results.failed} assertion(s) failed`);
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
