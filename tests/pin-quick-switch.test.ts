/**
 * Issue #1338: PIN quick user switch with user picker (PIN for all roles, approvals stay owner/manager).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';

const Module = require('module');
const frontendRequire = Module.createRequire(path.join(process.cwd(), 'frontend/package.json'));
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pin-quick-switch-'));

let mockApiHandler: {
  get?: (url: string) => Promise<any>;
  post?: (url: string, body?: any) => Promise<any>;
} = {};

const mockPosSettingsStore = {
  state: {
    language: 'en',
    billTemplateSource: 'core' as 'core' | null,
    billLanguagePolicy: null as unknown,
    kotLanguagePolicy: null as unknown,
    autoLockMinutes: 0,
    setLanguage(language: string) {
      this.language = language;
    },
    setBillTemplateSource(source: 'core' | null) {
      this.billTemplateSource = source;
    },
    setBillLanguagePolicy(policy: unknown) {
      this.billLanguagePolicy = policy;
    },
    setKotLanguagePolicy(policy: unknown) {
      this.kotLanguagePolicy = policy;
    },
    setAutoLockMinutes(mins: number) {
      this.autoLockMinutes = mins;
    },
  },
  getState() {
    return this.state;
  },
};

Module._load = function (reqName: string, parent: unknown, isMain: boolean) {
  if (reqName === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  if (reqName === '@/lib/api') {
    return {
      get: (...args: [string]) => mockApiHandler.get?.(...args),
      post: (...args: [string, any]) => mockApiHandler.post?.(...args),
    };
  }
  if (reqName === '@/store/pos-settings') {
    return { usePosSettingsStore: mockPosSettingsStore };
  }
  if (reqName === '@/lib/cart-identity') {
    return originalLoad.call(
      this,
      path.join(process.cwd(), 'frontend/src/lib/cart-identity.ts'),
      parent,
      isMain,
    );
  }
  if (reqName === '@/lib/cart-price') {
    return originalLoad.call(
      this,
      path.join(process.cwd(), 'frontend/src/lib/cart-price.ts'),
      parent,
      isMain,
    );
  }
  if (reqName === 'zustand') {
    return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  seedTable,
  seedCategory,
  seedProduct,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const { staffRoutes } = require('../main/routes/staff');
const {
  billRoutes,
  resetPinRateLimitForTests: resetBillPinRateLimit,
} = require('../main/routes/bills');
const {
  orderRoutes,
  resetPinRateLimitForTests: resetOrderPinRateLimit,
} = require('../main/routes/orders');
const { settingsRoutes } = require('../main/routes/settings');
const { refundRoutes } = require('../main/routes/refunds');
const { resetSuccessfulLogin } = require('../main/middleware/security');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function run() {
  console.log('Testing PIN Quick User Switch & Approval Hardening (#1338)...');
  console.log('='.repeat(64));

  const db = initTestDb();
  resetBillPinRateLimit();
  resetOrderPinRateLimit();

  const ts = now();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_requires_approval', 'true', ?)",
  ).run(ts);

  // Seed owner (PIN 2468) and manager (PIN 1357)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('owner-1', 'Alice Owner', 'owner@test.local', ?, 'owner', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('OwnerPass1!', 10), bcrypt.hashSync('2468', 10), ts, ts);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-1', 'Bob Manager', 'manager@test.local', ?, 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('MgrPass1!', 10), bcrypt.hashSync('1357', 10), ts, ts);

  // Seed user without PIN (server) and inactive user with PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('server-no-pin', 'NoPin Server', 'server@test.local', ?, 'server', NULL, 1, ?, ?)
  `).run(bcrypt.hashSync('SrvPass1!', 10), ts, ts);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('inactive-pin', 'Inactive Chef', 'inactive@test.local', ?, 'chef', ?, 0, ?, ?)
  `).run(bcrypt.hashSync('ChefPass1!', 10), bcrypt.hashSync('9999', 10), ts, ts);

  const ownerAuth = makeToken('owner-1', 'owner', 'owner@test.local');
  const managerAuth = makeToken('mgr-1', 'manager', 'manager@test.local');

  const app = createApp({
    '/api/auth': authRoutes,
    '/api/staff': staffRoutes,
    '/api/bills': billRoutes,
    '/api/orders': orderRoutes,
    '/api/settings': settingsRoutes,
    '/api/refunds': refundRoutes,
  });

  // ── 1. Cashier setting a PIN and signing in via POST /api/auth/pin-login ──
  console.log('\n1. Cashier setting a PIN (shared PIN 2468 with owner) and signing in');
  const createCashierRes = await request(app).post('/api/staff').set(managerAuth).send({
    name: 'Charlie Cashier',
    email: 'cashier@test.local',
    password: 'CashierPass1!',
    role: 'cashier',
    pin: '2468', // Same PIN as owner-1!
  });
  assertEqualOrThrow(createCashierRes.status, 201, 'Manager can create cashier with a 4-6 digit PIN');
  const cashierId = createCashierRes.body.staff.id as string;
  assertEqualOrThrow(createCashierRes.body.staff.has_pin, 1, 'Created cashier has_pin is 1');

  // Update cashier PIN to 5555 and back to 2468 via PUT /api/staff/:id
  const updateCashierPinRes = await request(app)
    .put(`/api/staff/${cashierId}`)
    .set(managerAuth)
    .send({ pin: '5555' });
  assertEqualOrThrow(updateCashierPinRes.status, 200, 'Manager can update cashier PIN');

  const restoreSharedPinRes = await request(app)
    .put(`/api/staff/${cashierId}`)
    .set(managerAuth)
    .send({ pin: '2468' });
  assertEqualOrThrow(restoreSharedPinRes.status, 200, 'Cashier can share PIN 2468 with owner');

  // ── 2. Quick-switch directory omits users without PIN and inactive users ──
  console.log('\n2. GET /api/auth/pin-users returns only active users with PIN');
  const pickerRes = await request(app).get('/api/auth/pin-users');
  assertEqualOrThrow(pickerRes.status, 200, 'GET /api/auth/pin-users returns 200');
  const pickerUsers = pickerRes.body.users as Array<Record<string, unknown>>;
  assertEqualOrThrow(pickerUsers.length, 3, 'Picker includes owner, manager, and cashier with PIN');
  assertOrThrow(
    !pickerUsers.some((u) => u.id === 'server-no-pin'),
    'User without a PIN is omitted from quick-switch picker',
  );
  assertOrThrow(
    !pickerUsers.some((u) => u.id === 'inactive-pin'),
    'Inactive user with a PIN is omitted from quick-switch picker',
  );
  for (const u of pickerUsers) {
    assertEqualOrThrow(
      Object.keys(u).sort().join(','),
      'id,name,role',
      'Picker exposes only id, name, role',
    );
  }

  // ── 3. Two users with the same PIN each sign in as themselves ──
  console.log('\n3. Two users sharing PIN 2468 sign in as themselves via POST /api/auth/pin-login');
  const ownerPinLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'owner-1', pin: '2468' });
  assertEqualOrThrow(ownerPinLogin.status, 200, 'Owner signs in with PIN 2468');
  assertEqualOrThrow(ownerPinLogin.body.user.id, 'owner-1', 'Owner PIN login returns owner-1');
  assertEqualOrThrow(ownerPinLogin.body.user.role, 'owner', 'Owner PIN login returns owner role');
  assertOrThrow(Boolean(ownerPinLogin.body.access_token), 'Owner PIN login issues access_token');

  const cashierPinLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: cashierId, pin: '2468' });
  assertEqualOrThrow(cashierPinLogin.status, 200, 'Cashier signs in with same PIN 2468');
  assertEqualOrThrow(cashierPinLogin.body.user.id, cashierId, 'Cashier PIN login returns cashierId');
  assertEqualOrThrow(
    cashierPinLogin.body.user.role,
    'cashier',
    'Cashier PIN login returns cashier role',
  );
  assertOrThrow(
    ownerPinLogin.body.access_token !== cashierPinLogin.body.access_token,
    'Owner and cashier receive distinct tokens',
  );

  // User without PIN cannot sign in via pin-login
  const noPinLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'server-no-pin', pin: '2468' });
  assertEqualOrThrow(noPinLogin.status, 401, 'User without PIN is rejected on pin-login');

  // ── 4. Per-user rate limiting and audit logging on POST /api/auth/pin-login ──
  console.log('\n4. Wrong PIN rate limiting per user and auth_audit_log rows');
  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wrongRes = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: cashierId, pin: '0000' });
    assertEqualOrThrow(wrongRes.status, 401, `Wrong PIN attempt ${attempt} returns 401`);
    assertEqualOrThrow(
      wrongRes.body.attempts_remaining,
      5 - attempt,
      `Attempt ${attempt} reports ${5 - attempt} attempts remaining`,
    );
  }
  const lockedOutRes = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: cashierId, pin: '2468' });
  assertEqualOrThrow(
    lockedOutRes.status,
    429,
    '6th attempt for locked-out user returns 429 even with correct PIN',
  );

  // Another user on the same device/IP is NOT locked out by cashierId's failed attempts
  const ownerStillCanLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'owner-1', pin: '2468' });
  assertEqualOrThrow(
    ownerStillCanLogin.status,
    200,
    'Rate limit is scoped per user so owner-1 can still sign in on the same terminal',
  );

  const auditRows = db
    .prepare(
      "SELECT user_id, event_type, outcome FROM auth_audit_log WHERE event_type = 'pin_login' ORDER BY id ASC",
    )
    .all() as Array<{ user_id: string; event_type: string; outcome: string }>;
  assertOrThrow(
    auditRows.some((r) => r.user_id === 'owner-1' && r.outcome === 'success'),
    'Audit log records successful owner PIN sign-in',
  );
  assertOrThrow(
    auditRows.some((r) => r.user_id === cashierId && r.outcome === 'success'),
    'Audit log records successful cashier PIN sign-in',
  );
  assertEqualOrThrow(
    auditRows.filter((r) => r.user_id === cashierId && r.outcome === 'failure').length,
    5,
    'Audit log records 5 failed PIN attempts for cashier',
  );
  assertOrThrow(
    auditRows.some((r) => r.user_id === cashierId && r.outcome === 'rate_limited'),
    'Audit log records rate_limited outcome on 6th attempt',
  );

  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);

  // ── 5. Cashier PIN rejected on EVERY approval endpoint ──
  console.log('\n5. Cashier PIN rejected on every approval endpoint');
  const cashierAuth = makeToken(cashierId, 'cashier', 'cashier@test.local');

  // Grant cashier configurable permissions so only the owner/manager approval check stands between them
  const grantPermStmt = db.prepare(`
    INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
    VALUES (?, ?, 'allow', 'owner-1', ?)
  `);
  for (const perm of [
    'bills.discount.apply',
    'orders.discount.apply',
    'orders.item.cancel',
    'orders.status.update',
    'payments.take',
    'bills.read',
    'bills.generate',
  ]) {
    grantPermStmt.run(cashierId, perm, ts);
  }

  // (a) GET /api/staff/approvers omits cashier
  const approversRes = await request(app).get('/api/staff/approvers').set(cashierAuth);
  assertEqualOrThrow(approversRes.status, 200, 'GET /api/staff/approvers returns 200');
  assertOrThrow(
    !approversRes.body.approvers.some((a: any) => a.id === cashierId),
    'Cashier with PIN is excluded from GET /api/staff/approvers',
  );

  // Set a distinct PIN on cashier (7777) so fallback PIN scanning cannot match owner-1 (2468)
  await request(app).put(`/api/staff/${cashierId}`).set(managerAuth).send({ pin: '7777' });

  // Even when a store grants cashier route permissions for discounts, item cancel, and refunds,
  // cashier PINs must STILL be rejected on every PIN approval check (only owner/manager PINs approve).
  for (const permId of ['bills.discount.apply', 'orders.item.cancel', 'refunds.initiate']) {
    db.prepare(`
      INSERT OR REPLACE INTO role_permission_overrides (role, permission_id, effect, updated_by, updated_at)
      VALUES ('cashier', ?, 'allow', 'owner-1', ?)
    `).run(permId, ts);
  }

  // Seed an active order + item + bill for discount, void, status, kitchen-delivery, charge waiver, and refund tests
  const tableId = 'tbl-pin-test';
  seedTable(db, tableId, 1, 4);
  db.prepare('UPDATE tables SET status = ? WHERE id = ?').run('occupied', tableId);

  const catId = 'cat-pin-test';
  seedCategory(db, catId, 'Main Course');

  const prodId = 'prod-pin-test';
  seedProduct(db, prodId, catId, 'Espresso', 100);

  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('custom_charges', ?, ?)",
  ).run(
    JSON.stringify([
      {
        id: 'service_charge',
        name: 'Service Charge',
        type: 'percentage',
        value: 10,
        calculation_basis: 'net',
        order_types: ['dine_in'],
        is_optional: true,
        is_default_active: true,
        is_active: true,
      },
    ]),
    ts,
  );

  const initialChargesBreakdown = JSON.stringify([
    {
      id: 'service_charge',
      name: 'Service Charge',
      type: 'percentage',
      rate: 10,
      calculation_basis: 'net',
      amount: 10,
      waived: false,
    },
  ]);

  db.prepare(`
    INSERT INTO orders (order_number, type, table_id, subtotal, tax_amount, service_charge, charges_breakdown, total, status, user_id, created_at, updated_at)
    VALUES ('ORD-PIN-001', 'dine_in', ?, 100, 0, 10, ?, 110, 'preparing', ?, ?, ?)
  `).run(tableId, initialChargesBreakdown, cashierId, ts, ts);
  const orderId = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-PIN-001'").get() as any
  ).id;

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, 'Espresso', 1, 100, 100, 0, 100, 'preparing', ?, ?)
  `).run(orderId, prodId, ts, ts);
  const orderItemId = (
    db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any
  ).id;

  db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, service_charge, packaging_charge, charges_breakdown, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES ('BILL-PIN-001', ?, 100, 0, 10, 0, ?, 110, 0, 110, 'unpaid', ?, ?)
  `).run(orderId, initialChargesBreakdown, ts, ts);
  const billId = (
    db.prepare("SELECT id FROM bills WHERE bill_number = 'BILL-PIN-001'").get() as any
  ).id;

  // (b) Bill discount with cashier PIN -> 403
  resetBillPinRateLimit();
  const billDiscCashierScan = await request(app)
    .post(`/api/bills/${billId}/discount`)
    .set(cashierAuth)
    .send({ type: 'percentage', value: 10, override_pin: '7777' });
  assertEqualOrThrow(
    billDiscCashierScan.status,
    403,
    'Bill discount rejects cashier PIN (scan path) with 403',
  );

  const billDiscCashierTargeted = await request(app)
    .post(`/api/bills/${billId}/discount`)
    .set(cashierAuth)
    .send({ type: 'percentage', value: 10, approver_id: cashierId, override_pin: '7777' });
  assertEqualOrThrow(
    billDiscCashierTargeted.status,
    403,
    'Bill discount rejects cashier PIN (targeted approver_id) with 403',
  );

  // (c) Order discount & order item discount with cashier PIN -> 403
  resetOrderPinRateLimit();
  const orderDiscCashier = await request(app)
    .patch(`/api/orders/${orderId}/discount`)
    .set(cashierAuth)
    .send({ discount_type: 'percentage', discount_value: 10, override_pin: '7777' });
  assertEqualOrThrow(orderDiscCashier.status, 403, 'Order discount rejects cashier PIN with 403');

  const itemDiscCashier = await request(app)
    .patch(`/api/orders/${orderId}/items/${orderItemId}/discount`)
    .set(cashierAuth)
    .send({ discount_type: 'percentage', discount_value: 10, override_pin: '7777' });
  assertEqualOrThrow(
    itemDiscCashier.status,
    403,
    'Order item discount rejects cashier PIN with 403',
  );

  // (d) Item void (cancel in-progress preparing item) with cashier PIN -> 403
  resetOrderPinRateLimit();
  const itemVoidCashierScan = await request(app)
    .patch(`/api/orders/${orderId}/items/${orderItemId}/cancel`)
    .set(cashierAuth)
    .send({ reason: 'Customer changed mind', override_pin: '7777' });
  assertEqualOrThrow(
    itemVoidCashierScan.status,
    403,
    'In-progress item void rejects cashier PIN (scan path) with 403',
  );

  const itemVoidCashierTargeted = await request(app)
    .patch(`/api/orders/${orderId}/items/${orderItemId}/cancel`)
    .set(cashierAuth)
    .send({ reason: 'Customer changed mind', approver_id: cashierId, override_pin: '7777' });
  assertEqualOrThrow(
    itemVoidCashierTargeted.status,
    403,
    'In-progress item void rejects cashier PIN (targeted approver_id) with 403',
  );

  // (e) Order-status override (cancel preparing order, complete unpaid order) with cashier PIN -> 403
  resetOrderPinRateLimit();
  const orderCancelCashier = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set(cashierAuth)
    .send({ status: 'cancelled', override_pin: '7777' });
  assertEqualOrThrow(
    orderCancelCashier.status,
    403,
    'Order cancel override rejects cashier PIN with 403',
  );

  const orderCompleteCashier = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set(cashierAuth)
    .send({ status: 'completed', approver_id: cashierId, override_pin: '7777' });
  assertEqualOrThrow(
    orderCompleteCashier.status,
    403,
    'Order complete override rejects cashier PIN with 403',
  );

  // (f) Charge waiver on bill (service/packaging/custom charge waiver) with cashier PIN -> 403
  resetBillPinRateLimit();
  const chargeWaiveNoPin = await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(cashierAuth)
    .send({ charge_id: 'service_charge', waived: true });
  assertEqualOrThrow(
    chargeWaiveNoPin.status,
    403,
    'Cashier cannot waive a bill charge without an owner/manager approval PIN',
  );

  const chargeWaiveCashierPin = await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(cashierAuth)
    .send({
      charge_id: 'service_charge',
      waived: true,
      approver_id: cashierId,
      override_pin: '7777',
    });
  assertEqualOrThrow(
    chargeWaiveCashierPin.status,
    403,
    'Charge waiver rejects cashier PIN with 403',
  );

  const chargeWaiveManagerPin = await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(cashierAuth)
    .send({
      charge_id: 'service_charge',
      waived: true,
      approver_id: 'mgr-1',
      override_pin: '1357',
    });
  assertEqualOrThrow(
    chargeWaiveManagerPin.status,
    200,
    'Charge waiver succeeds when authorized with manager PIN',
  );

  // Restore charge to un-waived for payment test
  await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(ownerAuth)
    .send({ charge_id: 'service_charge', waived: false });

  // (g) Kitchen-delivery override on bill payment and table payment with cashier PIN -> 403
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_kitchen_delivered_before_settlement', 'true', ?)",
  ).run(ts);
  resetBillPinRateLimit();

  const billPayKitchenOverrideCashier = await request(app)
    .post(`/api/bills/${billId}/payments`)
    .set(cashierAuth)
    .send({
      payments: [{ method: 'card', amount: 110 }],
      override_pin: '7777',
      approver_id: cashierId,
    });
  assertEqualOrThrow(
    billPayKitchenOverrideCashier.status,
    403,
    'Kitchen-delivery payment override rejects cashier PIN with 403',
  );

  const singlePayKitchenOverrideCashier = await request(app)
    .post(`/api/bills/${billId}/payment`)
    .set(cashierAuth)
    .send({
      method: 'card',
      amount: 110,
      override_pin: '7777',
    });
  assertEqualOrThrow(
    singlePayKitchenOverrideCashier.status,
    403,
    'Single payment kitchen-delivery override rejects cashier PIN with 403',
  );

  // Settle bill with valid manager PIN override so we can test refund approval
  const billPayWithManagerPin = await request(app)
    .post(`/api/bills/${billId}/payments`)
    .set(cashierAuth)
    .send({
      payments: [{ method: 'card', amount: 110 }],
      approver_id: 'mgr-1',
      override_pin: '1357',
    });
  assertEqualOrThrow(
    billPayWithManagerPin.status,
    200,
    'Kitchen-delivery payment override succeeds with manager PIN',
  );

  // (h) Refund with cashier PIN -> 403
  resetBillPinRateLimit();
  const refundCashierPin = await request(app)
    .post('/api/refunds')
    .set(cashierAuth)
    .send({
      bill_id: billId,
      amount: 20,
      reason: 'Customer complaint',
      method: 'card',
      approver_id: cashierId,
      override_pin: '7777',
    });
  assertEqualOrThrow(refundCashierPin.status, 403, 'Refund rejects cashier PIN with 403');

  const refundValidOwnerPin = await request(app)
    .post('/api/refunds')
    .set(cashierAuth)
    .send({
      bill_id: billId,
      amount: 20,
      reason: 'Customer complaint',
      method: 'card',
      approver_id: 'owner-1',
      override_pin: '2468',
    });
  assertEqualOrThrow(
    refundValidOwnerPin.status,
    201,
    'Refund succeeds with valid owner approver_id and PIN',
  );

  // ── 6. Auto-lock setting validation ──
  console.log('\n6. Idle auto-lock store setting (off by default; 1, 5, 15, or 30 minutes)');
  const defaultAutoLock = await request(app)
    .get('/api/settings/auto_lock_minutes')
    .set(cashierAuth);
  assertEqualOrThrow(defaultAutoLock.status, 200, 'Cashier can read /api/settings/auto_lock_minutes');
  assertEqualOrThrow(
    defaultAutoLock.body.setting.value,
    '0',
    'auto_lock_minutes defaults to 0 (off)',
  );

  for (const validMins of ['1', '5', '15', '30', '0']) {
    const saveAutoLock = await request(app)
      .put('/api/settings/auto_lock_minutes')
      .set(ownerAuth)
      .send({ value: validMins });
    assertEqualOrThrow(
      saveAutoLock.status,
      200,
      `Owner can set auto_lock_minutes to ${validMins}`,
    );
    assertEqualOrThrow(
      saveAutoLock.body.setting.value,
      validMins,
      `auto_lock_minutes persists ${validMins}`,
    );
  }

  const invalidAutoLock = await request(app)
    .put('/api/settings/auto_lock_minutes')
    .set(ownerAuth)
    .send({ value: '10' });
  assertEqualOrThrow(
    invalidAutoLock.status,
    400,
    'Invalid auto_lock_minutes value (10) is rejected with 400',
  );

  // ── 7. Frontend auth + cart store lock & quick-switch behavior ──
  console.log('\n7. Frontend auth & cart store: lock preserves cart, clears privileged state, ignores stale async callbacks');
  (globalThis as any).window = {
    dispatchEvent: () => {},
  };
  (globalThis as any).localStorage = {
    values: new Map<string, string>(),
    getItem(k: string) {
      return this.values.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      this.values.set(k, v);
    },
    removeItem(k: string) {
      this.values.delete(k);
    },
  };

  const { useAuthStore } = require('../frontend/src/store/auth');
  const { useCartStore } = require('../frontend/src/store/cart');

  let staleMeResolver!: (val: any) => void;
  const staleMePromise = new Promise((res) => {
    staleMeResolver = res;
  });

  mockApiHandler = {
    post: async (url: string, body?: any) => {
      if (url === '/auth/logout') return { data: { message: 'Logged out' } };
      if (url === '/auth/pin-login') {
        return {
          data: {
            access_token: `token-for-${body.user_id}`,
            user: {
              id: body.user_id,
              name: body.user_id === 'owner-1' ? 'Alice Owner' : 'Charlie Cashier',
              email: `${body.user_id}@test.local`,
              role: body.user_id === 'owner-1' ? 'owner' : 'cashier',
            },
            tenants: [
              {
                id: 1,
                business_name: 'Test Cafe',
                role: body.user_id === 'owner-1' ? 'owner' : 'cashier',
                permission_ids: body.user_id === 'owner-1' ? ['pos.use', 'orders.item.price_override'] : ['pos.use'],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
    get: async (url: string) => {
      if (url === '/auth/me') return staleMePromise;
      throw new Error(`Unexpected GET ${url}`);
    },
  };

  // Sign in as owner via pinLogin
  await useAuthStore.getState().pinLogin('owner-1', '2468');
  assertEqualOrThrow(useAuthStore.getState().user?.id, 'owner-1', 'Store signed in as owner-1');
  assertEqualOrThrow(useAuthStore.getState().isLocked, false, 'Store isLocked is false after pinLogin');

  // Add item to cart, apply owner price override, and waive a charge
  const sampleProduct = {
    id: 'prod-1',
    name: 'Latte',
    price: 120,
    category_id: 'cat-1',
    is_available: 1,
  };
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(sampleProduct as any, 2);
  const cartItemId = useCartStore.getState().items[0].id;
  useCartStore.getState().setItemPriceOverride(cartItemId, { price: 90, reason: 'Owner promo' });
  useCartStore.getState().toggleWaiveCharge('service_charge');
  assertEqualOrThrow(
    useCartStore.getState().items[0].price_override?.price,
    90,
    'Owner price override applied to cart item',
  );
  assertEqualOrThrow(
    useCartStore.getState().waivedChargeIds.has('service_charge'),
    true,
    'Charge waiver present before lock',
  );

  // Start an in-flight refreshAuthContext() for owner-1 before locking/switching
  const inFlightRefresh = useAuthStore.getState().refreshAuthContext();

  // Lock terminal
  await useAuthStore.getState().lock();
  assertEqualOrThrow(useAuthStore.getState().user, null, 'lock() clears active user');
  assertEqualOrThrow(useAuthStore.getState().token, null, 'lock() clears active token');
  assertEqualOrThrow(useAuthStore.getState().isLocked, true, 'lock() sets isLocked = true');
  assertEqualOrThrow(
    useCartStore.getState().items.length,
    1,
    'lock() preserves unfinished cart items on the terminal',
  );
  assertEqualOrThrow(
    useCartStore.getState().items[0].quantity,
    2,
    'lock() preserves cart item quantity',
  );
  assertEqualOrThrow(
    useCartStore.getState().items[0].price_override ?? null,
    null,
    'lock() clears privileged price_override from cart items',
  );
  assertEqualOrThrow(
    useCartStore.getState().waivedChargeIds.size,
    0,
    'lock() clears privileged charge waivers from cart',
  );

  // Quick-switch to cashier via pinLogin
  await useAuthStore.getState().pinLogin(cashierId, '7777');
  assertEqualOrThrow(useAuthStore.getState().user?.id, cashierId, 'Quick switch sets cashier user');
  assertEqualOrThrow(useAuthStore.getState().isLocked, false, 'Quick switch clears isLocked');

  // Resolve stale /auth/me from owner-1's previous session and confirm it is ignored
  staleMeResolver({
    data: {
      user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
      tenants: [{ id: 1, business_name: 'Test Cafe', role: 'owner' }],
    },
  });
  await inFlightRefresh;
  assertEqualOrThrow(
    useAuthStore.getState().user?.id,
    cashierId,
    'Stale /auth/me callback from previous session is ignored after user switch',
  );

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n✅ All PIN Quick Switch & Approval Hardening tests passed!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
