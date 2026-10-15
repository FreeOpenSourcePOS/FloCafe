/**
 * Regression coverage for order-status and manager-PIN authorization.
 * Run: npm run test:orders-authz
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-orders-authz-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-orders-authz';

const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  startServer,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    id,
    email,
    bcrypt.hashSync('testpass123', 10),
    role,
    pin ? bcrypt.hashSync(pin, 10) : null,
    now(),
    now(),
  );
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

function seedOrderWithItem(db: any, suffix: string, ownerId?: string) {
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, user_id, created_at, updated_at)
    VALUES (?, 'takeaway', 'pending', 100, 100, ?, ?, ?)`).run(
    `ORD-AUTHZ-${suffix}`,
    ownerId || null,
    now(),
    now(),
  );
  const orderId = (
    db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-AUTHZ-${suffix}`) as any
  ).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'authz-product', 'Authz item', 100, 1, 100, 0, 100, 'preparing', ?, ?)`).run(
    orderId,
    now(),
    now(),
  );
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any)
    .id;
  return { orderId, itemId };
}

async function main() {
  const db = initTestDb();
  const managerAuth = seedUser(db, 'manager-authz', 'manager', '1234');
  const ownerAuth = seedUser(db, 'owner-authz', 'owner', '5678');
  const cashierAuth = seedUser(db, 'cashier-authz', 'cashier', '9876');
  const waiterAuth = seedUser(db, 'server-authz', 'server');
  db.prepare(
    `INSERT INTO categories (id, name, sort_order) VALUES ('authz-category', 'Authz', 1)`,
  ).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('authz-product', 'authz-category', 'Authz item', 100, 1, 1)`).run();
  db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at)
    VALUES ('authz-printer', 'Authz Printer', 'network', '127.0.0.1', 9100, 1, '80mm', ?, ?)`).run(
    now(),
    now(),
  );

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ error: 'Authentication required' });
    try {
      req.user = jwt.verify(header.slice(7), getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });
  app.use('/api/orders', orderRoutes);
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    const statusOrder = seedOrderWithItem(db, 'STATUS', 'cashier-authz');
    const cashierStatus = await api(baseUrl, `/api/orders/${statusOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'preparing' },
      headers: cashierAuth,
    });
    assertEqual(cashierStatus.status, 200, 'cashier can advance an order to preparing');

    {
      const order = seedOrderWithItem(db, 'CASHIER-VOID', 'cashier-authz');
      const response = await api(
        baseUrl,
        `/api/orders/${order.orderId}/items/${order.itemId}/cancel`,
        {
          method: 'PATCH',
          body: { override_pin: '1234' },
          headers: cashierAuth,
        },
      );
      assertEqual(
        response.status,
        200,
        'cashier can void an in-progress item with a valid manager PIN',
      );
      assertEqual(
        (db.prepare('SELECT status FROM order_items WHERE id = ?').get(order.itemId) as any).status,
        'voided',
        'cashier void marks the original item voided',
      );
    }

    const ownerOrder = seedOrderWithItem(db, 'OWNER-PIN', 'owner-authz');
    const ownerVoid = await api(
      baseUrl,
      `/api/orders/${ownerOrder.orderId}/items/${ownerOrder.itemId}/cancel`,
      {
        method: 'PATCH',
        body: { override_pin: '5678' },
        headers: ownerAuth,
      },
    );
    assertEqual(ownerVoid.status, 200, 'owner PIN can authorize an in-progress item void');

    const cashierPinOrder = seedOrderWithItem(db, 'CASHIER-PIN', 'cashier-authz');
    const cashierPin = await api(
      baseUrl,
      `/api/orders/${cashierPinOrder.orderId}/items/${cashierPinOrder.itemId}/cancel`,
      {
        method: 'PATCH',
        body: { override_pin: '9876' },
        headers: cashierAuth,
      },
    );
    assertEqual(cashierPin.status, 403, 'cashier PIN cannot authorize an in-progress item void');

    // Orders are never ownership-gated (docs/reference/product-invariants.md).
    const waiterOwnOrder = seedOrderWithItem(db, 'WAITER-OWN', 'server-authz');
    const waiterCanAdvance = await api(baseUrl, `/api/orders/${waiterOwnOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'preparing' },
      headers: waiterAuth,
    });
    assertEqual(waiterCanAdvance.status, 200, 'server can advance any order, including their own');
    const otherOrder = seedOrderWithItem(db, 'WAITER-OTHER', 'cashier-authz');
    const waiterOtherStatus = await api(baseUrl, `/api/orders/${otherOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'cancelled', override_pin: '1234' },
      headers: waiterAuth,
    });
    assertEqual(
      waiterOtherStatus.status,
      200,
      'server can cancel an order created by another user, given a valid manager PIN',
    );
    const statusAuditRow = db
      .prepare(
        `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'status_changed' ORDER BY id DESC LIMIT 1`,
      )
      .get(otherOrder.orderId) as any;
    assertEqual(
      statusAuditRow?.actor_user_id,
      'server-authz',
      "audit log records the server as the actor, not the order's original creator",
    );
    assert(
      JSON.parse(statusAuditRow?.details_json || '{}').approved_by === 'manager-authz',
      'audit log records which manager PIN approved the cancellation',
    );

    const otherItemOrder = seedOrderWithItem(db, 'WAITER-OTHER-ITEM', 'cashier-authz');
    const waiterOtherItem = await api(
      baseUrl,
      `/api/orders/${otherItemOrder.orderId}/items/${otherItemOrder.itemId}/cancel`,
      {
        method: 'PATCH',
        body: { override_pin: '1234' },
        headers: waiterAuth,
      },
    );
    assertEqual(
      waiterOtherItem.status,
      200,
      'server can void an item on an order created by another user',
    );
    const itemAuditRow = db
      .prepare(
        `SELECT * FROM order_audit_log WHERE order_item_id = ? AND action = 'item_voided' ORDER BY id DESC LIMIT 1`,
      )
      .get(otherItemOrder.itemId) as any;
    assertEqual(
      itemAuditRow?.actor_user_id,
      'server-authz',
      'audit log records the server as the actor for a cross-user item void',
    );

    const waiterKotOtherOrder = seedOrderWithItem(db, 'WAITER-KOT-OTHER', 'cashier-authz');
    db.prepare(`UPDATE order_items SET status = 'ready' WHERE order_id = ?`).run(
      waiterKotOtherOrder.orderId,
    );
    const waiterKotOther = await api(baseUrl, '/api/printers/print-kot', {
      method: 'POST',
      body: { orderId: waiterKotOtherOrder.orderId },
      headers: waiterAuth,
    });
    assertEqual(
      waiterKotOther.status,
      200,
      'server can print-kot for an order created by another user',
    );

    const invalidPinOrder = seedOrderWithItem(db, 'INVALID-PIN', 'cashier-authz');
    const invalidPin = await api(
      baseUrl,
      `/api/orders/${invalidPinOrder.orderId}/items/${invalidPinOrder.itemId}/cancel`,
      {
        method: 'PATCH',
        body: { override_pin: '9999' },
        headers: cashierAuth,
      },
    );
    assertEqual(invalidPin.status, 403, 'cashier with an invalid manager PIN is denied');
    assert(
      String(invalidPin.data.error).includes('Invalid manager PIN'),
      'invalid PIN denial identifies the PIN, not the role',
    );

    // #1056: Unpaid order completion safeguards & explicit owner/manager PIN override
    resetPinRateLimitForTests();
    const unbilledOrder = seedOrderWithItem(db, 'UNBILLED-COMPLETE', 'owner-authz');
    db.prepare(`UPDATE orders SET status = 'served' WHERE id = ?`).run(unbilledOrder.orderId);
    db.prepare(`UPDATE order_items SET status = 'served' WHERE order_id = ?`).run(
      unbilledOrder.orderId,
    );

    const ownerUnbilledNoPin = await api(baseUrl, `/api/orders/${unbilledOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'completed' },
      headers: ownerAuth,
    });
    assertEqual(
      ownerUnbilledNoPin.status,
      400,
      'logged-in owner cannot complete an unbilled positive-total order without an explicit PIN',
    );
    assertEqual(
      (db.prepare('SELECT status FROM orders WHERE id = ?').get(unbilledOrder.orderId) as any)
        .status,
      'served',
      'unbilled order remains served when PIN is omitted',
    );

    const unpaidBilledOrder = seedOrderWithItem(db, 'UNPAID-BILL-COMPLETE', 'manager-authz');
    db.prepare(`UPDATE orders SET status = 'served' WHERE id = ?`).run(unpaidBilledOrder.orderId);
    db.prepare(`UPDATE order_items SET status = 'served' WHERE order_id = ?`).run(
      unpaidBilledOrder.orderId,
    );
    const unpaidBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: unpaidBilledOrder.orderId },
      headers: managerAuth,
    });
    assertEqual(unpaidBillRes.status, 201, 'generated bill for unpaid completion test');
    const unpaidBillId = unpaidBillRes.data.bill.id;

    const managerUnpaidNoPin = await api(
      baseUrl,
      `/api/orders/${unpaidBilledOrder.orderId}/status`,
      {
        method: 'PATCH',
        body: { status: 'completed' },
        headers: managerAuth,
      },
    );
    assertEqual(
      managerUnpaidNoPin.status,
      400,
      'logged-in manager cannot complete an order with an unpaid bill without an explicit PIN',
    );

    const cashierPinComplete = await api(
      baseUrl,
      `/api/orders/${unpaidBilledOrder.orderId}/status`,
      {
        method: 'PATCH',
        body: { status: 'completed', override_pin: '9876' },
        headers: cashierAuth,
      },
    );
    assertEqual(
      cashierPinComplete.status,
      403,
      'cashier PIN cannot authorize unpaid order completion',
    );

    // Inactive manager PIN must be rejected
    seedUser(db, 'inactive-mgr', 'manager', '4321');
    db.prepare(`UPDATE users SET is_active = 0 WHERE id = 'inactive-mgr'`).run();
    const inactiveMgrComplete = await api(
      baseUrl,
      `/api/orders/${unpaidBilledOrder.orderId}/status`,
      {
        method: 'PATCH',
        body: { status: 'completed', override_pin: '4321' },
        headers: cashierAuth,
      },
    );
    assertEqual(
      inactiveMgrComplete.status,
      403,
      'inactive manager PIN cannot authorize unpaid order completion',
    );

    // Manager lacking payments.take permission cannot authorize unpaid completion override
    db.prepare(
      `INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by, updated_at) VALUES ('manager', 'payments.take', 'deny', 'owner-authz', ?)`,
    ).run(now());
    try {
      const noPayPermComplete = await api(
        baseUrl,
        `/api/orders/${unpaidBilledOrder.orderId}/status`,
        {
          method: 'PATCH',
          body: { status: 'completed', override_pin: '1234' },
          headers: cashierAuth,
        },
      );
      assertEqual(
        noPayPermComplete.status,
        403,
        'manager without payments.take cannot approve unpaid completion',
      );
    } finally {
      db.prepare(
        `DELETE FROM role_permission_overrides WHERE role = 'manager' AND permission_id = 'payments.take'`,
      ).run();
    }

    // Rate limit after 5 failed PIN attempts on completion
    resetPinRateLimitForTests();
    for (let i = 1; i <= 5; i++) {
      const bad = await api(baseUrl, `/api/orders/${unpaidBilledOrder.orderId}/status`, {
        method: 'PATCH',
        body: { status: 'completed', override_pin: '0000' },
        headers: cashierAuth,
      });
      assertEqual(bad.status, 403, `failed completion PIN attempt ${i} returns 403`);
    }
    const rateLimitedComplete = await api(
      baseUrl,
      `/api/orders/${unpaidBilledOrder.orderId}/status`,
      {
        method: 'PATCH',
        body: { status: 'completed', override_pin: '1234' },
        headers: cashierAuth,
      },
    );
    assertEqual(
      rateLimitedComplete.status,
      429,
      '6th completion PIN attempt after 5 failures is rate-limited with 429',
    );
    assertEqual(
      (db.prepare('SELECT status FROM orders WHERE id = ?').get(unpaidBilledOrder.orderId) as any)
        .status,
      'served',
      'rate-limited attempt does not mutate order status',
    );

    resetPinRateLimitForTests();
    const validOverrideComplete = await api(
      baseUrl,
      `/api/orders/${unpaidBilledOrder.orderId}/status`,
      {
        method: 'PATCH',
        body: { status: 'completed', override_pin: '1234' },
        headers: cashierAuth,
      },
    );
    assertEqual(validOverrideComplete.status, 200, 'valid manager PIN overrides unpaid completion');
    const billAfterOverride = db
      .prepare(
        'SELECT payment_status, paid_amount, balance, payment_details FROM bills WHERE id = ?',
      )
      .get(unpaidBillId) as any;
    assertEqual(
      billAfterOverride.payment_status,
      'unpaid',
      'completion override does not mark unpaid bill as paid',
    );
    assertEqual(
      Number(billAfterOverride.paid_amount),
      0,
      'completion override does not manufacture paid_amount',
    );
    assert(
      Number(billAfterOverride.balance) > 0,
      'completion override preserves outstanding bill balance',
    );

    const completeAudits = db
      .prepare(`SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'status_changed'`)
      .all(unpaidBilledOrder.orderId) as any[];
    assertEqual(
      completeAudits.length,
      1,
      'valid completion override writes exactly one status_changed audit entry',
    );
    const completeAuditDetails = JSON.parse(completeAudits[0].details_json || '{}');
    assertEqual(
      completeAudits[0].actor_user_id,
      'cashier-authz',
      'completion audit records actor identity',
    );
    assertEqual(
      completeAuditDetails.approved_by,
      'manager-authz',
      'completion audit records approver identity',
    );
    assert(
      Array.isArray(completeAuditDetails.overridden_safeguards) &&
        completeAuditDetails.overridden_safeguards.includes('unsettled_payment'),
      'completion audit records unsettled_payment safeguard',
    );
    assert(
      Array.isArray(completeAuditDetails.bill_ids) &&
        completeAuditDetails.bill_ids.includes(unpaidBillId),
      'completion audit records bill IDs',
    );
    assert(
      Number(completeAuditDetails.outstanding_amount) > 0,
      'completion audit records outstanding amount',
    );
    assert(
      !String(completeAudits[0].details_json).includes('1234'),
      'completion audit never logs the PIN',
    );

    // Same-state retry on completed order is a harmless idempotent no-op without PIN
    const retryComplete = await api(baseUrl, `/api/orders/${unpaidBilledOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'completed' },
      headers: cashierAuth,
    });
    assertEqual(retryComplete.status, 200, 'same-state completed retry succeeds without PIN');
    const completeAuditsAfterRetry = db
      .prepare(`SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'status_changed'`)
      .all(unpaidBilledOrder.orderId) as any[];
    assertEqual(
      completeAuditsAfterRetry.length,
      1,
      'same-state retry does not record a duplicate audit entry',
    );

    // Ordinary settled completion succeeds without PIN when kitchen requirement is satisfied
    const settledOrder = seedOrderWithItem(db, 'SETTLED-COMPLETE', 'cashier-authz');
    db.prepare(`UPDATE orders SET status = 'served' WHERE id = ?`).run(settledOrder.orderId);
    db.prepare(`UPDATE order_items SET status = 'served' WHERE order_id = ?`).run(
      settledOrder.orderId,
    );
    const settledBillGen = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: settledOrder.orderId },
      headers: cashierAuth,
    });
    assertEqual(settledBillGen.status, 201, 'generated bill for settled completion test');
    const settledPay = await api(baseUrl, `/api/bills/${settledBillGen.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: settledBillGen.data.bill.total },
      headers: cashierAuth,
    });
    assertEqual(settledPay.status, 200, 'paid bill for settled completion test');
    db.prepare(`UPDATE orders SET status = 'served', completed_at = NULL WHERE id = ?`).run(
      settledOrder.orderId,
    );
    const settledComplete = await api(baseUrl, `/api/orders/${settledOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'completed' },
      headers: cashierAuth,
    });
    assertEqual(
      settledComplete.status,
      200,
      'settled order completes without requiring an override PIN',
    );

    // Kitchen delivery enforcement on completion when require_kitchen_delivered_before_settlement is enabled
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('require_kitchen_delivered_before_settlement', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(now());
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(now());
    try {
      const undeliveredPaidOrder = seedOrderWithItem(db, 'KITCHEN-BLOCK-COMPLETE', 'cashier-authz');
      const undeliveredBillGen = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        body: { order_id: undeliveredPaidOrder.orderId },
        headers: cashierAuth,
      });
      assertEqual(undeliveredBillGen.status, 201, 'generated bill for undelivered completion test');
      const undeliveredPay = await api(
        baseUrl,
        `/api/bills/${undeliveredBillGen.data.bill.id}/payment`,
        {
          method: 'POST',
          body: {
            method: 'cash',
            amount: undeliveredBillGen.data.bill.total,
            override_pin: '1234',
          },
          headers: cashierAuth,
        },
      );
      assertEqual(
        undeliveredPay.status,
        200,
        'paid bill with kitchen override for undelivered completion test',
      );
      db.prepare(`UPDATE orders SET status = 'preparing', completed_at = NULL WHERE id = ?`).run(
        undeliveredPaidOrder.orderId,
      );

      const blockedKitchenComplete = await api(
        baseUrl,
        `/api/orders/${undeliveredPaidOrder.orderId}/status`,
        {
          method: 'PATCH',
          body: { status: 'completed' },
          headers: ownerAuth,
        },
      );
      assertEqual(
        blockedKitchenComplete.status,
        400,
        'completion is blocked without PIN when kitchen delivery policy requires served items',
      );

      const overriddenKitchenComplete = await api(
        baseUrl,
        `/api/orders/${undeliveredPaidOrder.orderId}/status`,
        {
          method: 'PATCH',
          body: { status: 'completed', override_pin: '5678' },
          headers: cashierAuth,
        },
      );
      assertEqual(
        overriddenKitchenComplete.status,
        200,
        'owner PIN overrides kitchen-undelivered completion block',
      );
      const kitchenCompleteAudit = db
        .prepare(
          `SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'status_changed' ORDER BY id DESC LIMIT 1`,
        )
        .get(undeliveredPaidOrder.orderId) as any;
      const kitchenAuditDetails = JSON.parse(kitchenCompleteAudit?.details_json || '{}');
      assertEqual(
        kitchenAuditDetails.approved_by,
        'owner-authz',
        'kitchen completion override records owner approver',
      );
      assert(
        Array.isArray(kitchenAuditDetails.overridden_safeguards) &&
          kitchenAuditDetails.overridden_safeguards.includes('kitchen_undelivered'),
        'kitchen completion override records kitchen_undelivered safeguard',
      );
    } finally {
      db.prepare(
        `UPDATE settings SET value = 'false', updated_at = ? WHERE key = 'require_kitchen_delivered_before_settlement'`,
      ).run(now());
    }

    // Split checks: completion requires all payable checks to be settled and cover order total
    const splitOrder = seedOrderWithItem(db, 'SPLIT-COMPLETE', 'cashier-authz');
    db.prepare(`UPDATE orders SET status = 'served', subtotal = 200, total = 200 WHERE id = ?`).run(
      splitOrder.orderId,
    );
    db.prepare(
      `UPDATE order_items SET status = 'served', quantity = 2, subtotal = 200, total = 200 WHERE id = ?`,
    ).run(splitOrder.itemId);
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, split_group_id, subtotal, tax_amount, discount_amount, total, payment_status, paid_amount, balance, payment_details, created_at, updated_at)
       VALUES ('BILL-SPLIT-A', ?, 'sg-1', 100, 0, 0, 100, 'paid', 100, 0, ?, ?, ?)`,
    ).run(splitOrder.orderId, JSON.stringify([{ method: 'cash', amount: 100 }]), now(), now());
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, split_group_id, subtotal, tax_amount, discount_amount, total, payment_status, paid_amount, balance, payment_details, created_at, updated_at)
       VALUES ('BILL-SPLIT-B', ?, 'sg-1', 100, 0, 0, 100, 'unpaid', 0, 100, '[]', ?, ?)`,
    ).run(splitOrder.orderId, now(), now());

    const halfPaidSplitComplete = await api(baseUrl, `/api/orders/${splitOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'completed' },
      headers: ownerAuth,
    });
    assertEqual(
      halfPaidSplitComplete.status,
      400,
      'split-check order with an unpaid check cannot complete without PIN',
    );

    db.prepare(
      `UPDATE bills SET payment_status = 'paid', paid_amount = 100, balance = 0, payment_details = ? WHERE bill_number = 'BILL-SPLIT-B'`,
    ).run(JSON.stringify([{ method: 'card', amount: 100 }]));
    const fullPaidSplitComplete = await api(baseUrl, `/api/orders/${splitOrder.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'completed' },
      headers: cashierAuth,
    });
    assertEqual(
      fullPaidSplitComplete.status,
      200,
      'split-check order completes without PIN once all payable checks are settled',
    );
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) process.exit(1);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
