/**
 * Regression coverage for GHSA-9jjq-2fmw-x3mw: manager-PIN throttling must be
 * independent of order/item identifiers. Rotating the order or item id must
 * not reset the 5-attempt budget.
 *
 * Run: node tests/run-electron-node-test.cjs tests/manager-pin-rate-limit-bypass.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pin-rate-limit-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-pin-rate-limit';

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

// Seeds a 'preparing' order with a single 'preparing' item, so that cancelling
// the order (via /status) and voiding the item (via /items/:id/cancel) both
// require a manager PIN.
function seedPreparingOrder(db: any, suffix: string, ownerId?: string) {
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, user_id, created_at, updated_at)
    VALUES (?, 'takeaway', 'preparing', 100, 100, ?, ?, ?)`)
    .run(`ORD-PINLIM-${suffix}`, ownerId || null, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-PINLIM-${suffix}`) as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'pinlim-product', 'Pinlim item', 100, 1, 100, 0, 100, 'preparing', ?, ?)`)
    .run(orderId, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
  return { orderId, itemId };
}

async function main() {
  const db = initTestDb();
  const managerAuth = seedUser(db, 'mgr-pinlim', 'manager', '1234');
  const cashierAuth = seedUser(db, 'cashier-pinlim', 'cashier');
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('pinlim-category', 'Pinlim', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('pinlim-product', 'pinlim-category', 'Pinlim item', 100, 1, 1)`).run();

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
    // ── Order-cancel path: rotating order ids must not reset the budget ──
    console.log('\nOrder-cancel PIN budget is shared across orders');
    {
      const a = seedPreparingOrder(db, 'A', 'cashier-pinlim');
      const b = seedPreparingOrder(db, 'B', 'cashier-pinlim');
      for (let i = 0; i < 5; i++) {
        const res = await api(baseUrl, `/api/orders/${a.orderId}/status`, {
          method: 'PATCH', body: { status: 'cancelled', override_pin: '9999' }, headers: managerAuth,
        });
        assertEqual(res.status, 403, `wrong PIN attempt ${i + 1} on order A returns 403`);
      }
      const exhausted = await api(baseUrl, `/api/orders/${a.orderId}/status`, {
        method: 'PATCH', body: { status: 'cancelled', override_pin: '9999' }, headers: managerAuth,
      });
      assertEqual(exhausted.status, 429, '6th attempt on order A is throttled (429)');
      const rotated = await api(baseUrl, `/api/orders/${b.orderId}/status`, {
        method: 'PATCH', body: { status: 'cancelled', override_pin: '9999' }, headers: managerAuth,
      });
      assertEqual(rotated.status, 429, 'rotating to order B does not reset the budget (429)');
    }

    // ── Item-void path: rotating item ids must not reset the budget ──────
    console.log('\nItem-void PIN budget is shared across items');
    {
      const a = seedPreparingOrder(db, 'VA', 'cashier-pinlim');
      const b = seedPreparingOrder(db, 'VB', 'cashier-pinlim');
      for (let i = 0; i < 5; i++) {
        const res = await api(baseUrl, `/api/orders/${a.orderId}/items/${a.itemId}/cancel`, {
          method: 'PATCH', body: { override_pin: '9999' }, headers: cashierAuth,
        });
        assertEqual(res.status, 403, `wrong PIN attempt ${i + 1} on item A returns 403`);
      }
      const exhausted = await api(baseUrl, `/api/orders/${a.orderId}/items/${a.itemId}/cancel`, {
        method: 'PATCH', body: { override_pin: '9999' }, headers: cashierAuth,
      });
      assertEqual(exhausted.status, 429, '6th attempt on item A is throttled (429)');
      const rotated = await api(baseUrl, `/api/orders/${b.orderId}/items/${b.itemId}/cancel`, {
        method: 'PATCH', body: { override_pin: '9999' }, headers: cashierAuth,
      });
      assertEqual(rotated.status, 429, 'rotating to item B does not reset the budget (429)');
    }
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) {
    console.error(`${results.failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('✅ Manager PIN rate-limit bypass regression passed');
}

main().catch((error: any) => { console.error(error); process.exit(1); });
