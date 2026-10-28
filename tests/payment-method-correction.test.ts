/**
 * Issue #1337: Correct the payment method on a paid bill while its shift is open.
 *
 * Run: npm run test:payment-method-correction
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
  } catch (err: any) {
    if (
      err?.code === 'ERR_DLOPEN_FAILED' ||
      String(err?.message || '').includes('NODE_MODULE_VERSION')
    ) {
      const runner = path.resolve(__dirname, 'run-electron-node-test.cjs');
      const res = spawnSync(process.execPath, [runner, __filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: process.env,
      });
      process.exit(res.status ?? 1);
    }
    throw err;
  }
}

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payment-method-correction-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-payment-method-correction';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { reportRoutes } = require('../main/routes/reports');
const { cashSessionRoutes } = require('../main/routes/cash-sessions');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { getJWTSecret } = require('../main/routes/auth');
const { buildBillPrintData } = require('../main/printers/document-classic');

function findMethodRow(
  rows: Array<{ method: string; total: number; count: number }>,
  name: string,
) {
  return rows.find((r) => r.method.toLowerCase() === name.toLowerCase()) || null;
}

async function main() {
  console.log('Issue #1337: payment method correction on paid bills');
  const db = initTestDb();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('timezone', 'UTC') ON CONFLICT(key) DO UPDATE SET value = 'UTC'",
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('country', 'US') ON CONFLICT(key) DO UPDATE SET value = 'US'",
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('currency', 'USD') ON CONFLICT(key) DO UPDATE SET value = 'USD'",
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('split_checks_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'",
  ).run();

  const { userId: ownerId, authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
    bcrypt.hashSync('9999', 10),
    ownerId,
  );
  // seedManagerUser sets manager PIN to '1234'

  const inactiveManagerId = 'manager-inactive-1337';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, 'Inactive Manager', 'inactive-mgr@test.local', ?, 'manager', ?, 0, ?, ?)`,
  ).run(
    inactiveManagerId,
    bcrypt.hashSync('password123', 10),
    bcrypt.hashSync('7777', 10),
    now(),
    now(),
  );

  const cashierId = 'cashier-1337';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, 'Cashier User', 'cashier@test.local', ?, 'cashier', ?, 1, ?, ?)`,
  ).run(cashierId, bcrypt.hashSync('password123', 10), bcrypt.hashSync('5555', 10), now(), now());
  const cashierAuth = {
    Authorization: `Bearer ${jwt.sign(
      { userId: cashierId, email: 'cashier@test.local', role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}`,
  };

  const chefId = 'chef-1337';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, 'Chef User', 'chef@test.local', ?, 'chef', 1, ?, ?)`,
  ).run(chefId, bcrypt.hashSync('password123', 10), now(), now());
  const chefAuth = {
    Authorization: `Bearer ${jwt.sign(
      { userId: chefId, email: 'chef@test.local', role: 'chef' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}`,
  };

  const serverId = 'server-1337';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, 'Server User', 'server@test.local', ?, 'server', 1, ?, ?)`,
  ).run(serverId, bcrypt.hashSync('password123', 10), now(), now());
  db.prepare(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
     VALUES (?, 'payments.take', 'allow', ?, ?)`,
  ).run(serverId, ownerId, now());
  const serverAuth = {
    Authorization: `Bearer ${jwt.sign(
      { userId: serverId, email: 'server@test.local', role: 'server' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}`,
  };

  seedCategory(db, 'cat-1337', 'Menu');
  seedProduct(db, 'prod-100', 'cat-1337', 'Steak Dinner', 100);
  seedProduct(db, 'prod-80', 'cat-1337', 'Pasta Plate', 80);
  seedTable(db, 'table-split-1337', 'T-1337');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/reports': reportRoutes,
    '/api/cash-sessions': cashSessionRoutes,
    '/api/payment-methods': paymentMethodRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  async function createPaidBill(
    productId: string,
    method: string,
    extraPayment: Record<string, unknown> = {},
    headers = cashierAuth,
  ) {
    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: productId, quantity: 1 }] },
      headers,
    });
    assertEqualOrThrow(orderRes.status, 201, 'order created');
    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderRes.data.order.id },
      headers,
    });
    assertEqualOrThrow(billRes.status, 201, 'bill generated');
    const payRes = await api(baseUrl, `/api/bills/${billRes.data.bill.id}/payment`, {
      method: 'POST',
      body: { method, amount: null, ...extraPayment },
      headers,
    });
    assertEqualOrThrow(payRes.status, 200, 'bill paid');
    return { order: orderRes.data.order, bill: payRes.data.bill };
  }

  try {
    // ── 0. Sessionless payment before any shift opens (cash_session_id = 0) ─
    const { bill: sessionlessBill } = await createPaidBill('prod-80', 'card', {
      transaction_id: 'TX-SESSIONLESS-001',
    });
    assertEqualOrThrow(
      sessionlessBill.payment_details[0].cash_session_id,
      0,
      'payment recorded without an open shift has cash_session_id = 0',
    );
    // Delete the pre-shift bill's order/bill after testing it inside Shift 1 so Shift 1 X-report starts clean
    // (we'll verify rejection once Shift 1 is open)

    // ── 1. Open a cash shift (opening float $50 = 5000 cents) ─────────────
    const openSessionRes = await api(baseUrl, '/api/cash-sessions/open', {
      method: 'POST',
      body: { opening_float_cents: 5000 },
      headers: managerAuth,
    });
    assertEqualOrThrow(openSessionRes.status, 200, 'open cash session succeeds');
    const session1Id = openSessionRes.data.id;

    // F6a: Payment recorded with cash_session_id = 0 (no open shift at payment time) is rejected with 409 even after a shift opens
    const correctSessionlessRes = await api(
      baseUrl,
      `/api/bills/${sessionlessBill.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: managerAuth,
        body: {
          method: 'cash',
          reason: 'Attempt to move sessionless payment into open shift',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      correctSessionlessRes.status,
      409,
      'payment recorded with cash_session_id = 0 is rejected with 409 even after a shift opens',
    );
    assertEqualOrThrow(
      correctSessionlessRes.data.reason,
      'shift_closed',
      'sessionless payment rejection includes reason = shift_closed',
    );
    const unchangedSessionless = await api(baseUrl, `/api/bills/${sessionlessBill.id}`, {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      unchangedSessionless.data.bill.payment_details[0].cash_session_id,
      0,
      'sessionless payment cash_session_id remains 0',
    );
    assertEqualOrThrow(
      unchangedSessionless.data.bill.payment_details[0].method,
      'card',
      'sessionless payment method remains card',
    );

    // F6b: Legacy/untagged card payment with no cash_session_id and no cash_transactions row is rejected with 409
    db.prepare('UPDATE bills SET payment_details = ? WHERE id = ?').run(
      JSON.stringify([
        {
          method: 'card',
          amount: 80,
          requested_amount: 80,
          amount_omitted: true,
          transaction_id: 'TX-SESSIONLESS-001',
          timestamp: now(),
        },
      ]),
      sessionlessBill.id,
    );
    const correctUntaggedRes = await api(
      baseUrl,
      `/api/bills/${sessionlessBill.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: managerAuth,
        body: {
          method: 'cash',
          reason: 'Attempt to attach untagged payment to current open shift',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      correctUntaggedRes.status,
      409,
      'legacy/untagged payment with no cash_session_id is rejected with 409 rather than attached to current shift',
    );
    assertEqualOrThrow(
      correctUntaggedRes.data.reason,
      'shift_closed',
      'untagged payment rejection includes reason = shift_closed',
    );
    const unchangedUntagged = await api(baseUrl, `/api/bills/${sessionlessBill.id}`, {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      unchangedUntagged.data.bill.payment_details[0].cash_session_id,
      undefined,
      'untagged payment is not silently assigned cash_session_id',
    );
    // Clean up the F6 fixture bill so X-report totals below reflect only Shift 1 bills
    db.prepare('DELETE FROM payment_transaction_refs WHERE bill_id = ?').run(
      String(sessionlessBill.id),
    );
    db.prepare('DELETE FROM bills WHERE id = ?').run(sessionlessBill.id);
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(sessionlessBill.order_id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(sessionlessBill.order_id);

    // ── 2. Cash -> Card on open shift updates shift expected cash & X-report ─
    const { order: order1, bill: bill1 } = await createPaidBill('prod-100', 'cash');

    const currentBefore1 = await api(baseUrl, '/api/cash-sessions/current', {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      currentBefore1.data.expected_cash_cents,
      15000,
      'expected cash is 5000 float + 10000 cash sale before correction',
    );
    const xReportBefore1 = await api(baseUrl, '/api/reports/x-report', { headers: managerAuth });
    assertEqualOrThrow(
      xReportBefore1.data.xReport.expectedCashCents,
      10000,
      'X-report expectedCashCents includes 10000 cash sale before correction',
    );
    assertEqualOrThrow(
      findMethodRow(xReportBefore1.data.xReport.paymentMethods, 'Cash')?.total,
      100,
      'X-report Cash total is 100 before correction',
    );

    // ── 3. Actor Role & PIN Authorization Checks (F5) ────────────────────
    const chefAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        approver_id: managerId,
        override_pin: '1234',
      },
      headers: chefAuth,
    });
    assertEqualOrThrow(
      chefAttempt.status,
      403,
      'chef without payments.take cannot correct payment method',
    );

    const serverWithManagerPinAttempt = await api(
      baseUrl,
      `/api/bills/${bill1.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: { ...serverAuth, 'Idempotency-Key': 'idem-server-blocked-1337' },
        body: {
          method: 'card',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      serverWithManagerPinAttempt.status,
      403,
      'server actor is rejected with 403 even with payments.take and valid manager PIN',
    );

    const cashierOwnPinAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: { ...cashierAuth, 'Idempotency-Key': 'idem-cashier-own-pin-1337' },
      body: {
        method: 'card',
        approver_id: cashierId,
        override_pin: '5555',
      },
    });
    assertEqualOrThrow(
      cashierOwnPinAttempt.status,
      403,
      'cashier actor with cashier PIN is rejected with 403',
    );

    const cashierWithValidManagerPinAttempt = await api(
      baseUrl,
      `/api/bills/${bill1.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: { ...cashierAuth, 'Idempotency-Key': 'idem-cashier-mgr-pin-1337' },
        body: {
          method: 'card',
          transaction_id: 'TX-CASHIER-BLOCKED',
          reason: 'Cashier attempting correction with manager PIN',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      cashierWithValidManagerPinAttempt.status,
      403,
      'cashier actor is rejected with 403 even when supplying valid manager override_pin and approver_id',
    );
    assertEqualOrThrow(
      cashierWithValidManagerPinAttempt.data.reason,
      'insufficient_role_permissions',
      'cashier actor rejection returns reason = insufficient_role_permissions',
    );

    // Verify zero payment updates, zero audit_log writes, and zero payment_idempotency writes from non-owner/manager actors
    const billAfterForbiddenActors = await api(baseUrl, `/api/bills/${bill1.id}`, {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      billAfterForbiddenActors.data.bill.payment_details[0].method,
      'cash',
      'rejected cashier/server/chef attempts perform zero payment updates',
    );
    const auditCountAfterForbiddenActors = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM order_audit_log WHERE order_id = ? AND action = 'bill.payment_method.corrected'`,
        )
        .get(order1.id) as { c: number }
    ).c;
    assertEqualOrThrow(
      auditCountAfterForbiddenActors,
      0,
      'rejected cashier/server/chef attempts perform zero order_audit_log writes',
    );
    const idemCountAfterForbiddenActors = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM payment_idempotency WHERE bill_id = ?`)
        .get(String(bill1.id)) as { c: number }
    ).c;
    assertEqualOrThrow(
      idemCountAfterForbiddenActors,
      0,
      'rejected cashier/server/chef attempts perform zero payment_idempotency writes',
    );

    // Now test PIN validation when called by an authorized manager actor
    const managerWithCashierPinAndId = await api(
      baseUrl,
      `/api/bills/${bill1.id}/payments/0/method`,
      {
        method: 'PATCH',
        body: {
          method: 'card',
          approver_id: cashierId,
          override_pin: '5555',
        },
        headers: managerAuth,
      },
    );
    assertEqualOrThrow(
      managerWithCashierPinAndId.status,
      403,
      'cashier PIN with cashier approver_id is rejected with 403 even when caller is manager',
    );

    const managerWithCashierPinWithoutId = await api(
      baseUrl,
      `/api/bills/${bill1.id}/payments/0/method`,
      {
        method: 'PATCH',
        body: {
          method: 'card',
          override_pin: '5555',
        },
        headers: managerAuth,
      },
    );
    assertEqualOrThrow(
      managerWithCashierPinWithoutId.status,
      403,
      'cashier PIN without approver_id is rejected with 403 even when caller is manager',
    );

    const inactiveManagerAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        approver_id: inactiveManagerId,
        override_pin: '7777',
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(
      inactiveManagerAttempt.status,
      403,
      'inactive manager PIN is rejected with 403',
    );

    const wrongManagerPinAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        approver_id: managerId,
        override_pin: '0000',
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(
      wrongManagerPinAttempt.status,
      403,
      'wrong manager PIN is rejected with 403',
    );

    const fifthFailedPinAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        override_pin: '5555',
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(
      fifthFailedPinAttempt.status,
      403,
      'fifth failed PIN attempt is rejected with 403 and reaches rate-limit threshold',
    );

    const rateLimitedPinAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        approver_id: managerId,
        override_pin: '1234',
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(
      rateLimitedPinAttempt.status,
      429,
      'sixth PIN attempt after five failures is rejected with 429',
    );
    assertEqualOrThrow(
      rateLimitedPinAttempt.data.reason,
      'pin_rate_limited',
      'rate-limited PIN response includes reason = pin_rate_limited',
    );
    resetPinRateLimitForTests();

    const immutableAmountAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        amount: 50,
        approver_id: managerId,
        override_pin: '1234',
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(
      immutableAmountAttempt.status,
      400,
      'attempting to change the payment amount is rejected with 400',
    );

    // ── 4. Valid Cash -> Card correction by manager with manager PIN ──────
    const idemKey1 = 'idem-correct-1337-1';
    const correctToCard = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: { ...managerAuth, 'Idempotency-Key': idemKey1 },
      body: {
        method: 'card',
        transaction_id: 'TX-CARD-101',
        reason: 'Customer tapped card instead of cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      correctToCard.status,
      200,
      'manager actor with valid manager PIN corrects cash -> card (200)',
    );
    assertEqualOrThrow(
      correctToCard.data.bill.payment_details[0].method,
      'card',
      'payment line method is now card',
    );
    assertEqualOrThrow(
      correctToCard.data.bill.payment_details[0].amount,
      100,
      'payment line amount remains 100',
    );
    assertEqualOrThrow(
      correctToCard.data.bill.payment_details[0].transaction_id,
      'TX-CARD-101',
      'payment line transaction_id is set',
    );
    assertEqualOrThrow(
      correctToCard.data.bill.payment_details[0].tendered_amount,
      undefined,
      'tendered_amount removed when switching from cash to card',
    );

    // Verify expected cash and X-report recalculated automatically
    const currentAfter1 = await api(baseUrl, '/api/cash-sessions/current', {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      currentAfter1.data.expected_cash_cents,
      5000,
      'expected cash drops by 10000 cents after cash -> card correction',
    );
    const xReportAfter1 = await api(baseUrl, '/api/reports/x-report', { headers: managerAuth });
    assertEqualOrThrow(
      xReportAfter1.data.xReport.expectedCashCents,
      0,
      'X-report expectedCashCents drops to 0 after cash -> card correction',
    );
    assertEqualOrThrow(
      findMethodRow(xReportAfter1.data.xReport.paymentMethods, 'Cash'),
      null,
      'X-report Cash row is empty after cash -> card correction',
    );
    assertEqualOrThrow(
      findMethodRow(xReportAfter1.data.xReport.paymentMethods, 'Card')?.total,
      100,
      'X-report Card total rises by 100 after cash -> card correction',
    );

    // ── 5. Audit row & Idempotency (Idempotency-Key + natural replay) ────
    const auditRows1 = db
      .prepare(
        `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'bill.payment_method.corrected' ORDER BY id ASC`,
      )
      .all(order1.id) as any[];
    assertEqualOrThrow(auditRows1.length, 1, 'exactly 1 audit row written for cash -> card');
    assertEqualOrThrow(
      auditRows1[0].actor_user_id,
      managerId,
      'audit row records manager as actor_user_id',
    );
    const auditDetails1 = JSON.parse(auditRows1[0].details_json);
    assertEqualOrThrow(auditDetails1.old_method, 'cash', 'audit details record old_method = cash');
    assertEqualOrThrow(auditDetails1.new_method, 'card', 'audit details record new_method = card');
    assertEqualOrThrow(
      auditDetails1.actor_id,
      managerId,
      'audit details record actor_id = managerId',
    );
    assertEqualOrThrow(
      auditDetails1.approver_id,
      managerId,
      'audit details record approver_id = managerId',
    );
    assertEqualOrThrow(
      auditDetails1.reason,
      'Customer tapped card instead of cash',
      'audit details record reason',
    );
    assertOrThrow(Boolean(auditDetails1.timestamp), 'audit details record timestamp');

    // Replay with same Idempotency-Key
    const idemReplay = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: { ...managerAuth, 'Idempotency-Key': idemKey1 },
      body: {
        method: 'card',
        transaction_id: 'TX-CARD-101',
        reason: 'Customer tapped card instead of cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(idemReplay.status, 200, 'Idempotency-Key replay returns 200');
    assertEqualOrThrow(
      idemReplay.data.idempotentReplay,
      true,
      'Idempotency-Key replay sets idempotentReplay = true',
    );

    // Natural replay without Idempotency-Key
    const naturalReplay = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'card',
        transaction_id: 'TX-CARD-101',
        reason: 'Customer tapped card instead of cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(naturalReplay.status, 200, 'natural replay of same method returns 200');
    assertEqualOrThrow(
      naturalReplay.data.idempotentReplay,
      true,
      'natural replay sets idempotentReplay = true',
    );
    const auditCountAfterReplay = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM order_audit_log WHERE order_id = ? AND action = 'bill.payment_method.corrected'`,
        )
        .get(order1.id) as any
    ).c;
    assertEqualOrThrow(
      auditCountAfterReplay,
      1,
      'replaying the same request does not write a duplicate audit row',
    );

    // Conflicting payload with same Idempotency-Key returns 409
    const idemConflict = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: { ...managerAuth, 'Idempotency-Key': idemKey1 },
      body: {
        method: 'cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      idemConflict.status,
      409,
      'reusing Idempotency-Key with a different target method returns 409',
    );

    const idemReasonConflict = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: { ...managerAuth, 'Idempotency-Key': idemKey1 },
      body: {
        method: 'card',
        transaction_id: 'TX-CARD-101',
        reason: 'Different reason than original request',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      idemReasonConflict.status,
      409,
      'reusing Idempotency-Key with a different reason returns 409',
    );

    // ── 6. Receipt reprint & GET /api/bills/:id show corrected method ─────
    const fetchedBill1 = await api(baseUrl, `/api/bills/${bill1.id}`, { headers: cashierAuth });
    assertEqualOrThrow(fetchedBill1.status, 200, 'GET /api/bills/:id succeeds');
    assertEqualOrThrow(
      fetchedBill1.data.bill.payment_details[0].method,
      'card',
      'GET /api/bills/:id returns corrected method',
    );
    const printData1 = buildBillPrintData(order1, fetchedBill1.data.bill, {}, true);
    assertEqualOrThrow(printData1.isReprint, true, 'print data is marked as reprint');
    assertEqualOrThrow(
      printData1.bill.payments[0]?.method,
      'card',
      'receipt reprint PrintData shows corrected payment method',
    );

    // ── 7. Card -> Cash on open shift updates shift expected cash & X-report ─
    const { bill: bill2 } = await createPaidBill('prod-80', 'card', {
      transaction_id: 'TX-CARD-202',
    });
    const correctToCash = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: ownerAuth,
      body: {
        method: 'cash',
        reason: 'Paid in cash at counter',
        approver_id: ownerId,
        override_pin: '9999',
      },
    });
    assertEqualOrThrow(
      correctToCash.status,
      200,
      'owner actor with owner PIN authorizes card -> cash correction (200)',
    );
    assertEqualOrThrow(
      correctToCash.data.bill.payment_details[0].method,
      'cash',
      'payment line method is now cash',
    );
    assertEqualOrThrow(
      correctToCash.data.bill.payment_details[0].tendered_amount,
      80,
      'tendered_amount set to line amount when switching to cash',
    );
    assertEqualOrThrow(
      correctToCash.data.bill.payment_details[0].change_amount,
      0,
      'change_amount set to 0 when switching to cash',
    );

    const currentAfter2 = await api(baseUrl, '/api/cash-sessions/current', {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      currentAfter2.data.expected_cash_cents,
      13000,
      'expected cash rises by 8000 cents (5000 float + 8000 cash) after card -> cash correction',
    );
    const xReportAfter2 = await api(baseUrl, '/api/reports/x-report', { headers: managerAuth });
    assertEqualOrThrow(
      xReportAfter2.data.xReport.expectedCashCents,
      8000,
      'X-report expectedCashCents rises to 8000 after card -> cash correction',
    );
    assertEqualOrThrow(
      findMethodRow(xReportAfter2.data.xReport.paymentMethods, 'Cash')?.total,
      80,
      'X-report Cash total is 80 after card -> cash correction',
    );
    assertEqualOrThrow(
      findMethodRow(xReportAfter2.data.xReport.paymentMethods, 'Card')?.total,
      100,
      'X-report Card total drops back to 100 after card -> cash correction',
    );

    // ── 8. Unknown, inactive, and active custom payment methods ───────────
    const unknownMethodRes = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'unknown-tender-xyz',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(unknownMethodRes.status, 400, 'unknown payment method is rejected with 400');

    const walletSwapRes = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'wallet',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(walletSwapRes.status, 400, 'changing to wallet is rejected with 400');

    const createCustomPm = await api(baseUrl, '/api/payment-methods', {
      method: 'POST',
      headers: ownerAuth,
      body: { name: 'UPI' },
    });
    assertEqualOrThrow(createCustomPm.status, 201, 'custom payment method UPI created');
    const upiId = createCustomPm.data.payment_method.id;

    // Deactivate UPI and verify correction is refused
    await api(baseUrl, `/api/payment-methods/${upiId}`, {
      method: 'PUT',
      headers: ownerAuth,
      body: { is_active: false },
    });
    const inactiveCustomRes = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'custom',
        payment_method_id: upiId,
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      inactiveCustomRes.status,
      409,
      'inactive custom payment method is rejected with 409',
    );

    // Reactivate UPI and verify correction succeeds
    await api(baseUrl, `/api/payment-methods/${upiId}`, {
      method: 'PUT',
      headers: ownerAuth,
      body: { is_active: true },
    });
    const activeCustomRes = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'custom',
        payment_method_id: upiId,
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      activeCustomRes.status,
      200,
      'active custom payment method UPI succeeds (200)',
    );
    assertEqualOrThrow(
      activeCustomRes.data.bill.payment_details[0].method,
      'UPI',
      'custom method resolves to canonical name UPI',
    );
    assertEqualOrThrow(
      activeCustomRes.data.bill.payment_details[0].payment_method_id,
      upiId,
      'custom method stores payment_method_id',
    );

    // Switch bill2 back to cash for subsequent shift-close assertions
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
      bcrypt.hashSync('1234', 10),
      cashierId,
    );
    const sharedPinNoApproverRes = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'cash',
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      sharedPinNoApproverRes.status,
      200,
      'omitting approver_id when active manager shares PIN value with cashier succeeds (200)',
    );
    assertEqualOrThrow(
      sharedPinNoApproverRes.data.audit.approver_id,
      managerId,
      'shared PIN without approver_id attributes approval to the active manager',
    );
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
      bcrypt.hashSync('5555', 10),
      cashierId,
    );

    // ── 9. Refunded bill is refused with 409 ─────────────────────────────
    const { bill: refundBill } = await createPaidBill('prod-80', 'cash');
    const refundRes = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      headers: ownerAuth,
      body: {
        bill_id: refundBill.id,
        amount: 80,
        method: 'cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(refundRes.status, 201, 'refund issued on refundBill');

    const correctRefundedBill = await api(
      baseUrl,
      `/api/bills/${refundBill.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: managerAuth,
        body: {
          method: 'card',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      correctRefundedBill.status,
      409,
      'correcting payment method on a refunded bill is rejected with 409',
    );

    // ── 10. Split check sibling in a closed shift is refused with 409 ─────
    const splitOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: cashierAuth,
      body: {
        type: 'dine_in',
        table_id: 'table-split-1337',
        items: [{ product_id: 'prod-100', quantity: 2 }],
      },
    });
    assertEqualOrThrow(splitOrderRes.status, 201, 'dine-in order created for split check');
    const splitOrderItemId = splitOrderRes.data.order.items[0].id;
    const sourceBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: cashierAuth,
      body: { order_id: splitOrderRes.data.order.id },
    });
    assertEqualOrThrow(sourceBillRes.status, 201, 'source bill generated for split check');
    const splitRes = await api(baseUrl, `/api/bills/${sourceBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      headers: cashierAuth,
      body: {
        checks: [
          { label: 'Guest 1', items: [{ order_item_id: splitOrderItemId, quantity: 1 }] },
          { label: 'Guest 2', items: [{ order_item_id: splitOrderItemId, quantity: 1 }] },
        ],
      },
    });
    assertEqualOrThrow(splitRes.status, 201, 'split check created 2 sibling bills');
    const [splitBillA, splitBillB] = splitRes.data.bills;

    // Pay splitBillA in session 1
    const paySplitA = await api(baseUrl, `/api/bills/${splitBillA.id}/payment`, {
      method: 'POST',
      headers: cashierAuth,
      body: { method: 'cash', amount: null },
    });
    assertEqualOrThrow(paySplitA.status, 200, 'splitBillA paid in session 1');

    // ── 11. Close shift 1 and verify closed-shift refusal (409) ───────────
    const closeSession1 = await api(baseUrl, `/api/cash-sessions/${session1Id}/close`, {
      method: 'POST',
      headers: managerAuth,
      body: { counted_cash_cents: 13000 },
    });
    assertEqualOrThrow(closeSession1.status, 200, 'cash session 1 closed');

    const closedShiftAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      closedShiftAttempt.status,
      409,
      'correcting a payment from a closed shift returns 409',
    );
    assertEqualOrThrow(
      closedShiftAttempt.data.reason,
      'shift_closed',
      'closed shift refusal includes reason = shift_closed',
    );
    const unchangedBill1 = await api(baseUrl, `/api/bills/${bill1.id}`, { headers: cashierAuth });
    assertEqualOrThrow(
      unchangedBill1.data.bill.payment_details[0].method,
      'card',
      'closed shift refusal leaves bill1 payment method unchanged',
    );

    // Replaying an already-committed Idempotency-Key after shift close still returns cached 200
    const idemReplayAfterShiftClose = await api(
      baseUrl,
      `/api/bills/${bill1.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: { ...managerAuth, 'Idempotency-Key': idemKey1 },
        body: {
          method: 'card',
          transaction_id: 'TX-CARD-101',
          reason: 'Customer tapped card instead of cash',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      idemReplayAfterShiftClose.status,
      200,
      'Idempotency-Key replay after shift close returns cached 200',
    );
    assertEqualOrThrow(
      idemReplayAfterShiftClose.data.idempotentReplay,
      true,
      'Idempotency-Key replay after shift close sets idempotentReplay = true',
    );

    // ── 12. Open shift 2, pay splitBillB, and verify split-sibling guard ──
    const openSession2Res = await api(baseUrl, '/api/cash-sessions/open', {
      method: 'POST',
      headers: managerAuth,
      body: { opening_float_cents: 2000 },
    });
    assertEqualOrThrow(openSession2Res.status, 200, 'cash session 2 opened');

    // Multi-line natural replay scopes audit to (bill_id, payment_index)
    const multiLineOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: cashierAuth,
      body: { type: 'takeaway', items: [{ product_id: 'prod-80', quantity: 1 }] },
    });
    assertEqualOrThrow(multiLineOrderRes.status, 201, 'multi-line order created');
    const multiLineBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: cashierAuth,
      body: { order_id: multiLineOrderRes.data.order.id },
    });
    assertEqualOrThrow(multiLineBillRes.status, 201, 'multi-line bill generated');
    const multiLinePayRes = await api(
      baseUrl,
      `/api/bills/${multiLineBillRes.data.bill.id}/payments`,
      {
        method: 'POST',
        headers: cashierAuth,
        body: {
          payments: [
            { method: 'cash', amount: 50 },
            { method: 'card', amount: 30, transaction_id: 'TX-MULTI-LINE-1' },
          ],
        },
      },
    );
    assertEqualOrThrow(multiLinePayRes.status, 200, 'multi-line bill paid with 2 lines');
    const multiLineBillId = multiLinePayRes.data.bill.id;

    const correctLine0Res = await api(baseUrl, `/api/bills/${multiLineBillId}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'card',
        transaction_id: 'TX-MULTI-LINE-0',
        reason: 'Line 0 was card',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(correctLine0Res.status, 200, 'line 0 corrected to card');

    const replayLine1Res = await api(baseUrl, `/api/bills/${multiLineBillId}/payments/1/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'card',
        transaction_id: 'TX-MULTI-LINE-1',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(replayLine1Res.status, 200, 'no-op replay on line 1 returns 200');
    assertEqualOrThrow(
      replayLine1Res.data.idempotentReplay,
      true,
      'no-op replay on line 1 sets idempotentReplay = true',
    );
    assertEqualOrThrow(
      replayLine1Res.data.audit,
      null,
      'no-op replay on uncorrected line 1 returns audit = null instead of line 0 audit',
    );

    const replayLine0Res = await api(baseUrl, `/api/bills/${multiLineBillId}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'card',
        transaction_id: 'TX-MULTI-LINE-0',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(replayLine0Res.status, 200, 'no-op replay on line 0 returns 200');
    assertEqualOrThrow(
      replayLine0Res.data.audit?.payment_index,
      0,
      'no-op replay on line 0 returns line 0 audit record',
    );

    const paySplitB = await api(baseUrl, `/api/bills/${splitBillB.id}/payment`, {
      method: 'POST',
      headers: cashierAuth,
      body: { method: 'cash', amount: null },
    });
    assertEqualOrThrow(paySplitB.status, 200, 'splitBillB paid in session 2');

    // Attempting to correct splitBillB when sibling splitBillA was settled in closed session 1 -> 409
    const splitSiblingClosedShiftAttempt = await api(
      baseUrl,
      `/api/bills/${splitBillB.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: managerAuth,
        body: {
          method: 'card',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      splitSiblingClosedShiftAttempt.status,
      409,
      'correcting split check when sibling was settled in a closed shift returns 409',
    );

    // ── 12b. Per-staff shifts (one_shift_per_staff = true): manager correcting Staff B payment keeps it in Staff B shift ─
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('one_shift_per_staff', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'",
    ).run();
    const cashierBId = 'cashier-b-1337';
    db.prepare(
      `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
       VALUES (?, 'Cashier B', 'cashier-b@test.local', ?, 'cashier', ?, 1, ?, ?)`,
    ).run(
      cashierBId,
      bcrypt.hashSync('password123', 10),
      bcrypt.hashSync('6666', 10),
      now(),
      now(),
    );
    const cashierBAuth = {
      Authorization: `Bearer ${jwt.sign(
        { userId: cashierBId, email: 'cashier-b@test.local', role: 'cashier' },
        getJWTSecret(),
        { expiresIn: '1h' },
      )}`,
    };
    const openShiftARes = await api(baseUrl, '/api/cash-sessions/open', {
      method: 'POST',
      body: { opening_float_cents: 3000 },
      headers: cashierAuth,
    });
    assertEqualOrThrow(openShiftARes.status, 200, 'Staff A opens own cash shift (200)');
    const shiftAId = openShiftARes.data.id;

    const openShiftBRes = await api(baseUrl, '/api/cash-sessions/open', {
      method: 'POST',
      body: { opening_float_cents: 4000 },
      headers: cashierBAuth,
    });
    assertEqualOrThrow(openShiftBRes.status, 200, 'Staff B opens own cash shift (200)');
    const shiftBId = openShiftBRes.data.id;

    const { bill: staffBBill } = await createPaidBill('prod-80', 'cash', {}, cashierBAuth);
    assertEqualOrThrow(
      staffBBill.payment_details[0].cash_session_id,
      shiftBId,
      'Staff B cash payment is attributed to Staff B open shift',
    );

    const curShiftBBefore = await api(baseUrl, '/api/cash-sessions/current', {
      headers: cashierBAuth,
    });
    const curShiftMgrBefore = await api(baseUrl, '/api/cash-sessions/current', {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      curShiftBBefore.data.expected_cash_cents,
      12000,
      'Staff B shift expected cash is 4000 float + 8000 sale = 12000 before correction',
    );

    const mgrCorrectsStaffBBill = await api(
      baseUrl,
      `/api/bills/${staffBBill.id}/payments/0/method`,
      {
        method: 'PATCH',
        headers: managerAuth,
        body: {
          method: 'card',
          transaction_id: 'TX-STAFF-B-CARD',
          reason: 'Manager correcting Staff B payment method',
          approver_id: managerId,
          override_pin: '1234',
        },
      },
    );
    assertEqualOrThrow(
      mgrCorrectsStaffBBill.status,
      200,
      'manager corrects Staff B cash payment to card while Staff A, Staff B, and manager shifts are open (200)',
    );
    assertEqualOrThrow(
      mgrCorrectsStaffBBill.data.bill.payment_details[0].cash_session_id,
      shiftBId,
      'corrected payment stays in Staff B shift and does not move to manager shift',
    );
    const curShiftAAfter = await api(baseUrl, '/api/cash-sessions/current', {
      headers: cashierAuth,
    });
    const curShiftBAfter = await api(baseUrl, '/api/cash-sessions/current', {
      headers: cashierBAuth,
    });
    const curShiftMgrAfter = await api(baseUrl, '/api/cash-sessions/current', {
      headers: managerAuth,
    });
    assertEqualOrThrow(
      curShiftBAfter.data.expected_cash_cents,
      4000,
      'Staff B shift expected cash drops to 4000 (float only) after cash -> card correction',
    );
    assertEqualOrThrow(
      curShiftAAfter.data.expected_cash_cents,
      3000,
      'Staff A shift expected cash remains untouched at 3000',
    );
    assertEqualOrThrow(
      curShiftMgrAfter.data.expected_cash_cents,
      curShiftMgrBefore.data.expected_cash_cents,
      'Manager shift expected cash remains untouched',
    );
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'one_shift_per_staff'").run();
    db.prepare('DELETE FROM cash_sessions WHERE id IN (?, ?)').run(shiftAId, shiftBId);

    // ── 13. Closed business day refusal (409) ─────────────────────────────
    const { bill: bill3 } = await createPaidBill('prod-80', 'cash');
    const businessDate = (
      db.prepare("SELECT strftime('%Y-%m-%d', 'now') AS d").get() as { d: string }
    ).d;
    db.prepare(
      `INSERT INTO cash_closures (
        business_date, scope, period_start, period_end,
        opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents,
        gross_collected_cents, refunded_cents, net_collected_cents,
        bill_count, refund_count, payment_methods_json, staff_sales_json,
        tax_components_json, pay_in_cents, pay_out_cents, safe_drop_cents,
        cash_movements_json, z_number, closed_by, notes, created_at
      ) VALUES (?, 'day', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, '[]', '[]', '[]', 0, 0, 0, '[]', 999, ?, null, ?)`,
    ).run(businessDate, now(), now(), ownerId, now());

    const closedDayAttempt = await api(baseUrl, `/api/bills/${bill3.id}/payments/0/method`, {
      method: 'PATCH',
      headers: managerAuth,
      body: {
        method: 'card',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(
      closedDayAttempt.status,
      409,
      'correcting a payment on a closed business day returns 409',
    );
    assertEqualOrThrow(
      closedDayAttempt.data.reason,
      'day_closed',
      'closed day refusal includes reason = day_closed',
    );

    // ── 14. Frontend OrderDetailPanel restricts button visibility to owner/manager ─
    {
      const rootDir = path.resolve(__dirname, '..');
      const frontendRequire = Module.createRequire(path.join(rootDir, 'frontend/package.json'));
      const zustandPath = frontendRequire.resolve('zustand');
      const resolveFrontendPackage = (reqName: string): string | null => {
        if (reqName.startsWith('.') || path.isAbsolute(reqName) || reqName.startsWith('node:'))
          return null;
        try {
          return frontendRequire.resolve(reqName);
        } catch {
          return null;
        }
      };
      const origResolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (
        reqName: string,
        parent: unknown,
        isMain: boolean,
        options?: unknown,
      ) {
        const resolvedRequest =
          reqName === 'zustand'
            ? zustandPath
            : reqName === '@countries'
              ? path.resolve(rootDir, 'main/countries.ts')
              : reqName.startsWith('@/')
                ? path.resolve(rootDir, 'frontend/src', reqName.slice(2))
                : reqName.startsWith('@print/')
                  ? path.resolve(rootDir, 'shared/print', reqName.slice('@print/'.length))
                  : reqName.startsWith('@shared/')
                    ? path.resolve(rootDir, 'shared', reqName.slice('@shared/'.length))
                    : (resolveFrontendPackage(reqName) ?? reqName);
        return origResolveFilename.call(this, resolvedRequest, parent, isMain, options);
      };
      try {
        const React = frontendRequire('react');
        const ReactDOMServer = frontendRequire('react-dom/server');
        const { IntlProvider } = frontendRequire('use-intl');
        const messages = require('../frontend/src/lib/i18n/messages/en.json');
        const { useAuthStore } = require('../frontend/src/store/auth');
        const { OrderDetailPanel } = require('../frontend/src/components/orders/OrderDetailPanel');

        const renderPanel = (role: string) => {
          useAuthStore.setState({
            currentTenant: {
              id: 1,
              business_name: 'Flo Test',
              slug: 'flo-test',
              database_name: 'flo',
              business_type: 'restaurant',
              country: 'US',
              currency: 'USD',
              timezone: 'UTC',
              plan: 'free',
              status: 'active',
              role,
            },
          });
          const paidBillFixture = {
            id: 501,
            bill_number: 'BILL-501',
            order_id: 701,
            subtotal: 100,
            discount_amount: 0,
            tax_amount: 0,
            total: 100,
            paid_amount: 100,
            balance: 0,
            payment_status: 'paid',
            payment_details: [{ method: 'cash', amount: 100, cash_session_id: 1 }],
          };
          const orderFixture = {
            id: 701,
            order_number: 'ORD-701',
            type: 'takeaway',
            status: 'completed',
            created_at: '2026-10-28 12:00:00',
            items: [],
            subtotal: 100,
            discount_amount: 0,
            tax_amount: 0,
            total: 100,
            delivery_charge: 0,
            service_charge: 0,
            packaging_charge: 0,
            charges_breakdown: null,
            bill: paidBillFixture,
            bills: [paidBillFixture],
          };
          return ReactDOMServer.renderToStaticMarkup(
            React.createElement(
              IntlProvider,
              { locale: 'en', messages, onError: () => {} },
              React.createElement(OrderDetailPanel, {
                order: orderFixture,
                now: Date.now(),
                canCancelItems: false,
                canRestoreItems: false,
                canRefund: false,
                isWhatsAppReady: false,
                printHistory: {},
                generatingBillId: null,
                printingBillId: null,
                sendingWaOrderId: null,
                cancellingOrderId: null,
                convertingOrderId: null,
                onCheckout: () => {},
                onAddItems: () => {},
                onRefund: () => {},
                onCorrectPaymentMethod: () => {},
                onConvertToTakeaway: () => {},
                onCancelOrder: () => {},
                onPrint: () => {},
                onSendWhatsApp: () => {},
                onLinkCustomer: () => {},
                onCreateNewOrderForCustomer: () => {},
              }),
            ),
          );
        };

        assertOrThrow(
          renderPanel('owner').includes('data-testid="correct-payment-method-button"'),
          'OrderDetailPanel shows Correct Payment Method button for owner role',
        );
        assertOrThrow(
          renderPanel('manager').includes('data-testid="correct-payment-method-button"'),
          'OrderDetailPanel shows Correct Payment Method button for manager role',
        );
        assertOrThrow(
          !renderPanel('cashier').includes('data-testid="correct-payment-method-button"'),
          'OrderDetailPanel hides Correct Payment Method button for cashier role',
        );
        assertOrThrow(
          !renderPanel('server').includes('data-testid="correct-payment-method-button"'),
          'OrderDetailPanel hides Correct Payment Method button for server role',
        );
        assertOrThrow(
          !renderPanel('chef').includes('data-testid="correct-payment-method-button"'),
          'OrderDetailPanel hides Correct Payment Method button for chef role',
        );
      } finally {
        Module._resolveFilename = origResolveFilename;
      }
    }
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\nPayment method correction tests: ${results.passed}/${results.total} passed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
