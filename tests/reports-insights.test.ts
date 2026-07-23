/**
 * GET /api/reports/insights — Dashboard metrics enhancement (#77)
 *
 * Verifies AOV, top staff, top categories, avg prep time, and the
 * timezone-aware busiest/idlest hour & day-of-week bucketing.
 *
 * The hour/day fixtures below use fixed UTC timestamps whose expected
 * Asia/Kolkata (UTC+5:30, no DST) local hour/weekday were independently
 * precomputed with the same Intl approach the endpoint uses — see the
 * commit that added this test for the derivation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/reports-insights.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-insights-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-reports-insights';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { reportRoutes } = require('../main/routes/reports');

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

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

async function main() {
  console.log('GET /api/reports/insights');
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
  db.prepare(`UPDATE settings SET value = 'Asia/Kolkata' WHERE key = 'timezone'`).run();
  if ((db.prepare(`SELECT COUNT(*) as c FROM settings WHERE key = 'timezone'`).get() as any).c === 0) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('timezone', 'Asia/Kolkata')`).run();
  }

  // ── Seed staff ────────────────────────────────────────────────────────
  const ownerId = 'owner-insights';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(ownerId, 'Owner', 'owner-insights@test.local', bcrypt.hashSync('pw', 10), 'owner', now(), now());
  const cashierId = 'cashier-insights';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(cashierId, 'Top Cashier', 'cashier-insights@test.local', bcrypt.hashSync('pw', 10), 'cashier', now(), now());
  const waiterId = 'waiter-insights';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(waiterId, 'Waiter', 'waiter-insights@test.local', bcrypt.hashSync('pw', 10), 'waiter', now(), now());
  // Dedicated to the hour/day bucketing fixtures below, kept separate from
  // cashier/waiter so its order count doesn't skew the top-staff-by-revenue
  // assertions (its orders are zero-value — only their created_at matters).
  const bucketUserId = 'bucket-fixtures-insights';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(bucketUserId, 'Bucket Fixtures', 'bucket-insights@test.local', bcrypt.hashSync('pw', 10), 'waiter', now(), now());

  // ── Seed categories + products ───────────────────────────────────────
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-drinks', 'Drinks', 1);
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-food', 'Food', 2);
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)`)
    .run('prod-tea', 'cat-drinks', 'Tea', 20);
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 2)`)
    .run('prod-burger', 'cat-food', 'Burger', 200);

  // ── Seed orders for hour/day-of-week bucketing ───────────────────────
  // Expected (precomputed): busiest hour=14 (3 orders), idlest hour=8 (1),
  // busiest day=Monday (3), idlest day=Tuesday (0 — no fixture lands there).
  const hourDayFixtures: { id: string; createdAt: string }[] = [
    { id: 'ORD-INS-1', createdAt: '2026-06-01T08:30:00.000Z' }, // Mon 14:00
    { id: 'ORD-INS-2', createdAt: '2026-06-01T09:00:00.000Z' }, // Mon 14:30
    { id: 'ORD-INS-3', createdAt: '2026-06-01T09:15:00.000Z' }, // Mon 14:45
    { id: 'ORD-INS-4', createdAt: '2026-06-03T04:00:00.000Z' }, // Wed 09:30
    { id: 'ORD-INS-5', createdAt: '2026-06-04T03:00:00.000Z' }, // Thu 08:30
    { id: 'ORD-INS-6', createdAt: '2026-06-05T05:00:00.000Z' }, // Fri 10:30
    { id: 'ORD-INS-7', createdAt: '2026-06-06T06:00:00.000Z' }, // Sat 11:30
    { id: 'ORD-INS-8', createdAt: '2026-06-07T07:00:00.000Z' }, // Sun 12:30
  ];
  // Zero-value on purpose — only created_at matters for bucketing, and this
  // keeps these 8 orders from perturbing the top-staff revenue ranking below.
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, cooking_started_at, ready_at)
    VALUES (?, ?, 'takeaway', 'completed', 0, 0, ?, ?, ?, ?)
  `);
  for (const fixture of hourDayFixtures) {
    insertOrder.run(fixture.id, bucketUserId, fixture.createdAt, fixture.createdAt, null, null);
  }

  // These four use fixed timestamps rather than now() so they land in hour/day
  // buckets that don't perturb the busiest/idlest fixture above (each is on a
  // distinct weekday and hour, none matching Monday/Tuesday or hour 8/14) —
  // otherwise a test run whose real wall-clock happens to fall in the same
  // Kolkata hour or weekday as the crafted fixtures would flip the result.
  // ── Seed prep-time orders: 10 min and 20 min -> avg 15 min ───────────
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, cooking_started_at, ready_at)
    VALUES (?, ?, 'takeaway', 'completed', 50, 50, ?, ?, ?, ?)
  `).run('ORD-PREP-1', cashierId, '2026-05-01T04:00:00.000Z', '2026-05-01T04:00:00.000Z', '2026-07-01T10:00:00.000Z', '2026-07-01T10:10:00.000Z');
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, cooking_started_at, ready_at)
    VALUES (?, ?, 'takeaway', 'completed', 50, 50, ?, ?, ?, ?)
  `).run('ORD-PREP-2', waiterId, '2026-05-02T05:00:00.000Z', '2026-05-02T05:00:00.000Z', '2026-07-01T11:00:00.000Z', '2026-07-01T11:20:00.000Z');

  // ── Seed top-staff orders: cashier earns more than waiter ────────────
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'completed', 500, 500, ?, ?)
  `).run('ORD-STAFF-CASHIER', cashierId, '2026-05-03T06:00:00.000Z', '2026-05-03T06:00:00.000Z');
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'completed', 50, 50, ?, ?)
  `).run('ORD-STAFF-WAITER', waiterId, '2026-05-06T07:00:00.000Z', '2026-05-06T07:00:00.000Z');

  // A cancelled order with a huge total must NOT count toward top staff or AOV.
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'cancelled', 99999, 99999, ?, ?)
  `).run('ORD-CANCELLED', cashierId, now(), now());

  // ── Seed top-category order_items: Food (Burger) outsells Drinks (Tea) ──
  const categoryOrderId = (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-STAFF-CASHIER'`).get() as any).id;
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'served', ?, ?)
  `).run(categoryOrderId, 'prod-burger', 'Burger', 200, 2, 400, 400, now(), now());
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'served', ?, ?)
  `).run(categoryOrderId, 'prod-tea', 'Tea', 20, 5, 100, 100, now(), now());

  // ── Seed AOV: two paid bills totaling 300 across 2 bills -> AOV 150 ──
  const billOrderId1 = (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-STAFF-CASHIER'`).get() as any).id;
  const billOrderId2 = (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-STAFF-WAITER'`).get() as any).id;
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
    VALUES (?, ?, 100, 100, 0, 'paid', ?, ?, ?)
  `).run('BILL-INS-1', billOrderId1, now(), now(), now());
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
    VALUES (?, ?, 200, 200, 0, 'paid', ?, ?, ?)
  `).run('BILL-INS-2', billOrderId2, now(), now(), now());

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  app.use('/api/reports', reportRoutes);

  const ownerToken = jwt.sign({ userId: ownerId, email: 'owner-insights@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const waiterToken = jwt.sign({ userId: waiterId, email: 'waiter-insights@test.local', role: 'waiter' }, getJWTSecret(), { expiresIn: '1h' });

  try {
    console.log('\n1. Role gating');
    {
      const forbidden = await request(app).get('/api/reports/insights').set('Authorization', `Bearer ${waiterToken}`);
      assertEqual(forbidden.status, 403, `waiter is forbidden (got ${forbidden.status})`);
    }

    console.log('\n2. GET /api/reports/insights?days=90');
    const res = await request(app).get('/api/reports/insights?days=90').set('Authorization', `Bearer ${ownerToken}`);
    assertEqual(res.status, 200, `owner gets 200 (got ${res.status}, ${JSON.stringify(res.body)})`);
    const body = res.body;

    console.log('\n3. AOV');
    assertEqual(body.aov, 150, 'AOV is (100+200)/2 = 150');

    console.log('\n4. Avg prep time');
    assertEqual(body.avgPrepTimeMinutes, 15, 'avg prep time is (10+20)/2 = 15 minutes');

    console.log('\n5. Top staff (cancelled order excluded, cashier ranks above waiter)');
    assertEqual(body.topStaff?.[0]?.user_id, cashierId, 'cashier is #1 by revenue');
    assertEqual(body.topStaff?.[0]?.revenue, 550, 'cashier revenue is 500 (ORD-STAFF-CASHIER) + 50 (ORD-PREP-1) = 550');
    assertEqual(body.topStaff?.[1]?.user_id, waiterId, 'waiter is #2 by revenue');
    assertEqual(body.topStaff?.[1]?.revenue, 100, 'waiter revenue is 50 (ORD-STAFF-WAITER) + 50 (ORD-PREP-2) = 100');
    const cancelledCounted = (body.topStaff ?? []).some((s: any) => s.revenue >= 99999);
    assert(!cancelledCounted, 'the cancelled order revenue (99999) is excluded from top staff');

    console.log('\n6. Top categories (Food/Burger outsells Drinks/Tea)');
    assertEqual(body.topCategories?.[0]?.name, 'Food', 'Food is the top category by revenue');
    assertEqual(body.topCategories?.[0]?.revenue, 400, 'Food revenue is 2 x 200');
    assertEqual(body.topCategories?.[1]?.name, 'Drinks', 'Drinks is #2');

    console.log('\n7. Busiest/idlest hour (Asia/Kolkata)');
    assertEqual(body.busiestHour?.hour, 14, 'busiest hour is 14:00 local (3 orders)');
    assertEqual(body.busiestHour?.orderCount, 3, 'busiest hour has 3 orders');
    assertEqual(body.idlestHour?.hour, 8, 'idlest (non-zero) hour is 08:00 local');
    assertEqual(body.idlestHour?.orderCount, 1, 'idlest hour has 1 order');

    console.log('\n8. Busiest/idlest day of week (Asia/Kolkata)');
    assertEqual(body.busiestDayOfWeek?.dayIndex, 1, 'busiest day is Monday (index 1)');
    assertEqual(body.busiestDayOfWeek?.orderCount, 3, 'Monday has 3 orders');
    assertEqual(body.idlestDayOfWeek?.dayIndex, 2, 'idlest day is Tuesday (index 2), with zero orders — a real signal, unlike hour zeros');
    assertEqual(body.idlestDayOfWeek?.orderCount, 0, 'Tuesday has 0 orders in the fixture window');

    console.log('\n9. GET /api/reports/recentOrders?date=X scopes to that day (dashboard date picker)');
    {
      const dated = await request(app).get('/api/reports/recentOrders?date=2026-06-01&limit=10').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(dated.status, 200, `owner gets 200 (got ${dated.status})`);
      const numbers = (dated.body.recentOrders ?? []).map((o: any) => o.order_number).sort();
      assertEqual(JSON.stringify(numbers), JSON.stringify(['ORD-INS-1', 'ORD-INS-2', 'ORD-INS-3']), 'only the 3 orders created on 2026-06-01 are returned');

      const undated = await request(app).get('/api/reports/recentOrders?limit=1').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(undated.status, 200, `omitting date still works — most-recent-overall behavior preserved (got ${undated.status})`);
      assert(Array.isArray(undated.body.recentOrders) && undated.body.recentOrders.length === 1, 'no date param still returns most-recent-overall, unaffected by the new filter');
    }

  } finally {
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
