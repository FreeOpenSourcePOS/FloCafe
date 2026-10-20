/**
 * Test suite for Area D: Manager PIN verification
 * Verifies role filtering, is_active status, rate limiting, and targeted lookup for manager PIN overrides.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mgr-pin-'));

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
const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertEqual,
  assert,
  getResults,
  closeDatabase,
  now,
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

async function run() {
  console.log('Testing Manager PIN Verification (Area D)...');
  console.log('='.repeat(60));

  const db = initTestDb();

  // The PIN limiters are module-level state keyed by client IP, and
  // every request here comes from 127.0.0.1. Reset them so this suite cannot be
  // rate-limited (or rate-limit a later one) by PIN attempts made elsewhere.
  resetBillPinRateLimit();
  resetOrderPinRateLimit();

  // Turn on discount approval in settings
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_requires_approval', 'true', ?)",
  ).run(now());

  // Seed active manager 1 (PIN: 1111)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-1', 'Manager One', 'mgr1@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('1111', 10), now(), now());

  // Seed active manager 2 (PIN: 2222)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-2', 'Manager Two', 'mgr2@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('2222', 10), now(), now());

  // Seed deactivated manager 3 (PIN: 3333, is_active = 0)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-3', 'Deactivated Manager', 'mgr3@test.local', 'Pass1234!', 'manager', ?, 0, ?, ?)
  `).run(bcrypt.hashSync('3333', 10), now(), now());

  // Seed cashier user
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('cashier-1', 'Cashier One', 'cashier1@test.local', 'Pass1234!', 'cashier', 1, ?, ?)
  `).run(now(), now());

  // Seed an order and bill to test discount approval
  const orderRes = db
    .prepare(`
    INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES ('ORD-TEST-001', 'dine_in', 100, 10, 110, 'pending', ?, ?)
  `)
    .run(now(), now());
  const orderId = orderRes.lastInsertRowid;

  const billRes = db
    .prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES ('BILL-TEST-001', ?, 100, 10, 110, 0, 110, 'unpaid', ?, ?)
  `)
    .run(orderId, now(), now());
  const billId = billRes.lastInsertRowid;

  const ownerAuth = makeToken('mgr-1', 'manager', 'mgr1@test.local');
  const cashierAuth = makeToken('cashier-1', 'cashier', 'cashier1@test.local');
  const app = createApp({ '/api/bills': billRoutes, '/api/orders': orderRoutes });

  // Test 1: Valid Manager 1 PIN (1111) succeeds
  const res1 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '1111' });
  assertEqual(res1.status, 200, 'Valid manager 1 PIN succeeds');

  // Test 2: Valid Manager 2 PIN (2222) succeeds
  const res2 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '2222' });
  assertEqual(res2.status, 200, 'Valid manager 2 PIN succeeds');

  // Test 3: Deactivated Manager 3 PIN (3333) fails
  const res3 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '3333' });
  assertEqual(res3.status, 403, 'Deactivated manager PIN fails with 403');

  // Test 4: Targeted Manager lookup by manager_id
  const res4 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '2222', manager_id: 'mgr-2' });
  assertEqual(res4.status, 200, 'Targeted manager PIN lookup by manager_id succeeds');

  // Test 5: Incorrect PIN returns 403
  const res5 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '9999' });
  assertEqual(res5.status, 403, 'Incorrect PIN returns 403');
  resetBillPinRateLimit();

  // Test 6: Mismatched manager selection on bill discount fails with 403
  const res6 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '2222', manager_id: 'mgr-1' });
  assertEqual(res6.status, 403, 'Mismatched manager selection on bill discount fails with 403');
  resetBillPinRateLimit();

  // Test 7: Inactive manager selection on bill discount fails with 403
  const res7 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '1111', manager_id: 'mgr-3' });
  assertEqual(res7.status, 403, 'Inactive manager selection on bill discount fails with 403');
  resetBillPinRateLimit();

  // Test 8: Nonexistent manager selection on bill discount fails with 403
  const res8 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '1111', manager_id: 'mgr-nonexistent' });
  assertEqual(res8.status, 403, 'Nonexistent manager selection on bill discount fails with 403');
  resetBillPinRateLimit();

  // Test 9: Order discount manager selection binding
  const res9a = await request(app).patch(`/api/orders/${orderId}/discount`).set(ownerAuth).send({
    discount_type: 'percentage',
    discount_value: 5,
    override_pin: '2222',
    manager_id: 'mgr-1',
  });
  assertEqual(res9a.status, 403, 'Mismatched manager selection on order discount fails with 403');
  resetOrderPinRateLimit();

  const res9b = await request(app).patch(`/api/orders/${orderId}/discount`).set(ownerAuth).send({
    discount_type: 'percentage',
    discount_value: 5,
    override_pin: '2222',
    manager_id: 'mgr-2',
  });
  assertEqual(res9b.status, 200, 'Matching manager selection on order discount succeeds with 200');
  resetOrderPinRateLimit();

  // Test 10: Item void in preparation (PATCH /api/orders/:orderId/items/:itemId/cancel)
  db.prepare(`
    INSERT INTO products (id, name, price, is_active, created_at, updated_at)
    VALUES ('prod-1', 'Burger', 100, 1, ?, ?)
  `).run(now(), now());

  const voidOrderRes1 = db
    .prepare(`
    INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES ('ORD-VOID-001', 'dine_in', 100, 0, 100, 'pending', ?, ?)
  `)
    .run(now(), now());
  const voidOrderId1 = voidOrderRes1.lastInsertRowid;

  const itemRes1 = db
    .prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-1', 'Burger', 100, 1, 100, 0, 100, 'preparing', ?, ?)
  `)
    .run(voidOrderId1, now(), now());
  const itemId1 = itemRes1.lastInsertRowid;

  // Test 10a: Mismatched manager ID and PIN fails with 403 and does NOT void item or attribute to manager 2
  const res10a = await request(app)
    .patch(`/api/orders/${voidOrderId1}/items/${itemId1}/cancel`)
    .set(cashierAuth)
    .send({ manager_id: 'mgr-1', override_pin: '2222' });
  assertEqual(res10a.status, 403, 'Item void with mismatched manager ID and PIN fails with 403');
  resetOrderPinRateLimit();

  const itemAfter10a = db
    .prepare('SELECT status FROM order_items WHERE id = ?')
    .get(itemId1) as any;
  assertEqual(
    itemAfter10a.status,
    'preparing',
    'Item remains in preparing status after mismatched void',
  );
  const auditLogs10a = db
    .prepare('SELECT * FROM order_audit_log WHERE order_id = ?')
    .all(voidOrderId1) as any[];
  const attributedToMgr2Before = auditLogs10a.some((row) => {
    try {
      return JSON.parse(row.details_json || '{}').approved_by === 'mgr-2';
    } catch {
      return false;
    }
  });
  assert(!attributedToMgr2Before, 'No audit log entry created attributing approval to manager 2');

  // Test 10b: Inactive manager ID fails with 403
  const res10b = await request(app)
    .patch(`/api/orders/${voidOrderId1}/items/${itemId1}/cancel`)
    .set(cashierAuth)
    .send({ manager_id: 'mgr-3', override_pin: '1111' });
  assertEqual(res10b.status, 403, 'Item void with inactive manager ID fails with 403');
  resetOrderPinRateLimit();

  // Test 10c: Correct manager ID and matching PIN voids item and attributes audit to mgr-2
  const res10c = await request(app)
    .patch(`/api/orders/${voidOrderId1}/items/${itemId1}/cancel`)
    .set(cashierAuth)
    .send({ manager_id: 'mgr-2', override_pin: '2222' });
  assertEqual(res10c.status, 200, 'Item void with matching manager ID and PIN succeeds with 200');
  resetOrderPinRateLimit();

  const itemAfter10c = db
    .prepare('SELECT status FROM order_items WHERE id = ?')
    .get(itemId1) as any;
  assertEqual(itemAfter10c.status, 'voided', 'Item status updated to voided');
  const auditLogs10c = db
    .prepare(
      'SELECT * FROM order_audit_log WHERE order_id = ? AND order_item_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(voidOrderId1, itemId1) as any;
  assert(!!auditLogs10c, 'Audit log entry created for voided item');
  assertEqual(auditLogs10c.actor_user_id, 'cashier-1', 'Audit log records actor as cashier-1');
  assertEqual(
    JSON.parse(auditLogs10c.details_json || '{}').approved_by,
    'mgr-2',
    'Audit log records approved_by as mgr-2',
  );

  // Test 10d: PIN-only void (no manager_id) succeeds and attributes to the PIN-matching manager
  const voidOrderRes2 = db
    .prepare(`
    INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES ('ORD-VOID-002', 'dine_in', 100, 0, 100, 'pending', ?, ?)
  `)
    .run(now(), now());
  const voidOrderId2 = voidOrderRes2.lastInsertRowid;

  const itemRes2 = db
    .prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-1', 'Burger', 100, 1, 100, 0, 100, 'preparing', ?, ?)
  `)
    .run(voidOrderId2, now(), now());
  const itemId2 = itemRes2.lastInsertRowid;

  const res10d = await request(app)
    .patch(`/api/orders/${voidOrderId2}/items/${itemId2}/cancel`)
    .set(cashierAuth)
    .send({ override_pin: '1111' });
  assertEqual(res10d.status, 200, 'PIN-only item void succeeds with 200');
  resetOrderPinRateLimit();

  const itemAfter10d = db
    .prepare('SELECT status FROM order_items WHERE id = ?')
    .get(itemId2) as any;
  assertEqual(itemAfter10d.status, 'voided', 'PIN-only void updates item status to voided');
  const auditLogs10d = db
    .prepare(
      'SELECT * FROM order_audit_log WHERE order_id = ? AND order_item_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(voidOrderId2, itemId2) as any;
  assert(!!auditLogs10d, 'PIN-only void records audit log entry');
  assertEqual(
    JSON.parse(auditLogs10d.details_json || '{}').approved_by,
    'mgr-1',
    'PIN-only void records matching manager 1 in approved_by',
  );

  // Test 11: Completing unpaid order with shared PIN requires payment permission during pre-verification
  // Seed two managers sharing PIN 5555:
  // mgr-shared-nopay comes first alphabetically, but has payments.take denied
  // mgr-shared-pay has default manager permissions including payments.take
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-shared-nopay', 'Manager No Pay', 'mgrnopay@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('5555', 10), now(), now());
  db.prepare(`
    INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
    VALUES ('mgr-shared-nopay', 'payments.take', 'deny', 'mgr-1', ?, ?)
  `).run(now(), now());

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-shared-pay', 'Manager With Pay', 'mgrpay@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('5555', 10), now(), now());

  const unpaidOrderRes = db
    .prepare(`
    INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES ('ORD-UNPAID-001', 'dine_in', 100, 0, 100, 'pending', ?, ?)
  `)
    .run(now(), now());
  const unpaidOrderId = unpaidOrderRes.lastInsertRowid;

  db.prepare(`
    INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES (?, 'BILL-UNPAID-001', 100, 0, 100, 0, 100, 'unpaid', ?, ?)
  `).run(unpaidOrderId, now(), now());

  // Test 11a: Explicit approver who lacks payments.take fails with 403
  const res11a = await request(app)
    .patch(`/api/orders/${unpaidOrderId}/status`)
    .set(cashierAuth)
    .send({ status: 'completed', override_pin: '5555', approver_id: 'mgr-shared-nopay' });
  assertEqual(res11a.status, 403, 'Explicit approver lacking payments.take is rejected with 403');
  resetOrderPinRateLimit();

  // Test 11b: Fallback PIN scan skips ineligible mgr-shared-nopay and authorizes mgr-shared-pay
  const res11b = await request(app)
    .patch(`/api/orders/${unpaidOrderId}/status`)
    .set(cashierAuth)
    .send({ status: 'completed', override_pin: '5555' });
  assertEqual(
    res11b.status,
    200,
    'Fallback PIN scan authorizes eligible manager with payments.take',
  );
  resetOrderPinRateLimit();

  const completedOrder = db
    .prepare('SELECT status FROM orders WHERE id = ?')
    .get(unpaidOrderId) as any;
  assertEqual(completedOrder.status, 'completed', 'Order status updated to completed');

  const auditLog11 = db
    .prepare(`
    SELECT * FROM order_audit_log WHERE order_id = ? ORDER BY id DESC LIMIT 1
  `)
    .get(unpaidOrderId) as any;
  assert(!!auditLog11, 'Audit log entry created for completed unpaid order');
  assertEqual(
    JSON.parse(auditLog11.details_json || '{}').approved_by,
    'mgr-shared-pay',
    'Audit log attributes approval to eligible mgr-shared-pay',
  );

  // Test 12a: Concurrent burst of 10 invalid PIN requests locks out after 5 attempts
  resetBillPinRateLimit();
  const invalidBurst = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(app)
        .post(`/api/bills/${billId}/applyDiscount`)
        .set(ownerAuth)
        .send({ type: 'percentage', value: 10, override_pin: '9999' }),
    ),
  );
  const statusCounts = invalidBurst.reduce((acc: Record<number, number>, res: any) => {
    acc[res.status] = (acc[res.status] || 0) + 1;
    return acc;
  }, {});
  assertEqual(statusCounts[403], 5, 'Exactly 5 invalid requests return 403 before lockout');
  assertEqual(
    statusCounts[429],
    5,
    'Remaining 5 concurrent requests return 429 without running bcrypt',
  );

  // Any subsequent request returns 429 immediately while locked out
  const lockedOutRes = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '1111' });
  assertEqual(lockedOutRes.status, 429, 'Subsequent attempt during lockout returns 429');

  // Test 12b: Concurrent valid PIN requests succeed and do not trigger false 429 lockouts
  resetBillPinRateLimit();
  const validBurst = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(app)
        .post(`/api/bills/${billId}/applyDiscount`)
        .set(ownerAuth)
        .send({ type: 'percentage', value: 10, override_pin: '1111' }),
    ),
  );
  for (const res of validBurst) {
    assertEqual(res.status, 200, 'Concurrent valid PIN request succeeds with 200');
  }
  resetBillPinRateLimit();
  const results = getResults();
  if (results.failed > 0) {
    throw new Error(`${results.failed} test assertions failed`);
  }
  console.log('\n✅ Manager PIN verification tests passed!');
}

run()
  .then(() => {
    resetBillPinRateLimit();
    resetOrderPinRateLimit();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((err) => {
    try {
      resetBillPinRateLimit();
    } catch {}
    try {
      resetOrderPinRateLimit();
    } catch {}
    try {
      closeDatabase();
    } catch {}
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
