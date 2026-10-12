/**
 * Customer display pairing tests
 *
 * Runs the production requireAuth middleware in front of the real settings and display-feed
 * routers against a real SQLite DB (Electron ABI; run via run-electron-node-test.cjs).
 * Covers token scope, revocation, the sanitized feed, management permissions and the schema.
 *
 * Run: npm run test:customer-display-pairing
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-display-pairing-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
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
  const owner = seedUser(db, 'pairing-owner', 'owner');
  const server = seedUser(db, 'pairing-server', 'server');

  db.prepare(
    `INSERT INTO customers (id, name, phone, is_active, created_at, updated_at)
     VALUES ('pairing-customer', 'Secret Customer', '+15551230000', 1, ?, ?)`,
  ).run(now(), now());
  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, customer_id, user_id, special_instructions, status, created_at, updated_at)
     VALUES (?, 'pairing-customer', 'pairing-owner', 'allergic to nuts', ?, ?, ?)`,
  );
  for (const [number, status] of [
    ['A-1', 'pending'],
    ['A-2', 'preparing'],
    ['A-3', 'ready'],
    ['A-4', 'completed'],
    ['A-5', 'cancelled'],
  ]) {
    insertOrder.run(number, status, now(), now());
  }

  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/customer-display', customerDisplayFeedRoutes);
  app.use('/api/orders', orderRoutes);

  // Schema: migration created the table and no plaintext column exists.
  const columns = (
    db.prepare('PRAGMA table_info(customer_display_tokens)').all() as { name: string }[]
  ).map((c) => c.name);
  assert.ok(columns.includes('token_hash') && !columns.includes('token'), 'only a hash is stored');

  // Unpaired access
  assert.equal((await request(app).get(FEED)).status, 401, 'no credential is refused');
  assert.equal(
    (await request(app).get(FEED).set('Authorization', 'Bearer cdt_nope')).status,
    401,
    'unknown token refused',
  );
  assert.equal(
    (await request(app).get(FEED).set(owner)).status,
    401,
    'a staff JWT is not a display token',
  );
  assert.equal((await request(app).post(FEED).set(owner)).status, 404, 'the feed is GET-only');

  // Management permissions
  for (const call of [
    () => request(app).get(TOKENS).set(server),
    () => request(app).post(TOKENS).set(server).send({ label: 'Lobby TV' }),
    () => request(app).delete(`${TOKENS}/anything`).set(server),
  ]) {
    assert.equal(
      (await call()).status,
      403,
      'a role without settings.manage cannot manage displays',
    );
  }
  assert.equal(
    (await request(app).post(TOKENS).set(owner).send({})).status,
    400,
    'a label is required',
  );
  assert.equal(
    (
      await request(app)
        .post(TOKENS)
        .set(owner)
        .send({ label: 'x'.repeat(61) })
    ).status,
    400,
    'label length is bounded',
  );

  // Pair a device
  const created = await request(app).post(TOKENS).set(owner).send({ label: '  Lobby TV  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.label, 'Lobby TV');
  assert.match(created.body.token, /^cdt_[0-9a-f]{64}$/);
  const stored = db
    .prepare('SELECT * FROM customer_display_tokens WHERE id = ?')
    .get(created.body.id);
  assert.equal(stored.created_by, 'pairing-owner', 'creation is attributed to the actor');
  assert.ok(
    !JSON.stringify(stored).includes(created.body.token),
    'the plaintext token is never stored',
  );
  const display = { Authorization: `Bearer ${created.body.token}` };

  const listed = await request(app).get(TOKENS).set(owner);
  assert.equal(listed.body.tokens.length, 1);
  assert.ok(
    !JSON.stringify(listed.body).includes(created.body.token),
    'listing never returns the token',
  );
  assert.ok(!JSON.stringify(listed.body).includes('token_hash'), 'listing never returns the hash');

  // Feed content: all three statuses by default, sanitized fields only
  const feed = await request(app).get(FEED).set(display);
  assert.equal(feed.status, 200);
  assert.equal(feed.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(feed.body).sort(), ['business_name', 'config', 'orders']);
  assert.deepEqual(
    feed.body.orders.map((o: any) => [o.number, o.status]),
    [
      ['A-1', 'pending'],
      ['A-2', 'preparing'],
      ['A-3', 'ready'],
    ],
    'only active orders, oldest first',
  );
  for (const order of feed.body.orders) {
    assert.deepEqual(
      Object.keys(order).sort(),
      ['id', 'number', 'status'],
      'orders expose three fields',
    );
  }
  const serialized = JSON.stringify(feed.body);
  for (const secret of [
    'Secret Customer',
    '+15551230000',
    'allergic',
    'pairing-owner',
    'Staff pairing',
  ]) {
    assert.ok(!serialized.includes(secret), `the feed never contains ${secret}`);
  }
  assert.ok(
    db.prepare('SELECT last_seen_at FROM customer_display_tokens WHERE id = ?').get(created.body.id)
      .last_seen_at,
    'last_seen_at is recorded',
  );

  // The configured statuses narrow the feed
  const configured = await request(app)
    .put('/api/settings/customer-display')
    .set(owner)
    .send({ statuses: ['ready'], refresh_seconds: 3, show_updated: true });
  assert.equal(configured.status, 200);
  assert.deepEqual(
    (await request(app).get(FEED).set(display)).body.orders.map((o: any) => o.number),
    ['A-3'],
  );

  // Scope: the display token opens nothing else
  for (const [method, url] of [
    ['get', '/api/orders'],
    ['get', '/api/settings/customer-display'],
    ['put', '/api/settings/customer-display'],
    ['get', TOKENS],
    ['post', TOKENS],
    ['get', `${FEED}/`],
    ['get', '/API/orders'],
  ] as const) {
    assert.equal(
      (await (request(app) as any)[method](url).set(display).send({ label: 'x' })).status,
      401,
      `${method} ${url} refuses a display token`,
    );
  }

  // Revocation takes effect immediately and is not repeatable
  assert.equal((await request(app).delete(`${TOKENS}/${created.body.id}`).set(owner)).status, 200);
  assert.equal(
    (await request(app).get(FEED).set(display)).status,
    401,
    'a revoked token stops working at once',
  );
  assert.equal(
    (await request(app).delete(`${TOKENS}/${created.body.id}`).set(owner)).status,
    404,
    'revoking twice is a 404',
  );
  assert.equal(
    (await request(app).get(TOKENS).set(owner)).body.tokens.length,
    0,
    'revoked tokens leave the list',
  );

  // Limit
  for (let i = 0; i < 20; i++) {
    assert.equal(
      (
        await request(app)
          .post(TOKENS)
          .set(owner)
          .send({ label: `TV ${i}` })
      ).status,
      201,
    );
  }
  const over = await request(app).post(TOKENS).set(owner).send({ label: 'one too many' });
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'customer_display_token_limit');

  console.log('customer-display-pairing: all assertions passed');
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
