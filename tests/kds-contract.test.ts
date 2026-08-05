/** Regression coverage for embedded KDS REST response contracts. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-contract-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-kds-contract';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, seedOwnerUser, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { kdsRoutes } = require('../main/routes/kds');
const { orderItemRoutes } = require('../main/routes/order-items');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-contract-station', 'Contract Station', ?, 1, ?, ?)`).run(JSON.stringify(['kds-contract-category']), now(), now());
  db.prepare(`INSERT INTO tables (id, number, kitchen_station_id, created_at, updated_at)
    VALUES ('kds-contract-table', '42', 'kds-contract-station', ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('kds-contract-category', 'Food', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('kds-contract-product', 'kds-contract-category', 'Contract food', 10, 1, 1)`).run();
  db.prepare(`INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
    VALUES ('KDS-CONTRACT-001', 'kds-contract-table', 'dine_in', 'pending', 10, 10, ?, ?)`).run(now(), now());
  const orderId = (db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-CONTRACT-001'").get() as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(orderId, now(), now());

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('kds-contract-bar', 'Bar', 2)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('kds-contract-bar-product', 'kds-contract-bar', 'Contract bar', 12, 1, 1)`).run();
  db.prepare(`INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
    VALUES ('KDS-CONTRACT-002', 'kds-contract-table', 'dine_in', 'pending', 12, 12, ?, ?)`).run(now(), now());
  const barOrderId = (db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-CONTRACT-002'").get() as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'kds-contract-bar-product', 'Contract bar', 12, 1, 12, 0, 12, 'pending', ?, ?)`).run(barOrderId, now(), now());
  const barItemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(barOrderId) as any).id;
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
    VALUES ('KDS-CONTRACT-003', 'takeaway', 'pending', 10, 10, ?, ?)`).run(now(), now());
  const tablelessOrderId = (db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-CONTRACT-003'").get() as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(tablelessOrderId, now(), now());

  const chefId = 'kds-contract-chef';
  db.prepare(`INSERT INTO users (id, name, email, password, role, category_ids, is_active, created_at, updated_at)
    VALUES (?, 'Restricted Chef', ?, ?, 'chef', ?, 1, ?, ?)`).run(
    chefId, 'kds-contract-chef@flo.local', bcrypt.hashSync('testpass123', 10), JSON.stringify(['kds-contract-category']), now(), now(),
  );
  const chefAuth = { Authorization: `Bearer ${jwt.sign({ userId: chefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}` };
  db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(chefId, 'kds-contract-station', now());
  db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-contract-inactive-station', 'Inactive Station', ?, 0, ?, ?)`).run(JSON.stringify(['kds-contract-category']), now(), now());
  const inactiveChefId = 'kds-contract-inactive-chef';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, 'Inactive Station Chef', ?, ?, 'chef', 1, ?, ?)`).run(
    inactiveChefId, 'kds-contract-inactive@flo.local', bcrypt.hashSync('testpass123', 10), now(), now(),
  );
  db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(inactiveChefId, 'kds-contract-inactive-station', now());
  const inactiveChefAuth = { Authorization: `Bearer ${jwt.sign({ userId: inactiveChefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}` };

  const app = createApp({ '/api/kds': kdsRoutes, '/api/order-items': orderItemRoutes });
  try {
    const orders = await request(app).get('/api/kds/orders').set(authHeader);
    assertEqual(orders.status, 200, 'embedded KDS orders request succeeds');
    const order = orders.body.orders.find((entry: any) => entry.id === orderId);
    assertEqual(order?.table?.name, '42', 'embedded KDS orders uses table.name');

    const display = await request(app).get('/api/kds/display?station_id=kds-contract-station').set(authHeader);
    assertEqual(display.status, 200, 'embedded KDS display request succeeds');
    assertEqual(display.body.orders[0]?.table?.name, '42', 'embedded KDS display uses table.name');

    const inactiveStationOrders = await request(app).get('/api/kds/orders').set(inactiveChefAuth);
    assertEqual(inactiveStationOrders.status, 403, 'inactive-only station assignments do not fail open');
    const inactiveOwnerOrders = await request(app).get('/api/kds/orders?station_id=kds-contract-inactive-station').set(authHeader);
    assertEqual(inactiveOwnerOrders.status, 404, 'station-scoped orders reject inactive stations');

    const restrictedOrders = await request(app).get('/api/kds/orders').set(chefAuth);
    assertEqual(restrictedOrders.status, 200, 'restricted chef can access embedded KDS orders');
    assertEqual(restrictedOrders.body.orders.some((entry: any) => entry.id === barOrderId), false, 'embedded KDS orders hide unauthorized categories');
    assertEqual(restrictedOrders.body.orders.some((entry: any) => entry.id === tablelessOrderId), true, 'station-scoped KDS includes routed tableless orders');
    assert(!('unit_price' in (restrictedOrders.body.orders.find((entry: any) => entry.id === orderId)?.items?.[0] || {})), 'restricted KDS items omit line pricing');

    db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
      VALUES ('kds-contract-bar-station', 'Bar Station', ?, 1, ?, ?)`).run(JSON.stringify(['kds-contract-bar']), now(), now());
    const deniedDisplay = await request(app).get('/api/kds/display?station_id=kds-contract-bar-station').set(chefAuth);
    assertEqual(deniedDisplay.status, 403, 'restricted chef cannot open a disallowed station display');
    const deniedStationOrders = await request(app).get('/api/kds/orders?station_id=kds-contract-bar-station').set(chefAuth);
    assertEqual(deniedStationOrders.status, 403, 'restricted chef cannot list a disallowed station');
    const barDisplay = await request(app).get('/api/kds/display?station_id=kds-contract-bar-station').set(authHeader);
    assertEqual(barDisplay.status, 200, 'owner can inspect the bar station display');
    assertEqual(barDisplay.body.orders.some((entry: any) => entry.order_id === barOrderId), false, 'station category routing does not duplicate table-assigned orders');

    const pairing = await request(app).get('/api/kds/pairing').set(chefAuth);
    assertEqual(pairing.status, 200, 'restricted chef can list assigned KDS stations');
    assertEqual(pairing.body.stations.some((station: any) => station.id === 'kds-contract-bar-station'), false, 'station assignments hide unassigned stations');
    db.prepare('UPDATE kitchen_stations SET category_ids = ? WHERE id = ?').run(JSON.stringify(['kds-contract-category', 'kds-contract-bar']), 'kds-contract-bar-station');
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(chefId, 'kds-contract-bar-station', now());
    const mixedPairing = await request(app).get('/api/kds/pairing').set(chefAuth);
    const mixedStation = mixedPairing.body.stations.find((station: any) => station.id === 'kds-contract-bar-station');
    assertEqual(mixedStation?.category_ids, JSON.stringify(['kds-contract-category']), 'restricted station metadata omits disallowed categories');

    const restrictedDisplay = await request(app).get('/api/kds/display?station_id=kds-contract-station').set(chefAuth);
    assertEqual(restrictedDisplay.status, 200, 'restricted chef can access the station display');
    assertEqual(restrictedDisplay.body.orders.some((entry: any) => entry.order_id === barOrderId), false, 'station display hides unauthorized categories');
    assertEqual(restrictedDisplay.body.orders.some((entry: any) => entry.order_id === tablelessOrderId), true, 'station display includes routed tableless orders');
    assert(!('subtotal' in (restrictedDisplay.body.orders[0]?.items?.[0] || {})), 'restricted station items omit line totals');

    const deniedEmbeddedMutation = await request(app).patch(`/api/kds/items/${barItemId}/status`).set(chefAuth).send({ status: 'ready' });
    assertEqual(deniedEmbeddedMutation.status, 403, 'restricted chef cannot mutate an unauthorized embedded KDS item');
    const deniedOrderItemMutation = await request(app).patch(`/api/order-items/${barItemId}/status`).set(chefAuth).send({ status: 'ready' });
    assertEqual(deniedOrderItemMutation.status, 403, 'restricted chef cannot mutate an unauthorized order item');

    db.prepare('UPDATE users SET category_ids = NULL WHERE id = ?').run(chefId);
    const stationOnlyOrders = await request(app).get('/api/kds/orders').set(chefAuth);
    assertEqual(stationOnlyOrders.status, 200, 'station-only chef can access embedded KDS orders');
    const stationOnlyItem = stationOnlyOrders.body.orders.find((entry: any) => entry.id === orderId)?.items?.[0] || {};
    assert(!('unit_price' in stationOnlyItem), 'station-only chef receives redacted embedded KDS items');
    assert(!('table_id' in stationOnlyItem), 'station-only chef does not receive raw item table IDs');
    assertEqual(stationOnlyOrders.body.orders.find((entry: any) => entry.id === barOrderId)?.items?.length || 0, 0, 'mixed station ACLs do not cross-route table-assigned categories');
    const deniedMixedStationMutation = await request(app).patch(`/api/order-items/${barItemId}/status`).set(chefAuth).send({ status: 'ready' });
    assertEqual(deniedMixedStationMutation.status, 403, 'mixed station ACLs block cross-station mutations');
    const stationOnlyDisplay = await request(app).get('/api/kds/display?station_id=kds-contract-station').set(chefAuth);
    assertEqual(stationOnlyDisplay.status, 200, 'station-only chef can access station display');
    assert(!('subtotal' in (stationOnlyDisplay.body.orders[0]?.items?.[0] || {})), 'station-only chef receives redacted station display items');
    assert(!('kitchen_station_id' in (stationOnlyDisplay.body.orders[0]?.table || {})), 'station-only chef receives projected table metadata');
    assertEqual(stationOnlyDisplay.body.orders[0]?.table_id, null, 'station-only display does not expose raw table IDs');
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  if (getResults().failed > 0) process.exit(1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
