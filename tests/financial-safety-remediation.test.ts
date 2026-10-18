/**
 * Test suite for Financial Safety Remediation (Issues #1205, #1206, #1207):
 *
 * 1. Payment Replay Idempotency & PIN Decoupling (#1205):
 *    - Replaying an idempotent single payment with changed/invalid/rate-limited PIN succeeds with 200 without duplicate payments.
 *    - Replaying an idempotent batch payment with changed/invalid/rate-limited PIN succeeds with 200 without duplicate payments.
 *    - Kitchen delivery PIN verification is bypassed when all kitchen items are already delivered.
 *
 * 2. Bill & Order Discount In-Txn State Revalidation (#1206):
 *    - Bill discount application re-reads paid_amount inside transaction; if concurrent payments reduce balance below collected funds, aborts with 409 below_collected_funds.
 *    - Order discount application re-reads bill state inside transaction; if concurrent payments reduce balance below collected funds, aborts with 409 below_collected_funds.
 *    - Order discount application re-reads split status inside transaction; if bill is split concurrently, aborts with 409 split_check.
 *
 * 3. Stale Order-Item State Revalidation (#1206):
 *    - Item discount application re-reads item quantity inside transaction; if quantity was changed during async PIN approval, recalculates subtotal and total using fresh quantity.
 *
 * 4. Approver Permission Selection (#1207):
 *    - When completing an unpaid order requiring payment override and multiple managers share a PIN, the candidate loop selects the manager with payments.take permission rather than failing with 403.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fin-safety-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  getResults,
  closeDatabase,
  now,
  seedOwnerUser,
  seedCategory,
  seedProduct,
} = require('./helpers/test-setup');

const {
  billRoutes,
  resetPinRateLimitForTests: resetBillPinRateLimit,
} = require('../main/routes/bills');
const {
  orderRoutes,
  resetPinRateLimitForTests: resetOrderPinRateLimit,
} = require('../main/routes/orders');
const { getJWTSecret } = require('../main/routes/auth');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function run(): Promise<void> {
  console.log('Testing Financial Safety Remediation (Issues #1205, #1206, #1207)...');
  console.log('='.repeat(70));

  const db = initTestDb();
  resetBillPinRateLimit();
  resetOrderPinRateLimit();

  // Settings
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_requires_approval', 'true', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_mode', 'both', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_max_percentage', '100', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_max_amount', '0', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_kitchen_delivered_before_settlement', 'true', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)",
  ).run(now());

  // Seed Menu
  seedCategory(db, 'cat-fin', 'Financial Test Category');
  seedProduct(db, 'prod-100', 'cat-fin', 'Item 100', 100);
  seedProduct(db, 'prod-50', 'cat-fin', 'Item 50', 50);

  // Seed Manager 1 (PIN 1111)
  const pin1111Hash = bcrypt.hashSync('1111', 8);
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-1', 'Manager One', 'mgr1@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(pin1111Hash, now(), now());

  // Seed Cashier with discount permissions
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('cashier-1', 'Cashier One', 'cashier1@test.local', 'Pass1234!', 'cashier', 1, ?, ?)
  `).run(now(), now());
  db.prepare(`
    INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
    VALUES ('cashier-1', 'bills.discount.apply', 'allow', 'mgr-1', ?, ?),
           ('cashier-1', 'orders.discount.apply', 'allow', 'mgr-1', ?, ?)
  `).run(now(), now(), now(), now());

  // Seed Server user
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('server-1', 'Server One', 'server1@test.local', 'Pass1234!', 'server', 1, ?, ?)
  `).run(now(), now());

  const cashierAuth = makeToken('cashier-1', 'cashier', 'cashier1@test.local');
  const serverAuth = makeToken('server-1', 'server', 'server1@test.local');
  const managerAuth = makeToken('mgr-1', 'manager', 'mgr1@test.local');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // 1. Payment Replay Idempotency & PIN Decoupling (#1205)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- 1. Payment Replay Idempotency & PIN Decoupling (#1205) ---');
    {
      // Create order and bill with undelivered items so kitchen override PIN is required on first payment
      const orderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      assertEqualOrThrow(orderRes.status, 201, 'Order created');
      const orderId = orderRes.data.order.id;

      const billRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: cashierAuth,
      });
      assertEqualOrThrow(billRes.status, 201, 'Bill generated');
      const billId = billRes.data.bill.id;

      // Ensure item is preparing (undelivered)
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      const idempotencyKey = 'idem-pay-replay-001';

      // First payment: valid manager PIN override '1111'
      const pay1 = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          amount: 50,
          method: 'cash',
          override_pin: '1111',
        },
        headers: {
          ...cashierAuth,
          'Idempotency-Key': idempotencyKey,
        },
      });
      assertEqualOrThrow(pay1.status, 200, 'Initial payment with valid PIN succeeds');
      assertEqualOrThrow(pay1.data.bill.paid_amount, 50, 'Paid amount is 50');

      // Check payment count in database
      const billRow1 = db
        .prepare('SELECT payment_details FROM bills WHERE id = ?')
        .get(billId) as any;
      const payments1 = JSON.parse(billRow1.payment_details || '[]');
      assertEqualOrThrow(
        payments1.length,
        1,
        'Exactly 1 payment entry recorded in payment_details',
      );

      // Replay 1: Same idempotency key, but altered/invalid manager PIN '9999'
      const payReplayInvalidPin = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          amount: 50,
          method: 'cash',
          override_pin: '9999', // Invalid PIN
        },
        headers: {
          ...cashierAuth,
          'Idempotency-Key': idempotencyKey,
        },
      });
      assertEqualOrThrow(
        payReplayInvalidPin.status,
        200,
        'Idempotent payment replay returns 200 despite modified/invalid override_pin',
      );
      assertEqualOrThrow(
        payReplayInvalidPin.data.bill.paid_amount,
        50,
        'Replay returned cached bill response',
      );

      // Verify no duplicate payment inserted
      const billRowAfterReplay = db
        .prepare('SELECT payment_details FROM bills WHERE id = ?')
        .get(billId) as any;
      const paymentsAfterReplay = JSON.parse(billRowAfterReplay.payment_details || '[]');
      assertEqualOrThrow(
        paymentsAfterReplay.length,
        1,
        'Payment was not duplicated on replay with altered PIN',
      );

      // Replay 2: Batch payment idempotency test
      const batchIdemKey = 'idem-batch-replay-001';
      const batchPay1 = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ amount: 50, method: 'card' }],
          override_pin: '1111',
        },
        headers: {
          ...cashierAuth,
          'Idempotency-Key': batchIdemKey,
        },
      });
      assertEqualOrThrow(batchPay1.status, 200, 'Batch payment with valid PIN succeeds');

      const billRowAfterBatch = db
        .prepare('SELECT payment_details FROM bills WHERE id = ?')
        .get(billId) as any;
      const paymentsAfterBatch = JSON.parse(billRowAfterBatch.payment_details || '[]');
      assertEqualOrThrow(paymentsAfterBatch.length, 2, 'Total 2 payments recorded after batch');

      // Replay batch payment with invalid PIN
      const batchPayReplay = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ amount: 50, method: 'card' }],
          override_pin: 'wrong-pin',
        },
        headers: {
          ...cashierAuth,
          'Idempotency-Key': batchIdemKey,
        },
      });
      assertEqualOrThrow(
        batchPayReplay.status,
        200,
        'Batch payment replay returns 200 despite invalid override_pin',
      );

      const billRowAfterBatchReplay = db
        .prepare('SELECT payment_details FROM bills WHERE id = ?')
        .get(billId) as any;
      const paymentsAfterBatchReplay = JSON.parse(billRowAfterBatchReplay.payment_details || '[]');
      assertEqualOrThrow(
        paymentsAfterBatchReplay.length,
        2,
        'Batch payment was not duplicated on replay',
      );

      // Replay 3: Concurrent in-flight single payment replay
      const concurrentOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const cOrderId = concurrentOrderRes.data.order.id;
      const cBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: cOrderId },
        headers: cashierAuth,
      });
      const cBillId = cBillRes.data.bill.id;
      db.prepare("UPDATE order_items SET status = 'delivered' WHERE order_id = ?").run(cOrderId);

      const concurrentIdemKey = 'idem-concurrent-in-flight-001';
      const [concPayA, concPayB] = await Promise.all([
        api(baseUrl, `/api/bills/${cBillId}/payment`, {
          method: 'POST',
          body: { amount: 100, method: 'cash' },
          headers: { ...cashierAuth, 'Idempotency-Key': concurrentIdemKey },
        }),
        api(baseUrl, `/api/bills/${cBillId}/payment`, {
          method: 'POST',
          body: { amount: 100, method: 'cash' },
          headers: { ...cashierAuth, 'Idempotency-Key': concurrentIdemKey },
        }),
      ]);

      assertEqualOrThrow(concPayA.status, 200, 'First concurrent payment returns 200');
      assertEqualOrThrow(concPayB.status, 200, 'Second concurrent payment returns 200');
      assertEqualOrThrow(concPayA.data.bill.paid_amount, 100, 'First response reports 100 paid');
      assertEqualOrThrow(concPayB.data.bill.paid_amount, 100, 'Second response reports 100 paid');

      const cBillRow = db
        .prepare('SELECT paid_amount, payment_details FROM bills WHERE id = ?')
        .get(cBillId) as any;
      assertEqualOrThrow(cBillRow.paid_amount, 100, 'Total recorded paid amount is exactly 100');
      const cPayments = JSON.parse(cBillRow.payment_details || '[]');
      assertEqualOrThrow(
        cPayments.length,
        1,
        'Exactly 1 payment record inserted in database for concurrent replay',
      );

      // Replay 4: Concurrent in-flight replay with manager PIN override
      const pinOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const pinOrderId = pinOrderRes.data.order.id;
      const pinBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: pinOrderId },
        headers: cashierAuth,
      });
      const pinBillId = pinBillRes.data.bill.id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(pinOrderId);

      const pinIdemKey = 'idem-concurrent-pin-override-001';
      const [pinPayA, pinPayB] = await Promise.all([
        api(baseUrl, `/api/bills/${pinBillId}/payment`, {
          method: 'POST',
          body: { amount: 100, method: 'cash', override_pin: '1111' },
          headers: { ...cashierAuth, 'Idempotency-Key': pinIdemKey },
        }),
        api(baseUrl, `/api/bills/${pinBillId}/payment`, {
          method: 'POST',
          body: { amount: 100, method: 'cash', override_pin: '9999' },
          headers: { ...cashierAuth, 'Idempotency-Key': pinIdemKey },
        }),
      ]);

      assertEqualOrThrow(pinPayA.status, 200, 'Primary in-flight payment succeeds with valid PIN');
      assertEqualOrThrow(
        pinPayB.status,
        200,
        'Concurrent replay with modified PIN succeeds without 403 error',
      );
      assertEqualOrThrow(
        pinPayB.data.bill.paid_amount,
        100,
        'Concurrent replay returned settled bill',
      );

      const pinBillRow = db
        .prepare('SELECT paid_amount, payment_details FROM bills WHERE id = ?')
        .get(pinBillId) as any;
      assertEqualOrThrow(pinBillRow.paid_amount, 100, 'Paid amount is exactly 100');
      const pinPayments = JSON.parse(pinBillRow.payment_details || '[]');
      assertEqualOrThrow(
        pinPayments.length,
        1,
        'Exactly 1 payment recorded for concurrent in-flight replay with PIN',
      );

      // Replay 5: In-flight attempt where owner rejects (invalid PIN), waiter continues with valid PIN
      const failOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const failOrderId = failOrderRes.data.order.id;
      const failBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: failOrderId },
        headers: cashierAuth,
      });
      const failBillId = failBillRes.data.bill.id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(failOrderId);

      const rejectedOwnerIdemKey = 'idem-owner-reject-waiter-succeeds-001';
      const reqA = api(baseUrl, `/api/bills/${failBillId}/payment`, {
        method: 'POST',
        body: { amount: 100, method: 'cash', override_pin: '9999' },
        headers: { ...cashierAuth, 'Idempotency-Key': rejectedOwnerIdemKey },
      });
      const reqB = api(baseUrl, `/api/bills/${failBillId}/payment`, {
        method: 'POST',
        body: { amount: 100, method: 'cash', override_pin: '1111' },
        headers: { ...cashierAuth, 'Idempotency-Key': rejectedOwnerIdemKey },
      });
      const [resA, resB] = await Promise.all([reqA, reqB]);

      assertEqualOrThrow(resA.status, 403, 'Owner attempt with invalid PIN returns 403');
      assertEqualOrThrow(resB.status, 200, 'Waiter with valid PIN succeeds after owner rejection');
      assertEqualOrThrow(resB.data.bill.paid_amount, 100, 'Waiter completed payment');
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. Kitchen Delivery PIN Verification Skipped when Items Delivered (#1205)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- 2. Kitchen Delivery PIN Skipped when Items Delivered (#1205) ---');
    {
      const orderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-50', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const orderId = orderRes.data.order.id;

      const billRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: cashierAuth,
      });
      const billId = billRes.data.bill.id;

      // Mark all kitchen items as delivered
      db.prepare("UPDATE order_items SET status = 'delivered' WHERE order_id = ?").run(orderId);

      // Attempt payment with invalid override_pin
      // Since kitchen delivery is satisfied, PIN verification should be bypassed entirely
      const payRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          amount: 50,
          method: 'cash',
          override_pin: 'invalid-pin-should-be-ignored',
        },
        headers: cashierAuth,
      });
      assertEqualOrThrow(
        payRes.status,
        200,
        'Payment succeeds without PIN verification when all kitchen items are already delivered',
      );
      assertEqualOrThrow(payRes.data.bill.payment_status, 'paid', 'Bill is fully paid');
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 3. Bill & Order Discount In-Txn State Revalidation (#1206)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- 3. Bill & Order Discount In-Txn State Revalidation (#1206) ---');
    {
      // Test 3A: Bill discount reducing total below collected payments is rejected with 409
      const orderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const orderId = orderRes.data.order.id;

      const billRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: cashierAuth,
      });
      const billId = billRes.data.bill.id;

      // Mark delivered to allow partial payment without manager PIN
      db.prepare("UPDATE order_items SET status = 'delivered' WHERE order_id = ?").run(orderId);

      // Collect partial payment of 60
      const partialPay = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { amount: 60, method: 'cash' },
        headers: cashierAuth,
      });
      assertEqualOrThrow(partialPay.status, 200, 'Partial payment of 60 accepted');

      // Attempt bill discount of 50 (would reduce total to 50, below collected 60)
      const discountRes = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: {
          type: 'amount',
          value: 50,
          override_pin: '1111',
        },
        headers: cashierAuth,
      });
      assertEqualOrThrow(
        discountRes.status,
        409,
        'Bill discount reducing total below collected funds is rejected with 409',
      );
      assertEqualOrThrow(
        discountRes.data.display_code,
        'below_collected_funds',
        'Rejection has diagnostic code below_collected_funds',
      );

      // Verify bill state remains unchanged
      const currentBill = db
        .prepare('SELECT total, paid_amount, balance FROM bills WHERE id = ?')
        .get(billId) as any;
      assertEqualOrThrow(currentBill.total, 100, 'Bill total unchanged at 100');
      assertEqualOrThrow(currentBill.paid_amount, 60, 'Bill paid_amount unchanged at 60');
      assertEqualOrThrow(currentBill.balance, 40, 'Bill balance unchanged at 40');

      // Test 3B: Order discount reducing total below collected payments is rejected with 409
      const orderDiscountRes = await api(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: {
          discount_type: 'amount',
          discount_value: 50,
          override_pin: '1111',
        },
        headers: cashierAuth,
      });
      assertEqualOrThrow(
        orderDiscountRes.status,
        409,
        'Order discount reducing total below collected funds is rejected with 409',
      );
      assertEqualOrThrow(
        orderDiscountRes.data.display_code,
        'below_collected_funds',
        'Order discount rejection has diagnostic code below_collected_funds',
      );

      // Test 3C: Order discount rejected when check was split
      const splitOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const splitOrderId = splitOrderRes.data.order.id;
      const splitBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: splitOrderId },
        headers: cashierAuth,
      });
      const splitBillId = splitBillRes.data.bill.id;

      // Simulate split group on bill
      db.prepare("UPDATE bills SET split_group_id = 'group-123' WHERE id = ?").run(splitBillId);

      const splitDiscountRes = await api(baseUrl, `/api/orders/${splitOrderId}/discount`, {
        method: 'PATCH',
        body: {
          discount_type: 'percentage',
          discount_value: 10,
          override_pin: '1111',
        },
        headers: cashierAuth,
      });
      assertEqualOrThrow(
        splitDiscountRes.status,
        409,
        'Order discount rejected with 409 when bill is split',
      );
      assertEqualOrThrow(
        splitDiscountRes.data.display_code,
        'split_check',
        'Rejection has diagnostic code split_check',
      );

      // Test 3D: Race scenario - Payment before Discount
      // Bill total = 100. Payment of 80 is processed first.
      // Discount of 50 is then attempted.
      // Inside transaction, discount detects new total (50) < collected payments (80)
      // and aborts with 409 below_collected_funds, leaving financial state intact.
      const raceOrder1Res = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const race1OrderId = raceOrder1Res.data.order.id;
      const race1BillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: race1OrderId },
        headers: cashierAuth,
      });
      const race1BillId = race1BillRes.data.bill.id;
      db.prepare("UPDATE order_items SET status = 'delivered' WHERE order_id = ?").run(
        race1OrderId,
      );

      // Process payment of 80
      const payBeforeDiscount = await api(baseUrl, `/api/bills/${race1BillId}/payment`, {
        method: 'POST',
        body: { amount: 80, method: 'cash' },
        headers: cashierAuth,
      });
      assertEqualOrThrow(payBeforeDiscount.status, 200, 'Payment of 80 recorded before discount');

      // Attempt bill discount of 50
      const rejectedDiscount = await api(baseUrl, `/api/bills/${race1BillId}/applyDiscount`, {
        method: 'POST',
        body: { type: 'amount', value: 50, override_pin: '1111' },
        headers: cashierAuth,
      });
      assertEqualOrThrow(
        rejectedDiscount.status,
        409,
        'Bill discount after payment is rejected with 409 when reducing total below collected funds',
      );
      assertEqualOrThrow(
        rejectedDiscount.data.display_code,
        'below_collected_funds',
        'Rejection has diagnostic code below_collected_funds',
      );

      const billAfterRejectedDiscount = db
        .prepare('SELECT total, paid_amount, balance FROM bills WHERE id = ?')
        .get(race1BillId) as any;
      assertEqualOrThrow(billAfterRejectedDiscount.total, 100, 'Bill total unchanged at 100');
      assertEqualOrThrow(billAfterRejectedDiscount.paid_amount, 80, 'Bill paid_amount remains 80');
      assertEqualOrThrow(billAfterRejectedDiscount.balance, 20, 'Bill balance remains 20');

      // Test 3E: Race scenario - Discount before Payment
      // Bill total = 100. Discount of 30 is applied first (new total = 70, balance = 70).
      // Payment of 70 is then processed.
      // Payment succeeds, settling the freshly discounted bill.
      const raceOrder2Res = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const race2OrderId = raceOrder2Res.data.order.id;
      const race2BillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: race2OrderId },
        headers: cashierAuth,
      });
      const race2BillId = race2BillRes.data.bill.id;
      db.prepare("UPDATE order_items SET status = 'delivered' WHERE order_id = ?").run(
        race2OrderId,
      );

      // Apply discount of 30
      const discountBeforePayment = await api(baseUrl, `/api/bills/${race2BillId}/applyDiscount`, {
        method: 'POST',
        body: { type: 'amount', value: 30, override_pin: '1111' },
        headers: cashierAuth,
      });
      assertEqualOrThrow(
        discountBeforePayment.status,
        200,
        'Discount of 30 applied before payment',
      );
      assertEqualOrThrow(discountBeforePayment.data.bill.total, 70, 'Discounted total is 70');
      assertEqualOrThrow(discountBeforePayment.data.bill.balance, 70, 'Discounted balance is 70');

      // Settle the discounted balance of 70
      const payAfterDiscount = await api(baseUrl, `/api/bills/${race2BillId}/payment`, {
        method: 'POST',
        body: { amount: 70, method: 'cash' },
        headers: cashierAuth,
      });
      assertEqualOrThrow(payAfterDiscount.status, 200, 'Payment for discounted balance succeeds');
      assertEqualOrThrow(payAfterDiscount.data.bill.payment_status, 'paid', 'Bill is fully paid');
      assertEqualOrThrow(payAfterDiscount.data.bill.balance, 0, 'Bill balance is 0');

      // Test 3F: Controlled barrier race - Simultaneous Payment and Discount
      // Bill total = 100. Simultaneous execution via Promise.all
      const barrierOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: cashierAuth,
      });
      const barrierOrderId = barrierOrderRes.data.order.id;
      const barrierBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: barrierOrderId },
        headers: cashierAuth,
      });
      const barrierBillId = barrierBillRes.data.bill.id;
      db.prepare("UPDATE order_items SET status = 'delivered' WHERE order_id = ?").run(
        barrierOrderId,
      );

      const [racePayment, raceDiscount] = await Promise.all([
        api(baseUrl, `/api/bills/${barrierBillId}/payment`, {
          method: 'POST',
          body: { amount: 80, method: 'cash' },
          headers: cashierAuth,
        }),
        api(baseUrl, `/api/bills/${barrierBillId}/applyDiscount`, {
          method: 'POST',
          body: { type: 'amount', value: 50, override_pin: '1111' },
          headers: cashierAuth,
        }),
      ]);

      // Exactly one order of operations occurred; verify consistency
      const finalBillState = db
        .prepare('SELECT total, paid_amount, balance FROM bills WHERE id = ?')
        .get(barrierBillId) as any;
      assertOrThrow(
        finalBillState.paid_amount <= finalBillState.total,
        'In-txn coordination ensures collected funds never exceed total',
      );
      assertEqualOrThrow(
        finalBillState.balance,
        Math.max(0, finalBillState.total - finalBillState.paid_amount),
        'Bill balance accurately reflects total minus paid_amount',
      );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. Stale Order-Item State Revalidation (#1206)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- 4. Stale Order-Item State Revalidation (#1206) ---');
    {
      // Create order with item quantity = 2 (unit price 50, subtotal 100)
      const orderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-50', quantity: 2 }],
        },
        headers: cashierAuth,
      });
      const orderId = orderRes.data.order.id;
      const itemId = orderRes.data.order.items[0].id;

      await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: cashierAuth,
      });

      // Concurrently change item quantity from 2 to 1 in database
      // (simulating edit during async PIN approval)
      db.prepare(`
        UPDATE order_items
        SET quantity = 1, subtotal = 50, total = 50, updated_at = ?
        WHERE id = ?
      `).run(now(), itemId);
      db.prepare(`
        UPDATE orders
        SET subtotal = 50, total = 50, updated_at = ?
        WHERE id = ?
      `).run(now(), orderId);
      db.prepare(`
        UPDATE bills
        SET subtotal = 50, total = 50, balance = 50, updated_at = ?
        WHERE order_id = ?
      `).run(now(), orderId);

      // Apply 20% item discount
      const itemDiscountRes = await api(
        baseUrl,
        `/api/orders/${orderId}/items/${itemId}/discount`,
        {
          method: 'PATCH',
          body: {
            discount_type: 'percentage',
            discount_value: 20,
            override_pin: '1111',
          },
          headers: cashierAuth,
        },
      );
      assertEqualOrThrow(itemDiscountRes.status, 200, 'Item discount applied successfully');

      // Verify that the item discount was computed using fresh quantity 1 (50 * 20% = 10 discount, 40 total)
      // rather than stale quantity 2 (100 * 20% = 20 discount, 80 total)
      const updatedItem = db
        .prepare('SELECT quantity, discount_amount, subtotal, total FROM order_items WHERE id = ?')
        .get(itemId) as any;
      assertEqualOrThrow(updatedItem.quantity, 1, 'Item quantity is 1');
      assertEqualOrThrow(
        updatedItem.discount_amount,
        10,
        'Item discount is 10 (20% of 50, not stale 20)',
      );
      assertEqualOrThrow(updatedItem.subtotal, 40, 'Item subtotal is 40');
      assertEqualOrThrow(updatedItem.total, 40, 'Item total is 40');

      const updatedOrder = db
        .prepare('SELECT subtotal, total FROM orders WHERE id = ?')
        .get(orderId) as any;
      assertEqualOrThrow(updatedOrder.subtotal, 40, 'Order subtotal matches fresh item total');
      assertEqualOrThrow(updatedOrder.total, 40, 'Order total matches fresh item total');

      const updatedBill = db
        .prepare('SELECT subtotal, total, balance FROM bills WHERE order_id = ?')
        .get(orderId) as any;
      assertEqualOrThrow(updatedBill.subtotal, 40, 'Bill subtotal is 40');
      assertEqualOrThrow(updatedBill.total, 40, 'Bill total is 40');
      assertEqualOrThrow(updatedBill.balance, 40, 'Bill balance is 40');
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 5. Approver Permission Selection (#1207)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- 5. Approver Permission Selection (#1207) ---');
    {
      // Seed two managers sharing the exact same PIN '4444'
      // Manager A (mgr-no-pay): has orders.status.update, DENIED payments.take
      // Manager B (mgr-with-pay): has orders.status.update AND payments.take
      const sharedPinHash = bcrypt.hashSync('4444', 8);

      db.prepare(`
        INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
        VALUES ('mgr-no-pay', 'Manager No Pay', 'mgr_nopay@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
      `).run(sharedPinHash, now(), now());

      db.prepare(`
        INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
        VALUES ('mgr-no-pay', 'payments.take', 'deny', 'mgr-1', ?, ?)
      `).run(now(), now());

      db.prepare(`
        INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
        VALUES ('mgr-with-pay', 'Manager With Pay', 'mgr_pay@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
      `).run(sharedPinHash, now(), now());

      // Create unpaid order as server-1 (who lacks payments.take)
      const orderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: serverAuth,
      });
      const orderId = orderRes.data.order.id;

      // Generate unpaid bill
      await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: cashierAuth,
      });

      // Complete unpaid order as server-1 using PIN '4444'
      // Prior to fix: The pre-verification loop selected 'mgr-no-pay' (ordered first by id),
      // which failed inside withTxn because 'mgr-no-pay' lacks payments.take, returning 403.
      // With fix: The pre-verification loop requires candidate to have payments.take when order
      // is unpaid, correctly selecting 'mgr-with-pay'.
      const completeRes = await api(baseUrl, `/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: {
          status: 'completed',
          override_pin: '4444',
        },
        headers: serverAuth,
      });

      assertEqualOrThrow(
        completeRes.status,
        200,
        'Order completion succeeds by selecting manager with payments.take permission',
      );
      assertEqualOrThrow(
        completeRes.data.order.status,
        'completed',
        'Order status updated to completed',
      );

      // Verify audit log recorded mgr-with-pay as the approver
      const auditLog = db
        .prepare(
          "SELECT details_json FROM order_audit_log WHERE order_id = ? AND action = 'status_changed' ORDER BY id DESC LIMIT 1",
        )
        .get(orderId) as any;
      assertOrThrow(Boolean(auditLog), 'Audit log entry created for status change');
      const details = JSON.parse(auditLog.details_json || '{}');
      assertEqualOrThrow(
        details.approved_by,
        'mgr-with-pay',
        'Audit log correctly attributes approval to mgr-with-pay',
      );

      // Test null-balance fully-paid bill completion with kitchen-only override
      const nullBalOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          items: [{ product_id: 'prod-100', quantity: 1 }],
        },
        headers: serverAuth,
      });
      const nullBalOrderId = nullBalOrderRes.data.order.id;
      const nullBalBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: nullBalOrderId },
        headers: cashierAuth,
      });
      const nullBalBillId = nullBalBillRes.data.bill.id;
      // Mark bill paid, but simulate legacy record where balance is NULL
      db.prepare(
        "UPDATE bills SET paid_amount = 100, balance = NULL, payment_status = 'paid' WHERE id = ?",
      ).run(nullBalBillId);
      // Mark item preparing so kitchen override is required
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(
        nullBalOrderId,
      );

      // Complete order specifying mgr-no-pay explicitly (who only has orders.status.update)
      const completeNullBalRes = await api(baseUrl, `/api/orders/${nullBalOrderId}/status`, {
        method: 'PATCH',
        body: {
          status: 'completed',
          override_pin: '4444',
          approver_id: 'mgr-no-pay',
        },
        headers: serverAuth,
      });
      assertEqualOrThrow(
        completeNullBalRes.status,
        200,
        'Order with null-balance paid bill completes via kitchen override without requiring payments.take',
      );
      assertEqualOrThrow(
        completeNullBalRes.data.order.status,
        'completed',
        'Null-balance order status is completed',
      );
    }

    console.log('\nAll Financial Safety Remediation tests passed successfully!');
  } finally {
    server.close();
    closeDatabase();
  }

  const { passed, failed, total } = getResults();
  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
