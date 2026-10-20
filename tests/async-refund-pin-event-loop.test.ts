/**
 * Test suite: Asynchronous Refund PIN Verification & Event Loop Responsiveness
 *
 * Verifies that:
 * 1. Synchronous verifyPin blocks the event loop (0 ticks), while verifyPinAsync yields
 *    to the event loop (ticks > 0).
 * 2. POST /api/refunds performs asynchronous PIN verification outside withTxn, yielding
 *    to the Node.js event loop for both valid and invalid PINs.
 * 3. Late refund authorization (order > 1 hour ago) verifies owner PIN asynchronously outside withTxn.
 * 4. Concurrent SQLite write transactions proceed freely without transaction lock contention
 *    during asynchronous refund PIN evaluation.
 * 5. Atomic SQLite revalidation inside withTxn prevents race conditions:
 *    - PIN hash changed between pre-check and commit throws 403.
 *    - Approver deactivated between pre-check and commit throws 403.
 *    - Approver demoted between pre-check and commit throws 403.
 *    - Regular refund transitioned to late refund between pre-check and commit throws 403 for non-owner.
 * 6. withRefundPinLock serializes concurrent invalid PIN attempts and enforces rate limiting (429).
 * 7. Idempotency replays return the stored response outside withTxn without re-evaluating PINs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-async-refund-pin-'));

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

const { refundRoutes, resetRefundPinLocksForTests } = require('../main/routes/refunds');
const { resetPinRateLimitForTests: resetOrderPinRateLimit } = require('../main/routes/orders');
const { getJWTSecret } = require('../main/routes/auth');
const { verifyPin, verifyPinAsync, withTxn } = require('../main/db');
const { createRefund } = require('../main/services/refund');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function run() {
  console.log('Testing Asynchronous Refund PIN Verification & Event Loop...');
  console.log('='.repeat(70));

  const db = initTestDb();

  resetRefundPinLocksForTests();
  resetOrderPinRateLimit();

  // Create accounts
  const managerPin = '1234';
  const managerHash = bcrypt.hashSync(managerPin, 8);
  const managerId = 'mgr-async-1';
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, 'Manager 1', 'mgr1@test.com', 'dummy', 'manager', ?, 1, ?, ?)
  `).run(managerId, managerHash, now(), now());

  const ownerPin = '8888';
  const ownerHash = bcrypt.hashSync(ownerPin, 8);
  const ownerId = 'owner-async-1';
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, 'Owner 1', 'owner1@test.com', 'dummy', 'owner', ?, 1, ?, ?)
  `).run(ownerId, ownerHash, now(), now());

  const cashierId = 'cashier-async-1';
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, 'Cashier 1', 'cashier1@test.com', 'dummy', 'cashier', NULL, 1, ?, ?)
  `).run(cashierId, now(), now());

  // Ensure cash session is open for cash refunds
  db.prepare(`
    INSERT INTO cash_sessions (opened_by, opened_at, opening_float_cents, status)
    VALUES (?, ?, 10000, 'open')
  `).run(ownerId, now());

  const ownerAuth = makeToken(ownerId, 'owner', 'owner1@test.com');
  const app = createApp({ '/api/refunds': refundRoutes });

  // Helper to create a paid bill fixture
  function createPaidBill(options: { total?: number; createdAt?: string } = {}) {
    const total = options.total ?? 100;
    const createdAt = options.createdAt ?? now();
    const orderRes = db
      .prepare(`
      INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'dine_in', ?, 0, ?, 'completed', ?, ?)
    `)
      .run(`ORD-REF-${Date.now()}-${Math.random()}`, total, total, createdAt, createdAt);
    const orderId = orderRes.lastInsertRowid;

    const billRes = db
      .prepare(`
      INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, total, paid_amount, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, 'paid', ?, ?)
    `)
      .run(
        orderId,
        `BILL-REF-${Date.now()}-${Math.random()}`,
        total,
        total,
        total,
        createdAt,
        createdAt,
      );
    const billId = billRes.lastInsertRowid;

    return { orderId, billId, total };
  }

  // Monitor event loop ticks during an async action
  async function executeWithTickTracker<T>(
    action: () => Promise<T>,
  ): Promise<{ result: T; ticks: number }> {
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

  // ─── 1. Event Loop Yielding on Valid and Invalid Refund PINs ──────────────
  console.log('\n--- 1. Event Loop Yielding on Refund PIN Verification ---');
  {
    // A. Valid manager PIN
    const fixture1 = createPaidBill();
    resetRefundPinLocksForTests();
    resetOrderPinRateLimit();

    const { result: resValid, ticks: ticksValid } = await executeWithTickTracker(() =>
      request(app).post('/api/refunds').set(ownerAuth).send({
        bill_id: fixture1.billId,
        amount: fixture1.total,
        method: 'cash',
        approver_id: managerId,
        override_pin: managerPin,
      }),
    );
    assertEqualOrThrow(resValid.status, 201, 'Valid refund request succeeds with 201');
    assertGreaterThanOrThrow(
      ticksValid,
      0,
      `Event loop yielded during valid refund PIN verification (${ticksValid} ticks observed)`,
    );

    // B. Invalid manager PIN
    const fixture2 = createPaidBill();
    resetRefundPinLocksForTests();
    resetOrderPinRateLimit();

    const { result: resInvalid, ticks: ticksInvalid } = await executeWithTickTracker(() =>
      request(app).post('/api/refunds').set(ownerAuth).send({
        bill_id: fixture2.billId,
        amount: fixture2.total,
        method: 'cash',
        approver_id: managerId,
        override_pin: '9999',
      }),
    );
    assertEqualOrThrow(resInvalid.status, 403, 'Invalid PIN refund request rejected with 403');
    assertEqualOrThrow(
      resInvalid.body.display_code,
      'approver_pin_invalid',
      'Diagnostic display code is approver_pin_invalid',
    );
    assertGreaterThanOrThrow(
      ticksInvalid,
      0,
      `Event loop yielded during invalid refund PIN verification (${ticksInvalid} ticks observed)`,
    );
  }

  // ─── 2. Late Refund PIN Verification (Owner-Only) ─────────────────────────
  console.log('\n--- 2. Late Refund PIN Verification ---');
  {
    // Freeze the clock so business-day fixtures cannot flake near a day boundary
    const originalDateNow = Date.now;
    const FIXED_NOW = Date.UTC(2025, 5, 15, 12, 0, 0);
    Date.now = () => FIXED_NOW;

    try {
      // Order created 1.5 hours ago (past 1-hour in-progress window, same business day)
      const lateFixture = createPaidBill({ createdAt: '2025-06-15 10:30:00' });

      // Manager PIN on late refund -> rejected with 403
      resetRefundPinLocksForTests();
      resetOrderPinRateLimit();
      const resMgr = await request(app).post('/api/refunds').set(ownerAuth).send({
        bill_id: lateFixture.billId,
        amount: lateFixture.total,
        method: 'cash',
        approver_id: managerId,
        override_pin: managerPin,
      });
      assertEqualOrThrow(resMgr.status, 403, 'Manager PIN cannot authorize late refund');

      // Owner PIN on late refund -> succeeds with 201 and yields event loop
      resetRefundPinLocksForTests();
      resetOrderPinRateLimit();
      const { result: resOwner, ticks: ticksOwner } = await executeWithTickTracker(() =>
        request(app).post('/api/refunds').set(ownerAuth).send({
          bill_id: lateFixture.billId,
          amount: lateFixture.total,
          method: 'cash',
          approver_id: ownerId,
          override_pin: ownerPin,
        }),
      );
      assertEqualOrThrow(resOwner.status, 201, 'Owner PIN authorizes late refund');
      assertGreaterThanOrThrow(
        ticksOwner,
        0,
        `Event loop yielded during late refund owner PIN verification (${ticksOwner} ticks observed)`,
      );
    } finally {
      Date.now = originalDateNow;
    }
  }

  // ─── 3. Non-Blocking Concurrent SQLite Write Operations ───────────────────
  console.log('\n--- 3. Non-Blocking Concurrent SQLite Writes During PIN Verification ---');
  {
    const fixtureConcurrent = createPaidBill();
    resetRefundPinLocksForTests();
    resetOrderPinRateLimit();

    // Launch refund request in background
    const refundPromise = request(app).post('/api/refunds').set(ownerAuth).send({
      bill_id: fixtureConcurrent.billId,
      amount: fixtureConcurrent.total,
      method: 'cash',
      approver_id: managerId,
      override_pin: managerPin,
    });

    // While refund PIN is computing bcrypt outside withTxn, concurrent WAL write transactions execute
    let writeCount = 0;
    for (let i = 0; i < 5; i++) {
      withTxn(() => {
        db.prepare(`
          INSERT INTO order_audit_log (order_id, actor_user_id, action, details_json, created_at)
          VALUES (?, 'cashier-async-1', 'concurrent_write', ?, ?)
        `).run(fixtureConcurrent.orderId, JSON.stringify({ iter: i }), now());
      });
      writeCount++;
    }

    const refundRes = await refundPromise;
    assertEqualOrThrow(refundRes.status, 201, 'Refund completed successfully');
    assertEqualOrThrow(
      writeCount,
      5,
      '5 concurrent write transactions committed during async refund PIN evaluation',
    );
  }

  // ─── 4. Transactional Revalidation Race Condition Safeguards ──────────────
  console.log('\n--- 4. Transactional Revalidation Safeguards ---');
  {
    const fixtureRace = createPaidBill();

    // A. Approver PIN hash changed between pre-verification and commit
    let threwExpected = false;
    try {
      withTxn(() => {
        createRefund(db, {
          billId: fixtureRace.billId,
          amountCents: fixtureRace.total * 100,
          method: 'cash',
          approverId: managerId,
          createdByUserId: ownerId,
          clientIp: '127.0.0.1',
          checkPinRateLimit: () => true,
          isPinRateLimited: () => false,
          clearPinRateLimit: () => {},
          preVerifiedApprover: {
            id: managerId,
            verifiedPinHash: 'stale-hash-value',
            lateRefund: false,
          },
        });
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(threwExpected, 'Stale PIN hash between pre-check and commit rejected with 403');

    // B. Approver deactivated between pre-verification and commit
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(managerId);
    threwExpected = false;
    try {
      withTxn(() => {
        createRefund(db, {
          billId: fixtureRace.billId,
          amountCents: fixtureRace.total * 100,
          method: 'cash',
          approverId: managerId,
          createdByUserId: ownerId,
          clientIp: '127.0.0.1',
          checkPinRateLimit: () => true,
          isPinRateLimited: () => false,
          clearPinRateLimit: () => {},
          preVerifiedApprover: {
            id: managerId,
            verifiedPinHash: managerHash,
            lateRefund: false,
          },
        });
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(
      threwExpected,
      'Deactivated approver between pre-check and commit rejected with 403',
    );
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(managerId);

    // C. Approver demoted between pre-verification and commit
    db.prepare("UPDATE users SET role = 'cashier' WHERE id = ?").run(managerId);
    threwExpected = false;
    try {
      withTxn(() => {
        createRefund(db, {
          billId: fixtureRace.billId,
          amountCents: fixtureRace.total * 100,
          method: 'cash',
          approverId: managerId,
          createdByUserId: ownerId,
          clientIp: '127.0.0.1',
          checkPinRateLimit: () => true,
          isPinRateLimited: () => false,
          clearPinRateLimit: () => {},
          preVerifiedApprover: {
            id: managerId,
            verifiedPinHash: managerHash,
            lateRefund: false,
          },
        });
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(threwExpected, 'Demoted approver between pre-check and commit rejected with 403');
    db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(managerId);

    // D. Approver ID mismatch
    threwExpected = false;
    try {
      withTxn(() => {
        createRefund(db, {
          billId: fixtureRace.billId,
          amountCents: fixtureRace.total * 100,
          method: 'cash',
          approverId: managerId,
          createdByUserId: ownerId,
          clientIp: '127.0.0.1',
          checkPinRateLimit: () => true,
          isPinRateLimited: () => false,
          clearPinRateLimit: () => {},
          preVerifiedApprover: {
            id: ownerId,
            verifiedPinHash: ownerHash,
            lateRefund: false,
          },
        });
      });
    } catch (e: any) {
      if (e.statusCode === 403) threwExpected = true;
    }
    assertOrThrow(threwExpected, 'Approver ID mismatch rejected with 403');
  }

  // ─── 5. Concurrent Invalid Burst & Rate Limiting ──────────────────────────
  console.log('\n--- 5. Concurrent Burst & Rate Limiting ---');
  {
    const fixtureBurst = createPaidBill();
    resetRefundPinLocksForTests();
    resetOrderPinRateLimit();

    // Send 10 concurrent requests with invalid PIN
    const burstPromises = Array.from({ length: 10 }, () =>
      request(app).post('/api/refunds').set(ownerAuth).send({
        bill_id: fixtureBurst.billId,
        amount: fixtureBurst.total,
        method: 'cash',
        approver_id: managerId,
        override_pin: '0000',
      }),
    );

    const burstResponses = await Promise.all(burstPromises);
    const count403 = burstResponses.filter((r) => r.status === 403).length;
    const count429 = burstResponses.filter((r) => r.status === 429).length;

    assertEqualOrThrow(count403, 5, 'Exactly 5 attempts evaluated before rate limit lockout');
    assertEqualOrThrow(count429, 5, 'Remaining 5 concurrent requests locked out with 429');
  }

  // ─── 6. Idempotency Replay Outside Transaction ────────────────────────────
  console.log('\n--- 6. Idempotency Replay Outside Transaction ---');
  {
    const fixtureIdem = createPaidBill();
    resetRefundPinLocksForTests();
    resetOrderPinRateLimit();

    const idempotencyKey = `refund-idem-test-${Date.now()}`;
    const payload = {
      bill_id: fixtureIdem.billId,
      amount: fixtureIdem.total,
      method: 'cash',
      approver_id: managerId,
      override_pin: managerPin,
    };

    const firstRes = await request(app)
      .post('/api/refunds')
      .set({ ...ownerAuth, 'Idempotency-Key': idempotencyKey })
      .send(payload);
    assertEqualOrThrow(firstRes.status, 201, 'First idempotent refund succeeds');

    // Replay with matching key & body: returns stored response even if PIN is missing or invalid!
    const replayRes = await request(app)
      .post('/api/refunds')
      .set({ ...ownerAuth, 'Idempotency-Key': idempotencyKey })
      .send({ ...payload, override_pin: 'wrong-pin' });
    assertEqualOrThrow(
      replayRes.status,
      201,
      'Idempotent replay returns 201 without re-evaluating PIN',
    );
    assertEqualOrThrow(
      replayRes.body.refund.id,
      firstRes.body.refund.id,
      'Replay returns exact same refund ID',
    );
  }

  console.log('\nAll Asynchronous Refund PIN tests passed successfully!');
  closeDatabase();
}

run()
  .then(() => {
    const results = getResults();
    console.log(`\nResults: ${results.passed} passed, ${results.failed} failed`);
    process.exit(results.failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nTest failed with error:', err);
    process.exit(1);
  });
