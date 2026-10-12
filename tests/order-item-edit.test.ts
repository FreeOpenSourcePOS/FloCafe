/**
 * Owner-only edit of live order items: quantity changes and replacements.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-item-edit.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-item-edit-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-item-edit';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, startServer, api, assertOrThrow, assertEqualOrThrow,
  getResults, resetCounters, closeDatabase, now,
} = require('./helpers/test-setup');
const { withTxn } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { registerRoutes } = require('../main/routes/index');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, pin ? bcrypt.hashSync(pin, 10) : null, now(), now());
  return { Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}


function seedOrder(db: any, suffix: string, itemStatus: string, quantity = 2, deducted = 0) {
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
    VALUES (?, 'takeaway', 'pending', ?, 0, ?, ?, ?)`).run(`ORD-EDIT-${suffix}`, quantity * 100, quantity * 100, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-EDIT-${suffix}`) as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, inventory_deducted_quantity, created_at, updated_at)
    VALUES (?, 'prod-edit', 'Edit item', 100, ?, ?, 0, ?, ?, ?, ?, ?)`).run(orderId, quantity, quantity * 100, quantity * 100, itemStatus, deducted, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
  if (deducted > 0) db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?').run(deducted, 'prod-edit');
  return { orderId, itemId };
}
function seedBill(db: any, orderId: any, total: number, paid: number, status: string) {
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`BILL-EDIT-${orderId}`, orderId, total, total, paid, total - paid, status, now(), now());
  return db.prepare('SELECT * FROM bills WHERE order_id = ?').get(orderId) as any;
}
const stockOf = (db: any) => Number((db.prepare("SELECT stock_quantity FROM products WHERE id = 'prod-edit'").get() as any).stock_quantity);

async function main() {
  console.log('Owner-only order item edit');
  console.log('='.repeat(60));
  resetCounters();
  resetPinRateLimitForTests();
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-edit', 'Edit', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-edit', 'cat-edit', 'Edit item', 100, 'none', 1, 1, 1, 50, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-other', 'cat-edit', 'Other item', 150, 'none', 1, 2, ?, ?)`).run(now(), now());

  const ownerAuth = seedUser(db, 'owner-edit', 'owner', '5678');
  const managerAuth = seedUser(db, 'mgr-edit', 'manager', '1234');
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const edit = (orderId: any, itemId: any, body: any, headers: any) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/edit`, { method: 'PATCH', body, headers });
  const itemStatus = (id: any) => (db.prepare('SELECT status FROM order_items WHERE id = ?').get(id) as any).status;
  const orderTotal = (id: any) => Number((db.prepare('SELECT total FROM orders WHERE id = ?').get(id) as any).total);

  try {
    console.log('\n─── Permission ───');
    {
      const order = seedOrder(db, 'PERM', 'pending');
      const response = await edit(order.orderId, order.itemId, { quantity: 3 }, managerAuth);
      assertEqualOrThrow(response.status, 403, 'a manager cannot edit order items (owner-only)');
      assertEqualOrThrow(itemStatus(order.itemId), 'pending', 'a refused edit leaves the item untouched');
    }

    console.log('\n─── Quantity ───');
    {
      const order = seedOrder(db, 'QTY-DOWN', 'pending', 3, 3);
      const bill = seedBill(db, order.orderId, 300, 0, 'unpaid');
      const stockBefore = stockOf(db);
      const response = await edit(order.orderId, order.itemId, { quantity: 1, reason: 'typo' }, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'owner can reduce a quantity');
      assertEqualOrThrow(itemStatus(order.itemId), 'cancelled', 'the original line is superseded');
      assertEqualOrThrow(orderTotal(order.orderId), 100, 'order total follows the new quantity');
      assertEqualOrThrow(stockOf(db), stockBefore + 2, 'stock is restored for the removed units only');
      const updatedBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id) as any;
      assertEqualOrThrow(updatedBill.total, 100, 'the unpaid bill total is re-synced');
      assertEqualOrThrow(updatedBill.balance, 100, 'the unpaid bill balance is re-synced');
      const active = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'").all(order.orderId) as any[];
      assertEqualOrThrow(active.length, 1, 'one active line remains');
      assertEqualOrThrow(active[0].quantity, 1, 'the active line has the new quantity');
      assertEqualOrThrow(active[0].unit_price, 100, 'the original unit price is preserved');
      const audit = db.prepare("SELECT * FROM order_audit_log WHERE order_item_id = ? AND action = 'item_edited'").get(order.itemId) as any;
      assertEqualOrThrow(audit?.actor_user_id, 'owner-edit', 'the edit is attributed to the owner');
    }
    {
      const order = seedOrder(db, 'QTY-DOWN-PREP', 'preparing', 3);
      const response = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'owner can reduce a line the kitchen already started');
      const active = db.prepare("SELECT status, quantity FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled')").all(order.orderId) as any[];
      assertEqualOrThrow(active.length, 1, 'one active line remains');
      assertEqualOrThrow(active[0].status, 'preparing', 'the reduced line keeps its kitchen status');
    }
    {
      const order = seedOrder(db, 'QTY-UP-PREP', 'preparing', 2, 2);
      const stockBefore = stockOf(db);
      const response = await edit(order.orderId, order.itemId, { quantity: 5 }, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'owner can raise a quantity');
      assertEqualOrThrow(itemStatus(order.itemId), 'preparing', 'the started line is left as it is');
      const extra = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND id != ?").get(order.orderId, order.itemId) as any;
      assertEqualOrThrow(extra?.quantity, 3, 'only the extra units become a new line');
      assertEqualOrThrow(extra?.status, 'pending', 'the extra line goes to the kitchen as pending');
      assertEqualOrThrow(orderTotal(order.orderId), 500, 'order total covers the new quantity');
      assertEqualOrThrow(stockOf(db), stockBefore - 3, 'stock is deducted for the extra units');
    }
    {
      const order = seedOrder(db, 'QTY-SAME', 'pending', 2);
      const response = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(response.status, 400, 'an unchanged quantity is rejected');
      const bad = await edit(order.orderId, order.itemId, { quantity: 0 }, ownerAuth);
      assertEqualOrThrow(bad.status, 400, 'a non-positive quantity is rejected');
      const both = await edit(order.orderId, order.itemId, { quantity: 3, replacement: { product_id: 'prod-other', quantity: 1 } }, ownerAuth);
      assertEqualOrThrow(both.status, 400, 'quantity and replacement together are rejected');
    }

    console.log('\n─── Superseded lines ───');
    {
      const order = seedOrder(db, 'SUPERSEDED', 'pending', 2);
      await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      const fetched = await api(baseUrl, `/api/orders/${order.orderId}`, { headers: ownerAuth });
      const lines = fetched.data.order.items as any[];
      const old = lines.find((line) => line.id === order.itemId);
      assertEqualOrThrow(old?.superseded, true, 'the replaced line is flagged superseded');
      assertOrThrow(!lines.find((line) => line.id !== order.itemId)?.superseded, 'the new line is not flagged');
    }

    console.log('\n─── Replacement ───');
    {
      const order = seedOrder(db, 'REPLACE', 'preparing', 2, 2);
      const bill = seedBill(db, order.orderId, 200, 0, 'unpaid');
      const stockBefore = stockOf(db);
      const response = await edit(order.orderId, order.itemId, { replacement: { product_id: 'prod-other', quantity: 2 } }, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'owner can replace an item');
      assertEqualOrThrow(itemStatus(order.itemId), 'cancelled', 'the replaced line is cancelled');
      const fresh = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND id != ?").get(order.orderId, order.itemId) as any;
      assertEqualOrThrow(fresh?.product_id, 'prod-other', 'the replacement line is the new product');
      assertEqualOrThrow(fresh?.status, 'pending', 'the replacement goes to the kitchen as pending');
      assertEqualOrThrow(orderTotal(order.orderId), 300, 'order total uses the replacement price');
      assertEqualOrThrow(stockOf(db), stockBefore + 2, 'the replaced item stock is restored');
      assertEqualOrThrow((db.prepare('SELECT total FROM bills WHERE id = ?').get(bill.id) as any).total, 300, 'the bill is re-synced');
    }

    console.log('\n─── Collected payments ───');
    {
      const order = seedOrder(db, 'PARTIAL-OK', 'pending', 3);
      const bill = seedBill(db, order.orderId, 300, 100, 'partial');
      const response = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'editing is allowed after a partial payment when the total stays above it');
      const updated = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id) as any;
      assertEqualOrThrow(updated.total, 200, 'the partially paid bill total is re-synced');
      assertEqualOrThrow(updated.balance, 100, 'the balance accounts for what was collected');
    }
    {
      const order = seedOrder(db, 'PARTIAL-LOW', 'pending', 3);
      seedBill(db, order.orderId, 300, 250, 'partial');
      const response = await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      assertEqualOrThrow(response.status, 409, 'an edit that drops the total below the collected amount is refused');
      assertEqualOrThrow(itemStatus(order.itemId), 'pending', 'the refused edit rolls back');
      assertEqualOrThrow(orderTotal(order.orderId), 300, 'the order total is unchanged after the refusal');
    }
    {
      const order = seedOrder(db, 'PAID', 'pending', 2);
      seedBill(db, order.orderId, 200, 200, 'paid');
      const response = await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      assertEqualOrThrow(response.status, 409, 'a fully paid order cannot be edited');
    }
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
