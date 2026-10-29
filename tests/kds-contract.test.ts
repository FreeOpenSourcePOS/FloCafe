/** Regression coverage for embedded KDS REST response contracts. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-contract-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-kds-contract';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  seedOwnerUser,
  seedManagerUser,
  assert,
  assertEqual,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { kdsRoutes } = require('../main/routes/kds');
const { orderItemRoutes } = require('../main/routes/order-items');
const { orderRoutes } = require('../main/routes/orders');
const { refundRoutes } = require('../main/routes/refunds');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-contract-station', 'Contract Station', ?, 1, ?, ?)`).run(
    JSON.stringify(['kds-contract-category']),
    now(),
    now(),
  );
  db.prepare(`INSERT INTO tables (id, number, kitchen_station_id, created_at, updated_at)
    VALUES ('kds-contract-table', '42', 'kds-contract-station', ?, ?)`).run(now(), now());
  db.prepare(
    `INSERT INTO categories (id, name, sort_order) VALUES ('kds-contract-category', 'Food', 1)`,
  ).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('kds-contract-product', 'kds-contract-category', 'Contract food', 10, 1, 1)`).run();
  db.prepare(`INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
    VALUES ('KDS-CONTRACT-001', 'kds-contract-table', 'dine_in', 'pending', 10, 10, ?, ?)`).run(
    now(),
    now(),
  );
  const orderId = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-CONTRACT-001'").get() as any
  ).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(
    orderId,
    now(),
    now(),
  );
  const foodItemId = (
    db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any
  ).id;

  db.prepare(
    `INSERT INTO categories (id, name, sort_order) VALUES ('kds-contract-bar', 'Bar', 2)`,
  ).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('kds-contract-bar-product', 'kds-contract-bar', 'Contract bar', 12, 1, 1)`).run();
  db.prepare(`INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
    VALUES ('KDS-CONTRACT-002', 'kds-contract-table', 'dine_in', 'pending', 12, 12, ?, ?)`).run(
    now(),
    now(),
  );
  const barOrderId = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-CONTRACT-002'").get() as any
  ).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'kds-contract-bar-product', 'Contract bar', 12, 1, 12, 0, 12, 'pending', ?, ?)`).run(
    barOrderId,
    now(),
    now(),
  );
  const barItemId = (
    db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(barOrderId) as any
  ).id;
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
    VALUES ('KDS-CONTRACT-003', 'takeaway', 'pending', 10, 10, ?, ?)`).run(now(), now());
  const tablelessOrderId = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-CONTRACT-003'").get() as any
  ).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(
    tablelessOrderId,
    now(),
    now(),
  );

  db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-contract-unrestricted-station', 'Unrestricted Station', NULL, 1, ?, ?)`).run(
    now(),
    now(),
  );
  const unrestrictedChefId = 'kds-contract-unrestricted-chef';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, station_assignments_configured, created_at, updated_at)
    VALUES (?, 'Unrestricted Chef', ?, ?, 'chef', 1, 1, ?, ?)`).run(
    unrestrictedChefId,
    'kds-contract-unrestricted@flo.local',
    bcrypt.hashSync('testpass123', 10),
    now(),
    now(),
  );
  db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(
    unrestrictedChefId,
    'kds-contract-unrestricted-station',
    now(),
  );
  const unrestrictedChefAuth = {
    Authorization: `Bearer ${jwt.sign({ userId: unrestrictedChefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };

  const chefId = 'kds-contract-chef';
  db.prepare(`INSERT INTO users (id, name, email, password, role, category_ids, is_active, created_at, updated_at)
    VALUES (?, 'Restricted Chef', ?, ?, 'chef', ?, 1, ?, ?)`).run(
    chefId,
    'kds-contract-chef@flo.local',
    bcrypt.hashSync('testpass123', 10),
    JSON.stringify(['kds-contract-category']),
    now(),
    now(),
  );
  const chefAuth = {
    Authorization: `Bearer ${jwt.sign({ userId: chefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
  db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(
    chefId,
    'kds-contract-station',
    now(),
  );
  db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-contract-inactive-station', 'Inactive Station', ?, 0, ?, ?)`).run(
    JSON.stringify(['kds-contract-category']),
    now(),
    now(),
  );
  const inactiveChefId = 'kds-contract-inactive-chef';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, 'Inactive Station Chef', ?, ?, 'chef', 1, ?, ?)`).run(
    inactiveChefId,
    'kds-contract-inactive@flo.local',
    bcrypt.hashSync('testpass123', 10),
    now(),
    now(),
  );
  db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(
    inactiveChefId,
    'kds-contract-inactive-station',
    now(),
  );
  const inactiveChefAuth = {
    Authorization: `Bearer ${jwt.sign({ userId: inactiveChefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };

  seedManagerUser(db);
  const app = createApp({
    '/api/kds': kdsRoutes,
    '/api/order-items': orderItemRoutes,
    '/api/orders': orderRoutes,
    '/api/refunds': refundRoutes,
  });
  try {
    const orders = await request(app).get('/api/kds/orders').set(authHeader);
    assertEqual(orders.status, 200, 'embedded KDS orders request succeeds');
    const order = orders.body.orders.find((entry: any) => entry.id === orderId);
    assertEqual(order?.table?.name, '42', 'embedded KDS orders uses table.name');

    const display = await request(app)
      .get('/api/kds/display?station_id=kds-contract-station')
      .set(authHeader);
    assertEqual(display.status, 200, 'embedded KDS display request succeeds');
    assertEqual(display.body.orders[0]?.table?.name, '42', 'embedded KDS display uses table.name');

    const inactiveStationOrders = await request(app).get('/api/kds/orders').set(inactiveChefAuth);
    assertEqual(
      inactiveStationOrders.status,
      403,
      'inactive-only station assignments do not fail open',
    );
    const inactiveOwnerOrders = await request(app)
      .get('/api/kds/orders?station_id=kds-contract-inactive-station')
      .set(authHeader);
    assertEqual(inactiveOwnerOrders.status, 404, 'station-scoped orders reject inactive stations');

    const restrictedOrders = await request(app).get('/api/kds/orders').set(chefAuth);
    assertEqual(restrictedOrders.status, 200, 'restricted chef can access embedded KDS orders');
    assertEqual(
      restrictedOrders.body.orders.some((entry: any) => entry.id === barOrderId),
      false,
      'embedded KDS orders hide unauthorized categories',
    );
    assertEqual(
      restrictedOrders.body.orders.some((entry: any) => entry.id === tablelessOrderId),
      true,
      'station-scoped KDS includes routed tableless orders',
    );
    assert(
      !(
        'unit_price' in
        (restrictedOrders.body.orders.find((entry: any) => entry.id === orderId)?.items?.[0] || {})
      ),
      'restricted KDS items omit line pricing',
    );

    db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
      VALUES ('kds-contract-bar-station', 'Bar Station', ?, 1, ?, ?)`).run(
      JSON.stringify(['kds-contract-bar']),
      now(),
      now(),
    );
    const deniedDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-contract-bar-station')
      .set(chefAuth);
    assertEqual(
      deniedDisplay.status,
      403,
      'restricted chef cannot open a disallowed station display',
    );
    const deniedStationOrders = await request(app)
      .get('/api/kds/orders?station_id=kds-contract-bar-station')
      .set(chefAuth);
    assertEqual(
      deniedStationOrders.status,
      403,
      'restricted chef cannot list a disallowed station',
    );
    const barDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-contract-bar-station')
      .set(authHeader);
    assertEqual(barDisplay.status, 200, 'owner can inspect the bar station display');
    assertEqual(
      barDisplay.body.orders.some((entry: any) => entry.order_id === barOrderId),
      false,
      'station category routing does not duplicate table-assigned orders',
    );

    const pairing = await request(app).get('/api/kds/pairing').set(chefAuth);
    assertEqual(pairing.status, 200, 'restricted chef can list assigned KDS stations');
    assertEqual(
      pairing.body.stations.some((station: any) => station.id === 'kds-contract-bar-station'),
      false,
      'station assignments hide unassigned stations',
    );
    db.prepare('UPDATE kitchen_stations SET category_ids = ? WHERE id = ?').run(
      JSON.stringify(['kds-contract-category', 'kds-contract-bar']),
      'kds-contract-bar-station',
    );
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(
      chefId,
      'kds-contract-bar-station',
      now(),
    );
    const mixedPairing = await request(app).get('/api/kds/pairing').set(chefAuth);
    const mixedStation = mixedPairing.body.stations.find(
      (station: any) => station.id === 'kds-contract-bar-station',
    );
    assertEqual(
      mixedStation?.category_ids,
      JSON.stringify(['kds-contract-category']),
      'restricted station metadata omits disallowed categories',
    );

    const restrictedDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-contract-station')
      .set(chefAuth);
    assertEqual(restrictedDisplay.status, 200, 'restricted chef can access the station display');
    assertEqual(
      restrictedDisplay.body.orders.some((entry: any) => entry.order_id === barOrderId),
      false,
      'station display hides unauthorized categories',
    );
    assertEqual(
      restrictedDisplay.body.orders.some((entry: any) => entry.order_id === tablelessOrderId),
      true,
      'station display includes routed tableless orders',
    );
    assert(
      !('subtotal' in (restrictedDisplay.body.orders[0]?.items?.[0] || {})),
      'restricted station items omit line totals',
    );

    const deniedEmbeddedMutation = await request(app)
      .patch(`/api/kds/items/${barItemId}/status`)
      .set(chefAuth)
      .send({ status: 'ready' });
    assertEqual(
      deniedEmbeddedMutation.status,
      403,
      'restricted chef cannot mutate an unauthorized embedded KDS item',
    );
    const deniedOrderItemMutation = await request(app)
      .patch(`/api/order-items/${barItemId}/status`)
      .set(chefAuth)
      .send({ status: 'ready' });
    assertEqual(
      deniedOrderItemMutation.status,
      403,
      'restricted chef cannot mutate an unauthorized order item',
    );
    assertEqual(
      deniedOrderItemMutation.body.display_code,
      'category_scope_denied',
      'KDS category denial has a safe branch code',
    );

    db.prepare('UPDATE users SET category_ids = NULL WHERE id = ?').run(chefId);
    const stationOnlyOrders = await request(app).get('/api/kds/orders').set(chefAuth);
    assertEqual(stationOnlyOrders.status, 200, 'station-only chef can access embedded KDS orders');
    const stationOnlyItem =
      stationOnlyOrders.body.orders.find((entry: any) => entry.id === orderId)?.items?.[0] || {};
    assert(
      !('unit_price' in stationOnlyItem),
      'station-only chef receives redacted embedded KDS items',
    );
    assert(
      !('table_id' in stationOnlyItem),
      'station-only chef does not receive raw item table IDs',
    );
    assertEqual(
      stationOnlyOrders.body.orders.find((entry: any) => entry.id === barOrderId)?.items?.length ||
        0,
      0,
      'mixed station ACLs do not cross-route table-assigned categories',
    );
    const deniedMixedStationMutation = await request(app)
      .patch(`/api/order-items/${barItemId}/status`)
      .set(chefAuth)
      .send({ status: 'ready' });
    assertEqual(
      deniedMixedStationMutation.status,
      403,
      'mixed station ACLs block cross-station mutations',
    );
    assertEqual(
      deniedMixedStationMutation.body.display_code,
      'station_scope_denied',
      'KDS station denial has a safe branch code',
    );
    const stationOnlyDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-contract-station')
      .set(chefAuth);
    assertEqual(stationOnlyDisplay.status, 200, 'station-only chef can access station display');
    assertEqual(
      stationOnlyDisplay.body.orders.some((entry: any) => entry.order_id === barOrderId),
      false,
      'station display enforces per-station categories for table-assigned orders',
    );
    assert(
      !('subtotal' in (stationOnlyDisplay.body.orders[0]?.items?.[0] || {})),
      'station-only chef receives redacted station display items',
    );
    assert(
      !('kitchen_station_id' in (stationOnlyDisplay.body.orders[0]?.table || {})),
      'station-only chef receives projected table metadata',
    );
    assertEqual(
      stationOnlyDisplay.body.orders[0]?.table_id,
      null,
      'station-only display does not expose raw table IDs',
    );
    const casUpdate = await request(app)
      .patch(`/api/kds/items/${barItemId}/status`)
      .set(authHeader)
      .send({ status: 'preparing', expected_status: 'pending' });
    assertEqual(casUpdate.status, 200, 'KDS status update accepts the expected current status');
    const staleCasUpdate = await request(app)
      .patch(`/api/kds/items/${barItemId}/status`)
      .set(authHeader)
      .send({ status: 'ready', expected_status: 'pending' });
    assertEqual(staleCasUpdate.status, 409, 'KDS status update rejects a stale expected status');

    const invalidStatus = await request(app)
      .patch(`/api/order-items/${foodItemId}/status`)
      .set({ ...authHeader, 'x-operation-id': '3e6f5e32-7ae8-4f6f-a59c-35eb7e9f4601' })
      .send({ status: 'boiling' });
    assertEqual(
      invalidStatus.status,
      400,
      'invalid KDS status retains its existing response status',
    );
    assertEqual(
      invalidStatus.body.reason_code,
      'kds.status_rejected',
      'invalid KDS status has a stable reason',
    );
    assertEqual(
      invalidStatus.body.display_code,
      'invalid_status',
      'invalid KDS status has a safe branch code',
    );
    assertEqual(
      invalidStatus.body.correlation_id,
      '3e6f5e32-7ae8-4f6f-a59c-35eb7e9f4601',
      'KDS status failure preserves the operation reference',
    );
    const missingItem = await request(app)
      .patch('/api/order-items/missing-kds-item/status')
      .set(authHeader)
      .send({ status: 'ready' });
    assertEqual(missingItem.status, 404, 'missing KDS item keeps its existing response status');
    assertEqual(
      missingItem.body.display_code,
      'item_unavailable',
      'missing KDS item has a safe branch code',
    );
    const staleOrderItemStatus = await request(app)
      .patch(`/api/order-items/${foodItemId}/status`)
      .set(authHeader)
      .send({ status: 'preparing', expected_status: 'ready' });
    assertEqual(
      staleOrderItemStatus.status,
      409,
      'stale order-item compare-and-set keeps its existing response status',
    );
    assertEqual(
      staleOrderItemStatus.body.display_code,
      'status_conflict',
      'stale order-item compare-and-set has a safe branch code',
    );

    db.exec(`CREATE TRIGGER diagnostics_force_kds_status_rollback BEFORE UPDATE ON order_items
      WHEN NEW.id = ${Number(foodItemId)} BEGIN SELECT RAISE(ABORT, 'synthetic KDS status rollback'); END`);
    const rollbackStatus = await request(app)
      .patch(`/api/order-items/${foodItemId}/status`)
      .set(authHeader)
      .send({ status: 'preparing' });
    db.exec('DROP TRIGGER diagnostics_force_kds_status_rollback');
    assertEqual(rollbackStatus.status, 500, 'a KDS write failure keeps the route error status');
    assertEqual(
      rollbackStatus.body.reason_code,
      'persistence.failed',
      'a KDS write failure is not mislabeled as expected validation',
    );
    assertEqual(
      rollbackStatus.body.outcome,
      'not_applied',
      'failed KDS transaction is reported as rolled back',
    );
    assertEqual(
      (db.prepare('SELECT status FROM order_items WHERE id = ?').get(foodItemId) as any).status,
      'pending',
      'failed KDS transaction leaves the item unchanged',
    );
    const rollbackRow = db
      .prepare(
        "SELECT metadata_json FROM local_diagnostics WHERE event_code = 'persistence.failed' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata_json: string };
    const rollbackMetadata = JSON.parse(rollbackRow.metadata_json);
    assertEqual(
      rollbackMetadata.outcome,
      'not_applied',
      'stored KDS rollback row preserves the proven outcome',
    );
    assertEqual(
      JSON.stringify(rollbackMetadata).includes('synthetic KDS status rollback'),
      false,
      'KDS rollback diagnostics omit exception text',
    );

    db.prepare('UPDATE kitchen_stations SET category_ids = ? WHERE id = ?').run(
      '{invalid-json',
      'kds-contract-station',
    );
    const invalidStationState = await request(app)
      .patch(`/api/order-items/${foodItemId}/status`)
      .set(chefAuth)
      .send({ status: 'preparing' });
    assertEqual(
      invalidStationState.status,
      403,
      'malformed station permissions preserve the existing 403 response',
    );
    assertEqual(
      invalidStationState.body.reason_code,
      'kds.permissions_unavailable',
      'malformed station configuration is an unexpected permission-state failure',
    );
    assertEqual(
      invalidStationState.body.classification,
      'unexpected_failure',
      'permission resolver failure is not mislabeled as expected denial',
    );
    db.prepare('UPDATE kitchen_stations SET category_ids = ? WHERE id = ?').run(
      JSON.stringify(['kds-contract-category']),
      'kds-contract-station',
    );

    const kdsService = require('../main/services/kds');
    const originalNotifyKdsUpdate = kdsService.notifyKdsUpdate;
    kdsService.notifyKdsUpdate = () => {
      throw new Error('synthetic KDS notification failure');
    };
    let completionFailure;
    try {
      completionFailure = await request(app)
        .patch(`/api/order-items/${foodItemId}/status`)
        .set({ ...authHeader, 'x-operation-id': '0d3374a2-4e1e-47a6-8e4f-f2c0278d15b1' })
        .send({ status: 'preparing' });
    } finally {
      kdsService.notifyKdsUpdate = originalNotifyKdsUpdate;
    }
    assertEqual(
      completionFailure.status,
      500,
      'post-commit KDS notification failure retains the route error status',
    );
    assertEqual(
      completionFailure.body.reason_code,
      'operation.completion_failed',
      'post-commit notification failure is classified as completion',
    );
    assertEqual(
      completionFailure.body.outcome,
      'applied',
      'post-commit notification failure reports the committed KDS status',
    );
    assertEqual(
      completionFailure.body.correlation_id,
      '0d3374a2-4e1e-47a6-8e4f-f2c0278d15b1',
      'post-commit KDS failure preserves the operation reference',
    );
    assertEqual(
      (db.prepare('SELECT status FROM order_items WHERE id = ?').get(foodItemId) as any).status,
      'preparing',
      'post-commit notification failure does not undo the item status',
    );

    const unrestrictedOrders = await request(app).get('/api/kds/orders').set(unrestrictedChefAuth);
    assertEqual(unrestrictedOrders.status, 200, 'unrestricted station KDS request succeeds');
    assertEqual(
      unrestrictedOrders.body.orders.some((entry: any) => entry.id === tablelessOrderId),
      true,
      'unrestricted station receives tableless orders',
    );
    const unrestrictedDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-contract-unrestricted-station')
      .set(unrestrictedChefAuth);
    assertEqual(unrestrictedDisplay.status, 200, 'unrestricted station display request succeeds');
    assertEqual(
      unrestrictedDisplay.body.orders.some((entry: any) => entry.order_id === tablelessOrderId),
      true,
      'unrestricted station display receives tableless orders',
    );

    const pairingCreate = await request(app)
      .post('/api/kds/pairing')
      .set(authHeader)
      .send({ station_id: 'kds-contract-station' });
    assertEqual(pairingCreate.status, 201, 'pairing token creation succeeds');
    const storedPairing = db
      .prepare('SELECT id FROM kds_pairing_tokens WHERE token = ?')
      .get(pairingCreate.body.pairingToken.token) as { id: string };
    assertEqual(
      pairingCreate.body.pairingToken.id,
      storedPairing.id,
      'pairing response returns stored identifier',
    );

    // Regression for the reported bug: a dine-in order (table has no
    // kitchen_station_id of its own — there's no settings UI to set one)
    // whose items are split across two category-scoped stations used to
    // match neither station's routing clause and vanish from both screens.
    db.prepare(`INSERT INTO tables (id, number, created_at, updated_at)
      VALUES ('kds-split-table', '7', ?, ?)`).run(now(), now());
    db.prepare(`INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
      VALUES ('KDS-SPLIT-001', 'kds-split-table', 'dine_in', 'pending', 22, 22, ?, ?)`).run(
      now(),
      now(),
    );
    const splitOrderId = (
      db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-SPLIT-001'").get() as any
    ).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(
      splitOrderId,
      now(),
      now(),
    );
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-contract-bar-product', 'Contract bar', 12, 1, 12, 0, 12, 'pending', ?, ?)`).run(
      splitOrderId,
      now(),
      now(),
    );

    db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
      VALUES ('kds-split-counter-station', 'Split Counter Station', ?, 1, ?, ?)`).run(
      JSON.stringify(['kds-contract-bar']),
      now(),
      now(),
    );
    const splitKitchenChefId = 'kds-split-kitchen-chef';
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, 'Split Kitchen Chef', ?, ?, 'chef', 1, ?, ?)`).run(
      splitKitchenChefId,
      'kds-split-kitchen@flo.local',
      bcrypt.hashSync('testpass123', 10),
      now(),
      now(),
    );
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(
      splitKitchenChefId,
      'kds-contract-station',
      now(),
    );
    const splitKitchenAuth = {
      Authorization: `Bearer ${jwt.sign({ userId: splitKitchenChefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}`,
    };

    const splitCounterChefId = 'kds-split-counter-chef';
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, 'Split Counter Chef', ?, ?, 'chef', 1, ?, ?)`).run(
      splitCounterChefId,
      'kds-split-counter@flo.local',
      bcrypt.hashSync('testpass123', 10),
      now(),
      now(),
    );
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)').run(
      splitCounterChefId,
      'kds-split-counter-station',
      now(),
    );
    const splitCounterAuth = {
      Authorization: `Bearer ${jwt.sign({ userId: splitCounterChefId, role: 'chef' }, getJWTSecret(), { expiresIn: '1h' })}`,
    };

    const kitchenSplitOrders = await request(app).get('/api/kds/orders').set(splitKitchenAuth);
    assertEqual(
      kitchenSplitOrders.status,
      200,
      'kitchen-station chef can access embedded KDS orders for a dine-in split order',
    );
    const kitchenSplitOrder = kitchenSplitOrders.body.orders.find(
      (entry: any) => entry.id === splitOrderId,
    );
    assertEqual(
      kitchenSplitOrder?.items?.length,
      1,
      'kitchen-station chef sees only the food item on a dine-in order with category-split stations',
    );

    const counterSplitOrders = await request(app).get('/api/kds/orders').set(splitCounterAuth);
    assertEqual(
      counterSplitOrders.status,
      200,
      'counter-station chef can access embedded KDS orders for a dine-in split order',
    );
    const counterSplitOrder = counterSplitOrders.body.orders.find(
      (entry: any) => entry.id === splitOrderId,
    );
    assertEqual(
      counterSplitOrder?.items?.length,
      1,
      'counter-station chef sees only the drink item on a dine-in order with category-split stations',
    );

    const kitchenSplitDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-contract-station')
      .set(splitKitchenAuth);
    assertEqual(
      kitchenSplitDisplay.status,
      200,
      'kitchen-station display request succeeds for a dine-in split order',
    );
    assertEqual(
      kitchenSplitDisplay.body.orders.some((entry: any) => entry.order_id === splitOrderId),
      true,
      'kitchen station display shows the dine-in split order food item',
    );

    const counterSplitDisplay = await request(app)
      .get('/api/kds/display?station_id=kds-split-counter-station')
      .set(splitCounterAuth);
    assertEqual(
      counterSplitDisplay.status,
      200,
      'counter-station display request succeeds for a dine-in split order',
    );
    assertEqual(
      counterSplitDisplay.body.orders.some((entry: any) => entry.order_id === splitOrderId),
      true,
      'counter station display shows the dine-in split order drink item',
    );

    const { buildActiveOrdersSnapshot } = require('../main/services/kds');
    let orderFindCalls = 0;
    const origFind = Array.prototype.find;
    Array.prototype.find = function (predicate: any, thisArg?: any) {
      if (
        this.length > 0 &&
        this[0] &&
        typeof this[0] === 'object' &&
        'order_number' in this[0] &&
        'kitchen_station_id' in this[0]
      ) {
        orderFindCalls++;
      }
      return origFind.call(this, predicate, thisArg);
    };
    try {
      const snapshot = JSON.parse(buildActiveOrdersSnapshot([], ['kds-contract-station']));
      assert(
        snapshot.orders.length > 0,
        'buildActiveOrdersSnapshot returns active orders for station',
      );
    } finally {
      Array.prototype.find = origFind;
    }
    assertEqual(
      orderFindCalls,
      0,
      'buildActiveOrdersSnapshot indexes orders by ID in a Map instead of calling orders.find per item',
    );

    // Regression for #1401: KDS item transitions and item-set mutations reconcile active parent order status across all order types.
    const readOrderState = (id: number | string) =>
      db
        .prepare(
          'SELECT status, cooking_started_at, ready_at, served_at, updated_at FROM orders WHERE id = ?',
        )
        .get(id) as {
        status: string;
        cooking_started_at: string | null;
        ready_at: string | null;
        served_at: string | null;
        updated_at: string;
      };
    const readStatusAudits = (id: number | string) =>
      db
        .prepare(
          "SELECT actor_user_id, details_json FROM order_audit_log WHERE order_id = ? AND action = 'status_changed' ORDER BY id ASC",
        )
        .all(id) as Array<{ actor_user_id: string; details_json: string }>;

    db.prepare(`INSERT INTO tables (id, number, created_at, updated_at)
      VALUES ('kds-reconcile-table', '88', ?, ?)`).run(now(), now());

    for (const orderType of ['takeaway', 'dine_in', 'delivery', 'online'] as const) {
      const writerPath =
        orderType === 'takeaway' || orderType === 'delivery'
          ? ('order-items' as const)
          : ('kds-items' as const);
      const createdRes = await request(app)
        .post('/api/orders')
        .set(authHeader)
        .send({
          type: orderType,
          ...(orderType === 'dine_in' ? { table_id: 'kds-reconcile-table' } : {}),
          ...(orderType === 'delivery' ? { delivery_address: '123 Pickup St' } : {}),
          ...(orderType === 'online'
            ? { online_platform: 'ubereats', external_order_id: `ext-1401-${orderType}` }
            : {}),
          items: [
            { product_id: 'kds-contract-product', quantity: 1 },
            { product_id: 'kds-contract-bar-product', quantity: 1 },
          ],
        });
      assertEqualOrThrow(createdRes.status, 201, `${orderType} order placement succeeds`);
      const recOrderId = createdRes.body.order.id;
      const [firstItem, secondItem] = createdRes.body.order.items;
      const patchItem = (itemId: number | string, status: string) =>
        request(app)
          .patch(
            writerPath === 'order-items'
              ? `/api/order-items/${itemId}/status`
              : `/api/kds/items/${itemId}/status`,
          )
          .set(authHeader)
          .send({ status });

      assertEqualOrThrow(
        (await patchItem(firstItem.id, 'preparing')).status,
        200,
        `${orderType}: first item preparing succeeds`,
      );
      const afterPrep = readOrderState(recOrderId);
      assertEqualOrThrow(
        afterPrep.status,
        'preparing',
        `${orderType}: starting kitchen work promotes pending parent to preparing`,
      );
      assertOrThrow(
        afterPrep.cooking_started_at !== null,
        `${orderType}: cooking_started_at is populated on preparing promotion`,
      );
      assertEqualOrThrow(afterPrep.ready_at, null, `${orderType}: ready_at remains null`);

      assertEqualOrThrow(
        (await patchItem(firstItem.id, 'ready')).status,
        200,
        `${orderType}: 1-of-2 ready succeeds`,
      );
      assertEqualOrThrow(
        readOrderState(recOrderId).status,
        'preparing',
        `${orderType}: 1-of-2 ready keeps parent in preparing while unfinished items remain`,
      );

      assertEqualOrThrow(
        (await patchItem(secondItem.id, 'ready')).status,
        200,
        `${orderType}: 2-of-2 ready succeeds`,
      );
      const afterAllReady = readOrderState(recOrderId);
      assertEqualOrThrow(
        afterAllReady.status,
        'ready',
        `${orderType}: 2-of-2 ready promotes parent to ready`,
      );
      assertOrThrow(
        afterAllReady.ready_at !== null,
        `${orderType}: ready_at is populated on ready promotion`,
      );

      // Mixed ready + served stays ready
      assertEqualOrThrow(
        (await patchItem(firstItem.id, 'served')).status,
        200,
        `${orderType}: 1-of-2 served succeeds`,
      );
      assertEqualOrThrow(
        readOrderState(recOrderId).status,
        'ready',
        `${orderType}: mixed served + ready keeps parent ready`,
      );

      // All live items served promotes parent to served
      assertEqualOrThrow(
        (await patchItem(secondItem.id, 'served')).status,
        200,
        `${orderType}: 2-of-2 served succeeds`,
      );
      const afterAllServed = readOrderState(recOrderId);
      assertEqualOrThrow(
        afterAllServed.status,
        'served',
        `${orderType}: all live items served promotes parent to served`,
      );
      assertOrThrow(
        afterAllServed.served_at !== null,
        `${orderType}: served_at is populated on served promotion`,
      );

      if (orderType === 'dine_in') {
        db.prepare("UPDATE tables SET status = 'available' WHERE id = 'kds-reconcile-table'").run();
      }
    }

    // Multi-station two-chef partial visibility on splitOrderId (food + bar across separate stations)
    const splitItems = db
      .prepare('SELECT id, product_id FROM order_items WHERE order_id = ? ORDER BY id ASC')
      .all(splitOrderId) as Array<{ id: number; product_id: string }>;
    const splitFoodItem = splitItems.find((i) => i.product_id === 'kds-contract-product')!;
    const splitBarItem = splitItems.find((i) => i.product_id === 'kds-contract-bar-product')!;
    const firstChefReady = await request(app)
      .patch(`/api/order-items/${splitFoodItem.id}/status`)
      .set(splitKitchenAuth)
      .send({ status: 'ready' });
    assertEqualOrThrow(firstChefReady.status, 200, 'first station chef marks food item ready');
    assertEqualOrThrow(
      readOrderState(splitOrderId).status,
      'preparing',
      'first station chef finishing only its visible subset promotes pending -> preparing, not ready',
    );
    const secondChefReady = await request(app)
      .patch(`/api/kds/items/${splitBarItem.id}/status`)
      .set(splitCounterAuth)
      .send({ status: 'ready' });
    assertEqualOrThrow(secondChefReady.status, 200, 'second station chef marks bar item ready');
    assertEqualOrThrow(
      readOrderState(splitOrderId).status,
      'ready',
      'second station chef finishing the last live item promotes parent to ready',
    );
    const splitAudits = readStatusAudits(splitOrderId);
    assertEqualOrThrow(
      splitAudits.length,
      2,
      'two distinct parent transitions record two status_changed audit entries',
    );
    assertEqualOrThrow(
      splitAudits[0].actor_user_id,
      splitKitchenChefId,
      'first transition audit attributes kitchen station chef',
    );
    assertEqualOrThrow(
      splitAudits[1].actor_user_id,
      splitCounterChefId,
      'second transition audit attributes counter station chef',
    );

    // Item-set mutations: append, cancel, void (no preparing->pending regression), restore, edit, and requeue
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('cloud_orders_enabled', '1', ?)",
    ).run(now());
    db.prepare('DELETE FROM cloud_sync_outbox').run();
    const mutOrderRes = await request(app)
      .post('/api/orders')
      .set(authHeader)
      .send({
        type: 'takeaway',
        items: [{ product_id: 'kds-contract-product', quantity: 1 }],
      });
    assertEqualOrThrow(mutOrderRes.status, 201, 'mutation test takeaway created');
    const mutOrderId = mutOrderRes.body.order.id;
    const mutItem1Id = mutOrderRes.body.order.items[0].id;
    db.prepare('DELETE FROM cloud_sync_outbox').run();

    // Mark single item ready -> parent ready + cloud outbox event emitted
    const singleReadyRes = await request(app)
      .patch(`/api/order-items/${mutItem1Id}/status`)
      .set(authHeader)
      .send({ status: 'ready' });
    assertEqualOrThrow(singleReadyRes.status, 200, 'single item ready succeeds');
    assertEqualOrThrow(
      singleReadyRes.body.order.status,
      'ready',
      'order-items response reflects reconciled ready parent status immediately',
    );
    assertEqualOrThrow(readOrderState(mutOrderId).status, 'ready', 'DB parent status is ready');
    const readyOutbox = db
      .prepare('SELECT event_type FROM cloud_sync_outbox ORDER BY created_at DESC LIMIT 1')
      .get() as { event_type: string } | undefined;
    assertEqualOrThrow(
      readyOutbox?.event_type,
      'order.ready',
      'KDS parent reconciliation emits order.ready cloud event',
    );

    // Requeue single ready item back to pending -> demotes ready parent to preparing (never pending) and clears ready_at
    const requeuePendingRes = await request(app)
      .patch(`/api/order-items/${mutItem1Id}/status`)
      .set(authHeader)
      .send({ status: 'pending' });
    assertEqualOrThrow(requeuePendingRes.status, 200, 'requeue ready -> pending succeeds');
    const afterRequeue = readOrderState(mutOrderId);
    assertEqualOrThrow(
      afterRequeue.status,
      'preparing',
      'requeuing ready item to pending demotes parent from ready to preparing',
    );
    assertEqualOrThrow(afterRequeue.ready_at, null, 'requeue clears stale ready_at');

    // Re-promote to ready, then append a new pending item -> demotes ready -> preparing
    await request(app)
      .patch(`/api/order-items/${mutItem1Id}/status`)
      .set(authHeader)
      .send({ status: 'ready' });
    assertEqualOrThrow(readOrderState(mutOrderId).status, 'ready', 'parent ready again');

    const appendRes = await request(app)
      .post(`/api/orders/${mutOrderId}/items`)
      .set(authHeader)
      .send({ items: [{ product_id: 'kds-contract-bar-product', quantity: 1 }] });
    assertEqualOrThrow(appendRes.status, 200, 'append pending item succeeds');
    assertEqualOrThrow(
      appendRes.body.order.status,
      'preparing',
      'append response reflects demoted preparing status',
    );
    assertEqualOrThrow(
      readOrderState(mutOrderId).ready_at,
      null,
      'appending pending item clears ready_at',
    );
    const appendedItem = appendRes.body.order.items.find(
      (i: any) => i.product_id === 'kds-contract-bar-product',
    );

    // Cancel the appended pending blocker -> surviving item is ready -> parent promotes back to ready!
    const cancelBlockerRes = await request(app)
      .patch(`/api/orders/${mutOrderId}/items/${appendedItem.id}/cancel`)
      .set(authHeader)
      .send({ reason: 'mistake' });
    assertEqualOrThrow(cancelBlockerRes.status, 200, 'cancel pending blocker succeeds');
    assertEqualOrThrow(
      cancelBlockerRes.body.order.status,
      'ready',
      'cancelling last pending blocker promotes surviving ready order to ready',
    );
    assertOrThrow(
      readOrderState(mutOrderId).ready_at !== null,
      'cancelling blocker populates ready_at',
    );

    // Restore cancelled item back to pending -> demotes ready -> preparing and clears ready_at
    const restoreRes = await request(app)
      .patch(`/api/orders/${mutOrderId}/items/${appendedItem.id}/restore`)
      .set(authHeader)
      .send({});
    assertEqualOrThrow(restoreRes.status, 200, 'restore cancelled item succeeds');
    assertEqualOrThrow(
      restoreRes.body.order.status,
      'preparing',
      'restoring pending item demotes ready parent back to preparing',
    );
    assertEqualOrThrow(readOrderState(mutOrderId).ready_at, null, 'restore clears ready_at');

    // Voiding started item (mutItem1Id is ready) while restored item is pending:
    // remaining live item is pending, parent is already preparing -> must NOT regress preparing -> pending!
    const auditsBeforeVoid = readStatusAudits(mutOrderId).length;
    const cookingStartedBeforeVoid = readOrderState(mutOrderId).cooking_started_at;
    const voidStartedRes = await request(app)
      .patch(`/api/orders/${mutOrderId}/items/${mutItem1Id}/cancel`)
      .set(authHeader)
      .send({ override_pin: '1234', reason: 'dropped' });
    assertEqualOrThrow(voidStartedRes.status, 200, 'voiding started item with manager PIN succeeds');
    const afterVoid = readOrderState(mutOrderId);
    assertEqualOrThrow(
      afterVoid.status,
      'preparing',
      'voiding started item while pending items remain does NOT regress preparing -> pending',
    );
    assertEqualOrThrow(
      afterVoid.cooking_started_at,
      cookingStartedBeforeVoid,
      'void non-regression avoids cooking_started_at churn',
    );
    assertEqualOrThrow(
      readStatusAudits(mutOrderId).length,
      auditsBeforeVoid,
      'void non-regression avoids status_changed audit churn',
    );

    // Mark surviving restored item ready (voided + void_adjustment excluded) -> promotes to ready!
    const readyAfterVoidRes = await request(app)
      .patch(`/api/order-items/${appendedItem.id}/status`)
      .set(authHeader)
      .send({ status: 'ready' });
    assertEqualOrThrow(readyAfterVoidRes.status, 200, 'marking remaining item ready succeeds');
    assertEqualOrThrow(
      readOrderState(mutOrderId).status,
      'ready',
      'voided and void_adjustment rows are excluded when computing readiness',
    );

    // Edit ready item to increase quantity (adds new pending line) -> demotes ready -> preparing
    const fetchedMutOrder = await request(app)
      .get(`/api/orders/${mutOrderId}`)
      .set(authHeader);
    const currentAppendedItem = fetchedMutOrder.body.order.items.find(
      (i: any) => i.id === appendedItem.id,
    );
    const editIncreaseRes = await request(app)
      .patch(`/api/orders/${mutOrderId}/items/${appendedItem.id}/edit`)
      .set({ ...authHeader, 'Idempotency-Key': 'idem-1401-edit-inc' })
      .send({
        quantity: 2,
        expected_edit_version: currentAppendedItem.edit_version,
        reason: 'add one more',
      });
    assertEqualOrThrow(editIncreaseRes.status, 200, 'quantity-increase edit on ready item succeeds');
    assertEqualOrThrow(
      editIncreaseRes.body.order.status,
      'preparing',
      'quantity-increase edit adding pending work demotes ready parent to preparing',
    );
    assertEqualOrThrow(
      readOrderState(mutOrderId).ready_at,
      null,
      'quantity-increase edit clears ready_at',
    );

    const refundActiveOrderId = Number(
      db
        .prepare(
          `INSERT INTO orders (order_number, type, status, subtotal, total, cooking_started_at, created_at, updated_at)
           VALUES ('KDS-PARTIAL-REFUND', 'takeaway', 'preparing', 22, 22, ?, ?, ?)`,
        )
        .run(now(), now(), now()).lastInsertRowid,
    );
    const refundBlockerItemId = Number(
      db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
           VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'preparing', ?, ?)`,
        )
        .run(refundActiveOrderId, now(), now()).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
       VALUES (?, 'kds-contract-bar-product', 'Contract bar', 12, 1, 12, 0, 12, 'ready', ?, ?)`,
    ).run(refundActiveOrderId, now(), now());
    const partialBillId = Number(
      db
        .prepare(
          `INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
           VALUES ('BILL-KDS-PARTIAL-REFUND', ?, 22, 0, 22, 10, 12, 'partial', ?, ?)`,
        )
        .run(refundActiveOrderId, now(), now()).lastInsertRowid,
    );
    const blockedCancelRes = await request(app)
      .patch(`/api/orders/${refundActiveOrderId}/items/${refundBlockerItemId}/cancel`)
      .set(authHeader)
      .send({ override_pin: '1234', reason: 'out of stock' });
    assertEqualOrThrow(
      blockedCancelRes.status,
      409,
      'partially paid active order blocks item cancel in favor of refund',
    );
    db.prepare('DELETE FROM cloud_sync_outbox').run();
    const itemRefundRes = await request(app)
      .post('/api/refunds')
      .set(authHeader)
      .send({
        bill_id: partialBillId,
        order_item_id: refundBlockerItemId,
        method: 'card',
        approver_id: 'mgr-test-001',
        override_pin: '1234',
        reason: 'out of stock',
      });
    assertEqualOrThrow(itemRefundRes.status, 201, 'item refund on active partial bill succeeds');
    const afterRefundState = readOrderState(refundActiveOrderId);
    assertEqualOrThrow(
      afterRefundState.status,
      'ready',
      'refunding the last unready item promotes active order to ready',
    );
    assertOrThrow(afterRefundState.ready_at !== null, 'item refund promotion populates ready_at');
    const refundAudits = readStatusAudits(refundActiveOrderId);
    assertEqualOrThrow(refundAudits.length, 1, 'item refund records status_changed audit');
    assertEqualOrThrow(
      JSON.parse(refundAudits[0].details).to,
      'ready',
      'item refund status_changed audit records ready target',
    );
    const refundOutbox = db
      .prepare('SELECT event_type FROM cloud_sync_outbox ORDER BY created_at DESC LIMIT 1')
      .get() as { event_type: string } | undefined;
    assertEqualOrThrow(
      refundOutbox?.event_type,
      'order.ready',
      'item refund reconciliation emits order.ready cloud event',
    );

    // Completed parent order is never reopened/mutated by KDS item updates
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, completed_at, created_at, updated_at)
      VALUES ('KDS-PREPAID-COMPLETED', 'takeaway', 'completed', 10, 10, ?, ?, ?)`).run(
      now(),
      now(),
      now(),
    );
    const prepaidCompletedOrderId = (
      db.prepare("SELECT id FROM orders WHERE order_number = 'KDS-PREPAID-COMPLETED'").get() as any
    ).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-contract-product', 'Contract food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(
      prepaidCompletedOrderId,
      now(),
      now(),
    );
    const prepaidItemId = (
      db
        .prepare('SELECT id FROM order_items WHERE order_id = ?')
        .get(prepaidCompletedOrderId) as any
    ).id;
    for (const st of ['preparing', 'ready', 'served']) {
      const prepRes = await request(app)
        .patch(`/api/order-items/${prepaidItemId}/status`)
        .set(authHeader)
        .send({ status: st });
      assertEqualOrThrow(prepRes.status, 200, `prepaid completed item -> ${st} succeeds`);
      assertEqualOrThrow(
        readOrderState(prepaidCompletedOrderId).status,
        'completed',
        `completed order status is never mutated when item moves to ${st}`,
      );
    }

    // KDS disabled preserves manual parent-status workflow without automatic item reconciliation
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'false', ?)",
    ).run(now());
    try {
      const manualOrderRes = await request(app)
        .post('/api/orders')
        .set(authHeader)
        .send({
          type: 'takeaway',
          items: [{ product_id: 'kds-contract-product', quantity: 1 }],
        });
      assertEqualOrThrow(manualOrderRes.status, 201, 'KDS-disabled takeaway created');
      const manualOrderId = manualOrderRes.body.order.id;
      const manualReadyRes = await request(app)
        .patch(`/api/orders/${manualOrderId}/status`)
        .set(authHeader)
        .send({ status: 'ready' });
      assertEqualOrThrow(manualReadyRes.status, 200, 'manual parent ready succeeds with KDS disabled');
      assertEqualOrThrow(
        readOrderState(manualOrderId).status,
        'ready',
        'manual parent status is ready with KDS disabled',
      );
      const manualAppendRes = await request(app)
        .post(`/api/orders/${manualOrderId}/items`)
        .set(authHeader)
        .send({ items: [{ product_id: 'kds-contract-bar-product', quantity: 1 }] });
      assertEqualOrThrow(manualAppendRes.status, 200, 'append succeeds with KDS disabled');
      assertEqualOrThrow(
        readOrderState(manualOrderId).status,
        'ready',
        'KDS-disabled mode preserves manual parent status without auto-reconciliation',
      );
    } finally {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)",
      ).run(now());
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('cloud_orders_enabled', '0', ?)",
      ).run(now());
    }

    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE order_items SET order_id = ? WHERE id = ?').run('missing-order', barItemId);
    db.exec('PRAGMA foreign_keys = ON');
    const orphanUpdate = await request(app)
      .patch(`/api/order-items/${barItemId}/status`)
      .set(authHeader)
      .send({ status: 'ready' });
    assertEqual(orphanUpdate.status, 404, 'orphaned order item update returns 404');
    assertEqual(
      orphanUpdate.body.display_code,
      'orphaned_order',
      'orphaned order-item rejection has a safe branch code',
    );
    assertEqual(
      (db.prepare('SELECT status FROM order_items WHERE id = ?').get(barItemId) as any).status,
      'preparing',
      'orphaned update does not commit a status change',
    );
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  if (getResults().failed > 0) process.exit(1);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
