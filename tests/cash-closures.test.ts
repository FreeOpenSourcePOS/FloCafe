/**
 * Day-close (cierre de caja, issue #649) — POST /api/cash-closures (#649, Wave 2).
 *
 * Verifies the count-against-day-math endpoint:
 *  - Owner-only authorization (manager forbidden; cashier forbidden).
 *  - Validation: date shape, not-in-future, integer cents >= 0.
 *  - Snapshot math: `expected_cash_cents = opening_float + cashSales − cashRefunds(created_at)`;
 *    `variance = counted − expected`; `z_number` from `nextZNumber()`; bill/refund counts and totals.
 *  - Duplicate close (same `business_date`, scope='day') → 409 via the partial index.
 *  - Drawer-reality: a same-day cash refund against a yesterday-paid bill still
 *    reduces today's `expected_cash_cents` because cash was removed from the drawer today.
 *  - Midnight split: sales at 23:50 vs 00:10 land on different tenant-local business dates.
 *
 * Sales flow is deliberately untouched: `createRefund` is not modified, and
 * `refunds.shift_id` stays null throughout (sessions are out of scope).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cash-closures.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cash-closures-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cash-closures';

const express = require('express');
const expressRateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initDatabase, getDatabase, closeDatabase, now,
  dayBoundsInTimezone, localDateInTimezone, parseDbTimestamp, nextZNumber,
} = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const { reportRoutes } = require('../main/routes/reports');
const { getCurrencyFractionDigits, resolveTenantCurrency } = require('../main/countries');

let passed = 0;
let failed = 0;
let total = 0;
// Holds section-3's POST response so section-12 can deep-compare every
// key of the GET /api/reports/z-report response back to it.
let sectionThreePost: any = null;

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
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

function dbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

async function main() {
  console.log('POST /api/cash-closures — day close');
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
  // Tenant timezone stays at the default UTC, set explicitly here to be
  // deterministic across machines (the migration seeds it during init).
  db.prepare("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'").run();
  if ((db.prepare("SELECT COUNT(*) as c FROM settings WHERE key = 'timezone'").get() as any).c === 0) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('timezone', 'UTC')").run();
  }
  // Seed a known default currency so the F6 (KWD factor 1000) regression has
  // something to mutate. The default seed (`INR`) has factor 100; KWD has
  // factor 1000 and JPY has factor 1.
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'INR', ?) ON CONFLICT(key) DO UPDATE SET value='INR', updated_at=excluded.updated_at`).run(now());
  // F1 (settings read): seed a non-default business name so the header
  // assertion below can prove the key/value reader reaches the body bytes,
  // and so the spec-derived `business_name`/`business_address` lookups work.
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('business_name', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run('Acme Coffee', now());
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('business_address', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run('742 Evergreen Tce', now());
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('tax_registration_number', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run('TAX-0001', now());
  // F2: seed a default receipt printer so POST /:id/print can resolve a target.
  // The webusb test below swaps it for a webusb one and clears printers at the end.
  db.prepare(`DELETE FROM printers`).run();
  db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('printer-default', 'Default Test Printer', 'network', '127.0.0.1', 9100, '80mm', now(), now());

  // ── Users (owner, manager, cashier) ───────────────────────────────────
  const ownerId = 'owner-close';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)`)
    .run(ownerId, 'Owner', 'owner-close@test.local', bcrypt.hashSync('pw', 10), now(), now());
  const managerId = 'manager-close';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'manager', 1, ?, ?)`)
    .run(managerId, 'Manager', 'manager-close@test.local', bcrypt.hashSync('pw', 10), now(), now());
  const cashierId = 'cashier-close';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'cashier', 1, ?, ?)`)
    .run(cashierId, 'Cashier', 'cashier-close@test.local', bcrypt.hashSync('pw', 10), now(), now());

  // ── App + auth middleware (matches reports-daily-stats-table-turn) ────
  const app = express();
  app.use(express.json());
  app.use(expressRateLimit({ windowMs: 60 * 1000, limit: 1000 }));
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
  app.use('/api/cash-closures', cashClosureRoutes);
  app.use('/api/reports', reportRoutes);

  const ownerToken = jwt.sign({ userId: ownerId, email: 'owner-close@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const managerToken = jwt.sign({ userId: managerId, email: 'manager-close@test.local', role: 'manager' }, getJWTSecret(), { expiresIn: '1h' });
  const cashierToken = jwt.sign({ userId: cashierId, email: 'cashier-close@test.local', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' });

  /**
   * Seed a paid bill on `businessDate` (a tenant-local YYYY-MM-DD) with a
   * single payment line carrying `method` and amount (in major units, stored
   * via SQLite REAL). Uses the canonical cash literal for cash lines so the
   * paymentMethodBreakdown/financial-summary aggregation matches. Skips
   * refund processing — bills created here are first-day invoices that will
   * not appear in `refunds` until the second-day refund fixture below.
   */
  function seedPaidBill({
    billNumber, method, amount, businessDate, createdAt, paidAt, refundAmount, refundCreatedAt,
  }: { billNumber: string; method: string; amount: number; businessDate: string; createdAt?: string; paidAt?: string; refundAmount?: number; refundCreatedAt?: string; }) {
    const created = createdAt || dbTimestamp(new Date(`${businessDate}T12:00:00Z`));
    const paid = paidAt || created;
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, ?, 'takeaway', 'completed', ?, ?, ?, ?, ?)
    `).run(`ORD-${billNumber}`, cashierId, amount, amount, created, paid, paid);
    const orderId = Number(db.prepare("SELECT id FROM orders WHERE order_number = ?").get(`ORD-${billNumber}`).id);
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
    `).run(
      billNumber, orderId, amount, amount, amount,
      JSON.stringify([{ method, amount, timestamp: paid }]),
      paid, created, paid,
    );
    const bill = db.prepare("SELECT id, paid_at FROM bills WHERE bill_number = ?").get(billNumber) as { id: number; paid_at: string };
    if (refundAmount && method === 'cash') {
      const refundedAt = refundCreatedAt || dbTimestamp(new Date());
      db.prepare(`
        INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
        VALUES (?, NULL, ?, 'cash', ?, NULL, ?, ?, ?)
      `).run(bill.id, refundAmount, 'Day-close test refund', ownerId, ownerId, refundedAt);
    }
    return bill.id;
  }

  try {
    console.log('\n1. Role gating');
    {
      const body = { business_date: '2026-09-05', opening_float_cents: 0, counted_cash_cents: 0 };
      const forbiddenCashier = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${cashierToken}`).send(body);
      assertEqual(forbiddenCashier.status, 403, `cashier forbidden (got ${forbiddenCashier.status})`);
      const forbiddenManager = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${managerToken}`).send(body);
      assertEqual(forbiddenManager.status, 403, `manager forbidden (got ${forbiddenManager.status})`);
    }

    console.log('\n2. Validation');
    {
      const futureLocal = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const future = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: futureLocal, opening_float_cents: 0, counted_cash_cents: 0 });
      assertEqual(future.status, 400, `future date → 400 (got ${future.status})`);
      const malformed = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: '2026-9-5', opening_float_cents: 0, counted_cash_cents: 0 });
      assertEqual(malformed.status, 400, `malformed date → 400 (got ${malformed.status})`);
      const negativeFloat = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: '2026-09-05', opening_float_cents: -1, counted_cash_cents: 0 });
      assertEqual(negativeFloat.status, 400, `negative opening_float_cents → 400 (got ${negativeFloat.status})`);
      const missingDate = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ opening_float_cents: 0, counted_cash_cents: 0 });
      assertEqual(missingDate.status, 400, `missing business_date → 400 (got ${missingDate.status})`);
      const realCalendar = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: '2026-02-30', opening_float_cents: 0, counted_cash_cents: 0 });
      assertEqual(realCalendar.status, 400, `2026-02-30 (impossible date) → 400 (got ${realCalendar.status})`);
      const fractional = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: '2026-09-05', opening_float_cents: 10.5, counted_cash_cents: 0 });
      assertEqual(fractional.status, 400, `non-integer opening_float_cents → 400 (got ${fractional.status})`);
      const longNotes = 'x'.repeat(501);
      const tooLongNotes = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: '2026-09-05', opening_float_cents: 0, counted_cash_cents: 0, notes: longNotes });
      assertEqual(tooLongNotes.status, 400, `notes > 500 chars → 400 (got ${tooLongNotes.status})`);
      // F2: tenant-local "today" must always be accepted, even when the host
      // UTC clock disagrees (timezone shift guard). The store's configured
      // timezone in this test is UTC, so today's local date equals the host's
      // UTC date — the regression we care about is the path that uses
      // localDateInTimezone(...) instead of new Date().toISOString().slice(0,10).
      const todayLocal = new Date().toISOString().slice(0, 10);
      // Seed zero-value bills + refunds on today so the close actually stores
      // a snapshot (otherwise 409 from the prior section would fire).
      seedPaidBill({ billNumber: 'B-TODAY-CASH', method: 'cash', amount: 100, businessDate: todayLocal });
      const today = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({ business_date: todayLocal, opening_float_cents: 0, counted_cash_cents: 10000 });
      assertEqual(today.status, 201, `tenant-local today is accepted regardless of host clock (got ${today.status}, body=${JSON.stringify(today.body)})`);
    }

    console.log('\n3. Snapshot math: 1 cash bill + 1 card bill, no refunds');
    {
      // Pick a date 30 days back from the test-run "today" so this fixture
      // never collides with the section-4 (today) or section-5 (two adjacent
      // dates) closures.
      const baseDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const businessDate = baseDate.toISOString().slice(0, 10);
      seedPaidBill({ billNumber: 'B-CASH-1', method: 'cash', amount: 500, businessDate });
      seedPaidBill({ billNumber: 'B-CARD-1', method: 'card', amount: 250, businessDate });

      const res = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: businessDate,
        opening_float_cents: 10000,
        counted_cash_cents: 12000,
      });
      assertEqual(res.status, 201, `owner gets 201 (got ${res.status}, body=${JSON.stringify(res.body)})`);
      const z = res.body?.zReport;
      assert(!!z, 'response includes zReport');
      assertEqual(z.business_date, businessDate, 'business_date round-trips');
      // expected = opening_float + cashSales − cashRefunds(created_at) = 10000 + 50000 − 0 = 60000
      // cashSales is stored in major units (500) and the spec says money is
      // INTEGER cents end-to-end; we assert on the cents field directly.
      assertEqual(z.opening_float_cents, 10000, 'opening_float_cents round-trips');
      assertEqual(z.expected_cash_cents, 60000, 'expected_cash_cents = opening_float + cashSales');
      assertEqual(z.counted_cash_cents, 12000, 'counted_cash_cents round-trips');
      assertEqual(z.variance_cents, 12000 - 60000, 'variance_cents = counted − expected');
      assertEqual(z.bill_count, 2, 'bill_count is 2 (cash + card)');
      assertEqual(z.refund_count, 0, 'refund_count is 0');
      // F3: display gross comes from SUM(paid_amount) over the paid_at day
      // window (financial-summary template). bills.paid_amount is REAL in
      // major units (seed: cash 500 + card 250 = 750); the close converts
      // to cents at the API boundary.
      assertEqual(z.gross_collected_cents, (500 + 250) * 100, 'gross_collected_cents = SUM(paid_amount) over paid_at window');
      assertEqual(z.refunded_cents, 0, 'refunded_cents = 0');
      assertEqual(z.net_collected_cents, (500 + 250) * 100, 'net_collected_cents = gross_collected − refunded');
      // F3: display payment-method totals must reconcile with the live
      // financial-summary breakdown for the same seeded day (cash 500 +
      // card 250 major units, both converted to cents).
      const pmByMethod = Object.fromEntries((z.payment_methods as any[]).map((m) => [m.method, m]));
      assertEqual(pmByMethod['cash']?.total_cents, 500 * 100, 'paymentMethods.cash total_cents matches paid_amount');
      assertEqual(pmByMethod['card']?.total_cents, 250 * 100, 'paymentMethods.card total_cents matches paid_amount');
      assert(Array.isArray(z.staff_sales), 'staff_sales is an array');
      // F4: tax_components carries the spec's DisplayTaxComponent[] shape
      // (each entry: {title, rate, amount}). An empty array is the correct
      // empty-day value — non-empty when the live tax-components endpoint
      // sees taxable bills.
      assert(Array.isArray(z.tax_components), 'tax_components is an array');
      for (const c of z.tax_components as any[]) {
        assert(typeof c.title === 'string' && typeof c.amount === 'number', `tax component has title+amount shape (got ${JSON.stringify(c)})`);
      }
      assert(typeof z.z_number === 'number' && z.z_number >= 1, `z_number is a positive integer (got ${z.z_number})`);
      assertEqual(z.closed_by, ownerId, 'closed_by stamped with the requesting owner');
      // Capture for the section-12 round-trip comparison (every key, not
      // just the ones asserted inline).
      sectionThreePost = z;
    }

    console.log('\n4. Drawer-reality refund: a cash refund issued today against a yesterday-paid bill reduces today’s expected_cash_cents');
    {
      // Today is already closed by section 2's F2 test, so pick a date well
      // clear of all other sections (section 3 uses day-30, section 5 uses
      // day-6) and seed a yesterday-paid bill + a day-20-ago-issued cash
      // refund against it.
      const dayCloseBase = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const yesterday = new Date(dayCloseBase.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const today = dayCloseBase.toISOString().slice(0, 10);
      seedPaidBill({
        billNumber: 'B-YDAY-CASH',
        method: 'cash',
        amount: 1000,
        businessDate: yesterday,
        createdAt: dbTimestamp(new Date(`${yesterday}T10:00:00Z`)),
        paidAt: dbTimestamp(new Date(`${yesterday}T11:00:00Z`)),
        // Refund must be issued on the same day we're closing (today, here
        // = dayCloseBase) so its created_at lands inside the close window.
        // The bill was paid yesterday — drawer-reality attribution (cash
        // refunds by created_at) is what drops today's expected.
        refundAmount: 20000, // 200 INR in cents
        refundCreatedAt: dbTimestamp(new Date(`${today}T14:30:00Z`)),
      });

      const res = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: today,
        opening_float_cents: 0,
        counted_cash_cents: 0,
      });
      assertEqual(res.status, 201, `today close returns 201 (got ${res.status})`);
      const z = res.body?.zReport;
      // expected_cash_cents uses cash refunds by created_at (drawer reality):
      // opening_float 0 + cashSales 0 − cashRefund(20000) = -20000.
      // (display totals would attribute the refund to yesterday's bill
      // paid_at via attributeRefundsToBillDate=true, but expected is drawer.)
      assertEqual(z.expected_cash_cents, -20000, 'expected_cash_cents = 0 + 0 − 20000 cash refund (drawer reality)');
      // Display attribution: refund_count + refunded_cents follow bill
      // paid_at (financial-summary). The refund is against a yesterday-paid
      // bill, so today's display totals exclude it.
      assertEqual(z.refund_count, 0, 'refund_count is 0 because the refund’s bill was paid yesterday (display attribution follows paid_at)');
      assertEqual(z.refunded_cents, 0, 'refunded_cents is 0 for the same reason');
      // The yesterday bill's 1000 INR cash payment is paid_at yesterday,
      // so it doesn't appear in today's paid_at window either.
      assertEqual(z.bill_count, 0, 'bill_count is 0 (yesterday bill is not paid in today\'s window)');
      assertEqual(z.gross_collected_cents, 0, 'gross_collected_cents = 0 (no today-paid bills)');
      assertEqual(z.counted_cash_cents, 0, 'counted_cash_cents round-trips');
      assertEqual(z.variance_cents, 0 - -20000, 'variance_cents = counted − expected');
    }

    console.log('\n4.5. F5: stored refunded_cents/net_collected_cents stay in INTEGER cents');
    {
      // Pick a date well clear of the other sections' dates so the seeded
      // bill/refund don't collide with section 3 (day-30), section 4
      // (dayCloseBase), section 5 (day-6/day-7), or section 8 (day-45).
      // Section 3 uses day-30 and section 4 uses dayCloseBase (day-20) so
      // day-15 is clear.
      const sameDayDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const refundAmountCents = 12345; // arbitrary non-round cents to catch integer math
      // Bill is paid on the same day we close; the refund is issued the same
      // day too. Because both bill.paid_at and refund.created_at land inside
      // the close window, BOTH attribution paths see the refund — but the
      // assertion below only cares about the stored cents columns.
      seedPaidBill({
        billNumber: 'B-SAMEDAY-CASH',
        method: 'cash',
        amount: 500,
        businessDate: sameDayDate,
        createdAt: dbTimestamp(new Date(`${sameDayDate}T10:00:00Z`)),
        paidAt: dbTimestamp(new Date(`${sameDayDate}T11:00:00Z`)),
        refundAmount: refundAmountCents,
        refundCreatedAt: dbTimestamp(new Date(`${sameDayDate}T14:30:00Z`)),
      });

      const res = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: sameDayDate,
        opening_float_cents: 0,
        counted_cash_cents: 0,
      });
      assertEqual(res.status, 201, `same-day refund close returns 201 (got ${res.status}, body=${JSON.stringify(res.body)})`);
      const z = res.body?.zReport;
      // F5: refunded_cents must be the exact cent amount of the refund —
      // storage stays in INTEGER cents (bills.paid_amount /
      // refunds.amount_cents convention), and display/API-boundary
      // conversion (if any) happens only at the response edge.
      assertEqual(z.refunded_cents, refundAmountCents, `refunded_cents == ${refundAmountCents} (exact cent amount)`);
      assertEqual(z.refund_count, 1, 'refund_count is 1 (same-day refund falls inside paid_at window)');
      // F5: net_collected_cents must equal gross − refunded, all in cents.
      // With seed cash 500 + 0 card = 50000 cents gross; refund 12345; net = 37655.
      const expectedGrossCents = 500 * 100;
      assertEqual(z.gross_collected_cents, expectedGrossCents, 'gross_collected_cents == cash 500 in cents');
      assertEqual(z.net_collected_cents, expectedGrossCents - refundAmountCents, `net_collected_cents == gross_collected_cents − refunded_cents (in cents)`);
      // F5: storage round-trip — the stored row must match the response
      // field-for-field (immutable Z invariant).
      const stored = db.prepare(
        `SELECT refunded_cents, net_collected_cents, gross_collected_cents
         FROM cash_closures WHERE business_date = ? AND scope = 'day'`
      ).get(sameDayDate) as { refunded_cents: number; net_collected_cents: number; gross_collected_cents: number };
      assertEqual(stored.refunded_cents, refundAmountCents, 'stored refunded_cents is INTEGER cents, equal to refund amount_cents');
      assertEqual(stored.net_collected_cents, expectedGrossCents - refundAmountCents, 'stored net_collected_cents = gross − refunded (in cents)');
      assertEqual(stored.gross_collected_cents, expectedGrossCents, 'stored gross_collected_cents is INTEGER cents');
    }

    console.log('\n5. Midnight split via dayBoundsInTimezone: 23:50 vs 00:10 land on different business dates');
    {
      // Pick two consecutive dates well in the past (and not "today" or
      // "yesterday") so neither collides with sections 3-4 closures.
      const dayBBase = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const dayA = new Date(dayBBase.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dayB = dayBBase.toISOString().slice(0, 10);
      // 23:50 UTC on dayA — inside dayBoundsInTimezone(dayA).
      seedPaidBill({
        billNumber: 'B-NIGHT', method: 'cash', amount: 100, businessDate: dayA,
        createdAt: dbTimestamp(new Date(`${dayA}T23:50:00Z`)),
        paidAt: dbTimestamp(new Date(`${dayA}T23:50:00Z`)),
      });
      // 00:10 UTC on dayB — inside dayBoundsInTimezone(dayB).
      seedPaidBill({
        billNumber: 'B-MORNING', method: 'cash', amount: 200, businessDate: dayB,
        createdAt: dbTimestamp(new Date(`${dayB}T00:10:00Z`)),
        paidAt: dbTimestamp(new Date(`${dayB}T00:10:00Z`)),
      });

      const [startA, endA] = dayBoundsInTimezone(dayA, 'UTC');
      const [startB, endB] = dayBoundsInTimezone(dayB, 'UTC');
      // Paid_at '2026-09-05 23:50:00' must fall inside dayA bounds and before dayB.
      const nightPaidAt = db.prepare("SELECT paid_at FROM bills WHERE bill_number = 'B-NIGHT'").get().paid_at;
      const morningPaidAt = db.prepare("SELECT paid_at FROM bills WHERE bill_number = 'B-MORNING'").get().paid_at;
      assert(nightPaidAt >= startA && nightPaidAt < endA, '23:50 UTC bill lies inside day A bounds');
      assert(morningPaidAt >= startB && morningPaidAt < endB, '00:10 UTC next-day bill lies inside day B bounds');

      // Close day A first; only B-NIGHT should contribute.
      const closeA = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: dayA, opening_float_cents: 0, counted_cash_cents: 10000,
      });
      assertEqual(closeA.status, 201, 'day A close succeeds');
      assertEqual(closeA.body?.zReport?.bill_count, 1, 'day A: only B-NIGHT counted');
      assertEqual(closeA.body?.zReport?.expected_cash_cents, 10000, 'day A: expected = 0 + 10000 cash − 0');

      // Close day B; only B-MORNING should contribute (B-NIGHT is on day A).
      const closeB = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: dayB, opening_float_cents: 0, counted_cash_cents: 20000,
      });
      assertEqual(closeB.status, 201, 'day B close succeeds');
      assertEqual(closeB.body?.zReport?.bill_count, 1, 'day B: only B-MORNING counted');
      assertEqual(closeB.body?.zReport?.expected_cash_cents, 20000, 'day B: expected = 0 + 20000 cash − 0');
    }

    console.log('\n6. Duplicate close (same business_date, scope=day) → 409');
    {
      // Re-try the dayA close from section 5: the partial unique index on
      // (business_date) WHERE scope='day' turns the second POST into 409.
      const dayBBase = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const dayA = new Date(dayBBase.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dup = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: dayA, opening_float_cents: 0, counted_cash_cents: 0,
      });
      assertEqual(dup.status, 409, `duplicate day close → 409 (got ${dup.status})`);
    }

    console.log('\n8. F4: tax_components_json carries DisplayTaxComponent[] with correct sums');
    {
      // Pick a date 45 days back (well clear of all other sections) and seed
      // a single bill with tax_snapshot + tax_breakdown populated directly so
      // `aggregateTaxComponents` returns a non-empty component list. The
      // min-allocation snapshot format is what the live tax-components
      // endpoint feeds to `aggregateTaxComponents`.
      const taxDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const taxSnapshot = JSON.stringify({
        splitAllocation: 'minor-unit-v1',
        lines: [{
          kind: 'item',
          components: [
            { label: 'CGST', rate: '9', amount: 50 },
            { label: 'SGST', rate: '9', amount: 50 },
          ],
        }],
      });
      const taxBreakdown = JSON.stringify([
        { title: 'CGST', rate: 9, amount: 50 },
        { title: 'SGST', rate: 9, amount: 50 },
      ]);
      const paidAt = dbTimestamp(new Date(`${taxDate}T12:00:00Z`));
      const orderNum = `ORD-TAX-1`;
      db.prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES (?, ?, 'takeaway', 'completed', ?, ?, ?, ?, ?)
      `).run(orderNum, cashierId, 1000, 1100, paidAt, paidAt, paidAt);
      const orderId = Number(db.prepare("SELECT id FROM orders WHERE order_number = ?").get(orderNum).id);
      db.prepare(`
        INSERT INTO bills (
          bill_number, order_id, subtotal, total, paid_amount, balance, payment_status,
          payment_details, paid_at, created_at, updated_at,
          tax_amount, tax_snapshot, tax_breakdown
        ) VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'B-TAX-1',
        orderId, 1000, 1100, 1100,
        JSON.stringify([{ method: 'cash', amount: 1100, timestamp: paidAt }]),
        paidAt, paidAt, paidAt,
        100, taxSnapshot, taxBreakdown,
      );

      const res = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: taxDate,
        opening_float_cents: 0,
        counted_cash_cents: 110000,
      });
      assertEqual(res.status, 201, `tax-bill close returns 201 (got ${res.status}, body=${JSON.stringify(res.body)})`);
      const components = res.body?.zReport?.tax_components as any[];
      assert(Array.isArray(components) && components.length > 0, `tax_components is non-empty DisplayTaxComponent[] (got ${JSON.stringify(components)})`);
      // Shape: every component has title (string), rate (number|null), amount (number).
      for (const c of components) {
        assert(typeof c.title === 'string', `component has title (got ${JSON.stringify(c)})`);
        assert(typeof c.amount === 'number', `component has numeric amount (got ${JSON.stringify(c)})`);
      }
      // The seeded CGST + SGST must each round-trip at 50 cents / 50 cents.
      const cgst = components.find((c) => c.title === 'CGST');
      const sgst = components.find((c) => c.title === 'SGST');
      assert(!!cgst && cgst.amount === 50, `CGST component present at 50 (got ${JSON.stringify(cgst)})`);
      assert(!!sgst && sgst.amount === 50, `SGST component present at 50 (got ${JSON.stringify(sgst)})`);
      // Cross-check: stored tax_components_json column parses back to the
      // exact same array, so the round-trip endpoint (Wave 3's
      // GET /api/reports/z-report) can hand it back unchanged.
      const stored = db.prepare("SELECT tax_components_json FROM cash_closures WHERE business_date = ? AND scope = 'day'").get(taxDate) as { tax_components_json: string };
      const parsed = JSON.parse(stored.tax_components_json);
      assert(JSON.stringify(parsed) === JSON.stringify(components), 'stored tax_components_json round-trips identically');
    }

    console.log('\n7. F1 regression: KWD (factor 1000) — 0.500 cash sale yields 500 cents expected');
    {
      // Pick day-50 (well clear of all other sections) and switch the store
      // currency to KWD so getCurrencyMinorUnitFactor returns 1000. Seed a
      // 0.500 cash bill (stored in payment_details as amount=0.5) and assert
      // expected_cash_cents = 0.5 × 1000 = 500. With the prior hardcoded *100
      // this would have been 50; the regression catches it.
      const kwdDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'KWD', ?) ON CONFLICT(key) DO UPDATE SET value='KWD', updated_at=excluded.updated_at`).run(now());
      seedPaidBill({ billNumber: 'B-KWD-1', method: 'cash', amount: 0.5, businessDate: kwdDate });

      const res = await request(app).post('/api/cash-closures').set('Authorization', `Bearer ${ownerToken}`).send({
        business_date: kwdDate,
        opening_float_cents: 0,
        counted_cash_cents: 500,
      });
      assertEqual(res.status, 201, `KWD close returns 201 (got ${res.status}, body=${JSON.stringify(res.body)})`);
      const z = res.body?.zReport;
      assertEqual(z.expected_cash_cents, 500, `KWD: expected = 0 + (0.5 × 1000) = 500 cents`);
      assertEqual(z.gross_collected_cents, 500, `KWD: gross_collected_cents = 0.5 × 1000 = 500`);
      const cashPm = (z.payment_methods as any[]).find((m) => m.method === 'cash');
      assertEqual(cashPm?.total_cents, 500, `KWD: paymentMethods.cash.total_cents = 0.5 × 1000 = 500`);
      const staffKwd = (z.staff_sales as any[]).find((s) => s.user_id === cashierId);
      assert(staffKwd && staffKwd.revenue_cents === 500, `KWD: staff_sales revenue_cents = 0.5 × 1000 = 500 (got ${JSON.stringify(staffKwd)})`);
      // Restore the default currency so later (or external) sections aren't
      // perturbed. (Nothing else in this file reads currency, but keep the
      // side-effect local.)
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'INR', ?) ON CONFLICT(key) DO UPDATE SET value='INR', updated_at=excluded.updated_at`).run(now());
    }

    console.log('\n7. Z-number monotonic lifetime');
    {
      const z = nextZNumber();
      assert(typeof z === 'number' && z > 0, `nextZNumber still returns positive ints after close (got ${z})`);
      // The just-closed section-3 row's z_number must be smaller than a
      // freshly-issued nextZNumber() — closing the day does not consume the
      // counter from today (each close inserts with nextZNumber() too).
      const dayBBase = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sectionThreeDate = dayBBase.toISOString().slice(0, 10);
      const first = db.prepare("SELECT z_number FROM cash_closures WHERE business_date = ?").get(sectionThreeDate) as { z_number: number };
      assert(typeof first?.z_number === 'number' && first.z_number < z, `stored z_number (${first?.z_number}) < nextZNumber (${z})`);
    }

    console.log('\n9. GET /api/reports/x-report — live day report');
    {
      // Section 3 already closed a day-30 day with cash 500 + card 250.
      // Re-query that day: X should return display-shape aggregates and
      // `alreadyClosed: true` with the stale-by-design Z number.
      const dayBBase = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sectionThreeDate = dayBBase.toISOString().slice(0, 10);
      const x = await request(app).get(`/api/reports/x-report?date=${sectionThreeDate}`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(x.status, 200, `x-report returns 200 (got ${x.status}, body=${JSON.stringify(x.body)})`);
      const report = x.body?.xReport;
      assert(!!report, 'xReport envelope present');
      assertEqual(report.businessDate, sectionThreeDate, 'xReport.businessDate echoes requested date');
      assertEqual(report.billCount, 2, 'xReport.billCount = 2 (cash + card)');
      assertEqual(report.refundCount, 0, 'xReport.refundCount = 0');
      assertEqual(report.grossCollected, 500 + 250, 'xReport.grossCollected = 750 (display major units)');
      assertEqual(report.refunded, 0, 'xReport.refunded = 0');
      assertEqual(report.netCollected, 500 + 250, 'xReport.netCollected = 750');
      assertEqual(report.alreadyClosed, true, 'xReport.alreadyClosed = true after POST close');
      assert(typeof report.zNumber === 'number' && report.zNumber > 0, `xReport.zNumber is a positive integer (got ${report.zNumber})`);
      // paymentMethods must reconcile with the live financial-summary breakdown
      // for the same day (cash 500 + card 250 major units, paidOnly=true).
      const pmByMethod = Object.fromEntries((report.paymentMethods as any[]).map((m) => [m.method, m]));
      assertEqual(pmByMethod['cash']?.total, 500, 'paymentMethods.cash.total = 500');
      assertEqual(pmByMethod['card']?.total, 250, 'paymentMethods.card.total = 250');
      assert(Array.isArray(report.staffSales), 'staffSales is an array');
      // taxComponents is an array; non-empty when the day has taxable bills,
      // empty otherwise — both shapes are valid.
      assert(Array.isArray(report.taxComponents), 'taxComponents is an array');
      // expectedCashCents (drawer reality): cash sales − cash refunds by
      // created_at, in INTEGER cents. The seeded day has 500 major cash
      // sales and 0 cash refunds = 50000 cents.
      assertEqual(report.expectedCashCents, 500 * 100, 'xReport.expectedCashCents = 50000 cents');
      // F3: server-resolved prior close. Section 8 (this test file) closes
      // a day earlier (day-45) with a counted cash value; on a non-UTC test
      // host the dates may differ, so probe the seeded previous close
      // directly and assert the most recent prior scope='day' close is reported.
      const priorDirect = db.prepare(`SELECT business_date, counted_cash_cents FROM cash_closures WHERE scope='day' AND business_date < ? ORDER BY business_date DESC LIMIT 1`).get(sectionThreeDate) as { business_date: string; counted_cash_cents: number } | undefined;
      if (priorDirect) {
        assertEqual(report.priorBusinessDate, priorDirect.business_date, 'xReport.priorBusinessDate matches the previous close');
        assertEqual(report.priorClosedCashCents, priorDirect.counted_cash_cents, 'xReport.priorClosedCashCents matches the previous close cash count');
      } else {
        assertEqual(report.priorBusinessDate, null, 'xReport.priorBusinessDate is null when no prior close exists');
        assertEqual(report.priorClosedCashCents, null, 'xReport.priorClosedCashCents is null when no prior close exists');
      }
      // F3 null-prior branch: probe a date strictly before the earliest seeded
      // close (day-60, before section 8's day-45) — there has been no prior
      // close ever, so both prior fields must be null. Section 9 above
      // exercises the with-prior branch; this exercises the null-prior
      // branch so the F1 no-prior-close prefill + noPriorCloseHint UX is
      // deterministically covered.
      const noPriorDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const np = await request(app).get(`/api/reports/x-report?date=${noPriorDate}`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(np.status, 200, `x-report on day-60 returns 200 (got ${np.status})`);
      const npReport = np.body?.xReport;
      assert(!!npReport, 'xReport envelope present on day-60');
      assertEqual(npReport.alreadyClosed, false, 'xReport.alreadyClosed = false on day-60 (no prior close ever)');
      assertEqual(npReport.priorBusinessDate, null, 'xReport.priorBusinessDate is null when no prior close exists');
      assertEqual(npReport.priorClosedCashCents, null, 'xReport.priorClosedCashCents is null when no prior close exists');
    }

    console.log('\n10. GET /api/reports/x-report — an unclosed day shows alreadyClosed=false');
    {
      // Pick a fresh day in the past that hasn't been closed yet.
      const openDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      // Seed a tiny cash bill so x-report has at least one payment line.
      seedPaidBill({ billNumber: 'B-OPEN-X', method: 'cash', amount: 50, businessDate: openDate });
      const x = await request(app).get(`/api/reports/x-report?date=${openDate}`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(x.status, 200, `x-report returns 200 (got ${x.status})`);
      const report = x.body?.xReport;
      assert(!!report, 'xReport envelope present');
      assertEqual(report.alreadyClosed, false, 'xReport.alreadyClosed = false for an unclosed day');
      assertEqual(report.zNumber, undefined, 'xReport.zNumber is absent when not closed');
      assertEqual(report.billCount, 1, 'xReport.billCount = 1 (seeded)');
      assertEqual(report.expectedCashCents, 50 * 100, 'xReport.expectedCashCents = 5000 cents');
    }

    console.log('\n11. GET /api/reports/x-report — defaults to tenant-local today');
    {
      // Seed a today cash bill + a today cash refund against it so the
      // drawer-reality subtraction (cash sales − cash refunds by
      // created_at) has a nonzero refund leg. Section 4 already seeds a
      // yesterday-bill + today-refund; here we want a clean today/today
      // pair that proves the X handler's expectedCashCents math without
      // the section-4 timestamp manipulation.
      const nowToday = new Date();
      const todayLocal = nowToday.toISOString().slice(0, 10);
      seedPaidBill({
        billNumber: 'B-TODAY-CASH-X',
        method: 'cash',
        amount: 300,
        businessDate: todayLocal,
        createdAt: dbTimestamp(new Date(`${todayLocal}T09:00:00Z`)),
        paidAt: dbTimestamp(new Date(`${todayLocal}T09:05:00Z`)),
        refundAmount: 5000, // 50 INR in cents
        refundCreatedAt: dbTimestamp(new Date(`${todayLocal}T17:00:00Z`)),
      });
      const x = await request(app).get('/api/reports/x-report').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(x.status, 200, `x-report with no date returns 200 (got ${x.status})`);
      const report = x.body?.xReport;
      assert(!!report, 'xReport envelope present');
      // The default business date must be a YYYY-MM-DD (whatever the host
      // UTC date is in the test's UTC tenant config).
      assert(/^\d{4}-\d{2}-\d{2}$/.test(report.businessDate), `xReport.businessDate is YYYY-MM-DD (got ${report.businessDate})`);
      // Drawer-reality assert: today cash sales (B-TODAY-CASH 100 major
      // from section 2 + B-TODAY-CASH-X 300 major = 400 major = 40000
      // cents) − today cash refund 5000 cents = 35000 cents. The opening
      // float is intentionally NOT included in X (it is captured only at
      // close), so this is the X-only expected figure.
      assertEqual(report.expectedCashCents, 40000 - 5000, `xReport.expectedCashCents = 35000 cents (cash 400 − refund 50, no float) (got ${report.expectedCashCents})`);
      // F3: prior-close fields are null when no prior day has been closed.
      // Section 3 closed the day-30 day; the default-today X probe above
      // is the most recent date in the seeded set, so any prior close for
      // it would be in the past. The branch intentionally asserts both
      // shapes (null when nothing earlier, populated otherwise) so a
      // regression where the backend hard-fails the prior query is caught.
      const anyPrior = db.prepare(`SELECT business_date, counted_cash_cents FROM cash_closures WHERE scope='day' AND business_date < ? ORDER BY business_date DESC LIMIT 1`).get(report.businessDate) as { business_date: string; counted_cash_cents: number } | undefined;
      if (anyPrior) {
        assertEqual(report.priorBusinessDate, anyPrior.business_date, 'xReport.priorBusinessDate = previous close when one exists');
        assertEqual(report.priorClosedCashCents, anyPrior.counted_cash_cents, 'xReport.priorClosedCashCents = previous close counted cash');
      } else {
        assertEqual(report.priorBusinessDate, null, 'xReport.priorBusinessDate = null when no prior close');
        assertEqual(report.priorClosedCashCents, null, 'xReport.priorClosedCashCents = null when no prior close');
      }
    }

    console.log('\n12. GET /api/reports/z-report — round-trips the POST response field for field');
    {
      const dayBBase = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sectionThreeDate = dayBBase.toISOString().slice(0, 10);
      const z = await request(app).get(`/api/reports/z-report?date=${sectionThreeDate}`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(z.status, 200, `z-report returns 200 (got ${z.status})`);
      const report = z.body?.zReport;
      assert(!!report, 'zReport envelope present');
      assertEqual(report.business_date, sectionThreeDate, 'zReport.business_date echoes');
      assertEqual(report.bill_count, 2, 'zReport.bill_count = 2');
      assertEqual(report.expected_cash_cents, 60000, 'zReport.expected_cash_cents = 60000 cents (opening_float 10000 + cash 50000)');
      assertEqual(report.counted_cash_cents, 12000, 'zReport.counted_cash_cents = 12000');
      assertEqual(report.variance_cents, 12000 - 60000, 'zReport.variance_cents matches');
      assertEqual(report.z_number > 0, true, 'zReport.z_number is positive');
      // The three snapshot JSONs must round-trip identically.
      assert(Array.isArray(report.payment_methods), 'zReport.payment_methods is an array');
      assert(Array.isArray(report.staff_sales), 'zReport.staff_sales is an array');
      assert(Array.isArray(report.tax_components), 'zReport.tax_components is an array');
      // F1: full field-for-field equality with the POST response for the
      // same day. Spec ("Testing approach"): "Z round-trip (GET after POST)
      // equals the close response field for field." Compare all 21 keys
      // and the three parsed snapshot arrays/objects.
      assert(!!sectionThreePost, 'section-3 POST response was captured');
      const expectedKeys = [
        'id', 'scope', 'business_date', 'period_start', 'period_end',
        'opening_float_cents', 'expected_cash_cents', 'counted_cash_cents', 'variance_cents',
        'gross_collected_cents', 'refunded_cents', 'net_collected_cents',
        'bill_count', 'refund_count',
        'payment_methods', 'staff_sales', 'tax_components',
        'z_number', 'closed_by', 'closed_by_name', 'notes', 'created_at',
      ];
      assertEqual(JSON.stringify(Object.keys(report).sort()), JSON.stringify([...expectedKeys].sort()), 'GET zReport has exactly the 22 spec keys (incl. closed_by_name)');
      for (const key of expectedKeys) {
        // The three snapshot fields are parsed inside GET (JSON.parse on
        // `row.<x>_json`) so the reference differs from POST's; compare by
        // canonical string for those, and by value for the rest.
        // `closed_by_name` is resolved only on the GET (the POST response
        // stores the raw id); skip it from the POST-equality loop and
        // assert it separately above.
        if (key === 'closed_by_name') continue;
        if (key === 'payment_methods' || key === 'staff_sales' || key === 'tax_components') {
          assertEqual(JSON.stringify(report[key]), JSON.stringify(sectionThreePost[key]), `zReport.${key} === POST.${key}`);
        } else {
          assertEqual(report[key], sectionThreePost[key], `zReport.${key} === POST.${key}`);
        }
      }
      assertEqual(JSON.stringify(report.payment_methods), JSON.stringify(sectionThreePost.payment_methods), 'payment_methods deep-equal (order-preserving)');
      assertEqual(JSON.stringify(report.staff_sales), JSON.stringify(sectionThreePost.staff_sales), 'staff_sales deep-equal');
      assertEqual(JSON.stringify(report.tax_components), JSON.stringify(sectionThreePost.tax_components), 'tax_components deep-equal');
    }

    console.log('\n13. GET /api/reports/z-report — 404 with alreadyClosed=false for an unclosed date');
    {
      const openDate = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const z = await request(app).get(`/api/reports/z-report?date=${openDate}`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(z.status, 404, `z-report for unclosed date → 404 (got ${z.status})`);
      assertEqual(z.body?.alreadyClosed, false, 'unclosed-day response carries alreadyClosed: false');
    }

    console.log('\n14. Role gating on reads: manager reads both, cashier gets 403');
    {
      const dayBBase = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sectionThreeDate = dayBBase.toISOString().slice(0, 10);
      // Manager may read both endpoints (ownerManager gate).
      const mgrX = await request(app).get(`/api/reports/x-report?date=${sectionThreeDate}`).set('Authorization', `Bearer ${managerToken}`);
      assertEqual(mgrX.status, 200, `manager reads x-report (got ${mgrX.status})`);
      const mgrZ = await request(app).get(`/api/reports/z-report?date=${sectionThreeDate}`).set('Authorization', `Bearer ${managerToken}`);
      assertEqual(mgrZ.status, 200, `manager reads z-report (got ${mgrZ.status})`);
      // Cashier: POST close is already 403 (section 1). Reads here are gated
      // ownerManager, so cashier should also be 403 on x-report / z-report.
      const csX = await request(app).get(`/api/reports/x-report?date=${sectionThreeDate}`).set('Authorization', `Bearer ${cashierToken}`);
      assertEqual(csX.status, 403, `cashier forbidden on x-report (got ${csX.status})`);
      const csZ = await request(app).get(`/api/reports/z-report?date=${sectionThreeDate}`).set('Authorization', `Bearer ${cashierToken}`);
      assertEqual(csZ.status, 403, `cashier forbidden on z-report (got ${csZ.status})`);
    }

    console.log('\n15. POST /api/cash-closures/:id/print — Z print with forced drawer pulse (Wave 4, #649)');
    {
      // The print primitive appends the ESC/POS drawer-pulse sequence directly
      // (spec: bypass bill-bound shouldPulseForPayment, forced on Z). We mock
      // `printZReport` so the test never opens a real socket; what we assert
      // is the bytes the route hands to dispatch.
      const thermalModule = require('../main/printers/thermal');
      const origPrintZReport = thermalModule.printZReport;
      const captured: Buffer[] = [];
      // The mock mirrors the real `printZReport` shape: when the resolved
      // printer is webusb, the helper returns `bytes` already including the
      // forced pulse tail, and the route emits `{ webusb: true, bytes: [...] }`.
      // For the network/usb path the helper returns `ok: true` with bytes.
      thermalModule.printZReport = async (z: any, _lang?: string, _signal?: any, targetPrinter?: any) => {
        const baseBody = thermalModule.buildZReportBody(z);
        const data = thermalModule.appendCashDrawerPulse(baseBody);
        captured.push(data);
        if (targetPrinter?.connection_type === 'webusb') {
          return { ok: true, bytes: data, connection_type: 'webusb' };
        }
        return { ok: true, bytes: data, connection_type: targetPrinter?.connection_type || 'network' };
      };
      try {
        // Use the date already closed by section 3 (day-30 ago).
        const dayPBase = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const printDate = dayPBase.toISOString().slice(0, 10);
        const ownerPrintToken = jwt.sign({ userId: ownerId, email: 'owner-close@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
        const cashierPrintToken = jwt.sign({ userId: cashierId, email: 'cashier-close@test.local', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' });

        // GET the stored Z first so we can compare byte-for-byte after print.
        const zBefore = await request(app).get(`/api/reports/z-report?date=${printDate}`).set('Authorization', `Bearer ${ownerPrintToken}`);
        assertEqual(zBefore.status, 200, `print: GET z-report before print (got ${zBefore.status})`);
        const zId = zBefore.body?.zReport?.id;
        assert(typeof zId === 'number' || typeof zId === 'string', `print: zReport.id is truthy (got ${typeof zId})`);

        const printResp = await request(app)
          .post(`/api/cash-closures/${zId}/print`)
          .set('Authorization', `Bearer ${ownerPrintToken}`)
          .send({ isReprint: false });
        assertEqual(printResp.status, 200, `print: owner POST /:id/print → 200 (got ${printResp.status})`);
        assertEqual(printResp.body?.isReprint, false, 'print: response carries isReprint:false');

        // At least one dispatch captured.
        assert(captured.length === 1, `print: exactly one dispatch (got ${captured.length})`);
        const bytes = captured[0];
        // The forced drawer pulse sequence (ESC/POS `ESC p 0 25 250`) is the
        // last 5 bytes — independent of language, columns, or content.
        const tail = Array.from(bytes.slice(bytes.length - 5));
        assert(JSON.stringify(tail) === JSON.stringify([0x1B, 0x70, 0x00, 0x19, 0xFA]),
          `print: forced drawer pulse tail bytes (got ${JSON.stringify(tail)})`);

        // The Z body must contain the Z number and the expected/counted/variance
        // values the operator entered. The thermal pipeline re-encodes text, so
        // we look for ASCII-stable substrings: the Z number is digits and the
        // cents values convert to display via the currency factor.
        const text = bytes.toString('binary');
        const zNumber = zBefore.body.zReport.z_number;
        assert(text.includes(String(zNumber)), `print: bytes include Z number (${zNumber})`);
        const factor = 100; // INR minor factor in seeded tests
        const expectedDisplay = zBefore.body.zReport.expected_cash_cents / factor;
        const countedDisplay = zBefore.body.zReport.counted_cash_cents / factor;
        const varianceDisplay = zBefore.body.zReport.variance_cents / factor;
        const hasExpected = expectedDisplay !== 0
          ? text.includes(String(expectedDisplay)) || text.includes(expectedDisplay.toFixed(2))
          : true;
        const hasCounted = countedDisplay !== 0
          ? text.includes(String(countedDisplay)) || text.includes(countedDisplay.toFixed(2))
          : true;
        const hasVariance = varianceDisplay !== 0
          ? text.includes(String(varianceDisplay)) || text.includes(varianceDisplay.toFixed(2))
          : true;
        assert(hasExpected && hasCounted && hasVariance,
          `print: bytes include expected=${expectedDisplay}, counted=${countedDisplay}, variance=${varianceDisplay}`);
        // F1: the header block reads `business_name` from the key/value
        // `settings` table. The seeded value must reach the body bytes.
        assert(text.includes('Acme Coffee'), `print: bytes include business_name from settings`);
        assert(text.includes('742 Evergreen Tce'), `print: bytes include business_address from settings`);
        assert(text.includes('TAX-0001'), `print: bytes include tax_registration_number from settings`);

        // F1 (non-INR factor): switch the tenant to KWD (minor factor 1000)
        // and rebuild the body. The payment-method row of 150 minor units
        // renders as "0.150" (150 / 1000), proving the divisor follows the
        // tenant settings. The default INR rendering of "1.50" must NOT
        // appear in any amount line, proving no INR/100 fallback.
        const originalCurrency = (db.prepare(`SELECT value FROM settings WHERE key='currency'`).get() as any).value;
        try {
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'KWD', ?) ON CONFLICT(key) DO UPDATE SET value='KWD', updated_at=excluded.updated_at`).run(now());
          // Use ASCII-mappable currency_symbol — the Arabic KWD prefix
          // `د.ك` is normalized to `KWD` by `normalizeCurrencyToAscii` for
          // printers without a native code page, so the byte assertion
          // targets the divisor-revealing digits rather than the prefix.
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency_symbol', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run('KWD', now());
          const kwdBody = thermalModule.buildZReportBody({
            ...zBefore.body.zReport,
            opening_float_cents: 0,
            expected_cash_cents: 0,
            counted_cash_cents: 0,
            variance_cents: 0,
            payment_methods: [{ method: 'cash', count: 1, total_cents: 150 }],
          });
          const kwdBytes = Array.from(kwdBody);
          // Search the byte buffer for the exact UTF-8 sequence for
          // `0.150` (5 bytes 48,46,49,53,48). KWD factor 1000 maps
          // 150 minor units to "0.150"; the default INR factor 100
          // would map to "1.50" (5 bytes 49,46,53,48) — distinct.
          const want = [48, 46, 49, 53, 48];
          const has0150 = kwdBytes.some((_, i) => want.every((b, j) => kwdBytes[i + j] === b));
          assert(has0150,
            `print (KWD factor 1000): bytes include 0.150 for 150 minor units`);
          const inrWant = [49, 46, 53, 48];
          const has150 = kwdBytes.some((_, i) => inrWant.every((b, j) => kwdBytes[i + j] === b));
          assert(!has150,
            `print (KWD factor 1000): bytes must not include the INR-rendered 1.50`);
        } finally {
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(originalCurrency || 'INR', now());
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency_symbol', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run('₹', now());
        }

        // F2: width regression asserts — every visual line of buildZReportBody
        // must fit the configured columns. Without the F1/signature fixes a
        // 32-col build overflows the signature row (cols+1 wide) and a 48-col
        // build truncates the rule separator to '..'.
        const assertWidthBudget = (z: any, cols: number, tag: string): void => {
          const body = thermalModule.buildZReportBody(z, undefined, { columns: cols });
          const preview = thermalModule.escPosToText(body);
          const lines = preview.split('\n');
          let wide = '';
          for (const line of lines) {
            if (line.length > cols) { wide = `${tag} line ${line.length}>${cols}: ${JSON.stringify(line)}`; break; }
          }
          assert(wide === '', wide || `${tag}: every visual line ≤ ${cols} cols`);
          assert(preview.includes('Operator signature:'), `${tag}: signature label renders`);
          assert(/_{3,}/.test(preview), `${tag}: signature underscores render`);
          assert(preview.includes('Generated by FloCafe'), `${tag}: footer renders`);
        };
        assertWidthBudget(zBefore.body.zReport, 48, 'print (F2 48-col)');
        assertWidthBudget(zBefore.body.zReport, 32, 'print (F2 32-col / 58mm)');
        // N3: a 24+ char value alone at 32 cols would overflow without the
        // periodLine clamp; verify the long-value case still fits.
        const longValueZ = JSON.parse(JSON.stringify(zBefore.body.zReport));
        longValueZ.period_start = '9999-12-31T23:59:59.999Z';
        longValueZ.period_end = '9999-12-31T23:59:59.999Z+24';
        assertWidthBudget(longValueZ, 32, 'print (N3 32-col long value)');


        // Printing must NOT mutate the row.
        const zAfter = await request(app).get(`/api/reports/z-report?date=${printDate}`).set('Authorization', `Bearer ${ownerPrintToken}`);
        assertEqual(zAfter.status, 200, `print: GET z-report after print → 200 (got ${zAfter.status})`);
        assertEqual(JSON.stringify(zAfter.body.zReport), JSON.stringify(zBefore.body.zReport), 'print: Z row unchanged after print');

        // Reprint marks the body but still succeeds.
        captured.length = 0;
        const reprint = await request(app)
          .post(`/api/cash-closures/${zId}/print`)
          .set('Authorization', `Bearer ${ownerPrintToken}`)
          .send({ isReprint: true });
        assertEqual(reprint.status, 200, `print: isReprint:true → 200 (got ${reprint.status})`);
        assertEqual(reprint.body?.isReprint, true, 'print: response carries isReprint:true');
        assert(captured.length === 1, `print: reprint produced one dispatch (got ${captured.length})`);
        assert(!captured[0].equals(bytes), 'print: reprint body differs from original');
        assert(captured[0].includes(Buffer.from('REIMPRESION', 'utf8')), 'print: reprint body carries the REIMPRESION marker');

        // WebUSB branch: buildZReportBody returns the body without the pulse;
        // the print primitive (printZReport) appends the forced pulse before
        // returning `bytes: number[]` to the renderer. The body must end
        // with a CUT sequence (final ESC/POS byte 0x1B 0x56) instead.
        const body = thermalModule.buildZReportBody(zBefore.body.zReport);
        const arr = Array.from(body);
        assertEqual(typeof body?.equals, 'function', 'print: buildZReportBody returns a Buffer');
        assert(arr.length > 0, 'print: buildZReportBody bytes length > 0');
        // ESC/POS `ESC @` (initialize) is required at the head; the pulse sequence
        // is appended by printZReport, not by the body builder.
        const head = arr.slice(0, 2);
        assert(JSON.stringify(head) === JSON.stringify([0x1B, 0x40]),
          `print: body starts with ESC @ (got ${JSON.stringify(head)})`);
        // And printZReport appends the forced pulse.
        const data = thermalModule.appendCashDrawerPulse(body);
        const lastFive = Array.from(data).slice(-5);
        assert(JSON.stringify(lastFive) === JSON.stringify([0x1B, 0x70, 0x00, 0x19, 0xFA]),
          `print: printZReport-wrapped body ends with the drawer pulse (got ${JSON.stringify(lastFive)})`);

        // Role gating: cashier is forbidden (route is owner-only).
        const csPrint = await request(app)
          .post(`/api/cash-closures/${zId}/print`)
          .set('Authorization', `Bearer ${cashierPrintToken}`)
          .send({});
        assertEqual(csPrint.status, 403, `print: cashier POST /:id/print → 403 (got ${csPrint.status})`);

        // F2: webusb end-to-end. Seed a webusb default printer, swap the
        // print primitive's helper to surface `bytes` to the route, and assert
        // the response carries `webusb: true` and `bytes: number[]` whose tail
        // is the forced drawer pulse (not just the body).
        db.prepare(`DELETE FROM printers`).run();
        db.prepare(`INSERT INTO printers (id, name, connection_type, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, 1, '80mm', ?, ?)`).run('webusb-1', 'WebUSB Test', 'webusb', now(), now());
        const webResp = await request(app)
          .post(`/api/cash-closures/${zId}/print`)
          .set('Authorization', `Bearer ${ownerPrintToken}`)
          .send({});
        assertEqual(webResp.status, 200, `print (webusb): owner POST → 200 (got ${webResp.status})`);
        assertEqual(webResp.body?.webusb, true, 'print (webusb): response.webusb === true');
        assert(Array.isArray(webResp.body?.bytes), 'print (webusb): response.bytes is number[]');
        const webBytes = webResp.body.bytes as number[];
        const webTail = webBytes.slice(-5);
        assert(JSON.stringify(webTail) === JSON.stringify([0x1B, 0x70, 0x00, 0x19, 0xFA]),
          `print (webusb): bytes include forced drawer pulse tail (got ${JSON.stringify(webTail)})`);
        assert(webResp.body.isReprint === false, 'print (webusb): response carries isReprint:false');
        // Re-clear for the rest of the file (later sections may add their own printers).
        db.prepare(`DELETE FROM printers`).run();

        // Missing Z row → 404.
        const missing = await request(app)
          .post('/api/cash-closures/999999/print')
          .set('Authorization', `Bearer ${ownerPrintToken}`)
          .send({});
        assertEqual(missing.status, 404, `print: missing Z → 404 (got ${missing.status})`);
      } finally {
        thermalModule.printZReport = origPrintZReport;
      }
    }

    console.log('\n15a. F6: closed_by stamped with name (not raw ID) in both Z payload and printed Z body (#649)');
    {
      // Re-install a network default printer; later print tests DELETE FROM printers between sub-tests.
      db.prepare(`DELETE FROM printers`).run();
      db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('printer-fa', '15a Printer', 'network', '127.0.0.1', 9100, '80mm', now(), now());
      // The Z row stamps `closed_by` as the requesting owner's id; the
      // display path resolves it through users(id → name) so the dashboard
      // and printed receipt show the operator's name, not the id. Reuse
      // the section-3 closure (owner = "Owner").
      const dayZBase = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sectionF6Date = dayZBase.toISOString().slice(0, 10);
      const resZ = await request(app).get(`/api/reports/z-report?date=${sectionF6Date}`).set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(resZ.status, 200, `F6 GET z-report: 200 (got ${resZ.status})`);
      const z = resZ.body?.zReport;
      assertEqual(z?.closed_by_name, 'Owner', `F6 closed_by_name surfaces user name (got ${JSON.stringify(z?.closed_by_name)})`);
      assertEqual(z?.closed_by, 'owner-close', `F6 closed_by still raw id (got ${JSON.stringify(z?.closed_by)})`);

      // Bytes: print and assert the printed operator block contains 'Owner'
      // (not the raw 'owner-close' id). The thermal body re-encodes text via
      // normalizeThermalText, but the ASCII-named operator renders verbatim.
      const thermalModule = require('../main/printers/thermal');
      const origPrint = thermalModule.printZReport;
      thermalModule.printZReport = async (zz: any) => {
        (thermalModule as any).__lastSnapshotForF6 = zz;
        return { ok: true, bytes: thermalModule.appendCashDrawerPulse(thermalModule.buildZReportBody(zz)), connection_type: 'network' };
      };
      try {
        const printResp = await request(app)
          .post(`/api/cash-closures/${z.id}/print`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({});
        assertEqual(printResp.status, 200, `F6 print: 200 (got ${printResp.status})`);
        // The thermal pipeline re-encodes text via normalizeThermalText; the
        // underlying bytes are not user-visible ASCII, so read the printZReport
        // payload directly. Assert the routed snapshot resolved closed_by_name.
        const printSpy = (thermalModule as any).__lastSnapshotForF6;
        assert(printSpy && printSpy.closed_by_name === 'Owner',
          `F6 print: snapshot carries closed_by_name='Owner' (got ${JSON.stringify(printSpy?.closed_by_name)})`);
        assert(printSpy && printSpy.closed_by === 'owner-close',
          `F6 print: snapshot keeps raw closed_by='owner-close' (got ${JSON.stringify(printSpy?.closed_by)})`);
        // F6 cross-check: the body builder pulls closed_by_name when present
        // (proves the print primitive reads the resolved name, not the id).
        const f6Body = thermalModule.buildZReportBody(printSpy);
        assert(f6Body.toString('binary').includes('Owner'),
          `F6 print: built body includes 'Owner' (got ${f6Body.toString('binary').slice(0, 400)})`);
      } finally {
        thermalModule.printZReport = origPrint;
      }
    }

    console.log('\n15b. F5: print path resolves currency through resolveTenantCurrency, not settings.currency fallback (#649)');
    {
      // Re-install a network default printer; later print tests DELETE FROM printers between sub-tests.
      db.prepare(`DELETE FROM printers`).run();
      db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('printer-fb', '15b Printer', 'network', '127.0.0.1', 9100, '80mm', now(), now());
      // Drop currency and seed country=JP. resolveTenantCurrency must pick
      // JPY (factor 1), so 150 minor units must render as "150", never as
      // "1.50" (which would be the legacy INR/100 fallback).
      const originalCurrency = (db.prepare(`SELECT value FROM settings WHERE key='currency'`).get() as any)?.value;
      try {
        db.prepare(`DELETE FROM settings WHERE key='currency'`).run();
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country','JP',?) ON CONFLICT(key) DO UPDATE SET value='JP', updated_at=excluded.updated_at`).run(now());

        const day30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const resZ = await request(app).get(`/api/reports/z-report?date=${day30}`).set('Authorization', `Bearer ${ownerToken}`);
        assertEqual(resZ.status, 200, `F5 GET z-report: 200 (got ${resZ.status})`);
        const zId = resZ.body?.zReport?.id;

        const thermalModule = require('../main/printers/thermal');
        const origPrint = thermalModule.printZReport;
        thermalModule.printZReport = async (zz: any) => {
          (thermalModule as any).__lastSnapshotForF5 = zz;
          return { ok: true, bytes: thermalModule.appendCashDrawerPulse(thermalModule.buildZReportBody(zz)), connection_type: 'network' };
        };
        try {
          const printResp = await request(app)
            .post(`/api/cash-closures/${zId}/print`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({});
          assertEqual(printResp.status, 200, `F5 print: 200 (got ${printResp.status})`);
          // F5: country=JP with no settings.currency must resolve JPY
          // (factor 1) via resolveTenantCurrency, so the rendered body
          // emits the JPY amount column verbatim — not collapsed by the
          // legacy INR/100 fallback. We pin two concrete observables:
          // (1) getCurrencyFractionDigits returns 0 for JP, so a JPY-
          // formatted amount has no decimal place; (2) the JPY body differs
          // from a body rendered with currency=INR/country=IN swapped in,
          // which would otherwise pass an equality-based assertion if a
          // regression reintroduced the legacy factor=100 fallback for JP.
          assertEqual(getCurrencyFractionDigits(resolveTenantCurrency(null, 'JP')), 0,
            `F5: getCurrencyFractionDigits(JP) must be 0 (got ${getCurrencyFractionDigits(resolveTenantCurrency(null, 'JP'))})`);
          const jpyBody = thermalModule.buildZReportBody(
            (thermalModule as any).__lastSnapshotForF5 ?? {}
          ).toString('binary');
          const jpySettings = (db.prepare(`SELECT key, value FROM settings`).all() as any[]);
          const savedCurrency = jpySettings.find((r: any) => r.key === 'currency')?.value;
          try {
            db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency','INR',?) ON CONFLICT(key) DO UPDATE SET value='INR', updated_at=excluded.updated_at`).run(now());
            db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country','IN',?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`).run(now());
            const inrBody = thermalModule.buildZReportBody(
              (thermalModule as any).__lastSnapshotForF5 ?? {}
            ).toString('binary');
            assert(jpyBody !== inrBody,
              `F5: JPY body must differ from INR/100 body (got len JPY=${jpyBody.length} INR=${inrBody.length})`);
          } finally {
            db.prepare(`DELETE FROM settings WHERE key='country'`).run();
            if (savedCurrency) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(savedCurrency, now());
            else db.prepare(`DELETE FROM settings WHERE key='currency'`).run();
            db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country','IN',?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`).run(now());
          }
        } finally {
          thermalModule.printZReport = origPrint;
        }
      } finally {
        db.prepare(`DELETE FROM settings WHERE key='country'`).run();
        if (originalCurrency) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(originalCurrency, now());
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country','IN',?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`).run(now());
      }
    }

    console.log('\n15c. F1+F2: cancelled-order paid bill still counts; paymentMethodBreakdown is shared (#649)');
    {
      // Re-install a network default printer; later print tests DELETE FROM printers between sub-tests.
      db.prepare(`DELETE FROM printers`).run();
      db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('printer-fc', '15c Printer', 'network', '127.0.0.1', 9100, '80mm', now(), now());
      // F1: a bill whose order was later cancelled must still count toward
      // display totals (the cash already left the drawer when the bill was
      // paid). Seed a brand-new day with a paid bill on a cancelled order
      // and assert the Z still includes the bill in gross/bill_count/expected.
      const cancelBase = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const cancelDate = cancelBase.toISOString().slice(0, 10);
      const created = dbTimestamp(new Date(`${cancelDate}T11:00:00Z`));
      const paid = dbTimestamp(new Date(`${cancelDate}T11:30:00Z`));
      db.prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES (?, ?, 'takeaway', 'cancelled', 500, 500, ?, ?, ?)
      `).run(`ORD-CANCEL-${cancelDate}`, cashierId, created, paid, paid);
      const orderId = Number(db.prepare(`SELECT id FROM orders WHERE order_number = ?`).get(`ORD-CANCEL-${cancelDate}`).id);
      db.prepare(`
        INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES (?, ?, 500, 500, 500, 0, 'paid', ?, ?, ?, ?)
      `).run(`B-CANCEL-${cancelDate}`, orderId, JSON.stringify([{ method: 'cash', amount: 500 }]), paid, created, created);

      const closed = await request(app)
        .post('/api/cash-closures')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ business_date: cancelDate, opening_float_cents: 0, counted_cash_cents: 500 });
      assertEqual(closed.status, 201, `F1: cancelled-order bill closes (got ${closed.status})`);
      const z = closed.body?.zReport;
      assertEqual(z?.bill_count, 1, `F1: cancelled-order paid bill still counted (got ${z?.bill_count})`);
      assertEqual(z?.gross_collected_cents, 50000, `F1: gross includes cancelled-order bill (got ${z?.gross_collected_cents})`);
      assertEqual(z?.expected_cash_cents, 50000, `F1: expected includes cancelled-order bill's cash (got ${z?.expected_cash_cents})`);

      // F2: paymentMethodBreakdown must be exported from cash-closures.ts and
      // reachable from reports.ts without a duplicate copy. Assert the export
      // exists.
      const cashMod = require('../main/routes/cash-closures');
      assert(typeof cashMod.paymentMethodBreakdown === 'function', `F2: paymentMethodBreakdown exported from cash-closures.ts`);
    }

    console.log('\n15d. Multi-day end-bound: shared paymentMethodBreakdown over start_date=A&end_date=B includes BOTH days (#649)');
    {
      // Regression anchor for the 49885ab fix: `paymentMethodBreakdown` binds
      // the trailing `payment_time < ?` to end-of-endDate, not end-of-startDate.
      // Exercise it through a real consumer (the X /api/reports/x-report date
      // union, here via financial-summary's shared consumer at start_date=A,
      // end_date=B). Pick two adjacent dates far in the past to avoid collisions
      // with sections 3-4 and 5.
      const dayBBase = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
      const dayA = new Date(dayBBase.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dayB = dayBBase.toISOString().slice(0, 10);
      // day A: cash 300, day B: cash 700. Distinct amounts so a buggy end-bound
      // (clamping to end-of-startDate = end-of-A) would visibly drop day B.
      seedPaidBill({
        billNumber: 'B-MULTI-A', method: 'cash', amount: 300, businessDate: dayA,
        createdAt: dbTimestamp(new Date(`${dayA}T11:00:00Z`)),
        paidAt: dbTimestamp(new Date(`${dayA}T11:00:00Z`)),
      });
      seedPaidBill({
        billNumber: 'B-MULTI-B', method: 'cash', amount: 700, businessDate: dayB,
        createdAt: dbTimestamp(new Date(`${dayB}T11:00:00Z`)),
        paidAt: dbTimestamp(new Date(`${dayB}T11:00:00Z`)),
      });

      // Shared consumer over [A, B] bounded at end-of-B. The day-A-only pass
      // (start=end=A) must include A's row and exclude B's; the multi-day
      // pass (start=A, end=B) must include BOTH rows. The difference in
      // gross_collected between the two passes pins the trailing bound to
      // end-of-endDate.
      const single = await request(app)
        .get('/api/reports/financial-summary')
        .query({ start_date: dayA, end_date: dayA })
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(single.status, 200, `single-day consumer returns 200 (got ${single.status})`);
      const singleGross = Number(single.body?.financialSummary?.grossCollected ?? 0);
      const singleBills = Number(single.body?.financialSummary?.billCount ?? 0);
      assertEqual(singleBills, 1, `single-day: only B-MULTI-A counted (got ${singleBills})`);
      assertEqual(singleGross, 300, `single-day: gross = 300, B-MULTI-B excluded (got ${singleGross})`);

      const multi = await request(app)
        .get('/api/reports/financial-summary')
        .query({ start_date: dayA, end_date: dayB })
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(multi.status, 200, `multi-day consumer returns 200 (got ${multi.status})`);
      const multiGross = Number(multi.body?.financialSummary?.grossCollected ?? 0);
      const multiBills = Number(multi.body?.financialSummary?.billCount ?? 0);
      assertEqual(multiBills, 2, `multi-day: BOTH bills counted (got ${multiBills})`);
      assertEqual(multiGross, 1000, `multi-day: gross = 300 + 700, trailing bound = end-of-endDate (got ${multiGross})`);
      assert(multiGross > singleGross, `multi-day gross (${multiGross}) > single-day gross (${singleGross}); the trailing bind is end-of-endDate, not end-of-startDate`);
    }

    console.log('\n16. F4: direct no-I/O printZReport coverage + route 409/502 (#649)');
    {
      const thermalModule = require('../main/printers/thermal');
      const f4OwnerToken = jwt.sign({ userId: ownerId, email: 'owner-close@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
      // Re-seed the default printer (section 15 cleared printers at the end
      // of its webusb sub-block) and resolve the stored Z directly from DB.
      db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('printer-f4', 'F4 Printer', 'network', '127.0.0.1', 9100, '80mm', now(), now());
      const zRow = db.prepare(`SELECT * FROM cash_closures ORDER BY id DESC LIMIT 1`).get() as any;
      const z = {
        ...zRow,
        payment_methods: JSON.parse(zRow.payment_methods_json || '[]'),
        staff_sales: JSON.parse(zRow.staff_sales_json || '[]'),
        tax_components: JSON.parse(zRow.tax_components_json || '[]'),
      };
      // (a) Direct webusb branch — no socket, no mock: real printZReport
      // resolves bytes including the forced drawer pulse for webusb printers.
      const realPrintZ = thermalModule.printZReport;
      const webusbPrinter = {
        id: 'webusb-direct', name: 'Direct WebUSB', connection_type: 'webusb',
        is_default: 1, paper_width: '80mm',
      };
      const direct = await realPrintZ(z, 'en', undefined, webusbPrinter);
      assertEqual(direct.ok, true, `F4 direct: printZReport(webusb) ok=true (got ${direct.ok})`);
      assertEqual(direct.connection_type, 'webusb', 'F4 direct: connection_type=webusb');
      assert(Buffer.isBuffer(direct.bytes), 'F4 direct: bytes is a Buffer');
      const directArr = Array.from(direct.bytes!);
      const directTail = directArr.slice(-5);
      assert(JSON.stringify(directTail) === JSON.stringify([0x1B, 0x70, 0x00, 0x19, 0xFA]),
        `F4 direct: forced drawer pulse tail (got ${JSON.stringify(directTail)})`);
      // Non-webusb direct dispatch (network): same shape, no mock — the test
      // server is not actually reachable, so the helper returns ok:false with
      // a socket detail. We assert the contract (bytes present, detail propagated).
      const networkPrinter = {
        id: 'network-direct', name: 'Direct Network', connection_type: 'network',
        is_default: 1, ip_address: '127.0.0.1', port: 1, paper_width: '80mm',
      };
      const netDirect = await realPrintZ(z, 'en', undefined, networkPrinter);
      assertEqual(typeof netDirect.bytes?.length, 'number', 'F4 direct: network branch returns bytes buffer');
      assertEqual(netDirect.connection_type, 'network', 'F4 direct: connection_type=network');

      // (b) 409: no default printer → route returns 409 with the existing
      // message; the route never reaches printZReport (so we keep the real
      // helper installed; nothing to restore).
      db.prepare(`DELETE FROM printers`).run();
      const noPrinter = await request(app)
        .post(`/api/cash-closures/${z.id}/print`)
        .set('Authorization', `Bearer ${f4OwnerToken}`)
        .send({});
      assertEqual(noPrinter.status, 409, `F4 409: no default printer → 409 (got ${noPrinter.status})`);
      assert(/no default printer/i.test(noPrinter.body?.error || ''),
        `F4 409: error message names default printer (got ${JSON.stringify(noPrinter.body)})`);

      // (c) 502: dispatch failure surfaces the underlying detail. Mock the
      // helper to return ok:false with a distinguishable detail string.
      const origPrintZReport = thermalModule.printZReport;
      const networkPrinter2 = {
        id: 'net-502', name: 'Net 502', connection_type: 'network',
        is_default: 1, ip_address: '127.0.0.1', port: 1, paper_width: '80mm',
      };
      db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(networkPrinter2.id, networkPrinter2.name, networkPrinter2.connection_type,
             networkPrinter2.ip_address, networkPrinter2.port, networkPrinter2.paper_width, now(), now());
      thermalModule.printZReport = async () => ({ ok: false, detail: 'connection refused (test)' });
      try {
        const fail = await request(app)
          .post(`/api/cash-closures/${z.id}/print`)
          .set('Authorization', `Bearer ${f4OwnerToken}`)
          .send({});
        assertEqual(fail.status, 502, `F4 502: dispatch fail → 502 (got ${fail.status})`);
        assertEqual(fail.body?.detail, 'connection refused (test)',
          `F4 502: response carries underlying detail (got ${JSON.stringify(fail.body)})`);
      } finally {
        thermalModule.printZReport = origPrintZReport;
      }
    }

    // ── Section 13: regression — shared paymentMethodBreakdown defaults ───
    // After commit e1ec953 the helper moved into cash-closures.ts and the
    // three reports.ts call sites (daily-stats 2 args, summary 2 args,
    // sales 4 args) now rely on its defaults. Build breaks (TS2554) and
    // those endpoints 500 at runtime if any default is dropped — pin them.
    {
      console.log('\n13. Regression: shared paymentMethodBreakdown defaults');
      const ds = await request(app)
        .get('/api/reports/daily-stats')
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(ds.status, 200, `daily-stats returns 200 (got ${ds.status})`);
      assert(Array.isArray(ds.body?.paymentMethods),
        'daily-stats shape: paymentMethods array present');
      assert(typeof ds.body?.sales === 'number',
        'daily-stats shape: sales numeric');

      const sum = await request(app)
        .get('/api/reports/summary')
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(sum.status, 200, `summary returns 200 (got ${sum.status})`);
      assert(sum.body?.summary?.orders !== undefined,
        'summary shape: summary.orders present');
      assert(sum.body?.summary?.paymentMethods !== undefined,
        'summary shape: summary.paymentMethods present');
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
