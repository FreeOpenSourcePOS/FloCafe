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
const { initDatabase, getDatabase, closeDatabase, now, localDateInTimezone, parseDbTimestamp } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { reportRoutes } = require('../main/routes/reports');

let passed = 0;
let failed = 0;
let total = 0;

function dbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

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
  const waiterId = 'server-insights';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(waiterId, 'Server', 'server-insights@test.local', bcrypt.hashSync('pw', 10), 'server', now(), now());
  // Dedicated to the hour/day bucketing fixtures below, kept separate from
  // cashier/server so its order count doesn't skew the top-staff-by-revenue
  // assertions (its orders are zero-value — only their created_at matters).
  const bucketUserId = 'bucket-fixtures-insights';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(bucketUserId, 'Bucket Fixtures', 'bucket-insights@test.local', bcrypt.hashSync('pw', 10), 'server', now(), now());

  // Keep rolling-window fixtures safely within the insights query window,
  // while placing them on Wed–Sat at Kolkata hours that cannot affect the
  // crafted Mon/Tue and 08:00/14:00 bucketing assertions below.
  //
  // `weeksAgo` lets two independent fixture sets share this helper while
  // landing on different calendar weeks — required so the hour/day-of-week
  // bucketing counts below (computed by weekday-name and hour-of-day only,
  // not by specific date) don't accidentally double up. Both sets must also
  // stay within the endpoint's 90-day trailing window, so timestamps are
  // computed relative to "now" rather than pinned to a fixed calendar date
  // that would eventually age out of that window.
  const relativeWeekdayTimestamp = (weekday: number, utcHour: number, utcMinute: number, weeksAgo: number) => {
    const date = new Date();
    const daysSinceWeekday = (date.getUTCDay() - weekday + 7) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceWeekday - weeksAgo * 7);
    date.setUTCHours(utcHour, utcMinute, 0, 0);
    return dbTimestamp(date);
  };
  const recentWeekdayTimestamp = (weekday: number, utcHour: number) => relativeWeekdayTimestamp(weekday, utcHour, 0, 1);
  const prepOneCreatedAt = recentWeekdayTimestamp(3, 4); // Wed, 09:30 Kolkata
  const prepTwoCreatedAt = recentWeekdayTimestamp(4, 5); // Thu, 10:30 Kolkata
  const cashierRevenueCreatedAt = recentWeekdayTimestamp(5, 6); // Fri, 11:30 Kolkata
  const waiterRevenueCreatedAt = recentWeekdayTimestamp(6, 7); // Sat, 12:30 Kolkata

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
  // These used to be pinned to a fixed calendar week (2026-06-01..07), which
  // silently aged out of the endpoint's 90-day trailing window once "now"
  // moved far enough past it — the fixed dates were excluded from the
  // report entirely, leaving only the "recent" fixtures above to determine
  // busiest hour/day. Anchored to a Monday well back from "now" instead, so
  // this can never drift out of the 90-day window again. All 8 timestamps
  // are offset from one shared Monday anchor — computing each weekday
  // independently via "most recent occurrence on/before today" (like the
  // `recentWeekdayTimestamp` helper above) would put Monday and Wednesday in
  // different calendar weeks whenever "today" falls between them, breaking
  // section 9's Monday→Wednesday date-range assertion below.
  //
  // The offset (21 days) must keep every day of this bucket week strictly
  // earlier than the "recent" fixtures above: `daysSinceWeekday` there
  // ranges 0-6 before the +7 (weeksAgo=1), so those land 7-13 days back.
  // Sunday, the closest day of the bucket week to "now", is anchor-6 days
  // back, ranging 15-21 — comfortably past that 13-day ceiling. A smaller
  // offset (e.g. 14) can let the two sets land on the same calendar day
  // depending on what weekday "today" is, and the range assertion in
  // section 9 would then pick up an extra order.
  const bucketWeekAnchor = (() => {
    const date = new Date();
    const daysSinceMonday = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
    date.setUTCDate(date.getUTCDate() - daysSinceMonday - 21);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  })();
  const bucketTimestamp = (dayOffsetFromMonday: number, utcHour: number, utcMinute: number) => {
    const d = new Date(bucketWeekAnchor);
    d.setUTCDate(d.getUTCDate() + dayOffsetFromMonday);
    d.setUTCHours(utcHour, utcMinute, 0, 0);
    return dbTimestamp(d);
  };
  const hourDayFixtures: { id: string; createdAt: string }[] = [
    { id: 'ORD-INS-1', createdAt: bucketTimestamp(0, 8, 30) }, // Mon 14:00 Kolkata
    { id: 'ORD-INS-2', createdAt: bucketTimestamp(0, 9, 0) },  // Mon 14:30 Kolkata
    { id: 'ORD-INS-3', createdAt: bucketTimestamp(0, 9, 15) }, // Mon 14:45 Kolkata
    { id: 'ORD-INS-4', createdAt: bucketTimestamp(2, 4, 0) },  // Wed 09:30 Kolkata
    { id: 'ORD-INS-5', createdAt: bucketTimestamp(3, 3, 0) },  // Thu 08:30 Kolkata
    { id: 'ORD-INS-6', createdAt: bucketTimestamp(4, 5, 0) },  // Fri 10:30 Kolkata
    { id: 'ORD-INS-7', createdAt: bucketTimestamp(5, 6, 0) },  // Sat 11:30 Kolkata
    { id: 'ORD-INS-8', createdAt: bucketTimestamp(6, 7, 0) },  // Sun 12:30 Kolkata
  ];
  // Tenant-local calendar dates of the Monday/Wednesday fixtures above,
  // reused by the recentOrders date-scoping assertions (section 9) instead
  // of hardcoding the dates a second time.
  const bucketMondayDate = localDateInTimezone(parseDbTimestamp(hourDayFixtures[0].createdAt), 'Asia/Kolkata');
  const bucketWednesdayDate = localDateInTimezone(parseDbTimestamp(hourDayFixtures[3].createdAt), 'Asia/Kolkata');
  // Zero-value on purpose — only created_at matters for bucketing, and this
  // keeps these 8 orders from perturbing the top-staff revenue ranking below.
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, cooking_started_at, ready_at)
    VALUES (?, ?, 'takeaway', 'completed', 0, 0, ?, ?, ?, ?)
  `);
  for (const fixture of hourDayFixtures) {
    insertOrder.run(fixture.id, bucketUserId, fixture.createdAt, fixture.createdAt, null, null);
  }

  // These rolling-window fixtures use controlled recent timestamps so they
  // remain in the 90-day query window without perturbing the bucketing checks.
  // ── Seed prep-time orders: 10 min and 20 min -> avg 15 min ───────────
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, cooking_started_at, ready_at)
    VALUES (?, ?, 'takeaway', 'completed', 50, 50, ?, ?, ?, ?)
  `).run('ORD-PREP-1', cashierId, prepOneCreatedAt, prepOneCreatedAt, prepOneCreatedAt, dbTimestamp(new Date(parseDbTimestamp(prepOneCreatedAt).getTime() + 10 * 60 * 1000)));
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, cooking_started_at, ready_at)
    VALUES (?, ?, 'takeaway', 'completed', 50, 50, ?, ?, ?, ?)
  `).run('ORD-PREP-2', waiterId, prepTwoCreatedAt, prepTwoCreatedAt, prepTwoCreatedAt, dbTimestamp(new Date(parseDbTimestamp(prepTwoCreatedAt).getTime() + 20 * 60 * 1000)));

  // ── Seed top-staff orders: cashier earns more than server ────────────
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'completed', 500, 500, ?, ?)
  `).run('ORD-STAFF-CASHIER', cashierId, cashierRevenueCreatedAt, cashierRevenueCreatedAt);
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'completed', 50, 50, ?, ?)
  `).run('ORD-STAFF-WAITER', waiterId, waiterRevenueCreatedAt, waiterRevenueCreatedAt);

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

  const categorizedSnapshot = JSON.stringify({
    lines: [{
      lineId: 'burger',
      components: [
        { ruleId: 'state-tax', label: 'State Tax', rate: '2.5', amount: '5' },
        { ruleId: 'local-tax', label: 'Local Tax', rate: '2.5', amount: '5' },
      ],
    }],
  });
  db.prepare(`UPDATE order_items SET tax_amount = 10, tax_snapshot = ?, tax_breakdown = ? WHERE order_id = ? AND product_id = ?`)
    .run(categorizedSnapshot, JSON.stringify([{ title: 'WRONG', rate: 99, amount: 99 }]), billOrderId1, 'prod-burger');
  db.prepare(`UPDATE order_items SET tax_amount = 1.4, tax_snapshot = NULL, tax_breakdown = ? WHERE order_id = ? AND product_id = ?`)
    .run(JSON.stringify([{ title: 'VAT', rate: 7, amount: 1.4 }]), billOrderId1, 'prod-tea');
  db.prepare(`UPDATE bills SET tax_amount = 11.4, tax_snapshot = ?, tax_breakdown = ? WHERE bill_number = ?`)
    .run(
      JSON.stringify([JSON.parse(categorizedSnapshot)]),
      JSON.stringify([
        { title: 'State Tax', rate: 2.5, amount: 5 },
        { title: 'Local Tax', rate: 2.5, amount: 5 },
        { title: 'VAT', rate: 7, amount: 1.4 },
      ]),
      'BILL-INS-1',
    );

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
  const waiterToken = jwt.sign({ userId: waiterId, email: 'server-insights@test.local', role: 'server' }, getJWTSecret(), { expiresIn: '1h' });

  try {
    console.log('\n1. Role gating');
    {
      const forbidden = await request(app).get('/api/reports/insights').set('Authorization', `Bearer ${waiterToken}`);
      assertEqual(forbidden.status, 403, `server is forbidden (got ${forbidden.status})`);
    }

    console.log('\n2. GET /api/reports/insights?days=90');
    const res = await request(app).get('/api/reports/insights?days=90').set('Authorization', `Bearer ${ownerToken}`);
    assertEqual(res.status, 200, `owner gets 200 (got ${res.status}, ${JSON.stringify(res.body)})`);
    const body = res.body;

    console.log('\n3. AOV');
    assertEqual(body.aov, 150, 'AOV is (100+200)/2 = 150');

    console.log('\n4. Avg prep time');
    assertEqual(body.avgPrepTimeMinutes, 15, 'avg prep time is (10+20)/2 = 15 minutes');

    console.log('\n5. Top staff (cancelled order excluded, cashier ranks above server)');
    assertEqual(body.topStaff?.[0]?.user_id, cashierId, 'cashier is #1 by revenue');
    assertEqual(body.topStaff?.[0]?.revenue, 550, 'cashier revenue is 500 (ORD-STAFF-CASHIER) + 50 (ORD-PREP-1) = 550');
    assertEqual(body.topStaff?.[1]?.user_id, waiterId, 'server is #2 by revenue');
    assertEqual(body.topStaff?.[1]?.revenue, 100, 'server revenue is 50 (ORD-STAFF-WAITER) + 50 (ORD-PREP-2) = 100');
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
      const dated = await request(app).get(`/api/reports/recentOrders?date=${bucketMondayDate}&limit=10`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(dated.status, 200, `owner gets 200 (got ${dated.status})`);
      const numbers = (dated.body.recentOrders ?? []).map((o: any) => o.order_number).sort();
      assertEqual(JSON.stringify(numbers), JSON.stringify(['ORD-INS-1', 'ORD-INS-2', 'ORD-INS-3']), `only the 3 orders created on ${bucketMondayDate} are returned`);

      const ranged = await request(app).get(`/api/reports/recentOrders?start_date=${bucketMondayDate}&end_date=${bucketWednesdayDate}&limit=10`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(ranged.status, 200, `owner can request a month-style date range (got ${ranged.status})`);
      const rangedNumbers = (ranged.body.recentOrders ?? []).map((o: any) => o.order_number).sort();
      assertEqual(JSON.stringify(rangedNumbers), JSON.stringify(['ORD-INS-1', 'ORD-INS-2', 'ORD-INS-3', 'ORD-INS-4']), 'date range includes orders from both boundary dates');

      const mixedRange = await request(app).get('/api/reports/recentOrders?date=2026-06-01&start_date=2026-06-01').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(mixedRange.status, 400, 'single-date and range filters cannot be combined');

      const undated = await request(app).get('/api/reports/recentOrders?limit=1').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(undated.status, 200, `omitting date still works — most-recent-overall behavior preserved (got ${undated.status})`);
      assert(Array.isArray(undated.body.recentOrders) && undated.body.recentOrders.length === 1, 'no date param still returns most-recent-overall, unaffected by the new filter');
    }

    console.log('\n10. Dynamic tax component report handles mixed categorized + legacy items');
    {
      const today = localDateInTimezone(new Date(), 'Asia/Kolkata');
      const forbidden = await request(app)
        .get(`/api/reports/tax-components?start_date=${today}&end_date=${today}`)
        .set('Authorization', `Bearer ${waiterToken}`);
      assertEqual(forbidden.status, 403, 'tax component report retains reports role gating');

      const taxReport = await request(app)
        .get(`/api/reports/tax-components?start_date=${today}&end_date=${today}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(taxReport.status, 200, `owner gets tax report (got ${taxReport.status})`);
      assertEqual(taxReport.body.taxComponents?.taxAmount, 11.4, 'tax total is summed across bills in range');
      const components = taxReport.body.taxComponents?.components ?? [];
      assertEqual(components.find((part: any) => part.title === 'State Tax')?.amount, 5, 'categorized State Tax is read from snapshot');
      assertEqual(components.find((part: any) => part.title === 'Local Tax')?.amount, 5, 'categorized Local Tax is read from snapshot');
      assertEqual(components.find((part: any) => part.title === 'VAT')?.amount, 1.4, 'legacy VAT is included once');
      assert(!components.some((part: any) => part.title === 'WRONG'), 'categorized legacy copy is not double-counted');
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
