/**
 * Multi-counter ordering flow (create here, pay there) (#361)
 *
 * Covers:
 * - Multi-counter settings toggle (owner-only)
 * - Counters configuration CRUD API with permissions
 * - Order creation with dispatch_policy ('on_payment' for takeaway and dine_in, rejected for delivery)
 * - Deferred release (no stock deduction, no KDS/KOT auto-print prior to payment)
 * - Shared payment queue (/api/orders/awaiting-payment) with pagination and search
 * - Ticket lookup by order number and QR code payload (FLOCAFE-TICKET:<order_number>)
 * - Release gate: manual release of unpaid on_payment order rejected (409 ORDER_NOT_PAID)
 * - Prepayment lifecycle: partial payment updates balance; full payment triggers release
 * - Prepayment invariants: payment never marks kitchen completed and never prematurely frees dine-in tables
 * - Prepayment edit lock: items/discounts locked once payment is recorded (409 SCHEDULED_ORDER_PAID)
 * - Scheduled + on_payment takeaway: full payment marks paid, release waits for scheduled instant or explicit release
 * - Stock failure after payment leaves paid-but-blocked ticket; payment preserved; retry succeeds after restock
 * - Concurrent payment protection
 * - Thermal payment ticket slip generation with QR code (/api/printers/print-payment-ticket)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/multi-counter-ordering.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-multi-counter-361-'));

let kotPrintCalls: Array<{ orderId: unknown; stationName: string; itemCount: number }> = [];

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      powerMonitor: { on: () => {} },
    };
  }
  const loaded = originalLoad.apply(this, arguments as any);
  if (
    typeof request === 'string' &&
    (request.endsWith('/printers/thermal') || request.endsWith('\\printers\\thermal')) &&
    loaded &&
    typeof loaded.printKOTDetailed === 'function' &&
    !(loaded as any).__multiCounterKotWrapped
  ) {
    const origPrintKot = loaded.printKOTDetailed;
    loaded.printKOTDetailed = async function (
      order: any,
      items: any[],
      stationName: string,
      ...rest: any[]
    ) {
      kotPrintCalls.push({
        orderId: order?.id,
        stationName,
        itemCount: Array.isArray(items) ? items.length : 0,
      });
      return { ok: true, warnings: [] };
    };
    (loaded as any).__multiCounterKotWrapped = true;
    void origPrintKot;
  }
  return loaded;
};

process.env.JWT_SECRET = 'test-secret-multi-counter-361';
process.env.KDS_PORT = '0';

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
  seedCustomer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { validateInventoryLedgerDatabase } = require('../main/db');
const { sweepDueScheduledOrders } = require('../main/services/scheduled-orders');

function seedStaffUser(db: any, id: string, role: string, pin?: string) {
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
    userId: id,
    email,
    role,
    authHeader: {
      Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
    },
  };
}
const { adjustProductStock } = require('../main/services/inventory');
const { stopScheduledOrderSweep } = require('../main/services/scheduled-orders');
const { resetPinRateLimitForTests } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const { stopKdsServer } = require('../main/kds-server');
const { escPosToText } = require('../main/printers/thermal');

function adjustStock(
  db: any,
  productId: string,
  quantityDelta: number,
  reason: string,
  actorUserId: string,
) {
  adjustProductStock(db, {
    productId,
    quantityDelta,
    movementType: 'adjustment',
    referenceType: 'manual_adjustment',
    reason,
    actorUserId,
  });
}

function setStoreSetting(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

function productStock(db: any, id: string): number {
  const row = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any;
  return Number(row?.stock_quantity ?? 0);
}

function assertLedgerReconciles(db: any, label: string) {
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    `inventory ledger reconciles (${label})`,
  );
}

function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return local - date.getTime();
}

function hasDstTransitionInWindow(timezone: string, startMs: number, windowMs: number): boolean {
  try {
    return (
      getTimezoneOffsetMs(new Date(startMs), timezone) !==
      getTimezoneOffsetMs(new Date(startMs + windowMs), timezone)
    );
  } catch {
    return false;
  }
}

function futureWallClockInZone(timezone: string, offsetMinutes: number): string {
  const nowMs = Date.now();
  let baseMs = nowMs;
  if (hasDstTransitionInWindow(timezone, nowMs, 24 * 60 * 60 * 1000)) {
    baseMs += 24 * 60 * 60 * 1000;
  }
  const target = new Date(baseMs + offsetMinutes * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(target);
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour === '24' ? '00' : byType.hour}:${byType.minute}`;
}

async function main() {
  console.log('Multi-counter ordering flow test (#361)');
  console.log('='.repeat(66));
  resetCounters();
  resetPinRateLimitForTests();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const cashier = seedStaffUser(db, 'cashier-mc', 'cashier');
  const serverUser = seedStaffUser(db, 'server-mc', 'server');

  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
    bcrypt.hashSync('9999', 10),
    owner.userId,
  );

  // Store regional & kitchen settings
  setStoreSetting(db, 'country', 'US');
  setStoreSetting(db, 'currency', 'USD');
  setStoreSetting(db, 'timezone', 'America/New_York');
  setStoreSetting(db, 'kds_enabled', 'true');
  setStoreSetting(db, 'kot_printing_enabled', 'true');
  setStoreSetting(db, 'auto_print_kot', 'true');
  setStoreSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
  setStoreSetting(db, 'split_checks_enabled', 'true');

  // Seed default printer for ticket printing tests
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, text_size, is_default, cash_drawer_pulse_enabled, created_at, updated_at)
     VALUES ('prn-mc-1', 'Receipt Thermal', 'network', '127.0.0.1', 9100, 'cols-42', 'normal', 1, 0, ?, ?)`,
  ).run(now(), now());

  // Seed menu catalog
  seedCategory(db, 'cat-mc', 'MultiCounter Menu');
  seedTable(db, 'tbl-mc-1', 1, 4);
  seedCustomer(db, 'cust-mc-1', 'Alex Counter', '+15551112222');
  seedCustomer(db, 'cust-mc-2', 'Jordan Queue', '+15553334444');

  // Seed tracked products with ledger-backed stock
  seedProduct(db, 'prod-burger', 'cat-mc', 'Counter Burger', 1200, {
    track_inventory: true,
    stock_quantity: 0,
  });
  seedProduct(db, 'prod-fries', 'cat-mc', 'Counter Fries', 400, {
    track_inventory: true,
    stock_quantity: 0,
  });
  seedProduct(db, 'prod-limited', 'cat-mc', 'Limited Pie', 500, {
    track_inventory: true,
    stock_quantity: 0,
  });

  adjustStock(db, 'prod-burger', 50, 'initial seed', owner.userId);
  adjustStock(db, 'prod-fries', 50, 'initial seed', owner.userId);
  adjustStock(db, 'prod-limited', 1, 'initial seed 1 left', owner.userId);
  assertLedgerReconciles(db, 'after initial stock');

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function req(options: { path: string; method?: string; body?: any; headers?: any }) {
    const { path: urlPath, ...rest } = options;
    const res = await api(baseUrl, urlPath, rest);
    return { status: res.status, body: res.data };
  }

  try {
    // -------------------------------------------------------------------------
    // 1. Settings: multi_counter_enabled toggle
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Multi-counter Settings Toggle ---');

    const disabledSetting = await req({
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'false' },
    });
    assertEqualOrThrow(disabledSetting.status, 200, 'multi-counter disabled for creation check');
    const beforeDisabled = {
      orders: (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as any).count,
      bills: (db.prepare('SELECT COUNT(*) AS count FROM bills').get() as any).count,
      attempts: (db.prepare('SELECT COUNT(*) AS count FROM order_idempotency').get() as any).count,
      stock: productStock(db, 'prod-burger'),
      sequences: JSON.stringify(db.prepare('SELECT * FROM sequences ORDER BY name, date').all()),
    };
    const disabledCreation = await req({
      path: '/api/orders',
      method: 'POST',
      headers: { ...serverUser.authHeader, 'Idempotency-Key': 'disabled-create-test' },
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(
      disabledCreation.status,
      409,
      'disabled multi-counter rejects new deferred ticket',
    );
    assertEqualOrThrow(
      disabledCreation.body.code,
      'MULTI_COUNTER_DISABLED',
      'disabled error has stable code',
    );
    assertEqualOrThrow(
      disabledCreation.body.outcome,
      'not_applied',
      'disabled error reports no mutation',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as any).count,
      beforeDisabled.orders,
      'disabled creation leaves no order',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM bills').get() as any).count,
      beforeDisabled.bills,
      'disabled creation leaves no bill',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM order_idempotency').get() as any).count,
      beforeDisabled.attempts,
      'disabled creation leaves no idempotency record',
    );
    assertEqualOrThrow(
      productStock(db, 'prod-burger'),
      beforeDisabled.stock,
      'disabled creation leaves stock unchanged',
    );
    assertEqualOrThrow(
      JSON.stringify(db.prepare('SELECT * FROM sequences ORDER BY name, date').all()),
      beforeDisabled.sequences,
      'disabled creation does not allocate an order number',
    );
    const ordinaryDisabled = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-burger', quantity: 1 }] },
    });
    assertEqualOrThrow(
      ordinaryDisabled.status,
      201,
      'ordinary order remains available when multi-counter is disabled',
    );
    const cancelOrdinary = await req({
      path: `/api/orders/${ordinaryDisabled.body.order.id}/status`,
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'cancelled' },
    });
    assertEqualOrThrow(cancelOrdinary.status, 200, 'ordinary test order cancels normally');

    // Non-owner cannot toggle multi_counter_enabled
    const cashierToggle = await req({
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: cashier.authHeader,
      body: { value: 'true' },
    });
    assertEqualOrThrow(
      cashierToggle.status,
      403,
      'non-owner toggle multi_counter_enabled rejected 403',
    );

    // Owner can toggle multi_counter_enabled
    const ownerToggle = await req({
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'true' },
    });
    assertEqualOrThrow(ownerToggle.status, 200, 'owner can enable multi_counter_enabled');

    const checkSetting = await req({
      path: '/api/settings/multi_counter_enabled',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(checkSetting.status, 200, 'read multi_counter_enabled setting');
    assertEqualOrThrow(checkSetting.body?.setting?.value, 'true', 'setting is true');

    // -------------------------------------------------------------------------
    // 2. Counters API CRUD & Permissions
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Counters CRUD API ---');

    // Initial list is empty
    const listInitial = await req({
      path: '/api/counters',
      method: 'GET',
      headers: serverUser.authHeader,
    });
    assertEqualOrThrow(listInitial.status, 200, 'server can read counters');
    assertEqualOrThrow(listInitial.body?.counters?.length, 0, 'initial counters count is 0');

    // Non-owner cannot create counter
    const serverCreate = await req({
      path: '/api/counters',
      method: 'POST',
      headers: serverUser.authHeader,
      body: { name: 'Unauthorized Counter', role: 'ordering' },
    });
    assertEqualOrThrow(serverCreate.status, 403, 'non-owner cannot create counter');

    // Validation checks
    const badRole = await req({
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Counter 1', role: 'invalid_role' },
    });
    assertEqualOrThrow(badRole.status, 400, 'invalid counter role rejected 400');

    const emptyName = await req({
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: '   ', role: 'ordering' },
    });
    assertEqualOrThrow(emptyName.status, 400, 'empty counter name rejected 400');

    // Create 3 counters with different roles
    const c1Res = await req({
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Order Station 1', role: 'ordering', sort_order: 1 },
    });
    assertEqualOrThrow(c1Res.status, 201, 'create ordering counter 201');
    const c1 = c1Res.body.counter;
    assertEqualOrThrow(c1.role, 'ordering', 'counter role is ordering');

    const c2Res = await req({
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Payment Station 1', role: 'payment', sort_order: 2 },
    });
    assertEqualOrThrow(c2Res.status, 201, 'create payment counter 201');
    const c2 = c2Res.body.counter;

    const c3Res = await req({
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Express Combined', role: 'combined', sort_order: 3 },
    });
    assertEqualOrThrow(c3Res.status, 201, 'create combined counter 201');
    const c3 = c3Res.body.counter;

    // Check list ordering
    const listRes = await req({
      path: '/api/counters',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(listRes.body?.counters?.length, 3, 'counters list has 3 counters');
    assertEqualOrThrow(listRes.body.counters[0].id, c1.id, 'first counter sorted by sort_order');
    assertEqualOrThrow(listRes.body.counters[1].id, c2.id, 'second counter sorted by sort_order');

    // Update counter
    const updateRes = await req({
      path: `/api/counters/${c3.id}`,
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        name: 'Express Combined Renamed',
        role: 'combined',
        is_active: false,
        sort_order: 10,
      },
    });
    assertEqualOrThrow(updateRes.status, 200, 'update counter 200');
    assertEqualOrThrow(
      updateRes.body.counter.name,
      'Express Combined Renamed',
      'counter name updated',
    );
    assertEqualOrThrow(updateRes.body.counter.is_active, 0, 'counter is_active is 0');

    // Delete counter
    const deleteRes = await req({
      path: `/api/counters/${c3.id}`,
      method: 'DELETE',
      headers: owner.authHeader,
    });
    assertEqualOrThrow(deleteRes.status, 200, 'delete counter 200');

    const listAfterDelete = await req({
      path: '/api/counters',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      listAfterDelete.body?.counters?.length,
      2,
      'counters count is 2 after deletion',
    );

    // -------------------------------------------------------------------------
    // 3. Order Creation with dispatch_policy: 'on_payment'
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Order Creation & Deferred Release ---');

    // Reject delivery with on_payment
    const deliveryReject = await req({
      path: '/api/orders',
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        type: 'delivery',
        dispatch_policy: 'on_payment',
        delivery_address: '123 Main St',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(
      deliveryReject.status,
      400,
      'delivery with dispatch_policy on_payment rejected 400',
    );
    assertIncludesOrThrow(
      deliveryReject.body?.error,
      'not supported for delivery orders',
      'helpful delivery rejection error',
    );

    // Reject invalid dispatch_policy
    const invalidPolicyReject = await req({
      path: '/api/orders',
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'invalid_policy',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(invalidPolicyReject.status, 400, 'invalid dispatch_policy rejected 400');

    // Reject invalid or mismatched checkout_stage (Item 1)
    const invalidStageRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        checkout_stage: 'invalid_stage',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(invalidStageRes.status, 400, 'invalid checkout_stage rejected 400');

    const mismatchedStageRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'immediate',
        checkout_stage: 'awaiting_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(mismatchedStageRes.status, 400, 'mismatched checkout_stage rejected 400');

    // Idempotent POST /orders replay returns QR fields (Item 5)
    const idemKeyOrder = `idem-order-test-${Date.now()}`;
    const idemOrder1 = await req({
      path: '/api/orders',
      method: 'POST',
      headers: { ...serverUser.authHeader, 'Idempotency-Key': idemKeyOrder },
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(idemOrder1.status, 201, 'idempotent initial order created 201');
    assertOrThrow(!!idemOrder1.body?.qr_payload, 'initial response includes qr_payload');
    assertOrThrow(!!idemOrder1.body?.qr_data_url, 'initial response includes qr_data_url');

    const payableAfterDisable = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        scheduled_for: futureWallClockInZone('America/New_York', 45),
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(payableAfterDisable.status, 201, 'deferred ticket created before disabling');
    const payableBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(payableAfterDisable.body.order.id) as any;
    const disabledAfterCommit = await req({
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'false' },
    });
    assertEqualOrThrow(disabledAfterCommit.status, 200, 'feature disabled after committed ticket');
    const paidAfterDisable = await req({
      path: `/api/bills/${payableBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: { method: 'cash', amount: Number(payableBill.total) },
    });
    assertEqualOrThrow(
      paidAfterDisable.status,
      200,
      'existing deferred ticket remains payable after disabling',
    );
    const refundedAfterDisable = await req({
      path: '/api/refunds',
      method: 'POST',
      headers: owner.authHeader,
      body: {
        bill_id: payableBill.id,
        amount: Number(payableBill.total),
        method: 'cash',
        reason: 'Fixture cleanup',
        approver_id: owner.userId,
        override_pin: '9999',
      },
    });
    assertEqualOrThrow(
      refundedAfterDisable.status,
      201,
      'existing deferred ticket remains refundable after disabling',
    );
    const cancelledAfterDisable = await req({
      path: `/api/orders/${payableAfterDisable.body.order.id}/status`,
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'cancelled', reason: 'Fixture cleanup' },
    });
    assertEqualOrThrow(
      cancelledAfterDisable.status,
      200,
      'existing deferred ticket remains cancellable after disabling',
    );
    const idemReplay = await req({
      path: '/api/orders',
      method: 'POST',
      headers: { ...serverUser.authHeader, 'Idempotency-Key': idemKeyOrder },
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(idemReplay.status, 200, 'idempotent order replay 200');
    assertEqualOrThrow(
      idemReplay.body?.order?.order_number,
      idemOrder1.body?.order?.order_number,
      'replayed order number matches',
    );
    assertEqualOrThrow(
      idemReplay.body?.qr_payload,
      idemOrder1.body?.qr_payload,
      'replayed qr_payload matches',
    );
    assertOrThrow(
      typeof idemReplay.body?.qr_data_url === 'string' &&
        idemReplay.body.qr_data_url.startsWith('data:image/png;base64,'),
      'replayed qr_data_url is present',
    );
    const idemConflictAfterDisable = await req({
      path: '/api/orders',
      method: 'POST',
      headers: { ...serverUser.authHeader, 'Idempotency-Key': idemKeyOrder },
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 2 }],
      },
    });
    assertEqualOrThrow(
      idemConflictAfterDisable.status,
      409,
      'changed replay remains a conflict after disabling',
    );
    assertIncludesOrThrow(
      idemConflictAfterDisable.body.error,
      'Idempotency-Key',
      'changed replay reports the existing request-hash conflict',
    );
    const reenabledSetting = await req({
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'true' },
    });
    assertEqualOrThrow(reenabledSetting.status, 200, 'feature re-enabled for remaining scenarios');
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(idemOrder1.body.order.id);

    // Create valid takeaway order with dispatch_policy: 'on_payment'
    const initialBurgerStock = productStock(db, 'prod-burger');
    kotPrintCalls = [];

    const orderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        customer_id: 'cust-mc-1',
        items: [{ product_id: 'prod-burger', quantity: 2 }],
      },
    });
    assertEqualOrThrow(orderRes.status, 201, 'takeaway on_payment order created 201');
    const order1 = orderRes.body.order;

    assertEqualOrThrow(order1.dispatch_policy, 'on_payment', 'dispatch_policy is on_payment');
    assertEqualOrThrow(
      order1.checkout_stage,
      'awaiting_payment',
      'checkout_stage is awaiting_payment',
    );
    assertEqualOrThrow(
      order1.release_status,
      'scheduled',
      'release_status is scheduled (unreleased)',
    );
    assertEqualOrThrow(
      orderRes.body.qr_payload,
      `FLOCAFE-TICKET:${order1.order_number}`,
      'qr_payload carries FLOCAFE-TICKET prefix and order number',
    );
    assertOrThrow(typeof orderRes.body.qr_data_url === 'string', 'qr_data_url is provided');
    assertOrThrow(
      orderRes.body.qr_data_url.startsWith('data:image/png;base64,'),
      'qr_data_url is PNG data url',
    );

    const scheduledOnly = await req({
      path: '/api/orders/scheduled',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(scheduledOnly.status, 200, 'scheduled queue loads');
    assertOrThrow(
      !scheduledOnly.body.orders.some((order: any) => order.id === order1.id),
      'unscheduled deferred order is excluded from scheduled queue',
    );
    assertEqualOrThrow(
      scheduledOnly.body.scheduled_count,
      0,
      'unscheduled deferred order is excluded from scheduled count',
    );
    db.prepare("UPDATE orders SET release_status = 'blocked' WHERE id = ?").run(order1.id);
    const blockedScheduledOnly = await req({
      path: '/api/orders/scheduled?limit=1',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      blockedScheduledOnly.body.blocked_count,
      0,
      'unscheduled blocked order is excluded from blocked count',
    );
    assertEqualOrThrow(
      blockedScheduledOnly.body.orders.length,
      0,
      'unscheduled blocked order is excluded from scheduled pages',
    );
    db.prepare("UPDATE orders SET release_status = 'scheduled' WHERE id = ?").run(order1.id);

    // Verify stock was NOT deducted
    assertEqualOrThrow(
      productStock(db, 'prod-burger'),
      initialBurgerStock,
      'stock deferred on creation',
    );
    // Verify KOT print did NOT happen
    assertEqualOrThrow(kotPrintCalls.length, 0, 'kot print deferred on creation');

    // Verify real bill created in database
    const billRow = db
      .prepare('SELECT * FROM bills WHERE order_id = ? AND payment_status = ?')
      .get(order1.id, 'unpaid') as any;
    assertOrThrow(!!billRow, 'real unpaid bill created in bills table');
    assertEqualOrThrow(Number(billRow.total), 2400, 'bill total is 2400');
    assertEqualOrThrow(Number(billRow.balance), 2400, 'bill balance is 2400');

    // -------------------------------------------------------------------------
    // 4. Queue and Ticket Lookup
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Queue and Ticket Lookup ---');

    // Create a dine-in on_payment order too
    const dineInRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-mc-1',
        customer_id: 'cust-mc-2',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-fries', quantity: 1 }],
      },
    });
    assertEqualOrThrow(dineInRes.status, 201, 'dine_in on_payment order created 201');
    const orderDineIn = dineInRes.body.order;

    // Table must be occupied
    const tblRow = db.prepare('SELECT status FROM tables WHERE id = ?').get('tbl-mc-1') as any;
    assertEqualOrThrow(tblRow.status, 'occupied', 'dine_in table is occupied');

    // Query awaiting payment queue
    const queueRes = await req({
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(queueRes.status, 200, 'fetch awaiting-payment queue 200');
    assertEqualOrThrow(queueRes.body?.awaiting_count, 2, 'awaiting_count is 2');
    assertEqualOrThrow(queueRes.body?.total_count, 2, 'total_count is 2');
    assertEqualOrThrow(queueRes.body?.orders?.length, 2, 'queue returns 2 orders');

    // Pagination test (limit=1)
    const page1Res = await req({
      path: '/api/orders/awaiting-payment?limit=1',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(page1Res.body?.orders?.length, 1, 'page 1 returns 1 order');
    assertOrThrow(!!page1Res.body?.next_cursor, 'next_cursor returned for page 1');

    const page2Res = await req({
      path: `/api/orders/awaiting-payment?limit=1&cursor=${page1Res.body.next_cursor}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(page2Res.body?.orders?.length, 1, 'page 2 returns 1 order');
    assertOrThrow(
      page1Res.body.orders[0].id !== page2Res.body.orders[0].id,
      'pages return distinct orders',
    );

    // Search by customer name in queue
    const searchRes = await req({
      path: '/api/orders/awaiting-payment?search=Alex',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(searchRes.body?.orders?.length, 1, 'search matches Alex');
    assertEqualOrThrow(searchRes.body.orders[0].id, order1.id, 'matches order1');

    // Ticket lookup: by raw order number
    const lookupRaw = await req({
      path: `/api/orders/by-ticket/${order1.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupRaw.status, 200, 'lookup by raw order number 200');
    assertEqualOrThrow(lookupRaw.body?.order?.id, order1.id, 'order matches');
    assertOrThrow(!!lookupRaw.body?.bill, 'bill hydrated in lookup');

    // Ticket lookup: by full QR payload
    const lookupQr = await req({
      path: `/api/orders/by-ticket/${encodeURIComponent(`FLOCAFE-TICKET:${order1.order_number}`)}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupQr.status, 200, 'lookup by full QR payload 200');
    assertEqualOrThrow(lookupQr.body?.order?.id, order1.id, 'order matches by QR payload');

    // Ticket lookup: non-existent
    const lookup404 = await req({
      path: '/api/orders/by-ticket/NON-EXISTENT-TICKET-9999',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookup404.status, 404, 'lookup non-existent ticket 404');

    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order1.id);
    const lookupCancelled = await req({
      path: `/api/orders/by-ticket/${order1.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupCancelled.status, 404, 'lookup cancelled ticket 404');
    db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(order1.id);

    // Item 8: Non-multi-counter blocked scheduled order does NOT appear in awaiting-payment queue
    const futureTimeImmediate = futureWallClockInZone('America/New_York', 15);
    adjustStock(db, 'prod-limited', -productStock(db, 'prod-limited'), 'zero stock', owner.userId);
    const nonMcBlockedOrder = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'immediate',
        scheduled_for: futureTimeImmediate,
        items: [{ product_id: 'prod-limited', quantity: 1 }],
      },
    });
    assertEqualOrThrow(nonMcBlockedOrder.status, 201, 'non-MC scheduled order created');
    await req({
      path: `/api/orders/${nonMcBlockedOrder.body.order.id}/release`,
      method: 'POST',
      headers: manager.authHeader,
    });
    const nonMcOrderBlockedRow = db
      .prepare('SELECT release_status, dispatch_policy FROM orders WHERE id = ?')
      .get(nonMcBlockedOrder.body.order.id) as any;
    assertEqualOrThrow(nonMcOrderBlockedRow.release_status, 'blocked', 'non-MC order is blocked');
    assertEqualOrThrow(
      nonMcOrderBlockedRow.dispatch_policy,
      'immediate',
      'dispatch_policy is immediate',
    );

    const queueCheckNonMc = await req({
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    const foundNonMcInQueue = queueCheckNonMc.body?.orders?.find(
      (o: any) => o.id === nonMcBlockedOrder.body.order.id,
    );
    assertEqualOrThrow(
      foundNonMcInQueue,
      undefined,
      'non-MC blocked order NOT in awaiting-payment queue',
    );
    const scheduledPageControl = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        scheduled_for: futureWallClockInZone('America/New_York', 30),
        items: [{ product_id: 'prod-fries', quantity: 1 }],
      },
    });
    assertEqualOrThrow(scheduledPageControl.status, 201, 'scheduled pagination control created');
    db.prepare("UPDATE orders SET release_status = 'blocked' WHERE id = ?").run(order1.id);
    const scheduledFirst = await req({
      path: '/api/orders/scheduled?limit=1',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      scheduledFirst.status,
      200,
      'scheduled first page loads with unscheduled blocked ticket',
    );
    assertEqualOrThrow(
      scheduledFirst.body.scheduled_count,
      1,
      'scheduled count excludes undated tickets',
    );
    assertEqualOrThrow(
      scheduledFirst.body.blocked_count,
      1,
      'blocked count excludes undated tickets',
    );
    assertEqualOrThrow(
      scheduledFirst.body.orders[0].id,
      nonMcBlockedOrder.body.order.id,
      'dated blocked order appears first',
    );
    assertOrThrow(!!scheduledFirst.body.next_cursor, 'scheduled first page supplies a cursor');
    const scheduledSecond = await req({
      path: `/api/orders/scheduled?limit=1&cursor=${encodeURIComponent(scheduledFirst.body.next_cursor)}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(scheduledSecond.status, 200, 'scheduled second page loads');
    assertEqualOrThrow(
      scheduledSecond.body.orders[0].id,
      scheduledPageControl.body.order.id,
      'dated scheduled order appears on second page',
    );
    assertEqualOrThrow(
      scheduledSecond.body.next_cursor,
      null,
      'undated tickets do not create extra scheduled pages',
    );
    db.prepare("UPDATE orders SET release_status = 'scheduled' WHERE id = ?").run(order1.id);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(
      scheduledPageControl.body.order.id,
    );
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(
      nonMcBlockedOrder.body.order.id,
    );
    adjustStock(db, 'prod-limited', 1, 'restore stock', owner.userId);

    // Item 10: Read-only ticket lookup never creates a bill
    const orderWithoutBillRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    const testOrderNoBill = orderWithoutBillRes.body.order;
    db.prepare('DELETE FROM bills WHERE order_id = ?').run(testOrderNoBill.id);
    const billsBeforeLookup = (
      db
        .prepare('SELECT COUNT(*) as n FROM bills WHERE order_id = ?')
        .get(testOrderNoBill.id) as any
    ).n;
    assertEqualOrThrow(billsBeforeLookup, 0, 'zero bills before read-only lookup');

    const readOnlyLookupRes = await req({
      path: `/api/orders/by-ticket/${testOrderNoBill.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(readOnlyLookupRes.status, 200, 'lookup succeeds without bill');
    assertEqualOrThrow(readOnlyLookupRes.body?.bill, null, 'bill is null when not generated');
    const billsAfterLookup = (
      db
        .prepare('SELECT COUNT(*) as n FROM bills WHERE order_id = ?')
        .get(testOrderNoBill.id) as any
    ).n;
    assertEqualOrThrow(
      billsAfterLookup,
      0,
      'zero bills after read-only lookup (never created in GET)',
    );
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(testOrderNoBill.id);

    // Item 14: Ticket lookup by order_number vs id
    const lookupByOrderNum = await req({
      path: `/api/orders/by-ticket/${order1.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupByOrderNum.status, 200, 'lookup strictly by order_number 200');
    assertEqualOrThrow(
      lookupByOrderNum.body?.order?.order_number,
      order1.order_number,
      'matches order_number',
    );

    const lookupWithById = await req({
      path: `/api/orders/by-ticket/${order1.id}?by=id`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      lookupWithById.status,
      200,
      'lookup with ?by=id matches order by internal id',
    );
    assertEqualOrThrow(lookupWithById.body?.order?.id, order1.id, 'matched order id');

    // -------------------------------------------------------------------------
    // 5. Prepayment Release Gates & Prepayment Lifecycle
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Release Gates & Prepayment Lifecycle ---');

    // Manual release of unpaid order must fail with 409 ORDER_NOT_PAID
    const unpaidReleaseAttempt = await req({
      path: `/api/orders/${order1.id}/release`,
      method: 'POST',
      headers: serverUser.authHeader,
    });
    assertEqualOrThrow(
      unpaidReleaseAttempt.status,
      409,
      'manual release before payment rejected 409',
    );
    assertEqualOrThrow(unpaidReleaseAttempt.body?.code, 'ORDER_NOT_PAID', 'code is ORDER_NOT_PAID');

    // Partial payment: pay $10 of $24 (1000 cents of 2400)
    const partialPayRes = await req({
      path: `/api/bills/${billRow.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: 1000,
      },
    });
    assertEqualOrThrow(partialPayRes.status, 200, 'partial payment 200');
    assertEqualOrThrow(partialPayRes.body?.bill?.payment_status, 'partial', 'bill is partial');
    assertEqualOrThrow(Number(partialPayRes.body?.bill?.balance), 1400, 'bill balance is 1400');

    // Verify order still awaiting payment and scheduled
    const order1AfterPartial = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(order1.id) as any;
    assertEqualOrThrow(
      order1AfterPartial.checkout_stage,
      'awaiting_payment',
      'stage still awaiting_payment',
    );
    assertEqualOrThrow(
      order1AfterPartial.release_status,
      'scheduled',
      'release_status still scheduled',
    );
    assertEqualOrThrow(
      productStock(db, 'prod-burger'),
      initialBurgerStock,
      'stock still untouched',
    );

    // Prepayment edit lock: cannot add items or discounts once payment is recorded
    const editItemAttempt = await req({
      path: `/api/orders/${order1.id}/items`,
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        items: [{ product_id: 'prod-fries', quantity: 1 }],
      },
    });
    assertEqualOrThrow(editItemAttempt.status, 409, 'item edit rejected 409 once payment recorded');
    assertEqualOrThrow(
      editItemAttempt.body?.code,
      'SCHEDULED_ORDER_PAID',
      'code is SCHEDULED_ORDER_PAID',
    );

    const editDiscountAttempt = await req({
      path: `/api/orders/${order1.id}/discount`,
      method: 'PATCH',
      headers: manager.authHeader,
      body: {
        discount_type: 'flat',
        discount_value: 200,
        discount_reason: 'Friend discount',
      },
    });
    assertEqualOrThrow(
      editDiscountAttempt.status,
      409,
      'order discount rejected 409 once payment recorded',
    );

    // Final payment: pay remaining $14 (1400 cents)
    kotPrintCalls = [];
    const finalPayRes = await req({
      path: `/api/bills/${billRow.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: 1400,
      },
    });
    assertEqualOrThrow(finalPayRes.status, 200, 'final payment 200');
    assertEqualOrThrow(finalPayRes.body?.bill?.payment_status, 'paid', 'bill is paid');
    assertEqualOrThrow(Number(finalPayRes.body?.bill?.balance), 0, 'balance is 0');

    // Verify order transitions
    const order1AfterFinal = db.prepare('SELECT * FROM orders WHERE id = ?').get(order1.id) as any;
    assertEqualOrThrow(
      order1AfterFinal.checkout_stage,
      'paid',
      'checkout_stage transitioned to paid',
    );
    assertEqualOrThrow(order1AfterFinal.release_status, 'released', 'order released to kitchen!');
    assertEqualOrThrow(
      order1AfterFinal.status,
      'pending',
      'kitchen status remains pending, NOT completed!',
    );

    const lookupPaid = await req({
      path: `/api/orders/by-ticket/${order1.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupPaid.status, 404, 'lookup already paid ticket 404');

    // Verify stock deducted
    assertEqualOrThrow(
      productStock(db, 'prod-burger'),
      initialBurgerStock - 2,
      'stock deducted on release',
    );
    assertLedgerReconciles(db, 'after order1 release');

    // Verify dine-in prepayment invariant: table stays occupied on payment!
    const dineInBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(orderDineIn.id) as any;

    const dineInPayRes = await req({
      path: `/api/bills/${dineInBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'card',
        amount: Number(dineInBill.total),
      },
    });
    assertEqualOrThrow(dineInPayRes.status, 200, 'dine in payment 200');

    const tblRowAfterPay = db
      .prepare('SELECT status FROM tables WHERE id = ?')
      .get('tbl-mc-1') as any;
    assertEqualOrThrow(
      tblRowAfterPay.status,
      'occupied',
      'dine-in table remains OCCUPIED after prepayment!',
    );

    const orderDineInAfterPay = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(orderDineIn.id) as any;
    assertEqualOrThrow(
      orderDineInAfterPay.checkout_stage,
      'paid',
      'dine in checkout stage is paid',
    );
    assertEqualOrThrow(orderDineInAfterPay.status, 'pending', 'dine in status remains pending');

    const dineInItem = orderDineIn.items[0];
    const dineInServedRes = await req({
      path: `/api/order-items/${dineInItem.id}/status`,
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'served' },
    });
    assertEqualOrThrow(dineInServedRes.status, 200, 'served dine-in item after payment');
    const orderDineInAfterServed = db
      .prepare('SELECT status FROM orders WHERE id = ?')
      .get(orderDineIn.id) as any;
    assertEqualOrThrow(
      orderDineInAfterServed.status,
      'served',
      'dine-in order remains served instead of auto-completing',
    );
    const tblRowAfterServed = db
      .prepare('SELECT status FROM tables WHERE id = ?')
      .get('tbl-mc-1') as any;
    assertEqualOrThrow(
      tblRowAfterServed.status,
      'occupied',
      'dine-in table remains occupied after the last item is served',
    );

    const completeDineInRes = await req({
      path: `/api/orders/${orderDineIn.id}/status`,
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'completed' },
    });
    assertEqualOrThrow(completeDineInRes.status, 200, 'complete settled dine-in order');
    const tblRowAfterComplete = db
      .prepare('SELECT status FROM tables WHERE id = ?')
      .get('tbl-mc-1') as any;
    assertEqualOrThrow(
      tblRowAfterComplete.status,
      'available',
      'explicit completion releases the dine-in table',
    );

    const splitDineInRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-mc-1',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 2 }],
      },
    });
    assertEqualOrThrow(splitDineInRes.status, 201, 'split dine-in order created');
    const splitOrder = splitDineInRes.body.order;
    const splitItem1 = splitOrder.items[0];

    const initialSplitBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(splitOrder.id) as any;

    const splitRes = await req({
      path: `/api/bills/${initialSplitBill.id}/split-check`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        checks: [
          { label: 'Seat 1', items: [{ order_item_id: splitItem1.id, quantity: 1 }] },
          { label: 'Seat 2', items: [{ order_item_id: splitItem1.id, quantity: 1 }] },
        ],
      },
    });
    assertEqualOrThrow(splitRes.status, 201, 'dine-in check split 201');
    const [splitBill1, splitBill2] = splitRes.body.bills;

    const payBill1Res = await req({
      path: `/api/bills/${splitBill1.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: Number(splitBill1.total),
      },
    });
    assertEqualOrThrow(payBill1Res.status, 200, 'first split bill paid');

    const splitOrderAfterBill1 = db
      .prepare('SELECT checkout_stage FROM orders WHERE id = ?')
      .get(splitOrder.id) as any;
    assertEqualOrThrow(
      splitOrderAfterBill1.checkout_stage,
      'awaiting_payment',
      'stage remains awaiting_payment',
    );

    const queueAfterSplitBill1 = await req({
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    const splitQueueRow = queueAfterSplitBill1.body?.orders?.find(
      (o: any) => o.id === splitOrder.id,
    );
    assertOrThrow(!!splitQueueRow, 'order present in awaiting-payment queue');
    assertEqualOrThrow(splitQueueRow.bill_id, splitBill2.id, 'queue row joins unpaid splitBill2');
    assertEqualOrThrow(
      Number(splitQueueRow.balance),
      Number(splitBill2.balance),
      'queue row shows splitBill2 balance',
    );
    assertEqualOrThrow(
      Number(splitQueueRow.ticket_balance),
      Number(splitBill2.balance),
      'queue ticket balance covers all split bills',
    );
    assertEqualOrThrow(
      Number(splitQueueRow.ticket_paid_amount),
      Number(splitBill1.total),
      'queue ticket paid amount includes settled split bills',
    );

    const lookupSplitTicket = await req({
      path: `/api/orders/by-ticket/${splitOrder.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      lookupSplitTicket.status,
      200,
      'ticket lookup succeeds while second check is unpaid',
    );
    assertEqualOrThrow(
      lookupSplitTicket.body?.bill?.id,
      splitBill2.id,
      'primaryBill is splitBill2',
    );

    const payBill2Res = await req({
      path: `/api/bills/${splitBill2.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: Number(splitBill2.total),
      },
    });
    assertEqualOrThrow(payBill2Res.status, 200, 'second split bill paid');

    const splitOrderAfterAllPaid = db
      .prepare('SELECT checkout_stage FROM orders WHERE id = ?')
      .get(splitOrder.id) as any;
    assertEqualOrThrow(
      splitOrderAfterAllPaid.checkout_stage,
      'paid',
      'stage transitions to paid when all checks settled',
    );

    const lookupSplitTicketAllPaid = await req({
      path: `/api/orders/by-ticket/${splitOrder.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      lookupSplitTicketAllPaid.status,
      404,
      'ticket lookup 404 after all split checks paid',
    );

    // Item 9: Idempotent payment replay on POST /api/bills/:id/payments
    const idemPayOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    const idemPayOrder = idemPayOrderRes.body.order;
    const idemPayBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(idemPayOrder.id) as any;
    const idemPayKey = `idem-pay-${Date.now()}`;

    const idemPay1 = await req({
      path: `/api/bills/${idemPayBill.id}/payments`,
      method: 'POST',
      headers: { ...cashier.authHeader, 'Idempotency-Key': idemPayKey },
      body: {
        payments: [{ method: 'cash', amount: Number(idemPayBill.total) }],
      },
    });
    assertEqualOrThrow(idemPay1.status, 200, 'initial batch payment 200');
    assertEqualOrThrow(idemPay1.body?.bill?.payment_status, 'paid', 'bill is paid');

    const idemPayReplay = await req({
      path: `/api/bills/${idemPayBill.id}/payments`,
      method: 'POST',
      headers: { ...cashier.authHeader, 'Idempotency-Key': idemPayKey },
      body: {
        payments: [{ method: 'cash', amount: Number(idemPayBill.total) }],
      },
    });
    assertEqualOrThrow(idemPayReplay.status, 200, 'replayed batch payment 200');
    assertEqualOrThrow(
      idemPayReplay.body?.bill?.payment_status,
      'paid',
      'replayed bill is still paid',
    );
    const billPaymentsRow = db
      .prepare('SELECT payment_details FROM bills WHERE id = ?')
      .get(idemPayBill.id) as any;
    const recordedPayments = JSON.parse(billPaymentsRow.payment_details || '[]');
    assertEqualOrThrow(
      recordedPayments.length,
      1,
      'exactly one payment recorded (no duplicate charge)',
    );

    // Item 9: Concurrent payment requests on same bill
    const concurrentOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    const concurrentOrder = concurrentOrderRes.body.order;
    const concurrentBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(concurrentOrder.id) as any;
    const initialConcurrentStock = productStock(db, 'prod-burger');

    const [payAttempt1, payAttempt2] = await Promise.all([
      req({
        path: `/api/bills/${concurrentBill.id}/payment`,
        method: 'POST',
        headers: cashier.authHeader,
        body: { method: 'cash', amount: Number(concurrentBill.total) },
      }),
      req({
        path: `/api/bills/${concurrentBill.id}/payment`,
        method: 'POST',
        headers: cashier.authHeader,
        body: { method: 'cash', amount: Number(concurrentBill.total) },
      }),
    ]);
    const successCount = [payAttempt1, payAttempt2].filter((r) => r.status === 200).length;
    assertEqualOrThrow(successCount, 1, 'exactly one concurrent payment succeeds 200');
    const rejectedStatus = [payAttempt1, payAttempt2].find((r) => r.status !== 200)?.status;
    assertEqualOrThrow(rejectedStatus, 400, 'concurrent payment race rejected with 400');
    assertEqualOrThrow(
      productStock(db, 'prod-burger'),
      initialConcurrentStock - 1,
      'single stock deduction on concurrent payment',
    );

    // Item 4: Refunded split sibling keeps checkout_stage='awaiting_payment' and prevents release
    const refundSiblingOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'dine_in',
        dispatch_policy: 'on_payment',
        table_id: 'tbl-mc-1',
        items: [
          { product_id: 'prod-burger', quantity: 1 },
          { product_id: 'prod-fries', quantity: 1 },
        ],
      },
    });
    const refundSiblingOrder = refundSiblingOrderRes.body.order;
    const refundSourceBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(refundSiblingOrder.id) as any;
    const refundItems = db
      .prepare('SELECT * FROM order_items WHERE order_id = ?')
      .all(refundSiblingOrder.id) as any[];

    const refundSplitRes = await req({
      path: `/api/bills/${refundSourceBill.id}/split-check`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        checks: [
          { label: 'Guest A', items: [{ order_item_id: refundItems[0].id, quantity: 1 }] },
          { label: 'Guest B', items: [{ order_item_id: refundItems[1].id, quantity: 1 }] },
        ],
      },
    });
    assertEqualOrThrow(refundSplitRes.status, 201, 'split into 2 checks');
    const [rsBill1, rsBill2] = refundSplitRes.body.bills;

    await req({
      path: `/api/bills/${rsBill1.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: { method: 'cash', amount: Number(rsBill1.total) },
    });
    const siblingRefund = await req({
      path: '/api/refunds',
      method: 'POST',
      headers: owner.authHeader,
      body: {
        bill_id: rsBill1.id,
        amount: Number(rsBill1.total),
        method: 'cash',
        reason: 'Guest A left',
        approver_id: owner.userId,
        override_pin: '9999',
      },
    });

    assertEqualOrThrow(siblingRefund.status, 201, 'split sibling fully refunded');

    await req({
      path: `/api/bills/${rsBill2.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: { method: 'cash', amount: Number(rsBill2.total) },
    });

    const refundSiblingOrderRow = db
      .prepare('SELECT checkout_stage, release_status FROM orders WHERE id = ?')
      .get(refundSiblingOrder.id) as any;
    assertEqualOrThrow(
      refundSiblingOrderRow.checkout_stage,
      'awaiting_payment',
      'checkout_stage stays awaiting_payment when sibling refunded',
    );
    assertEqualOrThrow(
      refundSiblingOrderRow.release_status,
      'scheduled',
      'order remains unreleased',
    );
    const siblingStatuses = db
      .prepare('SELECT payment_status FROM bills WHERE id IN (?, ?) ORDER BY id')
      .all(rsBill1.id, rsBill2.id) as Array<{ payment_status: string }>;
    assertOrThrow(
      siblingStatuses.some((bill) => bill.payment_status === 'refunded'),
      'one split bill is fully refunded',
    );
    assertOrThrow(
      siblingStatuses.some((bill) => bill.payment_status === 'paid'),
      'the other split bill remains paid',
    );
    const mixedRelease = await req({
      path: `/api/orders/${refundSiblingOrder.id}/release`,
      method: 'POST',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(mixedRelease.status, 409, 'mixed split bills cannot bypass payment gate');
    assertEqualOrThrow(
      mixedRelease.body.code,
      'ORDER_NOT_PAID',
      'mixed split bills do not trigger full-refund hold',
    );
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(refundSiblingOrder.id);

    // -------------------------------------------------------------------------
    // 6. Scheduled + on_payment takeaway combination
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Scheduled Takeaway on_payment ---');

    const futureTime = futureWallClockInZone('America/New_York', 45);
    const schedOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        scheduled_for: futureTime,
        items: [{ product_id: 'prod-fries', quantity: 2 }],
      },
    });
    assertEqualOrThrow(schedOrderRes.status, 201, 'scheduled on_payment takeaway created 201');
    const schedOrder = schedOrderRes.body.order;

    const scheduledPage = await req({
      path: '/api/orders/scheduled?limit=1',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(scheduledPage.status, 200, 'scheduled queue with deferred tickets loads');
    assertOrThrow(
      scheduledPage.body.orders.every((order: any) => order.scheduled_for),
      'scheduled page contains only dated orders',
    );
    assertOrThrow(
      scheduledPage.body.orders.some((order: any) => order.id === schedOrder.id),
      'scheduled deferred ticket appears in scheduled queue',
    );

    const schedBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(schedOrder.id) as any;

    // Pay scheduled order in full before scheduled_for
    const schedPayRes = await req({
      path: `/api/bills/${schedBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: Number(schedBill.total),
      },
    });
    assertEqualOrThrow(schedPayRes.status, 200, 'paid scheduled order 200');

    // Order must be checkout_stage = 'paid', but release_status = 'scheduled' because scheduled_for > now
    const schedOrderAfterPay = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(schedOrder.id) as any;
    assertEqualOrThrow(schedOrderAfterPay.checkout_stage, 'paid', 'checkout stage is paid');
    assertEqualOrThrow(
      schedOrderAfterPay.release_status,
      'scheduled',
      'release_status remains scheduled until scheduled instant or manual release',
    );

    // Explicit manual release after payment succeeds!
    const manualReleaseRes = await req({
      path: `/api/orders/${schedOrder.id}/release`,
      method: 'POST',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(manualReleaseRes.status, 200, 'manual release of paid scheduled order 200');
    assertEqualOrThrow(
      manualReleaseRes.body?.order?.release_status,
      'released',
      'order is released',
    );

    const refundScheduledRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        scheduled_for: futureTime,
        items: [{ product_id: 'prod-fries', quantity: 1 }],
      },
    });
    assertEqualOrThrow(refundScheduledRes.status, 201, 'scheduled deferred refund order created');
    const refundScheduledId = refundScheduledRes.body.order.id;
    const refundScheduledBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(refundScheduledId) as any;
    const refundScheduledPay = await req({
      path: `/api/bills/${refundScheduledBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: { method: 'cash', amount: Number(refundScheduledBill.total) },
    });
    assertEqualOrThrow(refundScheduledPay.status, 200, 'scheduled deferred order paid');
    const refundScheduled = await req({
      path: '/api/refunds',
      method: 'POST',
      headers: owner.authHeader,
      body: {
        bill_id: refundScheduledBill.id,
        amount: Number(refundScheduledBill.total),
        method: 'cash',
        reason: 'Customer cancelled',
        approver_id: owner.userId,
        override_pin: '9999',
      },
    });
    assertEqualOrThrow(refundScheduled.status, 201, 'scheduled deferred order fully refunded');
    const refundScheduledStock = productStock(db, 'prod-fries');
    const refundScheduledPrints = kotPrintCalls.length;
    db.prepare("UPDATE orders SET scheduled_for = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      refundScheduledId,
    );
    const refundScheduledSweep = await sweepDueScheduledOrders(db, { trigger: 'sweep' });
    assertOrThrow(
      refundScheduledSweep.blockedIds.includes(refundScheduledId),
      'sweep blocks refunded deferred order',
    );
    const refundScheduledRelease = await req({
      path: `/api/orders/${refundScheduledId}/release`,
      method: 'POST',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      refundScheduledRelease.status,
      409,
      'refunded scheduled deferred release rejected',
    );
    assertEqualOrThrow(
      refundScheduledRelease.body.code,
      'RELEASE_BLOCKED',
      'refunded deferred order reports release hold',
    );
    assertEqualOrThrow(
      refundScheduledRelease.body.order.release_blocked_reason,
      'refunded',
      'refunded deferred order carries hold reason',
    );
    const repeatedRefundSweep = await sweepDueScheduledOrders(db, { trigger: 'sweep' });
    assertOrThrow(
      !repeatedRefundSweep.releasedIds.includes(refundScheduledId),
      'repeated sweep does not release refunded deferred order',
    );
    const repeatedRefundRelease = await req({
      path: `/api/orders/${refundScheduledId}/release`,
      method: 'POST',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(
      repeatedRefundRelease.status,
      409,
      'repeated manual release keeps refund hold',
    );
    assertEqualOrThrow(
      productStock(db, 'prod-fries'),
      refundScheduledStock,
      'refund hold leaves deferred product stock unchanged',
    );
    assertEqualOrThrow(
      kotPrintCalls.length,
      refundScheduledPrints,
      'refund hold does not print a deferred KOT',
    );
    const refundHoldAudit = db
      .prepare(
        "SELECT COUNT(*) AS count FROM order_audit_log WHERE order_id = ? AND action = 'release_blocked'",
      )
      .get(String(refundScheduledId)) as { count: number };
    assertEqualOrThrow(
      refundHoldAudit.count,
      1,
      'repeated deferred refund holds record one audit entry',
    );
    const refundKds = await req({
      path: '/api/kds/orders',
      method: 'GET',
      headers: owner.authHeader,
    });
    assertEqualOrThrow(refundKds.status, 200, 'KDS orders load after refund hold');
    assertOrThrow(
      !refundKds.body.orders.some((order: any) => order.id === refundScheduledId),
      'refunded deferred order is absent from KDS',
    );
    const cancelRefundScheduled = await req({
      path: `/api/orders/${refundScheduledId}/status`,
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'cancelled', reason: 'Customer cancelled' },
    });
    assertEqualOrThrow(
      cancelRefundScheduled.status,
      200,
      'refunded deferred order can be cancelled',
    );

    // Item 15: Takeaway order completion when kds_enabled is false
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'false', datetime('now'))",
    ).run();

    const noKdsOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-burger', quantity: 1 }],
      },
    });
    const noKdsOrder = noKdsOrderRes.body.order;
    const noKdsBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(noKdsOrder.id) as any;

    await req({
      path: `/api/bills/${noKdsBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: { method: 'cash', amount: Number(noKdsBill.total) },
    });

    const noKdsOrderRow = db
      .prepare('SELECT status, release_status, checkout_stage FROM orders WHERE id = ?')
      .get(noKdsOrder.id) as any;
    assertEqualOrThrow(noKdsOrderRow.checkout_stage, 'paid', 'no-kds order checkout_stage is paid');
    assertEqualOrThrow(noKdsOrderRow.release_status, 'released', 'no-kds order is released');
    assertEqualOrThrow(
      noKdsOrderRow.status,
      'completed',
      'takeaway order completed at release when kds is disabled',
    );

    // Restore kds_enabled = 'true'
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', datetime('now'))",
    ).run();

    // -------------------------------------------------------------------------
    // 7. Paid-but-blocked on Stock Shortfall & Retry Release
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Paid-but-blocked on Stock Shortfall ---');

    // Create on_payment order for prod-limited (currently 1 unit in stock)
    assertEqualOrThrow(productStock(db, 'prod-limited'), 1, 'prod-limited has 1 in stock');
    const limitedOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-limited', quantity: 1 }],
      },
    });
    assertEqualOrThrow(limitedOrderRes.status, 201, 'limited stock order created 201');
    const limitedOrder = limitedOrderRes.body.order;

    const limitedBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(limitedOrder.id) as any;

    // Simulate stock shortfall before payment by another event
    adjustStock(db, 'prod-limited', -1, 'other customer bought last one', owner.userId);
    assertEqualOrThrow(productStock(db, 'prod-limited'), 0, 'prod-limited is now 0');

    // Settle payment in full
    const limitedPayRes = await req({
      path: `/api/bills/${limitedBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: Number(limitedBill.total),
      },
    });
    // Payment must succeed! Never roll back or reject committed payment
    assertEqualOrThrow(limitedPayRes.status, 200, 'payment succeeds despite stock shortfall');
    assertEqualOrThrow(limitedPayRes.body?.bill?.payment_status, 'paid', 'bill is marked paid');

    // Order must transition to release_status = 'blocked'
    const limitedOrderAfterPay = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(limitedOrder.id) as any;
    assertEqualOrThrow(limitedOrderAfterPay.checkout_stage, 'paid', 'stage is paid');
    assertEqualOrThrow(
      limitedOrderAfterPay.release_status,
      'blocked',
      'release_status is blocked (paid-but-blocked)',
    );
    assertIncludesOrThrow(
      limitedOrderAfterPay.release_blocked_reason,
      'Insufficient stock',
      'reason indicates insufficient stock',
    );

    // Blocked order is visible in awaiting-payment queue with blocked_count = 1
    const queueWithBlocked = await req({
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(queueWithBlocked.body?.blocked_count, 1, 'queue reports blocked_count = 1');
    const foundBlocked = queueWithBlocked.body?.orders?.find((o: any) => o.id === limitedOrder.id);
    assertOrThrow(!!foundBlocked, 'blocked order found in queue');
    assertEqualOrThrow(
      foundBlocked.release_status,
      'blocked',
      'queue order shows release_status blocked',
    );

    // Manual release attempt fails while stock is still 0
    const retryFail = await req({
      path: `/api/orders/${limitedOrder.id}/release`,
      method: 'POST',
      headers: manager.authHeader,
    });
    assertEqualOrThrow(retryFail.status, 409, 'release retry fails while stock is 0');
    assertEqualOrThrow(retryFail.body?.code, 'RELEASE_BLOCKED', 'code is RELEASE_BLOCKED');

    // Restock 5 units
    adjustStock(db, 'prod-limited', 5, 'restocked batch', owner.userId);
    assertEqualOrThrow(productStock(db, 'prod-limited'), 5, 'restocked to 5');

    // Manual release retry succeeds!
    const retrySuccess = await req({
      path: `/api/orders/${limitedOrder.id}/release`,
      method: 'POST',
      headers: manager.authHeader,
    });
    assertEqualOrThrow(retrySuccess.status, 200, 'release retry succeeds after restock');
    assertEqualOrThrow(retrySuccess.body?.order?.release_status, 'released', 'order is released');
    assertEqualOrThrow(
      productStock(db, 'prod-limited'),
      4,
      '1 unit deducted on successful release',
    );
    assertLedgerReconciles(db, 'after retry release');

    adjustStock(
      db,
      'prod-limited',
      -productStock(db, 'prod-limited'),
      'clear stock for refund test',
      owner.userId,
    );
    const refundOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-limited', quantity: 1 }],
      },
    });
    assertEqualOrThrow(refundOrderRes.status, 201, 'refund test order created 201');
    const refundOrder = refundOrderRes.body.order;
    const refundBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(refundOrder.id) as any;

    const refundPayRes = await req({
      path: `/api/bills/${refundBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'cash',
        amount: Number(refundBill.total),
      },
    });
    assertEqualOrThrow(refundPayRes.status, 200, 'pay for blocked order 200');

    const refundRes = await req({
      path: '/api/refunds',
      method: 'POST',
      headers: owner.authHeader,
      body: {
        bill_id: refundBill.id,
        amount: Number(refundBill.total) / 100,
        method: 'cash',
        reason: 'Out of stock customer refund',
        approver_id: owner.userId,
        override_pin: '9999',
      },
    });
    assertEqualOrThrow(refundRes.status, 201, 'refund issued 201');

    adjustStock(db, 'prod-limited', 5, 'restock for test', owner.userId);

    const releaseRefundedAttempt = await req({
      path: `/api/orders/${refundOrder.id}/release`,
      method: 'POST',
      headers: manager.authHeader,
    });
    assertEqualOrThrow(
      releaseRefundedAttempt.status,
      409,
      'release of refunded order rejected 409',
    );
    assertEqualOrThrow(
      releaseRefundedAttempt.body?.code,
      'ORDER_NOT_PAID',
      'code is ORDER_NOT_PAID',
    );

    // -------------------------------------------------------------------------
    // 8. Printer Route: Print Payment Ticket
    // -------------------------------------------------------------------------
    console.log('\n--- 8. Printer Ticket Route ---');

    // Test print-payment-ticket preview
    const printPreviewRes = await req({
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        orderId: order1.id,
        preview: true,
      },
    });
    assertEqualOrThrow(printPreviewRes.status, 200, 'ticket preview 200');
    assertEqualOrThrow(printPreviewRes.body?.preview, true, 'preview is true');
    assertOrThrow(Array.isArray(printPreviewRes.body?.bytes), 'bytes array returned');
    assertOrThrow(printPreviewRes.body.bytes.length > 50, 'bytes length > 50');

    // Missing orderId
    const badPrintReq = await req({
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {},
    });
    assertEqualOrThrow(badPrintReq.status, 400, 'missing orderId rejected 400');

    // Item 11: WebUSB printer returns webusb: true and bytes
    const webusbPrinterId = 'printer-webusb-test';
    db.prepare(
      "INSERT OR REPLACE INTO printers (id, name, connection_type, paper_width, is_default) VALUES (?, 'WebUSB Thermal', 'webusb', '80mm', 0)",
    ).run(webusbPrinterId);

    const webusbPrintRes = await req({
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        orderId: order1.id,
        printerId: webusbPrinterId,
      },
    });
    assertEqualOrThrow(webusbPrintRes.status, 200, 'webusb print ticket 200');
    assertEqualOrThrow(webusbPrintRes.body?.webusb, true, 'webusb is true');
    assertOrThrow(Array.isArray(webusbPrintRes.body?.bytes), 'webusb bytes array returned');

    // Item 13, 16, 17: Split-bill balance, currency and timezone formatting on payment ticket
    const splitBalanceOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'dine_in',
        dispatch_policy: 'on_payment',
        table_id: 'tbl-mc-1',
        items: [
          { product_id: 'prod-burger', quantity: 2 },
          { product_id: 'prod-fries', quantity: 2 },
        ],
      },
    });
    const splitBalanceOrder = splitBalanceOrderRes.body.order;
    const splitBalanceSourceBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(splitBalanceOrder.id) as any;
    const sbItems = db
      .prepare('SELECT * FROM order_items WHERE order_id = ?')
      .all(splitBalanceOrder.id) as any[];

    const splitBalanceSplitRes = await req({
      path: `/api/bills/${splitBalanceSourceBill.id}/split-check`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        checks: [
          { label: 'Check 1', items: [{ order_item_id: sbItems[0].id, quantity: 2 }] },
          { label: 'Check 2', items: [{ order_item_id: sbItems[1].id, quantity: 2 }] },
        ],
      },
    });
    assertEqualOrThrow(splitBalanceSplitRes.status, 201, 'split into 2 checks for balance test');
    const [sbCheck1] = splitBalanceSplitRes.body.bills;
    const [, sbCheck2] = splitBalanceSplitRes.body.bills;

    // Pay Check 1 in full
    await req({
      path: `/api/bills/${sbCheck1.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: { method: 'cash', amount: Number(sbCheck1.total) },
    });

    // Check preview print for order - balance due should equal Check 2's balance
    const sbPrintPreview = await req({
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        orderId: splitBalanceOrder.id,
        preview: true,
      },
    });
    assertEqualOrThrow(sbPrintPreview.status, 200, 'split balance print preview 200');
    const previewBytes = Buffer.from(sbPrintPreview.body.bytes);
    const previewText = previewBytes.toString('utf8');
    assertOrThrow(previewText.includes('Balance Due:'), 'print ticket includes Balance Due');
    assertOrThrow(previewText.includes('Date:'), 'print ticket includes localized Date');

    const longTicketName =
      'Extraordinarily long product name with several words reserved amount column';
    db.prepare('UPDATE order_items SET product_name = ? WHERE order_id = ? AND id = ?').run(
      longTicketName,
      splitBalanceOrder.id,
      sbItems[0].id,
    );
    const longBusinessName = 'Cafe Ticket House MerchantName HarborSide NorthShore CoffeeRoasters';
    setStoreSetting(db, 'business_name', longBusinessName);
    const paymentTicketPrinters = [
      { id: 'prn-mc-payment-58', width: '58mm', columns: 32 },
      { id: 'prn-mc-payment-80', width: '80mm-42', columns: 42 },
    ];
    for (const target of paymentTicketPrinters) {
      db.prepare(
        'INSERT OR REPLACE INTO printers (id, name, connection_type, paper_width, is_default) VALUES (?, ?, ?, ?, 0)',
      ).run(target.id, `Payment ${target.width}`, 'network', target.width);
      const response = await req({
        path: '/api/printers/print-payment-ticket',
        method: 'POST',
        headers: serverUser.authHeader,
        body: { orderId: splitBalanceOrder.id, printerId: target.id, preview: true },
      });
      assertEqualOrThrow(response.status, 200, `${target.width} payment ticket preview succeeds`);
      const text = escPosToText(Buffer.from(response.body.bytes));
      assertOrThrow(
        longBusinessName.split(' ').every((word: string) => text.includes(word)),
        `${target.width} wraps the complete business_name`,
      );
      assertOrThrow(
        text.includes('PAYMENT TICKET'),
        `${target.width} has a centered ticket heading`,
      );
      assertOrThrow(text.includes('Balance Due:'), `${target.width} prints balance due`);
      assertOrThrow(
        longTicketName.split(' ').every((word: string) => text.includes(word)),
        `${target.width} wraps the complete long product name`,
      );
      assertOrThrow(
        !/[{](?:CENTER|BOLD|\/(?:CENTER|BOLD))[}]/.test(text),
        `${target.width} does not emit unsupported formatting tokens`,
      );
      const printableLines = text
        .split('\n')
        .filter((line: string) => !/[\x00-\x1f\x7f]/.test(line));
      const overflowLines = printableLines.filter((line: string) => line.length > target.columns);
      assertOrThrow(
        overflowLines.length === 0,
        `${target.width} emitted text fits its configured display columns (${overflowLines.join(' | ')})`,
      );
    }

    const largeTicketAmount = 1_000_000_000_000_000_000;
    db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(
      largeTicketAmount,
      splitBalanceOrder.id,
    );
    db.prepare('UPDATE bills SET balance = ? WHERE id = ?').run(largeTicketAmount, sbCheck2.id);
    const longTicketAmount = '$1,000,000,000,000,000,000.00';
    for (const target of paymentTicketPrinters) {
      const response = await req({
        path: '/api/printers/print-payment-ticket',
        method: 'POST',
        headers: serverUser.authHeader,
        body: { orderId: splitBalanceOrder.id, printerId: target.id, preview: true },
      });
      assertEqualOrThrow(
        response.status,
        200,
        `${target.width} large-amount ticket preview succeeds`,
      );
      const text = escPosToText(Buffer.from(response.body.bytes));
      const lines = text.split('\n');
      for (const label of ['Total:', 'Balance Due:']) {
        const labelIndex = lines.findIndex((line: string) => line.includes(label));
        assertOrThrow(labelIndex >= 0, `${target.width} prints ${label}`);
        if (target.columns === 32) {
          assertOrThrow(
            lines[labelIndex + 1]?.includes(longTicketAmount),
            `${target.width} prints the complete ${label} on a following line`,
          );
        } else {
          assertOrThrow(
            lines
              .slice(labelIndex, labelIndex + 2)
              .some((line: string) => line.includes(longTicketAmount)),
            `${target.width} keeps the complete amount beside ${label}`,
          );
        }
      }
      const printableLines = lines.filter((line: string) => !/[\x00-\x1f\x7f]/.test(line));
      const overflowLines = printableLines.filter((line: string) => line.length > target.columns);
      assertOrThrow(
        overflowLines.length === 0,
        `${target.width} large-amount lines fit the configured columns (${overflowLines.join(' | ')})`,
      );
    }

    const unprintableAmount = 1e30;
    db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(
      unprintableAmount,
      splitBalanceOrder.id,
    );
    db.prepare('UPDATE bills SET balance = ? WHERE id = ?').run(unprintableAmount, sbCheck2.id);
    const unprintableTicket = await req({
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        orderId: splitBalanceOrder.id,
        printerId: paymentTicketPrinters[0].id,
        preview: true,
      },
    });
    assertEqualOrThrow(unprintableTicket.status, 502, 'amount wider than paper is rejected');
    assertOrThrow(
      String(unprintableTicket.body?.error).includes('overflows available line width'),
      'rejected amount reports its width constraint',
    );
    db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(
      largeTicketAmount,
      splitBalanceOrder.id,
    );
    db.prepare('UPDATE bills SET balance = ? WHERE id = ?').run(largeTicketAmount, sbCheck2.id);

    const controlTokenName = `${'X'.repeat(14)} {CUT} ${'Y'.repeat(23)}`;
    db.prepare('UPDATE order_items SET product_name = ? WHERE order_id = ? AND id = ?').run(
      controlTokenName,
      splitBalanceOrder.id,
      sbItems[0].id,
    );
    const controlTokenPreview = await req({
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        orderId: splitBalanceOrder.id,
        printerId: paymentTicketPrinters[0].id,
        preview: true,
      },
    });
    assertEqualOrThrow(controlTokenPreview.status, 200, 'hostile catalog name preview succeeds');
    const controlTokenBytes = Buffer.from(controlTokenPreview.body.bytes);
    const controlTokenCutCount = controlTokenBytes.reduce(
      (count: number, byte: number, index: number, bytes: Buffer) =>
        count + (byte === 0x1d && bytes[index + 1] === 0x56 ? 1 : 0),
      0,
    );
    const controlTokenText = escPosToText(controlTokenBytes);
    assertEqualOrThrow(controlTokenCutCount, 1, 'catalog text cannot inject a printer cut command');
    assertOrThrow(controlTokenText.includes('Balance Due:'), 'ticket continues through balance');
    assertOrThrow(controlTokenText.includes('FLOCAFE-TICKET:'), 'ticket continues through QR text');

    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(splitBalanceOrder.id);

    // Queue amounts retain bill selection while aggregating all bills and refunds in tenant minor units.
    setStoreSetting(db, 'country', 'BH');
    setStoreSetting(db, 'timezone', 'Asia/Bahrain');
    db.prepare("DELETE FROM settings WHERE key = 'currency'").run();
    seedProduct(db, 'prod-mc-bhd-queue', 'cat-mc', 'Bahraini Queue Item', 1, {
      track_inventory: false,
      stock_quantity: 0,
    });
    const bhdQueueOrderRes = await req({
      path: '/api/orders',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        type: 'takeaway',
        dispatch_policy: 'on_payment',
        items: [{ product_id: 'prod-mc-bhd-queue', quantity: 1 }],
      },
    });
    assertEqualOrThrow(bhdQueueOrderRes.status, 201, 'create BHD payment queue order');
    const bhdQueueOrder = bhdQueueOrderRes.body.order;
    const bhdQueueBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(bhdQueueOrder.id) as any;
    db.prepare(
      "UPDATE bills SET paid_amount = 0.996, balance = 0.004, payment_status = 'partial', payment_details = ? WHERE id = ?",
    ).run(JSON.stringify([{ method: 'card', amount: 0.996 }]), bhdQueueBill.id);
    db.prepare(
      `INSERT INTO refunds (bill_id, amount_cents, method, approved_by, created_by, created_at)
       VALUES (?, ?, 'cash', ?, ?, ?)`,
    ).run(bhdQueueBill.id, 100, owner.userId, owner.userId, now());
    const bhdQueueRes = await req({
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(bhdQueueRes.status, 200, 'fetch BHD queue ticket aggregate');
    const bhdQueueTicket = bhdQueueRes.body.orders.find(
      (order: any) => order.id === bhdQueueOrder.id,
    );
    assertOrThrow(!!bhdQueueTicket, 'BHD order appears in payment queue');
    assertEqualOrThrow(bhdQueueTicket.bill_id, bhdQueueBill.id, 'BHD ticket retains selected bill');
    assertEqualOrThrow(
      Number(bhdQueueTicket.balance).toFixed(3),
      '0.004',
      'selected bill balance stays precise',
    );
    assertEqualOrThrow(
      Number(bhdQueueTicket.paid_amount).toFixed(3),
      '0.996',
      'selected bill paid amount stays precise',
    );
    assertEqualOrThrow(
      Number(bhdQueueTicket.ticket_balance).toFixed(3),
      '0.004',
      'aggregate balance stays precise',
    );
    assertEqualOrThrow(
      Number(bhdQueueTicket.ticket_paid_amount).toFixed(3),
      '0.896',
      'aggregate paid amount accounts for refund',
    );
    setStoreSetting(db, 'country', 'US');
    setStoreSetting(db, 'currency', 'USD');
    setStoreSetting(db, 'timezone', 'America/New_York');

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    const results = getResults();
    console.log('\n' + '='.repeat(66));
    console.log(`Multi-counter ordering test results: Passed ${results.passed}/${results.total}`);
    assertEqualOrThrow(results.failed, 0, 'zero failed assertions');
  } finally {
    stopScheduledOrderSweep();
    await stopKdsServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Multi-counter ordering test failed:', err);
  process.exit(1);
});
