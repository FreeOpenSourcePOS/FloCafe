import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-security-'));

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

const { staffRoutes } = require('../main/routes/staff');
const { kdsRoutes } = require('../main/routes/kds');
const { kitchenRoutes } = require('../main/routes/kitchen');
const { databaseRoutes } = require('../main/routes/database');
const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');

function seedUser(db: any, id: string, role: string, email: string, categoryIds?: string[]) {
  db.prepare(`
    INSERT OR REPLACE INTO users (id, name, email, password, role, pin_hash, category_ids, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    `${role} user`,
    email,
    bcrypt.hashSync('testpass123', 10),
    role,
    bcrypt.hashSync('1234', 10),
    categoryIds ? JSON.stringify(categoryIds) : null,
    now(),
    now(),
  );

  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  console.log('Security Hardening Regression Tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  const ownerAuth   = seedUser(db, 'security-owner',   'owner',   'security-owner@test.local');
  const managerAuth = seedUser(db, 'security-manager', 'manager', 'security-manager@test.local');
  const cashierAuth = seedUser(db, 'security-cashier', 'cashier', 'security-cashier@test.local');
  const waiterAuth  = seedUser(db, 'security-waiter',  'waiter',  'security-waiter@test.local');
  const chefAuth    = seedUser(db, 'security-chef',    'chef',    'security-chef@test.local', ['cat-security']);

  db.prepare(`
    INSERT OR IGNORE INTO categories (id, name, is_active, created_at, updated_at)
    VALUES ('cat-security', 'Security Category', 1, ?, ?)
  `).run(now(), now());

  const app = createApp({
    '/api/auth':    authRoutes,
    '/api/staff':   staffRoutes,
    '/api/kds':     kdsRoutes,
    '/api/kitchen': kitchenRoutes,
    '/api/orders':  orderRoutes,
    '/api/db':      databaseRoutes,
  });

  const cashierStaff = await request(app).get('/api/staff').set(cashierAuth);
  assertEqual(cashierStaff.status, 403, 'cashier cannot list staff');

  const managerStaff = await request(app).get('/api/staff').set(managerAuth);
  assertEqual(managerStaff.status, 200, 'manager can list staff');
  assert(!('pin_hash' in managerStaff.body.staff[0]), 'staff list does not expose pin_hash');

  const cashierKds = await request(app).get('/api/kds/pairing').set(cashierAuth);
  assertEqual(cashierKds.status, 403, 'cashier cannot access KDS routes');

  const chefKds = await request(app).get('/api/kds/pairing').set(chefAuth);
  assertEqual(chefKds.status, 200, 'chef can access KDS read routes');

  const chefPairingPost = await request(app).post('/api/kds/pairing').set(chefAuth).send({});
  assertEqual(chefPairingPost.status, 403, 'chef cannot create KDS pairing tokens');

  const managerPairingPost = await request(app).post('/api/kds/pairing').set(managerAuth).send({});
  assertEqual(managerPairingPost.status, 201, 'manager can create KDS pairing tokens');

  // POST, not GET: a GET can't safely carry the Master PIN in a request body.
  const managerBackup = await request(app).post('/api/db/backup').set(managerAuth).send({});
  assertEqual(managerBackup.status, 403, 'manager cannot create database backup through API');

  const ownerTables = await request(app).get('/api/db/tables').set(ownerAuth);
  assertEqual(ownerTables.status, 200, 'owner can inspect database table metadata');

  // ── vuln-0004: /api/kitchen/orders role enforcement ───────────────────────
  const cashierKitchen = await request(app).get('/api/kitchen/orders').set(cashierAuth);
  assertEqual(cashierKitchen.status, 403, 'cashier cannot access kitchen orders (vuln-0004)');

  const waiterKitchen = await request(app).get('/api/kitchen/orders').set(waiterAuth);
  assertEqual(waiterKitchen.status, 403, 'waiter cannot access kitchen orders (vuln-0004)');

  const chefKitchen = await request(app).get('/api/kitchen/orders').set(chefAuth);
  assertEqual(chefKitchen.status, 200, 'chef can access kitchen orders');

  const managerKitchen = await request(app).get('/api/kitchen/orders').set(managerAuth);
  assertEqual(managerKitchen.status, 200, 'manager can access kitchen orders');

  const ownerKitchen = await request(app).get('/api/kitchen/orders').set(ownerAuth);
  assertEqual(ownerKitchen.status, 200, 'owner can access kitchen orders');

  // ── vuln-0005: /api/db/export must redact secrets ─────────────────────────
  const exportRes = await request(app).get('/api/db/export').set(ownerAuth);
  assertEqual(exportRes.status, 200, 'owner can call /api/db/export');

  const exportBody = exportRes.body;
  assert(Array.isArray(exportBody.redacted_fields), 'export response includes redacted_fields list');

  // jwt_secret must be redacted in the settings rows
  const settingsRows: { key: string; value: string }[] = exportBody.data?.settings ?? [];
  const jwtRow = settingsRows.find((r: any) => r.key === 'jwt_secret');
  if (jwtRow) {
    assert(jwtRow.value === '[REDACTED]', 'jwt_secret value is [REDACTED] in export (vuln-0005)');
    assert(exportBody.redacted_fields.includes('settings.jwt_secret'), 'jwt_secret listed in redacted_fields');
  }

  // password and pin_hash must be absent from all user rows
  const userRows: Record<string, any>[] = exportBody.data?.users ?? [];
  for (const user of userRows) {
    assert(!('password' in user), 'users.password absent from export (vuln-0005)');
    assert(!('pin_hash' in user), 'users.pin_hash absent from export (vuln-0005)');
  }
  if (userRows.length > 0) {
    assert(exportBody.redacted_fields.includes('users.password'), 'users.password listed in redacted_fields');
  }

  // cloud_sync_outbox table must be excluded entirely
  assert(!('cloud_sync_outbox' in exportBody.data), 'cloud_sync_outbox excluded from export (vuln-0005)');

  // ── vuln-0006: Password Policy Enforcement ────────────────────────────────
  // Test staff creation
  const weakCreateRes = await request(app).post('/api/staff').set(ownerAuth).send({
    name: 'test', password: '1', role: 'cashier'
  });
  assertEqual(weakCreateRes.status, 400, 'owner cannot create staff with weak password (vuln-0006)');
  assert(weakCreateRes.body.error.includes('at least 8 characters'), 'create staff returns policy error');

  const strongCreateRes = await request(app).post('/api/staff').set(ownerAuth).send({
    name: 'test', password: 'StrongPass1', role: 'cashier', email: 'test1@test.local'
  });
  assertEqual(strongCreateRes.status, 201, 'owner can create staff with strong password (vuln-0006)');
  const newStaffId = strongCreateRes.body.staff.id;

  // Test staff update
  const weakUpdateRes = await request(app).put(`/api/staff/${newStaffId}`).set(ownerAuth).send({
    password: 'a'
  });
  assertEqual(weakUpdateRes.status, 400, 'owner cannot update staff with weak password (vuln-0006)');

  const strongUpdateRes = await request(app).put(`/api/staff/${newStaffId}`).set(ownerAuth).send({
    password: 'StrongPass2'
  });
  assertEqual(strongUpdateRes.status, 200, 'owner can update staff with strong password');

  // Test password change
  const weakChangeRes = await request(app).post('/api/auth/password/change').set(ownerAuth).send({
    current_password: 'testpass123', password: 'a'
  });
  assertEqual(weakChangeRes.status, 400, 'user cannot change to weak password (vuln-0006)');

  const strongChangeRes = await request(app).post('/api/auth/password/change').set(ownerAuth).send({
    current_password: 'testpass123', password: 'StrongPass3'
  });
  assertEqual(strongChangeRes.status, 200, 'user can change to strong password');

  // ── Rate Limit on Staff Mutations ─────────────────────────────────────────
  let rateLimitHit = false;
  for (let i = 0; i < 12; i++) {
    const res = await request(app).put(`/api/staff/${newStaffId}`).set(ownerAuth).send({
      name: 'rate-limit-test'
    });
    if (res.status === 429) {
      rateLimitHit = true;
      break;
    }
  }
  assert(rateLimitHit, 'owner hits authRateLimit after 10 requests to PUT /api/staff/:id');

  // ── vuln-0007: IDOR on Order List Endpoints ──────────────────────────────
  // 1. Chef cannot access orders at all
  const chefOrdersRes = await request(app).get('/api/orders/').set(chefAuth);
  assertEqual(chefOrdersRes.status, 403, 'chef cannot access /api/orders/');

  // 2. Owner can access all orders
  const ownerOrdersRes = await request(app).get('/api/orders/').set(ownerAuth);
  assertEqual(ownerOrdersRes.status, 200, 'owner can access /api/orders/');

  // Seed two orders: one by waiter, one by manager
  // But wait, we need to create orders through the API to ensure they are created correctly
  const prodId = 'test-prod-1';
  db.prepare("INSERT OR REPLACE INTO products (id, name, price, stock_quantity, tax_type) VALUES (?, 'Test', 100, 10, 'exclusive')").run(prodId);

  const managerOrderRes = await request(app).post('/api/orders/').set(managerAuth).send({
    type: 'dine_in', user_id: 'security-manager', items: [{ product_id: prodId, quantity: 1 }]
  });
  const managerOrderId = managerOrderRes.body.order.id;

  const waiterOrderRes = await request(app).post('/api/orders/').set(waiterAuth).send({
    type: 'dine_in', user_id: 'security-waiter', items: [{ product_id: prodId, quantity: 1 }]
  });
  const waiterOrderId = waiterOrderRes.body.order.id;

  // 3. Waiter fetching /api/orders/ should ONLY see their own order
  const waiterListRes = await request(app).get('/api/orders/').set(waiterAuth);
  assertEqual(waiterListRes.status, 200, 'waiter can access /api/orders/');
  const waiterSeenIds = waiterListRes.body.orders.map((o: any) => o.id);
  assert(waiterSeenIds.includes(waiterOrderId), 'waiter sees their own order');
  assert(!waiterSeenIds.includes(managerOrderId), 'waiter does NOT see manager order (vuln-0007 IDOR)');

  // 4. Waiter fetching /api/orders/:id for manager's order should return 403
  const waiterGetManagerOrder = await request(app).get(`/api/orders/${managerOrderId}`).set(waiterAuth);
  assertEqual(waiterGetManagerOrder.status, 403, 'waiter gets 403 for other user order (vuln-0007)');

  // 5. Waiter fetching /api/orders/:id for their own order should return 200
  const waiterGetOwnOrder = await request(app).get(`/api/orders/${waiterOrderId}`).set(waiterAuth);
  assertEqual(waiterGetOwnOrder.status, 200, 'waiter gets 200 for their own order');

  // ── user_id attribution: the real POS frontend never sends user_id — it
  // must come from the authenticated session, not the request body. Without
  // this, every order gets user_id=NULL and a waiter can never see any order
  // they place (the /api/orders/ list scopes waiters to `user_id = <their
  // id>`, which NULL never matches).
  const noBodyUserIdRes = await request(app).post('/api/orders/').set(waiterAuth).send({
    type: 'dine_in', items: [{ product_id: prodId, quantity: 1 }]
  });
  assertEqual(noBodyUserIdRes.status, 201, 'waiter can create an order without sending user_id');
  const noBodyUserIdOrderId = noBodyUserIdRes.body.order.id;
  assertEqual(noBodyUserIdRes.body.order.user_id, 'security-waiter', 'order is attributed to the authenticated waiter, not left NULL');

  const waiterSeesOwnUnattributedOrder = await request(app).get('/api/orders/').set(waiterAuth);
  const seenAfterCreate = waiterSeesOwnUnattributedOrder.body.orders.map((o: any) => o.id);
  assert(seenAfterCreate.includes(noBodyUserIdOrderId), 'the order the waiter just placed (no user_id in the request) shows up in their own order list');

  // A spoofed user_id in the body must be ignored — attribution always comes
  // from the session, never the client.
  const spoofedUserIdRes = await request(app).post('/api/orders/').set(waiterAuth).send({
    type: 'dine_in', user_id: 'security-owner', items: [{ product_id: prodId, quantity: 1 }]
  });
  assertEqual(spoofedUserIdRes.body.order.user_id, 'security-waiter', 'a client-supplied user_id is ignored — the order is still attributed to the real authenticated caller');

  const results = getResults();
  if (results.failed > 0) {
    throw new Error(`${results.failed} security hardening assertion(s) failed`);
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\nSecurity hardening tests passed');
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
