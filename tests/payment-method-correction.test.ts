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
    // ── 1. Open a cash shift (opening float $50 = 5000 cents) ─────────────
    const openSessionRes = await api(baseUrl, '/api/cash-sessions/open', {
      method: 'POST',
      body: { opening_float_cents: 5000 },
      headers: managerAuth,
    });
    assertEqualOrThrow(openSessionRes.status, 200, 'open cash session succeeds');
    const session1Id = openSessionRes.data.id;

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

    // ── 3. PIN & Role Authorization Checks ────────────────────────────────
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

    const cashierOwnPinWithId = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        approver_id: cashierId,
        override_pin: '5555',
      },
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      cashierOwnPinWithId.status,
      403,
      'cashier own PIN with cashier approver_id is rejected with 403',
    );

    const cashierOwnPinWithoutId = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        override_pin: '5555',
      },
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      cashierOwnPinWithoutId.status,
      403,
      'cashier own PIN without approver_id is rejected with 403',
    );

    const inactiveManagerAttempt = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      body: {
        method: 'card',
        approver_id: inactiveManagerId,
        override_pin: '7777',
      },
      headers: cashierAuth,
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
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      wrongManagerPinAttempt.status,
      403,
      'wrong manager PIN is rejected with 403',
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
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      immutableAmountAttempt.status,
      400,
      'attempting to change the payment amount is rejected with 400',
    );

    // ── 4. Valid Cash -> Card correction by cashier with manager PIN ──────
    const idemKey1 = 'idem-correct-1337-1';
    const correctToCard = await api(baseUrl, `/api/bills/${bill1.id}/payments/0/method`, {
      method: 'PATCH',
      headers: { ...cashierAuth, 'Idempotency-Key': idemKey1 },
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
      'cashier with valid manager PIN corrects cash -> card (200)',
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
      cashierId,
      'audit row records cashier as actor_user_id',
    );
    const auditDetails1 = JSON.parse(auditRows1[0].details_json);
    assertEqualOrThrow(auditDetails1.old_method, 'cash', 'audit details record old_method = cash');
    assertEqualOrThrow(auditDetails1.new_method, 'card', 'audit details record new_method = card');
    assertEqualOrThrow(
      auditDetails1.actor_id,
      cashierId,
      'audit details record actor_id = cashierId',
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
      headers: { ...cashierAuth, 'Idempotency-Key': idemKey1 },
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
      headers: cashierAuth,
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
      headers: { ...cashierAuth, 'Idempotency-Key': idemKey1 },
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
      headers: cashierAuth,
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
      'owner PIN authorizes card -> cash correction (200)',
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
      headers: cashierAuth,
      body: {
        method: 'unknown-tender-xyz',
        approver_id: managerId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(unknownMethodRes.status, 400, 'unknown payment method is rejected with 400');

    const walletSwapRes = await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: cashierAuth,
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
      headers: cashierAuth,
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
      headers: cashierAuth,
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
    await api(baseUrl, `/api/bills/${bill2.id}/payments/0/method`, {
      method: 'PATCH',
      headers: cashierAuth,
      body: {
        method: 'cash',
        approver_id: managerId,
        override_pin: '1234',
      },
    });

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
        headers: cashierAuth,
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
      headers: cashierAuth,
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

    // ── 12. Open shift 2, pay splitBillB, and verify split-sibling guard ──
    const openSession2Res = await api(baseUrl, '/api/cash-sessions/open', {
      method: 'POST',
      headers: managerAuth,
      body: { opening_float_cents: 2000 },
    });
    assertEqualOrThrow(openSession2Res.status, 200, 'cash session 2 opened');

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
        headers: cashierAuth,
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
      headers: cashierAuth,
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
