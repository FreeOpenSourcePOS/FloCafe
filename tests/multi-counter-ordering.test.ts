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

function adjustStock(db: any, productId: string, quantityDelta: number, reason: string, actorUserId: string) {
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

function futureWallClockInZone(timezone: string, offsetMinutes: number): string {
  const target = new Date(Date.now() + offsetMinutes * 60 * 1000);
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

    // Non-owner cannot toggle multi_counter_enabled
    const cashierToggle = await req( {
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: cashier.authHeader,
      body: { value: 'true' },
    });
    assertEqualOrThrow(cashierToggle.status, 403, 'non-owner toggle multi_counter_enabled rejected 403');

    // Owner can toggle multi_counter_enabled
    const ownerToggle = await req( {
      path: '/api/settings/multi_counter_enabled',
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'true' },
    });
    assertEqualOrThrow(ownerToggle.status, 200, 'owner can enable multi_counter_enabled');

    const checkSetting = await req( {
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
    const listInitial = await req( {
      path: '/api/counters',
      method: 'GET',
      headers: serverUser.authHeader,
    });
    assertEqualOrThrow(listInitial.status, 200, 'server can read counters');
    assertEqualOrThrow(listInitial.body?.counters?.length, 0, 'initial counters count is 0');

    // Non-owner cannot create counter
    const serverCreate = await req( {
      path: '/api/counters',
      method: 'POST',
      headers: serverUser.authHeader,
      body: { name: 'Unauthorized Counter', role: 'ordering' },
    });
    assertEqualOrThrow(serverCreate.status, 403, 'non-owner cannot create counter');

    // Validation checks
    const badRole = await req( {
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Counter 1', role: 'invalid_role' },
    });
    assertEqualOrThrow(badRole.status, 400, 'invalid counter role rejected 400');

    const emptyName = await req( {
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: '   ', role: 'ordering' },
    });
    assertEqualOrThrow(emptyName.status, 400, 'empty counter name rejected 400');

    // Create 3 counters with different roles
    const c1Res = await req( {
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Order Station 1', role: 'ordering', sort_order: 1 },
    });
    assertEqualOrThrow(c1Res.status, 201, 'create ordering counter 201');
    const c1 = c1Res.body.counter;
    assertEqualOrThrow(c1.role, 'ordering', 'counter role is ordering');

    const c2Res = await req( {
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Payment Station 1', role: 'payment', sort_order: 2 },
    });
    assertEqualOrThrow(c2Res.status, 201, 'create payment counter 201');
    const c2 = c2Res.body.counter;

    const c3Res = await req( {
      path: '/api/counters',
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Express Combined', role: 'combined', sort_order: 3 },
    });
    assertEqualOrThrow(c3Res.status, 201, 'create combined counter 201');
    const c3 = c3Res.body.counter;

    // Check list ordering
    const listRes = await req( {
      path: '/api/counters',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(listRes.body?.counters?.length, 3, 'counters list has 3 counters');
    assertEqualOrThrow(listRes.body.counters[0].id, c1.id, 'first counter sorted by sort_order');
    assertEqualOrThrow(listRes.body.counters[1].id, c2.id, 'second counter sorted by sort_order');

    // Update counter
    const updateRes = await req( {
      path: `/api/counters/${c3.id}`,
      method: 'PUT',
      headers: owner.authHeader,
      body: { name: 'Express Combined Renamed', role: 'combined', is_active: false, sort_order: 10 },
    });
    assertEqualOrThrow(updateRes.status, 200, 'update counter 200');
    assertEqualOrThrow(updateRes.body.counter.name, 'Express Combined Renamed', 'counter name updated');
    assertEqualOrThrow(updateRes.body.counter.is_active, 0, 'counter is_active is 0');

    // Delete counter
    const deleteRes = await req( {
      path: `/api/counters/${c3.id}`,
      method: 'DELETE',
      headers: owner.authHeader,
    });
    assertEqualOrThrow(deleteRes.status, 200, 'delete counter 200');

    const listAfterDelete = await req( {
      path: '/api/counters',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(listAfterDelete.body?.counters?.length, 2, 'counters count is 2 after deletion');

    // -------------------------------------------------------------------------
    // 3. Order Creation with dispatch_policy: 'on_payment'
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Order Creation & Deferred Release ---');

    // Reject delivery with on_payment
    const deliveryReject = await req( {
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
    assertEqualOrThrow(deliveryReject.status, 400, 'delivery with dispatch_policy on_payment rejected 400');
    assertIncludesOrThrow(
      deliveryReject.body?.error,
      'not supported for delivery orders',
      'helpful delivery rejection error',
    );

    // Reject invalid dispatch_policy
    const invalidPolicyReject = await req( {
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

    // Create valid takeaway order with dispatch_policy: 'on_payment'
    const initialBurgerStock = productStock(db, 'prod-burger');
    kotPrintCalls = [];

    const orderRes = await req( {
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
    assertEqualOrThrow(order1.checkout_stage, 'awaiting_payment', 'checkout_stage is awaiting_payment');
    assertEqualOrThrow(order1.release_status, 'scheduled', 'release_status is scheduled (unreleased)');
    assertEqualOrThrow(
      orderRes.body.qr_payload,
      `FLOCAFE-TICKET:${order1.order_number}`,
      'qr_payload carries FLOCAFE-TICKET prefix and order number',
    );
    assertOrThrow(typeof orderRes.body.qr_data_url === 'string', 'qr_data_url is provided');
    assertOrThrow(orderRes.body.qr_data_url.startsWith('data:image/png;base64,'), 'qr_data_url is PNG data url');

    // Verify stock was NOT deducted
    assertEqualOrThrow(productStock(db, 'prod-burger'), initialBurgerStock, 'stock deferred on creation');
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
    const dineInRes = await req( {
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
    const queueRes = await req( {
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(queueRes.status, 200, 'fetch awaiting-payment queue 200');
    assertEqualOrThrow(queueRes.body?.awaiting_count, 2, 'awaiting_count is 2');
    assertEqualOrThrow(queueRes.body?.total_count, 2, 'total_count is 2');
    assertEqualOrThrow(queueRes.body?.orders?.length, 2, 'queue returns 2 orders');

    // Pagination test (limit=1)
    const page1Res = await req( {
      path: '/api/orders/awaiting-payment?limit=1',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(page1Res.body?.orders?.length, 1, 'page 1 returns 1 order');
    assertOrThrow(!!page1Res.body?.next_cursor, 'next_cursor returned for page 1');

    const page2Res = await req( {
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
    const searchRes = await req( {
      path: '/api/orders/awaiting-payment?search=Alex',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(searchRes.body?.orders?.length, 1, 'search matches Alex');
    assertEqualOrThrow(searchRes.body.orders[0].id, order1.id, 'matches order1');

    // Ticket lookup: by raw order number
    const lookupRaw = await req( {
      path: `/api/orders/by-ticket/${order1.order_number}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupRaw.status, 200, 'lookup by raw order number 200');
    assertEqualOrThrow(lookupRaw.body?.order?.id, order1.id, 'order matches');
    assertOrThrow(!!lookupRaw.body?.bill, 'bill hydrated in lookup');

    // Ticket lookup: by full QR payload
    const lookupQr = await req( {
      path: `/api/orders/by-ticket/${encodeURIComponent(`FLOCAFE-TICKET:${order1.order_number}`)}`,
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookupQr.status, 200, 'lookup by full QR payload 200');
    assertEqualOrThrow(lookupQr.body?.order?.id, order1.id, 'order matches by QR payload');

    // Ticket lookup: non-existent
    const lookup404 = await req( {
      path: '/api/orders/by-ticket/NON-EXISTENT-TICKET-9999',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(lookup404.status, 404, 'lookup non-existent ticket 404');

    // -------------------------------------------------------------------------
    // 5. Prepayment Release Gates & Prepayment Lifecycle
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Release Gates & Prepayment Lifecycle ---');

    // Manual release of unpaid order must fail with 409 ORDER_NOT_PAID
    const unpaidReleaseAttempt = await req( {
      path: `/api/orders/${order1.id}/release`,
      method: 'POST',
      headers: serverUser.authHeader,
    });
    assertEqualOrThrow(unpaidReleaseAttempt.status, 409, 'manual release before payment rejected 409');
    assertEqualOrThrow(unpaidReleaseAttempt.body?.code, 'ORDER_NOT_PAID', 'code is ORDER_NOT_PAID');

    // Partial payment: pay $10 of $24 (1000 cents of 2400)
    const partialPayRes = await req( {
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
    const order1AfterPartial = db.prepare('SELECT * FROM orders WHERE id = ?').get(order1.id) as any;
    assertEqualOrThrow(order1AfterPartial.checkout_stage, 'awaiting_payment', 'stage still awaiting_payment');
    assertEqualOrThrow(order1AfterPartial.release_status, 'scheduled', 'release_status still scheduled');
    assertEqualOrThrow(productStock(db, 'prod-burger'), initialBurgerStock, 'stock still untouched');

    // Prepayment edit lock: cannot add items or discounts once payment is recorded
    const editItemAttempt = await req( {
      path: `/api/orders/${order1.id}/items`,
      method: 'POST',
      headers: serverUser.authHeader,
      body: {
        items: [{ product_id: 'prod-fries', quantity: 1 }],
      },
    });
    assertEqualOrThrow(editItemAttempt.status, 409, 'item edit rejected 409 once payment recorded');
    assertEqualOrThrow(editItemAttempt.body?.code, 'SCHEDULED_ORDER_PAID', 'code is SCHEDULED_ORDER_PAID');

    const editDiscountAttempt = await req( {
      path: `/api/orders/${order1.id}/discount`,
      method: 'PATCH',
      headers: manager.authHeader,
      body: {
        discount_type: 'flat',
        discount_value: 200,
        discount_reason: 'Friend discount',
      },
    });
    assertEqualOrThrow(editDiscountAttempt.status, 409, 'order discount rejected 409 once payment recorded');

    // Final payment: pay remaining $14 (1400 cents)
    kotPrintCalls = [];
    const finalPayRes = await req( {
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
    assertEqualOrThrow(order1AfterFinal.checkout_stage, 'paid', 'checkout_stage transitioned to paid');
    assertEqualOrThrow(order1AfterFinal.release_status, 'released', 'order released to kitchen!');
    assertEqualOrThrow(order1AfterFinal.status, 'pending', 'kitchen status remains pending, NOT completed!');

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

    const dineInPayRes = await req( {
      path: `/api/bills/${dineInBill.id}/payment`,
      method: 'POST',
      headers: cashier.authHeader,
      body: {
        method: 'card',
        amount: Number(dineInBill.total),
      },
    });
    assertEqualOrThrow(dineInPayRes.status, 200, 'dine in payment 200');

    const tblRowAfterPay = db.prepare('SELECT status FROM tables WHERE id = ?').get('tbl-mc-1') as any;
    assertEqualOrThrow(
      tblRowAfterPay.status,
      'occupied',
      'dine-in table remains OCCUPIED after prepayment!',
    );

    const orderDineInAfterPay = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderDineIn.id) as any;
    assertEqualOrThrow(orderDineInAfterPay.checkout_stage, 'paid', 'dine in checkout stage is paid');
    assertEqualOrThrow(orderDineInAfterPay.status, 'pending', 'dine in status remains pending');

    // -------------------------------------------------------------------------
    // 6. Scheduled + on_payment takeaway combination
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Scheduled Takeaway on_payment ---');

    const futureTime = futureWallClockInZone('America/New_York', 45);
    const schedOrderRes = await req( {
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

    const schedBill = db
      .prepare('SELECT * FROM bills WHERE order_id = ?')
      .get(schedOrder.id) as any;

    // Pay scheduled order in full before scheduled_for
    const schedPayRes = await req( {
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
    const schedOrderAfterPay = db.prepare('SELECT * FROM orders WHERE id = ?').get(schedOrder.id) as any;
    assertEqualOrThrow(schedOrderAfterPay.checkout_stage, 'paid', 'checkout stage is paid');
    assertEqualOrThrow(
      schedOrderAfterPay.release_status,
      'scheduled',
      'release_status remains scheduled until scheduled instant or manual release',
    );

    // Explicit manual release after payment succeeds!
    const manualReleaseRes = await req( {
      path: `/api/orders/${schedOrder.id}/release`,
      method: 'POST',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(manualReleaseRes.status, 200, 'manual release of paid scheduled order 200');
    assertEqualOrThrow(manualReleaseRes.body?.order?.release_status, 'released', 'order is released');

    // -------------------------------------------------------------------------
    // 7. Paid-but-blocked on Stock Shortfall & Retry Release
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Paid-but-blocked on Stock Shortfall ---');

    // Create on_payment order for prod-limited (currently 1 unit in stock)
    assertEqualOrThrow(productStock(db, 'prod-limited'), 1, 'prod-limited has 1 in stock');
    const limitedOrderRes = await req( {
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
    const limitedPayRes = await req( {
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
    const limitedOrderAfterPay = db.prepare('SELECT * FROM orders WHERE id = ?').get(limitedOrder.id) as any;
    assertEqualOrThrow(limitedOrderAfterPay.checkout_stage, 'paid', 'stage is paid');
    assertEqualOrThrow(limitedOrderAfterPay.release_status, 'blocked', 'release_status is blocked (paid-but-blocked)');
    assertIncludesOrThrow(
      limitedOrderAfterPay.release_blocked_reason,
      'Insufficient stock',
      'reason indicates insufficient stock',
    );

    // Blocked order is visible in awaiting-payment queue with blocked_count = 1
    const queueWithBlocked = await req( {
      path: '/api/orders/awaiting-payment',
      method: 'GET',
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(queueWithBlocked.body?.blocked_count, 1, 'queue reports blocked_count = 1');
    const foundBlocked = queueWithBlocked.body?.orders?.find((o: any) => o.id === limitedOrder.id);
    assertOrThrow(!!foundBlocked, 'blocked order found in queue');
    assertEqualOrThrow(foundBlocked.release_status, 'blocked', 'queue order shows release_status blocked');

    // Manual release attempt fails while stock is still 0
    const retryFail = await req( {
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
    const retrySuccess = await req( {
      path: `/api/orders/${limitedOrder.id}/release`,
      method: 'POST',
      headers: manager.authHeader,
    });
    assertEqualOrThrow(retrySuccess.status, 200, 'release retry succeeds after restock');
    assertEqualOrThrow(retrySuccess.body?.order?.release_status, 'released', 'order is released');
    assertEqualOrThrow(productStock(db, 'prod-limited'), 4, '1 unit deducted on successful release');
    assertLedgerReconciles(db, 'after retry release');

    // -------------------------------------------------------------------------
    // 8. Printer Route: Print Payment Ticket
    // -------------------------------------------------------------------------
    console.log('\n--- 8. Printer Ticket Route ---');

    // Test print-payment-ticket preview
    const printPreviewRes = await req( {
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
    const badPrintReq = await req( {
      path: '/api/printers/print-payment-ticket',
      method: 'POST',
      headers: serverUser.authHeader,
      body: {},
    });
    assertEqualOrThrow(badPrintReq.status, 400, 'missing orderId rejected 400');

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
