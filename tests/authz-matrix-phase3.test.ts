/**
 * Comprehensive Phase 3 Authorization Matrix & Data Exposure Test Suite
 * Evaluates role boundaries, unauthenticated access, deactivated user tokens,
 * ownership checks, and sensitive data protection across FloCafe API routes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phase3-authz-'));

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

process.env.JWT_SECRET = 'test-secret-phase3-authz';

const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { getJWTSecret } = require('../main/routes/auth');

function seedUser(db: any, id: string, role: string, isActive = 1, pin = '1234') {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    id,
    email,
    bcrypt.hashSync('Testpass123', 10),
    role,
    pin ? bcrypt.hashSync(pin, 10) : null,
    isActive,
    now(),
    now()
  );

  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { headers: { Authorization: `Bearer ${token}` }, token, id };
}

const { getUserAuthStatus, isTokenRevoked } = require('../main/middleware/security');

function buildApp() {
  const app = express();
  app.use(express.json());

  // RequireAuth middleware from main/server.ts
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) { next(); return; }
    if (req.path === '/api/health') { next(); return; }
    if (req.path.startsWith('/api/auth')) { next(); return; }
    if (req.path.startsWith('/api/products/') && req.path.endsWith('/image') && req.method === 'GET') { next(); return; }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      const token = authHeader.split(' ')[1];
      if (isTokenRevoked(token)) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      const decoded = jwt.verify(token, getJWTSecret()) as any;
      const status = getUserAuthStatus(decoded.userId);
      if (!status || !status.isActive) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      (req as any).user = { ...decoded, role: status.role };
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  registerRoutes(app);
  return app;
}

async function main() {
  console.log('Phase 3 Authorization Matrix & Security Verification');
  console.log('='.repeat(60));

  const db = initTestDb();
  const owner = seedUser(db, 'p3-owner', 'owner');
  const manager = seedUser(db, 'p3-manager', 'manager');
  const cashier = seedUser(db, 'p3-cashier', 'cashier');
  const waiter = seedUser(db, 'p3-waiter', 'waiter');
  const chef = seedUser(db, 'p3-chef', 'chef');
  const deactivated = seedUser(db, 'p3-deactivated', 'manager', 1); // will deactivate in DB later

  const app = buildApp();

  console.log('\n── 1. Unauthenticated Request Denials ───────────────────────');
  const protectedRoutes = [
    { method: 'get', path: '/api/orders' },
    { method: 'get', path: '/api/bills' },
    { method: 'get', path: '/api/customers' },
    { method: 'get', path: '/api/staff' },
    { method: 'get', path: '/api/settings' },
    { method: 'get', path: '/api/reports/sales' },
    { method: 'get', path: '/api/printers' },
    { method: 'get', path: '/api/db/export' },
    { method: 'get', path: '/api/database-tools/health-check' },
    { method: 'get', path: '/api/mobile/pairing-code' },
  ];

  for (const route of protectedRoutes) {
    const res = await (request(app) as any)[route.method](route.path);
    assertEqual(res.status, 401, `Unauthenticated ${route.method.toUpperCase()} ${route.path} returns 401`);
  }

  console.log('\n── 2. Deactivated User Token Rejection ─────────────────────');
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(deactivated.id);
  const deactivatedRes = await request(app).get('/api/orders').set(deactivated.headers);
  assertEqual(deactivatedRes.status, 401, 'Deactivated user with unexpired JWT token is denied with 401');

  console.log('\n── 3. Role Boundary Enforcement ──────────────────────────────');
  // Manager-only or Owner-only endpoints
  const ownerOnlyRoutes = [
    { method: 'get', path: '/api/db/export' },
    { method: 'get', path: '/api/db-tools/health-check' },
    { method: 'get', path: '/api/mobile/pairing-code' },
    { method: 'get', path: '/api/mobile/devices' },
    { method: 'post', path: '/api/mobile/rotate-code' },
  ];

  for (const route of ownerOnlyRoutes) {
    for (const user of [manager, cashier, waiter, chef]) {
      const res = await (request(app) as any)[route.method](route.path).set(user.headers);
      assertEqual(res.status, 403, `${user.id} denied 403 on owner-only route ${route.path}`);
    }
    const ownerRes = await (request(app) as any)[route.method](route.path).set(owner.headers);
    assert(ownerRes.status !== 401 && ownerRes.status !== 403, `Owner is allowed on ${route.path} (status: ${ownerRes.status})`);
  }

  const managerOrOwnerRoutes = [
    { method: 'post', path: '/api/categories', body: { name: 'Test Cat' } },
    { method: 'get', path: '/api/tax/categories' },
    { method: 'post', path: '/api/bills/1/applyDiscount', body: { discount_type: 'amount', discount_value: 10 } },
  ];

  for (const route of managerOrOwnerRoutes) {
    for (const user of [cashier, waiter, chef]) {
      const res = await (request(app) as any)[route.method](route.path).set(user.headers).send(route.body || {});
      assertEqual(res.status, 403, `${user.id} denied 403 on manager/owner route ${route.path}`);
    }
  }

  console.log('\n── 4. Sensitive Data Exposure Verification ─────────────────');
  const staffRes = await request(app).get('/api/staff').set(owner.headers);
  assertEqual(staffRes.status, 200, 'Owner can fetch staff list');
  const staffList = staffRes.body.staff || staffRes.body;
  assert(Array.isArray(staffList), 'Staff response is an array');
  for (const member of staffList) {
    assert(!('password' in member), 'Staff record does not expose password hash');
    assert(!('pin_hash' in member), 'Staff record does not expose PIN hash');
  }

  db.prepare(`INSERT INTO customers (id, name, email, phone, is_active, created_at, updated_at)
    VALUES ('p3-customer', 'P3 Customer', 'customer@test.local', '+15551234567', 1, ?, ?)`).run(now(), now());
  const customerRes = await request(app).get('/api/customers').set(owner.headers);
  assertEqual(customerRes.status, 200, 'Owner can fetch customer records');
  const customerList = customerRes.body.data || customerRes.body.customers || customerRes.body;
  assert(Array.isArray(customerList), 'Customer response is an array');
  for (const customer of customerList) {
    assert(!('password' in customer), 'Customer record does not expose password hash');
    assert(!('pin_hash' in customer), 'Customer record does not expose PIN hash');
  }

  console.log('\n── 5. Cross-Resource / Object-Level Access ────────────────');
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-P3-1', 'takeaway', 'pending', 50, 50, ?, ?)`).run(now(), now());
  const orderRow = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-P3-1'").get() as any;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-p3', 'P3 Item', 50, 1, 50, 0, 50, 'pending', ?, ?)`).run(orderRow.id, now(), now());
  const itemRow = db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderRow.id) as any;
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-P3-2', 'takeaway', 'pending', 25, 25, ?, ?)`).run(now(), now());
  const secondOrderRow = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-P3-2'").get() as any;

  const crossOrderRes = await request(app)
    .patch(`/api/orders/${secondOrderRow.id}/items/${itemRow.id}/cancel`)
    .set(owner.headers)
    .send({ override_pin: '1234' });
  assertEqual(crossOrderRes.status, 404, 'Cross-order item access returns 404');

  const mismatchItemRes = await request(app)
    .patch(`/api/orders/${orderRow.id}/items/99999/cancel`)
    .set(owner.headers)
    .send({ override_pin: '1234' });
  assertEqual(mismatchItemRes.status, 404, 'Mismatched or invalid order-item returns 404');

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed`);
  if (results.failed > 0) {
    throw new Error(`${results.failed} Phase 3 authorization test assertion(s) failed`);
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\nPhase 3 Authorization Matrix tests completed successfully');
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
