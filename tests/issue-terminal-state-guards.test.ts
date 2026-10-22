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
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  seedTable,
  installAndActivateTestTaxPack,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
} = require('./helpers/test-setup');

const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes, syncUnpaidBillsForOrder } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');

function setSetting(db: any, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

function billRow(db: any, id: any): any {
  return db
    .prepare(
      `SELECT id, payment_status, subtotal, discount_amount, total, paid_amount, balance, order_id
     FROM bills WHERE id = ?`,
    )
    .get(id);
}

function orderRow(db: any, id: any): any {
  return db
    .prepare(
      `SELECT id, status, table_id, subtotal, discount_amount, total FROM orders WHERE id = ?`,
    )
    .get(id);
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
    return api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: A,
    });
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
    return api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: { items },
      headers: A,
    });
  }
  async function setOrderStatus(orderId: any, body: any) {
    return api(baseUrl, `/api/orders/${orderId}/status`, { method: 'PATCH', body, headers: A });
  }
  async function newTakeawayOrder(productId: string, quantity = 1) {
    const create = await createOrder({
      type: 'takeaway',
      items: [{ product_id: productId, quantity }],
    });
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

      const cancel = await setOrderStatus(orderId, {
        status: 'cancelled',
        reason: 'tsg cancelled-order-payment',
      });
      assertEqual(cancel.status, 200, 'cancelled-order-payment: order cancelled');
      assertEqual(
        orderRow(db, orderId).status,
        'cancelled',
        'cancelled-order-payment: status is cancelled before payment',
      );

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
      assertEqual(
        billRow(db, billId).payment_status,
        'refunded',
        'payment-refund-guard: bill is refunded',
      );

      const pay2 = await pay(billId, { method: 'cash', amount: 100 });
      assertEqual(pay2.status, 409, 'payment-refund-guard: post-refund payment rejected with 409');
      const after = billRow(db, billId);
      assertEqual(
        after.paid_amount,
        500,
        'payment-refund-guard: paid_amount unchanged after rejected payment',
      );
      assertEqual(
        after.payment_status,
        'refunded',
        'payment-refund-guard: still refunded after rejected payment',
      );
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
      assertEqual(
        before.payment_status,
        'partially_refunded',
        'partial-payment-refund: bill partially refunded',
      );

      const pay2 = await pay(billId, { method: 'cash', amount: 100 });
      assertEqual(pay2.status, 409, 'partial-payment-refund: payment rejected with 409');
      const after = billRow(db, billId);
      assertEqual(
        after.payment_status,
        'partially_refunded',
        'partial-payment-refund: still partially_refunded after rejected payment',
      );
      assertEqual(
        after.paid_amount,
        before.paid_amount,
        'partial-payment-refund: paid_amount unchanged',
      );
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
      assertEqual(
        beforeFull.payment_status,
        'refunded',
        'discount-refund-guard: bill fully refunded',
      );

      const orderDisc = await applyOrderDiscount(orderId, {
        discount_type: 'amount',
        discount_value: 100,
      });
      assertEqual(
        orderDisc.status,
        409,
        'discount-refund-guard: order discount on refunded bill rejected with 409',
      );
      const afterOrderDisc = billRow(db, billId);
      assertEqual(
        Number(afterOrderDisc.total),
        Number(beforeFull.total),
        'discount-refund-guard: bill total unchanged after rejected order discount',
      );
      assertEqual(
        Number(afterOrderDisc.discount_amount),
        Number(beforeFull.discount_amount),
        'discount-refund-guard: bill discount_amount unchanged after rejected order discount',
      );

      const billDisc = await applyBillDiscount(billId, { type: 'amount', value: 50 });
      assertEqual(
        billDisc.status,
        409,
        'discount-refund-guard: bill discount on refunded bill rejected with 409',
      );

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
      assertEqual(
        billRow(db, second.billId).payment_status,
        'partially_refunded',
        'discount-refund-guard: bill partially refunded',
      );

      const partialDisc = await applyBillDiscount(second.billId, { type: 'amount', value: 50 });
      assertEqual(
        partialDisc.status,
        409,
        'discount-refund-guard: bill discount on partially refunded bill rejected with 409',
      );
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
      assertEqual(
        add.status,
        409,
        'add-items-refund-guard: add-items on refunded order rejected with 409',
      );
      const after = billRow(db, billId);
      assertEqual(
        Number(after.subtotal),
        Number(before.subtotal),
        'add-items-refund-guard: bill subtotal unchanged',
      );
      assertEqual(
        Number(after.total),
        Number(before.total),
        'add-items-refund-guard: bill total unchanged',
      );
    }

    // ── reject add-items when bill partially refunded ──
    console.log('\n─── add-items-refund-guard: add-items rejected on partially refunded order ───');
    {
      resetPinRateLimitForTests();
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const partialPay = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(partialPay.status, 200, 'partial-refund-add-items: partial payment accepted');
      assertEqual(
        orderRow(db, orderId).status !== 'completed',
        true,
        'partial-refund-add-items: order still active after partial payment',
      );
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
      assertEqual(
        before.payment_status,
        'partially_refunded',
        'partial-refund-add-items: bill partially refunded',
      );

      const add = await addItems(orderId, [{ product_id: 'prod-400', quantity: 1 }]);
      assertEqual(add.status, 409, 'partial-refund-add-items: add-items rejected with 409');
      const after = billRow(db, billId);
      assertEqual(
        Number(after.subtotal),
        Number(before.subtotal),
        'partial-refund-add-items: bill subtotal unchanged',
      );
      assertEqual(
        Number(after.total),
        Number(before.total),
        'partial-refund-add-items: bill total unchanged',
      );
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
      const itemRow = db
        .prepare('SELECT id FROM order_items WHERE order_id = ? LIMIT 1')
        .get(orderId) as any;
      const before = billRow(db, billId);

      const disc = await api(baseUrl, `/api/orders/${orderId}/items/${itemRow.id}/discount`, {
        method: 'PATCH',
        body: { discount_type: 'amount', discount_value: 50 },
        headers: A,
      });
      assertEqual(
        disc.status,
        409,
        'item-disc: discount on partially refunded bill rejected with 409',
      );
      const after = billRow(db, billId);
      assertEqual(Number(after.total), Number(before.total), 'item-disc: bill total unchanged');
    }

    // ── Issue #1176: Bill discount order-state guards, collected-funds validation, and audit logging ──
    console.log('\n─── Issue #1176: Bill discount rejected on completed order ───');
    {
      resetPinRateLimitForTests();
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      // Complete unpaid order via manager PIN override
      const completeRes = await setOrderStatus(orderId, {
        status: 'completed',
        override_pin: pin,
      });
      assertEqual(completeRes.status, 200, 'issue-1176: order completed with manager PIN override');
      assertEqual(orderRow(db, orderId).status, 'completed', 'issue-1176: order is completed');
      const beforeBill = billRow(db, billId);

      const discRes = await applyBillDiscount(billId, { type: 'amount', value: 100 });
      assertEqual(
        discRes.status,
        409,
        'issue-1176: bill discount on completed order rejected with 409',
      );
      assertEqual(
        discRes.data.display_code,
        'order_not_discountable',
        'issue-1176: display_code is order_not_discountable',
      );

      const afterBill = billRow(db, billId);
      assertEqual(
        Number(afterBill.total),
        Number(beforeBill.total),
        'issue-1176: bill total unchanged',
      );
      assertEqual(
        Number(afterBill.discount_amount),
        Number(beforeBill.discount_amount),
        'issue-1176: bill discount_amount unchanged',
      );

      const audits = db
        .prepare('SELECT * FROM order_audit_log WHERE order_id = ? AND action = ?')
        .all(orderId, 'order_discount_applied');
      assertEqual(
        audits.length,
        0,
        'issue-1176: no discount audit log created for rejected discount',
      );
    }

    console.log(
      '\n─── Issue #1176: Active unpaid bill discount succeeds and audits authenticated caller ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'false');
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const discRes = await applyBillDiscount(billId, { type: 'amount', value: 100 });
      assertEqual(discRes.status, 200, 'issue-1176: bill discount applied successfully');

      const afterBill = billRow(db, billId);
      assertEqual(Number(afterBill.total), 900, 'issue-1176: bill total reduced to 900');
      assertEqual(
        Number(afterBill.discount_amount),
        100,
        'issue-1176: bill discount_amount is 100',
      );
      assertEqual(Number(afterBill.balance), 900, 'issue-1176: bill balance is 900');

      const audit = db
        .prepare('SELECT * FROM order_audit_log WHERE order_id = ? AND action = ?')
        .get(orderId, 'order_discount_applied') as any;
      assertEqual(Boolean(audit), true, 'issue-1176: discount audit row recorded');
      assertEqual(
        audit.actor_user_id,
        ownerId,
        'issue-1176: audit attributed to authenticated actor',
      );
      const details = JSON.parse(audit.details_json);
      assertEqual(details.discount_type, 'amount', 'issue-1176: audit recorded discount_type');
      assertEqual(details.discount_value, 100, 'issue-1176: audit recorded discount_value');
      assertEqual(
        details.approved_by,
        undefined,
        'issue-1176: approved_by is undefined when no PIN was required',
      );
    }

    console.log(
      '\n─── Issue #1176: PIN-approved bill discount attributes actor and approver separately ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'true');
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const discRes = await applyBillDiscount(billId, {
        type: 'amount',
        value: 150,
        override_pin: pin,
      });
      assertEqual(
        discRes.status,
        200,
        'issue-1176: PIN-approved bill discount applied successfully',
      );

      const afterBill = billRow(db, billId);
      assertEqual(Number(afterBill.total), 850, 'issue-1176: bill total reduced to 850');
      assertEqual(
        Number(afterBill.discount_amount),
        150,
        'issue-1176: bill discount_amount is 150',
      );
      assertEqual(Number(afterBill.balance), 850, 'issue-1176: bill balance is 850');

      const audit = db
        .prepare('SELECT * FROM order_audit_log WHERE order_id = ? AND action = ?')
        .get(orderId, 'order_discount_applied') as any;
      assertEqual(Boolean(audit), true, 'issue-1176: discount audit row recorded');
      assertEqual(
        audit.actor_user_id,
        ownerId,
        'issue-1176: audit attributed to authenticated actor',
      );
      const details = JSON.parse(audit.details_json);
      assertEqual(details.discount_type, 'amount', 'issue-1176: audit recorded discount_type');
      assertEqual(details.discount_value, 150, 'issue-1176: audit recorded discount_value');
      assertEqual(details.approved_by, managerId, 'issue-1176: audit recorded approving manager');
      assertEqual(
        details.override_pin,
        undefined,
        'issue-1176: override_pin never saved in audit log',
      );
      assertEqual(
        audit.details_json.includes('1234'),
        false,
        'issue-1176: raw PIN never saved in audit log',
      );
    }

    console.log('\n─── Issue #1176: Partially paid bill discount preserves remaining balance ───');
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'false');
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const payRes = await pay(billId, { method: 'cash', amount: 300 });
      assertEqual(payRes.status, 200, 'issue-1176: partial payment of 300 accepted');

      const discRes = await applyBillDiscount(billId, { type: 'amount', value: 200 });
      assertEqual(discRes.status, 200, 'issue-1176: partial payment discount of 200 accepted');

      const afterBill = billRow(db, billId);
      assertEqual(Number(afterBill.total), 800, 'issue-1176: bill total is 800');
      assertEqual(Number(afterBill.paid_amount), 300, 'issue-1176: bill paid_amount is 300');
      assertEqual(Number(afterBill.balance), 500, 'issue-1176: bill balance is 500 (800 - 300)');
      assertEqual(
        afterBill.payment_status,
        'partial',
        'issue-1176: bill payment_status remains partial',
      );
    }

    console.log(
      '\n─── Issue #1176: Bill discount reducing total below collected funds is rejected ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'false');
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const payRes = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(payRes.status, 200, 'issue-1176: partial payment of 600 accepted');

      const beforeBill = billRow(db, billId);
      // Attempting discount of 500 would reduce total to 500, below collected 600
      const discRes = await applyBillDiscount(billId, { type: 'amount', value: 500 });
      assertEqual(
        discRes.status,
        409,
        'issue-1176: discount below collected funds rejected with 409',
      );
      assertEqual(
        discRes.data.display_code,
        'below_collected_funds',
        'issue-1176: display_code is below_collected_funds',
      );

      const afterBill = billRow(db, billId);
      assertEqual(
        Number(afterBill.total),
        Number(beforeBill.total),
        'issue-1176: bill total unchanged',
      );
      assertEqual(Number(afterBill.paid_amount), 600, 'issue-1176: bill paid_amount unchanged');
      assertEqual(Number(afterBill.balance), 400, 'issue-1176: bill balance unchanged');
      assertEqual(afterBill.payment_status, 'partial', 'issue-1176: payment_status unchanged');

      const refunds = db.prepare('SELECT * FROM refunds WHERE bill_id = ?').all(billId);
      assertEqual(refunds.length, 0, 'issue-1176: no refund created on rejected discount');
    }

    console.log(
      '\n─── Issue #1176: Order-level discount reducing total below collected funds is rejected ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'false');
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const payRes = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(payRes.status, 200, 'issue-1176: partial payment of 600 accepted');

      const beforeBill = billRow(db, billId);
      const beforeOrder = orderRow(db, orderId);

      // Attempt order discount of 500
      const discRes = await applyOrderDiscount(orderId, {
        discount_type: 'amount',
        discount_value: 500,
      });
      assertEqual(
        discRes.status,
        409,
        'issue-1176: order discount below collected funds rejected with 409',
      );
      assertEqual(
        discRes.data.display_code,
        'below_collected_funds',
        'issue-1176: display_code is below_collected_funds',
      );

      const afterBill = billRow(db, billId);
      const afterOrder = orderRow(db, orderId);
      assertEqual(
        Number(afterOrder.total),
        Number(beforeOrder.total),
        'issue-1176: order total unchanged',
      );
      assertEqual(
        Number(afterBill.total),
        Number(beforeBill.total),
        'issue-1176: bill total unchanged',
      );
      assertEqual(Number(afterBill.paid_amount), 600, 'issue-1176: bill paid_amount unchanged');
      assertEqual(Number(afterBill.balance), 400, 'issue-1176: bill balance unchanged');
    }

    console.log(
      '\n─── Issue #1176: Exact-balance discount leaves balance at zero and settles cleanly ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'false');
      const { orderId, billId } = await newTakeawayOrder('prod-1000');
      const payRes = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(payRes.status, 200, 'issue-1176: partial payment of 600 accepted');

      // Bill total is 1000, paid 600, balance 400. Discount 400 makes total 600, balance 0.
      const discRes = await applyBillDiscount(billId, { type: 'amount', value: 400 });
      assertEqual(discRes.status, 200, 'issue-1176: exact balance discount applied successfully');

      const afterBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
      assertEqual(Number(afterBill.total), 600, 'issue-1176: bill total is 600');
      assertEqual(Number(afterBill.paid_amount), 600, 'issue-1176: bill paid_amount is 600');
      assertEqual(Number(afterBill.balance), 0, 'issue-1176: bill balance is 0');
      assertEqual(
        afterBill.payment_status,
        'paid',
        'issue-1176: bill payment_status auto-settled to paid',
      );
      assertEqual(Boolean(afterBill.paid_at), true, 'issue-1176: paid_at timestamp is populated');
      assertEqual(
        orderRow(db, orderId).status,
        'completed',
        'issue-1176: order completed after exact-balance discount',
      );

      const settleRes = await pay(billId, { method: 'cash', amount: null });
      assertEqual(settleRes.status, 200, 'issue-1176: zero-balance bill settles cleanly');
      const settledBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
      assertEqual(settledBill.payment_status, 'paid', 'issue-1176: settled bill is paid');
      assertEqual(Boolean(settledBill.paid_at), true, 'issue-1176: paid_at timestamp is populated');
      assertEqual(
        orderRow(db, orderId).status,
        'completed',
        'issue-1176: order completed after settlement',
      );
    }

    // ── Issue #1295: 1. syncUnpaidBillsForOrder & POST /api/bills/generate preserve refunded, partially_refunded, and Rs.0 paid bills ──
    console.log(
      '\n─── Issue #1295 (1): syncUnpaidBillsForOrder and /bills/generate do not overwrite refunded/partially_refunded/Rs.0 paid bills ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_requires_approval', 'false');

      // 1a. Rs.0 paid bill (total = 0, paid_amount = 0, payment_status = 'paid')
      const { orderId: zeroOrderId, billId: zeroBillId } = await newTakeawayOrder('prod-1000');
      const fullDisc = await applyOrderDiscount(zeroOrderId, {
        discount_type: 'amount',
        discount_value: 1000,
      });
      assertEqual(fullDisc.status, 200, 'issue-1295-1a: 100% discount applied');
      const settleZero = await pay(zeroBillId, { method: 'cash', amount: null });
      assertEqual(settleZero.status, 200, 'issue-1295-1a: Rs.0 bill settled to paid');
      assertEqual(
        billRow(db, zeroBillId).payment_status,
        'paid',
        'issue-1295-1a: bill status is paid',
      );
      assertEqual(Number(billRow(db, zeroBillId).total), 0, 'issue-1295-1a: bill total is 0');
      assertEqual(
        Number(billRow(db, zeroBillId).paid_amount),
        0,
        'issue-1295-1a: bill paid_amount is 0',
      );

      // Even if order row has non-zero totals, syncUnpaidBillsForOrder and /bills/generate must not overwrite Rs.0 paid bill
      db.prepare('UPDATE orders SET discount_amount = 0, total = 1000 WHERE id = ?').run(
        zeroOrderId,
      );
      syncUnpaidBillsForOrder(
        db,
        zeroOrderId,
        {
          subtotal: 1000,
          taxAmount: 0,
          taxBreakdown: '[]',
          taxSnapshot: null,
          discountAmount: 0,
          deliveryCharge: 0,
          packagingCharge: 0,
          serviceCharge: 0,
          chargesBreakdown: null,
          total: 1000,
        },
        'IN',
      );
      const afterSyncZero = billRow(db, zeroBillId);
      assertEqual(
        afterSyncZero.payment_status,
        'paid',
        'issue-1295-1a: Rs.0 paid bill stays paid after syncUnpaidBillsForOrder',
      );
      assertEqual(
        Number(afterSyncZero.total),
        0,
        'issue-1295-1a: Rs.0 paid bill total stays 0 after syncUnpaidBillsForOrder',
      );
      assertEqual(
        Number(afterSyncZero.balance),
        0,
        'issue-1295-1a: Rs.0 paid bill balance stays 0 after syncUnpaidBillsForOrder',
      );

      const genZeroAgain = await generateBill(zeroOrderId);
      assertEqual(genZeroAgain.status, 200, 'issue-1295-1a: /bills/generate returns existing bill');
      assertEqual(
        Number(genZeroAgain.data.bill.total),
        0,
        'issue-1295-1a: /bills/generate does not overwrite Rs.0 paid bill total',
      );
      assertEqual(
        Number(genZeroAgain.data.bill.balance),
        0,
        'issue-1295-1a: /bills/generate does not overwrite Rs.0 paid bill balance',
      );

      // 1b. Refunded and partially_refunded bills are not overwritten by syncUnpaidBillsForOrder or /bills/generate
      const { orderId: refOrderId, billId: refBillId } = await newTakeawayOrder('prod-1000');
      await pay(refBillId, { method: 'cash', amount: 600 });
      const partRef = await refund({
        bill_id: refBillId,
        amount: 200,
        method: 'cash',
        reason: '1295 partial refund',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(partRef.status, 201, 'issue-1295-1b: partial refund created');
      assertEqual(
        billRow(db, refBillId).payment_status,
        'partially_refunded',
        'issue-1295-1b: status is partially_refunded',
      );

      db.prepare('UPDATE orders SET subtotal = 1400, total = 1400 WHERE id = ?').run(refOrderId);
      syncUnpaidBillsForOrder(
        db,
        refOrderId,
        {
          subtotal: 1400,
          taxAmount: 0,
          taxBreakdown: '[]',
          taxSnapshot: null,
          discountAmount: 0,
          deliveryCharge: 0,
          packagingCharge: 0,
          serviceCharge: 0,
          chargesBreakdown: null,
          total: 1400,
        },
        'IN',
      );
      const genPartRef = await generateBill(refOrderId);
      assertEqual(genPartRef.status, 200, 'issue-1295-1b: /bills/generate on partially_refunded');
      assertEqual(
        Number(billRow(db, refBillId).total),
        1000,
        'issue-1295-1b: partially_refunded bill total preserved at 1000',
      );

      const remRef = await refund({
        bill_id: refBillId,
        amount: 400,
        method: 'cash',
        reason: '1295 full refund',
        override_pin: pin,
        approver_id: approver,
      });
      assertEqual(remRef.status, 201, 'issue-1295-1b: remaining refund created');
      assertEqual(
        billRow(db, refBillId).payment_status,
        'refunded',
        'issue-1295-1b: status is refunded',
      );
      syncUnpaidBillsForOrder(
        db,
        refOrderId,
        {
          subtotal: 1800,
          taxAmount: 0,
          taxBreakdown: '[]',
          taxSnapshot: null,
          discountAmount: 0,
          deliveryCharge: 0,
          packagingCharge: 0,
          serviceCharge: 0,
          chargesBreakdown: null,
          total: 1800,
        },
        'IN',
      );
      const genFullRef = await generateBill(refOrderId);
      assertEqual(genFullRef.status, 200, 'issue-1295-1b: /bills/generate on refunded');
      assertEqual(
        Number(billRow(db, refBillId).total),
        1000,
        'issue-1295-1b: refunded bill total preserved at 1000',
      );
    }

    // ── Issue #1295: 2 & 3. convert-to-takeaway guards, below_collected_funds, audit log, and exact-balance settlement ──
    console.log(
      '\n─── Issue #1295 (2 & 3): convert-to-takeaway guards, below_collected_funds, audit, and exact-balance settlement ───',
    );
    {
      resetPinRateLimitForTests();
      seedTable(db, 'table-1295-1', 10);
      seedTable(db, 'table-1295-2', 11);
      seedTable(db, 'table-1295-3', 12);

      // Configure a dine-in-only fixed service charge of 200 so converting to takeaway drops order total by 200
      setSetting(
        db,
        'custom_charges',
        JSON.stringify([
          {
            id: 'service_charge',
            name: 'Dine-In Service',
            type: 'fixed',
            value: 200,
            calculation_basis: 'gross',
            order_types: ['dine_in'],
            is_optional: true,
            is_default_active: true,
            is_active: true,
          },
        ]),
      );

      // 2a. Rejects convert-to-takeaway when a paid or refunded bill exists
      const paidDineIn = await createOrder({
        type: 'dine_in',
        table_id: 'table-1295-1',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(paidDineIn.status, 201, 'issue-1295-2a: dine-in order created (total 1200)');
      const paidDineInOrderId = paidDineIn.data.order.id;
      const paidDineInBill = await generateBill(paidDineInOrderId);
      const paidDineInBillId = paidDineInBill.data.bill.id;
      await pay(paidDineInBillId, { method: 'cash', amount: 600 });
      await refund({
        bill_id: paidDineInBillId,
        amount: 200,
        method: 'cash',
        reason: '1295-2a partial refund',
        override_pin: pin,
        approver_id: approver,
      });
      const convPartRef = await api(
        baseUrl,
        `/api/orders/${paidDineInOrderId}/convert-to-takeaway`,
        {
          method: 'PATCH',
          headers: A,
        },
      );
      assertEqual(
        convPartRef.status,
        409,
        'issue-1295-2a: convert-to-takeaway rejected on partially_refunded bill with 409',
      );
      await refund({
        bill_id: paidDineInBillId,
        amount: 400,
        method: 'cash',
        reason: '1295-2a full refund',
        override_pin: pin,
        approver_id: approver,
      });
      const convFullRef = await api(
        baseUrl,
        `/api/orders/${paidDineInOrderId}/convert-to-takeaway`,
        {
          method: 'PATCH',
          headers: A,
        },
      );
      assertEqual(
        convFullRef.status,
        409,
        'issue-1295-2a: convert-to-takeaway rejected on refunded bill with 409',
      );
      // Free table-1295-1 for next test
      db.prepare("UPDATE tables SET status = 'available' WHERE id = 'table-1295-1'").run();

      // 2b. Rejects convert-to-takeaway with below_collected_funds when takeaway total < paid_amount
      const belowOrder = await createOrder({
        type: 'dine_in',
        table_id: 'table-1295-1',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(belowOrder.status, 201, 'issue-1295-2b: dine-in order created (total 1200)');
      const belowOrderId = belowOrder.data.order.id;
      const belowBill = await generateBill(belowOrderId);
      const belowBillId = belowBill.data.bill.id;
      assertEqual(Number(belowBill.data.bill.total), 1200, 'issue-1295-2b: dine-in bill is 1200');
      // Pay 1100 out of 1200; converting to takeaway removes 200 service charge -> 1000 < 1100 collected
      const pay1100 = await pay(belowBillId, { method: 'cash', amount: 1100 });
      assertEqual(pay1100.status, 200, 'issue-1295-2b: partial payment of 1100 accepted');

      const convBelow = await api(baseUrl, `/api/orders/${belowOrderId}/convert-to-takeaway`, {
        method: 'PATCH',
        headers: A,
      });
      assertEqual(
        convBelow.status,
        409,
        'issue-1295-2b: convert-to-takeaway below collected funds rejected with 409',
      );
      assertEqual(
        convBelow.data.display_code,
        'below_collected_funds',
        'issue-1295-2b: display_code is below_collected_funds',
      );
      assertEqual(
        Number(billRow(db, belowBillId).total),
        1200,
        'issue-1295-2b: bill total unchanged after rejected conversion',
      );

      // 2c & 3a. Exact-balance settlement + converted_to_takeaway audit on convert-to-takeaway
      const exactConvOrder = await createOrder({
        type: 'dine_in',
        table_id: 'table-1295-2',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(exactConvOrder.status, 201, 'issue-1295-3a: dine-in order created (total 1200)');
      const exactConvOrderId = exactConvOrder.data.order.id;
      const exactConvBill = await generateBill(exactConvOrderId);
      const exactConvBillId = exactConvBill.data.bill.id;
      // Pay 1000 out of 1200; converting to takeaway drops 200 dine-in charge so new total = 1000 === paid_amount
      const pay1000 = await pay(exactConvBillId, { method: 'cash', amount: 1000 });
      assertEqual(pay1000.status, 200, 'issue-1295-3a: partial payment of 1000 accepted');
      assertEqual(
        billRow(db, exactConvBillId).payment_status,
        'partial',
        'issue-1295-3a: bill is partial before conversion',
      );

      const convExact = await api(baseUrl, `/api/orders/${exactConvOrderId}/convert-to-takeaway`, {
        method: 'PATCH',
        headers: A,
      });
      assertEqual(convExact.status, 200, 'issue-1295-3a: convert-to-takeaway succeeds');
      const billAfterConv = db
        .prepare('SELECT * FROM bills WHERE id = ?')
        .get(exactConvBillId) as any;
      assertEqual(
        billAfterConv.payment_status,
        'paid',
        'issue-1295-3a: bill auto-settles to paid on exact balance after takeaway conversion',
      );
      assertEqual(Number(billAfterConv.total), 1000, 'issue-1295-3a: bill total is 1000');
      assertEqual(Number(billAfterConv.balance), 0, 'issue-1295-3a: bill balance is 0');
      assertEqual(Boolean(billAfterConv.paid_at), true, 'issue-1295-3a: bill paid_at is populated');
      assertEqual(
        orderRow(db, exactConvOrderId).status,
        'completed',
        'issue-1295-3a: order completes on exact-balance takeaway conversion',
      );
      const convAudit = db
        .prepare('SELECT * FROM order_audit_log WHERE order_id = ? AND action = ?')
        .get(exactConvOrderId, 'converted_to_takeaway') as any;
      assertEqual(
        Boolean(convAudit),
        true,
        'issue-1295-2c: converted_to_takeaway audit row recorded',
      );
      assertEqual(
        convAudit.actor_user_id,
        ownerId,
        'issue-1295-2c: converted_to_takeaway audit records actor',
      );

      // Clear custom_charges for subsequent tests
      db.prepare("DELETE FROM settings WHERE key = 'custom_charges'").run();

      // 3b. Exact-balance settlement on PATCH /api/orders/:orderId/items/:itemId/edit
      const editOrder = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-400', quantity: 2 }],
      });
      assertEqual(editOrder.status, 201, 'issue-1295-3b: order with 2x400=800 created');
      const editOrderId = editOrder.data.order.id;
      const editItem = editOrder.data.order.items[0];
      const editBill = await generateBill(editOrderId);
      const editBillId = editBill.data.bill.id;
      const pay400 = await pay(editBillId, { method: 'cash', amount: 400 });
      assertEqual(pay400.status, 200, 'issue-1295-3b: partial payment of 400 accepted');
      assertEqual(
        billRow(db, editBillId).payment_status,
        'partial',
        'issue-1295-3b: bill is partial before item edit',
      );

      const editRes = await api(baseUrl, `/api/orders/${editOrderId}/items/${editItem.id}/edit`, {
        method: 'PATCH',
        headers: { ...A, 'Idempotency-Key': 'idem-1295-3b-exact' },
        body: {
          quantity: 1,
          expected_edit_version: editItem.edit_version ?? 0,
          reason: 'reduce to 1 for exact balance',
        },
      });
      assertEqual(editRes.status, 200, 'issue-1295-3b: item quantity reduced from 2 to 1');
      const billAfterEdit = db.prepare('SELECT * FROM bills WHERE id = ?').get(editBillId) as any;
      assertEqual(
        billAfterEdit.payment_status,
        'paid',
        'issue-1295-3b: bill auto-settles to paid when item edit brings total to paid_amount',
      );
      assertEqual(Number(billAfterEdit.total), 400, 'issue-1295-3b: bill total is 400');
      assertEqual(Number(billAfterEdit.balance), 0, 'issue-1295-3b: bill balance is 0');
      assertEqual(Boolean(billAfterEdit.paid_at), true, 'issue-1295-3b: paid_at is populated');
      assertEqual(
        orderRow(db, editOrderId).status,
        'completed',
        'issue-1295-3b: order status transitions to completed after exact-balance item edit',
      );

      // 3c. Exact-balance settlement on POST /api/bills/generate when existing partial bill matches reduced order total
      const genSettleOrder = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const genSettleOrderId = genSettleOrder.data.order.id;
      const genSettleBill = await generateBill(genSettleOrderId);
      const genSettleBillId = genSettleBill.data.bill.id;
      await pay(genSettleBillId, { method: 'cash', amount: 600 });
      // Simulate order discounted to 600 prior to /bills/generate resync
      db.prepare(
        "UPDATE orders SET discount_amount = 400, discount_type = 'amount', discount_value = 400, total = 600 WHERE id = ?",
      ).run(genSettleOrderId);
      const regenRes = await generateBill(genSettleOrderId);
      assertEqual(regenRes.status, 200, 'issue-1295-3c: /bills/generate resyncs partial bill');
      assertEqual(
        regenRes.data.bill.payment_status,
        'paid',
        'issue-1295-3c: /bills/generate auto-settles partial bill to paid on exact balance',
      );
      assertEqual(
        Number(regenRes.data.bill.balance),
        0,
        'issue-1295-3c: /bills/generate sets balance to 0',
      );
      assertEqual(
        Boolean(regenRes.data.bill.paid_at),
        true,
        'issue-1295-3c: /bills/generate populates paid_at',
      );
      assertEqual(
        orderRow(db, genSettleOrderId).status,
        'completed',
        'issue-1295-3c: /bills/generate completes order on exact-balance settlement',
      );
    }

    // ── Issue #1295: 4. Restore item guards against partially_refunded, refunded, and Rs.0 paid bills ──
    console.log(
      '\n─── Issue #1295 (4): Restore item rejected on partially_refunded, refunded, and Rs.0 paid bills ───',
    );
    {
      resetPinRateLimitForTests();
      const restoreCreate = await createOrder({
        type: 'takeaway',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      assertEqual(restoreCreate.status, 201, 'issue-1295-4: order created');
      const restoreOrderId = restoreCreate.data.order.id;
      const item400 = restoreCreate.data.order.items.find((i: any) => i.product_id === 'prod-400');
      const cancelRes = await api(
        baseUrl,
        `/api/orders/${restoreOrderId}/items/${item400.id}/cancel`,
        {
          method: 'PATCH',
          body: { reason: 'cancel 400 before zero-pay settle' },
          headers: A,
        },
      );
      assertEqual(cancelRes.status, 200, 'issue-1295-4: 400 item cancelled');

      const restoreBill = await generateBill(restoreOrderId);
      const restoreBillId = restoreBill.data.bill.id;
      await applyOrderDiscount(restoreOrderId, { discount_type: 'amount', discount_value: 1000 });
      await pay(restoreBillId, { method: 'cash', amount: null });
      // Keep order status pending to directly test the bill status guard on Rs.0 paid bill
      db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(restoreOrderId);
      assertEqual(
        billRow(db, restoreBillId).payment_status,
        'paid',
        'issue-1295-4: bill is Rs.0 paid',
      );
      assertEqual(
        Number(billRow(db, restoreBillId).paid_amount),
        0,
        'issue-1295-4: bill paid_amount is 0',
      );

      const restoreOnZeroPaid = await api(
        baseUrl,
        `/api/orders/${restoreOrderId}/items/${item400.id}/restore`,
        {
          method: 'PATCH',
          body: {},
          headers: A,
        },
      );
      assertEqual(
        restoreOnZeroPaid.status,
        400,
        'issue-1295-4: restore rejected on Rs.0 paid bill with 400',
      );
      assertEqual(
        Number(billRow(db, restoreBillId).total),
        0,
        'issue-1295-4: Rs.0 paid bill total remains 0',
      );
    }

    // ── Issue #1295: 5. Flat order discount preserved and clamped across item discount, price override, and item cancel ──
    console.log(
      '\n─── Issue #1295 (5): Flat order discount preserved (not scaled) and clamped to newSubtotal ───',
    );
    {
      resetPinRateLimitForTests();
      setSetting(db, 'discount_mode', 'both');
      setSetting(db, 'discount_requires_approval', 'false');

      // 5a. handleItemDiscount preserves flat order discount and clamps when newSubtotal < flatDiscount
      const ord5a = await createOrder({
        type: 'takeaway',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      const ord5aId = ord5a.data.order.id;
      const item5a1000 = ord5a.data.order.items.find((i: any) => i.product_id === 'prod-1000').id;
      const item5a400 = ord5a.data.order.items.find((i: any) => i.product_id === 'prod-400').id;
      await applyOrderDiscount(ord5aId, { discount_type: 'amount', discount_value: 200 });
      assertEqual(
        Number(orderRow(db, ord5aId).discount_amount),
        200,
        'issue-1295-5a: flat 200 order discount applied on 1400 subtotal',
      );

      // Discount 400 item by 100 -> newSubtotal = 1300; flat order discount MUST stay 200 (not scaled by 1300/1400)
      const itemDisc1 = await api(baseUrl, `/api/orders/${ord5aId}/items/${item5a400}/discount`, {
        method: 'PATCH',
        body: { discount_type: 'amount', discount_value: 100 },
        headers: A,
      });
      assertEqual(itemDisc1.status, 200, 'issue-1295-5a: item discount 100 applied');
      assertEqual(
        Number(orderRow(db, ord5aId).subtotal),
        1300,
        'issue-1295-5a: order subtotal is 1300',
      );
      assertEqual(
        Number(orderRow(db, ord5aId).discount_amount),
        200,
        'issue-1295-5a: flat order discount preserved at 200 without proportional scaling',
      );

      // Discount 1000 item by 950 and 400 item by 300 -> newSubtotal = 50 + 100 = 150 < 200 -> clamped to 150
      await api(baseUrl, `/api/orders/${ord5aId}/items/${item5a1000}/discount`, {
        method: 'PATCH',
        body: { discount_type: 'amount', discount_value: 950 },
        headers: A,
      });
      await api(baseUrl, `/api/orders/${ord5aId}/items/${item5a400}/discount`, {
        method: 'PATCH',
        body: { discount_type: 'amount', discount_value: 300 },
        headers: A,
      });
      assertEqual(
        Number(orderRow(db, ord5aId).subtotal),
        150,
        'issue-1295-5a: order subtotal is 150',
      );
      assertEqual(
        Number(orderRow(db, ord5aId).discount_amount),
        150,
        'issue-1295-5a: flat order discount clamped to 150 subtotal',
      );
      assertEqual(Number(orderRow(db, ord5aId).total), 0, 'issue-1295-5a: order total is 0');

      // 5b. handleItemPriceOverride preserves flat order discount and clamps when newSubtotal < flatDiscount
      const ord5b = await createOrder({
        type: 'takeaway',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      const ord5bId = ord5b.data.order.id;
      const item5b1000 = ord5b.data.order.items.find((i: any) => i.product_id === 'prod-1000').id;
      const item5b400 = ord5b.data.order.items.find((i: any) => i.product_id === 'prod-400').id;
      await applyOrderDiscount(ord5bId, { discount_type: 'amount', discount_value: 200 });

      const ovr1 = await api(baseUrl, `/api/orders/${ord5bId}/items/${item5b400}/price`, {
        method: 'PATCH',
        body: { price: 200, reason: 'override 400 to 200' },
        headers: A,
      });
      assertEqual(ovr1.status, 200, 'issue-1295-5b: price override to 200 applied');
      assertEqual(
        Number(orderRow(db, ord5bId).subtotal),
        1200,
        'issue-1295-5b: order subtotal is 1200',
      );
      assertEqual(
        Number(orderRow(db, ord5bId).discount_amount),
        200,
        'issue-1295-5b: flat order discount preserved at 200 after price override',
      );

      const ovr2 = await api(baseUrl, `/api/orders/${ord5bId}/items/${item5b1000}/price`, {
        method: 'PATCH',
        body: { price: 0, reason: 'comp 1000 item' },
        headers: A,
      });
      assertEqual(ovr2.status, 200, 'issue-1295-5b: price override to 0 applied');
      const ovr3 = await api(baseUrl, `/api/orders/${ord5bId}/items/${item5b400}/price`, {
        method: 'PATCH',
        body: { price: 120, reason: 'reduce to 120' },
        headers: A,
      });
      assertEqual(ovr3.status, 200, 'issue-1295-5b: price override to 120 applied');
      assertEqual(
        Number(orderRow(db, ord5bId).subtotal),
        120,
        'issue-1295-5b: order subtotal is 120',
      );
      assertEqual(
        Number(orderRow(db, ord5bId).discount_amount),
        120,
        'issue-1295-5b: flat order discount clamped to 120 subtotal',
      );

      // 5c. PATCH /api/orders/:orderId/items/:itemId/cancel clamps flat order discount to newSubtotal
      const ord5c = await createOrder({
        type: 'takeaway',
        items: [
          { product_id: 'prod-1000', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      const ord5cId = ord5c.data.order.id;
      const item5c1000 = ord5c.data.order.items.find((i: any) => i.product_id === 'prod-1000').id;
      await applyOrderDiscount(ord5cId, { discount_type: 'amount', discount_value: 600 });
      assertEqual(
        Number(orderRow(db, ord5cId).discount_amount),
        600,
        'issue-1295-5c: flat 600 discount applied on 1400 order',
      );

      const cancel1000 = await api(baseUrl, `/api/orders/${ord5cId}/items/${item5c1000}/cancel`, {
        method: 'PATCH',
        body: { reason: 'cancel 1000 item' },
        headers: A,
      });
      assertEqual(cancel1000.status, 200, 'issue-1295-5c: 1000 item cancelled');
      assertEqual(
        Number(orderRow(db, ord5cId).subtotal),
        400,
        'issue-1295-5c: remaining subtotal is 400',
      );
      assertEqual(
        Number(orderRow(db, ord5cId).discount_amount),
        400,
        'issue-1295-5c: flat discount clamped from 600 to 400 subtotal',
      );
      assertEqual(Number(orderRow(db, ord5cId).total), 0, 'issue-1295-5c: order total is 0');
    }

    // ── Issue #1295: 6. PATCH /api/orders/:id/customer guards, tax recomputation, bill sync, and audit ──
    console.log(
      '\n─── Issue #1295 (6): PATCH /orders/:id/customer guards settled/partial/split bills and recomputes customer taxes ───',
    );
    {
      resetPinRateLimitForTests();
      db.exec('ALTER TABLE customers ADD COLUMN customer_state_code TEXT');
      db.exec('ALTER TABLE customers ADD COLUMN taxRegistrationNumber TEXT');
      const custIntra = 'cust-1295-intra';
      const custInter = 'cust-1295-inter';
      db.prepare(
        `INSERT INTO customers (id, name, phone, customer_state_code, taxRegistrationNumber, created_at, updated_at)
         VALUES (?, 'Intra Guest', '+919999912951', 'MH', '27AAAAA0000A1Z5', ?, ?),
                (?, 'Inter Guest', '+919999912952', 'KA', '29AAAAA0000A1Z5', ?, ?)`,
      ).run(custIntra, now(), now(), custInter, now(), now());

      // 6a. Rejects customer reassignment on partial, paid, partially_refunded, refunded, or split bills
      const { orderId: guardOrdId, billId: guardBillId } = await newTakeawayOrder('prod-1000');
      await pay(guardBillId, { method: 'cash', amount: 300 });
      const custOnPartial = await api(baseUrl, `/api/orders/${guardOrdId}/customer`, {
        method: 'PATCH',
        body: { customer_id: custIntra },
        headers: A,
      });
      assertEqual(
        custOnPartial.status,
        409,
        'issue-1295-6a: customer change rejected on partially paid bill with 409',
      );

      await refund({
        bill_id: guardBillId,
        amount: 100,
        method: 'cash',
        reason: '1295-6a partial refund',
        override_pin: pin,
        approver_id: approver,
      });
      const custOnPartRef = await api(baseUrl, `/api/orders/${guardOrdId}/customer`, {
        method: 'PATCH',
        body: { customer_id: custIntra },
        headers: A,
      });
      assertEqual(
        custOnPartRef.status,
        409,
        'issue-1295-6a: customer change rejected on partially_refunded bill with 409',
      );

      // 6b. Active order with unpaid bill: recomputes customer-dependent taxes, syncs unpaid bill, and records audit
      const customPack = {
        ...dualRatePackData,
        id: 'test-1295-customer-tax-pack',
        country: 'IN',
        currency: 'INR',
        publisher: 'FreeOpenSourcePOS',
        rules: dualRatePackData.rules.map((r: any) =>
          r.id === 'rate-c' ? { ...r, rate: '10' } : r,
        ),
      };
      installAndActivateTestTaxPack(db, customPack);
      setSetting(db, 'state_code', 'MH');
      seedProduct(db, 'prod-tax-1000', 'cat-tsg', 'Taxable Thousand', 1000, {
        tax_category_id: 'standard',
        tax_behavior: 'exclusive',
      });

      const taxOrd = await createOrder({
        type: 'takeaway',
        customer_id: custIntra,
        items: [{ product_id: 'prod-tax-1000', quantity: 1 }],
      });
      assertEqual(taxOrd.status, 201, 'issue-1295-6b: intrastate order created');
      const taxOrdId = taxOrd.data.order.id;
      assertEqual(
        Number(taxOrd.data.order.tax_amount),
        50,
        'issue-1295-6b: intrastate tax is 50 (2.5% + 2.5%)',
      );
      assertEqual(
        Number(taxOrd.data.order.total),
        1050,
        'issue-1295-6b: intrastate order total is 1050',
      );
      const taxBill = await generateBill(taxOrdId);
      const taxBillId = taxBill.data.bill.id;
      assertEqual(
        Number(taxBill.data.bill.total),
        1050,
        'issue-1295-6b: unpaid bill initial total is 1050',
      );

      // Reassign to interstate customer (KA != MH -> rate-c 10% applies -> tax = 100, total = 1100)
      const reassignRes = await api(baseUrl, `/api/orders/${taxOrdId}/customer`, {
        method: 'PATCH',
        body: { customer_id: custInter },
        headers: A,
      });
      assertEqual(reassignRes.status, 200, 'issue-1295-6b: customer reassignment succeeds');
      assertEqual(
        reassignRes.data.order.customer_id,
        custInter,
        'issue-1295-6b: order customer_id updated to interstate customer',
      );
      assertEqual(
        Number(reassignRes.data.order.tax_amount),
        100,
        'issue-1295-6b: order tax_amount recomputed to 100 (10% interstate)',
      );
      assertEqual(
        Number(reassignRes.data.order.total),
        1100,
        'issue-1295-6b: order total recomputed to 1100',
      );

      const syncedBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(taxBillId) as any;
      assertEqual(
        syncedBill.customer_id,
        custInter,
        'issue-1295-6b: unpaid bill customer_id updated',
      );
      assertEqual(
        Number(syncedBill.tax_amount),
        100,
        'issue-1295-6b: unpaid bill tax_amount synced to 100',
      );
      assertEqual(
        Number(syncedBill.total),
        1100,
        'issue-1295-6b: unpaid bill total synced to 1100',
      );
      assertEqual(
        Number(syncedBill.balance),
        1100,
        'issue-1295-6b: unpaid bill balance synced to 1100',
      );

      const custAudit = db
        .prepare('SELECT * FROM order_audit_log WHERE order_id = ? AND action = ?')
        .get(taxOrdId, 'customer_updated') as any;
      assertEqual(Boolean(custAudit), true, 'issue-1295-6b: customer_updated audit row recorded');
      assertEqual(custAudit.actor_user_id, ownerId, 'issue-1295-6b: audit attributed to actor');
      const custAuditDetails = JSON.parse(custAudit.details_json);
      assertEqual(
        custAuditDetails.previous_customer_id,
        custIntra,
        'issue-1295-6b: audit records previous_customer_id',
      );
      assertEqual(
        custAuditDetails.customer_id,
        custInter,
        'issue-1295-6b: audit records new customer_id',
      );
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
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
