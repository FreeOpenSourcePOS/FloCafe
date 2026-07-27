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
const {
  initTestDb, createApp, seedOwnerUser, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { kdsRoutes } = require('../main/routes/kds');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-contract-station', 'Contract Station', '[]', 1, ?, ?)`).run(now(), now());
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

  const app = createApp({ '/api/kds': kdsRoutes });
  try {
    const orders = await request(app).get('/api/kds/orders').set(authHeader);
    assertEqual(orders.status, 200, 'embedded KDS orders request succeeds');
    const order = orders.body.orders.find((entry: any) => entry.id === orderId);
    assertEqual(order?.table?.name, '42', 'embedded KDS orders uses table.name');

    const display = await request(app).get('/api/kds/display?station_id=kds-contract-station').set(authHeader);
    assertEqual(display.status, 200, 'embedded KDS display request succeeds');
    assertEqual(display.body.orders[0]?.table?.name, '42', 'embedded KDS display uses table.name');
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  if (getResults().failed > 0) process.exit(1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
