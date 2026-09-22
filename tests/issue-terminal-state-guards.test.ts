/**
 * Payment, discount, and add-items must not mutate cancelled orders or refunded bills.
 * Run: node tests/run-electron-node-test.cjs tests/issue-terminal-state-guards.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-terminal-state-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct, seedTable,
  api, assert, assertEqual, getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');

function setSetting(db: any, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

function billRow(db: any, id: any): any {
  return db.prepare(
    `SELECT id, payment_status, subtotal, discount_amount, total, paid_amount, balance, order_id
     FROM bills WHERE id = ?`,
  ).get(id);
}

function orderRow(db: any, id: any): any {
  return db.prepare(`SELECT id, status, table_id, subtotal, discount_amount, total FROM orders WHERE id = ?`).get(id);
}

async function main(): Promise<void> {
  console.log('Terminal-state & refund mutation guards');
  const db = initTestDb();

  setSetting(db, 'discount_mode', 'both');
  setSetting(db, 'discount_max_amount', '0');
  setSetting(db, 'split_checks_enabled', 'true');

  const { authHeader: ownerAuth, userId: ownerId } = seedOwnerUser(db);
  const { userId: managerId } = seedManagerUser(db);
  seedCategory(db, 'cat-tsg', 'TSG menu');
  seedProduct(db, 'prod-1000', 'cat-tsg', 'Thousand', 1000);
  seedProduct(db, 'prod-400', 'cat-tsg', 'Four hundred', 400);
  seedTable(db, 'table-tsg', 3);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const A = ownerAuth;
  const pin = '1234';
  const approver = managerId;

  async function createOrder(body: any) {
    return api(baseUrl, '/api/orders', { method: 'POST', body, headers: A });
  }
  async function generateBill(orderId: any) {
    return api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orderId }, headers: A });
  }
  async function pay(billId: any, body: any) {
    return api(baseUrl, `/api/bills/${billId}/payment`, { method: 'POST', body, headers: A });
  }
  async function applyBillDiscount(billId: any, body: any) {
    return api(baseUrl, `/api/bills/${billId}/applyDiscount`, { method: 'POST', body, headers: A });
  }
  async function applyOrderDiscount(orderId: any, body: any) {
    return api(baseUrl, `/api/orders/${orderId}/discount`, { method: 'PATCH', body, headers: A });
  }
  async function refund(body: any) {
    return api(baseUrl, '/api/refunds', { method: 'POST', body, headers: A });
  }
  async function addItems(orderId: any, items: any[]) {
    return api(baseUrl, `/api/orders/${orderId}/items`, { method: 'POST', body: { items }, headers: A });
  }
  async function setOrderStatus(orderId: any, body: any) {
    return api(baseUrl, `/api/orders/${orderId}/status`, { method: 'PATCH', body, headers: A });
  }
  async function newTakeawayOrder(productId: string, quantity = 1) {
    const create = await createOrder({ type: 'takeaway', items: [{ product_id: productId, quantity }] });
    assertEqual(create.status, 201, `takeaway order created (${productId})`);
    const gen = await generateBill(create.data.order.id);
    assertEqual(gen.status, 201, `bill generated for ${productId}`);
    return { orderId: create.data.order.id as any, billId: gen.data.bill.id as any };
  }

  try {
    // ── payment must not flip cancelled order to completed ──
    console.log('\n─── cancelled-order-payment: cancelled order stays cancelled after payment ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-tsg',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, 'cancelled-order-payment: dine-in order created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'cancelled-order-payment: bill generated');
      const billId = gen.data.bill.id;

      const cancel = await setOrderStatus(orderId, { status: 'cancelled', reason: 'tsg cancelled-order-payment' });
      assertEqual(cancel.status, 200, 'cancelled-order-payment: order cancelled');
      assertEqual(orderRow(db, orderId).status, 'cancelled', 'cancelled-order-payment: status is cancelled before payment');

      const paid = await pay(billId, { method: 'cash', amount: null });
      assertEqual(paid.status, 200, 'cancelled-order-payment: bill payment still accepted');
      assertEqual(
        orderRow(db, orderId).status,
        'cancelled',
        'cancelled-order-payment: cancelled order is not flipped to completed by payment',
      );
    }

    // ── reject payment on fully refunded bill ──
    console.log('\n─── payment-refund-guard: payment rejected on refunded bill ───');
    {
      const { billId } = await newTakeawayOrder('prod-1000');
      const partial = await pay(billId, { method: 'cash', amount: 500 });
      assertEqual(partial.status, 200, 'payment-refund-guard: partial payment accepted');
      const ref = await refund({
        bill_id: billId,
        amount: 500,
        method: 'cash',
        reason: 'tsg payment-refund-guard',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'payment-refund-guard: refund created');
      assertEqual(billRow(db, billId).payment_status, 'refunded', 'payment-refund-guard: bill is refunded');

      const pay2 = await pay(billId, { method: 'cash', amount: 100 });
      assertEqual(pay2.status, 409, 'payment-refund-guard: post-refund payment rejected with 409');
      const after = billRow(db, billId);
      assertEqual(after.paid_amount, 500, 'payment-refund-guard: paid_amount unchanged after rejected payment');
      assertEqual(after.payment_status, 'refunded', 'payment-refund-guard: still refunded after rejected payment');
    }

    // ── reject payment on partially refunded bill ──
    console.log('\n─── payment-refund-guard: payment rejected on partially refunded bill ───');
    {
      resetPinRateLimitForTests();
      const { billId } = await newTakeawayOrder('prod-1000');
      const full = await pay(billId, { method: 'cash', amount: null });
      assertEqual(full.status, 200, 'partial-payment-refund: full payment accepted');
      const ref = await refund({
        bill_id: billId,
        amount: 400,
        method: 'cash',
        reason: 'tsg payment-refund-guard partial',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'partial-payment-refund: partial refund created');
      const before = billRow(db, billId);
      assertEqual(before.payment_status, 'partially_refunded', 'partial-payment-refund: bill partially refunded');

      const pay2 = await pay(billId, { method: 'cash', amount: 100 });
      assertEqual(pay2.status, 409, 'partial-payment-refund: payment rejected with 409');
      const after = billRow(db, billId);
      assertEqual(after.payment_status, 'partially_refunded', 'partial-payment-refund: still partially_refunded after rejected payment');
      assertEqual(after.paid_amount, before.paid_amount, 'partial-payment-refund: paid_amount unchanged');
    }

    // ── reject discounts on refunded bills ──
    console.log('\n─── discount-refund-guard: discounts rejected on refunded bills ───');
    {
      // Fully refunded: order discount must not rewrite totals.
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      await pay(billId, { method: 'cash', amount: 500 });
      const ref = await refund({
        bill_id: billId,
        amount: 500,
        method: 'cash',
        reason: 'tsg discount-refund-guard full',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'discount-refund-guard: full refund of paid amount created');
      const beforeFull = billRow(db, billId);
      assertEqual(beforeFull.payment_status, 'refunded', 'discount-refund-guard: bill fully refunded');

      const orderDisc = await applyOrderDiscount(orderId, { discount_type: 'amount', discount_value: 100 });
      assertEqual(orderDisc.status, 409, 'discount-refund-guard: order discount on refunded bill rejected with 409');
      const afterOrderDisc = billRow(db, billId);
      assertEqual(Number(afterOrderDisc.total), Number(beforeFull.total), 'discount-refund-guard: bill total unchanged after rejected order discount');
      assertEqual(
        Number(afterOrderDisc.discount_amount),
        Number(beforeFull.discount_amount),
        'discount-refund-guard: bill discount_amount unchanged after rejected order discount',
      );

      const billDisc = await applyBillDiscount(billId, { type: 'amount', value: 50 });
      assertEqual(billDisc.status, 409, 'discount-refund-guard: bill discount on refunded bill rejected with 409');

      // Partially refunded (full pay, partial refund).
      const second = await newTakeawayOrder('prod-1000');
      await pay(second.billId, { method: 'cash', amount: null });
      const partialRef = await refund({
        bill_id: second.billId,
        amount: 400,
        method: 'cash',
        reason: 'tsg discount-refund-guard partial',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(partialRef.status, 201, 'discount-refund-guard: partial refund created');
      assertEqual(billRow(db, second.billId).payment_status, 'partially_refunded', 'discount-refund-guard: bill partially refunded');

      const partialDisc = await applyBillDiscount(second.billId, { type: 'amount', value: 50 });
      assertEqual(partialDisc.status, 409, 'discount-refund-guard: bill discount on partially refunded bill rejected with 409');
    }

    // ── reject add-items when bill refunded ──
    console.log('\n─── add-items-refund-guard: add-items rejected on refunded order ───');
    {
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      await pay(billId, { method: 'cash', amount: 500 });
      const ref = await refund({
        bill_id: billId,
        amount: 500,
        method: 'cash',
        reason: 'tsg add-items-refund-guard',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'add-items-refund-guard: refund created');
      const before = billRow(db, billId);
      assertEqual(before.payment_status, 'refunded', 'add-items-refund-guard: bill refunded');

      const add = await addItems(orderId, [{ product_id: 'prod-400', quantity: 1 }]);
      assertEqual(add.status, 409, 'add-items-refund-guard: add-items on refunded order rejected with 409');
      const after = billRow(db, billId);
      assertEqual(Number(after.subtotal), Number(before.subtotal), 'add-items-refund-guard: bill subtotal unchanged');
      assertEqual(Number(after.total), Number(before.total), 'add-items-refund-guard: bill total unchanged');
    }

    // ── reject add-items when bill partially refunded ──
    console.log('\n─── add-items-refund-guard: add-items rejected on partially refunded order ───');
    {
      resetPinRateLimitForTests();
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const partialPay = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(partialPay.status, 200, 'partial-refund-add-items: partial payment accepted');
      assertEqual(orderRow(db, orderId).status !== 'completed', true, 'partial-refund-add-items: order still active after partial payment');
      const ref = await refund({
        bill_id: billId,
        amount: 200,
        method: 'cash',
        reason: 'tsg add-items-refund-guard partial',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'partial-refund-add-items: partial refund created');
      const before = billRow(db, billId);
      assertEqual(before.payment_status, 'partially_refunded', 'partial-refund-add-items: bill partially refunded');

      const add = await addItems(orderId, [{ product_id: 'prod-400', quantity: 1 }]);
      assertEqual(add.status, 409, 'partial-refund-add-items: add-items rejected with 409');
      const after = billRow(db, billId);
      assertEqual(Number(after.subtotal), Number(before.subtotal), 'partial-refund-add-items: bill subtotal unchanged');
      assertEqual(Number(after.total), Number(before.total), 'partial-refund-add-items: bill total unchanged');
    }

    // ── reject item discount when bill refunded/partial ──
    console.log('\n─── Item discount rejected on partially refunded bill ───');
    {
      resetPinRateLimitForTests();
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const partialPay = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(partialPay.status, 200, 'item-disc: partial payment accepted');
      const ref = await refund({
        bill_id: billId,
        amount: 200,
        method: 'cash',
        reason: 'tsg item discount',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'item-disc: partial refund created');
      const itemRow = db.prepare('SELECT id FROM order_items WHERE order_id = ? LIMIT 1').get(orderId) as any;
      const before = billRow(db, billId);

      const disc = await api(baseUrl, `/api/orders/${orderId}/items/${itemRow.id}/discount`, {
        method: 'PATCH',
        body: { discount_type: 'amount', discount_value: 50 },
        headers: A,
      });
      assertEqual(disc.status, 409, 'item-disc: discount on partially refunded bill rejected with 409');
      const after = billRow(db, billId);
      assertEqual(Number(after.total), Number(before.total), 'item-disc: bill total unchanged');
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
