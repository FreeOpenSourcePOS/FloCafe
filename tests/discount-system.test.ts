/**
 * Discount System Tests
 *
 * Verifies that:
 * 1. Discount settings exist in the database after migration v7
 * 2. PATCH /api/orders/:id/discount validates type, value, and limits
 * 3. PATCH /api/orders/:id/discount calculates discount and updates totals
 * 4. PATCH /api/orders/:id/items/:itemId/discount validates and updates item
 * 5. Returns 404 for missing order/item
 *
 * Uses Electron runtime (via run-electron-node-test.cjs) because
 * better-sqlite3 is built for Electron's Node ABI.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/discount-system.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Mock electron before any imports that reference it
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-discount-test-'));
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

const express = require('express');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
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

function assertIncludes(haystack: string, needle: string, message: string) {
  total++;
  if (haystack.includes(needle)) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — "${haystack}" does not contain "${needle}"`);
  }
}

function assertGreaterThan(actual: number, expected: number, message: string) {
  total++;
  if (actual > expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — expected > ${expected}, got ${actual}`);
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
  const response = await (globalThis as any).fetch(baseUrl + urlPath, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  return { status: response.status, data };
}

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

// ── Expected discount settings ────────────────────────────────────────────────

const EXPECTED_DISCOUNT_SETTINGS: Record<string, string> = {
  discount_mode: 'percentage',
  discount_requires_approval: '0',
  discount_max_percentage: '25',
  discount_max_amount: '0',
};

// ── Setup ─────────────────────────────────────────────────────────────────────

function seedTestData() {
  const db = getDatabase();

  // Create a category and product for order items
  db.prepare(
    `INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`
  ).run('cat-disc', 'Test Category', 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-disc', 'cat-disc', 'Test Item', 500, 1, 1);

  // Real user row — order_audit_log.actor_user_id is a FK, so the mocked
  // auth identity below must resolve to an actual users row.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run('owner-disc-test', 'Test Owner', 'owner-disc-test@test.local', 'unused', 'owner', now(), now());

  // Create an order with a known total (500 for 1 item)
  db.prepare(
    `INSERT INTO orders (order_number, table_id, type, status, subtotal, tax_amount, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ORD-DISC-001', null, 'takeaway', 'pending', 500, 0, 500, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-DISC-001') as any).id;

  // Create order item
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId, 'prod-disc', 'Test Item', 500, 1, 500, 0, 500, 'pending', now(), now());

  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;

  return { orderId, itemId };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Discount System Tests');
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

  const { orderId, itemId } = seedTestData();

  // Start Express server
  const app = express();
  app.use(express.json());
  // Mock auth middleware — must run before routes
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 'owner-disc-test', userId: 'owner-disc-test', role: 'owner', name: 'Test Owner' };
    next();
  });
  app.use('/api/orders', orderRoutes);
  const server = await listen(app);
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // ── Test 1: Discount settings exist in database ──────────────────────
    console.log('\n1. Discount settings exist in database');
    {
      const db = getDatabase();
      for (const [key, expectedValue] of Object.entries(EXPECTED_DISCOUNT_SETTINGS)) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
        assert(row !== undefined, `setting "${key}" exists`);
        if (row) {
          assertEqual(row.value, expectedValue, `setting "${key}" has value "${expectedValue}"`);
        }
      }
    }

    // ── Test 2: Order-level percentage discount ──────────────────────────
    console.log('\n2. PATCH /api/orders/:id/discount — percentage discount');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'percentage',
          discount_value: 10,
          discount_reason: 'Happy hour',
        }),
      });
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.order.discount_type, 'percentage', 'discount_type is percentage');
      assertEqual(res.data.order.discount_value, 10, 'discount_value is 10');
      assertEqual(res.data.order.discount_amount, 50, 'discount_amount is 50 (10% of 500)');
      assertEqual(res.data.order.total, 450, 'total updated to 450');
    }

    // The install default is percentage-only. Enable flat discounts for
    // the legacy flat-discount behavior checks below.
    {
      const db = getDatabase();
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('both', 'discount_mode');
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('100', 'discount_max_amount');
    }

    // ── Test 3: Order-level amount discount ──────────────────────────────
    console.log('\n3. PATCH /api/orders/:id/discount — amount discount');
    {
      // Reset order to original state (clear previous discount)
      const db = getDatabase();
      db.prepare('UPDATE orders SET discount_type = NULL, discount_value = 0, discount_amount = 0, total = 500 WHERE id = ?').run(orderId);

      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'amount',
          discount_value: 75,
        }),
      });
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.order.discount_type, 'amount', 'discount_type is amount');
      assertEqual(res.data.order.discount_value, 75, 'discount_value is 75');
      assertEqual(res.data.order.discount_amount, 75, 'discount_amount is 75');
      assertEqual(res.data.order.total, 425, 'total updated to 425');
    }

    // ── Test 4: Invalid discount type ────────────────────────────────────
    console.log('\n4. PATCH /api/orders/:id/discount — invalid type');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'invalid',
          discount_value: 10,
        }),
      });
      assertEqual(res.status, 400, 'returns 400');
      assertIncludes(res.data.error, 'discount_type', 'error mentions discount_type');
    }

    // ── Test 5: Negative discount value ──────────────────────────────────
    console.log('\n5. PATCH /api/orders/:id/discount — negative value');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'percentage',
          discount_value: -5,
        }),
      });
      assertEqual(res.status, 400, 'returns 400');
      assertIncludes(res.data.error, 'non-negative', 'error mentions non-negative');
    }

    // ── Test 6: Percentage exceeds max ───────────────────────────────────
    console.log('\n6. PATCH /api/orders/:id/discount — percentage exceeds max');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'percentage',
          discount_value: 60,
        }),
      });
      assertEqual(res.status, 400, 'returns 400');
      assertIncludes(res.data.error, 'maximum', 'error mentions maximum');
    }

    // ── Test 7: Amount exceeds max ───────────────────────────────────────
    console.log('\n7. PATCH /api/orders/:id/discount — amount exceeds max');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'amount',
          discount_value: 150,
        }),
      });
      assertEqual(res.status, 400, 'returns 400');
      assertIncludes(res.data.error, 'maximum', 'error mentions maximum');
    }

    // ── Test 8: 404 for missing order ────────────────────────────────────
    console.log('\n8. PATCH /api/orders/:id/discount — 404 for missing order');
    {
      const res = await request(baseUrl, '/api/orders/99999/discount', {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'percentage',
          discount_value: 10,
        }),
      });
      assertEqual(res.status, 404, 'returns 404');
      assertIncludes(res.data.error, 'Order not found', 'error mentions Order not found');
    }

    // ── Test 9: Item-level amount discount ───────────────────────────────
    console.log('\n9. PATCH /api/orders/:id/items/:itemId/discount — amount discount');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'amount',
          discount_value: 25,
        }),
      });
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.item.discount_amount, 25, 'item discount_amount is 25');
    }

    // ── Test 10: Item-level percentage discount ──────────────────────────
    console.log('\n10. PATCH /api/orders/:id/items/:itemId/discount — percentage discount');
    {
      // Reset item to original state (clear previous discount)
      const db = getDatabase();
      db.prepare('UPDATE order_items SET discount_amount = 0, subtotal = 500, total = 500 WHERE id = ?').run(itemId);

      const res = await request(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'percentage',
          discount_value: 10,
        }),
      });
      assertEqual(res.status, 200, 'returns 200');
      assertEqual(res.data.item.discount_amount, 50, 'item discount_amount is 50 (10% of 500)');
    }

    // ── Test 11: 404 for missing item ────────────────────────────────────
    console.log('\n11. PATCH /api/orders/:id/items/:itemId/discount — 404 for missing item');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/items/99999/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'amount',
          discount_value: 10,
        }),
      });
      assertEqual(res.status, 404, 'returns 404');
      assertIncludes(res.data.error, 'Item not found', 'error mentions Item not found');
    }

    // ── Test 12: 404 for missing order on item discount ──────────────────
    console.log('\n12. PATCH /api/orders/:id/items/:itemId/discount — 404 for missing order');
    {
      const res = await request(baseUrl, '/api/orders/99999/items/1/discount', {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'amount',
          discount_value: 10,
        }),
      });
      assertEqual(res.status, 404, 'returns 404');
      assertIncludes(res.data.error, 'Order not found', 'error mentions Order not found');
    }

    // ── Test 13: Zero discount value removes discount ────────────────────
    console.log('\n13. PATCH /api/orders/:id/discount — zero value removes discount');
    {
      const res = await request(baseUrl, `/api/orders/${orderId}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({
          discount_type: 'percentage',
          discount_value: 0,
        }),
      });
      assertEqual(res.status, 200, 'returns 200 (zero removes discount)');
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
