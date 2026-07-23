/**
 * Order Item Addons — Normalized Table (issue #125)
 *
 * Verifies that order creation and add-items snapshot selected addons into
 * the normalized order_item_addons table (in addition to the existing
 * order_items.addons JSON column, which stays the read-path source of
 * truth for now). Also verifies:
 *  - an addon_id that doesn't match any row in `addons` (deleted/unknown)
 *    falls back to NULL instead of aborting order creation via FK violation
 *  - the v25 migration backfills pre-existing JSON-only order_items
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-item-addons.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-item-addons-'));
const mockApp = {
  isPackaged: true,
  getPath: (name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-item-addons';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, MIGRATIONS } = require('../main/db');
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
  console.log('Order Item Addons — Normalized Table');
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
  const ownerId = 'owner-addons-norm-test';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ownerId, 'Test Owner', 'owner-norm@test.local', bcrypt.hashSync('password', 10), 'owner', 1, now(), now());

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-addon-norm', 'Test', 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-addon-norm', 'cat-addon-norm', 'Tea', 50, 1, 1);

  db.prepare(`INSERT INTO addon_groups (id, name) VALUES (?, ?)`).run('ag-norm', 'Extras');
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES (?, ?, ?, ?, ?)`
  ).run('addon-real-sugar', 'ag-norm', 'Extra Sugar', 5, 1);
  // Deliberately no row for 'addon-deleted-lemon' — simulates an addon that
  // existed when the cart was built but was deleted before the order posted.

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
  const token = jwt.sign({ userId: ownerId, email: 'owner-norm@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const authHeader = `Bearer ${token}`;

  try {
    // ── Test 1: order creation dual-writes addons into the normalized table ──
    console.log('\n1. POST /api/orders snapshots addons into order_item_addons');
    let orderId: number;
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: JSON.stringify({
          type: 'takeaway',
          items: [{
            product_id: 'prod-addon-norm',
            quantity: 1,
            addons: [
              { id: 'addon-real-sugar', name: 'Extra Sugar', price: 5 },
              { id: 'addon-deleted-lemon', name: 'Lemon Slice', price: 3 },
            ],
          }],
        }),
      });
      assertEqual(res.status, 201, `order with addons is created (got ${res.status}, ${JSON.stringify(res.data)})`);
      orderId = res.data.order.id;

      const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
      const rows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ? ORDER BY id').all(itemId) as any[];

      assertEqual(rows.length, 2, 'both selected addons were snapshotted into order_item_addons');
      assertEqual(rows[0]?.addon_name, 'Extra Sugar', 'first addon name matches');
      assertEqual(rows[0]?.price, 5, 'first addon price matches');
      assertEqual(rows[0]?.addon_id, 'addon-real-sugar', 'addon with a valid catalog id keeps the FK link');
      assertEqual(rows[1]?.addon_name, 'Lemon Slice', 'second addon name matches (name/price preserved even without a catalog link)');
      assertEqual(rows[1]?.addon_id, null, 'addon with no matching catalog row falls back to NULL addon_id instead of failing the FK');

      const columns = db.prepare("PRAGMA table_info(order_items)").all().map((c: any) => c.name);
      assert(!columns.includes('addons'), 'order_items.addons column no longer exists — order_item_addons is the only store (issue #125)');
    }

    // ── Test 2: add-items also dual-writes ────────────────────────────────
    console.log('\n2. POST /api/orders/:id/items snapshots addons into order_item_addons');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/items`, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: JSON.stringify({
          items: [{ product_id: 'prod-addon-norm', quantity: 2, addons: [{ id: 'addon-real-sugar', name: 'Extra Sugar', price: 5 }] }],
        }),
      });
      assertEqual(res.status, 200, `add-items succeeds (got ${res.status}, ${JSON.stringify(res.data)})`);

      const newItem = db.prepare('SELECT id FROM order_items WHERE order_id = ? AND quantity = 2').get(orderId) as any;
      assert(!!newItem, 'the new item was inserted');
      const rows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(newItem.id) as any[];
      assertEqual(rows.length, 1, 'add-items addon was snapshotted into order_item_addons');
    }

    // ── Test 3: an item with no addons writes no rows (not even empty ones) ──
    console.log('\n3. Items without addons write zero order_item_addons rows');
    {
      const res = await request(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ type: 'takeaway', items: [{ product_id: 'prod-addon-norm', quantity: 1 }] }),
      });
      assertEqual(res.status, 201, 'order without addons is created');
      const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(res.data.order.id) as any).id;
      const rows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(itemId) as any[];
      assertEqual(rows.length, 0, 'no order_item_addons rows for an item with no addons');
    }

    // ── Test 4: v25 migration backfills legacy JSON-only rows ─────────────
    // v25 already shipped (1.9.4) and its .up() unconditionally assumes an
    // addons column, so it must stay runnable as-is for any real install
    // upgrading from that era — even though a fresh/current install's
    // order_items no longer has the column by the time this test runs
    // (migration v30 already dropped it during initDatabase() above). To
    // exercise v25's own backfill logic in isolation, re-add the column it
    // expects, exactly as it would still exist on an old, not-yet-upgraded
    // database.
    console.log('\n4. Migration v25 backfills pre-existing order_items.addons JSON');
    {
      db.exec('ALTER TABLE order_items ADD COLUMN addons TEXT');

      db.prepare(
        `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('ORD-LEGACY-BACKFILL', null, 'takeaway', 'completed', 55, 55, now(), now());
      const legacyOrderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-LEGACY-BACKFILL') as any).id;

      const legacyAddons = JSON.stringify([{ id: 'addon-real-sugar', name: 'Extra Sugar', price: 5 }]);
      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, addons, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(legacyOrderId, 'prod-addon-norm', 'Tea', 50, 1, 55, 0, 55, legacyAddons, 'completed', now(), now());
      const legacyItemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(legacyOrderId) as any).id;

      // This row was inserted directly (bypassing the API), simulating data
      // that predates the dual-write — no order_item_addons rows exist yet.
      const beforeRows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(legacyItemId) as any[];
      assertEqual(beforeRows.length, 0, 'legacy row has no order_item_addons rows before backfill runs');

      const v25 = MIGRATIONS.find((m: any) => m.version === 25);
      assert(!!v25, 'migration v25 is registered');
      v25.up();

      const afterRows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(legacyItemId) as any[];
      assertEqual(afterRows.length, 1, 'backfill created the missing order_item_addons row');
      assertEqual(afterRows[0]?.addon_name, 'Extra Sugar', 'backfilled row has the correct addon name');

      // Clean up the column we re-added for this isolated test, so it
      // doesn't leak into whatever runs after this test in the same process.
      db.exec('ALTER TABLE order_items DROP COLUMN addons');
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
