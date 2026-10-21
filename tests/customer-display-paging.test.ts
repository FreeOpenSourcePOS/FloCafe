/**
 * Customer display feed cursor paging: a paired display can read the whole eligible queue,
 * page by page, without widening token scope or the sanitized projection.
 *
 * Run: npm run test:customer-display-paging
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-display-paging-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { customerDisplayFeedRoutes } = require('../main/routes/customer-display-feed');
const {
  createDisplayToken,
  revokeDisplayToken,
} = require('../main/services/customer-display-tokens');

const { mergeFeedPages, isCustomerDisplayFeed } = require('../frontend/src/lib/customer-display');

const FEED = '/api/customer-display/feed';
const TOTAL = 250;

type FeedOrder = { id: number; number: string; status: string };
type Feed = { orders: FeedOrder[]; next_cursor: string | null };

async function walk(app: any, token: string): Promise<{ pages: Feed[]; orders: FeedOrder[] }> {
  const pages: Feed[] = [];
  let cursor: string | null = null;
  do {
    const res: any = await request(app)
      .get(cursor ? `${FEED}?cursor=${encodeURIComponent(cursor)}` : FEED)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200, 'every page is readable with the display token');
    pages.push(res.body);
    cursor = res.body.next_cursor;
    assert.ok(pages.length <= 10, 'paging terminates');
  } while (cursor);
  return { pages, orders: [...pages].reverse().flatMap((page) => page.orders) };
}

async function main(): Promise<void> {
  initDatabase();
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO orders (order_number, special_instructions, status, created_at, updated_at)
     VALUES (?, 'allergic to nuts', ?, ?, ?)`,
  );
  for (let i = 0; i < TOTAL; i += 1) {
    // Five orders share each timestamp, so the (created_at, id) tie-break is exercised.
    const stamp = `2026-01-01 10:${String(Math.floor(i / 5) % 60).padStart(2, '0')}:${String(Math.floor(i / 300)).padStart(2, '0')}`;
    insert.run(`P-${i}`, 'pending', stamp, stamp);
  }
  insert.run('DONE-1', 'completed', '2026-01-01 09:00:00', '2026-01-01 09:00:00');
  insert.run('CANCELLED-1', 'cancelled', '2026-01-01 09:00:01', '2026-01-01 09:00:01');

  const app = express();
  app.use('/api/customer-display', customerDisplayFeedRoutes);
  const { token, id: tokenId } = createDisplayToken('Lobby', null);

  const first = await request(app).get(FEED).set('Authorization', `Bearer ${token}`);
  assert.equal(first.body.orders.length, 100, 'the default page keeps the newest-100 window');
  assert.ok(first.body.next_cursor, 'a cursor is offered when older eligible orders exist');

  const { pages, orders } = await walk(app, token);
  assert.equal(pages.length, 3, '250 eligible orders take three pages');
  assert.deepEqual(pages[0].orders, first.body.orders, 'page one matches the unpaged request');
  assert.equal(orders.length, TOTAL, 'every eligible order is reachable');
  assert.equal(new Set(orders.map((o) => o.id)).size, TOTAL, 'no order repeats across pages');
  assert.equal(pages[2].next_cursor, null, 'the last page has no cursor');
  assert.ok(
    orders.every((o) => o.number.startsWith('P-')),
    'completed and cancelled orders are never served',
  );
  for (const order of orders) {
    assert.deepEqual(
      Object.keys(order).sort(),
      ['id', 'number', 'status'],
      'pages carry only the sanitized projection',
    );
  }
  const dbOrder = db.prepare("SELECT id FROM orders WHERE order_number = 'P-0'").get() as {
    id: number;
  };
  assert.equal(orders[0].id, dbOrder.id, 'the oldest order comes first once pages are merged');

  // Status changes show up on the next walk, in whichever page holds the order.
  db.prepare("UPDATE orders SET status = 'ready' WHERE order_number = 'P-3'").run();
  db.prepare("UPDATE orders SET status = 'completed' WHERE order_number = 'P-4'").run();
  const refreshed = (await walk(app, token)).orders;
  assert.equal(refreshed.length, TOTAL - 1, 'an order leaving the eligible set disappears');
  assert.equal(refreshed.find((o) => o.number === 'P-3')?.status, 'ready', 'status updates apply');

  // Bad input and revocation.
  for (const bad of [
    'not-a-cursor',
    'e30',
    Buffer.from('[1,2]').toString('base64url'),
    'x'.repeat(300),
  ]) {
    const res = await request(app)
      .get(`${FEED}?cursor=${bad}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 400, `cursor ${bad.slice(0, 12)} is rejected`);
  }
  assert.equal(
    (await request(app).get(`${FEED}?cursor=${first.body.next_cursor}`)).status,
    401,
    'a cursor does not replace the display token',
  );
  revokeDisplayToken(tokenId);
  assert.equal(
    (
      await request(app)
        .get(`${FEED}?cursor=${first.body.next_cursor}`)
        .set('Authorization', `Bearer ${token}`)
    ).status,
    401,
    'a revoked token is refused on paged requests too',
  );

  const merged = mergeFeedPages([
    [
      { id: 5, number: 'N-5', status: 'ready' },
      { id: 6, number: 'N-6', status: 'pending' },
    ],
    [
      { id: 4, number: 'N-4', status: 'pending' },
      { id: 5, number: 'N-5', status: 'pending' },
    ],
  ]);
  assert.deepEqual(
    merged.map((o: FeedOrder) => `${o.id}:${o.status}`),
    ['4:pending', '5:ready', '6:pending'],
    'merged pages are oldest-first, deduplicated, and keep the newest page version',
  );
  const validFeed = {
    business_name: 'x',
    config: { statuses: ['pending'], refresh_seconds: 3, show_updated: true },
    orders: [],
  };
  assert.ok(isCustomerDisplayFeed(validFeed), 'a feed without next_cursor stays valid');
  assert.ok(isCustomerDisplayFeed({ ...validFeed, next_cursor: null }), 'a null cursor is valid');
  assert.ok(
    !isCustomerDisplayFeed({ ...validFeed, next_cursor: 5 }),
    'a non-string cursor is invalid',
  );

  console.log('customer-display-paging tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });
