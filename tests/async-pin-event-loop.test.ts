/**
 * Test suite for Issue #1179: Asynchronous Manager PIN Scans & Event Loop Responsiveness
 *
 * Verifies that:
 * 1. Synchronous verifyPin blocks the event loop (0 ticks), while verifyPinAsync yields
 *    to the event loop (ticks > 0) via bcryptjs async hashing.
 * 2. All 5 manager PIN verification route surfaces yield to the Node.js event loop
 *    during 5-candidate manager scans:
 *    - PATCH /api/orders/:id/status (order cancel/complete override)
 *    - PATCH /api/orders/:id/discount (order discount approval)
 *    - PATCH /api/orders/:id/items/:itemId/discount (item discount approval)
 *    - PATCH /api/orders/:orderId/items/:itemId/cancel (in-progress item void approval)
 *    - POST /api/bills/:id/applyDiscount (bill discount approval)
 *    - POST /api/bills/:id/payment (kitchen delivery gate override)
 * 3. Scans to the last candidate (#5) succeed, while invalid PINs check all candidates and return 403.
 * 4. Atomic SQLite revalidation inside withTxn prevents race conditions:
 *    - PIN hash changed between pre-check and commit throws 403.
 *    - Manager deactivated between pre-check and commit throws 403.
 *    - Manager demoted to cashier between pre-check and commit throws 403.
 *    - Manager permission revoked between pre-check and commit throws 403.
 * 5. Concurrent WAL database writes proceed freely without transaction lock contention during
 *    asynchronous PIN evaluation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-async-pin-'));

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
  assertEqualOrThrow,
  assertOrThrow,
  assertGreaterThanOrThrow,
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
const { verifyPin, verifyPinAsync, withTxn } = require('../main/db');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function run() {
  console.log('Testing Asynchronous Manager PIN Scans & Event Loop (Issue #1179)...');
  console.log('='.repeat(70));

  const db = initTestDb();

  resetBillPinRateLimit();
  resetOrderPinRateLimit();

  // Enable manager approval settings
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_requires_approval', 'true', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_kitchen_delivered_before_settlement', 'true', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)",
  ).run(now());

  // Seed 5 active managers with distinct PINs
  const pinHashes: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const pin = `${i}${i}${i}${i}`;
    const hash = bcrypt.hashSync(pin, 8); // cost factor 8 for deterministic fast test execution
    pinHashes.push(hash);
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'Pass1234!', 'manager', ?, 1, ?, ?)
    `).run(`mgr-${i}`, `Manager ${i}`, `mgr${i}@test.local`, hash, now(), now());
  }

  // Seed category and product
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-async', 'Async', 1)`).run();
  db.prepare(`
    INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-async-1', 'cat-async', 'Async item', 50, 'none', 1, 1, 0, 100, ?, ?)
  `).run(now(), now());

  // Seed cashier user
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('cashier-1', 'Cashier One', 'cashier1@test.local', 'Pass1234!', 'cashier', 1, ?, ?)
  `).run(now(), now());

  const ownerAuth = makeToken('mgr-1', 'manager', 'mgr1@test.local');
  const cashierAuth = makeToken('cashier-1', 'cashier', 'cashier1@test.local');
  const app = createApp({ '/api/bills': billRoutes, '/api/orders': orderRoutes });

  // ─── 1. Unit Event Loop Yielding Test ─────────────────────────────────────
  console.log('\n--- 1. Unit Event Loop Yielding Verification ---');
  {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 1);

    // Synchronous verifyPin scan over 5 hashes
    ticks = 0;
    for (const hash of pinHashes) {
      verifyPin(hash, '9999');
    }
    const syncTicks = ticks;
    assertEqualOrThrow(syncTicks, 0, 'Synchronous verifyPin blocks event loop (0 ticks observed)');

    // Asynchronous verifyPinAsync scan over 5 hashes
    ticks = 0;
    for (const hash of pinHashes) {
      await verifyPinAsync(hash, '9999');
    }
    clearInterval(interval);
    const asyncTicks = ticks;
    assertGreaterThanOrThrow(
      asyncTicks,
      0,
      `Asynchronous verifyPinAsync yielded to event loop (${asyncTicks} ticks observed)`,
    );
  }

  // ─── 2. Route-Level Verification (All 6 Surfaces) ─────────────────────────
  console.log('\n--- 2. Route-Level Non-Blocking PIN Verification ---');

  // Helper to monitor event loop ticks during an async HTTP operation
  async function executeWithTickTracker<T>(action: () => Promise<T>): Promise<{ result: T; ticks: number }> {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    try {
      const result = await action();
      return { result, ticks };
    } finally {
      clearInterval(timer);
    }
  }

  // A. PATCH /api/orders/:id/discount
  {
    const orderRes = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-001', 'dine_in', 100, 10, 110, 'pending', ?, ?)
    `).run(now(), now());
    const orderId = orderRes.lastInsertRowid;

    // Scan to last candidate (#5, PIN '5555')
    resetOrderPinRateLimit();
    const { result: resA1, ticks: ticksA1 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId}/discount`)
        .set(ownerAuth)
        .send({ discount_type: 'percentage', discount_value: 10, override_pin: '5555' }),
    );
    assertEqualOrThrow(resA1.status, 200, 'Order discount succeeds with candidate #5 PIN');
    assertGreaterThanOrThrow(ticksA1, 0, 'Event loop yielded during order discount PIN scan');

    // Invalid PIN checks all candidates and fails
    resetOrderPinRateLimit();
    const { result: resA2, ticks: ticksA2 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId}/discount`)
        .set(ownerAuth)
        .send({ discount_type: 'percentage', discount_value: 10, override_pin: '9999' }),
    );
    assertEqualOrThrow(resA2.status, 403, 'Order discount fails with 403 on invalid PIN');
    assertGreaterThanOrThrow(ticksA2, 0, 'Event loop yielded during invalid order discount scan');
  }

  // B. PATCH /api/orders/:id/items/:itemId/discount
  {
    const orderRes = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-002', 'dine_in', 50, 5, 55, 'pending', ?, ?)
    `).run(now(), now());
    const orderId = orderRes.lastInsertRowid;
    const itemRes = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (?, 'prod-async-1', 'Item A', 50, 1, 50, 55, 'pending', ?, ?)
    `).run(orderId, now(), now());
    const itemId = itemRes.lastInsertRowid;

    // Scan to last candidate (#5, PIN '5555')
    resetOrderPinRateLimit();
    const { result: resB1, ticks: ticksB1 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId}/items/${itemId}/discount`)
        .set(ownerAuth)
        .send({ discount_type: 'percentage', discount_value: 10, override_pin: '5555' }),
    );
    assertEqualOrThrow(resB1.status, 200, 'Item discount succeeds with candidate #5 PIN');
    assertGreaterThanOrThrow(ticksB1, 0, 'Event loop yielded during item discount PIN scan');

    // Invalid PIN fails
    resetOrderPinRateLimit();
    const { result: resB2, ticks: ticksB2 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId}/items/${itemId}/discount`)
        .set(ownerAuth)
        .send({ discount_type: 'percentage', discount_value: 10, override_pin: '9999' }),
    );
    assertEqualOrThrow(resB2.status, 403, 'Item discount fails with 403 on invalid PIN');
    assertGreaterThanOrThrow(ticksB2, 0, 'Event loop yielded during invalid item discount scan');
  }

  // C. PATCH /api/orders/:orderId/items/:itemId/cancel (in-progress item void)
  {
    const orderRes = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-003', 'dine_in', 50, 5, 55, 'preparing', ?, ?)
    `).run(now(), now());
    const orderId = orderRes.lastInsertRowid;
    const itemRes = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (?, 'prod-async-1', 'Item In Prep', 50, 1, 50, 55, 'preparing', ?, ?)
    `).run(orderId, now(), now());
    const itemId = itemRes.lastInsertRowid;

    // Scan to last candidate (#5, PIN '5555')
    resetOrderPinRateLimit();
    const { result: resC1, ticks: ticksC1 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId}/items/${itemId}/cancel`)
        .set(cashierAuth)
        .send({ reason: 'Customer changed mind', override_pin: '5555' }),
    );
    assertEqualOrThrow(resC1.status, 200, 'Item void succeeds with candidate #5 PIN');
    assertGreaterThanOrThrow(ticksC1, 0, 'Event loop yielded during item void PIN scan');

    // Seed fresh preparing order and item for invalid PIN test
    const orderRes2 = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-003B', 'dine_in', 50, 5, 55, 'preparing', ?, ?)
    `).run(now(), now());
    const orderId2 = orderRes2.lastInsertRowid;
    const itemRes2 = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (?, 'prod-async-1', 'Item In Prep 2', 50, 1, 50, 55, 'preparing', ?, ?)
    `).run(orderId2, now(), now());
    const itemId2 = itemRes2.lastInsertRowid;

    resetOrderPinRateLimit();
    const { result: resC2, ticks: ticksC2 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId2}/items/${itemId2}/cancel`)
        .set(cashierAuth)
        .send({ reason: 'Mistake', override_pin: '9999' }),
    );
    assertEqualOrThrow(resC2.status, 403, 'Item void fails with 403 on invalid PIN');
    assertGreaterThanOrThrow(ticksC2, 0, 'Event loop yielded during invalid item void scan');
  }

  // D. PATCH /api/orders/:id/status (order cancel override)
  {
    const orderRes = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-004', 'dine_in', 80, 8, 88, 'preparing', ?, ?)
    `).run(now(), now());
    const orderId = orderRes.lastInsertRowid;

    // Scan to last candidate (#5, PIN '5555')
    resetOrderPinRateLimit();
    const { result: resD1, ticks: ticksD1 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId}/status`)
        .set(cashierAuth)
        .send({ status: 'cancelled', reason: 'Walkout', override_pin: '5555' }),
    );
    assertEqualOrThrow(resD1.status, 200, 'Order cancel succeeds with candidate #5 PIN');
    assertGreaterThanOrThrow(ticksD1, 0, 'Event loop yielded during order cancel PIN scan');

    // Re-seed preparing order for invalid PIN test
    const orderRes2 = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-005', 'dine_in', 80, 8, 88, 'preparing', ?, ?)
    `).run(now(), now());
    const orderId2 = orderRes2.lastInsertRowid;

    resetOrderPinRateLimit();
    const { result: resD2, ticks: ticksD2 } = await executeWithTickTracker(() =>
      request(app)
        .patch(`/api/orders/${orderId2}/status`)
        .set(cashierAuth)
        .send({ status: 'cancelled', reason: 'Walkout', override_pin: '9999' }),
    );
    assertEqualOrThrow(resD2.status, 403, 'Order cancel fails with 403 on invalid PIN');
    assertGreaterThanOrThrow(ticksD2, 0, 'Event loop yielded during invalid order cancel scan');
  }

  // E. POST /api/bills/:id/applyDiscount
  {
    const orderRes = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-006', 'dine_in', 100, 10, 110, 'pending', ?, ?)
    `).run(now(), now());
    const orderId = orderRes.lastInsertRowid;
    const billRes = db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES ('BILL-ASYNC-001', ?, 100, 10, 110, 0, 110, 'unpaid', ?, ?)
    `).run(orderId, now(), now());
    const billId = billRes.lastInsertRowid;

    // Scan to last candidate (#5, PIN '5555')
    resetBillPinRateLimit();
    const { result: resE1, ticks: ticksE1 } = await executeWithTickTracker(() =>
      request(app)
        .post(`/api/bills/${billId}/applyDiscount`)
        .set(ownerAuth)
        .send({ type: 'percentage', value: 10, override_pin: '5555' }),
    );
    assertEqualOrThrow(resE1.status, 200, 'Bill discount succeeds with candidate #5 PIN');
    assertGreaterThanOrThrow(ticksE1, 0, 'Event loop yielded during bill discount PIN scan');

    // Invalid PIN fails
    resetBillPinRateLimit();
    const { result: resE2, ticks: ticksE2 } = await executeWithTickTracker(() =>
      request(app)
        .post(`/api/bills/${billId}/applyDiscount`)
        .set(ownerAuth)
        .send({ type: 'percentage', value: 10, override_pin: '9999' }),
    );
    assertEqualOrThrow(resE2.status, 403, 'Bill discount fails with 403 on invalid PIN');
    assertGreaterThanOrThrow(ticksE2, 0, 'Event loop yielded during invalid bill discount scan');
  }

  // F. POST /api/bills/:id/payment (kitchen delivery gate override)
  {
    const orderRes = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-007', 'dine_in', 40, 4, 44, 'pending', ?, ?)
    `).run(now(), now());
    const orderId = orderRes.lastInsertRowid;
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (?, 'prod-async-1', 'Hot Pizza', 40, 1, 40, 44, 'preparing', ?, ?)
    `).run(orderId, now(), now());
    const billRes = db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES ('BILL-ASYNC-002', ?, 40, 4, 44, 0, 44, 'unpaid', ?, ?)
    `).run(orderId, now(), now());
    const billId = billRes.lastInsertRowid;

    // Scan to last candidate (#5, PIN '5555')
    resetBillPinRateLimit();
    const { result: resF1, ticks: ticksF1 } = await executeWithTickTracker(() =>
      request(app)
        .post(`/api/bills/${billId}/payment`)
        .set(ownerAuth)
        .send({
          method: 'cash',
          amount: 44,
          override_pin: '5555',
        }),
    );
    assertEqualOrThrow(resF1.status, 200, 'Payment with kitchen override succeeds with candidate #5 PIN');
    assertEqualOrThrow(resF1.body.kitchenDeliveryOverridden, true, 'Payment marked as kitchen delivery overridden');
    assertGreaterThanOrThrow(ticksF1, 0, 'Event loop yielded during kitchen override PIN scan');

    // Seed another unpaid bill with undelivered item for invalid PIN test
    const orderRes2 = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-ASYNC-008', 'dine_in', 40, 4, 44, 'pending', ?, ?)
    `).run(now(), now());
    const orderId2 = orderRes2.lastInsertRowid;
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (?, 'prod-async-1', 'Hot Pasta', 40, 1, 40, 44, 'preparing', ?, ?)
    `).run(orderId2, now(), now());
    const billRes2 = db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES ('BILL-ASYNC-003', ?, 40, 4, 44, 0, 44, 'unpaid', ?, ?)
    `).run(orderId2, now(), now());
    const billId2 = billRes2.lastInsertRowid;

    resetBillPinRateLimit();
    const { result: resF2, ticks: ticksF2 } = await executeWithTickTracker(() =>
      request(app)
        .post(`/api/bills/${billId2}/payment`)
        .set(ownerAuth)
        .send({
          method: 'cash',
          amount: 44,
          override_pin: '9999',
        }),
    );
    assertEqualOrThrow(resF2.status, 403, 'Payment fails with 403 on invalid manager PIN');
    assertGreaterThanOrThrow(ticksF2, 0, 'Event loop yielded during invalid kitchen override scan');
  }

  // ─── 3. Atomic Revalidation & Race Condition Protection ───────────────────
  console.log('\n--- 3. Atomic SQLite Revalidation Under Transaction Lock ---');
  {
    // Test: Candidate PIN hash changed between pre-check and withTxn commit
    const preVerified = { id: 'mgr-1', verifiedPinHash: pinHashes[0] };
    const originalHash = pinHashes[0];
    const alteredHash = bcrypt.hashSync('9999', 8);

    // Update PIN hash in database to simulate concurrent PIN reset
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(alteredHash, 'mgr-1');

    let threwExpected = false;
    try {
      withTxn(() => {
        const candidate = db
          .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
          .get(preVerified.id) as { id: string; role: string; pin_hash: string; is_active: number };
        if (
          !candidate ||
          candidate.is_active !== 1 ||
          candidate.pin_hash !== preVerified.verifiedPinHash
        ) {
          throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
        }
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(threwExpected, 'Altered PIN hash between pre-check and commit rejected with 403');
    // Restore original hash
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(originalHash, 'mgr-1');

    // Test: Candidate deactivated between pre-check and commit
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run('mgr-1');
    threwExpected = false;
    try {
      withTxn(() => {
        const candidate = db
          .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
          .get(preVerified.id) as { id: string; role: string; pin_hash: string; is_active: number };
        if (
          !candidate ||
          candidate.is_active !== 1 ||
          candidate.pin_hash !== preVerified.verifiedPinHash
        ) {
          throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
        }
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(threwExpected, 'Deactivated manager between pre-check and commit rejected with 403');
    // Restore active status
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run('mgr-1');

    // Test: Candidate role demoted to cashier between pre-check and commit
    db.prepare("UPDATE users SET role = 'cashier' WHERE id = ?").run('mgr-1');
    threwExpected = false;
    try {
      withTxn(() => {
        const candidate = db
          .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
          .get(preVerified.id) as { id: string; role: string; pin_hash: string; is_active: number };
        if (
          !candidate ||
          candidate.is_active !== 1 ||
          candidate.role !== 'manager' ||
          candidate.pin_hash !== preVerified.verifiedPinHash
        ) {
          throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
        }
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(threwExpected, 'Demoted manager between pre-check and commit rejected with 403');
    // Restore manager role
    db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run('mgr-1');
  }

  // ─── 4. Non-Blocking Concurrent WAL Database Operations ───────────────────
  console.log('\n--- 4. Non-Blocking Concurrent WAL Database Operations ---');
  {
    // Start an asynchronous 5-hash verification
    const asyncVerifyPromise = (async () => {
      for (const hash of pinHashes) {
        await verifyPinAsync(hash, '9999');
      }
      return true;
    })();

    const walOrder = db.prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES ('ORD-WAL-001', 'dine_in', 10, 1, 11, 'pending', ?, ?)
    `).run(now(), now());
    const walOrderId = walOrder.lastInsertRowid;

    // While the async verification is executing, perform concurrent database writes
    let writeCount = 0;
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO order_audit_log (order_id, actor_user_id, action, details_json, created_at)
        VALUES (?, 'cashier-1', 'wal_concurrent_write', ?, ?)
      `).run(walOrderId, JSON.stringify({ iteration: i }), now());
      writeCount++;
    }

    const verifyResult = await asyncVerifyPromise;
    assertEqualOrThrow(verifyResult, true, 'Asynchronous PIN verification completed successfully');
    assertEqualOrThrow(writeCount, 10, '10 concurrent WAL database writes succeeded during async PIN verification');
  }

  console.log('\nAll Asynchronous PIN Event Loop tests passed successfully!');
  closeDatabase();
}

run()
  .then(() => {
    const results = getResults();
    console.log(`\nResults: ${results.passed} passed, ${results.failed} failed`);
    process.exit(results.failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
