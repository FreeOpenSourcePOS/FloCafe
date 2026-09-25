/**
 * Cancel Override Logic Tests
 *
 * Verifies that cancelling an order in preparing/ready/served status
 * requires a manager PIN, while cancelling a pending order does not.
 *
 * Uses Electron runtime (via run-electron-node-test.cjs) because
 * better-sqlite3 is built for Electron's Node ABI.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cancel-override.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Mock electron before any imports that reference it
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cancel-override-'));
const mockApp = {
  isPackaged: true,
  getPath: (name: string) => {
    if (name === 'userData') return testDir;
    if (name === 'documents') return testDir;
    return testDir;
  },
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

// Set JWT_SECRET before importing auth modules
process.env.JWT_SECRET = 'test-secret-for-cancel-override';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');

// ── Test Helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function listen(app: any): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function request(
  baseUrl: string,
  urlPath: string,
  options: Record<string, any> = {}
): Promise<{ status: number; data: any }> {
  const fetchOptions: any = {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  };
  if (options.method) fetchOptions.method = options.method;
  if (options.body) fetchOptions.body = options.body;

  const response = await (globalThis as any).fetch(baseUrl + urlPath, fetchOptions);
  const data = await response.json();
  return { status: response.status, data };
}

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const MANAGER_PIN = '1234';
const WRONG_PIN = '9999';
let managerUserId: string;

function seedTestData() {
  const db = getDatabase();
  // Regional settings come from signup, never a fallback; seed one
  // explicitly so resolveRegionalSnapshot() resolves.
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`).run(now());

  // Create a manager user with a hashed PIN
  managerUserId = 'mgr-test-001';
  const pinHash = bcrypt.hashSync(MANAGER_PIN, 10);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    managerUserId,
    'Test Manager',
    'mgr@test.local',
    bcrypt.hashSync('password', 10),
    'manager',
    pinHash,
    1,
    now(),
    now()
  );

  // Create a product for order items
  db.prepare(
    `INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`
  ).run('cat-test', 'Test', 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-test', 'cat-test', 'Test Item', 100, 1, 1);

  // Create orders in various statuses
  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Pending order (no override required)
  insertOrder.run('ORD-TEST-001', null, 'takeaway', 'pending', 100, 100, now(), now());
  const pendingId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-TEST-001') as any).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(pendingId, 'prod-test', 'Test Item', 100, 1, 100, 0, 100, 'pending', now(), now());

  // Preparing order (override required)
  insertOrder.run('ORD-TEST-002', null, 'takeaway', 'preparing', 100, 100, now(), now());
  const preparingId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-TEST-002') as any).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(preparingId, 'prod-test', 'Test Item', 100, 1, 100, 0, 100, 'preparing', now(), now());

  // Ready order (override required)
  insertOrder.run('ORD-TEST-003', null, 'takeaway', 'ready', 100, 100, now(), now());
  const readyId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-TEST-003') as any).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(readyId, 'prod-test', 'Test Item', 100, 1, 100, 0, 100, 'ready', now(), now());

  // Served order (override required)
  insertOrder.run('ORD-TEST-004', null, 'takeaway', 'served', 100, 100, now(), now());
  const servedId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-TEST-004') as any).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(servedId, 'prod-test', 'Test Item', 100, 1, 100, 0, 100, 'served', now(), now());
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Cancel Override Logic Tests');
  console.log('='.repeat(50));

  // Init database
  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77); // exit code 77 = skip (GNU convention)
    }
    throw error;
  }

  seedTestData();

  // Start Express server
  const app = express();
  app.use(express.json());

  // Add auth middleware (replicate requireAuth from server.ts)
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) { next(); return; }
    if (req.path === '/api/health') { next(); return; }
    if (req.path.startsWith('/api/auth')) { next(); return; }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      const payload = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      req.user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  app.use('/api/orders', orderRoutes);
  const server = await listen(app);
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Generate a valid JWT for test requests (manager role)
  const token = jwt.sign(
    { userId: managerUserId, email: 'mgr@test.local', role: 'manager' },
    getJWTSecret(),
    { expiresIn: '1h' }
  );
  const authHeader = `Bearer ${token}`;

  try {
    // ── Test 1: Cancel pending order (no override required) ──────────────
    console.log('\n1. Cancel pending order (no override required)');
    {
      // Get the pending order ID
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-001'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled', reason: 'Customer changed mind' }),
      });
      console.log('  Response:', JSON.stringify(res.data));
      assertEqual(res.status, 200, 'returns 200 for cancelling pending order');
      assertEqual(res.data.order.status, 'cancelled', 'pending order status becomes cancelled');
    }

    // ── Test 2: Cancel preparing order without PIN (should fail) ────────
    console.log('\n2. Cancel preparing order without PIN (should fail)');
    {
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-002'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assertEqual(res.status, 400, 'returns 400 when PIN is missing');
      assert(res.data.error.includes('Manager PIN'), 'error mentions Manager PIN');
    }

    // ── Test 3: Cancel preparing order with wrong PIN (should fail) ─────
    console.log('\n3. Cancel preparing order with wrong PIN (should fail)');
    {
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-002'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled', override_pin: WRONG_PIN }),
      });
      assertEqual(res.status, 403, 'returns 403 for invalid PIN');
      assert(res.data.error.includes('Invalid manager PIN'), 'error mentions Invalid manager PIN');
    }

    // ── Test 4: Cancel preparing order with valid PIN ───────────────────
    console.log('\n4. Cancel preparing order with valid PIN');
    {
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-002'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled', override_pin: MANAGER_PIN, reason: 'Item out of stock' }),
      });
      assertEqual(res.status, 200, 'returns 200 for cancelling with valid PIN');
      assertEqual(res.data.order.status, 'cancelled', 'preparing order status becomes cancelled');
    }

    // ── Test 5: Cancel ready order with valid PIN ───────────────────────
    console.log('\n5. Cancel ready order with valid PIN');
    {
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-003'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled', override_pin: MANAGER_PIN }),
      });
      assertEqual(res.status, 200, 'returns 200 for cancelling ready order with valid PIN');
      assertEqual(res.data.order.status, 'cancelled', 'ready order status becomes cancelled');
    }

    // ── Test 6: Cancel served order with valid PIN ──────────────────────
    console.log('\n6. Cancel served order with valid PIN');
    {
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-004'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled', override_pin: MANAGER_PIN }),
      });
      assertEqual(res.status, 200, 'returns 200 for cancelling served order with valid PIN');
      assertEqual(res.data.order.status, 'cancelled', 'served order status becomes cancelled');
    }

    // ── Test 7: Cancel non-existent order (should 404) ──────────────────
    console.log('\n7. Cancel non-existent order');
    {
      const res = await request(baseUrl, '/api/orders/99999/status', {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'cancelled', override_pin: MANAGER_PIN }),
      });
      assertEqual(res.status, 404, 'returns 404 for non-existent order');
    }

    // ── Test 8: Invalid status value (should 400) ──────────────────────
    console.log('\n8. Invalid status value');
    {
      const db = getDatabase();
      const order = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-TEST-001'").get() as any;
      const res = await request(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ status: 'invalid_status' }),
      });
      assertEqual(res.status, 400, 'returns 400 for invalid status');
    }
  } finally {
    server.close();
    closeDatabase();
  }

  // Cleanup
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
