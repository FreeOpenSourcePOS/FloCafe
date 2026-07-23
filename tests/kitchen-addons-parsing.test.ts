/**
 * Kitchen Orders — Addons Parsing Test
 *
 * Verifies that the /api/kitchen/orders endpoint returns addons as an
 * array — resolved from the normalized order_item_addons table via
 * attachEffectiveAddons (see issue #125) — never a raw JSON string or
 * null, which used to cause "e.addons.map is not a function" on the KDS
 * frontend back when addons lived as JSON on order_items.addons.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/kitchen-addons-parsing.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kitchen-addons-'));
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

process.env.JWT_SECRET = 'test-secret-kitchen-addons';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { kitchenRoutes } = require('../main/routes/kitchen');

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

// ── Seed ──────────────────────────────────────────────────────────────────────

function seedTestData() {
  const db = getDatabase();

  // Owner user
  const ownerId = 'owner-addons-test';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ownerId, 'Test Owner', 'owner@test.local',
    bcrypt.hashSync('password', 10), 'owner', 1, now(), now()
  );

  // Category + product
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`)
    .run('cat-addons', 'Test', 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-addons', 'cat-addons', 'Burger', 200, 1, 1);

  db.prepare(`INSERT INTO addon_groups (id, name) VALUES ('ag-addons', 'Extras')`).run();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-cheese', 'ag-addons', 'Extra Cheese', 50, 1)`).run();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-bacon', 'ag-addons', 'Bacon', 80, 1)`).run();

  // Order with selected addons snapshotted into order_item_addons (how the
  // orders API stores them — order_items.addons no longer exists, issue #125)
  db.prepare(
    `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ORD-ADDONS-001', null, 'takeaway', 'preparing', 330, 330, now(), now());

  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-ADDONS-001') as any).id;

  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity,
      subtotal, tax_amount, total, special_instructions, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId, 'prod-addons', 'Burger', 200, 1, 330, 0, 330, 'No pickles', 'preparing', now(), now());
  const itemId1 = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
  db.prepare(
    `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at) VALUES (?, ?, ?, ?, 1, ?)`
  ).run(itemId1, 'addon-cheese', 'Extra Cheese', 50, now());
  db.prepare(
    `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at) VALUES (?, ?, ?, ?, 1, ?)`
  ).run(itemId1, 'addon-bacon', 'Bacon', 80, now());

  // Order with no addons at all
  db.prepare(
    `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ORD-ADDONS-002', null, 'takeaway', 'pending', 200, 200, now(), now());

  const orderId2 = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-ADDONS-002') as any).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity,
      subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId2, 'prod-addons', 'Burger', 200, 1, 200, 0, 200, 'pending', now(), now());
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Kitchen Orders — Addons Parsing');
  console.log('='.repeat(50));

  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw error;
  }

  seedTestData();

  const app = express();
  app.use(express.json());

  // Auth middleware
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) { next(); return; }
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

  app.use('/api/kitchen', kitchenRoutes);
  const server = await listen(app);
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const token = jwt.sign(
    { userId: 'owner-addons-test', email: 'owner@test.local', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '1h' }
  );
  const authHeader = `Bearer ${token}`;

  try {
    // ── Test 1: Kitchen returns addons as array ────────────────────────
    console.log('\n1. Kitchen orders returns addons as parsed array');
    {
      const res = await request(baseUrl, '/api/kitchen/orders', {
        headers: { Authorization: authHeader },
      });
      assertEqual(res.status, 200, 'returns 200');

      const order1 = res.data.orders.find((o: any) => o.order_number === 'ORD-ADDONS-001');
      assert(!!order1, 'found order with addons');
      const item1 = order1?.items?.[0];
      assert(!!item1, 'order has an item');

      // Critical: addons must be an array, not a string
      assert(Array.isArray(item1?.addons), 'addons is an array (not a string)');
      assertEqual(item1?.addons?.length, 2, 'addons has 2 entries');
      assertEqual(item1?.addons?.[0]?.name, 'Extra Cheese', 'first addon name is correct');
      assertEqual(item1?.addons?.[1]?.price, 80, 'second addon price is correct');
    }

    // ── Test 2: item with no selected addons gets an empty array ────────
    console.log('\n2. Item with no addons returns an empty array (not null)');
    {
      const res = await request(baseUrl, '/api/kitchen/orders', {
        headers: { Authorization: authHeader },
      });
      const order2 = res.data.orders.find((o: any) => o.order_number === 'ORD-ADDONS-002');
      const item2 = order2?.items?.[0];
      assert(Array.isArray(item2?.addons), 'addons is an array even with no selections');
      assertEqual(item2?.addons?.length, 0, 'addons array is empty');
    }

    // ── Test 3: special_instructions preserved ─────────────────────────
    console.log('\n3. Special instructions are preserved');
    {
      const res = await request(baseUrl, '/api/kitchen/orders', {
        headers: { Authorization: authHeader },
      });
      const order1 = res.data.orders.find((o: any) => o.order_number === 'ORD-ADDONS-001');
      const item1 = order1?.items?.[0];
      assertEqual(item1?.special_instructions, 'No pickles', 'special instructions preserved');
    }

  } finally {
    server.close();
    closeDatabase();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
