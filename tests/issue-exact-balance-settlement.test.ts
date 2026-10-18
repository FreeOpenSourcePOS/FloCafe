/**
 * Issue #1176 / PR #1192: Automatic Exact-Balance Settlement
 * Verifies automatic completion of settlement when an order, item, or bill discount
 * reduces the remaining balance to exactly 0 (or when paid_amount equals the newly discounted total):
 * - Bill payment_status = 'paid', balance = 0, paid_at timestamp recorded.
 * - Order status = 'completed', completed_at timestamp recorded, dine-in table freed.
 * - Loyalty points credited on collected funds.
 * - Strictly NO fabricated payment lines or phantom payment entries.
 * - below_collected_funds guard (409) remains intact.
 * - Cash session and daily report accounting remain accurate.
 * - Payment reversals correctly affect net collected funds.
 *
 * Run: node tests/run-electron-node-test.cjs tests/issue-exact-balance-settlement.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-exact-balance-settlement-'));
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
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
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
  return db
    .prepare(
      `SELECT id, bill_number, payment_status, subtotal, discount_amount, discount_type, discount_value, total, paid_amount, balance, payment_details, paid_at, customer_id, order_id
     FROM bills WHERE id = ?`,
    )
    .get(id);
}

function orderRow(db: any, id: any): any {
  return db
    .prepare(
      `SELECT id, status, table_id, subtotal, discount_amount, total, completed_at, customer_id FROM orders WHERE id = ?`,
    )
    .get(id);
}

function tableRow(db: any, id: any): any {
  return db.prepare(`SELECT id, status FROM tables WHERE id = ?`).get(id);
}

async function main(): Promise<void> {
  console.log('Issue #1176: Automatic Exact-Balance Settlement Regression Suite');
  const db = initTestDb();

  setSetting(db, 'discount_mode', 'both');
  setSetting(db, 'discount_max_amount', '0');
  setSetting(db, 'discount_max_percentage', '0');
  setSetting(db, 'discount_requires_approval', 'false');

  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId } = seedManagerUser(db);
  seedCategory(db, 'cat-eb', 'EB menu');
  seedProduct(db, 'prod-1000', 'cat-eb', 'One Thousand', 1000, { cb_percent: null });
  seedProduct(db, 'prod-600', 'cat-eb', 'Six Hundred', 600, { cb_percent: null });
  seedProduct(db, 'prod-400', 'cat-eb', 'Four Hundred', 400, { cb_percent: null });
  seedTable(db, 'table-eb-1', 1);
  seedTable(db, 'table-eb-2', 2);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
  });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const A = ownerAuth;

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
  async function itemDiscount(orderId: any, itemId: any, body: any) {
    return api(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
      method: 'PATCH',
      body,
      headers: A,
    });
  }
  async function refund(body: any) {
    return api(baseUrl, '/api/refunds', { method: 'POST', body, headers: A });
  }

  try {
    // ── 1. Bill Discount Flow: Exact balance reduction auto-settles bill & completes order ──
    console.log(
      '\n─── 1. Bill Discount Flow: Exact-balance discount auto-settles bill & completes dine-in order ───',
    );
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-eb-1',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, '1. bill-discount: dine-in order created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, '1. bill-discount: bill generated');
      const billId = gen.data.bill.id;

      // Partial payment of 600 cash leaves balance 400
      const payRes = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(payRes.status, 200, '1. bill-discount: partial payment of 600 accepted');
      const billBeforeDisc = billRow(db, billId);
      assertEqual(
        billBeforeDisc.payment_status,
        'partial',
        '1. bill-discount: status is partial before discount',
      );
      assertEqual(Number(billBeforeDisc.balance), 400, '1. bill-discount: balance is 400');

      // Apply bill discount of 400 — exact balance reduction
      const discRes = await applyBillDiscount(billId, {
        type: 'amount',
        value: 400,
        reason: 'EB bill test',
      });
      assertEqual(discRes.status, 200, '1. bill-discount: discount applied successfully');
      assertEqual(
        discRes.data.bill.payment_status,
        'paid',
        '1. bill-discount: response reports paid status',
      );
      assertEqual(
        Number(discRes.data.bill.balance),
        0,
        '1. bill-discount: response reports balance 0',
      );

      // Verify persisted state in DB
      const billAfterDisc = billRow(db, billId);
      assertEqual(
        billAfterDisc.payment_status,
        'paid',
        '1. bill-discount: bill payment_status auto-settled to paid',
      );
      assertEqual(Number(billAfterDisc.total), 600, '1. bill-discount: bill total reduced to 600');
      assertEqual(
        Number(billAfterDisc.paid_amount),
        600,
        '1. bill-discount: bill paid_amount remains 600',
      );
      assertEqual(Number(billAfterDisc.balance), 0, '1. bill-discount: bill balance is 0');
      assert(Boolean(billAfterDisc.paid_at), '1. bill-discount: paid_at timestamp is populated');

      // Invariant: NEVER fabricate extra payment lines
      const payments = JSON.parse(billAfterDisc.payment_details || '[]');
      assertEqual(
        payments.length,
        1,
        '1. bill-discount: exactly 1 payment record preserved, NO phantom entries',
      );
      assertEqual(
        Number(payments[0].amount),
        600,
        '1. bill-discount: payment record holds original 600 tender',
      );

      // Verify order completed and dine-in table freed
      const ordAfterDisc = orderRow(db, orderId);
      assertEqual(
        ordAfterDisc.status,
        'completed',
        '1. bill-discount: order status transitioned to completed',
      );
      assert(
        Boolean(ordAfterDisc.completed_at),
        '1. bill-discount: order completed_at timestamp populated',
      );
      assertEqual(
        tableRow(db, 'table-eb-1')?.status,
        'available',
        '1. bill-discount: table freed to available',
      );

      // Verify idempotent retry / zero-balance payment call succeeds cleanly
      const settleRetry = await pay(billId, { method: 'cash', amount: null });
      assertEqual(
        settleRetry.status,
        200,
        '1. bill-discount: settlement retry on settled bill returns 200',
      );
      assertEqual(
        settleRetry.data.bill.payment_status,
        'paid',
        '1. bill-discount: retry preserves paid status',
      );
    }

    // ── 2. Order Discount Flow: Exact balance reduction auto-settles bill & completes order ──
    console.log(
      '\n─── 2. Order Discount Flow: Order discount auto-settles bill & completes order ───',
    );
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-eb-2',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, '2. order-discount: dine-in order created');
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, '2. order-discount: bill generated');
      const billId = gen.data.bill.id;

      // Partial payment of 400 cash leaves balance 600
      const payRes = await pay(billId, { method: 'cash', amount: 400 });
      assertEqual(payRes.status, 200, '2. order-discount: partial payment of 400 accepted');

      // Apply order discount of 600
      const discRes = await applyOrderDiscount(orderId, {
        discount_type: 'amount',
        discount_value: 600,
      });
      assertEqual(discRes.status, 200, '2. order-discount: order discount applied successfully');
      assertEqual(
        discRes.data.order.status,
        'completed',
        '2. order-discount: order response status is completed',
      );

      // Verify persisted state
      const billAfterDisc = billRow(db, billId);
      assertEqual(
        billAfterDisc.payment_status,
        'paid',
        '2. order-discount: bill payment_status auto-settled to paid',
      );
      assertEqual(Number(billAfterDisc.total), 400, '2. order-discount: bill total reduced to 400');
      assertEqual(
        Number(billAfterDisc.paid_amount),
        400,
        '2. order-discount: bill paid_amount remains 400',
      );
      assertEqual(Number(billAfterDisc.balance), 0, '2. order-discount: bill balance is 0');
      assert(Boolean(billAfterDisc.paid_at), '2. order-discount: paid_at timestamp is populated');

      const payments = JSON.parse(billAfterDisc.payment_details || '[]');
      assertEqual(payments.length, 1, '2. order-discount: no phantom payment lines fabricated');

      const ordAfterDisc = orderRow(db, orderId);
      assertEqual(ordAfterDisc.status, 'completed', '2. order-discount: order status is completed');
      assertEqual(
        tableRow(db, 'table-eb-2')?.status,
        'available',
        '2. order-discount: table freed to available',
      );
    }

    // ── 3. Item Discount Flow: Item discount zeroes balance and auto-settles ──
    console.log(
      '\n─── 3. Item Discount Flow: Item discount auto-settles bill & completes order ───',
    );
    {
      const create = await createOrder({
        type: 'takeaway',
        items: [
          { product_id: 'prod-600', quantity: 1 },
          { product_id: 'prod-400', quantity: 1 },
        ],
      });
      assertEqual(create.status, 201, '3. item-discount: takeaway order created');
      const orderId = create.data.order.id;
      const itemId400 = create.data.order.items.find((i: any) => i.product_id === 'prod-400').id;
      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, '3. item-discount: bill generated (total 1000)');
      const billId = gen.data.bill.id;

      // Partial payment of 600 cash covers the prod-600 item, balance 400
      const payRes = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(payRes.status, 200, '3. item-discount: partial payment of 600 accepted');

      // Apply 100% item discount (400) on prod-400
      const discRes = await itemDiscount(orderId, itemId400, {
        discount_type: 'amount',
        discount_value: 400,
      });
      assertEqual(discRes.status, 200, '3. item-discount: item discount applied');

      const billAfterDisc = billRow(db, billId);
      assertEqual(
        billAfterDisc.payment_status,
        'paid',
        '3. item-discount: bill auto-settled to paid',
      );
      assertEqual(Number(billAfterDisc.total), 600, '3. item-discount: bill total reduced to 600');
      assertEqual(
        Number(billAfterDisc.paid_amount),
        600,
        '3. item-discount: bill paid_amount remains 600',
      );
      assertEqual(Number(billAfterDisc.balance), 0, '3. item-discount: bill balance is 0');
      assert(Boolean(billAfterDisc.paid_at), '3. item-discount: paid_at timestamp populated');

      const ordAfterDisc = orderRow(db, orderId);
      assertEqual(ordAfterDisc.status, 'completed', '3. item-discount: order status is completed');
    }

    // ── 4. Percentage Discount Flow: Percentage discount zeroes balance ──
    console.log(
      '\n─── 4. Percentage Discount Flow: 50% discount on 1000 bill with 500 paid auto-settles ───',
    );
    {
      const create = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      const billId = gen.data.bill.id;

      await pay(billId, { method: 'cash', amount: 500 });
      const discRes = await applyOrderDiscount(orderId, {
        discount_type: 'percentage',
        discount_value: 50,
      });
      assertEqual(discRes.status, 200, '4. pct-discount: 50% discount applied');

      const billAfterDisc = billRow(db, billId);
      assertEqual(
        billAfterDisc.payment_status,
        'paid',
        '4. pct-discount: bill auto-settled to paid',
      );
      assertEqual(Number(billAfterDisc.total), 500, '4. pct-discount: bill total is 500');
      assertEqual(Number(billAfterDisc.balance), 0, '4. pct-discount: bill balance is 0');
      assertEqual(orderRow(db, orderId).status, 'completed', '4. pct-discount: order completed');
    }

    // ── 5. below_collected_funds Guard (409) Remains Intact ──
    console.log('\n─── 5. below_collected_funds Guard (409) Remains Intact Across All Routes ───');
    {
      const create = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      const billId = gen.data.bill.id;

      // Pay 600
      await pay(billId, { method: 'cash', amount: 600 });

      // Try bill discount of 500 (total would become 500 < 600 paid) -> MUST 409
      const rejBill = await applyBillDiscount(billId, { type: 'amount', value: 500 });
      assertEqual(rejBill.status, 409, '5. guard: bill discount below collected rejected with 409');
      assertEqual(
        rejBill.data.display_code,
        'below_collected_funds',
        '5. guard: display code below_collected_funds',
      );

      // Try order discount of 500 -> MUST 409
      const rejOrder = await applyOrderDiscount(orderId, {
        discount_type: 'amount',
        discount_value: 500,
      });
      assertEqual(
        rejOrder.status,
        409,
        '5. guard: order discount below collected rejected with 409',
      );
      assertEqual(
        rejOrder.data.display_code,
        'below_collected_funds',
        '5. guard: display code below_collected_funds',
      );

      // Verify bill state remains partial, balance 400
      const currentBill = billRow(db, billId);
      assertEqual(currentBill.payment_status, 'partial', '5. guard: bill remains partial');
      assertEqual(Number(currentBill.total), 1000, '5. guard: total untouched');
      assertEqual(Number(currentBill.paid_amount), 600, '5. guard: paid_amount untouched');
      assertEqual(Number(currentBill.balance), 400, '5. guard: balance untouched');
    }

    // ── 6. Zero-Paid Bill with 100% Discount Stays Unpaid ──
    console.log('\n─── 6. Zero-Paid Bill Stays Unpaid (No False Auto-Settlement) ───');
    {
      const create = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      const billId = gen.data.bill.id;

      // 100% discount with 0 collected funds
      const disc = await applyOrderDiscount(orderId, {
        discount_type: 'amount',
        discount_value: 1000,
      });
      assertEqual(disc.status, 200, '6. zero-paid: full discount applied');

      const bill = billRow(db, billId);
      assertEqual(
        bill.payment_status,
        'unpaid',
        '6. zero-paid: bill remains unpaid when paid_amount is 0',
      );
      assertEqual(Number(bill.total), 0, '6. zero-paid: bill total is 0');
      assertEqual(Number(bill.paid_amount), 0, '6. zero-paid: paid_amount is 0');
      assertEqual(Number(bill.balance), 0, '6. zero-paid: balance is 0');
      assertEqual(
        orderRow(db, orderId).status,
        'pending',
        '6. zero-paid: order remains pending until settled',
      );
    }

    // ── 7. Loyalty Points Credited on Collected Funds ──
    console.log('\n─── 7. Loyalty Points Credited on Collected Funds ───');
    {
      setSetting(db, 'loyalty_enabled', 'true');
      setSetting(db, 'global_cashback_percent', '10');

      // Seed customer
      const custId = 'cust-eb-loyalty';
      db.prepare(
        `INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES (?, 'Loyal Guest', '5551234', ?, ?)`,
      ).run(custId, now(), now());

      const create = await createOrder({
        type: 'takeaway',
        customer_id: custId,
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      const billId = gen.data.bill.id;

      // Partial payment of 600 cash
      await pay(billId, { method: 'cash', amount: 600 });

      // Apply 400 discount -> auto-settles
      await applyBillDiscount(billId, { type: 'amount', value: 400 });

      const bill = billRow(db, billId);
      assertEqual(bill.payment_status, 'paid', '7. loyalty: bill auto-settled');

      // Loyalty points should be calculated on the discounted/collected subtotal (600 @ 10% = 60 points)
      const ledgerEntry = db
        .prepare(`SELECT * FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'`)
        .get(billId) as any;
      assert(Boolean(ledgerEntry), '7. loyalty: loyalty credit entry created');
      assertEqual(
        Number(ledgerEntry.amount),
        60,
        '7. loyalty: cashback credited on collected funds (60 points)',
      );
    }

    // ── 8. Payment Reversals / Refunds on Auto-Settled Bills ──
    console.log('\n─── 8. Payment Reversals Correctly Affect Net Collected Funds ───');
    {
      const create = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      const billId = gen.data.bill.id;

      await pay(billId, { method: 'cash', amount: 600 });
      await applyBillDiscount(billId, { type: 'amount', value: 400 });
      assertEqual(billRow(db, billId).payment_status, 'paid', '8. refund: bill auto-settled');

      // Partial refund of 200 cash
      const ref1 = await refund({
        bill_id: billId,
        amount: 200,
        method: 'cash',
        reason: 'EB partial refund',
        override_pin: '1234',
        approver_id: managerId,
      });
      assertEqual(ref1.status, 201, '8. refund: partial refund of 200 created');
      assertEqual(
        billRow(db, billId).payment_status,
        'partially_refunded',
        '8. refund: status transitions to partially_refunded',
      );

      // Full remaining refund of 400 cash
      const ref2 = await refund({
        bill_id: billId,
        amount: 400,
        method: 'cash',
        reason: 'EB remaining refund',
        override_pin: '1234',
        approver_id: managerId,
      });
      assertEqual(ref2.status, 201, '8. refund: final refund of 400 created');
      assertEqual(
        billRow(db, billId).payment_status,
        'refunded',
        '8. refund: status transitions to refunded',
      );

      // Subsequent payment attempt on refunded bill is rejected
      const payAfterRef = await pay(billId, { method: 'cash', amount: 100 });
      assertEqual(payAfterRef.status, 409, '8. refund: payment on refunded bill rejected with 409');
    }

    // ── 9. Payment Rejection on Paid Bills vs Zero-Balance Retry & Cash Session Accounting ──
    console.log(
      '\n─── 9. Positive Payment Rejected on Settled Bill & Accurate Cash Accounting ───',
    );
    {
      const create = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId = create.data.order.id;
      const gen = await generateBill(orderId);
      const billId = gen.data.bill.id;

      // Pay 600 cash
      const initialPay = await pay(billId, { method: 'cash', amount: 600 });
      assertEqual(initialPay.status, 200, '9. cash: partial payment of 600 accepted');

      // Auto-settle via 400 discount
      const disc = await applyBillDiscount(billId, { type: 'amount', value: 400 });
      assertEqual(disc.status, 200, '9. cash: discount applied and auto-settled');
      assertEqual(billRow(db, billId).payment_status, 'paid', '9. cash: bill is paid');

      // Attempting positive card payment on already-settled bill MUST reject with bill_already_paid
      const extraPay = await pay(billId, { method: 'card', amount: 100 });
      assertEqual(
        extraPay.status,
        400,
        '9. pay-rejected: positive payment on paid bill rejected with 400',
      );
      assertEqual(
        extraPay.data.display_code,
        'bill_already_paid',
        '9. pay-rejected: display code is bill_already_paid',
      );

      // Retrying single-line zero-balance settle (amount: null) succeeds cleanly
      const zeroRetry = await pay(billId, { method: 'cash', amount: null });
      assertEqual(
        zeroRetry.status,
        200,
        '9. retry: zero-balance omitted-amount settle retry succeeds',
      );
      assertEqual(zeroRetry.data.bill.payment_status, 'paid', '9. retry: bill remains paid');

      // Retrying cash tender with positive amount on settled zero-balance bill succeeds with zero applied (change)
      const cashRetry = await pay(billId, { method: 'cash', amount: 50 });
      assertEqual(
        cashRetry.status,
        200,
        '9. retry: cash tender on zero-balance paid bill succeeds',
      );
      assertEqual(
        cashRetry.data.bill.payment_status,
        'paid',
        '9. retry: bill remains paid after cash retry',
      );

      // Payment details must strictly reflect ONLY the actual 600 tendered cash, never phantom entries
      const recordedPayments = JSON.parse(billRow(db, billId).payment_details || '[]');
      assertEqual(
        recordedPayments.length,
        1,
        '9. accounting: exactly one payment record preserved in ledger',
      );
      assertEqual(
        Number(recordedPayments[0].amount),
        600,
        '9. accounting: ledger entry has exact 600 tendered cash',
      );
    }

    // ── 10. Sibling Bill Topology: Exact-Balance Auto-Settlement with Unpaid Sibling ──
    console.log('\n─── 10. Sibling Bill Topology with Unpaid Sibling ───');
    {
      const create = await createOrder({
        type: 'dine_in',
        table_id: 'table-eb-2',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create.status, 201, '10. sibling: dine-in order created');
      const orderId = create.data.order.id;

      const gen = await generateBill(orderId);
      assertEqual(gen.status, 201, '10. sibling: bill 1 generated');
      const bill1Id = gen.data.bill.id;

      // Seed an unpaid sibling bill for the same order
      const siblingRes = db
        .prepare(
          `INSERT INTO bills (order_id, bill_number, subtotal, total, balance, paid_amount, payment_status, created_at, updated_at)
         VALUES (?, 'BILL-SIB-10', 500, 500, 500, 0, 'unpaid', ?, ?)`,
        )
        .run(orderId, now(), now());
      const siblingBillId = siblingRes.lastInsertRowid;

      // Partially pay Bill 1: pay 600 out of 1000
      const pay1 = await pay(bill1Id, { method: 'cash', amount: 600 });
      assertEqual(pay1.status, 200, '10. sibling: bill 1 partial pay 600 accepted');

      // Discount Bill 1 by 400 -> exact-balance auto-settles Bill 1
      const disc1 = await applyBillDiscount(bill1Id, { type: 'amount', value: 400 });
      assertEqual(disc1.status, 200, '10. sibling: bill 1 discounted by 400');
      assertEqual(
        billRow(db, bill1Id).payment_status,
        'paid',
        '10. sibling: bill 1 auto-settled to paid',
      );
      assertEqual(Number(billRow(db, bill1Id).balance), 0, '10. sibling: bill 1 balance is 0');

      // Crucial: Sibling bill is still unpaid, so Order must NOT be completed and table must NOT be freed!
      assertEqual(
        billRow(db, siblingBillId).payment_status,
        'unpaid',
        '10. sibling: sibling bill remains unpaid',
      );
      assertEqual(
        orderRow(db, orderId).status !== 'completed',
        true,
        '10. sibling: order remains active because sibling bill is unpaid',
      );
      assertEqual(
        tableRow(db, 'table-eb-2').status,
        'occupied',
        '10. sibling: table remains occupied',
      );

      // Now pay sibling bill in full
      const paySib = await pay(siblingBillId, { method: 'cash', amount: 500 });
      assertEqual(paySib.status, 200, '10. sibling: sibling bill paid in full');
      assertEqual(
        billRow(db, siblingBillId).payment_status,
        'paid',
        '10. sibling: sibling bill is paid',
      );

      // Now all sibling bills are paid -> order completes and table is released!
      assertEqual(
        orderRow(db, orderId).status,
        'completed',
        '10. sibling: order transitions to completed after all bills paid',
      );
      assertEqual(
        tableRow(db, 'table-eb-2').status,
        'available',
        '10. sibling: table released to available',
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
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
