/**
 * Zero-balance settle, zero-total split siblings, refunded/partially-refunded sibling completion,
 * cancel/restore after zero-close, and full-discount settle with no prior payment.
 * Run: node tests/run-electron-node-test.cjs tests/issue-zero-balance-settlement.test.ts
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
    // ── order discount zeroes balance, then settle ──
    console.log('\n─── order-discount-zero-balance: settle after order discount zeroes balance ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, 'order-discount-zero-balance: dine-in created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'order-discount-zero-balance: bill generated');
      const billId = gen.data.bill.id;
      await pay(billId, { method: 'cash', amount: 500 });
      const disc = await applyOrderDiscount(orderId, { discount_type: 'amount', discount_value: 500 });
      assertEqual(disc.status, 200, 'order-discount-zero-balance: order discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'order-discount-zero-balance: balance is 0 after discount');

      const settle = await pay(billId, { method: 'cash', amount: 100 });
      assert(settle.status >= 200 && settle.status < 300, `order-discount-zero-balance: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      const afterSettle = billRow(db, billId);
      assertEqual(afterSettle.payment_status, 'paid', 'order-discount-zero-balance: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'order-discount-zero-balance: order completed after settle');
      if (tableRow(db, 'table-zb')?.status !== 'available') {
        db.prepare(`UPDATE tables SET status = 'available' WHERE id = ?`).run('table-zb');
      }
    }

    // ── bill discount zeroes balance, then settle ──
    console.log('\n─── bill-discount-zero-balance: settle after bill discount zeroes balance ───');
    {
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      await pay(billId, { method: 'cash', amount: 400 });
      const disc = await applyBillDiscount(billId, { type: 'amount', value: 600, reason: 'zb bill-discount-zero-balance' });
      assertEqual(disc.status, 200, 'bill-discount-zero-balance: bill discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'bill-discount-zero-balance: balance is 0 after discount');

      const settle = await pay(billId, { method: 'cash', amount: 50 });
      assert(settle.status >= 200 && settle.status < 300, `bill-discount-zero-balance: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      const afterSettle = billRow(db, billId);
      assertEqual(afterSettle.payment_status, 'paid', 'bill-discount-zero-balance: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'bill-discount-zero-balance: order completed after settle');
    }

    // ── item discount zeroes balance, then settle ──
    console.log('\n─── item-discount-zero-balance: settle after item discount zeroes balance ───');
    {
      const create = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-1000', quantity: 1 }] });
      assertEqual(create.status, 201, 'item-discount-zero-balance: order created');
      const orderId = create.data.order.id;
      const itemId = create.data.order.items[0].id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'item-discount-zero-balance: bill generated');
      const billId = gen.data.bill.id;
      await pay(billId, { method: 'cash', amount: 500 });
      const disc = await itemDiscount(orderId, itemId, { discount_type: 'amount', discount_value: 500 });
      assertEqual(disc.status, 200, 'item-discount-zero-balance: item discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'item-discount-zero-balance: balance is 0 after discount');

      const settle = await pay(billId, { method: 'cash', amount: 100 });
      assert(settle.status >= 200 && settle.status < 300, `item-discount-zero-balance: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      const afterSettle = billRow(db, billId);
      assertEqual(afterSettle.payment_status, 'paid', 'item-discount-zero-balance: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'item-discount-zero-balance: order completed after settle');
    }

    // ── zero-total sibling auto-closes ──
    console.log('\n─── zero-total-split-sibling: zero-total sibling auto-closes, order completes ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      assertEqual(create.status, 201, 'zero-total-split-sibling: dine-in created');
      const orderId = create.data.order.id;
      const items = create.data.order.items as any[];
      const itemA = items.find((i: any) => i.product_id === 'prod-1000');
      const itemB = items.find((i: any) => i.product_id === 'prod-400');
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'zero-total-split-sibling: bill generated');
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
      assertEqual(split.status, 201, 'zero-total-split-sibling: split created');
      const checkA = split.data.bills[0];
      const checkB = split.data.bills[1];

      const cancelB = await cancelItem(orderId, itemB.id, { reason: 'zb zero-total-split-sibling' });
      assertEqual(cancelB.status, 200, 'zero-total-split-sibling: item B cancelled after split');
      const bAfter = billRow(db, checkB.id);
      assertEqual(Number(bAfter.total), 0, 'zero-total-split-sibling: sibling B total is 0');
      assertEqual(bAfter.payment_status, 'paid', 'zero-total-split-sibling: zero-total sibling auto-closed as paid');

      const payA = await pay(checkA.id, { method: 'cash', amount: null });
      assertEqual(payA.status, 200, 'zero-total-split-sibling: pay A succeeds');
      const ordFinal = orderRow(db, orderId);
      assertEqual(ordFinal.status, 'completed', 'zero-total-split-sibling: order completed after A paid');
      assert(tableRow(db, 'table-zb')?.status === 'available', 'zero-total-split-sibling: table freed');
    }

    // ── refunded sibling does not block completion ──
    console.log('\n─── refunded-sibling-completion: refunded sibling does not block order completion ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [{ product_id: 'prod-1000', quantity: 2 }],
      });
      assertEqual(create.status, 201, 'refunded-sibling-completion: dine-in created');
      const orderId = create.data.order.id;
      const itemId = create.data.order.items[0].id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'refunded-sibling-completion: bill generated');
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
      assertEqual(split.status, 201, 'refunded-sibling-completion: split created');
      const billA = split.data.bills[0];
      const billB = split.data.bills[1];

      const payA = await pay(billA.id, { method: 'cash', amount: null });
      assertEqual(payA.status, 200, 'refunded-sibling-completion: paid A');
      const liveA = billRow(db, billA.id);
      const refA = await refund({
        bill_id: billA.id,
        amount: Number(liveA.paid_amount),
        method: 'cash',
        reason: 'zb refunded-sibling-completion',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(refA.status, 201, 'refunded-sibling-completion: refunded A');
      assertEqual(billRow(db, billA.id).payment_status, 'refunded', 'refunded-sibling-completion: A is refunded');

      const payB = await pay(billB.id, { method: 'cash', amount: null });
      assertEqual(payB.status, 200, 'refunded-sibling-completion: paid B');
      const ordFinal = orderRow(db, orderId);
      assertEqual(ordFinal.status, 'completed', 'refunded-sibling-completion: order completed after B paid + A refunded');
      assert(tableRow(db, 'table-zb')?.status === 'available', 'refunded-sibling-completion: table freed');
    }

    // ── full discount with no prior payment settles ──
    console.log('\n─── full-discount-no-payment: settle after 100% discount with paid_amount=0 ───');
    {
      const create = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-1000', quantity: 1 }] });
      assertEqual(create.status, 201, 'full-discount-no-payment: order created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'full-discount-no-payment: bill generated');
      const billId = gen.data.bill.id;
      const disc = await applyBillDiscount(billId, { type: 'amount', value: 1000, reason: 'zb full-discount-no-payment' });
      assertEqual(disc.status, 200, 'full-discount-no-payment: 100% discount applied');
      const afterDisc = billRow(db, billId);
      assertEqual(Number(afterDisc.balance), 0, 'full-discount-no-payment: balance is 0 after discount');
      assertEqual(Number(afterDisc.paid_amount), 0, 'full-discount-no-payment: paid_amount stays 0');
      const settle = await pay(billId, { method: 'cash', amount: null });
      assert(settle.status >= 200 && settle.status < 300, `full-discount-no-payment: settle not rejected (got ${settle.status} ${JSON.stringify(settle.data)})`);
      assertEqual(billRow(db, billId).payment_status, 'paid', 'full-discount-no-payment: bill is paid after settle');
      assertEqual(orderRow(db, orderId).status, 'completed', 'full-discount-no-payment: order completed after settle');
    }

    // ── cancel is not blocked by a zero-closed sibling ──
    console.log('\n─── cancel-after-zero-close: cancel not blocked by zero-closed sibling ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      assertEqual(create.status, 201, 'cancel-after-zero-close: dine-in created');
      const orderId = create.data.order.id;
      const items = create.data.order.items as any[];
      const itemA = items.find((i: any) => i.product_id === 'prod-1000');
      const itemB = items.find((i: any) => i.product_id === 'prod-400');
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'cancel-after-zero-close: bill generated');
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
      assertEqual(split.status, 201, 'cancel-after-zero-close: split created');
      const checkB = split.data.bills[1];
      const cancelB = await cancelItem(orderId, itemB.id, { reason: 'zb cancel-after-zero-close B' });
      assertEqual(cancelB.status, 200, 'cancel-after-zero-close: B cancelled');
      assertEqual(billRow(db, checkB.id).payment_status, 'paid', 'cancel-after-zero-close: B zero-closed as paid');
      const cancelA = await cancelItem(orderId, itemA.id, { reason: 'zb cancel-after-zero-close A' });
      assertEqual(cancelA.status, 200, 'cancel-after-zero-close: A still cancellable despite zero-closed sibling');
      if (tableRow(db, 'table-zb')?.status !== 'available') {
        db.prepare(`UPDATE tables SET status = 'available' WHERE id = ?`).run('table-zb');
      }
    }

    // ── partially refunded sibling does not block completion ──
    console.log('\n─── partially-refunded-sibling: partially refunded sibling does not block completion ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [{ product_id: 'prod-1000', quantity: 2 }],
      });
      assertEqual(create.status, 201, 'partially-refunded-sibling: dine-in created');
      const orderId = create.data.order.id;
      const itemId = create.data.order.items[0].id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'partially-refunded-sibling: bill generated');
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
      assertEqual(split.status, 201, 'partially-refunded-sibling: split created');
      const billA = split.data.bills[0];
      const billB = split.data.bills[1];

      const payA = await pay(billA.id, { method: 'cash', amount: null });
      assertEqual(payA.status, 200, 'partially-refunded-sibling: paid A');
      const refA = await refund({
        bill_id: billA.id,
        amount: 500,
        method: 'cash',
        reason: 'zb partially-refunded-sibling',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(refA.status, 201, 'partially-refunded-sibling: partial refund of A');
      assertEqual(billRow(db, billA.id).payment_status, 'partially_refunded', 'partially-refunded-sibling: A is partially_refunded');

      const payB = await pay(billB.id, { method: 'cash', amount: null });
      assertEqual(payB.status, 200, 'partially-refunded-sibling: paid B');
      assertEqual(orderRow(db, orderId).status, 'completed', 'partially-refunded-sibling: order completed after B paid + A partially refunded');
      assert(tableRow(db, 'table-zb')?.status === 'available', 'partially-refunded-sibling: table freed');
    }

    // ── restore re-syncs when all split bills were zero-closed ──
    console.log('\n─── restore-after-zero-close: restore re-syncs zero-closed split bills ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-zb',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      assertEqual(create.status, 201, 'restore-after-zero-close: dine-in created');
      const orderId = create.data.order.id;
      const items = create.data.order.items as any[];
      const itemA = items.find((i: any) => i.product_id === 'prod-1000');
      const itemB = items.find((i: any) => i.product_id === 'prod-400');

      const disc = await itemDiscount(orderId, itemB.id, { discount_type: 'amount', discount_value: 400 });
      assertEqual(disc.status, 200, 'restore-after-zero-close: item B fully discounted');

      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'restore-after-zero-close: bill generated');
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
      assertEqual(split.status, 201, 'restore-after-zero-close: split created');
      const checkA = split.data.bills[0];
      const checkB = split.data.bills[1];

      const cancelA = await cancelItem(orderId, itemA.id, { reason: 'zb restore-after-zero-close A' });
      assertEqual(cancelA.status, 200, 'restore-after-zero-close: A cancelled');
      assertEqual(billRow(db, checkA.id).payment_status, 'paid', 'restore-after-zero-close: check A zero-closed as paid');
      assertEqual(billRow(db, checkB.id).payment_status, 'paid', 'restore-after-zero-close: check B zero-closed as paid');
      assertEqual(orderRow(db, orderId).status, 'pending', 'restore-after-zero-close: order still open (B active)');

      const restore = await api(baseUrl, `/api/orders/${orderId}/items/${itemA.id}/restore`, {
        method: 'PATCH',
        body: { reason: 'zb restore-after-zero-close' },
        headers: A,
      });
      assertEqual(restore.status, 200, 'restore-after-zero-close: A restored');
      const aAfter = billRow(db, checkA.id);
      assertEqual(aAfter.payment_status, 'unpaid', 'restore-after-zero-close: check A flipped back to unpaid after restore');
      assert(Number(aAfter.total) > 0, `restore-after-zero-close: check A total re-synced (got ${aAfter.total})`);
      if (tableRow(db, 'table-zb')?.status !== 'available') {
        db.prepare(`UPDATE tables SET status = 'available' WHERE id = ?`).run('table-zb');
      }
    }

    // ── settle attempt on a refunded bill is rejected ──
    console.log('\n─── refunded-settle-rejected: settle attempt on refunded bill stays refunded ───');
    {
      const create = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-1000', quantity: 1 }] });
      assertEqual(create.status, 201, 'refunded-settle-rejected: order created');
      const gen = await generateBill(create.data.order.id);
      assertEqual(gen.status, 201, 'refunded-settle-rejected: bill generated');
      const billId = gen.data.bill.id;
      const paid = await pay(billId, { method: 'cash', amount: null });
      assertEqual(paid.status, 200, 'refunded-settle-rejected: bill paid in full');
      const live = billRow(db, billId);
      const ref = await refund({
        bill_id: billId,
        amount: Number(live.paid_amount),
        method: 'cash',
        reason: 'zb refunded-settle-rejected',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(ref.status, 201, 'refunded-settle-rejected: bill refunded');
      assertEqual(billRow(db, billId).payment_status, 'refunded', 'refunded-settle-rejected: status is refunded');

      const settle = await pay(billId, { method: 'cash', amount: null });
      assertEqual(settle.status, 400, `refunded-settle-rejected: settle rejected (got ${settle.status})`);
      assertEqual(billRow(db, billId).payment_status, 'refunded', 'refunded-settle-rejected: status still refunded after settle attempt');
    }

    // ── restore blocked when bill has a positive partial payment ──
    console.log('\n─── restore-partial-payment: restore rejected when bill has a positive partial payment ───');
    {
      // Two items: cancel the cheaper one so the remaining bill is 1000, then partially pay.
      const create = await createOrder({ type: 'takeaway', items: [
        { product_id: 'prod-1000', quantity: 1 },
        { product_id: 'prod-400', quantity: 1 },
      ]});
      assertEqual(create.status, 201, 'restore-partial-payment: order created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, 'restore-partial-payment: bill generated');
      const billId = gen.data.bill.id;

      // Cancel the prod-400 item so the bill syncs to 1000
      const orderData = await api(baseUrl, `/api/orders/${orderId}`, { method: 'GET', headers: A });
      const items = orderData.data?.order?.items ?? [];
      const item400 = items.find((i: any) => i.product_id === 'prod-400');
      const item1000 = items.find((i: any) => i.product_id === 'prod-1000');
      const cancelR = await cancelItem(orderId, item400.id, { reason: 'zb restore-partial-payment cancel 400' });
      assertEqual(cancelR.status, 200, 'restore-partial-payment: prod-400 item cancelled');

      // Partial payment on the remaining 1000-total bill
      const partialPay = await pay(billId, { method: 'cash', amount: 300 });
      assertEqual(partialPay.status, 200, 'restore-partial-payment: partial payment of 300 accepted');
      assertEqual(billRow(db, billId).payment_status, 'partial', 'restore-partial-payment: bill status is partial after partial payment');
      assertEqual(Number(billRow(db, billId).paid_amount) > 0, true, 'restore-partial-payment: paid_amount is positive');

      // Restore the cancelled item — must be rejected because the bill has a positive partial payment
      const restore = await api(baseUrl, `/api/orders/${orderId}/items/${item400.id}/restore`, {
        method: 'PATCH',
        body: { reason: 'zb restore-partial-payment' },
        headers: A,
      });
      assertEqual(restore.status, 400, 'restore-partial-payment: restore rejected when partial payment recorded');
      assertEqual(billRow(db, billId).payment_status, 'partial', 'restore-partial-payment: bill stays partial after rejected restore');
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
