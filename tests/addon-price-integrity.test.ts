/**
 * Add-on Price Integrity — GHSA-jmxx-39wh-4cjx
 *
 * Verifies that the order API resolves every submitted add-on against the
 * catalog instead of trusting client-supplied name/price:
 *  - a forged name/price is ignored; subtotal + snapshot use catalog values
 *  - an inactive add-on is rejected
 *  - an add-on whose group is not linked to the product is rejected
 *  - an unknown add-on id is rejected
 *  - an add-on without a catalog id is rejected
 *
 * Usage: node tests/run-electron-node-test.cjs tests/addon-price-integrity.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-price-integrity-'));
const mockApp = {
  isPackaged: true,
  getPath: (name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-addon-price-integrity';

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

async function main() {
  console.log('Add-on Price Integrity — GHSA-jmxx-39wh-4cjx');
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

  const db = getDatabase();

  // ── Seed ────────────────────────────────────────────────────────────────
  const ownerId = 'owner-addon-price-integrity';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ownerId, 'Test Owner', 'owner-ai@test.local', bcrypt.hashSync('password', 10), 'owner', 1, now(), now());

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-ai', 'Test', 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-ai', 'cat-ai', 'Burger', 100, 1, 1);

  db.prepare(`INSERT INTO addon_groups (id, name) VALUES (?, ?)`).run('ag-ai', 'Extras');
  db.prepare(`INSERT INTO addon_groups (id, name) VALUES (?, ?)`).run('ag-other', 'Other');
  // Linked to prod-ai
  db.prepare(`INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)`).run('prod-ai', 'ag-ai');
  // ag-other is deliberately NOT linked to prod-ai

  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES (?, ?, ?, ?, ?)`
  ).run('addon-ai-cheese', 'ag-ai', 'Extra Cheese', 50, 1);
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES (?, ?, ?, ?, ?)`
  ).run('addon-ai-inactive', 'ag-ai', 'Inactive Topping', 10, 0);
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES (?, ?, ?, ?, ?)`
  ).run('addon-ai-wrong-group', 'ag-other', 'Wrong Group', 20, 1);

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) { next(); return; }
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  app.use('/api/orders', orderRoutes);

  const server = await listen(app);
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const token = jwt.sign({ userId: ownerId, email: 'owner-ai@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const authHeader = `Bearer ${token}`;

  function orderBody(addons: any[]): string {
    return JSON.stringify({
      type: 'takeaway',
      items: [{ product_id: 'prod-ai', quantity: 1, addons }],
    });
  }

  try {
    // ── Case 1: forged name/price is ignored; catalog values win ──────────
    console.log('\n1. Client-supplied name/price is never trusted');
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: orderBody([{ id: 'addon-ai-cheese', name: 'FREEBIE', price: 0 }]),
      });
      assertEqual(res.status, 201, `order accepted (got ${res.status}, ${JSON.stringify(res.data)})`);

      const orderId = res.data.order.id;
      const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
      const rows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(itemId) as any[];

      assertEqual(res.data.order.subtotal, 150, 'subtotal uses catalog add-on price (100 + 50)');
      assertEqual(rows.length, 1, 'one add-on snapshot row');
      assertEqual(rows[0]?.addon_name, 'Extra Cheese', 'snapshot uses catalog name, not client-supplied name');
      assertEqual(rows[0]?.price, 50, 'snapshot uses catalog price, not client-supplied price');
    }

    // ── Case 2: inactive add-on is rejected ───────────────────────────────
    console.log('\n2. Inactive add-on is rejected');
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: orderBody([{ id: 'addon-ai-inactive' }]),
      });
      assertEqual(res.status, 400, `inactive add-on rejected (got ${res.status}, ${JSON.stringify(res.data)})`);
    }

    // ── Case 3: add-on from a group not linked to the product is rejected ─
    console.log('\n3. Add-on not linked to the product is rejected');
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: orderBody([{ id: 'addon-ai-wrong-group' }]),
      });
      assertEqual(res.status, 400, `wrong-group add-on rejected (got ${res.status}, ${JSON.stringify(res.data)})`);
    }

    // ── Case 4: unknown add-on id is rejected ─────────────────────────────
    console.log('\n4. Unknown add-on id is rejected');
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: orderBody([{ id: 'addon-ai-does-not-exist', name: 'Ghost', price: 5 }]),
      });
      assertEqual(res.status, 400, `unknown add-on rejected (got ${res.status}, ${JSON.stringify(res.data)})`);
    }

    // ── Case 5: add-on without a catalog id is rejected ───────────────────
    console.log('\n5. Add-on without a catalog id is rejected');
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: orderBody([{ name: 'Ghost Topping', price: 5 }]),
      });
      assertEqual(res.status, 400, `id-less add-on rejected (got ${res.status}, ${JSON.stringify(res.data)})`);
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
