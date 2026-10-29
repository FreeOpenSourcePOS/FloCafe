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
const { requireAuth } = require('../main/server');
const { getJWTSecret } = require('../main/routes/auth');

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

  // Regression for #1401: prepaid completed orders with active KDS items project board status without mutating orders.status or scanning closed history
  app.set('trust proxy', 1);
  const prepaidDisplay = { ...fivePageDisplay, 'X-Forwarded-For': '127.0.0.2' };
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('feed-cat', 'Cafe', 1)`).run();
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order)
     VALUES ('feed-prod-1', 'feed-cat', 'Espresso', 5, 1, 1),
            ('feed-prod-2', 'feed-cat', 'Muffin', 4, 1, 2)`,
  ).run();

  const prepaidStamp = '2026-02-02 09:00:00';
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

  // Verify index usage on order_items active KDS query and zero closed-history scan across all pages
  let capturedActiveKdsSql = '';
  let capturedActiveKdsParams: unknown[] = [];
  let closedScannedDuringMerge = 0;
  db.function('track_scanned_status_merge', (status: string) => {
    if (status === 'completed' || status === 'cancelled') closedScannedDuringMerge += 1;
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
    const stmt = origPrepare(sql);
    if (sql.includes('FROM order_items oi') && sql.includes('orders co')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        capturedActiveKdsSql = sql;
        capturedActiveKdsParams = params;
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
  assert.equal(drainIds.length, 501, 'all 500 active + 1 prepaid order drain across cursor pages');
  assert.equal(new Set(drainIds).size, 501, 'zero duplicate IDs across active + prepaid merge');
  assert.equal(
    closedScannedDuringMerge,
    0,
    'zero closed sales history rows scanned on FROM orders o',
  );
  assert.ok(capturedActiveKdsSql.length > 0, 'captured active KDS completed-order query');
  const activeKdsPlan = db
    .prepare(`EXPLAIN QUERY PLAN ${capturedActiveKdsSql}`)
    .all(...capturedActiveKdsParams) as Array<{ detail: string }>;
  const activeKdsPlanText = activeKdsPlan.map((r) => r.detail).join(' | ');
  assert.ok(
    activeKdsPlanText.includes('idx_order_items_active_kds'),
    `prepaid feed query uses idx_order_items_active_kds (got: ${activeKdsPlanText})`,
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

  let capturedActiveViewSql = '';
  let capturedActiveViewParams: unknown[] = [];
  db.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (sql.includes('SELECT orders.* FROM orders')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...params: unknown[]) => {
        if (!capturedActiveViewSql) {
          capturedActiveViewSql = sql;
          capturedActiveViewParams = params;
        }
        return origAll(...params);
      };
    }
    return stmt;
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
    'authenticated view=active drains 500 active + 1 prepaid order',
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
  const statusActiveRes = await request(app)
    .get('/api/orders?status=active&per_page=100')
    .set({ ...owner, 'X-Forwarded-For': '127.0.0.3' });
  assert.equal(statusActiveRes.status, 200);
  assert.equal(
    statusActiveRes.body.orders.some((o: any) => o.id === zeroQtyOrderId),
    false,
    'completed order with 0-quantity pending item is excluded from status=active',
  );
  const activeViewPlan = db
    .prepare(`EXPLAIN QUERY PLAN ${capturedActiveViewSql}`)
    .all(...capturedActiveViewParams) as Array<{ detail: string }>;
  const activeViewPlanText = activeViewPlan.map((r) => r.detail).join(' | ');
  assert.ok(
    activeViewPlanText.includes('idx_orders_status') &&
      activeViewPlanText.includes('idx_order_items_active_kds') &&
      !activeViewPlanText.includes('idx_orders_created'),
    `authenticated view=active query uses idx_orders_status + idx_order_items_active_kds without scanning idx_orders_created (got: ${activeViewPlanText})`,
  );

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
