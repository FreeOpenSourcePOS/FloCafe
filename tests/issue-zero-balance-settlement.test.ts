/**
 * Zero-balance settlement & split auto-completion.
 *
 * C1a/C1b/C1d: discounts that drive remaining balance to 0 leave the bill
 * stuck (payment_status != 'paid') and the subsequent settle is rejected
 * with 400 "Bill is already fully paid".
 * C1f: cancelling an item after split-check zeroes a sibling guest check;
 * that zero-total sibling is unpayable and blocks parent order completion.
 * H2: a refunded split sibling matches payment_status != 'paid' and blocks
 * parent order completion forever.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-zero-balance-settlement.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-zero-balance-'));
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
const { registerRoutes } = require('../main/routes/index');

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

function tableRow(db: any, id: any): any {
  return db.prepare(`SELECT id, status FROM tables WHERE id = ?`).get(id);
}

async function main(): Promise<void> {
  console.log('Zero-balance settlement & split auto-completion');
  const db = initTestDb();

  setSetting(db, 'discount_mode', 'both');
  setSetting(db, 'discount_max_amount', '0');
  setSetting(db, 'split_checks_enabled', 'true');

  const { authHeader: ownerAuth, userId: ownerId } = seedOwnerUser(db);
  const { userId: managerId } = seedManagerUser(db);
  seedCategory(db, 'cat-zb', 'ZB menu');
  seedProduct(db, 'prod-1000', 'cat-zb', 'Thousand', 1000);
  seedProduct(db, 'prod-400', 'cat-zb', 'Four hundred', 400);
  seedTable(db, 'table-zb', 9);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
  });
  registerRoutes(app);
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
  async function itemDiscount(orderId: any, itemId: any, body: any) {
    return api(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, { method: 'PATCH', body, headers: A });
  }
  async function refund(body: any) {
    return api(baseUrl, '/api/refunds', { method: 'POST', body, headers: A });
  }
  async function cancelItem(orderId: any, itemId: any, body: any = {}) {
    return api(baseUrl, `/api/orders/${orderId}/items/${itemId}/cancel`, { method: 'PATCH', body, headers: A });
  }
  async function newTakeawayOrder(productId: string, quantity = 1) {
    const create = await createOrder({ type: 'takeaway', items: [{ product_id: productId, quantity }] });
    assertEqual(create.status, 201, `takeaway order created (${productId})`);
    const gen = await generateBill(create.data.order.id);
    assertEqual(gen.status, 201, `bill generated for ${productId}`);
    return { orderId: create.data.order.id as any, billId: gen.data.bill.id as any };
  }

  try {
    // ── C1a: order discount drives balance to 0 ───────────────────────────────
    console.log('\n─── C1a: settle after order discount zeroes balance ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, 'C1a: dine-in created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'C1a: bill generated');
      const billId = gen.data.bill.id;
      await pay(billId, { method: 'cash', amount: 500 });
      const disc = await applyOrderDiscount(orderId, { discount_type: 'amount', discount_value: 500 });
      assertEqual(disc.status, 200, 'C1a: order discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'C1a: balance is 0 after discount');

      const settle = await pay(billId, { method: 'cash', amount: 100 });
      assert(settle.status >= 200 && settle.status < 300, `C1a: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      const afterSettle = billRow(db, billId);
      assertEqual(afterSettle.payment_status, 'paid', 'C1a: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'C1a: order completed after settle');
      if (tableRow(db, 'table-zb')?.status !== 'available') {
        db.prepare(`UPDATE tables SET status = 'available' WHERE id = ?`).run('table-zb');
      }
    }

    // ── C1b: bill applyDiscount drives balance to 0 ───────────────────────────
    console.log('\n─── C1b: settle after bill discount zeroes balance ───');
    {
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      await pay(billId, { method: 'cash', amount: 400 });
      const disc = await applyBillDiscount(billId, { type: 'amount', value: 600, reason: 'zb C1b' });
      assertEqual(disc.status, 200, 'C1b: bill discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'C1b: balance is 0 after discount');

      const settle = await pay(billId, { method: 'cash', amount: 50 });
      assert(settle.status >= 200 && settle.status < 300, `C1b: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      const afterSettle = billRow(db, billId);
      assertEqual(afterSettle.payment_status, 'paid', 'C1b: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'C1b: order completed after settle');
    }

    // ── C1d: item discount drives balance to 0 ────────────────────────────────
    console.log('\n─── C1d: settle after item discount zeroes balance ───');
    {
      const create = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-1000', quantity: 1 }] });
      assertEqual(create.status, 201, 'C1d: order created');
      const orderId = create.data.order.id;
      const itemId = create.data.order.items[0].id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'C1d: bill generated');
      const billId = gen.data.bill.id;
      await pay(billId, { method: 'cash', amount: 500 });
      const disc = await itemDiscount(orderId, itemId, { discount_type: 'amount', discount_value: 500 });
      assertEqual(disc.status, 200, 'C1d: item discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'C1d: balance is 0 after discount');

      const settle = await pay(billId, { method: 'cash', amount: 100 });
      assert(settle.status >= 200 && settle.status < 300, `C1d: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      const afterSettle = billRow(db, billId);
      assertEqual(afterSettle.payment_status, 'paid', 'C1d: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'C1d: order completed after settle');
    }

    // ── C1f: zero-total split sibling auto-closes ─────────────────────────────
    console.log('\n─── C1f: zero-total sibling auto-closes, order completes ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      assertEqual(create.status, 201, 'C1f: dine-in created');
      const orderId = create.data.order.id;
      const items = create.data.order.items as any[];
      const itemA = items.find((i: any) => i.product_id === 'prod-1000');
      const itemB = items.find((i: any) => i.product_id === 'prod-400');
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'C1f: bill generated');
      const split = await api(baseUrl, `/api/bills/${gen.data.bill.id}/split-check`, {
        method: 'POST',
        body: {
          checks: [
            { label: 'Guest A', items: [{ order_item_id: itemA.id, quantity: 1 }] },
            { label: 'Guest B', items: [{ order_item_id: itemB.id, quantity: 1 }] },
          ],
        },
        headers: A,
      });
      assertEqual(split.status, 201, 'C1f: split created');
      const checkA = split.data.bills[0];
      const checkB = split.data.bills[1];

      const cancelB = await cancelItem(orderId, itemB.id, { reason: 'zb C1f' });
      assertEqual(cancelB.status, 200, 'C1f: item B cancelled after split');
      const bAfter = billRow(db, checkB.id);
      assertEqual(Number(bAfter.total), 0, 'C1f: sibling B total is 0');
      assertEqual(bAfter.payment_status, 'paid', 'C1f: zero-total sibling auto-closed as paid');

      const payA = await pay(checkA.id, { method: 'cash', amount: null });
      assertEqual(payA.status, 200, 'C1f: pay A succeeds');
      const ordFinal = orderRow(db, orderId);
      assertEqual(ordFinal.status, 'completed', 'C1f: order completed after A paid');
      assert(tableRow(db, 'table-zb')?.status === 'available', 'C1f: table freed');
    }

    // ── H2: refunded split sibling does not block completion ──────────────────
    console.log('\n─── H2: refunded sibling does not block order completion ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [{ product_id: 'prod-1000', quantity: 2 }],
      });
      assertEqual(create.status, 201, 'H2: dine-in created');
      const orderId = create.data.order.id;
      const itemId = create.data.order.items[0].id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'H2: bill generated');
      const split = await api(baseUrl, `/api/bills/${gen.data.bill.id}/split-check`, {
        method: 'POST',
        body: {
          checks: [
            { label: 'Guest A', items: [{ order_item_id: itemId, quantity: 1 }] },
            { label: 'Guest B', items: [{ order_item_id: itemId, quantity: 1 }] },
          ],
        },
        headers: A,
      });
      assertEqual(split.status, 201, 'H2: split created');
      const billA = split.data.bills[0];
      const billB = split.data.bills[1];

      const payA = await pay(billA.id, { method: 'cash', amount: null });
      assertEqual(payA.status, 200, 'H2: paid A');
      const liveA = billRow(db, billA.id);
      const refA = await refund({
        bill_id: billA.id,
        amount: Number(liveA.paid_amount),
        method: 'cash',
        reason: 'zb H2',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(refA.status, 201, 'H2: refunded A');
      assertEqual(billRow(db, billA.id).payment_status, 'refunded', 'H2: A is refunded');

      const payB = await pay(billB.id, { method: 'cash', amount: null });
      assertEqual(payB.status, 200, 'H2: paid B');
      const ordFinal = orderRow(db, orderId);
      assertEqual(ordFinal.status, 'completed', 'H2: order completed after B paid + A refunded');
      assert(tableRow(db, 'table-zb')?.status === 'available', 'H2: table freed');
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
