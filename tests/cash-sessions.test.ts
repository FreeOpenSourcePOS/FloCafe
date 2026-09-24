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
  const movementOwnershipCols = (db.prepare(`PRAGMA table_info(cash_drawer_movements)`).all() as { name: string }[]).map((c) => c.name);
  assert(movementOwnershipCols.includes('cash_session_id'), 'movements carry cash_session_id');
  const refundOwnershipCols = (db.prepare(`PRAGMA table_info(refunds)`).all() as { name: string }[]).map((c) => c.name);
  assert(refundOwnershipCols.includes('cash_session_id'), 'refunds carry cash_session_id');

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
  let cashier2Token = '';
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
      ['cashier2-sess', 'Cashier Two', 'cashier2-sess@test.local', 'cashier'],
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
    cashier2Token = token('cashier2-sess', 'cashier2-sess@test.local', 'cashier');
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

  const billBatch = seedUnpaidBill('batch');
  const batchBlocked = await request(app).post(`/api/bills/${billBatch}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ payments: [{ method: 'card', amount: 25 }, { method: 'cash', amount: 25 }] });
  assert(batchBlocked.status === 409, 'enforcement on: cash batch payment without a session is 409');
  assert(/shift/i.test(String(batchBlocked.body?.error || '')), 'batch 409 names the missing open shift');
  const batchAfterBlocked = db.prepare('SELECT paid_amount, payment_status FROM bills WHERE id = ?').get(billBatch) as any;
  assert(batchAfterBlocked?.paid_amount === 0 && batchAfterBlocked?.payment_status === 'unpaid', 'blocked cash batch leaves the bill unpaid');

  const billBatchCard = seedUnpaidBill('batch-card');
  const batchCard = await request(app).post(`/api/bills/${billBatchCard}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ payments: [{ method: 'card', amount: 50 }] });
  assert(batchCard.status === 200, 'enforcement on: card batch payment without a session works (200)');

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
  const batchPaidLate = await request(app).post(`/api/bills/${billBatch}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ payments: [{ method: 'card', amount: 25 }, { method: 'cash', amount: 25 }] });
  assert(batchPaidLate.status === 200, 'blocked cash batch pays once enforcement is off (200)');

  const replaySession = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(replaySession.status === 200, 'replay-test session opens');
  const replaySessionId = replaySession.body?.id;
  const replayBill = seedUnpaidBill('replay');
  const replayFirst = await request(app).post(`/api/bills/${replayBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50, transaction_id: 'shift-replay' });
  assert(replayFirst.status === 200, 'replay fixture payment is recorded while the shift is open');
  const replayClose = await request(app).post(`/api/cash-sessions/${replaySessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 5000 });
  assert(replayClose.status === 200, 'replay-test shift closes');
  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  const replayRetry = await request(app).post(`/api/bills/${replayBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50, transaction_id: 'shift-replay' });
  assert(replayRetry.status === 200, 'recorded cash payment replays after its shift closes');
  const replayPaid = db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(replayBill) as any;
  assert(Number(replayPaid?.paid_amount) === 50, 'replay after shift close does not double-count');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();

  const ownedSession = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(ownedSession.status === 200, 'ownership-test session opens');
  const ownedSessionId = ownedSession.body?.id;
  const ownedMovement = await request(app).post('/api/cash-closures/movements')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ business_date: todayLocal, movement_type: 'pay_in', amount_cents: 1000, reason: 'ownership' });
  assert(ownedMovement.status === 201, 'movement records with an open session');
  const ownedRow = db.prepare('SELECT cash_session_id FROM cash_drawer_movements WHERE id = ?').get(ownedMovement.body?.movement?.id) as any;
  assert(Number(ownedRow?.cash_session_id) === Number(ownedSessionId), 'movement stores the active session owner');
  // An owned movement must appear in the immutable Z even when its coarse
  // timestamp lies outside the half-open window used by legacy rows.
  db.prepare(`UPDATE cash_drawer_movements SET created_at = '9999-12-31 00:00:00' WHERE id = ?`)
    .run(ownedMovement.body?.movement?.id);
  const ownedTidy = await request(app).post(`/api/cash-sessions/${ownedSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 1000 });
  assert(ownedTidy.status === 200, 'ownership-test session closes');
  const ownedZ = db.prepare('SELECT expected_cash_cents, pay_in_cents, cash_movements_json FROM cash_closures WHERE id = ?')
    .get(ownedTidy.body?.closure_id) as any;
  assert(ownedZ?.expected_cash_cents === 1000 && ownedZ?.pay_in_cents === 1000,
    'session Z movement total reconciles with owned expected cash');
  assert(JSON.parse(ownedZ?.cash_movements_json || '[]').some((movement: any) => movement.id === ownedMovement.body?.movement?.id),
    'session Z includes its owned movement line');

  const sessionlessMovement = await request(app).post('/api/cash-closures/movements')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ business_date: todayLocal, movement_type: 'pay_in', amount_cents: 700, reason: 'before shift' });
  assert(sessionlessMovement.status === 201, 'cash movement is allowed without a shift when enforcement is off');
  const afterMovementOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(afterMovementOpen.status === 200, 'shift opens after a sessionless movement');
  db.prepare('UPDATE cash_drawer_movements SET created_at = ? WHERE id = ?')
    .run(afterMovementOpen.body?.opened_at, sessionlessMovement.body?.movement?.id);
  const afterMovementCurrent = await request(app).get('/api/cash-sessions/current')
    .set('Authorization', `Bearer ${cashierToken}`);
  assert(afterMovementCurrent.body?.expected_cash_cents === 0,
    'same-second cash movement recorded before a shift does not enter its expected cash');
  const afterMovementClose = await request(app).post(`/api/cash-sessions/${afterMovementOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(afterMovementClose.status === 200, 'sessionless-movement fixture closes');

  const { refundRoutes: lineRefundRoutes } = require('../main/routes/refunds');
  app.use('/api/refunds', lineRefundRoutes);
  const lineSession = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(lineSession.status === 200, 'line-ownership session opens');
  const lineSessionId = lineSession.body?.id;
  const ownedBill = seedUnpaidBill('owned-line');
  const ownedPay = await request(app).post(`/api/bills/${ownedBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 20 });
  assert(ownedPay.status === 200, 'partial cash tender is accepted');
  const ownedDetails = JSON.parse((db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(ownedBill) as any).payment_details);
  assert(Number(ownedDetails[ownedDetails.length - 1]?.cash_session_id) === Number(lineSessionId), 'new payment line stores the active session owner');
  assert((db.prepare('SELECT paid_at FROM bills WHERE id = ?').get(ownedBill) as any).paid_at === null, 'partial payment leaves paid_at unset');
  db.prepare(`UPDATE users SET pin_hash = ? WHERE id = 'owner-sess'`).run(bcrypt.hashSync('1234', 10));
  const ownedOwnerToken = jwt.sign({ userId: 'owner-sess', email: 'owner-sess@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const ownedRefundBill = seedUnpaidBill('owned-refund');
  const ownedRefundPay = await request(app).post(`/api/bills/${ownedRefundBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 50 });
  assert(ownedRefundPay.status === 200, 'refund fixture bill settles');
  const ownedRefundPayload = { bill_id: ownedRefundBill, amount: 10, method: 'cash', approver_id: 'owner-sess', override_pin: '1234' };
  const ownedRefund = await request(app).post('/api/refunds')
    .set('Authorization', `Bearer ${ownedOwnerToken}`)
    .set('Idempotency-Key', 'cash-session-refund-replay')
    .send(ownedRefundPayload);
  assert(ownedRefund.status === 201, 'cash refund is created');
  const ownedRefundRow = db.prepare('SELECT cash_session_id FROM refunds WHERE id = ?').get(ownedRefund.body?.refund?.id) as any;
  assert(Number(ownedRefundRow?.cash_session_id) === Number(lineSessionId), 'new refund stores the active session owner');
  const ownedSettle = await request(app).post(`/api/bills/${ownedBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 30 });
  assert(ownedSettle.status === 200, 'partial fixture bill settles before cleanup');
  const lineTidy = await request(app).post(`/api/cash-sessions/${lineSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 90 });
  assert(lineTidy.status === 200, 'line-ownership fixtures close cleanly');
  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  const refundReplay = await request(app).post('/api/refunds')
    .set('Authorization', `Bearer ${ownedOwnerToken}`)
    .set('Idempotency-Key', 'cash-session-refund-replay')
    .send(ownedRefundPayload);
  assert(refundReplay.status === 201, 'recorded cash refund replays after its shift closes');
  const refundRows = db.prepare('SELECT COUNT(*) AS c FROM refunds WHERE bill_id = ?').get(ownedRefundBill) as { c: number };
  assert(refundRows.c === 1, 'refund replay does not create a second refund');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();
  const ownedLineZ = db.prepare('SELECT gross_collected_cents, refunded_cents, net_collected_cents, payment_methods_json FROM cash_closures WHERE id = ?')
    .get(lineTidy.body?.closure_id) as any;
  assert(ownedLineZ?.gross_collected_cents === 10000 && ownedLineZ?.refunded_cents === 1000
    && ownedLineZ?.net_collected_cents === 9000,
  'session Z sales and refunds match the cash events recorded during the shift');
  assert(JSON.parse(ownedLineZ?.payment_methods_json || '[]').some((method: any) => method.method.toLowerCase() === 'cash' && method.total_cents === 9000),
    'session Z payment method breakdown includes partial cash and its refund');

  const { sessionExpectedCash } = require('../main/routes/cash-closures');
  assert(typeof sessionExpectedCash === 'function', 'session expected-cash helper exists');
  const boundaryMoment = '2020-01-01 12:00:00';
  const firstBoundary = db.prepare(`INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status, closed_at, closed_by)
    VALUES ('cashier-sess', 'Cashier', ?, 0, 'closed', ?, 'cashier-sess')`).run(boundaryMoment, boundaryMoment);
  const secondBoundary = db.prepare(`INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status, closed_at, closed_by)
    VALUES ('cashier-sess', 'Cashier', ?, 0, 'closed', ?, 'cashier-sess')`).run(boundaryMoment, boundaryMoment);
  const firstBoundaryId = Number(firstBoundary.lastInsertRowid);
  const secondBoundaryId = Number(secondBoundary.lastInsertRowid);
  db.prepare(`INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, created_at, cash_session_id)
    VALUES ('2020-01-01', 'pay_in', 1000, 'boundary', 'cashier-sess', ?, ?)`).run(boundaryMoment, firstBoundaryId);
  db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-BOUND-1', 'cashier-sess', 'takeaway', 'pending', 50, 50, '2019-12-31 12:00:00', '2019-12-31 12:00:00', NULL)`).run();
  const boundaryOrderId = Number((db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-BOUND-1'`).get() as any).id);
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('BOUND-1', ?, 50, 50, 20, 30, 'partial', ?, NULL, '2019-12-31 12:00:00', '2019-12-31 12:00:00')`)
    .run(boundaryOrderId, JSON.stringify([{ method: 'cash', amount: 20, timestamp: boundaryMoment, cash_session_id: firstBoundaryId }]));
  db.prepare(`INSERT INTO refunds (bill_id, amount_cents, method, approved_by, created_by, created_at, cash_session_id)
    VALUES (?, 500, 'cash', 'owner-sess', 'cashier-sess', ?, ?)`).run(boundaryOrderId, boundaryMoment, firstBoundaryId);
  const firstBoundaryCash = sessionExpectedCash(db, { id: firstBoundaryId, opening_float_cents: 0 }, boundaryMoment);
  assert(firstBoundaryCash === 2500, 'same-second owned movement, partial payment, and refund net to 2500');
  const secondBoundaryCash = sessionExpectedCash(db, { id: secondBoundaryId, opening_float_cents: 0 }, boundaryMoment);
  assert(secondBoundaryCash === 0, 'adjacent session sharing the boundary second does not double-count');

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

  const cancelledSession = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(cancelledSession.status === 200, 'cancelled-guard session opens');
  const cancelledSessionId = cancelledSession.body?.id;
  const cancelledMoment = past(600_000);
  db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-CANCELLED-SESS', 'cashier-sess', 'takeaway', 'cancelled', 50, 50, ?, ?, NULL)`)
    .run(cancelledMoment, cancelledMoment);
  const cancelledOrderId = Number((db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-CANCELLED-SESS'`).get() as any).id);
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('CANCELLED-SESS', ?, 50, 50, 0, 0, 'unpaid', '[]', NULL, ?, ?)`)
    .run(cancelledOrderId, cancelledMoment, cancelledMoment);
  db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(past(3600_000), cancelledSessionId);
  const cancelledClose = await request(app).post(`/api/cash-sessions/${cancelledSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(cancelledClose.status === 200, 'cancelled zero-balance bill does not block shift close');

  const activeStaleOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 100 });
  assert(activeStaleOpen.status === 200, 'active stale-candidate session opens (200)');
  const activeStaleId = activeStaleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(activeStaleId);
  db.prepare(`INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, created_at)
    VALUES (?, 'pay_in', 1000, 'recent activity', 'cashier-sess', datetime('now'))`).run(todayLocal);
  const activeStaleBlocked = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 200 });
  assert(activeStaleBlocked.status === 409, 'stale session with recent activity is not auto-closed (409)');
  const activeStaleRow = db.prepare('SELECT status FROM cash_sessions WHERE id = ?').get(activeStaleId) as any;
  assert(activeStaleRow?.status === 'open', 'stale session with recent activity remains open');
  const activeStaleClose = await request(app).post(`/api/cash-sessions/${activeStaleId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 1100 });
  assert(activeStaleClose.status === 200, 'active stale candidate closes normally after the guard test');
  db.prepare(`UPDATE cash_drawer_movements SET created_at = datetime('now', '-8 days')`).run();

  const paidBillStaleOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(paidBillStaleOpen.status === 200, 'paid-bill stale-candidate session opens (200)');
  const paidBillStaleId = paidBillStaleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(paidBillStaleId);
  const recentPaidBill = seedUnpaidBill('stale-paid');
  const recentPaid = await request(app).post(`/api/bills/${recentPaidBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 50 });
  assert(recentPaid.status === 200, 'recent paid bill settles for the stale guard test');
  const paidBillStaleBlocked = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 200 });
  assert(paidBillStaleBlocked.status === 409, 'stale session with a recent paid bill is not auto-closed (409)');
  const paidBillStaleRow = db.prepare('SELECT status FROM cash_sessions WHERE id = ?').get(paidBillStaleId) as any;
  assert(paidBillStaleRow?.status === 'open', 'stale session with a recent paid bill remains open');
  const paidBillStaleClose = await request(app).post(`/api/cash-sessions/${paidBillStaleId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 5000 });
  assert(paidBillStaleClose.status === 200, 'paid-bill stale candidate closes normally after the guard test');

  const oldActivity = past(8 * 86400_000);
  const backdateStoreActivity = () => {
    db.prepare('UPDATE bills SET paid_at = ? WHERE paid_at IS NOT NULL').run(oldActivity);
    db.prepare('UPDATE cash_drawer_movements SET created_at = ?').run(oldActivity);
    db.prepare('UPDATE refunds SET created_at = ?').run(oldActivity);
    const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL').all() as { id: number; payment_details: string }[];
    for (const row of rows) {
      const parsed = JSON.parse(row.payment_details);
      const lines = Array.isArray(parsed) ? parsed : [parsed];
      for (const line of lines) if (line && typeof line === 'object') line.timestamp = oldActivity;
      db.prepare('UPDATE bills SET payment_details = ? WHERE id = ?')
        .run(JSON.stringify(Array.isArray(parsed) ? lines : lines[0]), row.id);
    }
  };

  backdateStoreActivity();
  const partialStaleOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(partialStaleOpen.status === 200, 'partial-payment stale candidate opens');
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(partialStaleOpen.body?.id);
  const partialStaleBill = seedUnpaidBill('stale-partial');
  const partialStalePay = await request(app).post(`/api/bills/${partialStaleBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 20 });
  assert(partialStalePay.status === 200, 'stale candidate receives a recent partial cash payment');
  const partialStaleBlocked = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(partialStaleBlocked.status === 409, 'recent partial cash payment prevents stale auto-close');
  const partialStaleSettle = await request(app).post(`/api/bills/${partialStaleBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'cash', amount: 30 });
  assert(partialStaleSettle.status === 200, 'partial stale fixture settles before closing');
  const partialStaleClose = await request(app).post(`/api/cash-sessions/${partialStaleOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 5000 });
  assert(partialStaleClose.status === 200, 'partial stale fixture closes normally');

  backdateStoreActivity();
  const refundStaleOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(refundStaleOpen.status === 200, 'refund stale candidate opens');
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(refundStaleOpen.body?.id);
  const refundStaleBill = seedUnpaidBill('stale-refund');
  const refundStalePay = await request(app).post(`/api/bills/${refundStaleBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ method: 'card', amount: 50 });
  assert(refundStalePay.status === 200, 'refund stale fixture settles');
  backdateStoreActivity();
  const recentStaleRefund = await request(app).post('/api/refunds')
    .set('Authorization', `Bearer ${ownedOwnerToken}`)
    .send({ bill_id: refundStaleBill, amount: 10, method: 'cash', approver_id: 'owner-sess', override_pin: '1234' });
  assert(recentStaleRefund.status === 201, 'stale candidate receives a recent cash refund');
  const refundStaleBlocked = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(refundStaleBlocked.status === 409, 'recent cash refund prevents stale auto-close');
  const refundStaleClose = await request(app).post(`/api/cash-sessions/${refundStaleOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(refundStaleClose.status === 200, 'refund stale fixture closes normally');

  const staleOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 100 });
  assert(staleOpen.status === 200, 'stale-candidate session opens (200)');
  const staleId = staleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(staleId);
  // Store-wide inactivity is part of the stale rule.
  backdateStoreActivity();
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

  const otherCashierOpen = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashier2Token}`).send({ opening_float_cents: 0 });
  assert(otherCashierOpen.status === 200, 'second cashier opens a session (200)');
  const otherCashierClose = await request(app).post(`/api/cash-sessions/${otherCashierOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 0 });
  assert(otherCashierClose.status === 403, 'cashier cannot close another cashier session (403)');
  const otherCashierRow = db.prepare('SELECT status FROM cash_sessions WHERE id = ?').get(otherCashierOpen.body?.id) as any;
  assert(otherCashierRow?.status === 'open', 'rejected cross-cashier close leaves the session open');
  const otherCashierTidy = await request(app).post(`/api/cash-sessions/${otherCashierOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashier2Token}`).send({ counted_cash_cents: 0 });
  assert(otherCashierTidy.status === 200, 'owning cashier closes their own session (200)');

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
  const customSession = await request(app).post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`).send({ opening_float_cents: 0 });
  assert(customSession.status === 200, 'custom-cash session opens');
  const customSessionId = customSession.body?.id;
  const customBill = seedUnpaidBill('custom-cash');
  const customPay = await request(app).post(`/api/bills/${customBill}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ payments: [{ method: 'custom', payment_method_id: customId, amount: 50 }] });
  assert(customPay.status === 200, 'configured Cash tender settles with an open session');
  const customCurrent = await request(app).get('/api/cash-sessions/current')
    .set('Authorization', `Bearer ${cashierToken}`);
  assert(customCurrent.body?.expected_cash_cents === 5000, 'configured Cash tender is included in session expected cash');
  const customTidy = await request(app).post(`/api/cash-sessions/${customSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`).send({ counted_cash_cents: 5000 });
  assert(customTidy.status === 200, 'configured Cash fixture closes cleanly');
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
