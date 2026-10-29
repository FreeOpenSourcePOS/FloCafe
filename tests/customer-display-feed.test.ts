import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-display-feed-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const expressRateLimit = require('express-rate-limit');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { settingsRoutes } = require('../main/routes/settings');
const { customerDisplayFeedRoutes } = require('../main/routes/customer-display-feed');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { kdsRoutes } = require('../main/routes/kds');
const { completedKdsProjectionCutoff } = require('../main/services/orders');
const { requireAuth } = require('../main/server');
const { getJWTSecret } = require('../main/routes/auth');
const { fetchSignedInBoardOrders } = require('../frontend/src/lib/customer-display');

const TOKENS = '/api/settings/customer-display/tokens';
const FEED = '/api/customer-display/feed';

function seedUser(db: any, id: string, role: string) {
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'unused-test-hash', ?, 1, ?, ?)`,
  ).run(id, `Staff ${id}`, `${id}@test.local`, role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main(): Promise<void> {
  initDatabase();
  const db = getDatabase();
  const owner = seedUser(db, 'feed-owner', 'owner');

  db.prepare(
    `INSERT INTO customers (id, name, phone, is_active, created_at, updated_at)
     VALUES ('feed-customer', 'Hidden Customer', '+15559990000', 1, ?, ?)`,
  ).run(now(), now());

  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, customer_id, user_id, special_instructions, status, created_at, updated_at)
     VALUES (?, 'feed-customer', 'feed-owner', 'private note', ?, ?, ?)`,
  );

  const eligibleStatuses = ['pending', 'preparing', 'ready'] as const;
  const expectedEligibleNumbers: string[] = [];

  for (let i = 1; i <= 230; i += 1) {
    const number = `E-${String(i).padStart(3, '0')}`;
    const status = eligibleStatuses[(i - 1) % eligibleStatuses.length];
    // Orders 125..136 share an identical timestamp across the page 1 / page 2 boundary (130/131)
    // to exercise tie-breaking by id.
    const minuteBucket = i >= 125 && i <= 136 ? 130 : i;
    const hh = String(Math.floor(minuteBucket / 60)).padStart(2, '0');
    const mm = String(minuteBucket % 60).padStart(2, '0');
    const stamp = `2026-02-01 ${hh}:${mm}:00`;
    insertOrder.run(number, status, stamp, stamp);
    expectedEligibleNumbers.push(number);
  }

  for (let i = 1; i <= 1000; i += 1) {
    const stamp = `2026-01-01 01:${String(i % 60).padStart(2, '0')}:30`;
    insertOrder.run(`DONE-${i}`, i % 2 === 0 ? 'completed' : 'cancelled', stamp, stamp);
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    expressRateLimit({
      windowMs: 60 * 1000,
      limit: 1000,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(requireAuth);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/customer-display', customerDisplayFeedRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/bills', billRoutes);
  app.use('/api/kds', kdsRoutes);

  const created = await request(app).post(TOKENS).set(owner).send({ label: 'Queue TV' });
  assert.equal(created.status, 201);
  const display = { Authorization: `Bearer ${created.body.token}` };

  // Page 1: newest 100 eligible orders (E-131 .. E-230), returned in ASC order within the page
  const page1 = await request(app).get(FEED).set(display);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.has_more, true, 'page 1 reports more pages available');
  assert.equal(typeof page1.body.next_cursor, 'string', 'page 1 returns a cursor string');
  assert.ok(page1.body.next_cursor.length > 0, 'page 1 cursor is non-empty');
  assert.equal(page1.body.orders.length, 100, 'page 1 contains 100 orders');
  assert.deepEqual(
    page1.body.orders.map((o: any) => o.number),
    expectedEligibleNumbers.slice(130, 230),
    'page 1 contains E-131..E-230 in chronological ASC order',
  );

  // Page 2: next 100 older eligible orders (E-031 .. E-130), returned in ASC order within the page
  let capturedCursorSql = '';
  let capturedCursorParams: unknown[] = [];
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (sql.includes('FROM orders o')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        capturedCursorSql = sql;
        capturedCursorParams = params;
        return origAll(...params);
      };
    }
    return stmt;
  };
  const page2 = await request(app)
    .get(`${FEED}?cursor=${encodeURIComponent(page1.body.next_cursor)}`)
    .set(display);
  db.prepare = origPrepare;
  assert.equal(page2.status, 200);
  assert.ok(capturedCursorSql.length > 0, 'captured cursor SQL statement');
  const cursorQueryPlan = db
    .prepare(`EXPLAIN QUERY PLAN ${capturedCursorSql}`)
    .all(...capturedCursorParams) as Array<{ detail: string }>;
  const planDetails = cursorQueryPlan.map((row) => row.detail).join(' | ');
  assert.ok(
    planDetails.includes('USING INDEX idx_orders_status (status=?)'),
    `cursor query stays status-selective on idx_orders_status (got: ${planDetails})`,
  );
  assert.ok(
    capturedCursorSql.includes('o.created_at <= ?'),
    'cursor query includes created_at range bound on cursor pages',
  );
  assert.equal(page2.body.has_more, true, 'page 2 reports more pages available');
  assert.equal(typeof page2.body.next_cursor, 'string', 'page 2 returns a second cursor string');
  assert.notEqual(page2.body.next_cursor, page1.body.next_cursor, 'page 2 cursor advances');
  assert.equal(page2.body.orders.length, 100, 'page 2 contains 100 orders');
  assert.deepEqual(
    page2.body.orders.map((o: any) => o.number),
    expectedEligibleNumbers.slice(30, 130),
    'page 2 contains E-031..E-130 in chronological ASC order with exact tie-breaking across shared timestamps',
  );

  // Page 3: oldest 30 eligible orders (E-001 .. E-030), returned in ASC order with no next cursor
  let page3CursorSql = '';
  let page3CursorParams: unknown[] = [];
  db.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (sql.includes('FROM orders o')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        page3CursorSql = sql;
        page3CursorParams = params;
        return origAll(...params);
      };
    }
    return stmt;
  };
  const page3 = await request(app)
    .get(`${FEED}?cursor=${encodeURIComponent(page2.body.next_cursor)}`)
    .set(display);
  db.prepare = origPrepare;
  assert.equal(page3.status, 200);
  const scannedStatuses: string[] = [];
  db.function('track_scanned_status', (status: string) => {
    scannedStatuses.push(status);
    return 1;
  });
  db.prepare(page3CursorSql.replace('WHERE', 'WHERE track_scanned_status(o.status) = 1 AND')).all(
    ...page3CursorParams,
  );
  const closedOrdersScanned = scannedStatuses.filter(
    (status) => status === 'completed' || status === 'cancelled',
  ).length;
  assert.equal(
    closedOrdersScanned,
    0,
    `terminal cursor page does not scan closed sales history (scanned ${closedOrdersScanned} of 1000 closed orders)`,
  );
  assert.equal(page3.body.has_more, false, 'page 3 is the terminal page');
  assert.equal(page3.body.next_cursor, null, 'page 3 has null next_cursor');
  assert.equal(page3.body.orders.length, 30, 'page 3 contains the oldest 30 orders');
  assert.deepEqual(
    page3.body.orders.map((o: any) => o.number),
    expectedEligibleNumbers.slice(0, 30),
    'page 3 contains E-001..E-030 in chronological ASC order',
  );

  // Union across all pages (oldest page to newest page) has all 230 eligible orders without duplicates or PII
  const merged = [...page3.body.orders, ...page2.body.orders, ...page1.body.orders];
  assert.equal(merged.length, 230, 'all 230 eligible orders are returned across pages 1-3');
  assert.equal(new Set(merged.map((o: any) => o.id)).size, 230, 'zero duplicate order IDs');
  assert.deepEqual(
    merged.map((o: any) => o.number),
    expectedEligibleNumbers,
    'merged pages reconstruct the complete 230-order queue oldest-first',
  );
  for (const order of merged) {
    assert.deepEqual(Object.keys(order).sort(), ['id', 'number', 'status']);
    assert.ok(!order.number.startsWith('DONE-'), 'completed and cancelled orders never appear');
  }
  const serialized = JSON.stringify([page1.body, page2.body, page3.body]);
  for (const secret of ['Hidden Customer', '+15559990000', 'private note', 'feed-owner']) {
    assert.ok(!serialized.includes(secret), `feed pages never leak ${secret}`);
  }

  for (const badQuery of [
    'cursor=',
    'cursor=not-valid-base64!',
    `cursor=${Buffer.from('not-json').toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ created_at: '', id: 10 })).toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ created_at: '2026-02-01 00:01:00', id: 0 })).toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ created_at: '2026-02-01 00:01:00', id: '10' })).toString('base64url')}`,
  ]) {
    const badRes = await request(app).get(`${FEED}?${badQuery}`).set(display);
    assert.equal(badRes.status, 400, `malformed query ?${badQuery} returns 400`);
  }

  // Unauthenticated request with cursor still returns 401 before parameter parsing
  assert.equal((await request(app).get(`${FEED}?cursor=invalid`)).status, 401);

  // Seed 270 additional eligible orders (500 total = 5 pages) and verify repeated 5-page polls stay within the real 120 req/min rate limit
  for (let i = 231; i <= 500; i += 1) {
    const number = `E-${String(i).padStart(3, '0')}`;
    const status = eligibleStatuses[(i - 1) % eligibleStatuses.length];
    const hh = String(Math.floor(i / 60)).padStart(2, '0');
    const mm = String(i % 60).padStart(2, '0');
    const stamp = `2026-02-01 ${hh}:${mm}:00`;
    insertOrder.run(number, status, stamp, stamp);
  }
  const freshTokenRes = await request(app)
    .post(TOKENS)
    .set(owner)
    .send({ label: '500 Order Queue TV' });
  assert.equal(freshTokenRes.status, 201);
  const fivePageDisplay = { Authorization: `Bearer ${freshTokenRes.body.token}` };
  for (let poll = 0; poll < 20; poll += 1) {
    let cursor: string | null = null;
    let pollOrders = 0;
    let pagesInPoll = 0;
    do {
      const url: string = cursor ? `${FEED}?cursor=${encodeURIComponent(cursor)}` : FEED;
      const res = await request(app).get(url).set(fivePageDisplay);
      assert.equal(
        res.status,
        200,
        `poll ${poll + 1} page ${pagesInPoll + 1} succeeds without 429`,
      );
      pollOrders += res.body.orders.length;
      pagesInPoll += 1;
      cursor = res.body.has_more ? res.body.next_cursor : null;
    } while (cursor);
    assert.equal(pagesInPoll, 5, '500 eligible orders drain in 5 pages');
    assert.equal(pollOrders, 500, 'each 5-page poll returns all 500 eligible orders');
  }

  // Regression for #1401: prepaid completed orders within the rolling 24h window with active KDS items
  // project board status without mutating orders.status or scanning historical (>24h) paid orders.
  app.set('trust proxy', 1);
  const prepaidDisplay = { ...fivePageDisplay, 'X-Forwarded-For': '127.0.0.2' };
  const testAnchorMs = Date.now();
  const utcFromAnchor = (offsetSeconds: number): string =>
    new Date(testAnchorMs + offsetSeconds * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('feed-cat', 'Cafe', 1)`).run();
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order)
     VALUES ('feed-prod-1', 'feed-cat', 'Espresso', 5, 1, 1),
            ('feed-prod-2', 'feed-cat', 'Muffin', 4, 1, 2)`,
  ).run();

  // Attach positive-quantity pending/ready KDS items to all 500 historical (>24h) DONE-* completed orders
  // (simulating stores with KDS-off history or ready-settled history) and prove zero leak onto either board.
  const historicalCompletedRows = db
    .prepare(
      `SELECT id, created_at FROM orders WHERE order_number LIKE 'DONE-%' AND status = 'completed'`,
    )
    .all() as Array<{ id: number; created_at: string }>;
  assert.equal(historicalCompletedRows.length, 500, '500 historical completed orders exist');
  const historicalCompletedIdSet = new Set(historicalCompletedRows.map((r) => r.id));
  const insertHistoricalItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, 'feed-prod-1', 'Espresso', 5, 1, 5, 0, 5, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let idx = 0; idx < historicalCompletedRows.length; idx += 1) {
      const row = historicalCompletedRows[idx];
      insertHistoricalItem.run(
        row.id,
        idx % 2 === 0 ? 'pending' : 'ready',
        row.created_at,
        row.created_at,
      );
    }
  })();

  const prepaidStamp = utcFromAnchor(-3 * 3600);
  const prepaidInsert = db
    .prepare(
      `INSERT INTO orders (order_number, customer_id, user_id, type, status, subtotal, total, completed_at, created_at, updated_at)
       VALUES ('PREPAID-001', 'feed-customer', 'feed-owner', 'takeaway', 'completed', 9, 9, ?, ?, ?)`,
    )
    .run(prepaidStamp, prepaidStamp, prepaidStamp);
  const prepaidOrderId = Number(prepaidInsert.lastInsertRowid);
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
     VALUES ('BILL-PREPAID-001', ?, 9, 0, 9, 9, 0, 'paid', ?, ?, ?)`,
  ).run(prepaidOrderId, prepaidStamp, prepaidStamp, prepaidStamp);
  const prepaidItem1 = Number(
    db
      .prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
         VALUES (?, 'feed-prod-1', 'Espresso', 5, 1, 5, 0, 5, 'pending', ?, ?)`,
      )
      .run(prepaidOrderId, prepaidStamp, prepaidStamp).lastInsertRowid,
  );
  const prepaidItem2 = Number(
    db
      .prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
         VALUES (?, 'feed-prod-2', 'Muffin', 4, 1, 4, 0, 4, 'pending', ?, ?)`,
      )
      .run(prepaidOrderId, prepaidStamp, prepaidStamp).lastInsertRowid,
  );

  // [pending, pending] -> projected 'pending' with bill number, orders.status untouched ('completed')
  let prepaidFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(prepaidFeed.status, 200);
  let prepaidEntry = prepaidFeed.body.orders.find((o: any) => o.id === prepaidOrderId);
  assert.deepEqual(
    prepaidEntry,
    { id: prepaidOrderId, number: 'BILL-PREPAID-001', status: 'pending' },
    'prepaid completed order with pending KDS items appears on feed with projected pending status and bill number',
  );
  assert.equal(
    (db.prepare('SELECT status FROM orders WHERE id = ?').get(prepaidOrderId) as any).status,
    'completed',
    'orders.status remains completed',
  );

  // [ready, pending] -> projected 'preparing'
  db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(prepaidItem1);
  prepaidFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(prepaidFeed.status, 200);
  prepaidEntry = prepaidFeed.body.orders.find((o: any) => o.id === prepaidOrderId);
  assert.deepEqual(
    prepaidEntry,
    { id: prepaidOrderId, number: 'BILL-PREPAID-001', status: 'preparing' },
    'prepaid completed order with 1-of-2 ready projects preparing status',
  );

  // CustomerDisplayConfig.statuses = ['ready'] hides preparing prepaid order
  const readyOnlyRes = await request(app)
    .put('/api/settings/customer-display')
    .set(owner)
    .send({ statuses: ['ready'], refresh_seconds: 3, show_updated: true });
  assert.equal(readyOnlyRes.status, 200);
  prepaidFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(prepaidFeed.status, 200);
  assert.equal(
    prepaidFeed.body.orders.some((o: any) => o.id === prepaidOrderId),
    false,
    'ready-only CustomerDisplayConfig excludes preparing prepaid order',
  );

  // [ready, ready] -> projected 'ready', now included in ready-only config!
  db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(prepaidItem2);
  prepaidFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(prepaidFeed.status, 200);
  prepaidEntry = prepaidFeed.body.orders.find((o: any) => o.id === prepaidOrderId);
  assert.deepEqual(
    prepaidEntry,
    { id: prepaidOrderId, number: 'BILL-PREPAID-001', status: 'ready' },
    'prepaid completed order with 2-of-2 ready projects ready status and passes ready-only filter',
  );

  // Restore default display config
  await request(app)
    .put('/api/settings/customer-display')
    .set(owner)
    .send({ statuses: ['pending', 'preparing', 'ready'], refresh_seconds: 3, show_updated: true });

  // Verify bounded index usage on completed-candidate batch query, zero closed-history scan on FROM orders o,
  // zero inspection of >24h completed orders, and bills lookup strictly bounded to final pageRows (<= 100).
  let capturedCompletedBatchSql = '';
  let capturedCompletedBatchParams: unknown[] = [];
  let closedScannedDuringMerge = 0;
  const completedCandidatesInspected: number[] = [];
  const billLookupWidths: number[] = [];
  db.function('track_scanned_status_merge', (status: string) => {
    if (status === 'completed' || status === 'cancelled') closedScannedDuringMerge += 1;
    return 1;
  });
  db.function('track_completed_candidate', (id: number) => {
    completedCandidatesInspected.push(Number(id));
    return 1;
  });
  db.prepare = (sql: string) => {
    if (sql.includes('FROM orders o')) {
      return origPrepare(
        sql.replace(
          'WHERE o.status IN',
          'WHERE track_scanned_status_merge(o.status) AND o.status IN',
        ),
      );
    }
    if (sql.includes('FROM orders co')) {
      const instrumented = sql.replace(
        'AND EXISTS (',
        'AND track_completed_candidate(co.id) = 1 AND EXISTS (',
      );
      const stmt = origPrepare(instrumented);
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        if (!capturedCompletedBatchSql) {
          capturedCompletedBatchSql = sql;
          capturedCompletedBatchParams = params;
        }
        return origAll(...params);
      };
      return stmt;
    }
    const stmt = origPrepare(sql);
    if (sql.includes('FROM bills') && sql.includes('WHERE order_id IN')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        billLookupWidths.push(params.length);
        return origAll(...params);
      };
    }
    return stmt;
  };
  const drainIds: number[] = [];
  let drainCursor: string | null = null;
  do {
    const url: string = drainCursor ? `${FEED}?cursor=${encodeURIComponent(drainCursor)}` : FEED;
    const res = await request(app).get(url).set(prepaidDisplay);
    assert.equal(res.status, 200);
    for (const o of res.body.orders) drainIds.push(o.id);
    drainCursor = res.body.has_more ? res.body.next_cursor : null;
  } while (drainCursor);
  db.prepare = origPrepare;
  assert.equal(
    drainIds.length,
    501,
    'all 500 non-completed active orders (unbounded by age) + 1 recent prepaid order drain across cursor pages',
  );
  assert.equal(new Set(drainIds).size, 501, 'zero duplicate IDs across active + prepaid merge');
  assert.equal(
    closedScannedDuringMerge,
    0,
    'zero closed sales history rows scanned on FROM orders o',
  );
  assert.equal(
    completedCandidatesInspected.filter((id) => historicalCompletedIdSet.has(id)).length,
    0,
    'zero >24h historical completed orders inspected by completed-candidate batch query',
  );
  assert.ok(billLookupWidths.length > 0, 'bills lookup executed for non-empty pages');
  assert.ok(
    billLookupWidths.every((width) => width <= 100),
    `bills lookup resolves bill_number only for final selected pageRows <= 100 (got widths: ${billLookupWidths.join(',')})`,
  );
  assert.ok(capturedCompletedBatchSql.length > 0, 'captured completed-candidate batch query');
  const completedBatchPlan = db
    .prepare(`EXPLAIN QUERY PLAN ${capturedCompletedBatchSql}`)
    .all(...capturedCompletedBatchParams) as Array<{ detail: string }>;
  const completedBatchPlanText = completedBatchPlan.map((r) => r.detail).join(' | ');
  assert.ok(
    completedBatchPlanText.includes('idx_orders_created') &&
      completedBatchPlanText.includes('idx_order_items_active_kds') &&
      !completedBatchPlanText.includes('TEMP B-TREE'),
    `completed-candidate batch query uses idx_orders_created + idx_order_items_active_kds without TEMP B-TREE (got: ${completedBatchPlanText})`,
  );

  const zeroQtyOrderId = Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, customer_id, user_id, type, status, subtotal, total, completed_at, created_at, updated_at)
         VALUES ('ZERO-QTY-001', 'feed-customer', 'feed-owner', 'takeaway', 'completed', 0, 0, ?, ?, ?)`,
      )
      .run(prepaidStamp, prepaidStamp, prepaidStamp).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, 'feed-prod-1', 'Espresso', 5, 0, 0, 0, 0, 'pending', ?, ?)`,
  ).run(zeroQtyOrderId, prepaidStamp, prepaidStamp);

  let capturedActiveViewPage1Sql = '';
  let capturedActiveViewPage1Params: unknown[] = [];
  let capturedActiveViewCursorSql = '';
  let capturedActiveViewCursorParams: unknown[] = [];
  let capturedActiveViewFinalSql = '';
  let capturedActiveViewFinalParams: unknown[] = [];
  const perPageOuterEvaluated: number[] = [];
  let closedHistoricalOuterEvaluated = 0;
  let coHistoricalEvaluated = 0;
  let currentOuterEvaluated = 0;
  db.function('track_active_outer_row', (id: number, status: string) => {
    currentOuterEvaluated += 1;
    if (status === 'cancelled' || historicalCompletedIdSet.has(Number(id))) {
      closedHistoricalOuterEvaluated += 1;
    }
    return 1;
  });
  db.function('track_active_co_row', (id: number) => {
    if (historicalCompletedIdSet.has(Number(id))) {
      coHistoricalEvaluated += 1;
    }
    return 1;
  });
  let activeViewCallIndex = 0;
  db.prepare = (sql: string) => {
    if (sql.includes('SELECT orders.* FROM orders')) {
      activeViewCallIndex += 1;
      const callIdx = activeViewCallIndex;
      const instrumentedSql = sql
        .replace(
          'WHERE orders.id IN (',
          'WHERE track_active_outer_row(orders.id, orders.status) = 1 AND orders.id IN (',
        )
        .replace('AND EXISTS (', 'AND track_active_co_row(co.id) = 1 AND EXISTS (');
      const stmt = origPrepare(instrumentedSql);
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        currentOuterEvaluated = 0;
        const rows = origAll(...params);
        perPageOuterEvaluated.push(currentOuterEvaluated);
        if (callIdx === 1) {
          capturedActiveViewPage1Sql = sql;
          capturedActiveViewPage1Params = params;
        } else if (callIdx === 2) {
          capturedActiveViewCursorSql = sql;
          capturedActiveViewCursorParams = params;
        }
        capturedActiveViewFinalSql = sql;
        capturedActiveViewFinalParams = params;
        return rows;
      };
      return stmt;
    }
    return origPrepare(sql);
  };
  const authActiveIds: number[] = [];
  let beforeId: number | string | null = null;
  do {
    const qs =
      beforeId !== null
        ? `view=active&per_page=100&before_id=${beforeId}`
        : 'view=active&per_page=100';
    const res = await request(app)
      .get(`/api/orders?${qs}`)
      .set({ ...owner, 'X-Forwarded-For': '127.0.0.3' });
    assert.equal(res.status, 200);
    for (const o of res.body.orders) authActiveIds.push(o.id);
    beforeId = res.body.nextCursor ?? null;
  } while (beforeId !== null);
  db.prepare = origPrepare;

  assert.equal(
    authActiveIds.length,
    501,
    'authenticated view=active drains 500 active + 1 recent prepaid order and excludes all 500 >24h completed orders',
  );
  assert.equal(
    new Set(authActiveIds).size,
    501,
    'authenticated view=active returns unique order IDs',
  );
  assert.equal(
    authActiveIds.includes(zeroQtyOrderId),
    false,
    'completed order with 0-quantity pending item is excluded from view=active',
  );
  assert.equal(
    perPageOuterEvaluated.length,
    6,
    'authenticated view=active drains 501 active orders across 6 pages',
  );
  assert.equal(
    closedHistoricalOuterEvaluated,
    0,
    'zero closed historical orders evaluated across all 6 drained pages including final page',
  );
  assert.equal(
    coHistoricalEvaluated,
    0,
    'zero >24h historical completed orders evaluated inside completed projection subquery',
  );
  assert.ok(
    perPageOuterEvaluated.every((count) => count === 501),
    `every drained page including final page 6 evaluates only the 501 active candidates (got ${perPageOuterEvaluated.join(',')})`,
  );
  const statusActiveRes = await request(app)
    .get('/api/orders?status=active&per_page=500')
    .set({ ...owner, 'X-Forwarded-For': '127.0.0.3' });
  assert.equal(statusActiveRes.status, 200);
  assert.equal(
    statusActiveRes.body.orders.some((o: any) => o.id === zeroQtyOrderId),
    false,
    'completed order with 0-quantity pending item is excluded from status=active',
  );
  assert.equal(
    statusActiveRes.body.orders.some((o: any) => historicalCompletedIdSet.has(o.id)),
    false,
    '>24h historical completed orders are excluded from status=active',
  );
  for (const [label, sql, params] of [
    ['page 1', capturedActiveViewPage1Sql, capturedActiveViewPage1Params],
    ['cursor page 2', capturedActiveViewCursorSql, capturedActiveViewCursorParams],
    ['final cursor page', capturedActiveViewFinalSql, capturedActiveViewFinalParams],
  ] as const) {
    assert.ok(sql.length > 0, `captured authenticated view=active SQL for ${label}`);
    const planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>;
    const planText = planRows.map((r) => r.detail).join(' | ');
    assert.ok(
      planText.includes('SEARCH orders USING INTEGER PRIMARY KEY') &&
        planText.includes('USING COVERING INDEX idx_orders_status') &&
        planText.includes('USING INDEX idx_orders_created') &&
        planText.includes('idx_order_items_active_kds') &&
        !planText.includes('SCAN orders') &&
        !planText.includes('SCAN co'),
      `authenticated view=active ${label} narrows active orders via idx_orders_status + idx_orders_created + idx_order_items_active_kds without scanning orders (got: ${planText})`,
    );
  }

  // Real API payment-flow regressions:
  // (A) KDS-disabled settlement leaves order_items.status='pending' while settling orders.status='completed';
  //     once >24h old, enabling KDS must NOT resurface it on signed-in or paired feeds.
  const ownerApi = { ...owner, 'X-Forwarded-For': '127.0.0.4' };
  for (const [key, value] of [
    ['country', 'IN'],
    ['currency', 'INR'],
    ['currency_symbol', '₹'],
    ['timezone', 'Asia/Kolkata'],
  ] as const) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      key,
      value,
      now(),
    );
  }
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'false', ?)",
  ).run(now());
  const kdsOffOrderRes = await request(app)
    .post('/api/orders')
    .set(ownerApi)
    .send({ type: 'takeaway', items: [{ product_id: 'feed-prod-1', quantity: 1 }] });
  assert.equal(kdsOffOrderRes.status, 201);
  const kdsOffOrderId = Number(kdsOffOrderRes.body.order.id);
  const kdsOffBillRes = await request(app)
    .post('/api/bills/generate')
    .set(ownerApi)
    .send({ order_id: kdsOffOrderId });
  assert.equal(kdsOffBillRes.status, 201);
  const kdsOffPayRes = await request(app)
    .post(`/api/bills/${kdsOffBillRes.body.bill.id}/payment`)
    .set(ownerApi)
    .send({ method: 'card', amount: kdsOffBillRes.body.bill.total });
  assert.equal(kdsOffPayRes.status, 200);
  assert.equal(
    (db.prepare('SELECT status FROM orders WHERE id = ?').get(kdsOffOrderId) as any).status,
    'completed',
  );
  assert.equal(
    (db.prepare('SELECT status FROM order_items WHERE order_id = ?').get(kdsOffOrderId) as any)
      .status,
    'pending',
  );
  const expired25hStamp = utcFromAnchor(-25 * 3600);
  db.prepare('UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?').run(
    expired25hStamp,
    expired25hStamp,
    kdsOffOrderId,
  );
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)",
  ).run(now());

  // (B) KDS-enabled settlement at 'ready' leaves order_items.status='ready' while orders.status='completed';
  //     included while recent (<24h), excluded once >24h old.
  const kdsOnOrderRes = await request(app)
    .post('/api/orders')
    .set(ownerApi)
    .send({ type: 'takeaway', items: [{ product_id: 'feed-prod-1', quantity: 1 }] });
  assert.equal(kdsOnOrderRes.status, 201);
  const kdsOnOrderId = Number(kdsOnOrderRes.body.order.id);
  const kdsOnItemId = Number(kdsOnOrderRes.body.order.items[0].id);
  assert.equal(
    (
      await request(app)
        .patch(`/api/kds/items/${kdsOnItemId}/status`)
        .set(ownerApi)
        .send({ status: 'preparing' })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .patch(`/api/kds/items/${kdsOnItemId}/status`)
        .set(ownerApi)
        .send({ status: 'ready' })
    ).status,
    200,
  );
  const kdsOnBillRes = await request(app)
    .post('/api/bills/generate')
    .set(ownerApi)
    .send({ order_id: kdsOnOrderId });
  assert.equal(kdsOnBillRes.status, 201);
  const kdsOnPayRes = await request(app)
    .post(`/api/bills/${kdsOnBillRes.body.bill.id}/payment`)
    .set(ownerApi)
    .send({ method: 'card', amount: kdsOnBillRes.body.bill.total });
  assert.equal(kdsOnPayRes.status, 200);

  // While recent (<24h), kdsOnOrderId appears on paired feed + view=active + status=active, while >24h kdsOffOrderId does not
  const recentCheckFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(recentCheckFeed.status, 200);
  assert.equal(
    recentCheckFeed.body.orders.some((o: any) => o.id === kdsOffOrderId),
    false,
    '>24h KDS-disabled paid pending order is excluded from paired feed after KDS is enabled',
  );
  assert.deepEqual(
    recentCheckFeed.body.orders.find((o: any) => o.id === kdsOnOrderId),
    { id: kdsOnOrderId, number: kdsOnBillRes.body.bill.bill_number, status: 'ready' },
    'recent <24h KDS-enabled paid ready order projects ready with bill_number on paired feed',
  );
  const recentViewActive = await request(app)
    .get('/api/orders?view=active&per_page=50')
    .set(ownerApi);
  assert.equal(
    recentViewActive.body.orders.some((o: any) => o.id === kdsOffOrderId),
    false,
    '>24h KDS-disabled paid pending order is excluded from view=active',
  );
  assert.equal(
    recentViewActive.body.orders.some((o: any) => o.id === kdsOnOrderId),
    true,
    'recent <24h KDS-enabled paid ready order is included in view=active',
  );
  const recentStatusActive = await request(app)
    .get('/api/orders?status=active&per_page=50')
    .set(ownerApi);
  assert.equal(
    recentStatusActive.body.orders.some((o: any) => o.id === kdsOffOrderId),
    false,
    '>24h KDS-disabled paid pending order is excluded from status=active',
  );
  assert.equal(
    recentStatusActive.body.orders.some((o: any) => o.id === kdsOnOrderId),
    true,
    'recent <24h KDS-enabled paid ready order is included in status=active',
  );

  // Age kdsOnOrderId past 24h -> now excluded from paired feed, view=active, and status=active
  db.prepare('UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?').run(
    expired25hStamp,
    expired25hStamp,
    kdsOnOrderId,
  );
  assert.equal(
    (await request(app).get(FEED).set(prepaidDisplay)).body.orders.some(
      (o: any) => o.id === kdsOnOrderId,
    ),
    false,
    '>24h KDS-enabled paid ready order ages off paired feed',
  );
  assert.equal(
    (await request(app).get('/api/orders?view=active&per_page=50').set(ownerApi)).body.orders.some(
      (o: any) => o.id === kdsOnOrderId,
    ),
    false,
    '>24h KDS-enabled paid ready order ages off view=active',
  );
  assert.equal(
    (
      await request(app).get('/api/orders?status=active&per_page=50').set(ownerApi)
    ).body.orders.some((o: any) => o.id === kdsOnOrderId),
    false,
    '>24h KDS-enabled paid ready order ages off status=active',
  );

  // Exact 24-hour cutoff boundary: created_at === cutoff is included; cutoff - 1s is excluded.
  const origDateNow = Date.now;
  const pinnedBoundaryNowMs = Math.floor(testAnchorMs / 1000) * 1000 + 10 * 60 * 1000;
  const exactCutoffStamp = completedKdsProjectionCutoff(pinnedBoundaryNowMs);
  const oneSecondOlderStamp = completedKdsProjectionCutoff(pinnedBoundaryNowMs - 1000);
  assert.notEqual(exactCutoffStamp, oneSecondOlderStamp);
  const boundaryInclusiveId = Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, customer_id, user_id, type, status, subtotal, total, completed_at, created_at, updated_at)
         VALUES ('BOUNDARY-INCLUSIVE', 'feed-customer', 'feed-owner', 'takeaway', 'completed', 5, 5, ?, ?, ?)`,
      )
      .run(exactCutoffStamp, exactCutoffStamp, exactCutoffStamp).lastInsertRowid,
  );
  const boundaryExpiredId = Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, customer_id, user_id, type, status, subtotal, total, completed_at, created_at, updated_at)
         VALUES ('BOUNDARY-EXPIRED', 'feed-customer', 'feed-owner', 'takeaway', 'completed', 5, 5, ?, ?, ?)`,
      )
      .run(oneSecondOlderStamp, oneSecondOlderStamp, oneSecondOlderStamp).lastInsertRowid,
  );
  insertHistoricalItem.run(boundaryInclusiveId, 'pending', exactCutoffStamp, exactCutoffStamp);
  insertHistoricalItem.run(boundaryExpiredId, 'pending', oneSecondOlderStamp, oneSecondOlderStamp);
  try {
    Date.now = () => pinnedBoundaryNowMs;
    const boundaryFeed = await request(app).get(FEED).set(prepaidDisplay);
    assert.equal(boundaryFeed.status, 200);
    assert.equal(
      boundaryFeed.body.orders.some((o: any) => o.id === boundaryInclusiveId),
      true,
      'completed order at exact 24h cutoff (created_at === cutoff) is included on paired feed',
    );
    assert.equal(
      boundaryFeed.body.orders.some((o: any) => o.id === boundaryExpiredId),
      false,
      'completed order 1s older than 24h cutoff is excluded from paired feed',
    );
    const boundaryViewRes = await request(app)
      .get('/api/orders?view=active&per_page=50')
      .set(ownerApi);
    assert.equal(boundaryViewRes.status, 200);
    assert.equal(
      boundaryViewRes.body.orders.some((o: any) => o.id === boundaryInclusiveId),
      true,
      'completed order at exact 24h cutoff is included in view=active',
    );
    assert.equal(
      boundaryViewRes.body.orders.some((o: any) => o.id === boundaryExpiredId),
      false,
      'completed order 1s older than 24h cutoff is excluded from view=active',
    );
    const boundaryStatusRes = await request(app)
      .get('/api/orders?status=active&per_page=50')
      .set(ownerApi);
    assert.equal(boundaryStatusRes.status, 200);
    assert.equal(
      boundaryStatusRes.body.orders.some((o: any) => o.id === boundaryInclusiveId),
      true,
      'completed order at exact 24h cutoff is included in status=active',
    );
    assert.equal(
      boundaryStatusRes.body.orders.some((o: any) => o.id === boundaryExpiredId),
      false,
      'completed order 1s older than 24h cutoff is excluded from status=active',
    );
  } finally {
    Date.now = origDateNow;
    db.prepare('DELETE FROM order_items WHERE order_id IN (?, ?)').run(
      boundaryInclusiveId,
      boundaryExpiredId,
    );
    db.prepare('DELETE FROM orders WHERE id IN (?, ?)').run(boundaryInclusiveId, boundaryExpiredId);
  }

  // KDS disabled excludes completed orders even if items are still ready/pending
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'false', ?)",
  ).run(now());
  prepaidFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(prepaidFeed.status, 200);
  assert.equal(
    prepaidFeed.body.orders.some((o: any) => o.id === prepaidOrderId),
    false,
    'KDS-disabled mode omits completed orders from customer display feed',
  );
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)",
  ).run(now());

  // [served, served] -> exits customer display feed automatically while orders.status remains 'completed'
  db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(prepaidOrderId);
  prepaidFeed = await request(app).get(FEED).set(prepaidDisplay);
  assert.equal(prepaidFeed.status, 200);
  assert.equal(
    prepaidFeed.body.orders.some((o: any) => o.id === prepaidOrderId),
    false,
    'prepaid completed order automatically leaves customer display feed once all live items are served',
  );
  assert.equal(
    (db.prepare('SELECT status FROM orders WHERE id = ?').get(prepaidOrderId) as any).status,
    'completed',
    'orders.status stays completed after all items served',
  );

  // Multi-batch status skipping (> 200 candidates) + equal-timestamp keyset ties across batch & page boundaries:
  // Under statuses=['ready'], 225 newer (<24h) completed orders with [ready, pending] items project 'preparing'
  // (skipped across the 200-row batch boundary, including shared timestamps across 195..206) to reach 15 older
  // (<24h) completed orders whose items project 'ready', also sharing timestamps with active 'ready' orders.
  assert.equal(
    (
      await request(app)
        .put('/api/settings/customer-display')
        .set(ownerApi)
        .send({ statuses: ['ready'], refresh_seconds: 3, show_updated: true })
    ).status,
    200,
  );
  const skippedPreparingIds = new Set<number>();
  const expectedBatchReadyCompletedIds: number[] = [];
  const sharedBatchBoundaryStamp = utcFromAnchor(-1800);
  const sharedPageTieStamp = utcFromAnchor(-7200);
  const insertBatchOrder = db.prepare(
    `INSERT INTO orders (order_number, customer_id, user_id, type, status, subtotal, total, completed_at, created_at, updated_at)
     VALUES (?, 'feed-customer', 'feed-owner', 'takeaway', ?, 9, 9, ?, ?, ?)`,
  );
  const insertBatchBill = db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
     VALUES (?, ?, 9, 0, 9, 9, 0, 'paid', ?, ?, ?)`,
  );
  db.transaction(() => {
    // Seed 15 older (<24h) completed orders that project 'ready', with 8 sharing sharedPageTieStamp
    for (let i = 1; i <= 15; i += 1) {
      const stamp = i <= 8 ? sharedPageTieStamp : utcFromAnchor(-7000 + i);
      const oid = Number(
        insertBatchOrder.run(`BATCH-READY-${i}`, 'completed', stamp, stamp, stamp).lastInsertRowid,
      );
      insertBatchBill.run(`BILL-BATCH-READY-${i}`, oid, stamp, stamp, stamp);
      insertHistoricalItem.run(oid, 'ready', stamp, stamp);
      expectedBatchReadyCompletedIds.push(oid);
    }
    // Interleave 4 active 'ready' orders at the exact same sharedPageTieStamp
    for (let i = 1; i <= 4; i += 1) {
      insertBatchOrder.run(
        `ACTIVE-TIE-READY-${i}`,
        'ready',
        null,
        sharedPageTieStamp,
        sharedPageTieStamp,
      );
    }
    // Seed 225 newer (<24h) completed orders with [ready, pending] -> projected 'preparing' (skipped under statuses=['ready']).
    // Candidates 19..30 (which land across the 200th DESC candidate boundary) share sharedBatchBoundaryStamp.
    for (let i = 1; i <= 225; i += 1) {
      const stamp = i >= 19 && i <= 30 ? sharedBatchBoundaryStamp : utcFromAnchor(-3600 + i * 10);
      const oid = Number(
        insertBatchOrder.run(`BATCH-SKIP-${i}`, 'completed', stamp, stamp, stamp).lastInsertRowid,
      );
      insertBatchBill.run(`BILL-BATCH-SKIP-${i}`, oid, stamp, stamp, stamp);
      insertHistoricalItem.run(oid, 'ready', stamp, stamp);
      insertHistoricalItem.run(oid, 'pending', stamp, stamp);
      skippedPreparingIds.add(oid);
    }
  })();

  let page1BatchFetches = 0;
  const readyModeBillWidths: number[] = [];
  db.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (sql.includes('FROM orders co')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        page1BatchFetches += 1;
        return origAll(...params);
      };
    } else if (sql.includes('FROM bills') && sql.includes('WHERE order_id IN')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        readyModeBillWidths.push(params.length);
        return origAll(...params);
      };
    }
    return stmt;
  };
  const readyPage1 = await request(app).get(FEED).set(prepaidDisplay);
  db.prepare = origPrepare;
  assert.equal(readyPage1.status, 200);
  assert.ok(
    page1BatchFetches >= 2,
    `statuses=['ready'] advances past first 200 skipped preparing candidates into batch 2+ (batches=${page1BatchFetches})`,
  );
  assert.deepEqual(
    readyModeBillWidths,
    [100],
    'bills lookup on page 1 runs once for the 100 selected pageRows (never for the 225 skipped candidates)',
  );

  const drainedReadyOrders: Array<{ id: number; number: string; status: string }> = [
    ...readyPage1.body.orders,
  ];
  let readyCursor: string | null = readyPage1.body.has_more ? readyPage1.body.next_cursor : null;
  while (readyCursor) {
    const res = await request(app)
      .get(`${FEED}?cursor=${encodeURIComponent(readyCursor)}`)
      .set(prepaidDisplay);
    assert.equal(res.status, 200);
    drainedReadyOrders.push(...res.body.orders);
    readyCursor = res.body.has_more ? res.body.next_cursor : null;
  }

  const drainedReadyIdSet = new Set(drainedReadyOrders.map((o) => o.id));
  assert.equal(
    drainedReadyIdSet.size,
    drainedReadyOrders.length,
    'zero duplicate IDs across multi-batch + shared-timestamp cursor pages',
  );
  for (const o of drainedReadyOrders) {
    assert.equal(
      o.status,
      'ready',
      'every returned order under ready-only config has status ready',
    );
    assert.equal(
      skippedPreparingIds.has(o.id),
      false,
      'none of the 225 skipped preparing completed orders appear',
    );
  }
  for (let idx = 0; idx < expectedBatchReadyCompletedIds.length; idx += 1) {
    const expectedId = expectedBatchReadyCompletedIds[idx];
    const found = drainedReadyOrders.find((o) => o.id === expectedId);
    assert.deepEqual(
      found,
      { id: expectedId, number: `BILL-BATCH-READY-${idx + 1}`, status: 'ready' },
      `older completed ready order BATCH-READY-${idx + 1} reached after skipping >200 preparing candidates`,
    );
  }
  const activeReadyCount = (
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'ready'").get() as { n: number }
  ).n;
  assert.equal(
    drainedReadyOrders.length,
    activeReadyCount + expectedBatchReadyCompletedIds.length,
    'drained ready pages reconstruct exact union of all active ready orders + 15 recent completed ready orders without dropping shared-timestamp ties',
  );

  const steadyKeepReadyIds = expectedBatchReadyCompletedIds.slice(0, 2);
  db.transaction(() => {
    db.prepare(
      `UPDATE orders
       SET status = 'completed',
           completed_at = '2026-01-02 00:00:00',
           created_at = '2026-01-02 00:00:00',
           updated_at = '2026-01-02 00:00:00'
       WHERE status IN ('pending', 'preparing', 'ready', 'served')
         AND order_number NOT IN ('E-001', 'E-002', 'E-003', 'E-004', 'E-005')`,
    ).run();
    db.prepare(
      `UPDATE orders
       SET created_at = '2026-01-02 00:00:00',
           updated_at = '2026-01-02 00:00:00'
       WHERE status = 'completed'
         AND id NOT IN (?, ?, ?, ?)`,
    ).run(steadyKeepReadyIds[0], steadyKeepReadyIds[1], prepaidOrderId, zeroQtyOrderId);
  })();
  const steadyCutoff = completedKdsProjectionCutoff();
  let steadyOuterEvaluated = 0;
  let steadyClosedOuterEvaluated = 0;
  let steadyCoEvaluated = 0;
  db.function('track_steady_outer', (status: string, createdAt: string) => {
    steadyOuterEvaluated += 1;
    if (status === 'cancelled' || (status === 'completed' && createdAt < steadyCutoff)) {
      steadyClosedOuterEvaluated += 1;
    }
    return 1;
  });
  db.function('track_steady_co', () => {
    steadyCoEvaluated += 1;
    return 1;
  });
  db.prepare = (sql: string) => {
    if (sql.includes('SELECT orders.* FROM orders')) {
      return origPrepare(
        sql
          .replace(
            'WHERE orders.id IN (',
            'WHERE track_steady_outer(orders.status, orders.created_at) = 1 AND orders.id IN (',
          )
          .replace('AND EXISTS (', 'AND track_steady_co() = 1 AND EXISTS ('),
      );
    }
    return origPrepare(sql);
  };
  try {
    for (const steadyQuery of [
      'view=active&per_page=100',
      'status=active&per_page=100',
      'view=active&status=active&per_page=100',
    ] as const) {
      steadyOuterEvaluated = 0;
      steadyClosedOuterEvaluated = 0;
      steadyCoEvaluated = 0;
      const steadyRes = await request(app).get(`/api/orders?${steadyQuery}`).set(ownerApi);
      assert.equal(steadyRes.status, 200);
      assert.equal(steadyRes.body.orders.length, 7, `${steadyQuery} returns all 7 active orders`);
      assert.equal(steadyRes.body.nextCursor, undefined, `${steadyQuery} has no nextCursor`);
      assert.equal(
        steadyClosedOuterEvaluated,
        0,
        `${steadyQuery} scans zero closed historical rows when < 100 active orders exist`,
      );
      assert.equal(
        steadyOuterEvaluated,
        7,
        `${steadyQuery} evaluates only the 7 active rows in outer orders`,
      );
      assert.equal(
        steadyCoEvaluated,
        4,
        `${steadyQuery} evaluates only the 4 <24h completed rows once`,
      );
    }
  } finally {
    db.prepare = origPrepare;
  }

  // Regression for Round-2 P2: excluded active statuses (5,000+ newer served, pending, preparing orders
  // and >200 newer <24h completed orders projecting preparing) must never consume signed-in pickup board
  // pagination slots or hide older eligible orders behind the 50-page (5,000-row) client fetch budget.
  db.transaction(() => {
    db.prepare(
      `UPDATE orders
       SET status = 'completed',
           completed_at = '2026-01-02 00:00:00',
           created_at = '2026-01-02 00:00:00',
           updated_at = '2026-01-02 00:00:00'
       WHERE created_at >= '2026-01-03 00:00:00'`,
    ).run();
  })();

  const eligiblePendingStamp = utcFromAnchor(-7200);
  const eligiblePreparingStamp = utcFromAnchor(-7199);
  const eligibleActiveReadyStamp = utcFromAnchor(-7198);
  const eligiblePrepaidReadyStamp = utcFromAnchor(-7197);

  const olderEligibleActivePendingId = Number(
    insertBatchOrder.run(
      'ELIG-ACTIVE-PENDING',
      'pending',
      null,
      eligiblePendingStamp,
      eligiblePendingStamp,
    ).lastInsertRowid,
  );
  const olderEligibleActivePreparingId = Number(
    insertBatchOrder.run(
      'ELIG-ACTIVE-PREPARING',
      'preparing',
      null,
      eligiblePreparingStamp,
      eligiblePreparingStamp,
    ).lastInsertRowid,
  );
  const olderEligibleActiveReadyId = Number(
    insertBatchOrder.run(
      'ELIG-ACTIVE-READY',
      'ready',
      null,
      eligibleActiveReadyStamp,
      eligibleActiveReadyStamp,
    ).lastInsertRowid,
  );
  const olderEligiblePrepaidReadyId = Number(
    insertBatchOrder.run(
      'ELIG-PREPAID-READY',
      'completed',
      eligiblePrepaidReadyStamp,
      eligiblePrepaidReadyStamp,
      eligiblePrepaidReadyStamp,
    ).lastInsertRowid,
  );
  insertBatchBill.run(
    'BILL-ELIG-PREPAID-READY',
    olderEligiblePrepaidReadyId,
    eligiblePrepaidReadyStamp,
    eligiblePrepaidReadyStamp,
    eligiblePrepaidReadyStamp,
  );
  insertHistoricalItem.run(
    olderEligiblePrepaidReadyId,
    'ready',
    eligiblePrepaidReadyStamp,
    eligiblePrepaidReadyStamp,
  );
  insertHistoricalItem.run(
    olderEligiblePrepaidReadyId,
    'served',
    eligiblePrepaidReadyStamp,
    eligiblePrepaidReadyStamp,
  );

  // Seed 5,000 newer served active orders ahead of the 4 older eligible orders
  db.transaction(() => {
    for (let i = 1; i <= 5000; i += 1) {
      const stamp = utcFromAnchor(-6000 + Math.floor(i / 2));
      insertBatchOrder.run(
        `EXCL-SERVED-${String(i).padStart(4, '0')}`,
        'served',
        null,
        stamp,
        stamp,
      );
    }
  })();

  const signedInOwnerDefault = { ...owner, 'X-Forwarded-For': '127.0.0.10' };
  const pairedBudgetDisplay = { ...fivePageDisplay, 'X-Forwarded-For': '127.0.0.11' };

  const defaultConfig = {
    statuses: ['pending', 'preparing', 'ready'] as Array<'pending' | 'preparing' | 'ready'>,
    refresh_seconds: 3,
    show_updated: true,
  };
  assert.equal(
    (
      await request(app)
        .put('/api/settings/customer-display')
        .set(signedInOwnerDefault)
        .send(defaultConfig)
    ).status,
    200,
  );

  let defaultSignedInPageRequests = 0;
  const defaultSignedIn = await fetchSignedInBoardOrders({
    config: defaultConfig,
    fetchPage: async (params: Record<string, unknown>) => {
      defaultSignedInPageRequests += 1;
      const res = await request(app).get('/api/orders').query(params).set(signedInOwnerDefault);
      assert.equal(res.status, 200, `signed-in default board page ${defaultSignedInPageRequests} returns 200`);
      return res.body;
    },
  });
  const defaultPairedFeed = await request(app).get(FEED).set(pairedBudgetDisplay);
  assert.equal(defaultPairedFeed.status, 200);
  const expectedDefaultBoardOrders = [
    { id: olderEligibleActivePendingId, number: 'ELIG-ACTIVE-PENDING', status: 'pending' },
    { id: olderEligibleActivePreparingId, number: 'ELIG-ACTIVE-PREPARING', status: 'preparing' },
    { id: olderEligibleActiveReadyId, number: 'ELIG-ACTIVE-READY', status: 'ready' },
    { id: olderEligiblePrepaidReadyId, number: 'BILL-ELIG-PREPAID-READY', status: 'ready' },
  ];
  assert.deepEqual(
    defaultPairedFeed.body.orders,
    expectedDefaultBoardOrders,
    'paired feed returns all 4 older eligible orders on page 1 despite 5,000 newer served orders',
  );
  assert.equal(defaultPairedFeed.body.has_more, false);
  assert.deepEqual(
    defaultSignedIn.orders,
    expectedDefaultBoardOrders,
    'signed-in board returns all 4 older eligible orders despite 5,000 newer served orders',
  );
  assert.equal(
    defaultSignedInPageRequests,
    1,
    'signed-in board filters out served orders before pagination so 4 eligible orders fit in 1 page',
  );

  // Under ready-only config, also seed newer pending + preparing active orders and >200 newer <24h
  // completed orders projecting preparing so 5,602 excluded active orders + 225 excluded projected-preparing
  // completed orders sit ahead of the 2 older eligible ready orders (active ready + prepaid completed ready).
  db.transaction(() => {
    for (let i = 1; i <= 300; i += 1) {
      const stamp = utcFromAnchor(-900 + i);
      insertBatchOrder.run(`EXCL-PENDING-${i}`, 'pending', null, stamp, stamp);
      insertBatchOrder.run(`EXCL-PREPARING-${i}`, 'preparing', null, stamp, stamp);
    }
    for (let i = 1; i <= 225; i += 1) {
      const stamp = utcFromAnchor(-400 + i);
      const oid = Number(
        insertBatchOrder.run(`EXCL-COMP-PREP-${i}`, 'completed', stamp, stamp, stamp)
          .lastInsertRowid,
      );
      insertBatchBill.run(`BILL-EXCL-COMP-PREP-${i}`, oid, stamp, stamp, stamp);
      insertHistoricalItem.run(oid, 'ready', stamp, stamp);
      insertHistoricalItem.run(oid, 'pending', stamp, stamp);
    }
  })();

  const signedInOwnerReady = { ...owner, 'X-Forwarded-For': '127.0.0.12' };
  const readyOnlyConfig = {
    statuses: ['ready'] as Array<'pending' | 'preparing' | 'ready'>,
    refresh_seconds: 3,
    show_updated: true,
  };
  assert.equal(
    (
      await request(app)
        .put('/api/settings/customer-display')
        .set(signedInOwnerReady)
        .send(readyOnlyConfig)
    ).status,
    200,
  );

  let readySignedInPageRequests = 0;
  const readySignedIn = await fetchSignedInBoardOrders({
    config: readyOnlyConfig,
    fetchPage: async (params: Record<string, unknown>) => {
      readySignedInPageRequests += 1;
      const res = await request(app).get('/api/orders').query(params).set(signedInOwnerReady);
      assert.equal(res.status, 200, `signed-in ready-only board page ${readySignedInPageRequests} returns 200`);
      return res.body;
    },
  });
  const readyPairedFeed = await request(app).get(FEED).set(pairedBudgetDisplay);
  assert.equal(readyPairedFeed.status, 200);
  const expectedReadyBoardOrders = [
    { id: olderEligibleActiveReadyId, number: 'ELIG-ACTIVE-READY', status: 'ready' },
    { id: olderEligiblePrepaidReadyId, number: 'BILL-ELIG-PREPAID-READY', status: 'ready' },
  ];
  assert.deepEqual(
    readyPairedFeed.body.orders,
    expectedReadyBoardOrders,
    'paired ready-only feed returns both active and <24h projected-ready completed orders on page 1',
  );
  assert.equal(readyPairedFeed.body.has_more, false);
  assert.deepEqual(
    readySignedIn.orders,
    expectedReadyBoardOrders,
    'signed-in ready-only board returns both active and <24h projected-ready completed orders despite 5,602 excluded active + 225 excluded completed orders',
  );
  assert.equal(
    readySignedInPageRequests,
    1,
    'signed-in ready-only board filters effective board_status before pagination in 1 page',
  );
  assert.equal(
    (db.prepare('SELECT status FROM orders WHERE id = ?').get(olderEligiblePrepaidReadyId) as any)
      .status,
    'completed',
    'older prepaid ready order retains terminal completed status in DB',
  );

  // Validate board_status query parameter error handling and composition with other GET /api/orders filters
  for (const invalidBoardStatus of ['', 'served', 'completed', 'ready,invalid', 'ready,']) {
    const badBoardRes = await request(app)
      .get(`/api/orders?view=active&board_status=${encodeURIComponent(invalidBoardStatus)}`)
      .set(signedInOwnerReady);
    assert.equal(
      badBoardRes.status,
      400,
      `invalid board_status=${JSON.stringify(invalidBoardStatus)} returns 400`,
    );
  }
  const completedReadyOnlyRes = await request(app)
    .get('/api/orders?view=active&status=completed&board_status=ready&per_page=50')
    .set(signedInOwnerReady);
  assert.equal(completedReadyOnlyRes.status, 200);
  assert.deepEqual(
    completedReadyOnlyRes.body.orders.map((o: any) => [o.id, o.status]),
    [[olderEligiblePrepaidReadyId, 'completed']],
    'combining status=completed with board_status=ready returns only the <24h completed order projecting ready',
  );

  const takeawayReadyRes = await request(app)
    .get('/api/orders?view=active&type=takeaway&board_status=ready&per_page=50')
    .set(signedInOwnerReady);
  assert.equal(takeawayReadyRes.status, 200);
  assert.deepEqual(
    takeawayReadyRes.body.orders.map((o: any) => [o.id, o.status]),
    [
      [olderEligiblePrepaidReadyId, 'completed'],
      [olderEligibleActiveReadyId, 'ready'],
    ],
    'combining type=takeaway with board_status=ready returns both <24h projected-ready completed and active ready takeaway orders',
  );

  // Verify multi-page before_id cursor advancement with board_status=ready across per_page=1 pages
  const cursorPage1 = await request(app)
    .get('/api/orders?view=active&board_status=ready&per_page=1')
    .set(signedInOwnerReady);
  assert.equal(cursorPage1.status, 200);
  assert.deepEqual(
    cursorPage1.body.orders.map((o: any) => o.id),
    [olderEligiblePrepaidReadyId],
    'board_status=ready page 1 (per_page=1) returns the newer eligible ready order',
  );
  assert.equal(
    cursorPage1.body.nextCursor,
    olderEligiblePrepaidReadyId,
    'board_status=ready page 1 sets nextCursor to the returned order id',
  );
  const cursorPage2 = await request(app)
    .get(
      `/api/orders?view=active&board_status=ready&per_page=1&before_id=${cursorPage1.body.nextCursor}`,
    )
    .set(signedInOwnerReady);
  assert.equal(cursorPage2.status, 200);
  assert.deepEqual(
    cursorPage2.body.orders.map((o: any) => o.id),
    [olderEligibleActiveReadyId],
    'board_status=ready page 2 (per_page=1) advances past page 1 to the older active ready order',
  );
  assert.equal(
    cursorPage2.body.nextCursor,
    undefined,
    'board_status=ready terminal page omits nextCursor',
  );

  console.log('customer-display-feed: all assertions passed');
}

main()
  .catch((error) => {
    console.error('Test error:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  });
