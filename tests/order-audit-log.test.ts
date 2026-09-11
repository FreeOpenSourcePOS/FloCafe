/**
 * Coverage for order_audit_log: every order/item mutation records who did it
 * (docs/business-decisions.md — orders are never ownership-gated, so the
 * audit trail is what makes each action traceable).
 * Run: npm run test:order-audit-log
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-audit-log-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-audit-log';

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
    .run(`ORD-AUDIT-${suffix}`, ownerId || null, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-AUDIT-${suffix}`) as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'audit-product', 'Audit item', 100, 1, 100, 0, 100, 'preparing', ?, ?)`)
    .run(orderId, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
  return { orderId, itemId };
}

function latestAudit(db: any, orderId: number, action: string) {
  return db.prepare(`SELECT * FROM order_audit_log WHERE order_id = ? AND action = ? ORDER BY id DESC LIMIT 1`).get(orderId, action) as any;
}

async function main() {
  const db = initTestDb();
  const managerAuth = seedUser(db, 'manager-audit', 'manager', '1234');
  const ownerAuth = seedUser(db, 'owner-audit', 'owner', '5678');
  const waiterAuth = seedUser(db, 'server-audit', 'server');
  const cashierAuth = seedUser(db, 'cashier-audit', 'cashier', '9876');
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('audit-category', 'Audit', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order)
    VALUES ('audit-product', 'audit-category', 'Audit item', 100, 1, 1)`).run();

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
    // items_added — a server appends items to an order created by the manager.
    const addItemsOrder = seedOrderWithItem(db, 'ADD-ITEMS', 'manager-audit');
    const addItemsRes = await api(baseUrl, `/api/orders/${addItemsOrder.orderId}/items`, {
      method: 'POST', body: { items: [{ product_id: 'audit-product', quantity: 2 }] }, headers: waiterAuth,
    });
    assertEqual(addItemsRes.status, 200, 'server can append items to another user\'s order');
    const addItemsAudit = latestAudit(db, addItemsOrder.orderId, 'items_added');
    assertEqual(addItemsAudit?.actor_user_id, 'server-audit', 'items_added audit row records the server as actor');
    const addedIds = JSON.parse(addItemsAudit?.details_json || '{}').item_ids || [];
    assertEqual(addedIds.length, 1, 'items_added audit details list the newly created item ids');

    // order_discount_applied — no approval required by default; owner applies
    // a discount to an order created by someone else.
    const discountOrder = seedOrderWithItem(db, 'ORDER-DISCOUNT', 'server-audit');
    const orderDiscountRes = await api(baseUrl, `/api/orders/${discountOrder.orderId}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 10 }, headers: ownerAuth,
    });
    assertEqual(orderDiscountRes.status, 200, 'owner can apply a discount to another user\'s order');
    const orderDiscountAudit = latestAudit(db, discountOrder.orderId, 'order_discount_applied');
    assertEqual(orderDiscountAudit?.actor_user_id, 'owner-audit', 'order_discount_applied audit row records the actor');
    assertEqual(JSON.parse(orderDiscountAudit?.details_json || '{}').discount_value, 10, 'order_discount_applied audit details record the discount value');

    // order_discount_applied with manager-PIN approval — the approving
    // manager (whose PIN was used) is distinct from the API caller.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('discount_requires_approval', 'true')
      ON CONFLICT(key) DO UPDATE SET value = 'true'`).run();
    const approvedDiscountOrder = seedOrderWithItem(db, 'ORDER-DISCOUNT-APPROVED', 'manager-audit');
    const approvedDiscountRes = await api(baseUrl, `/api/orders/${approvedDiscountOrder.orderId}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 15, override_pin: '1234' }, headers: cashierAuth,
    });
    assertEqual(approvedDiscountRes.status, 200, 'cashier can apply a PIN-approved discount');
    const approvedDiscountAudit = latestAudit(db, approvedDiscountOrder.orderId, 'order_discount_applied');
    assertEqual(approvedDiscountAudit?.actor_user_id, 'cashier-audit', 'PIN-approved discount audit records the cashier as actor (who performed it)');
    assertEqual(JSON.parse(approvedDiscountAudit?.details_json || '{}').approved_by, 'manager-audit', 'PIN-approved discount audit records the approving manager separately');
    db.prepare(`UPDATE settings SET value = 'false' WHERE key = 'discount_requires_approval'`).run();

    // item_discount_applied
    const itemDiscountOrder = seedOrderWithItem(db, 'ITEM-DISCOUNT', 'manager-audit');
    const itemDiscountRes = await api(baseUrl, `/api/orders/${itemDiscountOrder.orderId}/items/${itemDiscountOrder.itemId}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 20 }, headers: cashierAuth,
    });
    assertEqual(itemDiscountRes.status, 200, 'cashier can apply an item discount on another user\'s order');
    const itemDiscountAudit = latestAudit(db, itemDiscountOrder.orderId, 'item_discount_applied');
    assertEqual(itemDiscountAudit?.actor_user_id, 'cashier-audit', 'item_discount_applied audit row records the actor');
    assertEqual(itemDiscountAudit?.order_item_id, itemDiscountOrder.itemId, 'item_discount_applied audit row references the specific item');

    // item_restored — owner/manager only; restores a cancelled item.
    const restoreOrder = seedOrderWithItem(db, 'RESTORE', 'server-audit');
    db.prepare(`UPDATE order_items SET status = 'cancelled' WHERE id = ?`).run(restoreOrder.itemId);
    const restoreRes = await api(baseUrl, `/api/orders/${restoreOrder.orderId}/items/${restoreOrder.itemId}/restore`, {
      method: 'PATCH', body: {}, headers: managerAuth,
    });
    assertEqual(restoreRes.status, 200, 'manager can restore a cancelled item');
    const restoreAudit = latestAudit(db, restoreOrder.orderId, 'item_restored');
    assertEqual(restoreAudit?.actor_user_id, 'manager-audit', 'item_restored audit row records the actor');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) process.exit(1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
