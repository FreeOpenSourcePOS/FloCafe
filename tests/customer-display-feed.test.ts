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

  for (let i = 1; i <= 15; i += 1) {
    const stamp = `2026-02-01 01:${String(i).padStart(2, '0')}:30`;
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
  const page2 = await request(app)
    .get(`${FEED}?cursor=${encodeURIComponent(page1.body.next_cursor)}`)
    .set(display);
  assert.equal(page2.status, 200);
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
  const page3 = await request(app)
    .get(`${FEED}?cursor=${encodeURIComponent(page2.body.next_cursor)}`)
    .set(display);
  assert.equal(page3.status, 200);
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

  // Custom limit clamping and malformed cursor/limit rejection
  const customLimit = await request(app).get(`${FEED}?limit=25`).set(display);
  assert.equal(customLimit.status, 200);
  assert.equal(customLimit.body.orders.length, 25);
  assert.equal(customLimit.body.has_more, true);

  const clampedLimit = await request(app).get(`${FEED}?limit=250`).set(display);
  assert.equal(clampedLimit.status, 200);
  assert.equal(clampedLimit.body.orders.length, 100);

  for (const badQuery of [
    'cursor=',
    'cursor=not-valid-base64!',
    `cursor=${Buffer.from('not-json').toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ created_at: '', id: 10 })).toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ created_at: '2026-02-01 00:01:00', id: 0 })).toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ created_at: '2026-02-01 00:01:00', id: '10' })).toString('base64url')}`,
    'limit=0',
    'limit=-5',
    'limit=abc',
  ]) {
    const badRes = await request(app).get(`${FEED}?${badQuery}`).set(display);
    assert.equal(badRes.status, 400, `malformed query ?${badQuery} returns 400`);
  }

  // Unauthenticated request with cursor still returns 401 before parameter parsing
  assert.equal((await request(app).get(`${FEED}?cursor=invalid`)).status, 401);

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
