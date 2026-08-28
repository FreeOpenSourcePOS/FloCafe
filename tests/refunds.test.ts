/**
 * Refund system regression coverage (#278): bill-level and item-level
 * refunds, mandatory manager-PIN approval, idempotency, and the
 * over-collection guard.
 *
 * NOTE on PIN rate limiting: checkPinRateLimit (main/routes/orders.ts) keys
 * its 5-attempt budget by client IP + action name only (`pin:127.0.0.1:refund`
 * for every call in this file, since all requests originate from localhost),
 * not by user or bill. Every refund call that reaches the PIN-approval step
 * (i.e. passes validation/eligibility/balance checks) consumes one budget
 * point, whether the PIN was right or wrong — calls rejected before that step
 * (missing bill, over-collection, ineligible item, missing PIN) cost nothing.
 * This file is deliberately ordered so exactly 5 calls reach that step before
 * the final rate-limit assertion; do not add another successful PIN-reaching
 * refund call before it without accounting for the shared budget.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-refunds-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { reportRoutes } = require('../main/routes/reports');
const { getJWTSecret } = require('../main/routes/auth');

async function main() {
  console.log('Issue #278: refund system');
  const db = initTestDb();
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  seedCategory(db, 'cat-refund', 'Refund menu');
  seedProduct(db, 'prod-refund', 'cat-refund', 'Refund item', 100);
  seedProduct(db, 'prod-refund-inv', 'cat-refund', 'Refund inventory item', 50, { track_inventory: true, stock_quantity: 20 });
  seedProduct(db, 'prod-refund-weighted', 'cat-refund', 'Weighted refund item', 80, {
    sale_unit: 'kg', allow_fractional_quantity: true, weight_precision: 3,
  });

  const forbiddenAuth = {
    Authorization: `Bearer ${jwt.sign({ userId: 'chef-refund', email: 'chef@test.local', role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/reports': reportRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  async function newPaidBill(productId: string, quantity = 1, headers = ownerAuth) {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: productId, quantity }] },
      headers,
    });
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: order.data.order.id }, headers,
    });
    const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: null }, headers,
    });
    return { order: order.data.order, bill: paid.data.bill };
  }

  try {
    // ── Product quantity policy is backend-authoritative ──────────────────
    const wholeUnitFraction = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-refund', quantity: 1.25 }] }, headers: ownerAuth,
    });
    assertEqual(wholeUnitFraction.status, 400, 'order creation rejects fractional quantity for a whole-unit product');
    const weightedOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-refund-weighted', quantity: 1.25 }] }, headers: ownerAuth,
    });
    assertEqual(weightedOrder.status, 201, 'order creation accepts fractional quantity for an enabled weighted product');
    const wholeUnitAppend = await api(baseUrl, `/api/orders/${weightedOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-refund', quantity: 0.5 }] }, headers: ownerAuth,
    });
    assertEqual(wholeUnitAppend.status, 400, 'order append rejects fractional quantity for a whole-unit product');
    db.prepare("UPDATE products SET allow_fractional_quantity = 1 WHERE id = 'prod-refund'").run();
    const inconsistentWholeUnit = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-refund', quantity: 0.5 }] }, headers: ownerAuth,
    });
    assertEqual(inconsistentWholeUnit.status, 400, 'order creation rejects fractional each-unit quantity even with inconsistent catalog metadata');
    db.prepare("UPDATE products SET allow_fractional_quantity = 0 WHERE id = 'prod-refund'").run();

    // ── Role gating ──────────────────────────────────────────────────────
    const { bill: gatedBill } = await newPaidBill('prod-refund');
    const gated = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: gatedBill.id, amount: 100, method: 'cash', override_pin: '1234' }, headers: forbiddenAuth,
    });
    assertEqual(gated.status, 403, 'a chef (non owner/manager/cashier) cannot create a refund');

    // ── PIN approval: missing (no budget cost) ─────────────────────────────
    const noPinBill = await newPaidBill('prod-refund');
    const noPin = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: noPinBill.bill.id, amount: 100, method: 'cash' }, headers: ownerAuth,
    });
    assertEqual(noPin.status, 400, 'a refund without override_pin is rejected');

    // ── PIN approval: wrong (budget point 1) ────────────────────────────────
    const wrongPinBill = await newPaidBill('prod-refund');
    const wrongPin = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: wrongPinBill.bill.id, amount: 100, method: 'cash', override_pin: '0000', manager_id: managerId }, headers: ownerAuth,
    });
    assertEqual(wrongPin.status, 403, 'a refund with the wrong manager PIN is rejected');

    // ── PIN approval: correct, + idempotency replay/mismatch (budget point 2) ──
    const idemBill = await newPaidBill('prod-refund');
    const idemHeaders = { ...ownerAuth, 'Idempotency-Key': 'refund-278-idem-1' };
    const idemBody = { bill_id: idemBill.bill.id, amount: 100, method: 'cash', reason: 'Customer complaint', override_pin: '1234', manager_id: managerId };
    const created = await api(baseUrl, '/api/refunds', { method: 'POST', body: idemBody, headers: idemHeaders });
    assertEqual(created.status, 201, 'a refund with a valid manager PIN is accepted');
    assertEqual(created.data.refund.approved_by, managerId, 'the approving manager id is persisted');
    assertEqual(created.data.bill.payment_status, 'refunded', 'a full-amount refund marks the bill refunded');

    const replay = await api(baseUrl, '/api/refunds', { method: 'POST', body: idemBody, headers: idemHeaders });
    assertEqual(replay.status, 201, 'replaying the same Idempotency-Key + body returns the stored response');
    assertEqual(replay.data.refund.id, created.data.refund.id, 'the replay does not create a second refund row');
    const refundCountAfterReplay = db.prepare('SELECT COUNT(*) AS n FROM refunds WHERE bill_id = ?').get(idemBill.bill.id) as any;
    assertEqual(refundCountAfterReplay.n, 1, 'the replay does not insert a duplicate refunds row');

    const mismatch = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { ...idemBody, amount: 50 }, headers: idemHeaders,
    });
    assertEqual(mismatch.status, 409, 'reusing an Idempotency-Key with a different body is rejected');

    // ── Over-collection guard (full refund succeeds = budget point 3) ─────
    const overBill = await newPaidBill('prod-refund');
    const overshoot = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: overBill.bill.id, amount: (Number(overBill.bill.paid_amount) + 0.01).toFixed(2), method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: ownerAuth,
    });
    assertEqual(overshoot.status, 400, 'a refund exceeding the paid amount is rejected');
    const exact = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: overBill.bill.id, amount: overBill.bill.paid_amount, method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: ownerAuth,
    });
    assertEqual(exact.status, 201, 'a refund exactly equal to the paid amount is accepted');
    assertEqual(exact.data.bill.payment_status, 'refunded', 'refunding exactly the paid amount marks the bill refunded');
    const noBalanceLeft = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: overBill.bill.id, amount: 1, method: 'cash', override_pin: '1234', manager_id: managerId }, headers: ownerAuth,
    });
    assertEqual(noBalanceLeft.status, 400, 'a further refund on a fully refunded bill is rejected before touching the PIN budget');

    // ── Two-hour eligibility window (rejected before PIN budget) ─────────
    const expiredBill = await newPaidBill('prod-refund');
    db.prepare("UPDATE orders SET created_at = datetime('now', '-121 minutes') WHERE id = ?").run(expiredBill.order.id);
    const expiredRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: expiredBill.bill.id, amount: expiredBill.bill.paid_amount, method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: ownerAuth,
    });
    assertEqual(expiredRefund.status, 409, 'a refund more than two hours after order creation is rejected');
    assertEqual(
      (db.prepare('SELECT COUNT(*) AS count FROM refunds WHERE bill_id = ?').get(expiredBill.bill.id) as any).count,
      0,
      'an expired refund does not create a refund row',
    );

    // ── Partial refund (budget point 4) ────────────────────────────────────
    const partialBill = await newPaidBill('prod-refund');
    const salesBeforePartialRefund = await api(baseUrl, '/api/reports/daily-stats', { headers: ownerAuth });
    const partialAmount = (Number(partialBill.bill.paid_amount) * 0.4).toFixed(2);
    const partial = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: partialBill.bill.id, amount: partialAmount, method: 'cash', override_pin: '1234', manager_id: managerId }, headers: ownerAuth,
    });
    assertEqual(partial.status, 201, 'a partial refund is accepted');
    assertEqual(partial.data.bill.payment_status, 'partially_refunded', 'a partial refund marks the bill partially_refunded');
    const salesAfterPartialRefund = await api(baseUrl, '/api/reports/daily-stats', { headers: ownerAuth });
    assertEqual(
      Number((salesBeforePartialRefund.data.sales - salesAfterPartialRefund.data.sales).toFixed(2)),
      Number(partialAmount),
      'paid-sales reporting subtracts a partial refund without dropping the whole bill',
    );
    const cashAfterPartialRefund = salesAfterPartialRefund.data.paymentMethods.find((row: any) => row.method === 'cash');
    assertEqual(cashAfterPartialRefund.total, salesAfterPartialRefund.data.sales, 'cash payment reporting includes refund lines as negative cash movement');

    const paymentDate = '2025-01-10T12:00:00.000Z';
    const refundDate = '2025-01-11T12:00:00.000Z';
    const paymentDetails = JSON.parse((db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(partialBill.bill.id) as any).payment_details);
    paymentDetails.forEach((line: any) => { line.timestamp = paymentDate; });
    db.prepare('UPDATE bills SET created_at = ?, paid_at = ?, payment_details = ? WHERE id = ?')
      .run(paymentDate, paymentDate, JSON.stringify(paymentDetails), partialBill.bill.id);
    db.prepare('UPDATE refunds SET created_at = ? WHERE bill_id = ?').run(refundDate, partialBill.bill.id);
    const paymentDay = await api(baseUrl, '/api/reports/summary?date=2025-01-10', { headers: ownerAuth });
    const lateRefundDay = await api(baseUrl, '/api/reports/summary?date=2025-01-11', { headers: ownerAuth });
    assertEqual(paymentDay.data.summary.bills.collected, partialBill.bill.paid_amount, 'payment-day revenue keeps the original payment when a refund is posted later');
    assertEqual(paymentDay.data.summary.paymentMethods[0].total, partialBill.bill.paid_amount, 'payment-day method total matches payment-day revenue');
    assertEqual(lateRefundDay.data.summary.bills.collected, -Number(partialAmount), 'late refund reduces revenue on the refund day');
    assertEqual(lateRefundDay.data.summary.paymentMethods[0].total, -Number(partialAmount), 'refund-day method total matches refund-day revenue');
    const overRemainder = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: partialBill.bill.id, amount: partialBill.bill.paid_amount, method: 'cash', override_pin: '1234', manager_id: managerId }, headers: ownerAuth,
    });
    assertEqual(overRemainder.status, 400, 'a refund exceeding the remaining refundable balance is rejected');

    // ── GET /api/refunds listing (no PIN, no budget cost) ──────────────────
    const list = await api(baseUrl, `/api/refunds?bill_id=${partialBill.bill.id}`, { headers: ownerAuth });
    assertEqual(list.status, 200, 'listing refunds for a bill succeeds');
    assertEqual(list.data.refunds.length, 1, 'the listing is filtered to the requested bill');
    assertEqual(list.data.refunds[0].bill_id, partialBill.bill.id, 'the listed refund belongs to the requested bill');

    // ── Bill not found (no budget cost) ─────────────────────────────────────
    const notFound = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: 999999999, amount: 10, method: 'cash', override_pin: '1234', manager_id: managerId }, headers: ownerAuth,
    });
    assertEqual(notFound.status, 404, 'a refund against a non-existent bill returns 404');

    // ── Split allocation ownership is checked before approval ─────────────
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'split_checks_enabled'").run();
    const splitOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', items: [{ product_id: 'prod-refund', quantity: 2 }] }, headers: ownerAuth,
    });
    const splitItem = splitOrder.data.order.items[0];
    db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(splitItem.id);
    const splitSource = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: splitOrder.data.order.id }, headers: ownerAuth,
    });
    const splitChecks = await api(baseUrl, `/api/bills/${splitSource.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Guest 1', items: [{ order_item_id: splitItem.id, quantity: 1 }] },
        { label: 'Guest 2', items: [{ order_item_id: splitItem.id, quantity: 1 }] },
      ] },
      headers: ownerAuth,
    });
    assertEqual(splitChecks.status, 201, 'split-refund fixture creates two guest checks');
    const partialAllocationRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: splitChecks.data.bills[0].id, order_item_id: splitItem.id, method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: ownerAuth,
    });
    assertEqual(partialAllocationRefund.status, 409, 'a split check cannot refund an order item it owns only partially');
    assertEqual((db.prepare('SELECT status FROM order_items WHERE id = ?').get(splitItem.id) as any).status, 'ready', 'rejected split refund preserves the shared item');

    // ── Item-level refund on a paid bill (budget point 5) ──────────────────
    const invItem = await newPaidBill('prod-refund-inv', 2);
    const stockBeforeReady = (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-refund-inv') as any).stock_quantity;
    assertEqual(stockBeforeReady, 18, 'stock is deducted when the order is created');
    const itemRow = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(invItem.order.id) as any;
    db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(itemRow.id);
    const itemRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: invItem.bill.id, order_item_id: itemRow.id, method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: ownerAuth,
    });
    assertEqual(itemRefund.status, 201, 'an item-level refund on a ready item is accepted');
    assertEqual(itemRefund.data.refund.order_item_id, itemRow.id, 'the refund records the order_item_id');
    assertEqual(itemRefund.data.refund.amount_cents, Math.round(Number(itemRow.total) * 100), "the refund amount matches the item's total");
    const stockAfterRefund = (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-refund-inv') as any).stock_quantity;
    assertEqual(stockAfterRefund, 18, 'inventory is NOT restored by an item-level refund');
    const refundedItem = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemRow.id) as any;
    assertEqual(refundedItem.status, 'refunded', 'the refunded item transitions to the refunded status');
    const mirroredRow = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(invItem.order.id) as any;
    assert(!!mirroredRow, 'a mirrored void_adjustment row is inserted for the refunded item');
    assertEqual(mirroredRow.total, -itemRow.total, 'the mirrored row negates the original total');

    const doubleRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST', body: { bill_id: invItem.bill.id, order_item_id: itemRow.id, method: 'cash', override_pin: '1234', manager_id: managerId }, headers: ownerAuth,
    });
    assertEqual(doubleRefund.status, 409, 'refunding an already-refunded item is rejected before touching the PIN budget');

    // ── Rate limiting: the shared PIN budget above is now exhausted ────────
    const sixthAttempt = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: wrongPinBill.bill.id, amount: 100, method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: ownerAuth,
    });
    assertEqual(sixthAttempt.status, 429, 'the 6th refund call reaching PIN approval is throttled regardless of a correct PIN');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  }
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
