// Verification of settlement idempotency, zero-balance replays, and payment concurrency.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-settle-idem-'));

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
let pinApprovalHook: (() => Promise<void> | void) | null = null;
const originalBcryptCompare = bcrypt.compare;
bcrypt.compare = async function (...args: any[]) {
  if (pinApprovalHook) {
    const hook = pinApprovalHook;
    pinApprovalHook = null;
    await hook();
  }
  return originalBcryptCompare.apply(this, args);
};

const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  seedCustomer,
  seedTable,
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

function setSetting(db: any, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  assert(condition, message);
  if (!condition) {
    failures.push(message);
  }
}

function checkEqual(actual: any, expected: any, message: string): void {
  assertEqual(actual, expected, message);
  if (actual !== expected) {
    const detail = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(detail);
  }
}

async function run(): Promise<void> {
  console.log('Testing Financial Settlement Remediation (Settlement Idempotency & Concurrency)...');
  console.log('='.repeat(70));

  const db = initTestDb();
  resetBillPinRateLimit();
  resetOrderPinRateLimit();

  // Settings
  setSetting(db, 'discount_mode', 'both');
  setSetting(db, 'discount_max_amount', '0');
  setSetting(db, 'discount_max_percentage', '100');
  setSetting(db, 'discount_requires_approval', 'false');
  setSetting(db, 'split_checks_enabled', 'true');
  setSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
  setSetting(db, 'loyalty_enabled', 'false');
  setSetting(db, 'global_cashback_percent', '10');

  const { authHeader: ownerAuth, userId: ownerId } = seedOwnerUser(db);
  const { authHeader: managerAuth, userId: managerId } = seedManagerUser(db);
  const managerAPin = '1234';

  seedCategory(db, 'cat-settle', 'Settle menu');
  seedProduct(db, 'prod-1000', 'cat-settle', 'Thousand', 1000, { cb_percent: 10 });
  seedProduct(db, 'prod-500', 'cat-settle', 'Five hundred', 500, { cb_percent: 10 });
  seedCustomer(db, 'cust-f1', 'Loyalty Customer');
  seedTable(db, 'table-settle-1', 1);
  seedTable(db, 'table-settle-2', 2);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // Zero-amount payments on already-paid bills must not re-award loyalty points or enforce kitchen delivery.
    console.log('\n--- Section 1: Paid Bill Loyalty & Kitchen Delivery Checks ---');

    // Single payment zero-amount call on paid bill with loyalty enabled post-settlement
    {
      console.log(
        '\n[1.1] Single payment zero-amount call on paid bill with loyalty enabled post-settlement',
      );
      setSetting(db, 'loyalty_enabled', 'false');

      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          table_id: 'table-settle-1',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-1000', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      checkEqual(createOrder.status, 201, 'Order created');
      const orderId = createOrder.data?.order?.id;

      // Deliver items
      db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      checkEqual(genBill.status, 201, 'Bill generated');
      const billId = genBill.data?.bill?.id;

      // Settle bill fully while loyalty is disabled
      const settleRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: 1000, customer_id: 'cust-f1' },
        headers: ownerAuth,
      });
      checkEqual(settleRes.status, 200, 'Bill fully paid');
      checkEqual(settleRes.data?.bill?.payment_status, 'paid', 'Bill status is paid');
      checkEqual(
        settleRes.data?.loyaltyPointsEarned,
        0,
        'No loyalty points earned while loyalty disabled',
      );

      const initialLedgerCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM loyalty_ledger WHERE bill_id = ?')
          .get(billId) as any
      ).cnt;
      checkEqual(initialLedgerCount, 0, 'No initial loyalty_ledger rows for bill');

      // Now enable loyalty cashback
      setSetting(db, 'loyalty_enabled', 'true');
      setSetting(db, 'global_cashback_percent', '10');

      // Call single payment with amount: null on the already-paid bill
      const nullPayRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: null, customer_id: 'cust-f1' },
        headers: ownerAuth,
      });
      checkEqual(
        nullPayRes.status,
        200,
        'Null-amount payment call on already-paid bill returns 200',
      );
      checkEqual(
        nullPayRes.data?.loyaltyPointsEarned ?? 0,
        0,
        'Null-amount payment call on already-paid bill awards 0 loyalty points',
      );

      const nullLedgerCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM loyalty_ledger WHERE bill_id = ?')
          .get(billId) as any
      ).cnt;
      checkEqual(
        nullLedgerCount,
        0,
        'No loyalty_ledger rows created by null-amount call on paid bill',
      );

      // Call single payment with amount: 0 on the already-paid bill
      const zeroPayRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: 0, customer_id: 'cust-f1' },
        headers: ownerAuth,
      });
      checkEqual(
        zeroPayRes.status,
        200,
        'Zero-amount payment call on already-paid bill returns 200',
      );
      checkEqual(
        zeroPayRes.data?.loyaltyPointsEarned ?? 0,
        0,
        'Zero-amount payment call on already-paid bill awards 0 loyalty points',
      );

      const afterLedgerCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM loyalty_ledger WHERE bill_id = ?')
          .get(billId) as any
      ).cnt;
      checkEqual(
        afterLedgerCount,
        0,
        'No loyalty_ledger rows created by zero-amount call on paid bill',
      );

      // Retry with an Idempotency-Key
      const zeroIdemRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: 0, customer_id: 'cust-f1' },
        headers: { ...ownerAuth, 'Idempotency-Key': 'idem-f1-zero-single-001' },
      });
      checkEqual(zeroIdemRes.status, 200, 'Idempotent zero-amount payment call returns 200');
      checkEqual(
        zeroIdemRes.data?.loyaltyPointsEarned ?? 0,
        0,
        'Idempotent zero-amount payment call awards 0 loyalty points',
      );

      const afterIdemLedgerCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM loyalty_ledger WHERE bill_id = ?')
          .get(billId) as any
      ).cnt;
      checkEqual(
        afterIdemLedgerCount,
        0,
        'Still 0 loyalty_ledger rows after idempotent zero-amount call',
      );
    }

    // Batch payments zero-amount call on paid bill with loyalty enabled post-settlement
    {
      console.log(
        '\n[1.2] Batch payments zero-amount call on paid bill with loyalty enabled post-settlement',
      );
      setSetting(db, 'loyalty_enabled', 'false');

      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      // Settle via batch payments
      const settleRes = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ method: 'cash', amount: 500 }],
          customer_id: 'cust-f1',
        },
        headers: ownerAuth,
      });
      checkEqual(settleRes.status, 200, 'Batch payment settled bill');
      checkEqual(settleRes.data?.loyaltyPointsEarned, 0, 'No loyalty points earned while disabled');

      // Enable loyalty
      setSetting(db, 'loyalty_enabled', 'true');

      // Call batch payments with amount: null
      const batchNullRes = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ method: 'cash', amount: null }],
          customer_id: 'cust-f1',
        },
        headers: ownerAuth,
      });
      checkEqual(
        batchNullRes.status,
        200,
        'Batch null-amount payment call on already-paid bill returns 200',
      );
      checkEqual(
        batchNullRes.data?.loyaltyPointsEarned ?? 0,
        0,
        'Batch null-amount payment call awards 0 loyalty points',
      );

      // Call batch payments with amount: 0
      const batchZeroRes = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ method: 'cash', amount: 0 }],
          customer_id: 'cust-f1',
        },
        headers: { ...ownerAuth, 'Idempotency-Key': 'idem-f1-zero-batch-001' },
      });
      checkEqual(
        batchZeroRes.status,
        200,
        'Batch zero-amount payment call on already-paid bill returns 200',
      );
      checkEqual(
        batchZeroRes.data?.loyaltyPointsEarned ?? 0,
        0,
        'Batch zero-amount payment call awards 0 loyalty points',
      );

      const batchLedgerCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM loyalty_ledger WHERE bill_id = ?')
          .get(billId) as any
      ).cnt;
      checkEqual(
        batchLedgerCount,
        0,
        'No loyalty_ledger rows created by batch zero-amount call on paid bill',
      );
    }

    // Paid bill zero-amount call does not mutate bill/order/table state
    {
      console.log('\n[1.3] Zero-amount call on paid bill does not mutate database records');
      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: 500 },
        headers: ownerAuth,
      });

      const billBefore = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
      const orderBefore = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;

      // Small sleep to ensure updated_at would differ if touched
      await new Promise((r) => setTimeout(r, 50));

      const nullCall = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: null },
        headers: ownerAuth,
      });
      checkEqual(nullCall.status, 200, 'Null-amount call returns 200');

      const billAfter = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
      const orderAfter = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;

      checkEqual(billAfter.payment_status, 'paid', 'Bill payment_status remains paid');
      checkEqual(billAfter.paid_amount, billBefore.paid_amount, 'Bill paid_amount unchanged');
      checkEqual(billAfter.balance, billBefore.balance, 'Bill balance unchanged');
      checkEqual(billAfter.updated_at, billBefore.updated_at, 'Bill updated_at untouched');
      checkEqual(orderAfter.status, orderBefore.status, 'Order status unchanged');
      checkEqual(orderAfter.updated_at, orderBefore.updated_at, 'Order updated_at untouched');
    }

    // Already-paid bill with undelivered kitchen items skips kitchen verification
    {
      console.log(
        '\n[1.4] Paid bill with undelivered kitchen items does not require override PIN on 0-amount call',
      );
      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      // Item is preparing (undelivered)
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      // Settle with manager PIN override
      const initialSettle = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          method: 'cash',
          amount: 500,
          override_pin: managerAPin,
          approver_id: managerId,
        },
        headers: ownerAuth,
      });
      checkEqual(initialSettle.status, 200, 'Initial settlement with override PIN succeeds');
      checkEqual(initialSettle.data?.bill?.payment_status, 'paid', 'Bill is paid');

      const auditCountBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'",
          )
          .get(orderId) as any
      ).cnt;

      // Now call payment with amount: null on this already-paid bill WITHOUT override_pin
      const nullRetryWithoutPin = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: null },
        headers: ownerAuth,
      });
      checkEqual(
        nullRetryWithoutPin.status,
        200,
        'Null-amount call on already-paid bill succeeds without override_pin even with undelivered items',
      );

      // Call payment with amount: 0 on this already-paid bill WITHOUT override_pin
      const zeroRetryWithoutPin = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: 0 },
        headers: ownerAuth,
      });
      checkEqual(
        zeroRetryWithoutPin.status,
        200,
        'Zero-amount call on already-paid bill succeeds without override_pin even with undelivered items',
      );

      // And batch payments without override_pin
      const batchZeroRetryWithoutPin = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: { payments: [{ method: 'cash', amount: 0 }] },
        headers: ownerAuth,
      });
      checkEqual(
        batchZeroRetryWithoutPin.status,
        200,
        'Batch zero-amount call on already-paid bill succeeds without override_pin even with undelivered items',
      );

      const auditCountAfter = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'",
          )
          .get(orderId) as any
      ).cnt;
      checkEqual(
        auditCountAfter,
        auditCountBefore,
        'No duplicate kitchen_delivery_override audit log recorded on zero-amount retry',
      );
    }

    // Zero-balance settlement must persist payment idempotency and decouple PIN verification on replay.
    console.log('\n--- Section 2: Zero-Balance Settlement Idempotency & PIN Decoupling ---');

    // Single payment zero-balance settlement persists idempotency and succeeds on replay after PIN rotation
    {
      console.log(
        '\n[2.1] Single payment zero-balance settlement idempotency & replay with rotated PIN',
      );
      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      // Apply 100% discount so balance becomes 0
      const discRes = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: { type: 'percentage', value: 100, reason: 'Full comp' },
        headers: ownerAuth,
      });
      checkEqual(discRes.status, 200, 'Discount applied');
      const billAfterDisc = db
        .prepare('SELECT balance, payment_status FROM bills WHERE id = ?')
        .get(billId) as any;
      checkEqual(Number(billAfterDisc?.balance), 0, 'Bill balance is 0');
      checkEqual(billAfterDisc?.payment_status, 'unpaid', 'Bill is still unpaid');

      // Settle zero balance with Idempotency-Key and manager override PIN
      const idemKey = 'idem-f2-single-comp-001';
      const initialSettleRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          amount: null,
          method: 'cash',
          override_pin: managerAPin,
          approver_id: managerId,
        },
        headers: { ...ownerAuth, 'Idempotency-Key': idemKey },
      });
      checkEqual(initialSettleRes.status, 200, 'Initial zero-balance settlement succeeds');
      checkEqual(initialSettleRes.data?.bill?.payment_status, 'paid', 'Bill is marked paid');
      checkEqual(
        initialSettleRes.data?.kitchenDeliveryOverridden,
        true,
        'Response includes kitchenDeliveryOverridden: true',
      );

      // Verify idempotency record exists in DB
      const idempotencyRow = db
        .prepare('SELECT * FROM payment_idempotency WHERE idempotency_key = ?')
        .get(idemKey) as any;
      check(!!idempotencyRow, 'payment_idempotency record exists for zero-balance settlement');
      if (idempotencyRow) {
        checkEqual(
          String(idempotencyRow.bill_id),
          String(billId),
          'payment_idempotency bill_id matches',
        );
      }

      // Rotate Manager A's PIN
      const newPinHash = bcrypt.hashSync('8888', 10);
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(newPinHash, managerId);

      // Replay exact same request with old PIN '1234'
      const replayRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          amount: null,
          method: 'cash',
          override_pin: managerAPin, // Old, now-invalid PIN
          approver_id: managerId,
        },
        headers: { ...ownerAuth, 'Idempotency-Key': idemKey },
      });
      checkEqual(
        replayRes.status,
        200,
        'Replaying zero-balance settlement with rotated/invalid PIN succeeds with 200',
      );
      checkEqual(
        replayRes.data?.bill?.payment_status,
        'paid',
        'Replay returns cached bill response with paid status',
      );
      checkEqual(
        replayRes.data?.kitchenDeliveryOverridden,
        true,
        'Replay preserves kitchenDeliveryOverridden from idempotency cache',
      );
      checkEqual(
        JSON.stringify(replayRes.data),
        JSON.stringify(initialSettleRes.data),
        'Single-payment replay body matches initial response',
      );

      // Reset PIN back to 1234
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
        bcrypt.hashSync('1234', 10),
        managerId,
      );
    }

    // Batch payments zero-balance settlement persists idempotency and succeeds on replay
    {
      console.log(
        '\n[2.2] Batch payments zero-balance settlement idempotency & replay with rotated PIN',
      );
      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      // Apply 100% discount
      await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: { type: 'percentage', value: 100, reason: 'Full comp batch' },
        headers: ownerAuth,
      });

      const batchIdemKey = 'idem-f2-batch-comp-001';
      const initialBatchRes = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ amount: null, method: 'cash' }],
          override_pin: managerAPin,
          approver_id: managerId,
        },
        headers: { ...ownerAuth, 'Idempotency-Key': batchIdemKey },
      });
      checkEqual(initialBatchRes.status, 200, 'Initial batch zero-balance settlement succeeds');
      checkEqual(initialBatchRes.data?.bill?.payment_status, 'paid', 'Bill is marked paid');
      checkEqual(
        initialBatchRes.data?.kitchenDeliveryOverridden,
        true,
        'Batch response includes kitchenDeliveryOverridden: true',
      );

      // Verify idempotency record exists in DB
      const batchIdemRow = db
        .prepare('SELECT * FROM payment_idempotency WHERE idempotency_key = ?')
        .get(batchIdemKey) as any;
      check(!!batchIdemRow, 'payment_idempotency record exists for batch zero-balance settlement');

      // Rotate Manager A's PIN
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
        bcrypt.hashSync('8888', 10),
        managerId,
      );

      // Replay batch request with old PIN
      const batchReplayRes = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        body: {
          payments: [{ amount: null, method: 'cash' }],
          override_pin: managerAPin,
          approver_id: managerId,
        },
        headers: { ...ownerAuth, 'Idempotency-Key': batchIdemKey },
      });
      checkEqual(
        batchReplayRes.status,
        200,
        'Replaying batch zero-balance settlement with rotated PIN succeeds with 200',
      );
      checkEqual(
        batchReplayRes.data?.bill?.payment_status,
        'paid',
        'Batch replay returns cached paid bill response',
      );
      checkEqual(
        batchReplayRes.data?.kitchenDeliveryOverridden,
        true,
        'Batch replay preserves kitchenDeliveryOverridden from idempotency cache',
      );
      checkEqual(
        JSON.stringify(batchReplayRes.data),
        JSON.stringify(initialBatchRes.data),
        'Batch-payment replay body matches initial response',
      );

      // Reset PIN
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
        bcrypt.hashSync('1234', 10),
        managerId,
      );
    }

    // Deterministic interleaving between order cancellation and waiter payment.
    console.log('\n--- Section 3: Concurrency - Cancellation vs Waiter Payment ---');

    // Order cancellation races with waiter payment at async pre-verification boundary
    {
      console.log('\n[3.1] Owner cancels order during waiter async PIN verification');
      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          table_id: 'table-settle-2',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      // Pause waiter's payment during bcrypt.compare (inside preVerifyKitchenDeliveryPin)
      let cancelExecutedDuringPinCheck = false;
      pinApprovalHook = async () => {
        // Owner cancels the order while waiter is awaiting PIN verification
        const cancelRes = await api(baseUrl, `/api/orders/${orderId}/status`, {
          method: 'PATCH',
          body: {
            status: 'cancelled',
            reason: 'Owner cancelled during waiter payment',
            override_pin: managerAPin,
          },
          headers: ownerAuth,
        });
        cancelExecutedDuringPinCheck = cancelRes.status === 200;
        const currentOrder = db
          .prepare('SELECT status FROM orders WHERE id = ?')
          .get(orderId) as any;
        checkEqual(currentOrder?.status, 'cancelled', 'Order status is cancelled inside hook');
      };

      // Waiter sends payment with valid PIN
      const waiterPayRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          method: 'cash',
          amount: 500,
          override_pin: managerAPin,
          approver_id: managerId,
        },
        headers: ownerAuth,
      });

      check(
        cancelExecutedDuringPinCheck,
        'Order cancellation hook executed during waiter PIN check',
      );
      checkEqual(waiterPayRes.status, 200, 'Waiter payment transaction completes with 200');
      checkEqual(waiterPayRes.data?.bill?.payment_status, 'paid', 'Bill status is paid');

      // The critical consistency invariant:
      // Order must REMAIN 'cancelled' and must NOT be resurrected to 'completed'!
      const finalOrder = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as any;
      checkEqual(
        finalOrder?.status,
        'cancelled',
        'Cancelled order remains cancelled and is not flipped to completed by payment',
      );

      const finalBill = db
        .prepare('SELECT payment_status, balance FROM bills WHERE id = ?')
        .get(billId) as any;
      checkEqual(finalBill?.payment_status, 'paid', 'Bill is paid');
      checkEqual(Number(finalBill?.balance), 0, 'Bill balance is 0');
    }

    // In-flight owner reject (invalid PIN) vs waiter payment (valid PIN)
    {
      console.log(
        '\n[3.2] Concurrent in-flight payment attempt: Owner with invalid PIN, Waiter with valid PIN',
      );
      const createOrder = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: 'cust-f1',
          items: [{ product_id: 'prod-500', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      const orderId = createOrder.data?.order?.id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      const genBill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      const billId = genBill.data?.bill?.id;

      const sharedIdemKey = 'idem-race-owner-reject-waiter-valid-001';

      let waiterReq: Promise<any> | null = null;
      pinApprovalHook = async () => {
        waiterReq = api(baseUrl, `/api/bills/${billId}/payment`, {
          method: 'POST',
          body: {
            method: 'cash',
            amount: 500,
            override_pin: managerAPin, // Valid PIN 1234
            approver_id: managerId,
          },
          headers: { ...ownerAuth, 'Idempotency-Key': sharedIdemKey },
        });
        await new Promise((r) => setTimeout(r, 30));
      };

      const ownerReq = api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          method: 'cash',
          amount: 500,
          override_pin: '9999', // Invalid PIN
          approver_id: managerId,
        },
        headers: { ...ownerAuth, 'Idempotency-Key': sharedIdemKey },
      });

      const ownerRes = await ownerReq;
      const waiterRes = await waiterReq!;

      checkEqual(ownerRes.status, 403, 'Owner attempt with invalid PIN fails with 403');
      checkEqual(
        waiterRes.status,
        200,
        'Queued waiter attempt recovers after failed in-flight attempt and succeeds with 200',
      );
      checkEqual(waiterRes.data?.bill?.payment_status, 'paid', 'Bill is settled');

      // Check payment count in database
      const billRow = db
        .prepare('SELECT payment_details, paid_amount FROM bills WHERE id = ?')
        .get(billId) as any;
      checkEqual(billRow?.paid_amount, 500, 'Bill paid_amount is exactly 500');
      const details = JSON.parse(billRow?.payment_details || '[]');
      checkEqual(details.length, 1, 'Exactly 1 payment line recorded');

      // Replaying with sharedIdemKey returns 200
      const replay = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: {
          method: 'cash',
          amount: 500,
          override_pin: managerAPin,
          approver_id: managerId,
        },
        headers: { ...ownerAuth, 'Idempotency-Key': sharedIdemKey },
      });
      checkEqual(replay.status, 200, 'Replay of settled key returns 200');
    }
  } finally {
    bcrypt.compare = originalBcryptCompare;
    server.close();
    closeDatabase();
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(70));
  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  if (failures.length > 0 || failed > 0) {
    console.error(`\nFAILED (${failures.length} assertion(s) failed):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  } else {
    console.log('\nAll Financial Settlement Remediation tests passed successfully!');
  }
}

run().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
