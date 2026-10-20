/**
 * Tests for F3 (#1178): Discount kitchen delivery override approver identity binding.
 * Verifies bill, order, and item discount routes strictly bind kitchen delivery
 * overrides and exact-balance auto-settlements to the explicitly selected approver,
 * rejecting mismatched PINs with 403 even when discount_requires_approval is disabled.
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-f3-discount-kitchen-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  seedTable,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const {
  billRoutes,
  completeExactBalanceSettlement,
  resetPinRateLimitForTests: resetBillPinRateLimit,
} = require('../main/routes/bills');
const {
  orderRoutes,
  resetPinRateLimitForTests: resetOrderPinRateLimit,
} = require('../main/routes/orders');

function setSetting(db: any, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

function billRow(db: any, id: any): any {
  return db
    .prepare(
      `SELECT id, bill_number, payment_status, subtotal, discount_amount, total, paid_amount, balance, paid_at, order_id
       FROM bills WHERE id = ?`,
    )
    .get(id);
}

function orderRow(db: any, id: any): any {
  return db
    .prepare(
      `SELECT id, status, table_id, subtotal, discount_amount, total, completed_at FROM orders WHERE id = ?`,
    )
    .get(id);
}

async function run() {
  console.log('Testing Discount Kitchen Delivery Approver Identity Binding (F3 / #1178)...');

  const db = initTestDb();

  setSetting(db, 'kds_enabled', 'true');
  setSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
  setSetting(db, 'discount_mode', 'both');
  setSetting(db, 'discount_max_amount', '0');
  setSetting(db, 'discount_max_percentage', '0');
  setSetting(db, 'discount_requires_approval', 'false');

  const { authHeader: ownerAuth } = seedOwnerUser(db);

  // Seed Manager A (PIN 1111) and Manager B (PIN 2222)
  const passwordHash = bcrypt.hashSync('testpass123', 10);
  const pinHashA = bcrypt.hashSync('1111', 10);
  const pinHashB = bcrypt.hashSync('2222', 10);

  const managerA = { id: 'mgr-a-1111', name: 'Manager A', role: 'manager', pin: '1111' };
  const managerB = { id: 'mgr-b-2222', name: 'Manager B', role: 'manager', pin: '2222' };

  db.prepare(
    `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    managerA.id,
    managerA.name,
    'mgrA@test.local',
    passwordHash,
    managerA.role,
    pinHashA,
    now(),
    now(),
  );

  db.prepare(
    `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    managerB.id,
    managerB.name,
    'mgrB@test.local',
    passwordHash,
    managerB.role,
    pinHashB,
    now(),
    now(),
  );

  seedCategory(db, 'cat-f3', 'F3 Category');
  seedProduct(db, 'prod-1000', 'cat-f3', 'Item 1000', 1000);
  seedTable(db, 'tbl-f3-1', 1);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });

  const { baseUrl, server } = await startServer(app);

  try {
    resetBillPinRateLimit();
    resetOrderPinRateLimit();

    // Helper: create order, bill, partial payment, set items to preparing
    async function setupOrderWithPartialPayment() {
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'dine_in',
          table_id: 'tbl-f3-1',
          items: [{ product_id: 'prod-1000', quantity: 1 }],
        },
        headers: ownerAuth,
      });
      assertEqualOrThrow(createRes.status, 201, 'Order created');
      const orderId = createRes.data.order.id;
      const itemId = createRes.data.order.items[0].id;

      const billRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: orderId },
        headers: ownerAuth,
      });
      assertEqualOrThrow(billRes.status, 201, 'Bill generated');
      const billId = billRes.data.bill.id;

      // Partial payment: 600 cash, leaving 400 balance while setting is false
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'false');
      const payRes = await api(baseUrl, `/api/bills/${billId}/payment`, {
        method: 'POST',
        body: { method: 'cash', amount: 600 },
        headers: ownerAuth,
      });
      assertEqualOrThrow(payRes.status, 200, 'Partial payment accepted');

      // Now enable kitchen delivery requirement and set item to preparing (undelivered in kitchen)
      setSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ?").run(orderId);

      return { orderId, itemId, billId };
    }

    // ── 1. Bill Discount Route: Mismatched Approver PIN must reject with 403 ──
    console.log('\n── Subtest 1: Bill discount with mismatched approver ID & PIN ──');
    {
      const { orderId, billId } = await setupOrderWithPartialPayment();

      // Attempt bill discount with Manager A selected, but Manager B's PIN
      const discountRes = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: {
          type: 'amount',
          value: 400,
          approver_id: managerA.id,
          override_pin: managerB.pin,
        },
        headers: ownerAuth,
      });

      assertEqualOrThrow(
        discountRes.status,
        403,
        'Bill discount rejects mismatched approver PIN with 403',
      );

      // Verify bill remains in partial state and no kitchen_delivery_override was recorded for Manager B
      const bill = billRow(db, billId);
      assertEqualOrThrow(bill.payment_status, 'partial', 'Bill remains partial');
      const audit = db
        .prepare(
          `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'`,
        )
        .get(orderId);
      assertEqualOrThrow(
        audit,
        undefined,
        'No kitchen_delivery_override audit recorded on rejected discount',
      );
    }

    // ── 2. Order Discount Route: Mismatched Approver PIN must reject with 403 ──
    console.log('\n── Subtest 2: Order discount with mismatched approver ID & PIN ──');
    {
      const { orderId, billId } = await setupOrderWithPartialPayment();

      const discountRes = await api(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: {
          discount_type: 'amount',
          discount_value: 400,
          approver_id: managerA.id,
          override_pin: managerB.pin,
        },
        headers: ownerAuth,
      });

      assertEqualOrThrow(
        discountRes.status,
        403,
        'Order discount rejects mismatched approver PIN with 403',
      );

      const bill = billRow(db, billId);
      assertEqualOrThrow(bill.payment_status, 'partial', 'Bill remains partial');
      const audit = db
        .prepare(
          `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'`,
        )
        .get(orderId);
      assertEqualOrThrow(
        audit,
        undefined,
        'No kitchen_delivery_override audit recorded on rejected discount',
      );
    }

    // ── 3. Item Discount Route: Mismatched Approver PIN must reject with 403 ──
    console.log('\n── Subtest 3: Item discount with mismatched approver ID & PIN ──');
    {
      const { orderId, itemId, billId } = await setupOrderWithPartialPayment();

      const discountRes = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
        method: 'PATCH',
        body: {
          discount_type: 'amount',
          discount_value: 400,
          approver_id: managerA.id,
          override_pin: managerB.pin,
        },
        headers: ownerAuth,
      });

      assertEqualOrThrow(
        discountRes.status,
        403,
        'Item discount rejects mismatched approver PIN with 403',
      );

      const bill = billRow(db, billId);
      assertEqualOrThrow(bill.payment_status, 'partial', 'Bill remains partial');
      const audit = db
        .prepare(
          `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'`,
        )
        .get(orderId);
      assertEqualOrThrow(
        audit,
        undefined,
        'No kitchen_delivery_override audit recorded on rejected discount',
      );
    }

    // ── 4. Valid Approver PIN strictly binds to Manager A ──
    console.log(
      '\n── Subtest 4: Valid matching approver ID and PIN succeeds and attributes properly ──',
    );
    {
      const { orderId, billId } = await setupOrderWithPartialPayment();

      const discountRes = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: {
          type: 'amount',
          value: 400,
          approver_id: managerA.id,
          override_pin: managerA.pin,
        },
        headers: ownerAuth,
      });

      assertEqualOrThrow(
        discountRes.status,
        200,
        'Bill discount with matching approver PIN succeeds',
      );
      const bill = billRow(db, billId);
      assertEqualOrThrow(bill.payment_status, 'paid', 'Bill is auto-settled to paid');
      assertEqualOrThrow(orderRow(db, orderId).status, 'completed', 'Order completed');

      const audit = db
        .prepare(
          `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'`,
        )
        .get(orderId) as any;
      assertOrThrow(Boolean(audit), 'kitchen_delivery_override audit log recorded');
      const details = JSON.parse(audit.details_json);
      assertEqualOrThrow(
        details.manager_user_id,
        managerA.id,
        'Audit log correctly attributes override to Manager A',
      );
    }

    // ── 5. completeExactBalanceSettlement direct verification ──
    console.log('\n── Subtest 5: completeExactBalanceSettlement honors approverId binding ──');
    {
      const { orderId, billId } = await setupOrderWithPartialPayment();

      let threwMismatched = false;
      try {
        completeExactBalanceSettlement(
          db,
          billId,
          600,
          'USD',
          now(),
          managerB.pin,
          '127.0.0.1',
          null,
          managerA.id,
        );
      } catch (err: any) {
        if (err?.statusCode === 403 || err?.message === 'Invalid manager PIN') {
          threwMismatched = true;
        }
      }
      assertOrThrow(
        threwMismatched,
        'completeExactBalanceSettlement rejected mismatched approver PIN',
      );
    }

    // ── 6. When discount_requires_approval = 'true' ──
    console.log(
      '\n── Subtest 6: When discount_requires_approval is true, approver binding is enforced ──',
    );
    {
      setSetting(db, 'discount_requires_approval', 'true');
      const { orderId, billId } = await setupOrderWithPartialPayment();

      const rejectRes = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: {
          type: 'amount',
          value: 400,
          approver_id: managerA.id,
          override_pin: managerB.pin,
        },
        headers: ownerAuth,
      });
      assertEqualOrThrow(
        rejectRes.status,
        403,
        'Discount with mismatched PIN rejected when approval required',
      );

      const okRes = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST',
        body: {
          type: 'amount',
          value: 400,
          approver_id: managerA.id,
          override_pin: managerA.pin,
        },
        headers: ownerAuth,
      });
      assertEqualOrThrow(
        okRes.status,
        200,
        'Discount with valid PIN accepted when approval required',
      );
      const bill = billRow(db, billId);
      assertEqualOrThrow(bill.payment_status, 'paid', 'Bill auto-settled to paid');
    }

    console.log('✓ All discount kitchen approver identity tests passed!');
  } finally {
    server.close();
    closeDatabase(db);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
