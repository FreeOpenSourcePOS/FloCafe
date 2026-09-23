/**
 * Cash sessions / shift lifecycle (issue #279, approach A).
 *
 * Section 1: `cash_sessions` table + settings seed.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cash-sessions.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cash-sessions-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cash-sessions';

const express = require('express');
const expressRateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initDatabase, getDatabase, getSettingValue, now,
} = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');

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

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

async function main() {
  console.log('Cash sessions / shift lifecycle');
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

  // ── Section 1: schema + seed ──────────────────────────────────────────
  console.log('Section 1: cash_sessions table + settings seed');
  const cols = (db.prepare(`PRAGMA table_info(cash_sessions)`).all() as { name: string }[]).map((c) => c.name);
  assert(cols.includes('opened_by'), 'cash_sessions has opened_by');
  assert(cols.includes('opened_at'), 'cash_sessions has opened_at');
  assert(cols.includes('opening_float_cents'), 'cash_sessions has opening_float_cents');
  assert(cols.includes('status'), 'cash_sessions has status');
  assert(cols.includes('closure_id'), 'cash_sessions has closure_id');
  const oneOpen = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'cash_sessions_one_open'`).get() as { sql: string } | undefined;
  assert(!!oneOpen && oneOpen.sql.includes('WHERE'), 'partial unique index allows a single open session');
  assert(getSettingValue('require_open_shift') === 'false', 'enforcement defaults to off');
  assert(getSettingValue('stale_session_days') === '7', 'stale threshold defaults to 7 days');

  // ── Section 2: open/current/close lifecycle ───────────────────────────
  console.log('Section 2: open/current/close lifecycle');
  let cashSessionRoutes: any = null;
  try {
    cashSessionRoutes = require('../main/routes/cash-sessions').cashSessionRoutes;
  } catch {
    // Route file lands in implementation step.
  }
  assert(!!cashSessionRoutes, 'cash-sessions router exists');
  let app: any = null;
  let past: (msAgo: number) => string = () => '';
  let cashierToken = '';
  if (cashSessionRoutes) {
    const ts = (d: Date) => d.toISOString().replace('T', ' ').replace(/\..*$/, '');
    // Regional settings are never auto-seeded (business-decisions.md) — a
    // resolvable country/currency/timezone is required, as in cash-closures.test.ts.
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`).run(now());
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'INR', ?) ON CONFLICT(key) DO UPDATE SET value='INR', updated_at=excluded.updated_at`).run(now());
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'UTC', ?) ON CONFLICT(key) DO UPDATE SET value='UTC', updated_at=excluded.updated_at`).run(now());
    for (const [id, name, email, role] of [
      ['owner-sess', 'Owner', 'owner-sess@test.local', 'owner'],
      ['manager-sess', 'Manager', 'manager-sess@test.local', 'manager'],
      ['cashier-sess', 'Cashier', 'cashier-sess@test.local', 'cashier'],
      ['server-sess', 'Server', 'server-sess@test.local', 'server'],
    ] as const) {
      db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, name, email, bcrypt.hashSync('pw', 10), role, now(), now());
    }
    app = express();
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
    app.use('/api/cash-sessions', cashSessionRoutes);
    const token = (userId: string, email: string, role: string) =>
      jwt.sign({ userId, email, role }, getJWTSecret(), { expiresIn: '1h' });
    cashierToken = token('cashier-sess', 'cashier-sess@test.local', 'cashier');
    const serverToken = token('server-sess', 'server-sess@test.local', 'server');

    const openRes = await request(app).post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 5000 });
    assert(openRes.status === 200, 'cashier opens a session (200)');
    const sessionId = openRes.body?.id;
    assert(typeof sessionId === 'number', 'open returns a session id');

    const doubleOpen = await request(app).post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 100 });
    assert(doubleOpen.status === 409, 'second open while one is open is 409');

    const serverOpen = await request(app).post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${serverToken}`).send({ opening_float_cents: 100 });
    assert(serverOpen.status === 403, 'server role cannot open a session (403)');

    // One cash sale inside the session window: 100.00 cash. Timestamps sit
    // strictly inside the window: session windows are half-open
    // [opened_at, closed_at) like day bounds, so same-second fixtures would
    // fall outside.
    past = (msAgo: number) => ts(new Date(Date.now() - msAgo));
    db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(past(3600_000), sessionId);
    const moment = past(1800_000);
    db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES ('ORD-SESS-1', 'cashier-sess', 'takeaway', 'completed', 100, 100, ?, ?, ?)`)
      .run(moment, moment, moment);
    const orderId = Number((db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-SESS-1'`).get() as any).id);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES ('SESS-1', ?, 100, 100, 100, 0, 'paid', ?, ?, ?, ?)`)
      .run(orderId, JSON.stringify([{ method: 'cash', amount: 100, timestamp: moment }]), moment, moment, moment);

    const current = await request(app).get('/api/cash-sessions/current')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(current.status === 200, 'current returns the open session (200)');
    assert(current.body?.expected_cash_cents === 15000, 'live expected = float 5000 + cash sale 10000');

    const closeRes = await request(app).post(`/api/cash-sessions/${sessionId}/close`)
      .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 16000 });
    assert(closeRes.status === 200, 'cashier closes own session (200)');
    assert(closeRes.body?.variance_cents === 1000, 'variance = counted 16000 - expected 15000');
    const closure = db.prepare(`SELECT scope, z_number FROM cash_closures WHERE id = ?`).get(closeRes.body?.closure_id) as any;
    assert(closure?.scope === 'session', 'close writes a scope=session closure row');
    assert(typeof closure?.z_number === 'number', 'session closure carries a Z number');
    const after = await request(app).get('/api/cash-sessions/current')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(after.status === 404, 'no current session after close (404)');
  }

  // ── Section 3: enforcement (default off) ──────────────────────────────
  console.log('Section 3: enforcement gate, default off');
  const { billRoutes } = require('../main/routes/bills');
  const { cashClosureRoutes } = require('../main/routes/cash-closures');
  app.use('/api/bills', billRoutes);
  app.use('/api/cash-closures', cashClosureRoutes);
  assert(!!billRoutes && !!cashClosureRoutes, 'bills + closures routers mount');

  function seedUnpaidBill(tag: string): number {
    const m = past(600_000);
    db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, 'cashier-sess', 'takeaway', 'pending', 50, 50, ?, ?, NULL)`)
      .run(`ORD-ENF-${tag}`, m, m);
    const oid = Number((db.prepare(`SELECT id FROM orders WHERE order_number = ?`).get(`ORD-ENF-${tag}`) as any).id);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, 50, 50, 0, 50, 'unpaid', '[]', NULL, ?, ?)`)
      .run(`ENF-${tag}`, oid, m, m);
    return Number((db.prepare(`SELECT id FROM bills WHERE bill_number = ?`).get(`ENF-${tag}`) as any).id);
  }
  const todayLocal = new Date().toISOString().slice(0, 10);

  const billOff = seedUnpaidBill('off');
  const payOff = await request(app).post(`/api/bills/${billOff}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 50 });
  assert(payOff.status === 200, 'enforcement off: cash payment without a session works (200)');

  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  const billOn = seedUnpaidBill('on');
  const payOn = await request(app).post(`/api/bills/${billOn}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 50 });
  assert(payOn.status === 409, 'enforcement on: cash payment without a session is 409');
  assert(/shift/i.test(String(payOn.body?.error || '')), '409 names the missing open shift');

  const billCard = seedUnpaidBill('card');
  const cardOn = await request(app).post(`/api/bills/${billCard}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'card', amount: 50 });
  assert(cardOn.status === 200, 'enforcement on: non-cash payment without a session works (200)');

  const movBlocked = await request(app).post('/api/cash-closures/movements')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ business_date: todayLocal, movement_type: 'pay_in', amount_cents: 1000, reason: 'test' });
  assert(movBlocked.status === 409, 'enforcement on: drawer movement without a session is 409');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();
  const payOnLate = await request(app).post(`/api/bills/${billOn}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 50 });
  assert(payOnLate.status === 200, 'blocked bill pays fine once enforcement is off (200)');

  // ── Section 4: close guards ───────────────────────────────────────────
  console.log('Section 4: unpaid-bills block + stale auto-close');
  const guardOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(guardOpen.status === 200, 'guard session opens (200)');
  const guardId = guardOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(past(3600_000), guardId);
  const guardBill = seedUnpaidBill('guard');
  const blockedClose = await request(app).post(`/api/cash-sessions/${guardId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(blockedClose.status === 409, 'close with an unpaid bill in-window is 409');
  assert(/unpaid/i.test(String(blockedClose.body?.error || '')), '409 names unpaid bills');
  const payGuard = await request(app).post(`/api/bills/${guardBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 50 });
  assert(payGuard.status === 200, 'unpaid bill can still be paid (200)');
  const unblockedClose = await request(app).post(`/api/cash-sessions/${guardId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 5000 });
  assert(unblockedClose.status === 200, 'close succeeds once bills are paid (200)');

  const staleOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 100 });
  assert(staleOpen.status === 200, 'stale-candidate session opens (200)');
  const staleId = staleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(staleId);
  // Store-wide inactivity is part of the stale rule: backdate this run's
  // paid bills and movements beyond the cutoff so the store reads inactive.
  db.prepare(`UPDATE bills SET paid_at = datetime('now', '-8 days') WHERE paid_at IS NOT NULL`).run();
  db.prepare(`UPDATE cash_drawer_movements SET created_at = datetime('now', '-8 days')`).run();
  const freshOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 200 });
  assert(freshOpen.status === 200, 'new open auto-closes the stale session (200)');
  const staleRow = db.prepare(`SELECT status, closed_by, closure_id FROM cash_sessions WHERE id = ?`).get(staleId) as any;
  assert(staleRow?.status === 'closed', 'stale session marked closed');
  const staleClosure = db.prepare(`SELECT counted_cash_cents, notes FROM cash_closures WHERE id = ?`).get(staleRow?.closure_id) as any;
  assert(staleClosure?.counted_cash_cents === 0, 'stale auto-close records zero count');
  assert(/review/i.test(String(staleClosure?.notes || '')), 'stale auto-close flagged for manager review');
  const tidyClose = await request(app).post(`/api/cash-sessions/${freshOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 200 });
  assert(tidyClose.status === 200, 'section-4 fresh session closed to leave a clean slate (200)');

  // ── Section 5: roles ────────────────────────────────────────────────
  console.log('Section 5: capabilities + force-close');
  const { PERMISSION_CAPABILITIES, ROLE_ACCESS } = require('../shared/role-permissions');
  const shiftOpen = PERMISSION_CAPABILITIES.find((c: any) => c.id === 'shiftOpen');
  const shiftClose = PERMISSION_CAPABILITIES.find((c: any) => c.id === 'shiftClose');
  assert(!!shiftOpen && !!shiftClose, 'shiftOpen/shiftClose capabilities exist');
  assert(
    !!shiftOpen && [...shiftOpen.allowedRoles].sort().join(',') === [...ROLE_ACCESS.ownerManagerCashier].sort().join(','),
    'shift capabilities allow owner/manager/cashier',
  );

  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('chef-sess', 'Chef', 'chef-sess@test.local', ?, 'chef', 1, ?, ?)`)
    .run(bcrypt.hashSync('pw', 10), now(), now());
  const managerToken = jwt.sign({ userId: 'manager-sess', email: 'manager-sess@test.local', role: 'manager' }, getJWTSecret(), { expiresIn: '1h' });
  const chefToken = jwt.sign({ userId: 'chef-sess', email: 'chef-sess@test.local', role: 'chef' }, getJWTSecret(), { expiresIn: '1h' });
  const mcOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(mcOpen.status === 200, 'cashier opens for force-close test (200)');
  const forceClose = await request(app).post(`/api/cash-sessions/${mcOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${managerToken}`).send({ counted_cash_cents: 0 });
  assert(forceClose.status === 200, 'manager force-closes another shift (200)');
  const forced = db.prepare(`SELECT status, closed_by FROM cash_sessions WHERE id = ?`).get(mcOpen.body?.id) as any;
  assert(forced?.status === 'closed' && forced?.closed_by === 'manager-sess', 'force-close records the manager');
  const chefCurrent = await request(app).get('/api/cash-sessions/current')
    .set('Authorization', `Bearer ${chefToken}`);
  assert(chefCurrent.status === 403, 'chef cannot read sessions (403)');

  // ── Section 6: session Z print gate ───────────────────────────────────
  console.log('Section 6: session print gate');
  db.prepare(`DELETE FROM printers`).run();
  db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run('printer-default', 'Default Test Printer', 'network', '127.0.0.1', 9100, '80mm', now(), now());
  const ownerToken = jwt.sign({ userId: 'owner-sess', email: 'owner-sess@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const prOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(prOpen.status === 200, 'print-test session opens (200)');
  const prClose = await request(app).post(`/api/cash-sessions/${prOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(prClose.status === 200, 'print-test session closes (200)');
  const cashierPrint = await request(app).post(`/api/cash-closures/${prClose.body?.closure_id}/print`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ isReprint: false });
  assert(cashierPrint.status !== 403, 'cashier may print own session Z (not 403)');
  const dayClose = await request(app).post('/api/cash-closures')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ business_date: todayLocal, opening_float_cents: 5000, counted_cash_cents: 5000 });
  assert(dayClose.status === 201, 'owner day-close for gate test (201)');
  const managerDayPrint = await request(app).post(`/api/cash-closures/${dayClose.body?.zReport?.id}/print`)
    .set('Authorization', `Bearer ${managerToken}`).send({ isReprint: false });
  assert(managerDayPrint.status === 403, 'manager cannot print day-close Z (403)');

  // ── Section 7: round-2 review findings ────────────────────────────────
  console.log('Section 7: partial block, case-insensitive gate, refund gate');
  const { refundRoutes } = require('../main/routes/refunds');
  app.use('/api/refunds', refundRoutes);
  assert(!!refundRoutes, 'refunds router mounts');

  const pOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(pOpen.status === 200, 'partial-guard session opens (200)');
  db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(past(3600_000), pOpen.body?.id);
  // Partial bill: 50 total, 20 paid, 30 outstanding.
  const pm = past(1800_000);
  db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-PART-1', 'cashier-sess', 'takeaway', 'completed', 50, 50, ?, ?, ?)`)
    .run(pm, pm, pm);
  const partOrderId = Number((db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-PART-1'`).get() as any).id);
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('PART-1', ?, 50, 50, 20, 30, 'partial', ?, ?, ?, ?)`)
    .run(partOrderId, JSON.stringify([{ method: 'cash', amount: 20, timestamp: pm }]), pm, pm, pm);
  const partClose = await request(app).post(`/api/cash-sessions/${pOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(partClose.status === 409, 'close with a partial bill in-window is 409');
  const partBillId = Number((db.prepare(`SELECT id FROM bills WHERE bill_number = 'PART-1'`).get() as any).id);
  const payPart = await request(app).post(`/api/bills/${partBillId}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 30 });
  assert(payPart.status === 200, 'partial bill settles (200)');
  const closePart = await request(app).post(`/api/cash-sessions/${pOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 2000 });
  assert(closePart.status === 200, 'close succeeds once partial is settled (200)');

  // Case-insensitive gate: custom method named "Cash" is still cash.
  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  // Case-insensitive gate: custom method named "Cash" is still cash.
  db.prepare(`INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES ('Cash', 1, 10, ?, ?)`)
    .run(now(), now());
  const customId = Number((db.prepare(`SELECT id FROM payment_methods WHERE name = 'Cash'`).get() as any).id);
  const ciBill = seedUnpaidBill('ci');
  const ciPay = await request(app).post(`/api/bills/${ciBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'Cash', amount: 50 });
  assert(ciPay.status === 409, 'enforcement on: "Cash" (capitalized) without a session is 409');

  // Cash refunds leave the drawer: gated like cash payments. The gate fires
  // before PIN verification, so no PIN fixture is needed for the 409 path.
  const rfPay = await request(app).post(`/api/bills/${ciBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'card', amount: 50 });
  assert(rfPay.status === 200, 'card payment for refund fixture (200)');
  const rfBillId = ciBill;
  const rfBlocked = await request(app).post('/api/refunds')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ bill_id: rfBillId, amount: 10, method: 'cash', approver_id: 'manager-sess' });
  assert(rfBlocked.status === 409, 'enforcement on: cash refund without a session is 409');
  assert(/shift/i.test(String(rfBlocked.body?.error || '')), 'refund 409 names the missing open shift');

  // Custom method resolving to cash is still cash (resolution-aware gate).
  const ciCustomBill = seedUnpaidBill('cicustom');
  const ciCustomPay = await request(app).post(`/api/bills/${ciCustomBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'custom', payment_method_id: customId, amount: 50 });
  assert(ciCustomPay.status === 409, 'enforcement on: custom "Cash" method without a session is 409');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();

  // ── Section 8: float mirror (day/session consistency) ───────────────
  console.log('Section 8: opening-float mirror');
  db.prepare(`DELETE FROM cash_drawer_movements WHERE movement_type = 'opening_float'`).run();
  const mOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 7000 });
  assert(mOpen.status === 200, 'mirror-test session opens (200)');
  const mirrored = db.prepare(
    `SELECT amount_cents FROM cash_drawer_movements WHERE movement_type = 'opening_float' AND voided_at IS NULL`,
  ).all() as { amount_cents: number }[];
  assert(mirrored.length === 1 && mirrored[0].amount_cents === 7000, 'open mirrors one float movement (creation path)');
  const mClose = await request(app).post(`/api/cash-sessions/${mOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 7000 });
  assert(mClose.status === 200 && mClose.body?.variance_cents === 0, 'session ignores the mirrored movement (no double count)');
  const mOpen2 = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 9000 });
  assert(mOpen2.status === 200, 'second float session opens (200)');
  const mirrored2 = db.prepare(
    `SELECT amount_cents FROM cash_drawer_movements WHERE movement_type = 'opening_float' AND voided_at IS NULL`,
  ).all() as { amount_cents: number }[];
  assert(mirrored2.length === 1, 'one movement per day: second open skips the mirror');
  const mClose2 = await request(app).post(`/api/cash-sessions/${mOpen2.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 9000 });
  assert(mClose2.status === 200 && mClose2.body?.variance_cents === 0, 'session uses its own float, not the movement');

  console.log('='.repeat(50));
  console.log(`Passed ${passed}/${total}, failed ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
