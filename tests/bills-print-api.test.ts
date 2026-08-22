/**
 * Bills Print API Tests (supertest)
 *
 * Tests the POST /api/bills/:id/print and GET /api/bills/:id/print-history
 * endpoints by exercising the actual Express routes via supertest.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/bills-print-api.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron before importing any app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bills-print-api-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

// Set JWT_SECRET before importing auth modules
process.env.JWT_SECRET = 'test-secret-for-bills-print-api';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { billRoutes } = require('../main/routes/bills');

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

// ── Database setup ──────────────────────────────────────────────────────────

try {
  initDatabase();
} catch (error: any) {
  if (error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION')) {
    console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
    process.exit(77); // exit code 77 = skip (GNU convention)
  }
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
}

const db = getDatabase();

// Create prerequisite rows for foreign keys
db.exec("INSERT OR IGNORE INTO users (id, name, password, role) VALUES ('user-1', 'Test User', 'hash', 'cashier')");
db.exec("INSERT OR IGNORE INTO users (id, name, password, role) VALUES ('user-2', 'Cashier Two', 'hash', 'cashier')");
db.exec("INSERT OR IGNORE INTO orders (order_number, user_id) VALUES ('ORD-PRINT-API-0001', 'user-1')");
db.exec("INSERT OR IGNORE INTO bills (bill_number, order_id) VALUES ('INV-PRINT-API-0001', (SELECT id FROM orders WHERE order_number = 'ORD-PRINT-API-0001'))");

const testBillId = db.prepare("SELECT id FROM bills WHERE bill_number = 'INV-PRINT-API-0001'").get() as { id: number } | undefined;

// ── Express app for supertest ───────────────────────────────────────────────

// Build a minimal Express app that mirrors the production middleware stack
// (requireAuth + billRoutes) so supertest hits the real route handlers.
const app = express();
app.use(express.json());

// Replicate requireAuth from server.ts — verifies JWT and attaches decoded
// payload to req.user so downstream handlers can access it without re-verifying.
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

app.use('/api/bills', billRoutes);

// Generate a valid JWT for test requests
const token = jwt.sign(
  { userId: 'user-1', email: 'test@flo.local', role: 'cashier' },
  getJWTSecret(),
  { expiresIn: '1h' }
);
const authHeader = `Bearer ${token}`;

console.log('Bills Print API Tests (supertest)');
console.log('='.repeat(50));

// ── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  // ── Test 1: POST /api/bills/:id/print logs print action ────────────
  console.log('\nTest 1: POST /api/bills/:id/print logs print action');
  {
    if (!testBillId) {
      assert(false, 'skipped: no test bill found');
    } else {
      const initialCount = (db.prepare('SELECT COUNT(*) as count FROM print_logs WHERE bill_id = ?').get(testBillId.id) as { count: number }).count;

      const res = await request(app)
        .post(`/api/bills/${testBillId.id}/print`)
        .set('Authorization', authHeader)
        .send({ print_type: 'receipt' });

      assert(res.status === 200, `POST /print returns 200 (got ${res.status})`);
      assert(res.body.success === true, 'POST /print returns success: true');
      assert(res.body.printLogId !== undefined, 'POST /print returns printLogId');

      const finalCount = (db.prepare('SELECT COUNT(*) as count FROM print_logs WHERE bill_id = ?').get(testBillId.id) as { count: number }).count;
      assert(finalCount === initialCount + 1, 'print_logs entry created for bill');
    }
  }

  // ── Test 2: POST /api/bills/:id/print with invalid bill returns 404 ─
  console.log('\nTest 2: POST /api/bills/:id/print with non-existent bill returns 404');
  {
    const res = await request(app)
      .post('/api/bills/999999/print')
      .set('Authorization', authHeader)
      .send({ print_type: 'receipt' });

    assert(res.status === 404, `returns 404 for non-existent bill (got ${res.status})`);
    assert(res.body.error !== undefined, 'response includes error message');
  }

  // ── Test 3: POST /api/bills/:id/print with reprint type ────────────
  console.log('\nTest 3: POST /api/bills/:id/print with reprint type');
  {
    if (!testBillId) {
      assert(false, 'skipped: no test bill found');
    } else {
      const res = await request(app)
        .post(`/api/bills/${testBillId.id}/print`)
        .set('Authorization', authHeader)
        .send({ print_type: 'reprint' });

      assert(res.status === 200, `reprint returns 200 (got ${res.status})`);
      assert(res.body.success === true, 'reprint returns success: true');

      const log = db.prepare('SELECT print_type FROM print_logs WHERE bill_id = ? ORDER BY id DESC LIMIT 1').get(testBillId.id) as { print_type: string } | undefined;
      assert(log !== undefined, 'print_log row exists after reprint');
      assert(log!.print_type === 'reprint', 'print_type is "reprint"');
    }
  }

  // ── Test 4: POST /api/bills/:id/print with missing print_type returns 400 ──
  console.log('\nTest 4: POST /api/bills/:id/print with missing print_type returns 400');
  {
    if (!testBillId) {
      assert(false, 'skipped: no test bill found');
    } else {
      const res = await request(app)
        .post(`/api/bills/${testBillId.id}/print`)
        .set('Authorization', authHeader)
        .send({});

      assert(res.status === 400, `returns 400 for missing print_type (got ${res.status})`);
      assert(res.body.error !== undefined, 'response includes error message');
    }
  }

  // ── Test 5: POST /api/bills/:id/print without auth returns 401 ────
  console.log('\nTest 5: POST /api/bills/:id/print without auth returns 401');
  {
    if (!testBillId) {
      assert(false, 'skipped: no test bill found');
    } else {
      const res = await request(app)
        .post(`/api/bills/${testBillId.id}/print`)
        .send({ print_type: 'receipt' });

      assert(res.status === 401, `returns 401 without auth (got ${res.status})`);
    }
  }

  // ── Test 6: GET /api/bills/:id/print-history returns print logs ────
  console.log('\nTest 6: GET /api/bills/:id/print-history returns print logs');
  {
    if (!testBillId) {
      assert(false, 'skipped: no test bill found');
    } else {
      const res = await request(app)
        .get(`/api/bills/${testBillId.id}/print-history`)
        .set('Authorization', authHeader);

      assert(res.status === 200, `print-history returns 200 (got ${res.status})`);
      assert(Array.isArray(res.body.prints), 'print-history returns an array');
      assert(res.body.prints.length >= 2, `print-history has at least 2 entries (got ${res.body.prints.length})`);
      assert(
        res.body.prints[0].user_name === 'Test User' || res.body.prints[0].user_name === 'Cashier Two',
        'print log includes user_name'
      );
    }
  }

  // ── Test 7: GET /api/bills/:id/print-history returns empty for bill with no prints ──
  console.log('\nTest 7: GET /api/bills/:id/print-history returns empty for new bill');
  {
    // Create a new bill with no print history
    db.exec("INSERT OR IGNORE INTO orders (order_number, user_id) VALUES ('ORD-PRINT-API-EMPTY', 'user-1')");
    const newOrder = db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-PRINT-API-EMPTY'").get() as { id: number };
    db.exec(`INSERT INTO bills (bill_number, order_id) VALUES ('INV-PRINT-API-EMPTY', ${newOrder.id})`);
    const newBill = db.prepare("SELECT id FROM bills WHERE bill_number = 'INV-PRINT-API-EMPTY'").get() as { id: number };

    const res = await request(app)
      .get(`/api/bills/${newBill.id}/print-history`)
      .set('Authorization', authHeader);

    assert(res.status === 200, `print-history returns 200 (got ${res.status})`);
    assert(Array.isArray(res.body.prints), 'print-history returns an array for bill with no prints');
    assert(res.body.prints.length === 0, 'print-history is empty for bill with no prints');
  }

  // ── Test 8: POST /api/bills/:id/print updates bill printed_at ──────
  console.log('\nTest 8: POST /api/bills/:id/print updates bill printed_at');
  {
    if (!testBillId) {
      assert(false, 'skipped: no test bill found');
    } else {
      // Reset printed_at
      db.prepare('UPDATE bills SET printed_at = NULL WHERE id = ?').run(testBillId.id);
      const before = db.prepare('SELECT printed_at FROM bills WHERE id = ?').get(testBillId.id) as { printed_at: string | null };
      assert(before.printed_at === null, 'printed_at is null before print');

      const res = await request(app)
        .post(`/api/bills/${testBillId.id}/print`)
        .set('Authorization', authHeader)
        .send({ print_type: 'receipt' });

      assert(res.status === 200, `print returns 200 (got ${res.status})`);
      const after = db.prepare('SELECT printed_at FROM bills WHERE id = ?').get(testBillId.id) as { printed_at: string | null };
      assert(after.printed_at !== null, 'printed_at is set after print');
    }
  }

  // ── Test 9: prepareReceipt honors the arabicShaping request override (#437) ──
  console.log('\nTest 9: prepareReceipt arabicShaping override (#437)');
  {
    const { prepareReceipt } = require('../main/printers/thermal');

    const persianOrder = {
      order_number: 'ORD-FA-437',
      created_at: '2026-08-21 10:00:00',
      items: [
        { product_name: 'چای زعفرانی مخصوص', quantity: 2, unit_price: 250000, total: 500000, tax_amount: 0, addons: [], special_instructions: '' },
        { product_name: 'Espresso', quantity: 1, unit_price: 200000, total: 200000, tax_amount: 0, addons: [], special_instructions: '' },
      ],
    };
    const persianBill = {
      bill_number: 'INV-FA-437',
      subtotal: 700000,
      discount_amount: 0,
      tax_amount: 0,
      service_charge: 0,
      delivery_charge: 0,
      total: 700000,
    };
    const iranBiz = { name: 'کافه فلو', currency_symbol: 'IRR', country: 'IR' };

    // No override and no profile capability: Persian lines are skipped with a
    // precise warning while ASCII lines keep printing.
    const withoutOverride = prepareReceipt(persianOrder, persianBill, iranBiz, 'compact', true);
    const withoutText = withoutOverride.data.toString('utf8');
    assert(!withoutText.includes('چای زعفرانی'), 'without override, Persian item line is skipped');
    assert(
      withoutOverride.warnings.some((w: any) => /Persian\/Arabic/.test(w.message)),
      'without override, skipped Persian line reports Arabic-shaping warning'
    );
    assert(withoutText.includes('Espresso'), 'without override, English item line still prints');

    // Explicit request-body override (renderer global setting): Persian prints.
    const withOverride = prepareReceipt(persianOrder, persianBill, iranBiz, 'compact', true, false, true);
    const withText = withOverride.data.toString('utf8');
    assert(withText.includes('چای زعفرانی'), 'with arabicShaping:true override, Persian item line is emitted');
    assert(withOverride.warnings.length === 0, 'with override, no unsupported-line warnings remain');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });

  process.exit(failed === 0 ? 0 : 1);
}

runTests();
