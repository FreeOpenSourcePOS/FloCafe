/**
 * Regression coverage for order-status and manager-PIN authorization.
 * Run: npm run test:orders-authz
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-orders-authz-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-orders-authz';

const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  initTestDb, startServer, api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, pin ? bcrypt.hashSync(pin, 10) : null, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

function seedOrderWithItem(db: any, suffix: string, ownerId?: string) {
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, user_id, created_at, updated_at)
    VALUES (?, 'takeaway', 'pending', 100, 100, ?, ?, ?)`)
    .run(`ORD-AUTHZ-${suffix}`, ownerId || null, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-AUTHZ-${suffix}`) as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'authz-product', 'Authz item', 100, 1, 100, 0, 100, 'preparing', ?, ?)`)
    .run(orderId, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
  return { orderId, itemId };
}

async function main() {
  const db = initTestDb();
  const managerAuth = seedUser(db, 'manager-authz', 'manager', '1234');
  const ownerAuth = seedUser(db, 'owner-authz', 'owner', '5678');
  const cashierAuth = seedUser(db, 'cashier-authz', 'cashier', '9876');
  const waiterAuth = seedUser(db, 'server-authz', 'server');
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('authz-category', 'Authz', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('authz-product', 'authz-category', 'Authz item', 100, 1, 1)`).run();
  db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at)
    VALUES ('authz-printer', 'Authz Printer', 'network', '127.0.0.1', 9100, 1, '80mm', ?, ?)`).run(now(), now());

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try { req.user = jwt.verify(header.slice(7), getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/orders', orderRoutes);
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    const statusOrder = seedOrderWithItem(db, 'STATUS', 'cashier-authz');
    const cashierStatus = await api(baseUrl, `/api/orders/${statusOrder.orderId}/status`, {
      method: 'PATCH', body: { status: 'preparing' }, headers: cashierAuth,
    });
    assertEqual(cashierStatus.status, 200, 'cashier can advance an order to preparing');

    {
      const order = seedOrderWithItem(db, 'CASHIER-VOID', 'cashier-authz');
      const response = await api(baseUrl, `/api/orders/${order.orderId}/items/${order.itemId}/cancel`, {
        method: 'PATCH', body: { override_pin: '1234' }, headers: cashierAuth,
      });
      assertEqual(response.status, 200, 'cashier can void an in-progress item with a valid manager PIN');
      assertEqual((db.prepare('SELECT status FROM order_items WHERE id = ?').get(order.itemId) as any).status, 'voided', 'cashier void marks the original item voided');
    }

    const ownerOrder = seedOrderWithItem(db, 'OWNER-PIN', 'owner-authz');
    const ownerVoid = await api(baseUrl, `/api/orders/${ownerOrder.orderId}/items/${ownerOrder.itemId}/cancel`, {
      method: 'PATCH', body: { override_pin: '5678' }, headers: ownerAuth,
    });
    assertEqual(ownerVoid.status, 200, 'owner PIN can authorize an in-progress item void');

    const cashierPinOrder = seedOrderWithItem(db, 'CASHIER-PIN', 'cashier-authz');
    const cashierPin = await api(baseUrl, `/api/orders/${cashierPinOrder.orderId}/items/${cashierPinOrder.itemId}/cancel`, {
      method: 'PATCH', body: { override_pin: '9876' }, headers: cashierAuth,
    });
    assertEqual(cashierPin.status, 403, 'cashier PIN cannot authorize an in-progress item void');

    // Orders are never ownership-gated: any sales-role user can advance, cancel,
    // void, or print-kot any order, regardless of who created it. Only role and
    // (for in-progress cancellation) manager-PIN approval apply.
    const waiterOwnOrder = seedOrderWithItem(db, 'WAITER-OWN', 'server-authz');
    const waiterCanAdvance = await api(baseUrl, `/api/orders/${waiterOwnOrder.orderId}/status`, {
      method: 'PATCH', body: { status: 'preparing' }, headers: waiterAuth,
    });
    assertEqual(waiterCanAdvance.status, 200, 'server can advance any order, including their own');
    const otherOrder = seedOrderWithItem(db, 'WAITER-OTHER', 'cashier-authz');
    const waiterOtherStatus = await api(baseUrl, `/api/orders/${otherOrder.orderId}/status`, {
      method: 'PATCH', body: { status: 'cancelled', override_pin: '1234' }, headers: waiterAuth,
    });
    assertEqual(waiterOtherStatus.status, 200, 'server can cancel an order created by another user, given a valid manager PIN');
    const otherItemOrder = seedOrderWithItem(db, 'WAITER-OTHER-ITEM', 'cashier-authz');
    const waiterOtherItem = await api(baseUrl, `/api/orders/${otherItemOrder.orderId}/items/${otherItemOrder.itemId}/cancel`, {
      method: 'PATCH', body: { override_pin: '1234' }, headers: waiterAuth,
    });
    assertEqual(waiterOtherItem.status, 200, 'server can void an item on an order created by another user');

    const waiterKotOtherOrder = seedOrderWithItem(db, 'WAITER-KOT-OTHER', 'cashier-authz');
    db.prepare(`UPDATE order_items SET status = 'ready' WHERE order_id = ?`).run(waiterKotOtherOrder.orderId);
    const waiterKotOther = await api(baseUrl, '/api/printers/print-kot', {
      method: 'POST', body: { orderId: waiterKotOtherOrder.orderId }, headers: waiterAuth,
    });
    assertEqual(waiterKotOther.status, 200, 'server can print-kot for an order created by another user');

    const invalidPinOrder = seedOrderWithItem(db, 'INVALID-PIN', 'cashier-authz');
    const invalidPin = await api(baseUrl, `/api/orders/${invalidPinOrder.orderId}/items/${invalidPinOrder.itemId}/cancel`, {
      method: 'PATCH', body: { override_pin: '9999' }, headers: cashierAuth,
    });
    assertEqual(invalidPin.status, 403, 'cashier with an invalid manager PIN is denied');
    assert(String(invalidPin.data.error).includes('Invalid manager PIN'), 'invalid PIN denial identifies the PIN, not the role');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) process.exit(1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
