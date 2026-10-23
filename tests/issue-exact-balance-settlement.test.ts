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

      // Attempting positive cash payment on already-settled bill MUST ALSO reject with bill_already_paid (preventing phantom/unrecorded cash tender)
      const extraCashPay = await pay(billId, { method: 'cash', amount: 50 });
      assertEqual(
        extraCashPay.status,
        400,
        '9. pay-rejected: positive cash payment on paid bill rejected with 400',
      );
      assertEqual(
        extraCashPay.data.display_code,
        'bill_already_paid',
        '9. pay-rejected: cash display code is bill_already_paid',
      );

      // Retrying single-line zero-balance settle (amount: null) succeeds cleanly
      const zeroRetry = await pay(billId, { method: 'cash', amount: null });
      assertEqual(
        zeroRetry.status,
        200,
        '9. retry: zero-balance omitted-amount settle retry succeeds',
      );
      assertEqual(zeroRetry.data.bill.payment_status, 'paid', '9. retry: bill remains paid');

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

    // ── 11. Kitchen Delivery Gate on Exact-Balance Settlement & Zero-Balance Retries ──
    console.log(
      '\n─── 11. Kitchen Delivery Gate on Exact-Balance Settlement & Zero-Balance Retries ───',
    );
    {
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'false');
      setSetting(db, 'kds_enabled', 'true');
      setSetting(db, 'billing_type', 'postpaid');

      // Subtest 11a: Bill discount reduces balance to 0 while kitchen items pending (no override)
      const create11a = await createOrder({
        type: 'dine_in',
        table_id: 'table-eb-1',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      assertEqual(create11a.status, 201, '11a. dine-in order created');
      const orderId11a = create11a.data.order.id;

      const gen11a = await generateBill(orderId11a);
      const billId11a = gen11a.data.bill.id;

      // Pay 600 cash while items not yet in kitchen
      const pay11a = await pay(billId11a, { method: 'cash', amount: 600 });
      assertEqual(pay11a.status, 200, '11a. pay 600 accepted');

      // Now enable kitchen delivery requirement and mark order item as preparing
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId11a);

      // Discount bill by 400 without override PIN -> balance becomes 0, but bill MUST NOT settle to paid!
      const disc11a = await applyBillDiscount(billId11a, { type: 'amount', value: 400 });
      assertEqual(disc11a.status, 200, '11a. bill discount applied');
      const bill11aAfterDisc = billRow(db, billId11a);
      assertEqual(
        Number(bill11aAfterDisc.balance),
        0,
        '11a. bill balance is 0 after exact-balance discount',
      );
      assertEqual(
        bill11aAfterDisc.payment_status,
        'partial',
        '11a. bill payment_status remains partial due to pending kitchen delivery',
      );
      assertEqual(
        bill11aAfterDisc.paid_at,
        null,
        '11a. paid_at remains null due to pending kitchen delivery',
      );
      assertEqual(
        orderRow(db, orderId11a).status !== 'completed',
        true,
        '11a. order remains active (not completed)',
      );
      assertEqual(tableRow(db, 'table-eb-1').status, 'occupied', '11a. table remains occupied');

      // Zero-balance payment retry without manager override PIN -> rejected with 409 kitchen_undelivered
      const retryNoPin = await pay(billId11a, { method: 'cash', amount: null });
      assertEqual(
        retryNoPin.status,
        409,
        '11a. zero-balance retry rejected with 409 when kitchen delivery pending',
      );
      assertEqual(
        retryNoPin.data.display_code,
        'kitchen_undelivered',
        '11a. display_code is kitchen_undelivered',
      );

      // Positive payment attempt on 0-balance bill -> rejected with 400 payment_exceeds_balance
      const retryPos = await pay(billId11a, { method: 'cash', amount: 50 });
      assertEqual(retryPos.status, 400, '11a. positive tender on 0-balance bill rejected with 400');
      assertEqual(
        retryPos.data.display_code,
        'payment_exceeds_balance',
        '11a. display_code is payment_exceeds_balance',
      );

      // Zero-balance payment retry with valid manager override PIN -> succeeds!
      const retryWithPin = await pay(billId11a, {
        method: 'cash',
        amount: null,
        override_pin: '1234',
        approver_id: managerId,
      });
      assertEqual(
        retryWithPin.status,
        200,
        '11a. zero-balance retry with manager PIN override succeeds with 200',
      );
      const bill11aFinal = billRow(db, billId11a);
      assertEqual(
        bill11aFinal.payment_status,
        'paid',
        '11a. bill payment_status transitions to paid after override',
      );
      assertEqual(
        Boolean(bill11aFinal.paid_at),
        true,
        '11a. paid_at timestamp is set after override',
      );
      assertEqual(
        orderRow(db, orderId11a).status,
        'completed',
        '11a. order transitions to completed after override',
      );
      assertEqual(
        tableRow(db, 'table-eb-1').status,
        'available',
        '11a. table released to available after override',
      );

      // Verify kitchen_delivery_override audit log was recorded
      const overrideAudit = db
        .prepare(
          `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'`,
        )
        .get(orderId11a) as any;
      assert(Boolean(overrideAudit), '11a. kitchen_delivery_override audit log recorded');

      // Subtest 11b: Order discount with pending kitchen items but valid manager override_pin
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'false');
      const create11b = await createOrder({
        type: 'dine_in',
        table_id: 'table-eb-1',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId11b = create11b.data.order.id;
      const gen11b = await generateBill(orderId11b);
      const billId11b = gen11b.data.bill.id;

      const pay11b = await pay(billId11b, { method: 'cash', amount: 600 });
      assertEqual(pay11b.status, 200, '11b. pay 600 accepted');

      // Enable kitchen delivery requirement and mark item as preparing
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId11b);

      // Apply order discount with manager override PIN
      const disc11b = await applyOrderDiscount(orderId11b, {
        discount_type: 'amount',
        discount_value: 400,
        override_pin: '1234',
        approver_id: managerId,
      });
      assertEqual(disc11b.status, 200, '11b. order discount with manager PIN applied');
      const bill11bFinal = billRow(db, billId11b);
      assertEqual(
        bill11bFinal.payment_status,
        'paid',
        '11b. bill auto-settles to paid when manager override PIN supplied in discount',
      );
      assertEqual(
        orderRow(db, orderId11b).status,
        'completed',
        '11b. order completes with manager override',
      );
      assertEqual(
        tableRow(db, 'table-eb-1').status,
        'available',
        '11b. table released to available with manager override',
      );

      // Subtest 11c: Item discount with pending kitchen items -> served transition -> zero-balance retry
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'false');
      const create11c = await createOrder({
        type: 'dine_in',
        table_id: 'table-eb-1',
        items: [{ product_id: 'prod-1000', quantity: 1 }],
      });
      const orderId11c = create11c.data.order.id;
      const itemId11c = create11c.data.order.items[0].id;
      const gen11c = await generateBill(orderId11c);
      const billId11c = gen11c.data.bill.id;

      const pay11c = await pay(billId11c, { method: 'cash', amount: 600 });
      assertEqual(pay11c.status, 200, '11c. pay 600 accepted');

      // Enable kitchen delivery requirement and mark item as preparing
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId11c);

      // Item discount reduces balance to 0 without override PIN
      const disc11c = await itemDiscount(orderId11c, itemId11c, {
        discount_type: 'amount',
        discount_value: 400,
      });
      assertEqual(disc11c.status, 200, '11c. item discount applied');
      assertEqual(
        billRow(db, billId11c).payment_status,
        'partial',
        '11c. bill stays partial because kitchen items are preparing',
      );

      // Mark items as served (kitchen delivery satisfied)
      db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(orderId11c);

      // Now zero-balance retry succeeds without needing PIN!
      const settle11c = await pay(billId11c, { method: 'cash', amount: null });
      assertEqual(
        settle11c.status,
        200,
        '11c. zero-balance settle succeeds after kitchen items served',
      );
      assertEqual(
        billRow(db, billId11c).payment_status,
        'paid',
        '11c. bill transitions to paid after items served',
      );
      assertEqual(
        orderRow(db, orderId11c).status,
        'completed',
        '11c. order transitions to completed',
      );
      assertEqual(
        tableRow(db, 'table-eb-1').status,
        'available',
        '11c. table released to available',
      );

      // Restore settings
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'false');
    }

    // ── 12. Paid-Bill Automation Dispatch on Exact-Balance Auto-Settlement ──
    console.log(
      '\n─── 12. Paid-Bill Automation Dispatch on Exact-Balance Auto-Settlement ───',
    );
    {
      const whatsapp = require('../main/services/whatsapp');
      const originalTrigger = whatsapp.triggerBillPaidAutomation;
      const automationCalls: Array<{ billId: number; opts: any }> = [];
      whatsapp.triggerBillPaidAutomation = async (billId: number, opts?: any) => {
        automationCalls.push({ billId: Number(billId), opts });
        return { triggered: [], results: {} };
      };

      try {
        setSetting(db, 'cashback_percentage', '10');
        db.prepare(
          `INSERT OR IGNORE INTO customers (id, name, phone, created_at, updated_at)
           VALUES ('cust-eb-auto', 'Auto Settlement Customer', '+14155550199', ?, ?)`,
        ).run(now(), now());

        // 12a. Order item edit reducing order total to match collected paid_amount triggers automation
        const create12a = await createOrder({
          type: 'takeaway',
          customer_id: 'cust-eb-auto',
          items: [{ product_id: 'prod-400', quantity: 2 }],
        });
        assertEqual(create12a.status, 201, '12a. order with 2x 400 created');
        const orderId12a = create12a.data.order.id;
        const item12a = create12a.data.order.items[0];
        const gen12a = await generateBill(orderId12a);
        assertEqual(gen12a.status, 201, '12a. bill generated');
        const billId12a = Number(gen12a.data.bill.id);

        const pay12a = await pay(billId12a, { method: 'cash', amount: 400 });
        assertEqual(pay12a.status, 200, '12a. partial payment 400 recorded');
        assertEqual(automationCalls.length, 0, '12a. no paid-bill automation on partial payment');

        const edit12a = await api(
          baseUrl,
          `/api/orders/${orderId12a}/items/${item12a.id}/edit`,
          {
            method: 'PATCH',
            body: {
              quantity: 1,
              expected_edit_version: item12a.edit_version ?? 0,
              reason: 'Reduce quantity to match paid amount',
            },
            headers: { ...A, 'Idempotency-Key': 'eb-auto-12a' },
          },
        );
        assertEqual(edit12a.status, 200, '12a. item quantity edit to exact paid balance succeeded');
        assertEqual(
          billRow(db, billId12a).payment_status,
          'paid',
          '12a. bill auto-settled to paid on item edit',
        );
        assertEqual(
          automationCalls.length,
          1,
          '12a. triggerBillPaidAutomation called once after syncUnpaidBillsForOrder auto-settlement',
        );
        assertEqual(
          automationCalls[0]?.billId,
          billId12a,
          '12a. triggerBillPaidAutomation called with auto-settled billId',
        );
        assert(
          Number(automationCalls[0]?.opts?.pointsEarned) > 0,
          '12a. triggerBillPaidAutomation receives loyalty pointsEarned from auto-settlement',
        );

        // 12b. Bill discount reducing balance to 0 triggers automation; failed 409 discount does not
        automationCalls.length = 0;
        const create12b = await createOrder({
          type: 'takeaway',
          customer_id: 'cust-eb-auto',
          items: [{ product_id: 'prod-1000', quantity: 1 }],
        });
        const orderId12b = create12b.data.order.id;
        const gen12b = await generateBill(orderId12b);
        const billId12b = Number(gen12b.data.bill.id);
        await pay(billId12b, { method: 'cash', amount: 600 });
        assertEqual(automationCalls.length, 0, '12b. no automation after partial payment');

        const overDisc12b = await applyBillDiscount(billId12b, {
          type: 'amount',
          value: 500,
          reason: 'Exceeds remaining balance',
        });
        assertEqual(overDisc12b.status, 409, '12b. discount below collected funds rejected');
        assertEqual(
          automationCalls.length,
          0,
          '12b. rolled-back/rejected discount does not trigger paid-bill automation',
        );

        const exactDisc12b = await applyBillDiscount(billId12b, {
          type: 'amount',
          value: 400,
          reason: 'Exact remaining balance discount',
        });
        assertEqual(exactDisc12b.status, 200, '12b. exact-balance bill discount succeeded');
        assertEqual(
          automationCalls.length,
          1,
          '12b. triggerBillPaidAutomation called once after exact-balance bill discount',
        );
        assertEqual(
          automationCalls[0]?.billId,
          billId12b,
          '12b. triggerBillPaidAutomation received discounted billId',
        );

        // 12c. POST /api/bills/generate auto-settling a partial bill whose order total matches paid_amount triggers automation
        automationCalls.length = 0;
        const create12c = await createOrder({
          type: 'takeaway',
          customer_id: 'cust-eb-auto',
          items: [{ product_id: 'prod-1000', quantity: 1 }],
        });
        const orderId12c = create12c.data.order.id;
        const gen12cInitial = await generateBill(orderId12c);
        const billId12c = Number(gen12cInitial.data.bill.id);
        await pay(billId12c, { method: 'cash', amount: 600 });
        // Simulate an order total already reduced to 600 while bill remained partial before /generate resync
        db.prepare('UPDATE orders SET subtotal = 600, total = 600 WHERE id = ?').run(orderId12c);
        const regen12c = await generateBill(orderId12c);
        assertEqual(regen12c.status, 200, '12c. bill generate resync succeeded');
        assertEqual(
          regen12c.data.bill.payment_status,
          'paid',
          '12c. bill auto-settled to paid during generate resync',
        );
        assertEqual(
          automationCalls.length,
          1,
          '12c. triggerBillPaidAutomation called once after POST /api/bills/generate auto-settlement',
        );
        assertEqual(
          automationCalls[0]?.billId,
          billId12c,
          '12c. triggerBillPaidAutomation received regenerated billId',
        );
      } finally {
        whatsapp.triggerBillPaidAutomation = originalTrigger;
      }
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
