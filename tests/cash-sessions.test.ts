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
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cash-sessions';

const express = require('express');
const expressRateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, getSettingValue, now } = require('../main/db');
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

function latestDiagnostic(db: any, reasonCode: string): any | null {
  const row = db
    .prepare('SELECT * FROM local_diagnostics WHERE event_code = ? ORDER BY id DESC LIMIT 1')
    .get(reasonCode) as any;
  if (!row) return null;
  let metadata = {};
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    /* malformed rows are not test evidence */
  }
  return { ...row, metadata };
}

async function waitForDiagnostic(
  db: any,
  reasonCode: string,
  matches: (metadata: any) => boolean,
): Promise<any | null> {
  const deadline = Date.now() + 3000;
  let row = latestDiagnostic(db, reasonCode);
  while ((!row || !matches(row.metadata)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    row = latestDiagnostic(db, reasonCode);
  }
  return row && matches(row.metadata) ? row : null;
}

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

const RealDate = global.Date;
const withFixedClock = async <T>(isoUtc: string, fn: () => Promise<T>): Promise<T> => {
  const fixedMs = RealDate.parse(isoUtc);
  class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedMs);
      } else {
        super(...(args as [any]));
      }
    }
    static now(): number {
      return fixedMs;
    }
  }
  global.Date = FixedDate as DateConstructor;
  try {
    return await fn();
  } finally {
    global.Date = RealDate;
  }
};

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
  const cols = (db.prepare(`PRAGMA table_info(cash_sessions)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert(cols.includes('opened_by'), 'cash_sessions has opened_by');
  assert(cols.includes('opened_at'), 'cash_sessions has opened_at');
  assert(cols.includes('opening_float_cents'), 'cash_sessions has opening_float_cents');
  assert(cols.includes('status'), 'cash_sessions has status');
  assert(cols.includes('closure_id'), 'cash_sessions has closure_id');
  const legacyOneOpen = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'cash_sessions_one_open'`)
    .get() as { sql: string } | undefined;
  assert(!legacyOneOpen, 'legacy global cash_sessions_one_open index is dropped by migration 120');
  const oneOpenPerUser = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'cash_sessions_one_open_per_user'`)
    .get() as { sql: string } | undefined;
  assert(
    !!oneOpenPerUser &&
      oneOpenPerUser.sql.includes('opened_by') &&
      oneOpenPerUser.sql.includes('WHERE'),
    'partial unique index allows one open session per user',
  );
  assert(getSettingValue('require_open_shift') === 'false', 'enforcement defaults to off');
  assert(getSettingValue('one_shift_per_staff') === 'false', 'per-staff shifts default to off');
  assert(getSettingValue('stale_session_days') === '7', 'stale threshold defaults to 7 days');
  const movementOwnershipCols = (
    db.prepare(`PRAGMA table_info(cash_drawer_movements)`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  assert(movementOwnershipCols.includes('cash_session_id'), 'movements carry cash_session_id');
  const refundOwnershipCols = (
    db.prepare(`PRAGMA table_info(refunds)`).all() as { name: string }[]
  ).map((c) => c.name);
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
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`,
    ).run(now());
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'INR', ?) ON CONFLICT(key) DO UPDATE SET value='INR', updated_at=excluded.updated_at`,
    ).run(now());
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'UTC', ?) ON CONFLICT(key) DO UPDATE SET value='UTC', updated_at=excluded.updated_at`,
    ).run(now());
    for (const [id, name, email, role] of [
      ['owner-sess', 'Owner', 'owner-sess@test.local', 'owner'],
      ['manager-sess', 'Manager', 'manager-sess@test.local', 'manager'],
      ['cashier-sess', 'Cashier', 'cashier-sess@test.local', 'cashier'],
      ['cashier2-sess', 'Cashier Two', 'cashier2-sess@test.local', 'cashier'],
      ['server-sess', 'Server', 'server-sess@test.local', 'server'],
    ] as const) {
      db.prepare(
        `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, name, email, bcrypt.hashSync('pw', 10), role, now(), now());
    }
    app = express();
    app.use(express.json());
    app.use(expressRateLimit({ windowMs: 60 * 1000, limit: 1000 }));
    app.use((req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer '))
        return res.status(401).json({ error: 'Authentication required' });
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

    const invalidOpen = await request(app)
      .post('/api/cash-sessions/open')
      .set('x-operation-id', '11111111-1111-4111-8111-111111111111')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ opening_float_cents: -1 });
    assert(
      invalidOpen.status === 400,
      'negative opening float remains a validation response (400)',
    );
    assert(
      invalidOpen.body?.reason_code === 'cash.session_rejected',
      'opening float rejection has a stable reason',
    );
    assert(
      invalidOpen.body?.operation === 'cash.session.open' &&
        invalidOpen.body?.stage === 'validation',
      'opening float rejection identifies the action and stage',
    );
    assert(
      invalidOpen.body?.classification === 'expected_rejection' &&
        invalidOpen.body?.outcome === 'not_applied',
      'opening float rejection records a non-applied expected outcome',
    );
    assert(
      invalidOpen.body?.display_code === 'opening_float_invalid',
      'opening float code comes from the guarded field',
    );
    assert(
      invalidOpen.body?.correlation_id === '11111111-1111-4111-8111-111111111111',
      'opening float rejection retains the action UUID',
    );
    const openDiagnostic = await waitForDiagnostic(
      db,
      'cash.session_rejected',
      (metadata) => metadata.display_code === 'opening_float_invalid',
    );
    assert(
      openDiagnostic?.metadata?.display_code === 'opening_float_invalid',
      'only the safe opening-float enum is stored locally',
    );
    assert(
      (db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions WHERE status = 'open'`).get() as any)
        .c === 0,
      'invalid opening float does not create a session',
    );

    const openRes = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ opening_float_cents: 5000 });
    assert(openRes.status === 200, 'cashier opens a session (200)');
    const sessionId = openRes.body?.id;
    assert(typeof sessionId === 'number', 'open returns a session id');

    const doubleOpen = await request(app)
      .post('/api/cash-sessions/open')
      .set('x-operation-id', '22222222-2222-4222-8222-222222222222')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ opening_float_cents: 100 });
    assert(doubleOpen.status === 409, 'second open while one is open is 409');
    assert(
      doubleOpen.body?.display_code === 'session_already_open',
      'second open records the active-session guard',
    );

    const serverOpen = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${serverToken}`)
      .send({ opening_float_cents: 100 });
    assert(serverOpen.status === 403, 'server role cannot open a session (403)');

    // One cash sale inside the session window: 100.00 cash. Timestamps sit
    // strictly inside the window: session windows are half-open
    // [opened_at, closed_at) like day bounds, so same-second fixtures would
    // fall outside.
    past = (msAgo: number) => ts(new Date(Date.now() - msAgo));
    db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(
      past(3600_000),
      sessionId,
    );
    const moment = past(1800_000);
    db.prepare(
      `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES ('ORD-SESS-1', 'cashier-sess', 'takeaway', 'completed', 100, 100, ?, ?, ?)`,
    ).run(moment, moment, moment);
    const orderId = Number(
      (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-SESS-1'`).get() as any).id,
    );
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES ('SESS-1', ?, 100, 100, 100, 0, 'paid', ?, ?, ?, ?)`,
    ).run(
      orderId,
      JSON.stringify([{ method: 'cash', amount: 100, timestamp: moment }]),
      moment,
      moment,
      moment,
    );

    const current = await request(app)
      .get('/api/cash-sessions/current')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(current.status === 200, 'current returns the open session (200)');
    assert(
      current.body?.expected_cash_cents === 15000,
      'live expected = float 5000 + cash sale 10000',
    );

    const closeRes = await request(app)
      .post(`/api/cash-sessions/${sessionId}/close`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ counted_cash_cents: 16000 });
    assert(closeRes.status === 200, 'cashier closes own session (200)');
    assert(closeRes.body?.variance_cents === 1000, 'variance = counted 16000 - expected 15000');
    const closure = db
      .prepare(`SELECT scope, z_number FROM cash_closures WHERE id = ?`)
      .get(closeRes.body?.closure_id) as any;
    assert(closure?.scope === 'session', 'close writes a scope=session closure row');
    assert(typeof closure?.z_number === 'number', 'session closure carries a Z number');
    const after = await request(app)
      .get('/api/cash-sessions/current')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(after.status === 200, 'no current session after close (200)');
    assert(after.body === null, 'current returns null when no shift is open');

    const completionOpen = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ opening_float_cents: 200 });
    assert(completionOpen.status === 200, 'completion fixture session opens');
    const responsePrototype = app.response;
    const originalJson = responsePrototype.json;
    let failCloseResponseOnce = true;
    responsePrototype.json = function (body: unknown) {
      if (failCloseResponseOnce) {
        failCloseResponseOnce = false;
        throw new Error('synthetic session close response failure');
      }
      return originalJson.call(this, body);
    };
    let completionClose: any;
    try {
      completionClose = await request(app)
        .post(`/api/cash-sessions/${completionOpen.body?.id}/close`)
        .set('x-operation-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ counted_cash_cents: 200 });
    } finally {
      responsePrototype.json = originalJson;
    }
    assert(completionClose.status === 500, 'post-commit close response failure remains visible');
    assert(
      completionClose.body?.reason_code === 'operation.completion_failed',
      'post-commit shift close uses the completion reason',
    );
    assert(
      completionClose.body?.operation === 'cash.session.close' &&
        completionClose.body?.outcome === 'applied',
      'post-commit shift close reports the proven applied outcome',
    );
    assert(
      (
        db
          .prepare('SELECT status FROM cash_sessions WHERE id = ?')
          .get(completionOpen.body?.id) as any
      )?.status === 'closed',
      'post-commit close failure leaves the session closed',
    );
    const closeDiagnostic = await waitForDiagnostic(
      db,
      'operation.completion_failed',
      (metadata) => metadata.operation === 'cash.session.close' && metadata.outcome === 'applied',
    );
    assert(
      closeDiagnostic?.metadata?.correlation_id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'local completion capture retains the operation UUID',
    );
  }

  // ── Section 3: enforcement (default off) ──────────────────────────────
  console.log('Section 3: enforcement gate, default off');
  const { billRoutes } = require('../main/routes/bills');
  const { cashClosureRoutes } = require('../main/routes/cash-closures');
  const { settingsRoutes } = require('../main/routes/settings');
  app.use('/api/bills', billRoutes);
  app.use('/api/cash-closures', cashClosureRoutes);
  app.use('/api/settings', settingsRoutes);
  assert(
    !!billRoutes && !!cashClosureRoutes && !!settingsRoutes,
    'bills + closures + settings routers mount',
  );
  const ownerSettingsToken = jwt.sign(
    { userId: 'owner-sess', email: 'owner-sess@test.local', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );

  function seedUnpaidBill(tag: string): number {
    const m = past(600_000);
    db.prepare(
      `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, 'cashier-sess', 'takeaway', 'pending', 50, 50, ?, ?, NULL)`,
    ).run(`ORD-ENF-${tag}`, m, m);
    const oid = Number(
      (db.prepare(`SELECT id FROM orders WHERE order_number = ?`).get(`ORD-ENF-${tag}`) as any).id,
    );
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, 50, 50, 0, 50, 'unpaid', '[]', NULL, ?, ?)`,
    ).run(`ENF-${tag}`, oid, m, m);
    return Number(
      (db.prepare(`SELECT id FROM bills WHERE bill_number = ?`).get(`ENF-${tag}`) as any).id,
    );
  }
  const todayLocal = new Date().toISOString().slice(0, 10);

  const billOff = seedUnpaidBill('off');
  const payOff = await request(app)
    .post(`/api/bills/${billOff}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50 });
  assert(payOff.status === 200, 'enforcement off: cash payment without a session works (200)');

  const unauthorizedShiftSetting = await request(app)
    .put('/api/settings/require_open_shift')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ value: 'true' });
  assert(
    unauthorizedShiftSetting.status === 403 && getSettingValue('require_open_shift') === 'false',
    'cashier cannot update require_open_shift via settings API (403)',
  );

  for (const invalidValue of ['yes', '1', '0', '', 1, 0, null, {}]) {
    const invalidShiftSetting = await request(app)
      .put('/api/settings/require_open_shift')
      .set('Authorization', `Bearer ${ownerSettingsToken}`)
      .send({ value: invalidValue });
    assert(
      invalidShiftSetting.status === 400 && getSettingValue('require_open_shift') === 'false',
      `owner PUT /api/settings/require_open_shift rejects invalid value ${JSON.stringify(invalidValue)} (400)`,
    );
  }

  const enableShiftBoolean = await request(app)
    .put('/api/settings/require_open_shift')
    .set('Authorization', `Bearer ${ownerSettingsToken}`)
    .send({ value: true });
  assert(
    enableShiftBoolean.status === 200 &&
      enableShiftBoolean.body?.setting?.value === 'true' &&
      getSettingValue('require_open_shift') === 'true',
    'owner PUT /api/settings/require_open_shift with boolean true stores "true" (200)',
  );

  const disableShiftBoolean = await request(app)
    .put('/api/settings/require_open_shift')
    .set('Authorization', `Bearer ${ownerSettingsToken}`)
    .send({ value: false });
  assert(
    disableShiftBoolean.status === 200 &&
      disableShiftBoolean.body?.setting?.value === 'false' &&
      getSettingValue('require_open_shift') === 'false',
    'owner PUT /api/settings/require_open_shift with boolean false stores "false" (200)',
  );

  const enableShiftString = await request(app)
    .put('/api/settings/require_open_shift')
    .set('Authorization', `Bearer ${ownerSettingsToken}`)
    .send({ value: 'true' });
  assert(
    enableShiftString.status === 200 &&
      enableShiftString.body?.setting?.value === 'true' &&
      getSettingValue('require_open_shift') === 'true',
    'owner PUT /api/settings/require_open_shift with "true" enables shift gate (200)',
  );
  const billOn = seedUnpaidBill('on');
  const payOn = await request(app)
    .post(`/api/bills/${billOn}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50 });
  assert(payOn.status === 409, 'enforcement on: cash payment without a session is 409');
  assert(/shift/i.test(String(payOn.body?.error || '')), '409 names the missing open shift');

  const billBatch = seedUnpaidBill('batch');
  const batchBlocked = await request(app)
    .post(`/api/bills/${billBatch}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      payments: [
        { method: 'card', amount: 25 },
        { method: 'cash', amount: 25 },
      ],
    });
  assert(
    batchBlocked.status === 409,
    'enforcement on: cash batch payment without a session is 409',
  );
  assert(
    /shift/i.test(String(batchBlocked.body?.error || '')),
    'batch 409 names the missing open shift',
  );
  const batchAfterBlocked = db
    .prepare('SELECT paid_amount, payment_status FROM bills WHERE id = ?')
    .get(billBatch) as any;
  assert(
    batchAfterBlocked?.paid_amount === 0 && batchAfterBlocked?.payment_status === 'unpaid',
    'blocked cash batch leaves the bill unpaid',
  );

  const billBatchCard = seedUnpaidBill('batch-card');
  const batchCard = await request(app)
    .post(`/api/bills/${billBatchCard}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ payments: [{ method: 'card', amount: 50 }] });
  assert(
    batchCard.status === 200,
    'enforcement on: card batch payment without a session works (200)',
  );

  const billCard = seedUnpaidBill('card');
  const cardOn = await request(app)
    .post(`/api/bills/${billCard}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'card', amount: 50 });
  assert(cardOn.status === 200, 'enforcement on: non-cash payment without a session works (200)');

  const billBatchCardUnusedCash = seedUnpaidBill('batch-card-unused-cash');
  const batchCardUnusedCash = await request(app)
    .post(`/api/bills/${billBatchCardUnusedCash}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      payments: [
        { method: 'card', amount: 50 },
        { method: 'cash', amount: 1 },
      ],
    });
  assert(
    batchCardUnusedCash.status === 200,
    'enforcement on: unapplied cash line does not require a shift',
  );
  const unusedCashDetails = db
    .prepare('SELECT payment_details FROM bills WHERE id = ?')
    .get(billBatchCardUnusedCash) as any;
  const recordedUnusedCashDetails = JSON.parse(unusedCashDetails?.payment_details || '[]');
  assert(
    recordedUnusedCashDetails.length === 1 && recordedUnusedCashDetails[0].method === 'card',
    'enforcement on: zero-applied cash line is not recorded as a tender',
  );

  const movBlocked = await request(app)
    .post('/api/cash-closures/movements')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      business_date: todayLocal,
      movement_type: 'pay_in',
      amount_cents: 1000,
      reason: 'test',
    });
  assert(movBlocked.status === 409, 'enforcement on: drawer movement without a session is 409');
  const disableShiftString = await request(app)
    .put('/api/settings/require_open_shift')
    .set('Authorization', `Bearer ${ownerSettingsToken}`)
    .send({ value: 'false' });
  assert(
    disableShiftString.status === 200 &&
      disableShiftString.body?.setting?.value === 'false' &&
      getSettingValue('require_open_shift') === 'false',
    'owner PUT /api/settings/require_open_shift with "false" disables shift gate (200)',
  );
  const payOnLate = await request(app)
    .post(`/api/bills/${billOn}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50 });
  assert(payOnLate.status === 200, 'blocked bill pays fine once enforcement is off (200)');
  const batchPaidLate = await request(app)
    .post(`/api/bills/${billBatch}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      payments: [
        { method: 'card', amount: 25 },
        { method: 'cash', amount: 25 },
      ],
    });
  assert(batchPaidLate.status === 200, 'blocked cash batch pays once enforcement is off (200)');

  const replaySession = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(replaySession.status === 200, 'replay-test session opens');
  const replaySessionId = replaySession.body?.id;
  const replayBill = seedUnpaidBill('replay');
  const replayFirst = await request(app)
    .post(`/api/bills/${replayBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50, transaction_id: 'shift-replay' });
  assert(replayFirst.status === 200, 'replay fixture payment is recorded while the shift is open');
  const replayClose = await request(app)
    .post(`/api/cash-sessions/${replaySessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 5000 });
  assert(replayClose.status === 200, 'replay-test shift closes');
  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  const replayRetry = await request(app)
    .post(`/api/bills/${replayBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50, transaction_id: 'shift-replay' });
  assert(replayRetry.status === 200, 'recorded cash payment replays after its shift closes');
  const replayPaid = db
    .prepare('SELECT paid_amount FROM bills WHERE id = ?')
    .get(replayBill) as any;
  assert(Number(replayPaid?.paid_amount) === 50, 'replay after shift close does not double-count');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();

  const ownedSession = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(ownedSession.status === 200, 'ownership-test session opens');
  const ownedSessionId = ownedSession.body?.id;
  const ownedMovement = await request(app)
    .post('/api/cash-closures/movements')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      business_date: todayLocal,
      movement_type: 'pay_in',
      amount_cents: 1000,
      reason: 'ownership',
    });
  assert(ownedMovement.status === 201, 'movement records with an open session');
  const ownedRow = db
    .prepare('SELECT cash_session_id FROM cash_drawer_movements WHERE id = ?')
    .get(ownedMovement.body?.movement?.id) as any;
  assert(
    Number(ownedRow?.cash_session_id) === Number(ownedSessionId),
    'movement stores the active session owner',
  );
  // An owned movement must appear in the immutable Z even when its coarse
  // timestamp lies outside the half-open window used by legacy rows.
  db.prepare(
    `UPDATE cash_drawer_movements SET created_at = '9999-12-31 00:00:00' WHERE id = ?`,
  ).run(ownedMovement.body?.movement?.id);
  const ownedTidy = await request(app)
    .post(`/api/cash-sessions/${ownedSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 1000 });
  assert(ownedTidy.status === 200, 'ownership-test session closes');
  const ownedZ = db
    .prepare(
      'SELECT expected_cash_cents, pay_in_cents, cash_movements_json FROM cash_closures WHERE id = ?',
    )
    .get(ownedTidy.body?.closure_id) as any;
  assert(
    ownedZ?.expected_cash_cents === 1000 && ownedZ?.pay_in_cents === 1000,
    'session Z movement total reconciles with owned expected cash',
  );
  assert(
    JSON.parse(ownedZ?.cash_movements_json || '[]').some(
      (movement: any) => movement.id === ownedMovement.body?.movement?.id,
    ),
    'session Z includes its owned movement line',
  );

  const sessionlessMovement = await request(app)
    .post('/api/cash-closures/movements')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      business_date: todayLocal,
      movement_type: 'pay_in',
      amount_cents: 700,
      reason: 'before shift',
    });
  assert(
    sessionlessMovement.status === 201,
    'cash movement is allowed without a shift when enforcement is off',
  );
  const afterMovementOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(afterMovementOpen.status === 200, 'shift opens after a sessionless movement');
  db.prepare('UPDATE cash_drawer_movements SET created_at = ? WHERE id = ?').run(
    afterMovementOpen.body?.opened_at,
    sessionlessMovement.body?.movement?.id,
  );
  const afterMovementCurrent = await request(app)
    .get('/api/cash-sessions/current')
    .set('Authorization', `Bearer ${cashierToken}`);
  assert(
    afterMovementCurrent.body?.expected_cash_cents === 0,
    'same-second cash movement recorded before a shift does not enter its expected cash',
  );
  const afterMovementClose = await request(app)
    .post(`/api/cash-sessions/${afterMovementOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(afterMovementClose.status === 200, 'sessionless-movement fixture closes');

  const { refundRoutes: lineRefundRoutes } = require('../main/routes/refunds');
  app.use('/api/refunds', lineRefundRoutes);
  const lineSession = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(lineSession.status === 200, 'line-ownership session opens');
  const lineSessionId = lineSession.body?.id;
  const ownedBill = seedUnpaidBill('owned-line');
  const ownedPay = await request(app)
    .post(`/api/bills/${ownedBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 20 });
  assert(ownedPay.status === 200, 'partial cash tender is accepted');
  const ownedDetails = JSON.parse(
    (db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(ownedBill) as any)
      .payment_details,
  );
  assert(
    Number(ownedDetails[ownedDetails.length - 1]?.cash_session_id) === Number(lineSessionId),
    'new payment line stores the active session owner',
  );
  assert(
    (db.prepare('SELECT paid_at FROM bills WHERE id = ?').get(ownedBill) as any).paid_at === null,
    'partial payment leaves paid_at unset',
  );
  db.prepare(`UPDATE users SET pin_hash = ? WHERE id = 'owner-sess'`).run(
    bcrypt.hashSync('1234', 10),
  );
  const ownedOwnerToken = jwt.sign(
    { userId: 'owner-sess', email: 'owner-sess@test.local', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const ownedRefundBill = seedUnpaidBill('owned-refund');
  const ownedRefundPay = await request(app)
    .post(`/api/bills/${ownedRefundBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50 });
  assert(ownedRefundPay.status === 200, 'refund fixture bill settles');
  const ownedRefundPayload = {
    bill_id: ownedRefundBill,
    amount: 10,
    method: 'cash',
    approver_id: 'owner-sess',
    override_pin: '1234',
  };
  const ownedRefund = await request(app)
    .post('/api/refunds')
    .set('Authorization', `Bearer ${ownedOwnerToken}`)
    .set('Idempotency-Key', 'cash-session-refund-replay')
    .send(ownedRefundPayload);
  assert(ownedRefund.status === 201, 'cash refund is created');
  const ownedRefundRow = db
    .prepare('SELECT cash_session_id FROM refunds WHERE id = ?')
    .get(ownedRefund.body?.refund?.id) as any;
  assert(
    Number(ownedRefundRow?.cash_session_id) === Number(lineSessionId),
    'new refund stores the active session owner',
  );
  const ownedSettle = await request(app)
    .post(`/api/bills/${ownedBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 30 });
  assert(ownedSettle.status === 200, 'partial fixture bill settles before cleanup');
  const lineTidy = await request(app)
    .post(`/api/cash-sessions/${lineSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 90 });
  assert(lineTidy.status === 200, 'line-ownership fixtures close cleanly');
  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  const refundReplay = await request(app)
    .post('/api/refunds')
    .set('Authorization', `Bearer ${ownedOwnerToken}`)
    .set('Idempotency-Key', 'cash-session-refund-replay')
    .send(ownedRefundPayload);
  assert(refundReplay.status === 201, 'recorded cash refund replays after its shift closes');
  const refundRows = db
    .prepare('SELECT COUNT(*) AS c FROM refunds WHERE bill_id = ?')
    .get(ownedRefundBill) as { c: number };
  assert(refundRows.c === 1, 'refund replay does not create a second refund');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();
  const ownedLineZ = db
    .prepare(
      'SELECT gross_collected_cents, refunded_cents, net_collected_cents, payment_methods_json FROM cash_closures WHERE id = ?',
    )
    .get(lineTidy.body?.closure_id) as any;
  assert(
    ownedLineZ?.gross_collected_cents === 10000 &&
      ownedLineZ?.refunded_cents === 1000 &&
      ownedLineZ?.net_collected_cents === 9000,
    'session Z sales and refunds match the cash events recorded during the shift',
  );
  assert(
    JSON.parse(ownedLineZ?.payment_methods_json || '[]').some(
      (method: any) => method.method.toLowerCase() === 'cash' && method.total_cents === 9000,
    ),
    'session Z payment method breakdown includes partial cash and its refund',
  );

  const { sessionExpectedCash } = require('../main/routes/cash-closures');
  assert(typeof sessionExpectedCash === 'function', 'session expected-cash helper exists');
  const boundaryMoment = '2020-01-01 12:00:00';
  const firstBoundary = db
    .prepare(
      `INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status, closed_at, closed_by)
    VALUES ('cashier-sess', 'Cashier', ?, 0, 'closed', ?, 'cashier-sess')`,
    )
    .run(boundaryMoment, boundaryMoment);
  const secondBoundary = db
    .prepare(
      `INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status, closed_at, closed_by)
    VALUES ('cashier-sess', 'Cashier', ?, 0, 'closed', ?, 'cashier-sess')`,
    )
    .run(boundaryMoment, boundaryMoment);
  const firstBoundaryId = Number(firstBoundary.lastInsertRowid);
  const secondBoundaryId = Number(secondBoundary.lastInsertRowid);
  db.prepare(
    `INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, created_at, cash_session_id)
    VALUES ('2020-01-01', 'pay_in', 1000, 'boundary', 'cashier-sess', ?, ?)`,
  ).run(boundaryMoment, firstBoundaryId);
  db.prepare(
    `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-BOUND-1', 'cashier-sess', 'takeaway', 'pending', 50, 50, '2019-12-31 12:00:00', '2019-12-31 12:00:00', NULL)`,
  ).run();
  const boundaryOrderId = Number(
    (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-BOUND-1'`).get() as any).id,
  );
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('BOUND-1', ?, 50, 50, 20, 30, 'partial', ?, NULL, '2019-12-31 12:00:00', '2019-12-31 12:00:00')`,
  ).run(
    boundaryOrderId,
    JSON.stringify([
      {
        method: 'cash',
        amount: 20,
        timestamp: boundaryMoment,
        cash_session_id: firstBoundaryId,
      },
    ]),
  );
  db.prepare(
    `INSERT INTO refunds (bill_id, amount_cents, method, approved_by, created_by, created_at, cash_session_id)
    VALUES (?, 500, 'cash', 'owner-sess', 'cashier-sess', ?, ?)`,
  ).run(boundaryOrderId, boundaryMoment, firstBoundaryId);
  const firstBoundaryCash = sessionExpectedCash(
    db,
    { id: firstBoundaryId, opening_float_cents: 0 },
    boundaryMoment,
  );
  assert(
    firstBoundaryCash === 2500,
    'same-second owned movement, partial payment, and refund net to 2500',
  );
  const secondBoundaryCash = sessionExpectedCash(
    db,
    { id: secondBoundaryId, opening_float_cents: 0 },
    boundaryMoment,
  );
  assert(
    secondBoundaryCash === 0,
    'adjacent session sharing the boundary second does not double-count',
  );

  // ── Section 4: close guards & carry-over handover ────────────────────
  console.log('Section 4: unpaid-bills carry-over preview + stale auto-close');
  const guardOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(guardOpen.status === 200, 'guard session opens (200)');
  const guardId = guardOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(past(3600_000), guardId);
  const guardBill = seedUnpaidBill('guard');
  const closePreview = await request(app)
    .get('/api/cash-sessions/current/close-preview')
    .set('Authorization', `Bearer ${cashierToken}`);
  assert(closePreview.status === 200, 'close-preview returns 200');
  assert(
    closePreview.body?.unpaid_in_shift?.count === 1 &&
      closePreview.body?.unpaid_in_shift?.bill_count === 1,
    'close-preview counts unpaid bill in shift window',
  );
  assert(
    closePreview.body?.unpaid_in_shift?.pending_cents === 5000,
    'close-preview sums pending balance in cents',
  );
  assert(
    Array.isArray(closePreview.body?.unpaid_in_shift?.sample) &&
      closePreview.body.unpaid_in_shift.sample.length === 1,
    'close-preview includes sample of unpaid orders in shift window',
  );
  assert(
    closePreview.body?.would_block_close === false,
    'close-preview reports would_block_close: false (carry-over is non-blocking)',
  );
  const nonBlockingClose = await request(app)
    .post(`/api/cash-sessions/${guardId}/close`)
    .set('x-operation-id', '33333333-3333-4333-8333-333333333333')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(
    nonBlockingClose.status === 200,
    'close with an unpaid bill in-window succeeds (200) and carries bill over',
  );
  const guardBillStillUnpaid = db
    .prepare(`SELECT payment_status, balance FROM bills WHERE id = ?`)
    .get(guardBill) as { payment_status: string; balance: number };
  assert(
    guardBillStillUnpaid?.payment_status === 'unpaid' && guardBillStillUnpaid?.balance === 50,
    'carried-over bill remains unpaid with full balance after shift close',
  );

  const cancelledSession = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(cancelledSession.status === 200, 'next shift opens after carry-over');
  const cancelledSessionId = cancelledSession.body?.id;
  const payGuard = await request(app)
    .post(`/api/bills/${guardBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50 });
  assert(payGuard.status === 200, 'carried-over unpaid bill settles in the next shift (200)');
  const settledGuardBill = db
    .prepare(`SELECT payment_status, payment_details FROM bills WHERE id = ?`)
    .get(guardBill) as { payment_status: string; payment_details: string };
  assert(
    settledGuardBill?.payment_status === 'paid' &&
      JSON.parse(settledGuardBill.payment_details || '[]')[0]?.cash_session_id ===
        Number(cancelledSessionId),
    'settled carry-over bill records cash_session_id of the shift that collected the payment',
  );
  const cancelledMoment = past(600_000);
  db.prepare(
    `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-CANCELLED-SESS', 'cashier-sess', 'takeaway', 'cancelled', 50, 50, ?, ?, NULL)`,
  ).run(cancelledMoment, cancelledMoment);
  const cancelledOrderId = Number(
    (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-CANCELLED-SESS'`).get() as any).id,
  );
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('CANCELLED-SESS', ?, 50, 50, 0, 0, 'unpaid', '[]', NULL, ?, ?)`,
  ).run(cancelledOrderId, cancelledMoment, cancelledMoment);
  db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(
    past(3600_000),
    cancelledSessionId,
  );
  const cancelledClose = await request(app)
    .post(`/api/cash-sessions/${cancelledSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 5000 });
  assert(cancelledClose.status === 200, 'cancelled zero-balance bill does not block shift close');

  // Closing-second boundary: partial tender stays in Shift 1 drawer while open balance carries over
  const tShift1OpenIso = '2026-06-20T08:00:00.000Z';
  const tClose = '2026-06-20 12:00:00';
  const tCloseIso = '2026-06-20T12:00:00.000Z';
  const tShift2OpenIso = '2026-06-20T12:00:01.000Z';
  const tShift2CloseIso = '2026-06-20T13:00:00.000Z';

  let shift1Id: number = 0;
  await withFixedClock(tShift1OpenIso, async () => {
    const res = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ opening_float_cents: 0 });
    assert(res.status === 200, 'closing-second test shift 1 opens (200)');
    shift1Id = Number(res.body?.id);
  });

  db.prepare(
    `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-GUARD-SAME', 'cashier-sess', 'takeaway', 'pending', 50, 50, ?, ?)`,
  ).run(tClose, tClose);
  const sameOrderId = Number(
    (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-GUARD-SAME'`).get() as any).id,
  );
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
    VALUES ('BILL-GUARD-SAME', ?, 50, 50, 20, 30, 'partial', ?, ?, ?)`,
  ).run(
    sameOrderId,
    JSON.stringify([
      {
        method: 'cash',
        amount: 20,
        timestamp: tClose,
        cash_session_id: shift1Id,
      },
    ]),
    tClose,
    tClose,
  );

  db.prepare(
    `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-GUARD-CANCELLED', 'cashier-sess', 'takeaway', 'cancelled', 50, 50, ?, ?)`,
  ).run(tClose, tClose);
  const cancelOrderId = Number(
    (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-GUARD-CANCELLED'`).get() as any)
      .id,
  );
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
    VALUES ('BILL-GUARD-CANCELLED', ?, 50, 50, 0, 50, 'unpaid', '[]', ?, ?)`,
  ).run(cancelOrderId, tClose, tClose);

  await withFixedClock(tCloseIso, async () => {
    const previewRes = await request(app)
      .get('/api/cash-sessions/current/close-preview')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(previewRes.status === 200, 'closing-second close-preview returns 200');
    assert(
      previewRes.body?.unpaid_in_shift?.count === 1,
      'closing-second close-preview includes same-second partial order and excludes cancelled order',
    );
    assert(
      previewRes.body?.would_block_close === false,
      'closing-second close-preview reports would_block_close: false',
    );

    const res = await request(app)
      .post(`/api/cash-sessions/${shift1Id}/close`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ counted_cash_cents: 2000 });
    assert(
      res.status === 200,
      'same-second partial bill and cancelled order do not block shift close (200)',
    );
    assert(
      res.body?.expected_cash_cents === 2000,
      'same-second partial cash tender is included once in shift 1 expected cash',
    );
  });

  // Boundary second: opening and closing Shift 2 excludes prior shift tender.
  let shift2Id: number = 0;
  await withFixedClock(tShift2OpenIso, async () => {
    const res = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ opening_float_cents: 0 });
    assert(res.status === 200, 'shift 2 opens at boundary second (200)');
    shift2Id = Number(res.body?.id);
  });

  await withFixedClock(tShift2CloseIso, async () => {
    const res = await request(app)
      .post(`/api/cash-sessions/${shift2Id}/close`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ counted_cash_cents: 0 });
    assert(res.status === 200, 'shift 2 closes cleanly (200)');
    assert(
      res.body?.expected_cash_cents === 0,
      'shift 2 does not double-count shift 1 tender (expected_cash_cents === 0)',
    );
  });

  // Cleanup test records
  db.prepare(
    `DELETE FROM bills WHERE bill_number IN ('BILL-GUARD-SAME', 'BILL-GUARD-CANCELLED')`,
  ).run();
  db.prepare(
    `DELETE FROM orders WHERE order_number IN ('ORD-GUARD-SAME', 'ORD-GUARD-CANCELLED')`,
  ).run();

  const activeStaleOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 100 });
  assert(activeStaleOpen.status === 200, 'active stale-candidate session opens (200)');
  const activeStaleId = activeStaleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(
    activeStaleId,
  );
  db.prepare(
    `INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, created_at)
    VALUES (?, 'pay_in', 1000, 'recent activity', 'cashier-sess', datetime('now'))`,
  ).run(todayLocal);
  const activeStaleBlocked = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 200 });
  assert(
    activeStaleBlocked.status === 409,
    'stale session with recent activity is not auto-closed (409)',
  );
  const activeStaleRow = db
    .prepare('SELECT status FROM cash_sessions WHERE id = ?')
    .get(activeStaleId) as any;
  assert(activeStaleRow?.status === 'open', 'stale session with recent activity remains open');
  const activeStaleClose = await request(app)
    .post(`/api/cash-sessions/${activeStaleId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 1100 });
  assert(
    activeStaleClose.status === 200,
    'active stale candidate closes normally after the guard test',
  );
  db.prepare(`UPDATE cash_drawer_movements SET created_at = datetime('now', '-8 days')`).run();

  const paidBillStaleOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(paidBillStaleOpen.status === 200, 'paid-bill stale-candidate session opens (200)');
  const paidBillStaleId = paidBillStaleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(
    paidBillStaleId,
  );
  const recentPaidBill = seedUnpaidBill('stale-paid');
  const recentPaid = await request(app)
    .post(`/api/bills/${recentPaidBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 50 });
  assert(recentPaid.status === 200, 'recent paid bill settles for the stale guard test');
  const paidBillStaleBlocked = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 200 });
  assert(
    paidBillStaleBlocked.status === 409,
    'stale session with a recent paid bill is not auto-closed (409)',
  );
  const paidBillStaleRow = db
    .prepare('SELECT status FROM cash_sessions WHERE id = ?')
    .get(paidBillStaleId) as any;
  assert(paidBillStaleRow?.status === 'open', 'stale session with a recent paid bill remains open');
  const paidBillStaleClose = await request(app)
    .post(`/api/cash-sessions/${paidBillStaleId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 5000 });
  assert(
    paidBillStaleClose.status === 200,
    'paid-bill stale candidate closes normally after the guard test',
  );

  const oldActivity = past(8 * 86400_000);
  const backdateStoreActivity = () => {
    db.prepare('UPDATE bills SET paid_at = ? WHERE paid_at IS NOT NULL').run(oldActivity);
    db.prepare('UPDATE cash_drawer_movements SET created_at = ?').run(oldActivity);
    db.prepare('UPDATE refunds SET created_at = ?').run(oldActivity);
    const rows = db
      .prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL')
      .all() as { id: number; payment_details: string }[];
    for (const row of rows) {
      const parsed = JSON.parse(row.payment_details);
      const lines = Array.isArray(parsed) ? parsed : [parsed];
      for (const line of lines) if (line && typeof line === 'object') line.timestamp = oldActivity;
      db.prepare('UPDATE bills SET payment_details = ? WHERE id = ?').run(
        JSON.stringify(Array.isArray(parsed) ? lines : lines[0]),
        row.id,
      );
    }
  };

  backdateStoreActivity();
  const partialStaleOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(partialStaleOpen.status === 200, 'partial-payment stale candidate opens');
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(
    partialStaleOpen.body?.id,
  );
  const partialStaleBill = seedUnpaidBill('stale-partial');
  const partialStalePay = await request(app)
    .post(`/api/bills/${partialStaleBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 20 });
  assert(partialStalePay.status === 200, 'stale candidate receives a recent partial cash payment');
  const partialStaleBlocked = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(
    partialStaleBlocked.status === 409,
    'recent partial cash payment prevents stale auto-close',
  );
  const partialStaleSettle = await request(app)
    .post(`/api/bills/${partialStaleBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 30 });
  assert(partialStaleSettle.status === 200, 'partial stale fixture settles before closing');
  const partialStaleClose = await request(app)
    .post(`/api/cash-sessions/${partialStaleOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 5000 });
  assert(partialStaleClose.status === 200, 'partial stale fixture closes normally');

  backdateStoreActivity();
  const refundStaleOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(refundStaleOpen.status === 200, 'refund stale candidate opens');
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(
    refundStaleOpen.body?.id,
  );
  const refundStaleBill = seedUnpaidBill('stale-refund');
  const refundStalePay = await request(app)
    .post(`/api/bills/${refundStaleBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'card', amount: 50 });
  assert(refundStalePay.status === 200, 'refund stale fixture settles');
  backdateStoreActivity();
  const recentStaleRefund = await request(app)
    .post('/api/refunds')
    .set('Authorization', `Bearer ${ownedOwnerToken}`)
    .send({
      bill_id: refundStaleBill,
      amount: 10,
      method: 'cash',
      approver_id: 'owner-sess',
      override_pin: '1234',
    });
  assert(recentStaleRefund.status === 201, 'stale candidate receives a recent cash refund');
  const refundStaleBlocked = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(refundStaleBlocked.status === 409, 'recent cash refund prevents stale auto-close');
  const refundStaleClose = await request(app)
    .post(`/api/cash-sessions/${refundStaleOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(refundStaleClose.status === 200, 'refund stale fixture closes normally');

  const staleOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 100 });
  assert(staleOpen.status === 200, 'stale-candidate session opens (200)');
  const staleId = staleOpen.body?.id;
  db.prepare(`UPDATE cash_sessions SET opened_at = datetime('now', '-8 days') WHERE id = ?`).run(
    staleId,
  );
  // Store-wide inactivity is part of the stale rule.
  backdateStoreActivity();
  const freshOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 200 });
  assert(freshOpen.status === 200, 'new open auto-closes the stale session (200)');
  const staleRow = db
    .prepare(`SELECT status, closed_by, closure_id FROM cash_sessions WHERE id = ?`)
    .get(staleId) as any;
  assert(staleRow?.status === 'closed', 'stale session marked closed');
  const staleClosure = db
    .prepare(`SELECT counted_cash_cents, notes FROM cash_closures WHERE id = ?`)
    .get(staleRow?.closure_id) as any;
  assert(staleClosure?.counted_cash_cents === 0, 'stale auto-close records zero count');
  assert(
    /review/i.test(String(staleClosure?.notes || '')),
    'stale auto-close flagged for manager review',
  );
  const tidyClose = await request(app)
    .post(`/api/cash-sessions/${freshOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 200 });
  assert(tidyClose.status === 200, 'section-4 fresh session closed to leave a clean slate (200)');

  // ── Section 5: roles ────────────────────────────────────────────────
  console.log('Section 5: capabilities + force-close');
  const { PERMISSION_CAPABILITIES, ROLE_ACCESS } = require('../shared/role-permissions');
  const shiftOpen = PERMISSION_CAPABILITIES.find((c: any) => c.id === 'shiftOpen');
  const shiftClose = PERMISSION_CAPABILITIES.find((c: any) => c.id === 'shiftClose');
  assert(!!shiftOpen && !!shiftClose, 'shiftOpen/shiftClose capabilities exist');
  assert(
    !!shiftOpen &&
      [...shiftOpen.allowedRoles].sort().join(',') ===
        [...ROLE_ACCESS.ownerManagerCashier].sort().join(','),
    'shift capabilities allow owner/manager/cashier',
  );

  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('chef-sess', 'Chef', 'chef-sess@test.local', ?, 'chef', 1, ?, ?)`,
  ).run(bcrypt.hashSync('pw', 10), now(), now());
  const managerToken = jwt.sign(
    {
      userId: 'manager-sess',
      email: 'manager-sess@test.local',
      role: 'manager',
    },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const chefToken = jwt.sign(
    { userId: 'chef-sess', email: 'chef-sess@test.local', role: 'chef' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const mcOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(mcOpen.status === 200, 'cashier opens for force-close test (200)');
  const forceClose = await request(app)
    .post(`/api/cash-sessions/${mcOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ counted_cash_cents: 0 });
  assert(forceClose.status === 200, 'manager force-closes another shift (200)');
  const forced = db
    .prepare(`SELECT status, closed_by FROM cash_sessions WHERE id = ?`)
    .get(mcOpen.body?.id) as any;
  assert(
    forced?.status === 'closed' && forced?.closed_by === 'manager-sess',
    'force-close records the manager',
  );

  const otherCashierOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashier2Token}`)
    .send({ opening_float_cents: 0 });
  assert(otherCashierOpen.status === 200, 'second cashier opens a session (200)');
  const otherCashierClose = await request(app)
    .post(`/api/cash-sessions/${otherCashierOpen.body?.id}/close`)
    .set('x-operation-id', '44444444-4444-4444-8444-444444444444')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(otherCashierClose.status === 403, 'cashier cannot close another cashier session (403)');
  assert(
    otherCashierClose.body?.display_code === 'session_owner_required',
    'the cashier ownership guard receives a safe action code',
  );
  assert(
    otherCashierClose.body?.correlation_id === '44444444-4444-4444-8444-444444444444',
    'the owner-guard diagnostic retains the action UUID',
  );
  const otherCashierRow = db
    .prepare('SELECT status FROM cash_sessions WHERE id = ?')
    .get(otherCashierOpen.body?.id) as any;
  assert(
    otherCashierRow?.status === 'open',
    'rejected cross-cashier close leaves the session open',
  );
  const otherCashierTidy = await request(app)
    .post(`/api/cash-sessions/${otherCashierOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashier2Token}`)
    .send({ counted_cash_cents: 0 });
  assert(otherCashierTidy.status === 200, 'owning cashier closes their own session (200)');

  const chefCurrent = await request(app)
    .get('/api/cash-sessions/current')
    .set('Authorization', `Bearer ${chefToken}`);
  assert(chefCurrent.status === 403, 'chef cannot read sessions (403)');

  // ── Section 6: session Z print gate ───────────────────────────────────
  console.log('Section 6: session print gate');
  db.prepare(`DELETE FROM printers`).run();
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    'printer-default',
    'Default Test Printer',
    'network',
    '127.0.0.1',
    9100,
    '80mm',
    now(),
    now(),
  );
  const ownerToken = jwt.sign(
    { userId: 'owner-sess', email: 'owner-sess@test.local', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const prOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(prOpen.status === 200, 'print-test session opens (200)');
  const prClose = await request(app)
    .post(`/api/cash-sessions/${prOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(prClose.status === 200, 'print-test session closes (200)');
  const cashierPrint = await request(app)
    .post(`/api/cash-closures/${prClose.body?.closure_id}/print`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ isReprint: false });
  assert(cashierPrint.status !== 403, 'cashier may print own session Z (not 403)');
  const dayClose = await request(app)
    .post('/api/cash-closures')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      business_date: todayLocal,
      opening_float_cents: 5000,
      counted_cash_cents: 5000,
    });
  assert(dayClose.status === 201, 'owner day-close for gate test (201)');
  const managerDayPrint = await request(app)
    .post(`/api/cash-closures/${dayClose.body?.zReport?.id}/print`)
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ isReprint: false });
  assert(managerDayPrint.status === 403, 'manager cannot print day-close Z (403)');
  db.prepare(`DELETE FROM cash_closures WHERE id = ?`).run(dayClose.body?.zReport?.id);

  console.log('Section 6b: open shift blocks day close on same business date');
  const shiftForDay = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(shiftForDay.status === 200, 'shift opens for day-close guard test');
  const blockedDayClose = await request(app)
    .post('/api/cash-closures')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      business_date: todayLocal,
      opening_float_cents: 0,
      counted_cash_cents: 0,
    });
  assert(
    blockedDayClose.status === 409,
    `day close blocked while shift open (409, got ${blockedDayClose.status})`,
  );
  assert(
    blockedDayClose.body?.display_code === 'open_shift_blocks_day_close',
    'day close rejection uses open_shift_blocks_day_close',
  );
  assert(
    Number(blockedDayClose.body?.blocking_shift?.id) === Number(shiftForDay.body?.id),
    'response includes blocking_shift id',
  );
  const shiftCloseForDay = await request(app)
    .post(`/api/cash-sessions/${shiftForDay.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(shiftCloseForDay.status === 200, 'shift closes so day close can proceed');
  const recordedOpeningFloat = Number(
    (
      db
        .prepare(
          `SELECT amount_cents FROM cash_drawer_movements
           WHERE business_date = ? AND movement_type = 'opening_float' AND voided_at IS NULL LIMIT 1`,
        )
        .get(todayLocal) as { amount_cents: number } | undefined
    )?.amount_cents ?? 0,
  );
  const allowedDayClose = await request(app)
    .post('/api/cash-closures')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      business_date: todayLocal,
      opening_float_cents: recordedOpeningFloat,
      counted_cash_cents: recordedOpeningFloat,
    });
  assert(
    allowedDayClose.status === 201,
    `day close allowed after shift closed (got ${allowedDayClose.status}, code=${allowedDayClose.body?.display_code})`,
  );
  db.prepare(`DELETE FROM cash_closures WHERE id = ?`).run(allowedDayClose.body?.zReport?.id);

  console.log('Section Phase-1 validation: multi-shift same day + pending order carry-over');
  const turnA = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 1000 });
  assert(turnA.status === 200, 'phase1: first shift opens');
  const closeTurnA = await request(app)
    .post(`/api/cash-sessions/${turnA.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 1000 });
  assert(closeTurnA.status === 200, 'phase1: first shift closes on same commercial day');
  const turnB = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(turnB.status === 200, 'phase1: second shift opens on same commercial day');
  const turnBId = Number(turnB.body?.id);
  const carryMoment = now();
  db.prepare(
    `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-CARRY-PH1', 'cashier-sess', 'takeaway', 'pending', 50, 50, ?, ?, NULL)`,
  ).run(carryMoment, carryMoment);
  const carryOrderId = Number(
    (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-CARRY-PH1'`).get() as any).id,
  );
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('CARRY-PH1', ?, 50, 50, 0, 50, 'unpaid', '[]', NULL, ?, ?)`,
  ).run(carryOrderId, carryMoment, carryMoment);
  const closeTurnB = await request(app)
    .post(`/api/cash-sessions/${turnBId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 0 });
  assert(
    closeTurnB.status === 200,
    'phase1: second shift closes while in-shift unpaid bill exists and carries over',
  );
  const carryOrder = db
    .prepare(`SELECT status FROM orders WHERE order_number = 'ORD-CARRY-PH1'`)
    .get() as { status: string };
  assert(carryOrder?.status === 'pending', 'phase1: pending order remains after shift turnover');
  const carryBill = db
    .prepare(`SELECT balance, payment_status FROM bills WHERE bill_number = 'CARRY-PH1'`)
    .get() as { balance: number; payment_status: string };
  assert(carryBill?.balance === 50, 'phase1: unpaid balance unchanged (no duplicate charge)');
  assert(carryBill?.payment_status === 'unpaid', 'phase1: bill still collectible on next shift');
  db.prepare(`DELETE FROM bills WHERE bill_number = 'CARRY-PH1'`).run();
  db.prepare(`DELETE FROM orders WHERE order_number = 'ORD-CARRY-PH1'`).run();

  // ── Section 7: round-2 review findings ────────────────────────────────
  console.log('Section 7: partial carry-over, case-insensitive gate, refund gate');
  const { refundRoutes } = require('../main/routes/refunds');
  app.use('/api/refunds', refundRoutes);
  assert(!!refundRoutes, 'refunds router mounts');

  const pOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(pOpen.status === 200, 'partial-guard session opens (200)');
  db.prepare(`UPDATE cash_sessions SET opened_at = ? WHERE id = ?`).run(
    past(3600_000),
    pOpen.body?.id,
  );
  // Partial bill: 50 total, 20 paid, 30 outstanding.
  const pm = past(1800_000);
  db.prepare(
    `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES ('ORD-PART-1', 'cashier-sess', 'takeaway', 'completed', 50, 50, ?, ?, ?)`,
  ).run(pm, pm, pm);
  const partOrderId = Number(
    (db.prepare(`SELECT id FROM orders WHERE order_number = 'ORD-PART-1'`).get() as any).id,
  );
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES ('PART-1', ?, 50, 50, 20, 30, 'partial', ?, ?, ?, ?)`,
  ).run(partOrderId, JSON.stringify([{ method: 'cash', amount: 20, timestamp: pm }]), pm, pm, pm);
  const partPreview = await request(app)
    .get('/api/cash-sessions/current/close-preview')
    .set('Authorization', `Bearer ${cashierToken}`);
  assert(
    partPreview.status === 200 &&
      partPreview.body?.unpaid_in_shift?.count === 1 &&
      partPreview.body?.unpaid_in_shift?.pending_cents === 3000 &&
      partPreview.body?.would_block_close === false,
    'close-preview surfaces partial bill carry-over without blocking close',
  );
  const partClose = await request(app)
    .post(`/api/cash-sessions/${pOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 2000 });
  assert(
    partClose.status === 200 && partClose.body?.expected_cash_cents === 2000,
    'close with a partial bill in-window succeeds (200) and reconciles the 20 cash collected',
  );
  const pOpenCarry = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(pOpenCarry.status === 200, 'follow-up session opens to settle carried-over partial bill');
  const partBillId = Number(
    (db.prepare(`SELECT id FROM bills WHERE bill_number = 'PART-1'`).get() as any).id,
  );
  const payPart = await request(app)
    .post(`/api/bills/${partBillId}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'cash', amount: 30 });
  assert(payPart.status === 200, 'partial bill settles in follow-up shift (200)');
  const closePart = await request(app)
    .post(`/api/cash-sessions/${pOpenCarry.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 3000 });
  assert(
    closePart.status === 200 && closePart.body?.expected_cash_cents === 3000,
    'follow-up shift closes cleanly with remaining 30 cash collected (200)',
  );

  // Case-insensitive gate: custom method named "Cash" is still cash.
  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
  // Case-insensitive gate: custom method named "Cash" is still cash.
  db.prepare(
    `INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES ('Cash', 1, 10, ?, ?)`,
  ).run(now(), now());
  const customId = Number(
    (db.prepare(`SELECT id FROM payment_methods WHERE name = 'Cash'`).get() as any).id,
  );
  const ciBill = seedUnpaidBill('ci');
  const ciPay = await request(app)
    .post(`/api/bills/${ciBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'Cash', amount: 50 });
  assert(ciPay.status === 409, 'enforcement on: "Cash" (capitalized) without a session is 409');

  // Cash refunds leave the drawer: gated like cash payments. The gate fires
  // before PIN verification, so no PIN fixture is needed for the 409 path.
  const rfPay = await request(app)
    .post(`/api/bills/${ciBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'card', amount: 50 });
  assert(rfPay.status === 200, 'card payment for refund fixture (200)');
  const rfBillId = ciBill;
  const rfBlocked = await request(app)
    .post('/api/refunds')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({
      bill_id: rfBillId,
      amount: 10,
      method: 'cash',
      approver_id: 'manager-sess',
    });
  assert(rfBlocked.status === 409, 'enforcement on: cash refund without a session is 409');
  assert(
    /shift/i.test(String(rfBlocked.body?.error || '')),
    'refund 409 names the missing open shift',
  );

  // Custom method resolving to cash is still cash (resolution-aware gate).
  const ciCustomBill = seedUnpaidBill('cicustom');
  const ciCustomPay = await request(app)
    .post(`/api/bills/${ciCustomBill}/payment`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ method: 'custom', payment_method_id: customId, amount: 50 });
  assert(
    ciCustomPay.status === 409,
    'enforcement on: custom "Cash" method without a session is 409',
  );
  const customSession = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 0 });
  assert(customSession.status === 200, 'custom-cash session opens');
  const customSessionId = customSession.body?.id;
  const customBill = seedUnpaidBill('custom-cash');
  const customPay = await request(app)
    .post(`/api/bills/${customBill}/payments`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({
      payments: [{ method: 'custom', payment_method_id: customId, amount: 50 }],
    });
  assert(customPay.status === 200, 'configured Cash tender settles with an open session');
  const customCurrent = await request(app)
    .get('/api/cash-sessions/current')
    .set('Authorization', `Bearer ${cashierToken}`);
  assert(
    customCurrent.body?.expected_cash_cents === 5000,
    'configured Cash tender is included in session expected cash',
  );
  const customTidy = await request(app)
    .post(`/api/cash-sessions/${customSessionId}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 5000 });
  assert(customTidy.status === 200, 'configured Cash fixture closes cleanly');
  db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();

  // ── Section 8: float mirror (day/session consistency) ───────────────
  console.log('Section 8: opening-float mirror');
  db.prepare(`DELETE FROM cash_drawer_movements WHERE movement_type = 'opening_float'`).run();
  const mOpen = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 7000 });
  assert(mOpen.status === 200, 'mirror-test session opens (200)');
  const mirrored = db
    .prepare(
      `SELECT amount_cents FROM cash_drawer_movements WHERE movement_type = 'opening_float' AND voided_at IS NULL`,
    )
    .all() as { amount_cents: number }[];
  assert(
    mirrored.length === 1 && mirrored[0].amount_cents === 7000,
    'open mirrors one float movement (creation path)',
  );
  const mClose = await request(app)
    .post(`/api/cash-sessions/${mOpen.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 7000 });
  assert(
    mClose.status === 200 && mClose.body?.variance_cents === 0,
    'session ignores the mirrored movement (no double count)',
  );
  const mOpen2 = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ opening_float_cents: 9000 });
  assert(mOpen2.status === 200, 'second float session opens (200)');
  const mirrored2 = db
    .prepare(
      `SELECT amount_cents FROM cash_drawer_movements WHERE movement_type = 'opening_float' AND voided_at IS NULL`,
    )
    .all() as { amount_cents: number }[];
  assert(mirrored2.length === 1, 'one movement per day: second open skips the mirror');
  const mClose2 = await request(app)
    .post(`/api/cash-sessions/${mOpen2.body?.id}/close`)
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ counted_cash_cents: 9000 });
  assert(
    mClose2.status === 200 && mClose2.body?.variance_cents === 0,
    'session uses its own float, not the movement',
  );

  // ── Section 9: closed business day blocks new shift open ─────────────
  console.log('Section 9: closed business day blocks new shift open');

  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'America/New_York', ?) ON CONFLICT(key) DO UPDATE SET value='America/New_York', updated_at=excluded.updated_at`,
  ).run(now());
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '04:00', ?) ON CONFLICT(key) DO UPDATE SET value='04:00', updated_at=excluded.updated_at`,
  ).run(now());

  try {
    // Seed closed adjacent calendar days (2026-06-13 and 2026-06-15) while
    // leaving the effective business date 2026-06-14 open.
    await withFixedClock('2026-06-15T12:00:00.000Z', async () => {
      const closePriorDay = await request(app)
        .post('/api/cash-closures')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          business_date: '2026-06-13',
          opening_float_cents: 0,
          counted_cash_cents: 0,
        });
      assert(closePriorDay.status === 201, 'owner closes prior business day 2026-06-13 (201)');
      const closeCalendarDay = await request(app)
        .post('/api/cash-closures')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          business_date: '2026-06-15',
          opening_float_cents: 0,
          counted_cash_cents: 0,
        });
      assert(
        closeCalendarDay.status === 201,
        'owner closes calendar date 2026-06-15 before boundary test (201)',
      );
    });

    // At 2026-06-15T06:30:00.000Z, local time in America/New_York (EDT, UTC-4)
    // is 2026-06-15 02:30:00: both UTC and local calendar dates are 2026-06-15,
    // but before the 04:00 business_day_start_time the effective business date
    // is 2026-06-14.
    await withFixedClock('2026-06-15T06:30:00.000Z', async () => {
      const openOnUnclosedEffectiveDay = await request(app)
        .post('/api/cash-sessions/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ opening_float_cents: 2500 });
      assert(
        openOnUnclosedEffectiveDay.status === 200,
        `closing calendar date 2026-06-15 does not block opening on effective business day 2026-06-14 (got ${openOnUnclosedEffectiveDay.status})`,
      );
      const effectiveDayFloat = db
        .prepare(
          `SELECT amount_cents FROM cash_drawer_movements WHERE business_date = '2026-06-14' AND movement_type = 'opening_float' AND voided_at IS NULL`,
        )
        .get() as { amount_cents: number } | undefined;
      assert(
        effectiveDayFloat?.amount_cents === 2500,
        'shift open before 04:00 local cutoff mirrors opening float onto effective business date 2026-06-14',
      );
      const closeEffectiveDayShift = await request(app)
        .post(`/api/cash-sessions/${openOnUnclosedEffectiveDay.body?.id}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ counted_cash_cents: 2500 });
      assert(
        closeEffectiveDayShift.status === 200,
        'shift on effective business day 2026-06-14 closes cleanly (200)',
      );

      const closedEffectiveDayRes = await request(app)
        .post('/api/cash-closures')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          business_date: '2026-06-14',
          opening_float_cents: 2500,
          counted_cash_cents: 2500,
        });
      assert(
        closedEffectiveDayRes.status === 201,
        'owner closes effective business day 2026-06-14 (201)',
      );

      const sessionsBefore = (
        db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions`).get() as {
          c: number;
        }
      ).c;
      const movementsBefore = (
        db.prepare(`SELECT COUNT(*) AS c FROM cash_drawer_movements`).get() as {
          c: number;
        }
      ).c;

      const closedDayPositiveFloatOpen = await request(app)
        .post('/api/cash-sessions/open')
        .set('x-operation-id', '55555555-5555-4555-8555-555555555555')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ opening_float_cents: 1000 });
      assert(
        closedDayPositiveFloatOpen.status === 409,
        `opening a shift with positive float on closed effective business day is 409 (got ${closedDayPositiveFloatOpen.status})`,
      );
      assert(
        closedDayPositiveFloatOpen.body?.display_code === 'day_already_closed',
        'positive-float shift open rejection uses day_already_closed',
      );
      assert(
        (db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions WHERE status = 'open'`).get() as any)
          .c === 0 &&
          (db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions`).get() as any).c === sessionsBefore,
        'rejected positive-float open on closed day creates no cash session',
      );
      assert(
        (db.prepare(`SELECT COUNT(*) AS c FROM cash_drawer_movements`).get() as any).c ===
          movementsBefore,
        'rejected positive-float open on closed day creates no drawer movement',
      );

      const closedDayZeroFloatOpen = await request(app)
        .post('/api/cash-sessions/open')
        .set('x-operation-id', '66666666-6666-4666-8666-666666666666')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ opening_float_cents: 0 });
      assert(
        closedDayZeroFloatOpen.status === 409,
        `opening a shift with zero float on closed effective business day is 409 (got ${closedDayZeroFloatOpen.status})`,
      );
      assert(
        closedDayZeroFloatOpen.body?.display_code === 'day_already_closed',
        'zero-float shift open rejection uses day_already_closed',
      );
      assert(
        (db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions WHERE status = 'open'`).get() as any)
          .c === 0 &&
          (db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions`).get() as any).c === sessionsBefore,
        'rejected zero-float open on closed day creates no cash session',
      );
      assert(
        (db.prepare(`SELECT COUNT(*) AS c FROM cash_drawer_movements`).get() as any).c ===
          movementsBefore,
        'rejected zero-float open on closed day creates no drawer movement',
      );
    });
  } finally {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'UTC', ?) ON CONFLICT(key) DO UPDATE SET value='UTC', updated_at=excluded.updated_at`,
    ).run(now());
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', ?) ON CONFLICT(key) DO UPDATE SET value='00:00', updated_at=excluded.updated_at`,
    ).run(now());
  }

  // ── Section 10: cross-midnight shift closure business date (#1360) ───
  console.log('Section 10: shift closure uses opening business date across midnight and cutoffs');
  {
    const { escPosToText } = require('../main/printers/thermal');
    const { computeDayAggregates } = require('../main/routes/cash-closures');
    const longLivedCashierToken = jwt.sign(
      {
        userId: 'cashier-sess',
        email: 'cashier-sess@test.local',
        role: 'cashier',
      },
      getJWTSecret(),
    );

    const setTenantTimeConfig = (tz: string, cutoff: string) => {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('timezone', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      ).run(tz, now());
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('business_day_start_time', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      ).run(cutoff, now());
    };

    const seedAndPayShiftBill = async (
      tag: string,
      method: 'cash' | 'card',
      amount: number,
      atIsoUtc: string,
    ) => {
      await withFixedClock(atIsoUtc, async () => {
        const moment = now();
        db.prepare(
          `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
           VALUES (?, 'cashier-sess', 'takeaway', 'pending', ?, ?, ?, ?, NULL)`,
        ).run(`ORD-1360-${tag}`, amount, amount, moment, moment);
        const oid = Number(
          (db.prepare(`SELECT id FROM orders WHERE order_number = ?`).get(`ORD-1360-${tag}`) as any)
            .id,
        );
        db.prepare(
          `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, 'unpaid', '[]', NULL, ?, ?)`,
        ).run(`BILL-1360-${tag}`, oid, amount, amount, amount, moment, moment);
        const bid = Number(
          (db.prepare(`SELECT id FROM bills WHERE bill_number = ?`).get(`BILL-1360-${tag}`) as any)
            .id,
        );
        const payRes = await request(app)
          .post(`/api/bills/${bid}/payment`)
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ method, amount });
        assert(
          payRes.status === 200,
          `#1360 (${tag}): ${method} payment of ${amount} succeeds (200)`,
        );
      });
    };

    try {
      // Configure a default WebUSB printer so POST /api/cash-closures/:id/print returns ESC/POS bytes.
      db.prepare(`DELETE FROM printers`).run();
      db.prepare(
        `INSERT INTO printers (id, name, connection_type, is_default, paper_width, created_at, updated_at)
         VALUES ('webusb-1360', 'WebUSB 1360 Printer', 'webusb', 1, '80mm', ?, ?)`,
      ).run(now(), now());

      // 1) Cross-midnight shift with $200 float, $31.64 cash, $9.32 card across UTC, Montevideo, and Sydney
      const crossMidnightZones = [
        {
          label: 'UTC',
          tz: 'UTC',
          openIso: '2026-10-25T22:00:00.000Z',
          preMidnightSaleIso: '2026-10-25T23:15:00.000Z',
          postMidnightSaleIso: '2026-10-26T00:15:00.000Z',
          closeIso: '2026-10-26T00:30:00.000Z',
          expectedOpenTs: '2026-10-25 22:00:00',
          expectedCloseTs: '2026-10-26 00:30:00',
        },
        {
          label: 'Montevideo',
          tz: 'America/Montevideo',
          openIso: '2026-10-26T01:00:00.000Z', // 2026-10-25 22:00:00 local (UTC-3)
          preMidnightSaleIso: '2026-10-26T02:15:00.000Z', // 2026-10-25 23:15:00 local
          postMidnightSaleIso: '2026-10-26T03:15:00.000Z', // 2026-10-26 00:15:00 local
          closeIso: '2026-10-26T03:30:00.000Z', // 2026-10-26 00:30:00 local
          expectedOpenTs: '2026-10-26 01:00:00',
          expectedCloseTs: '2026-10-26 03:30:00',
        },
        {
          label: 'Sydney',
          tz: 'Australia/Sydney',
          openIso: '2026-10-25T11:00:00.000Z', // 2026-10-25 22:00:00 local (AEDT, UTC+11)
          preMidnightSaleIso: '2026-10-25T12:15:00.000Z', // 2026-10-25 23:15:00 local
          postMidnightSaleIso: '2026-10-25T13:15:00.000Z', // 2026-10-26 00:15:00 local
          closeIso: '2026-10-25T13:30:00.000Z', // 2026-10-26 00:30:00 local
          expectedOpenTs: '2026-10-25 11:00:00',
          expectedCloseTs: '2026-10-25 13:30:00',
        },
      ];

      for (const zone of crossMidnightZones) {
        db.prepare(`DELETE FROM cash_drawer_movements WHERE movement_type = 'opening_float'`).run();
        setTenantTimeConfig(zone.tz, '00:00');
        const oct25GrossBefore = computeDayAggregates(db, '2026-10-25').grossCollectedCents;
        const oct26GrossBefore = computeDayAggregates(db, '2026-10-26').grossCollectedCents;

        let sessionId = 0;
        await withFixedClock(zone.openIso, async () => {
          const openRes = await request(app)
            .post('/api/cash-sessions/open')
            .set('Authorization', `Bearer ${longLivedCashierToken}`)
            .send({ opening_float_cents: 20000 });
          assert(openRes.status === 200, `#1360 (${zone.label}): shift opens on Oct 25 (200)`);
          sessionId = Number(openRes.body?.id);
        });

        const floatMovement = db
          .prepare(
            `SELECT business_date, amount_cents FROM cash_drawer_movements WHERE cash_session_id = ? AND movement_type = 'opening_float'`,
          )
          .get(sessionId) as { business_date: string; amount_cents: number } | undefined;
        assert(
          floatMovement?.business_date === '2026-10-25' && floatMovement?.amount_cents === 20000,
          `#1360 (${zone.label}): opening float movement is recorded on 2026-10-25 (20000 cents)`,
        );

        await seedAndPayShiftBill(`${zone.label}-card`, 'card', 9.32, zone.preMidnightSaleIso);
        await seedAndPayShiftBill(`${zone.label}-cash`, 'cash', 31.64, zone.postMidnightSaleIso);

        let closureId = 0;
        await withFixedClock(zone.closeIso, async () => {
          const closeRes = await request(app)
            .post(`/api/cash-sessions/${sessionId}/close`)
            .set('Authorization', `Bearer ${longLivedCashierToken}`)
            .send({ counted_cash_cents: 23164 });
          assert(closeRes.status === 200, `#1360 (${zone.label}): shift closes at 00:30 Oct 26`);
          assert(
            closeRes.body?.expected_cash_cents === 23164 && closeRes.body?.variance_cents === 0,
            `#1360 (${zone.label}): expected cash reconciles at 23164 cents ($231.64) with zero variance`,
          );
          closureId = Number(closeRes.body?.closure_id);
        });

        const sessionRow = db
          .prepare(`SELECT opened_at, closed_at, status FROM cash_sessions WHERE id = ?`)
          .get(sessionId) as {
          opened_at: string;
          closed_at: string;
          status: string;
        };
        const closureRow = db
          .prepare(
            `SELECT scope, business_date, period_start, period_end, opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents, gross_collected_cents, net_collected_cents, bill_count, z_number FROM cash_closures WHERE id = ?`,
          )
          .get(closureId) as any;

        assert(
          closureRow?.scope === 'session' && closureRow?.business_date === '2026-10-25',
          `#1360 (${zone.label}): cross-midnight session closure retains opening business_date 2026-10-25 (got ${closureRow?.business_date})`,
        );
        assert(
          sessionRow?.opened_at === zone.expectedOpenTs &&
            sessionRow?.closed_at === zone.expectedCloseTs &&
            closureRow?.period_start === zone.expectedOpenTs &&
            closureRow?.period_end === zone.expectedCloseTs,
          `#1360 (${zone.label}): actual opened_at, closed_at, period_start, and period_end timestamps remain accurate`,
        );
        assert(
          closureRow?.opening_float_cents === 20000 &&
            closureRow?.expected_cash_cents === 23164 &&
            closureRow?.counted_cash_cents === 23164 &&
            closureRow?.variance_cents === 0 &&
            closureRow?.gross_collected_cents === 4096 &&
            closureRow?.net_collected_cents === 4096 &&
            closureRow?.bill_count === 2,
          `#1360 (${zone.label}): closure financial totals ($200 float, $31.64 post-midnight cash, $9.32 card) reconcile`,
        );

        if (zone.label === 'UTC') {
          // Daily sales attribution remains anchored to each business day's [start, end) window.
          const oct25Day = computeDayAggregates(db, '2026-10-25');
          const oct26Day = computeDayAggregates(db, '2026-10-26');
          assert(
            oct25Day.grossCollectedCents - oct25GrossBefore === 932 &&
              oct26Day.grossCollectedCents - oct26GrossBefore === 3164,
            '#1360 (UTC): daily reporting boundaries remain unchanged (pre-midnight sale on Oct 25, post-midnight sale on Oct 26)',
          );

          // Print at close time and reprint days later via WebUSB.
          await withFixedClock(zone.closeIso, async () => {
            const printRes = await request(app)
              .post(`/api/cash-closures/${closureId}/print`)
              .set('Authorization', `Bearer ${longLivedCashierToken}`)
              .send({ isReprint: false });
            assert(
              printRes.status === 200 &&
                printRes.body?.webusb === true &&
                printRes.body?.isReprint === false &&
                Array.isArray(printRes.body?.bytes),
              '#1360 (UTC): POST /api/cash-closures/:id/print returns WebUSB bytes (200)',
            );
            const printedText = escPosToText(Buffer.from(printRes.body?.bytes || []));
            assert(
              printedText.includes('2026-10-25') &&
                printedText.includes(`Z#${closureRow.z_number} - 2026-10-25`) &&
                !printedText.includes(`Z#${closureRow.z_number} - 2026-10-26`),
              '#1360 (UTC): printed Z bytes carry opening business date 2026-10-25',
            );
          });

          await withFixedClock('2026-10-28T14:00:00.000Z', async () => {
            const reprintRes = await request(app)
              .post(`/api/cash-closures/${closureId}/print`)
              .set('Authorization', `Bearer ${longLivedCashierToken}`)
              .send({ isReprint: true });
            assert(
              reprintRes.status === 200 &&
                reprintRes.body?.webusb === true &&
                reprintRes.body?.isReprint === true &&
                Array.isArray(reprintRes.body?.bytes),
              '#1360 (UTC): later reprint returns WebUSB bytes (200)',
            );
            const reprintedText = escPosToText(Buffer.from(reprintRes.body?.bytes || []));
            assert(
              reprintedText.includes('REPRINT') &&
                reprintedText.includes(`Z#${closureRow.z_number} - 2026-10-25`),
              '#1360 (UTC): later reprint preserves stored opening business date 2026-10-25',
            );
            const afterReprintRow = db
              .prepare(`SELECT business_date FROM cash_closures WHERE id = ?`)
              .get(closureId) as { business_date: string };
            assert(
              afterReprintRow?.business_date === '2026-10-25',
              '#1360 (UTC): stored closure business_date is untouched after reprint',
            );
          });
        }

        db.prepare(`DELETE FROM bills WHERE bill_number LIKE ?`).run(`BILL-1360-${zone.label}-%`);
        db.prepare(`DELETE FROM orders WHERE order_number LIKE ?`).run(`ORD-1360-${zone.label}-%`);
      }

      // 2) 04:00 business_day_start_time cutoff: open Oct 26 at 02:00, close at 05:00 -> 2026-10-25
      setTenantTimeConfig('UTC', '04:00');
      let cutoffSessionId = 0;
      await withFixedClock('2026-10-26T02:00:00.000Z', async () => {
        const openRes = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ opening_float_cents: 5000 });
        assert(openRes.status === 200, '#1360 (04:00 cutoff): shift opens at 02:00 (200)');
        cutoffSessionId = Number(openRes.body?.id);
      });
      let cutoffClosureId = 0;
      await withFixedClock('2026-10-26T05:00:00.000Z', async () => {
        const closeRes = await request(app)
          .post(`/api/cash-sessions/${cutoffSessionId}/close`)
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ counted_cash_cents: 5000 });
        assert(closeRes.status === 200, '#1360 (04:00 cutoff): shift closes at 05:00 (200)');
        cutoffClosureId = Number(closeRes.body?.closure_id);
      });
      const cutoffClosure = db
        .prepare(`SELECT business_date, period_start, period_end FROM cash_closures WHERE id = ?`)
        .get(cutoffClosureId) as {
        business_date: string;
        period_start: string;
        period_end: string;
      };
      assert(
        cutoffClosure?.business_date === '2026-10-25' &&
          cutoffClosure?.period_start === '2026-10-26 02:00:00' &&
          cutoffClosure?.period_end === '2026-10-26 05:00:00',
        `#1360 (04:00 cutoff): shift opened 02:00 Oct 26 and closed 05:00 Oct 26 retains business_date 2026-10-25 (got ${cutoffClosure?.business_date})`,
      );

      // 3) Same-business-day close -> opening business date
      setTenantTimeConfig('UTC', '00:00');
      let sameDaySessionId = 0;
      await withFixedClock('2026-10-25T10:00:00.000Z', async () => {
        const openRes = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ opening_float_cents: 3000 });
        assert(openRes.status === 200, '#1360 (same-day): shift opens at 10:00 Oct 25 (200)');
        sameDaySessionId = Number(openRes.body?.id);
      });
      let sameDayClosureId = 0;
      await withFixedClock('2026-10-25T18:00:00.000Z', async () => {
        const closeRes = await request(app)
          .post(`/api/cash-sessions/${sameDaySessionId}/close`)
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ counted_cash_cents: 3000 });
        assert(closeRes.status === 200, '#1360 (same-day): shift closes at 18:00 Oct 25 (200)');
        sameDayClosureId = Number(closeRes.body?.closure_id);
      });
      const sameDayClosure = db
        .prepare(`SELECT business_date, period_start, period_end FROM cash_closures WHERE id = ?`)
        .get(sameDayClosureId) as {
        business_date: string;
        period_start: string;
        period_end: string;
      };
      assert(
        sameDayClosure?.business_date === '2026-10-25' &&
          sameDayClosure?.period_start === '2026-10-25 10:00:00' &&
          sameDayClosure?.period_end === '2026-10-25 18:00:00',
        `#1360 (same-day): same-business-day close records opening business_date 2026-10-25 (got ${sameDayClosure?.business_date})`,
      );

      // 4) Daylight-saving transition: Australia/Sydney springs forward 2026-10-04 02:00 AEST -> 03:00 AEDT
      setTenantTimeConfig('Australia/Sydney', '00:00');
      let dstSessionId = 0;
      await withFixedClock('2026-10-03T12:00:00.000Z', async () => {
        // 2026-10-03 22:00:00 AEST (UTC+10)
        const openRes = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ opening_float_cents: 4000 });
        assert(openRes.status === 200, '#1360 (DST Sydney): shift opens before DST transition');
        dstSessionId = Number(openRes.body?.id);
      });
      let dstClosureId = 0;
      await withFixedClock('2026-10-03T16:30:00.000Z', async () => {
        // 2026-10-04 03:30:00 AEDT (UTC+11)
        const closeRes = await request(app)
          .post(`/api/cash-sessions/${dstSessionId}/close`)
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ counted_cash_cents: 4000 });
        assert(closeRes.status === 200, '#1360 (DST Sydney): shift closes after DST transition');
        dstClosureId = Number(closeRes.body?.closure_id);
      });
      const dstClosure = db
        .prepare(`SELECT business_date, period_start, period_end FROM cash_closures WHERE id = ?`)
        .get(dstClosureId) as {
        business_date: string;
        period_start: string;
        period_end: string;
      };
      assert(
        dstClosure?.business_date === '2026-10-03' &&
          dstClosure?.period_start === '2026-10-03 12:00:00' &&
          dstClosure?.period_end === '2026-10-03 16:30:00',
        `#1360 (DST Sydney): cross-DST shift retains opening business_date 2026-10-03 (got ${dstClosure?.business_date})`,
      );

      // 5) Stale automatic close several days later -> opening business date
      setTenantTimeConfig('America/Montevideo', '04:00');
      let staleSession1360Id = 0;
      await withFixedClock('2026-10-15T05:30:00.000Z', async () => {
        // 2026-10-15 02:30:00 Montevideo (before 04:00 cutoff -> business date 2026-10-14)
        const openRes = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ opening_float_cents: 1500 });
        assert(openRes.status === 200, '#1360 (stale auto-close): stale candidate opens (200)');
        staleSession1360Id = Number(openRes.body?.id);
      });
      // Ensure store-wide activity is older than the 7-day stale cutoff relative to 2026-10-25.
      const staleBackdate = '2026-10-10 00:00:00';
      db.prepare('UPDATE bills SET paid_at = ? WHERE paid_at IS NOT NULL').run(staleBackdate);
      db.prepare('UPDATE cash_drawer_movements SET created_at = ?').run(staleBackdate);
      db.prepare('UPDATE refunds SET created_at = ?').run(staleBackdate);
      for (const row of db
        .prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL')
        .all() as { id: number; payment_details: string }[]) {
        const parsed = JSON.parse(row.payment_details);
        const lines = Array.isArray(parsed) ? parsed : [parsed];
        for (const line of lines)
          if (line && typeof line === 'object') line.timestamp = staleBackdate;
        db.prepare('UPDATE bills SET payment_details = ? WHERE id = ?').run(
          JSON.stringify(Array.isArray(parsed) ? lines : lines[0]),
          row.id,
        );
      }

      await withFixedClock('2026-10-25T15:00:00.000Z', async () => {
        const freshOpenRes = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ opening_float_cents: 1000 });
        assert(
          freshOpenRes.status === 200,
          '#1360 (stale auto-close): opening a new shift 10 days later auto-closes stale session (200)',
        );
        const closeFreshRes = await request(app)
          .post(`/api/cash-sessions/${freshOpenRes.body?.id}/close`)
          .set('Authorization', `Bearer ${longLivedCashierToken}`)
          .send({ counted_cash_cents: 1000 });
        assert(closeFreshRes.status === 200, '#1360 (stale auto-close): fresh shift closes (200)');
      });

      const autoClosedSession = db
        .prepare(`SELECT status, opened_at, closed_at, closure_id FROM cash_sessions WHERE id = ?`)
        .get(staleSession1360Id) as {
        status: string;
        opened_at: string;
        closed_at: string;
        closure_id: number;
      };
      const autoClosedClosure = db
        .prepare(`SELECT business_date, period_start, period_end FROM cash_closures WHERE id = ?`)
        .get(autoClosedSession?.closure_id) as {
        business_date: string;
        period_start: string;
        period_end: string;
      };
      assert(
        autoClosedSession?.status === 'closed' &&
          autoClosedClosure?.business_date === '2026-10-14' &&
          autoClosedClosure?.period_start === '2026-10-15 05:30:00' &&
          autoClosedClosure?.period_end === '2026-10-25 15:00:00' &&
          autoClosedSession?.closed_at === '2026-10-25 15:00:00',
        `#1360 (stale auto-close): stale session auto-closed 10 days later retains opening business_date 2026-10-14 (got ${autoClosedClosure?.business_date})`,
      );

      // 6) Existing historical closures remain unchanged
      const historicalZNumber = 991360;
      const historicalInsert = db
        .prepare(
          `INSERT INTO cash_closures (
            scope, business_date, period_start, period_end,
            opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents,
            gross_collected_cents, refunded_cents, net_collected_cents,
            bill_count, refund_count,
            payment_methods_json, staff_sales_json, tax_components_json,
            pay_in_cents, pay_out_cents, safe_drop_cents, cash_movements_json,
            z_number, closed_by, notes, created_at
          ) VALUES (
            'session', '2026-10-20', '2026-10-19 22:00:00', '2026-10-20 00:30:00',
            10000, 10000, 10000, 0,
            0, 0, 0,
            0, 0,
            '[]', '[]', '[]',
            0, 0, 0, '[]',
            ?, 'cashier-sess', 'historical closure', '2026-10-20 00:30:00'
          )`,
        )
        .run(historicalZNumber);
      const historicalId = Number(historicalInsert.lastInsertRowid);
      const historicalPrint = await request(app)
        .post(`/api/cash-closures/${historicalId}/print`)
        .set('Authorization', `Bearer ${longLivedCashierToken}`)
        .send({ isReprint: true });
      const historicalText = escPosToText(Buffer.from(historicalPrint.body?.bytes || []));
      const historicalRow = db
        .prepare(`SELECT business_date, period_start, period_end FROM cash_closures WHERE id = ?`)
        .get(historicalId) as {
        business_date: string;
        period_start: string;
        period_end: string;
      };
      assert(
        historicalPrint.status === 200 &&
          historicalRow?.business_date === '2026-10-20' &&
          historicalText.includes(`Z#${historicalZNumber} - 2026-10-20`),
        '#1360 (historical): existing stored closures and their reprints remain unchanged',
      );
      db.prepare(`DELETE FROM cash_closures WHERE id = ?`).run(historicalId);
    } finally {
      setTenantTimeConfig('UTC', '00:00');
      db.prepare(`DELETE FROM printers WHERE id = 'webusb-1360'`).run();
    }

    // ── Section 11: opt-in one cash shift per staff member (#1339) ──────────
    console.log('Section 11: opt-in one cash shift per staff member (#1339)');
    const { expenseRoutes } = require('../main/routes/expenses');
    const { reportRoutes } = require('../main/routes/reports');
    app.use('/api/expenses', expenseRoutes);
    app.use('/api/reports', reportRoutes);
    const s11CashierAToken = jwt.sign(
      {
        userId: 'cashier-sess',
        email: 'cashier-sess@test.local',
        role: 'cashier',
      },
      getJWTSecret(),
      { expiresIn: '365d' },
    );
    const s11CashierBToken = jwt.sign(
      {
        userId: 'cashier2-sess',
        email: 'cashier2-sess@test.local',
        role: 'cashier',
      },
      getJWTSecret(),
      { expiresIn: '365d' },
    );
    const s11ManagerToken = jwt.sign(
      {
        userId: 'manager-sess',
        email: 'manager-sess@test.local',
        role: 'manager',
      },
      getJWTSecret(),
      { expiresIn: '365d' },
    );
    const s11OwnerToken = jwt.sign(
      { userId: 'owner-sess', email: 'owner-sess@test.local', role: 'owner' },
      getJWTSecret(),
      { expiresIn: '365d' },
    );

    const seedBillOnDate = (tag: string, isoMoment: string, amountMajor = 50): number => {
      const tsMoment = isoMoment.replace('T', ' ').replace(/\..*$/, '');
      db.prepare(
        `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
         VALUES (?, 'cashier-sess', 'takeaway', 'pending', ?, ?, ?, ?, NULL)`,
      ).run(`ORD-1339-${tag}`, amountMajor, amountMajor, tsMoment, tsMoment);
      const oid = Number(
        (db.prepare(`SELECT id FROM orders WHERE order_number = ?`).get(`ORD-1339-${tag}`) as any)
          .id,
      );
      db.prepare(
        `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 'unpaid', '[]', NULL, ?, ?)`,
      ).run(`BILL-1339-${tag}`, oid, amountMajor, amountMajor, amountMajor, tsMoment, tsMoment);
      return Number(
        (db.prepare(`SELECT id FROM bills WHERE bill_number = ?`).get(`BILL-1339-${tag}`) as any)
          .id,
      );
    };

    try {
      // 1) Setting off by default: second user opening a shift is refused with 409 session_already_open
      assert(
        getSettingValue('one_shift_per_staff') === 'false',
        '#1339: one_shift_per_staff is off before per-staff test',
      );
      await withFixedClock('2026-11-10T09:00:00.000Z', async () => {
        const s1 = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ opening_float_cents: 1000 });
        assert(s1.status === 200, '#1339 (setting off): User A opens shift (200)');

        const s2Blocked = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .send({ opening_float_cents: 1000 });
        assert(
          s2Blocked.status === 409 && s2Blocked.body?.display_code === 'session_already_open',
          '#1339 (setting off): User B opening second shift is refused with 409 session_already_open',
        );

        const s1Close = await request(app)
          .post(`/api/cash-sessions/${s1.body?.id}/close`)
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ counted_cash_cents: 1000 });
        assert(s1Close.status === 200, '#1339 (setting off): User A closes shift (200)');
      });
      db.prepare(
        `DELETE FROM cash_drawer_movements WHERE business_date = '2026-11-10' AND movement_type = 'opening_float'`,
      ).run();
      db.prepare(`DELETE FROM cash_sessions WHERE opened_at LIKE '2026-11-10%'`).run();
      db.prepare(`DELETE FROM cash_closures WHERE business_date = '2026-11-10'`).run();

      // 2) Settings validation & toggle permissions
      const unauthPerStaff = await request(app)
        .put('/api/settings/one_shift_per_staff')
        .set('Authorization', `Bearer ${s11CashierAToken}`)
        .send({ value: true });
      assert(
        unauthPerStaff.status === 403 && getSettingValue('one_shift_per_staff') === 'false',
        '#1339: cashier cannot toggle one_shift_per_staff (403)',
      );

      const invalidPerStaff = await request(app)
        .put('/api/settings/one_shift_per_staff')
        .set('Authorization', `Bearer ${s11OwnerToken}`)
        .send({ value: 'invalid' });
      assert(
        invalidPerStaff.status === 400 && getSettingValue('one_shift_per_staff') === 'false',
        '#1339: invalid non-boolean value for one_shift_per_staff returns 400',
      );

      const enablePerStaff = await request(app)
        .put('/api/settings/one_shift_per_staff')
        .set('Authorization', `Bearer ${s11OwnerToken}`)
        .send({ value: true });
      assert(
        enablePerStaff.status === 200 && getSettingValue('one_shift_per_staff') === 'true',
        '#1339: owner enables one_shift_per_staff (200)',
      );

      // 3) Concurrent shifts for User A and User B on 2026-11-10
      let shiftAId = 0;
      let shiftBId = 0;
      await withFixedClock('2026-11-10T10:00:00.000Z', async () => {
        const openA = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ opening_float_cents: 5000 });
        assert(
          openA.status === 200,
          '#1339 (setting on): User A opens Shift A with 5000 float (200)',
        );
        shiftAId = Number(openA.body?.id);

        const dupOpenA = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ opening_float_cents: 2000 });
        assert(
          dupOpenA.status === 409 && dupOpenA.body?.display_code === 'session_already_open',
          '#1339 (setting on): User A cannot open a second concurrent shift for themselves (409)',
        );

        const openB = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .send({ opening_float_cents: 3000 });
        assert(
          openB.status === 200 && Number(openB.body?.id) !== shiftAId,
          '#1339 (setting on): User B concurrently opens Shift B with 3000 float (200)',
        );
        shiftBId = Number(openB.body?.id);
      });

      const dayFloatRow = db
        .prepare(
          `SELECT amount_cents FROM cash_drawer_movements
           WHERE business_date = '2026-11-10' AND movement_type = 'opening_float' AND voided_at IS NULL`,
        )
        .get() as { amount_cents: number } | undefined;
      assert(
        dayFloatRow?.amount_cents === 8000,
        `#1339: day opening_float aggregates across concurrent shifts (5000 + 3000 = 8000, got ${dayFloatRow?.amount_cents})`,
      );

      // 4) Refusing to turn one_shift_per_staff off while >1 shift is open
      const disableWhileMultipleOpen = await request(app)
        .put('/api/settings/one_shift_per_staff')
        .set('Authorization', `Bearer ${s11OwnerToken}`)
        .send({ value: false });
      assert(
        disableWhileMultipleOpen.status === 409 &&
          disableWhileMultipleOpen.body?.code === 'multiple_shifts_open' &&
          getSettingValue('one_shift_per_staff') === 'true',
        '#1339: disabling one_shift_per_staff while 2 shifts are open is refused with 409 multiple_shifts_open',
      );

      // 5) Actor-scoped money routing: payments, drawer movements, refunds, and cash expenses
      // Grant cashier1 refund initiation and cashier2 expense permissions so each staff member can exercise their own shift.
      db.prepare(
        `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
         VALUES ('cashier-sess', 'refunds.initiate', 'allow', 'owner-sess', ?)
         ON CONFLICT(user_id, permission_id) DO UPDATE SET effect = 'allow', updated_at = excluded.updated_at`,
      ).run(now());
      for (const permId of ['expenses.view', 'expenses.manage', 'expenses.pay']) {
        db.prepare(
          `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
           VALUES ('cashier2-sess', ?, 'allow', 'owner-sess', ?)
           ON CONFLICT(user_id, permission_id) DO UPDATE SET effect = 'allow', updated_at = excluded.updated_at`,
        ).run(permId, now());
      }

      await withFixedClock('2026-11-10T11:00:00.000Z', async () => {
        // User A takes 40.00 (4000c) cash payment
        const billAId = seedBillOnDate('A', '2026-11-10T11:00:00.000Z', 40);
        const payA = await request(app)
          .post(`/api/bills/${billAId}/payment`)
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ method: 'cash', amount: 40 });
        assert(payA.status === 200, '#1339: User A records 40.00 cash payment (200)');
        const detailsA = JSON.parse(
          (db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(billAId) as any)
            .payment_details,
        );
        assert(
          Number(detailsA[0]?.cash_session_id) === shiftAId,
          '#1339: User A cash payment attaches to Shift A',
        );

        // User B takes 60.00 (6000c) cash payment
        const billBId = seedBillOnDate('B', '2026-11-10T11:00:00.000Z', 60);
        const payB = await request(app)
          .post(`/api/bills/${billBId}/payment`)
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .send({ method: 'cash', amount: 60 });
        assert(payB.status === 200, '#1339: User B records 60.00 cash payment (200)');
        const detailsB = JSON.parse(
          (db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(billBId) as any)
            .payment_details,
        );
        assert(
          Number(detailsB[0]?.cash_session_id) === shiftBId,
          '#1339: User B cash payment attaches to Shift B',
        );

        // User A records 1000c pay_in movement
        const movA = await request(app)
          .post('/api/cash-closures/movements')
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({
            business_date: '2026-11-10',
            movement_type: 'pay_in',
            amount_cents: 1000,
            reason: 'User A change',
          });
        assert(
          movA.status === 201 && Number(movA.body?.movement?.cash_session_id) === shiftAId,
          '#1339: User A drawer pay_in movement attaches to Shift A (201)',
        );

        // User B records 500c pay_out movement
        const movB = await request(app)
          .post('/api/cash-closures/movements')
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .send({
            business_date: '2026-11-10',
            movement_type: 'pay_out',
            amount_cents: 500,
            reason: 'User B supplies',
          });
        assert(
          movB.status === 201 && Number(movB.body?.movement?.cash_session_id) === shiftBId,
          '#1339: User B drawer pay_out movement attaches to Shift B (201)',
        );

        // User A records 10.00 (1000c) cash refund on Bill A
        const refundA = await request(app)
          .post('/api/refunds')
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({
            bill_id: billAId,
            amount: 10,
            method: 'cash',
            approver_id: 'owner-sess',
            override_pin: '1234',
          });
        assert(refundA.status === 201, '#1339: User A records 10.00 cash refund (201)');
        const refundARow = db
          .prepare('SELECT cash_session_id FROM refunds WHERE id = ?')
          .get(refundA.body?.refund?.id) as { cash_session_id: number } | undefined;
        assert(
          Number(refundARow?.cash_session_id) === shiftAId,
          '#1339: User A cash refund attaches to Shift A',
        );

        // User B creates and pays a 1500c cash expense
        const catRes = await request(app)
          .post('/api/expenses/categories')
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .set('Idempotency-Key', '1339-cat-1')
          .send({ name: 'Shift B Supplies' });
        assert(catRes.status === 201, '#1339: expense category created (201)');
        const catId = catRes.body?.category?.id;

        const expRes = await request(app)
          .post('/api/expenses')
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .set('Idempotency-Key', '1339-exp-1')
          .send({
            category_id: catId,
            description: 'Milk run',
            amount_minor: 1500,
            incurred_on: '2026-11-10',
          });
        assert(expRes.status === 201, '#1339: expense created (201)');
        const expId = expRes.body?.expense?.id;

        // Manager has no open shift -> cash expense payment by manager is refused with 409 cash_session_required
        const managerExpCtx = await request(app)
          .get('/api/expenses/context')
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        assert(
          managerExpCtx.status === 200 && managerExpCtx.body?.cash_session_open === false,
          '#1339: manager without own open shift sees cash_session_open=false in expense context',
        );
        const managerExpPayBlocked = await request(app)
          .post(`/api/expenses/${expId}/payments`)
          .set('Authorization', `Bearer ${s11ManagerToken}`)
          .set('Idempotency-Key', '1339-exp-pay-mgr')
          .send({ method: 'cash', amount_minor: 1500 });
        assert(
          managerExpPayBlocked.status === 409 &&
            managerExpPayBlocked.body?.code === 'cash_session_required',
          '#1339: manager without own open shift cannot pay cash expense even when staff shifts are open (409)',
        );

        // User B pays the 1500c cash expense -> routes to Shift B
        const expPayB = await request(app)
          .post(`/api/expenses/${expId}/payments`)
          .set('Authorization', `Bearer ${s11CashierBToken}`)
          .set('Idempotency-Key', '1339-exp-pay-b')
          .send({ method: 'cash', amount_minor: 1500 });
        assert(expPayB.status === 201, '#1339: User B records 1500c cash expense payment (201)');
        const expMovId = expPayB.body?.payment?.cash_movement_id;
        const expMovRow = db
          .prepare(
            'SELECT cash_session_id, amount_cents, movement_type FROM cash_drawer_movements WHERE id = ?',
          )
          .get(expMovId) as
          | {
              cash_session_id: number;
              amount_cents: number;
              movement_type: string;
            }
          | undefined;
        assert(
          Number(expMovRow?.cash_session_id) === shiftBId &&
            expMovRow?.amount_cents === 1500 &&
            expMovRow?.movement_type === 'pay_out',
          '#1339: User B cash expense payment writes a pay_out movement on Shift B',
        );

        // Manager without an open shift taking a cash bill payment:
        // When require_open_shift is off -> NO_CASH_SESSION_ID (0)
        // When require_open_shift is on -> 409 cash_session_required
        db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'require_open_shift'`).run();
        const billMgrId = seedBillOnDate('MGR', '2026-11-10T11:00:00.000Z', 25);
        const payMgrBlocked = await request(app)
          .post(`/api/bills/${billMgrId}/payment`)
          .set('Authorization', `Bearer ${s11ManagerToken}`)
          .send({ method: 'cash', amount: 25 });
        assert(
          payMgrBlocked.status === 409,
          '#1339: with require_open_shift on, manager without own open shift is blocked from cash payment (409)',
        );
        db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();
        const payMgrUnscoped = await request(app)
          .post(`/api/bills/${billMgrId}/payment`)
          .set('Authorization', `Bearer ${s11ManagerToken}`)
          .send({ method: 'cash', amount: 25 });
        assert(
          payMgrUnscoped.status === 200,
          '#1339: with require_open_shift off, manager without own open shift records cash payment with NO_CASH_SESSION_ID (200)',
        );
        const detailsMgr = JSON.parse(
          (db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(billMgrId) as any)
            .payment_details,
        );
        assert(
          Number(detailsMgr[0]?.cash_session_id) === 0,
          '#1339: sessionless actor payment stores cash_session_id = 0 (NO_CASH_SESSION_ID) and does not leak into Shift A or B',
        );
        // If the manager subsequently opens a shift and attempts to correct that sessionless payment line (cash_session_id === 0),
        // it must be rejected with 409 shift_closed rather than moving into the manager's open shift.
        const openMgrShift = await request(app)
          .post('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11ManagerToken}`)
          .send({ opening_float_cents: 0 });
        assert(openMgrShift.status === 200, '#1339: manager opens a shift (200)');
        const correctSessionless = await request(app)
          .patch(`/api/bills/${billMgrId}/payments/0/method`)
          .set('Authorization', `Bearer ${s11ManagerToken}`)
          .send({
            method: 'card',
            reason: 'Wrong button',
            approver_id: 'owner-sess',
            override_pin: '1234',
          });
        assert(
          correctSessionless.status === 409 && correctSessionless.body?.reason === 'shift_closed',
          `#1339: correcting a sessionless payment line (cash_session_id=0) is rejected with 409 shift_closed (got ${correctSessionless.status} ${correctSessionless.body?.reason})`,
        );
        db.prepare('DELETE FROM cash_sessions WHERE id = ?').run(openMgrShift.body?.id);
        // Delete the unscoped manager test bill so day close compares purely Shift A + Shift B
        db.prepare('DELETE FROM bills WHERE id = ?').run(billMgrId);
        db.prepare(`DELETE FROM orders WHERE order_number = 'ORD-1339-MGR'`).run();
      });

      // Expected cash for Shift A: 5000 float + 4000 sale + 1000 pay_in - 1000 refund = 9000
      // Expected cash for Shift B: 3000 float + 6000 sale - 500 pay_out - 1500 expense pay_out = 7000
      await withFixedClock('2026-11-10T12:00:00.000Z', async () => {
        const curA = await request(app)
          .get('/api/cash-sessions/current')
          .set('Authorization', `Bearer ${s11CashierAToken}`);
        assert(
          curA.status === 200 &&
            Number(curA.body?.id) === shiftAId &&
            curA.body?.expected_cash_cents === 9000,
          `#1339: User A GET /current returns Shift A with expected_cash_cents=9000 (got ${curA.body?.expected_cash_cents})`,
        );

        const curB = await request(app)
          .get('/api/cash-sessions/current')
          .set('Authorization', `Bearer ${s11CashierBToken}`);
        assert(
          curB.status === 200 &&
            Number(curB.body?.id) === shiftBId &&
            curB.body?.expected_cash_cents === 7000,
          `#1339: User B GET /current returns Shift B with expected_cash_cents=7000 (got ${curB.body?.expected_cash_cents})`,
        );

        // Manager listing all open shifts via GET /api/cash-sessions/open
        const openListMgr = await request(app)
          .get('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        assert(
          openListMgr.status === 200 &&
            Array.isArray(openListMgr.body?.sessions) &&
            openListMgr.body.sessions.length === 2,
          '#1339: manager GET /api/cash-sessions/open returns both open shifts',
        );
        // Cashier listing via GET /api/cash-sessions/open sees only their own shift
        const openListCashierA = await request(app)
          .get('/api/cash-sessions/open')
          .set('Authorization', `Bearer ${s11CashierAToken}`);
        assert(
          openListCashierA.status === 200 &&
            Array.isArray(openListCashierA.body?.sessions) &&
            openListCashierA.body.sessions.length === 1 &&
            Number(openListCashierA.body.sessions[0]?.id) === shiftAId,
          '#1339: cashier GET /api/cash-sessions/open returns only their own open shift',
        );

        // 6) X Report: all open shifts vs single shift (?session_id=)
        const xAll = await request(app)
          .get('/api/reports/x-report?date=2026-11-10')
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        const xAllRep = xAll.body?.xReport;
        assert(
          xAll.status === 200 &&
            Array.isArray(xAllRep?.openShifts) &&
            xAllRep.openShifts.length === 2 &&
            xAllRep?.openingFloatCents === 8000 &&
            xAllRep?.expectedCashCents === 8000 &&
            xAllRep?.grossCollected === 100 &&
            xAllRep?.refunded === 10 &&
            xAllRep?.netCollected === 90,
          `#1339: unscoped X report covers all shifts (expectedCashCents=8000 net of float, openingFloatCents=8000, got ${xAllRep?.expectedCashCents})`,
        );

        const xShiftA = await request(app)
          .get(`/api/reports/x-report?date=2026-11-10&session_id=${shiftAId}`)
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        const xShiftARep = xShiftA.body?.xReport;
        assert(
          xShiftA.status === 200 &&
            Number(xShiftARep?.session?.id) === shiftAId &&
            xShiftARep?.openingFloatCents === 5000 &&
            xShiftARep?.expectedCashCents === 4000 &&
            xShiftARep?.session?.expected_cash_cents === 9000 &&
            xShiftARep?.grossCollected === 40 &&
            xShiftARep?.refunded === 10 &&
            xShiftARep?.netCollected === 30 &&
            Array.isArray(xShiftARep?.staffSales) &&
            xShiftARep.staffSales.length === 1 &&
            Number(xShiftARep.staffSales[0]?.revenue) === 40 &&
            Number(xShiftARep.staffSales[0]?.orderCount) === 1,
          `#1339: X report with ?session_id=${shiftAId} scopes totals and staffSales to Shift A (expected_cash_cents=9000, got ${xShiftARep?.session?.expected_cash_cents})`,
        );

        const xShiftB = await request(app)
          .get(`/api/reports/x-report?date=2026-11-10&session_id=${shiftBId}`)
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        const xShiftBRep = xShiftB.body?.xReport;
        assert(
          xShiftB.status === 200 &&
            Number(xShiftBRep?.session?.id) === shiftBId &&
            xShiftBRep?.openingFloatCents === 3000 &&
            xShiftBRep?.expectedCashCents === 4000 &&
            xShiftBRep?.session?.expected_cash_cents === 7000 &&
            xShiftBRep?.grossCollected === 60 &&
            xShiftBRep?.refunded === 0 &&
            xShiftBRep?.netCollected === 60 &&
            xShiftBRep?.payOutCents === 2000 &&
            Array.isArray(xShiftBRep?.staffSales) &&
            xShiftBRep.staffSales.length === 1 &&
            Number(xShiftBRep.staffSales[0]?.revenue) === 60 &&
            Number(xShiftBRep.staffSales[0]?.orderCount) === 1,
          `#1339: X report with ?session_id=${shiftBId} scopes totals and staffSales to Shift B (expected_cash_cents=7000, payOut=2000, got ${xShiftBRep?.session?.expected_cash_cents})`,
        );

        // Cashier with reports.view can view their own shift X report (200) but is forbidden from another user's shift X report (403)
        db.prepare(
          `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
           VALUES ('cashier-sess', 'reports.view', 'allow', 'owner-sess', ?)
           ON CONFLICT(user_id, permission_id) DO UPDATE SET effect = 'allow', updated_at = excluded.updated_at`,
        ).run(now());
        const xOwnCashier = await request(app)
          .get(`/api/reports/x-report?date=2026-11-10&session_id=${shiftAId}`)
          .set('Authorization', `Bearer ${s11CashierAToken}`);
        assert(
          xOwnCashier.status === 200 && Number(xOwnCashier.body?.xReport?.session?.id) === shiftAId,
          '#1339: Cashier A with reports.view can view own shift X report (200)',
        );
        const xOtherCashier = await request(app)
          .get(`/api/reports/x-report?date=2026-11-10&session_id=${shiftBId}`)
          .set('Authorization', `Bearer ${s11CashierAToken}`);
        assert(
          xOtherCashier.status === 403 && xOtherCashier.body?.code === 'shift_access_forbidden',
          `#1339: Cashier A cannot view Cashier B shift X report (403 shift_access_forbidden, got ${xOtherCashier.status})`,
        );
        db.prepare(
          `DELETE FROM user_permission_overrides WHERE user_id = 'cashier-sess' AND permission_id = 'reports.view'`,
        ).run();

        // 7) Close authority & Day Close waiting until ALL shifts are closed
        // Cashier A cannot preview or close Cashier B's shift
        const crossPreview = await request(app)
          .get(`/api/cash-sessions/current/close-preview?session_id=${shiftBId}`)
          .set('Authorization', `Bearer ${s11CashierAToken}`);
        assert(
          crossPreview.status === 403 &&
            crossPreview.body?.display_code === 'session_owner_required',
          '#1339: Cashier A cannot close-preview Cashier B shift (403 session_owner_required)',
        );
        const crossClose = await request(app)
          .post(`/api/cash-sessions/${shiftBId}/close`)
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ counted_cash_cents: 7000 });
        assert(
          crossClose.status === 403 && crossClose.body?.display_code === 'session_owner_required',
          '#1339: Cashier A cannot close Cashier B shift (403 session_owner_required)',
        );

        // Day close is blocked while both shifts are open
        const dayBlockedBoth = await request(app)
          .post('/api/cash-closures')
          .set('Authorization', `Bearer ${s11OwnerToken}`)
          .send({
            business_date: '2026-11-10',
            opening_float_cents: 8000,
            counted_cash_cents: 16000,
          });
        assert(
          dayBlockedBoth.status === 409 &&
            dayBlockedBoth.body?.display_code === 'open_shift_blocks_day_close' &&
            Array.isArray(dayBlockedBoth.body?.blocking_shifts) &&
            dayBlockedBoth.body.blocking_shifts.length === 2,
          '#1339: day close is blocked (409) while both shifts are open and lists 2 blocking_shifts',
        );

        // Cashier A closes their own shift (Shift A)
        const closeA = await request(app)
          .post(`/api/cash-sessions/${shiftAId}/close`)
          .set('Authorization', `Bearer ${s11CashierAToken}`)
          .send({ counted_cash_cents: 9000 });
        assert(
          closeA.status === 200 &&
            closeA.body?.expected_cash_cents === 9000 &&
            closeA.body?.variance_cents === 0,
          '#1339: Cashier A closes Shift A with 9000c (200)',
        );
        const shiftAClosureRow = db
          .prepare('SELECT z_number FROM cash_closures WHERE id = ?')
          .get(closeA.body?.closure_id) as { z_number: number } | undefined;
        const xShiftAClosed = await request(app)
          .get(`/api/reports/x-report?date=2026-11-09&session_id=${shiftAId}`)
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        const xShiftAClosedRep = xShiftAClosed.body?.xReport;
        assert(
          xShiftAClosed.status === 200 &&
            xShiftAClosedRep?.businessDate === '2026-11-10' &&
            xShiftAClosedRep?.alreadyClosed === true &&
            xShiftAClosedRep?.zNumber === shiftAClosureRow?.z_number &&
            xShiftAClosedRep?.session?.status === 'closed' &&
            Number(xShiftAClosedRep?.session?.closure_id) === Number(closeA.body?.closure_id) &&
            Array.isArray(xShiftAClosedRep?.openShifts) &&
            xShiftAClosedRep.openShifts.length === 1 &&
            Number(xShiftAClosedRep.openShifts[0]?.id) === shiftBId &&
            Number(xShiftAClosedRep?.blockingOpenShift?.id) === shiftBId,
          `#1339: closed Shift A X report reports shift-scoped alreadyClosed=true, zNumber=${shiftAClosureRow?.z_number}, and shiftDate openShifts even when day is still open`,
        );

        // Day close is STILL blocked while Shift B remains open
        const dayBlockedOneLeft = await request(app)
          .post('/api/cash-closures')
          .set('Authorization', `Bearer ${s11OwnerToken}`)
          .send({
            business_date: '2026-11-10',
            opening_float_cents: 8000,
            counted_cash_cents: 16000,
          });
        assert(
          dayBlockedOneLeft.status === 409 &&
            dayBlockedOneLeft.body?.display_code === 'open_shift_blocks_day_close' &&
            Number(dayBlockedOneLeft.body?.blocking_shift?.id) === shiftBId,
          '#1339: day close remains blocked (409) while Shift B is still open',
        );

        // Manager can preview and close Cashier B's shift (Shift B)
        const mgrPreviewB = await request(app)
          .get(`/api/cash-sessions/current/close-preview?session_id=${shiftBId}`)
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        assert(
          mgrPreviewB.status === 200 && Number(mgrPreviewB.body?.session_id) === shiftBId,
          '#1339: Manager can close-preview Cashier B shift (200)',
        );
        const mgrCloseB = await request(app)
          .post(`/api/cash-sessions/${shiftBId}/close`)
          .set('Authorization', `Bearer ${s11ManagerToken}`)
          .send({ counted_cash_cents: 7000 });
        assert(
          mgrCloseB.status === 200 &&
            mgrCloseB.body?.expected_cash_cents === 7000 &&
            mgrCloseB.body?.variance_cents === 0,
          '#1339: Manager closes Cashier B shift with 7000c (200)',
        );

        // Once all shifts are closed, day close succeeds and sums Shift A + Shift B
        const dayCloseSuccess = await request(app)
          .post('/api/cash-closures')
          .set('Authorization', `Bearer ${s11OwnerToken}`)
          .send({
            business_date: '2026-11-10',
            opening_float_cents: 8000,
            counted_cash_cents: 16000,
          });
        assert(
          dayCloseSuccess.status === 201,
          `#1339: day close succeeds once both shifts are closed (201, got ${dayCloseSuccess.status})`,
        );
        const dayZ = dayCloseSuccess.body?.zReport;
        assert(
          dayZ?.scope === 'day' &&
            dayZ?.opening_float_cents === 8000 &&
            dayZ?.expected_cash_cents === 16000 &&
            dayZ?.counted_cash_cents === 16000 &&
            dayZ?.variance_cents === 0 &&
            dayZ?.gross_collected_cents === 10000 &&
            dayZ?.refunded_cents === 1000 &&
            dayZ?.net_collected_cents === 9000 &&
            dayZ?.pay_in_cents === 1000 &&
            dayZ?.pay_out_cents === 2000 &&
            dayZ?.bill_count === 2 &&
            dayZ?.refund_count === 1,
          `#1339: day Z report totals equal Shift A + Shift B (expected_cash=${dayZ?.expected_cash_cents}, net=${dayZ?.net_collected_cents})`,
        );
        const xShiftAAfterDayClose = await request(app)
          .get(`/api/reports/x-report?date=2026-11-10&session_id=${shiftAId}`)
          .set('Authorization', `Bearer ${s11ManagerToken}`);
        const xShiftAAfterDayCloseRep = xShiftAAfterDayClose.body?.xReport;
        assert(
          xShiftAAfterDayClose.status === 200 &&
            xShiftAAfterDayCloseRep?.alreadyClosed === true &&
            xShiftAAfterDayCloseRep?.zNumber === shiftAClosureRow?.z_number &&
            xShiftAAfterDayCloseRep?.zNumber !== dayZ?.z_number,
          `#1339: after day close, Shift A X report retains Shift A zNumber (${shiftAClosureRow?.z_number}) instead of day zNumber (${dayZ?.z_number})`,
        );

        // Turning one_shift_per_staff off now succeeds since <= 1 shift is open
        const disableAfterClose = await request(app)
          .put('/api/settings/one_shift_per_staff')
          .set('Authorization', `Bearer ${s11OwnerToken}`)
          .send({ value: false });
        assert(
          disableAfterClose.status === 200 && getSettingValue('one_shift_per_staff') === 'false',
          '#1339: owner disables one_shift_per_staff after concurrent shifts are closed (200)',
        );
      });
    } finally {
      db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'one_shift_per_staff'`).run();
      db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'require_open_shift'`).run();
      db.prepare(
        `DELETE FROM user_permission_overrides WHERE user_id IN ('cashier-sess', 'cashier2-sess')`,
      ).run();
    }
  }

  console.log('='.repeat(50));
  console.log(`Passed ${passed}/${total}, failed ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
