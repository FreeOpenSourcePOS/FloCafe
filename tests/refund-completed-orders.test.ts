/**
 * Refunds on already-completed orders: business-day approval tiers, expanded
 * item eligibility, and store-credit refunds (docs/reference/product-invariants.md).
 *
 * Kept separate from tests/refunds.test.ts because that file's PIN
 * rate-limit budget is deliberately tuned to exactly 5 attempts; adding more
 * PIN-reaching calls there would perturb its throttling assertion.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-refund-completed-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  seedCustomer,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { customerRoutes } = require('../main/routes/customers');
const { settingsRoutes } = require('../main/routes/settings');
const { getJWTSecret } = require('../main/routes/auth');

async function main() {
  console.log('Refunds on completed orders: business-day tiers, item eligibility, store credit');
  const db = initTestDb();
  db.prepare("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'").run();
  if (
    (db.prepare("SELECT COUNT(*) as c FROM settings WHERE key = 'timezone'").get() as any).c === 0
  ) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('timezone', 'UTC')").run();
  }
  const { userId: ownerId, authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  const cashierId = 'cashier-refund-co';
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cashierId,
    'Test Cashier',
    'cashier@test.local',
    bcrypt.hashSync('testpass123', 10),
    'cashier',
    1,
    now(),
    now(),
  );
  const cashierAuth = {
    Authorization: `Bearer ${jwt.sign({ userId: cashierId, email: 'cashier@test.local', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
  // seedOwnerUser doesn't set a PIN by default — completed-order refunds need one to approve.
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
    bcrypt.hashSync('9999', 10),
    ownerId,
  );
  seedCategory(db, 'cat-refund-co', 'Refund menu (completed orders)');
  seedProduct(db, 'prod-refund-co', 'cat-refund-co', 'Refund item', 100);
  seedCustomer(db, 'cust-refund-co', 'Refund Customer', '+10000000099');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/customers': customerRoutes,
    '/api/settings': settingsRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // Freeze the clock so business-day fixtures can't flake near a real day boundary.
  const originalDateNow = Date.now;
  const FIXED_NOW = Date.UTC(2025, 5, 15, 12, 0, 0);
  Date.now = () => FIXED_NOW;

  async function newPaidBill(productId: string, quantity = 1, headers = ownerAuth) {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: productId, quantity }] },
      headers,
    });
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.data.order.id },
      headers,
    });
    const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: null },
      headers,
    });
    return { order: order.data.order, bill: paid.data.bill };
  }

  try {
    // ── Same business day, past the 1-hour window: manager PIN insufficient ──
    const lateBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 10:30:00' WHERE id = ?").run(
      lateBill.order.id,
    );

    const managerAttempt = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: lateBill.bill.id,
        amount: lateBill.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        manager_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      managerAttempt.status,
      403,
      'a manager PIN cannot approve a refund once the 1-hour window has passed',
    );
    assertEqual(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM refunds WHERE bill_id = ?')
          .get(lateBill.bill.id) as any
      ).count,
      0,
      'the rejected late refund attempt does not create a refund row',
    );

    // ── Same bill, owner PIN: accepted, and recorded in the order audit log ──
    const ownerApproval = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: lateBill.bill.id,
        amount: lateBill.bill.paid_amount,
        method: 'cash',
        override_pin: '9999',
        approver_id: ownerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      ownerApproval.status,
      201,
      'an owner PIN can approve a refund after the 1-hour window, same business day',
    );
    assertEqual(
      ownerApproval.data.refund.approved_by,
      ownerId,
      'the owner is recorded as the approver',
    );
    assertEqual(
      ownerApproval.data.bill.payment_status,
      'refunded',
      'the late refund marks the bill refunded',
    );

    const auditRow = db
      .prepare(
        "SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'refund_issued' ORDER BY id DESC LIMIT 1",
      )
      .get(lateBill.order.id) as any;
    assert(!!auditRow, 'the late refund is recorded in order_audit_log');
    assertEqual(
      auditRow.actor_user_id,
      managerId,
      'the audit row attributes the refund to the initiating manager',
    );
    const auditDetails = JSON.parse(auditRow.details_json);
    assertEqual(auditDetails.lateRefund, true, 'the audit details flag this as a late refund');
    assertEqual(auditDetails.approvedBy, ownerId, 'the audit details record the owner as approver');

    // ── Prior business day: manager PIN rejected, owner PIN accepted (no age limit) ──
    const priorDayBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-13 12:00:00' WHERE id = ?").run(
      priorDayBill.order.id,
    );
    const priorDayManagerAttempt = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: priorDayBill.bill.id,
        amount: priorDayBill.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: ownerAuth,
    });
    assertEqual(
      priorDayManagerAttempt.status,
      403,
      'a manager PIN cannot refund an order from a prior business day',
    );

    const priorDayAttempt = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: priorDayBill.bill.id,
        amount: priorDayBill.bill.paid_amount,
        method: 'cash',
        override_pin: '9999',
        manager_id: ownerId,
      },
      headers: ownerAuth,
    });
    assertEqual(
      priorDayAttempt.status,
      201,
      'an owner PIN can refund an order from a prior business day',
    );
    assertEqual(
      priorDayAttempt.data.refund.approved_by,
      ownerId,
      'prior-day refund records the owner as approver',
    );

    // Backdated 1 year old order with an open cash session attaches to the current open session
    const sessionInsert = db
      .prepare(
        "INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status) VALUES (?, 'Test Owner', '2025-06-15 08:00:00', 10000, 'open')",
      )
      .run(ownerId);
    const openSessionId = Number(sessionInsert.lastInsertRowid);
    const yearOldBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2024-06-15 12:00:00' WHERE id = ?").run(
      yearOldBill.order.id,
    );
    const yearOldRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: yearOldBill.bill.id,
        amount: yearOldBill.bill.paid_amount,
        method: 'cash',
        override_pin: '9999',
        approver_id: ownerId,
      },
      headers: ownerAuth,
    });
    assertEqual(yearOldRefund.status, 201, 'an owner PIN can refund a 1-year-old order');
    const yearOldRefundRow = db
      .prepare('SELECT * FROM refunds WHERE id = ?')
      .get(yearOldRefund.data.refund.id) as any;
    assertEqual(
      yearOldRefundRow.cash_session_id,
      openSessionId,
      'a backdated cash refund attaches to the current open cash session',
    );

    // ── Refund policy settings endpoints & configurable manager windows ──────
    const defaultPolicy = await api(baseUrl, '/api/settings/refunds', { headers: cashierAuth });
    assertEqual(defaultPolicy.status, 200, 'authenticated staff can read /api/settings/refunds');
    assertEqual(
      defaultPolicy.data.refund_manager_enabled,
      true,
      'refund_manager_enabled defaults to true',
    );
    assertEqual(
      defaultPolicy.data.refund_manager_window,
      '1h',
      'refund_manager_window defaults to 1h',
    );

    const managerWriteAttempt = await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_enabled: false },
      headers: managerAuth,
    });
    assertEqual(managerWriteAttempt.status, 403, 'a manager cannot update /api/settings/refunds');

    const invalidWindowAttempt = await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_window: '10h' },
      headers: ownerAuth,
    });
    assertEqual(
      invalidWindowAttempt.status,
      400,
      'invalid refund_manager_window is rejected with 400',
    );

    // Toggling refund_manager_enabled to false requires Owner PIN even within 5 minutes
    const disableManagerRes = await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_enabled: false },
      headers: ownerAuth,
    });
    assertEqual(disableManagerRes.status, 200, 'owner can disable manager refund approvals');
    assertEqual(
      disableManagerRes.data.refund_manager_enabled,
      false,
      'response reflects refund_manager_enabled = false',
    );

    resetPinRateLimitForTests();
    const freshBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 11:55:00' WHERE id = ?").run(
      freshBill.order.id,
    );
    const managerWhenDisabled = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: freshBill.bill.id,
        amount: freshBill.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      managerWhenDisabled.status,
      403,
      'manager PIN is rejected even within 5 minutes when refund_manager_enabled is false',
    );
    const ownerWhenDisabled = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: freshBill.bill.id,
        amount: freshBill.bill.paid_amount,
        method: 'cash',
        override_pin: '9999',
        approver_id: ownerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      ownerWhenDisabled.status,
      201,
      'owner PIN succeeds when refund_manager_enabled is false',
    );

    // Window: 30m
    await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_enabled: true, refund_manager_window: '30m' },
      headers: ownerAuth,
    });
    resetPinRateLimitForTests();
    const bill20m = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 11:40:00' WHERE id = ?").run(
      bill20m.order.id,
    );
    const manager20m = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: bill20m.bill.id,
        amount: bill20m.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(manager20m.status, 201, '30m window allows manager PIN at 20 minutes');

    const bill40m = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 11:20:00' WHERE id = ?").run(
      bill40m.order.id,
    );
    const manager40m = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: bill40m.bill.id,
        amount: bill40m.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(manager40m.status, 403, '30m window rejects manager PIN at 40 minutes');

    // Window: 2h
    await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_window: '2h' },
      headers: ownerAuth,
    });
    resetPinRateLimitForTests();
    const bill90m = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 10:30:00' WHERE id = ?").run(
      bill90m.order.id,
    );
    const manager90m = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: bill90m.bill.id,
        amount: bill90m.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(manager90m.status, 201, '2h window allows manager PIN at 90 minutes');

    const bill150m = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 09:30:00' WHERE id = ?").run(
      bill150m.order.id,
    );
    const manager150m = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: bill150m.bill.id,
        amount: bill150m.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(manager150m.status, 403, '2h window rejects manager PIN at 150 minutes');

    // Window: 4h (including across business-day boundary check)
    await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_window: '4h' },
      headers: ownerAuth,
    });
    resetPinRateLimitForTests();
    const bill3h = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 09:00:00' WHERE id = ?").run(
      bill3h.order.id,
    );
    const manager3h = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: bill3h.bill.id,
        amount: bill3h.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      manager3h.status,
      201,
      '4h window allows manager PIN at 3 hours on same business day',
    );

    // Move clock to 01:00 UTC on 2025-06-15; an order at 23:00 UTC on 2025-06-14 is only 2h old,
    // but its business day (2025-06-14) has ended, so manager PIN must be rejected.
    Date.now = () => Date.UTC(2025, 5, 15, 1, 0, 0);
    const crossDayBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-14 23:00:00' WHERE id = ?").run(
      crossDayBill.order.id,
    );
    const crossDayManager = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: crossDayBill.bill.id,
        amount: crossDayBill.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      crossDayManager.status,
      403,
      '4h window across business-day close still requires owner PIN',
    );
    Date.now = () => FIXED_NOW;

    // Window: same_business_day
    await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_window: 'same_business_day' },
      headers: ownerAuth,
    });
    resetPinRateLimitForTests();
    const bill10hSameDay = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 02:00:00' WHERE id = ?").run(
      bill10hSameDay.order.id,
    );
    const manager10hSameDay = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: bill10hSameDay.bill.id,
        amount: bill10hSameDay.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqual(
      manager10hSameDay.status,
      201,
      'same_business_day window allows manager PIN 10 hours later on the same business day',
    );

    // Cashier with refunds.initiate granted can initiate, still subject to manager/owner approval tier
    db.prepare(
      "INSERT OR REPLACE INTO role_permission_overrides (role, permission_id, effect, updated_by, updated_at) VALUES ('cashier', 'refunds.initiate', 'allow', ?, ?)",
    ).run(ownerId, now());
    await api(baseUrl, '/api/settings/refunds', {
      method: 'PUT',
      body: { refund_manager_enabled: true, refund_manager_window: '1h' },
      headers: ownerAuth,
    });
    resetPinRateLimitForTests();
    const cashierInWindowBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 11:30:00' WHERE id = ?").run(
      cashierInWindowBill.order.id,
    );
    const cashierWithManagerPin = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: cashierInWindowBill.bill.id,
        amount: cashierInWindowBill.bill.paid_amount,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: cashierAuth,
    });
    assertEqual(
      cashierWithManagerPin.status,
      201,
      'cashier with refunds.initiate can initiate an in-window refund with manager PIN',
    );
    db.prepare(
      "DELETE FROM role_permission_overrides WHERE role = 'cashier' AND permission_id = 'refunds.initiate'",
    ).run();
    resetPinRateLimitForTests();

    // ── A completed item is refundable once the order is past the short window ──
    const itemBill = await newPaidBill('prod-refund-co');
    const itemRow = db
      .prepare('SELECT * FROM order_items WHERE order_id = ?')
      .get(itemBill.order.id) as any;
    db.prepare("UPDATE order_items SET status = 'completed' WHERE id = ?").run(itemRow.id);
    db.prepare("UPDATE orders SET created_at = '2025-06-15 10:30:00' WHERE id = ?").run(
      itemBill.order.id,
    );
    const completedItemRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: itemBill.bill.id,
        order_item_id: itemRow.id,
        method: 'cash',
        override_pin: '9999',
        manager_id: ownerId,
      },
      headers: ownerAuth,
    });
    assertEqual(
      completedItemRefund.status,
      201,
      'a completed item is refundable once the order is past the in-progress window',
    );

    // ── Store-credit refund ─────────────────────────────────────────────────
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)",
    ).run(now());

    const creditBill = await newPaidBill('prod-refund-co');
    db.prepare('UPDATE bills SET customer_id = ? WHERE id = ?').run(
      'cust-refund-co',
      creditBill.bill.id,
    );
    const storeCreditRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: creditBill.bill.id,
        amount: creditBill.bill.paid_amount,
        method: 'wallet',
        override_pin: '9999',
        manager_id: ownerId,
      },
      headers: ownerAuth,
    });
    assertEqual(
      storeCreditRefund.status,
      201,
      'a store-credit refund is accepted for a bill with a customer',
    );
    const ledgerRow = db
      .prepare(
        "SELECT * FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit' ORDER BY id DESC LIMIT 1",
      )
      .get(creditBill.bill.id) as any;
    assert(!!ledgerRow, 'the store-credit refund creates a loyalty_ledger credit entry');
    assertEqual(
      Number(ledgerRow.amount),
      Number(creditBill.bill.paid_amount),
      'the credited amount matches the refunded amount',
    );
    assertEqual(
      ledgerRow.customer_id,
      'cust-refund-co',
      'the credit is attributed to the bill customer',
    );

    const walletBalance = await api(baseUrl, '/api/customers/cust-refund-co/wallet', {
      headers: ownerAuth,
    });
    assertEqual(
      Number(walletBalance.data.balance),
      Number(creditBill.bill.paid_amount),
      'the customer wallet balance reflects the refund credit',
    );

    // ── Store credit requires a customer on the bill ─────────────────────────
    const noCustomerBill = await newPaidBill('prod-refund-co');
    const noCustomerCreditRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: noCustomerBill.bill.id,
        amount: noCustomerBill.bill.paid_amount,
        method: 'wallet',
        override_pin: '9999',
        manager_id: ownerId,
      },
      headers: ownerAuth,
    });
    assertEqual(
      noCustomerCreditRefund.status,
      400,
      'a store-credit refund without a bill customer is rejected',
    );

    // ── Store credit requires loyalty to be enabled ──────────────────────────
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'loyalty_enabled'").run();
    const loyaltyDisabledBill = await newPaidBill('prod-refund-co');
    db.prepare('UPDATE bills SET customer_id = ? WHERE id = ?').run(
      'cust-refund-co',
      loyaltyDisabledBill.bill.id,
    );
    const disabledCreditRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: loyaltyDisabledBill.bill.id,
        amount: loyaltyDisabledBill.bill.paid_amount,
        method: 'wallet',
        override_pin: '9999',
        manager_id: ownerId,
      },
      headers: ownerAuth,
    });
    assertEqual(
      disabledCreditRefund.status,
      400,
      'a store-credit refund is rejected when loyalty is disabled',
    );

    // ── RefundModal.submit() honors loaded refundPolicy and tenant timezone ──
    {
      const originalResolveFilename = Module._resolveFilename;
      const rootDir = path.join(__dirname, '..');
      Module._resolveFilename = function (
        request: string,
        parent: unknown,
        isMain: boolean,
        options?: unknown,
      ) {
        if (request.startsWith('@/')) {
          return originalResolveFilename.call(
            this,
            path.resolve(rootDir, 'frontend/src', request.slice(2)),
            parent,
            isMain,
            options,
          );
        }
        if (request === '@countries') {
          return originalResolveFilename.call(
            this,
            path.resolve(rootDir, 'main/countries.ts'),
            parent,
            isMain,
            options,
          );
        }
        if (request.startsWith('@shared/')) {
          return originalResolveFilename.call(
            this,
            path.resolve(rootDir, 'shared', request.slice('@shared/'.length)),
            parent,
            isMain,
            options,
          );
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
      };

      const states: any[] = [];
      const setters: Array<(next: any) => void> = [];
      const effectEntries: Array<{ deps?: any[]; initialized: boolean; cleanup?: any }> = [];
      const pendingEffects: Array<() => void> = [];
      let stateIdx = 0;
      let effectIdx = 0;

      const jsx = (type: any, props: any, key?: any) => ({ type, props, key });
      const createElement = (type: any, props: any, ...children: any[]) => ({
        type,
        props: {
          ...(props || {}),
          children:
            children.length === 0
              ? props?.children
              : children.length === 1
                ? children[0]
                : children,
        },
      });

      const reactMock = {
        createElement,
        Fragment: 'Fragment',
        useState: (initial: any) => {
          const idx = stateIdx++;
          if (idx >= states.length) {
            states.push(typeof initial === 'function' ? initial() : initial);
            setters.push((next: any) => {
              states[idx] = typeof next === 'function' ? next(states[idx]) : next;
            });
          }
          return [states[idx], setters[idx]];
        },
        useEffect: (effect: () => any, deps?: any[]) => {
          const idx = effectIdx++;
          const prev = effectEntries[idx];
          const changed =
            !prev ||
            !prev.initialized ||
            deps === undefined ||
            prev.deps === undefined ||
            deps.length !== prev.deps.length ||
            deps.some((d, i) => !Object.is(d, prev.deps![i]));
          if (!prev) effectEntries[idx] = { deps, initialized: false };
          else prev.deps = deps;
          if (changed) {
            pendingEffects.push(() => {
              if (typeof effectEntries[idx].cleanup === 'function') effectEntries[idx].cleanup();
              effectEntries[idx].cleanup = effect();
              effectEntries[idx].initialized = true;
            });
          }
        },
      };

      let mockPolicy = { refund_manager_enabled: true, refund_manager_window: '2h' };
      let mockTenant: any = {
        id: 't-1',
        country: 'US',
        currency: 'USD',
        timezone: 'America/New_York',
        business_day_start_time: '00:00',
        role: 'manager',
      };
      const postedRefunds: any[] = [];
      const ButtonStub = (props: any) => ({ type: 'ButtonStub', props });

      const modalMocks: Record<string, any> = {
        react: reactMock,
        'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
        clsx: { clsx: (...args: any[]) => args.filter(Boolean).join(' ') },
        'tailwind-merge': { twMerge: (s: string) => s },
        'next/link': { __esModule: true, default: (props: any) => ({ type: 'Link', props }) },
        'lucide-react': { Loader2: () => null },
        'use-intl': { useTranslations: () => (k: string) => k },
        'react-hot-toast': { __esModule: true, default: { success: () => {}, error: () => {} } },
        '@/components/ui/button': { Button: ButtonStub },
        '@/hooks/useCurrencyUnitAdapter': {
          useCurrencyUnitAdapter: () => ({
            toDisplay: (v: number) => v,
            toStored: (v: number) => v,
            formatInput: (v: number) => String(v),
          }),
        },
        '@/hooks/useFormatCurrency': { useFormatCurrency: () => (v: number) => `$${v}` },
        '@/lib/countries': {
          getCountryByCode: () => ({ currency: 'USD' }),
          getCurrencyMinorUnitFactor: () => 100,
        },
        '@/store/auth': {
          useAuthStore: () => ({
            user: { id: managerId, name: 'Test Manager', role: 'manager' },
            currentTenant: mockTenant,
          }),
        },
        '@/lib/api': {
          __esModule: true,
          default: {
            get: async (url: string) => {
              if (url === '/staff/approvers') {
                return {
                  data: {
                    approvers: [
                      { id: ownerId, name: 'Owner', role: 'owner', is_active: 1, has_pin: true },
                      {
                        id: managerId,
                        name: 'Manager',
                        role: 'manager',
                        is_active: 1,
                        has_pin: true,
                      },
                    ],
                  },
                };
              }
              if (url === '/settings/refunds') return { data: mockPolicy };
              if (url.startsWith('/bills/'))
                return { data: { bill: { id: 901, paid_amount: 50, order: { items: [] } } } };
              if (url === '/payment-methods') return { data: { payment_methods: [] } };
              if (url === '/settings/loyalty') return { data: { loyalty_enabled: false } };
              if (url === '/refunds') return { data: { refunds: [] } };
              return { data: {} };
            },
            post: async (url: string, body: any) => {
              if (url === '/refunds') {
                postedRefunds.push(body);
                return { data: { refund: { id: 1 } } };
              }
              return { data: {} };
            },
          },
        },
      };

      const prevLoad = Module._load;
      const prevGlobalReact = (globalThis as any).React;
      (globalThis as any).React = reactMock;
      Module._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request in modalMocks) return modalMocks[request];
        return prevLoad.call(this, request, parent, isMain);
      };

      function collectNodes(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
        if (Array.isArray(node)) {
          for (const child of node) collectNodes(child, pred, out);
          return out;
        }
        if (!node || typeof node !== 'object') return out;
        if (pred(node)) out.push(node);
        if (node.props?.children !== undefined) collectNodes(node.props.children, pred, out);
        return out;
      }

      try {
        const RefundModal = require('../frontend/src/components/orders/RefundModal').default;

        const runModalScenario = async (createdAtUtc: string) => {
          states.length = 0;
          setters.length = 0;
          effectEntries.length = 0;
          pendingEffects.length = 0;
          postedRefunds.length = 0;
          let refundedCount = 0;

          const modalProps = {
            order: {
              id: 500,
              order_number: 'ORD-500',
              created_at: createdAtUtc,
              release_status: 'released',
              items: [],
            },
            bills: [{ id: 901, bill_number: 'B-901', paid_amount: 50, payment_status: 'paid' }],
            onClose: () => {},
            onRefunded: () => {
              refundedCount += 1;
            },
          };

          const renderModal = () => {
            stateIdx = 0;
            effectIdx = 0;
            const tree = RefundModal(modalProps);
            while (pendingEffects.length > 0) {
              const fn = pendingEffects.shift()!;
              fn();
            }
            return tree;
          };

          renderModal();
          await new Promise((r) => setTimeout(r, 20));
          let tree = renderModal();

          const pinInput = collectNodes(tree, (n) => n.props?.id === 'refundPin')[0];
          pinInput.props.onChange({ target: { value: '1234' } });
          tree = renderModal();

          const submitBtn = collectNodes(
            tree,
            (n) =>
              n.type === ButtonStub &&
              (n.props?.children === 'refundSubmit' ||
                (Array.isArray(n.props?.children) && n.props.children.includes('refundSubmit'))),
          )[0];
          assert(
            submitBtn && !submitBtn.props.disabled,
            'RefundModal submit button is enabled for eligible manager',
          );
          await submitBtn.props.onClick();

          for (const entry of effectEntries) {
            if (typeof entry?.cleanup === 'function') entry.cleanup();
          }
          return { refundedCount, posted: [...postedRefunds] };
        };

        // Case 1: 2h window with a 90-minute-old order (past default 1h, within configured 2h)
        Date.now = () => Date.UTC(2025, 5, 15, 16, 0, 0);
        mockPolicy = { refund_manager_enabled: true, refund_manager_window: '2h' };
        const res2h = await runModalScenario('2025-06-15 14:30:00');
        assertEqual(
          res2h.posted.length,
          1,
          'RefundModal submits POST /refunds for manager at 90m under 2h policy',
        );
        assertEqual(
          res2h.posted[0]?.approver_id,
          managerId,
          'RefundModal submits manager approver_id under 2h policy',
        );
        assertEqual(
          res2h.refundedCount,
          1,
          'RefundModal invokes onRefunded callback under 2h policy',
        );

        // Case 2: same_business_day in America/New_York across 00:00 UTC (2025-06-15 22:30 UTC -> 2025-06-16 01:00 UTC, still 2025-06-15 EDT)
        Date.now = () => Date.UTC(2025, 5, 16, 1, 0, 0);
        mockPolicy = { refund_manager_enabled: true, refund_manager_window: 'same_business_day' };
        const resSameDayTz = await runModalScenario('2025-06-15 22:30:00');
        assertEqual(
          resSameDayTz.posted.length,
          1,
          'RefundModal submits POST /refunds for manager across UTC midnight when still same business day in store timezone',
        );
        assertEqual(
          resSameDayTz.posted[0]?.approver_id,
          managerId,
          'RefundModal keeps manager approver_id across UTC midnight',
        );
      } finally {
        (globalThis as any).React = prevGlobalReact;
        Module._load = prevLoad;
        Module._resolveFilename = originalResolveFilename;
        Date.now = () => FIXED_NOW;
      }
    }
  } finally {
    Date.now = originalDateNow;
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true });
    } catch {}
  }
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
