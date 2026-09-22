/**
 * Terminal-state & refund mutation guards.
 *
 * Covers proven defects where payment/discount/item mutations ignored
 * terminal order or refunded-bill state:
 * - C2: paying a bill on a cancelled order flips it to completed
 * - H1a: accepting a new payment on a fully refunded bill
 * - H1b: applying discounts to refunded / partially refunded bills
 * - H1c: adding items to an order whose bill was refunded
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-terminal-state-guards.test.ts
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

const { orderRoutes } = require('../main/routes/orders');
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
    // ── C2: payment on a cancelled order must not resurrect it ───────────────
    console.log('\n─── C2: cancelled order stays cancelled after payment ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-tsg',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, 'C2: dine-in order created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'C2: bill generated');
      const billId = gen.data.bill.id;

      const cancel = await setOrderStatus(orderId, { status: 'cancelled', reason: 'tsg C2' });
      assertEqual(cancel.status, 200, 'C2: order cancelled');
      assertEqual(orderRow(db, orderId).status, 'cancelled', 'C2: status is cancelled before payment');

      const paid = await pay(billId, { method: 'cash', amount: null });
      assertEqual(paid.status, 200, 'C2: bill payment still accepted');
      assertEqual(
        orderRow(db, orderId).status,
        'cancelled',
        'C2: cancelled order is not flipped to completed by payment',
      );
    }

    // ── H1a: reject payment on a fully refunded bill ─────────────────────────
    console.log('\n─── H1a: payment rejected on refunded bill ───');
    {
      const { billId } = await newTakeawayOrder('prod-1000');
      const partial = await pay(billId, { method: 'cash', amount: 500 });
      assertEqual(partial.status, 200, 'H1a: partial payment accepted');
      const ref = await refund({
        bill_id: billId,
        amount: 500,
        method: 'cash',
        reason: 'tsg H1a',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'H1a: refund created');
      assertEqual(billRow(db, billId).payment_status, 'refunded', 'H1a: bill is refunded');

      const pay2 = await pay(billId, { method: 'cash', amount: 100 });
      assertEqual(pay2.status, 409, 'H1a: post-refund payment rejected with 409');
      const after = billRow(db, billId);
      assertEqual(after.paid_amount, 500, 'H1a: paid_amount unchanged after rejected payment');
      assertEqual(after.payment_status, 'refunded', 'H1a: still refunded after rejected payment');
    }

    // ── H1b: reject discounts on refunded / partially refunded bills ─────────
    console.log('\n─── H1b: discounts rejected on refunded bills ───');
    {
      // Fully refunded bill: order-level discount must not rewrite totals.
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      await pay(billId, { method: 'cash', amount: 500 });
      const ref = await refund({
        bill_id: billId,
        amount: 500,
        method: 'cash',
        reason: 'tsg H1b full',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'H1b: full refund of paid amount created');
      const beforeFull = billRow(db, billId);
      assertEqual(beforeFull.payment_status, 'refunded', 'H1b: bill fully refunded');

      const orderDisc = await applyOrderDiscount(orderId, { discount_type: 'amount', discount_value: 100 });
      assertEqual(orderDisc.status, 409, 'H1b: order discount on refunded bill rejected with 409');
      const afterOrderDisc = billRow(db, billId);
      assertEqual(Number(afterOrderDisc.total), Number(beforeFull.total), 'H1b: bill total unchanged after rejected order discount');
      assertEqual(
        Number(afterOrderDisc.discount_amount),
        Number(beforeFull.discount_amount),
        'H1b: bill discount_amount unchanged after rejected order discount',
      );

      const billDisc = await applyBillDiscount(billId, { type: 'amount', value: 50 });
      assertEqual(billDisc.status, 409, 'H1b: bill discount on refunded bill rejected with 409');

      // Partially refunded bill (full payment, partial refund).
      const second = await newTakeawayOrder('prod-1000');
      await pay(second.billId, { method: 'cash', amount: null });
      const partialRef = await refund({
        bill_id: second.billId,
        amount: 400,
        method: 'cash',
        reason: 'tsg H1b partial',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(partialRef.status, 201, 'H1b: partial refund created');
      assertEqual(billRow(db, second.billId).payment_status, 'partially_refunded', 'H1b: bill partially refunded');

      const partialDisc = await applyBillDiscount(second.billId, { type: 'amount', value: 50 });
      assertEqual(partialDisc.status, 409, 'H1b: bill discount on partially refunded bill rejected with 409');
    }

    // ── H1c: reject add-items when the bill was refunded ─────────────────────
    console.log('\n─── H1c: add-items rejected on refunded order ───');
    {
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      await pay(billId, { method: 'cash', amount: 500 });
      const ref = await refund({
        bill_id: billId,
        amount: 500,
        method: 'cash',
        reason: 'tsg H1c',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'H1c: refund created');
      const before = billRow(db, billId);
      assertEqual(before.payment_status, 'refunded', 'H1c: bill refunded');

      const add = await addItems(orderId, [{ product_id: 'prod-400', quantity: 1 }]);
      assertEqual(add.status, 409, 'H1c: add-items on refunded order rejected with 409');
      const after = billRow(db, billId);
      assertEqual(Number(after.subtotal), Number(before.subtotal), 'H1c: bill subtotal unchanged');
      assertEqual(Number(after.total), Number(before.total), 'H1c: bill total unchanged');
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
