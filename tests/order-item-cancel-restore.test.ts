/**
 * Characterization coverage for the order-item cancel and restore routes.
 *
 * These freeze the role policy, the manager-PIN override, and the
 * transaction-ownership invariant of `PATCH /api/orders/:orderId/items/:itemId/cancel`
 * and `.../restore`, so moving those handlers out of the route registrar
 * (`main/routes/index.ts`) into `main/routes/orders.ts` cannot quietly drop a
 * guard. Nothing here asserts what the code *should* do - every expectation is
 * the behavior observed before the move.
 *
 * The order of the app mounts below is deliberate: `orderRoutes` is mounted
 * *before* `registerRoutes` mounts it again, exactly like
 * `tests/orders-authz.test.ts:69-70`. Both handlers must resolve to the same
 * handler whether they live in the router or in the registrar, so this file
 * also pins which layer wins.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-item-cancel-restore.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-item-cancel-restore-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-item-cancel-restore';

const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  initTestDb, startServer, api, assertOrThrow, assertEqualOrThrow,
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

/** Seeds an order whose single item already consumed `deducted` units of stock. */
function seedOrderWithItem(db: any, suffix: string, productId: string, itemStatus: string, deducted = 0) {
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
    VALUES (?, 'takeaway', 'pending', 100, 0, 100, ?, ?)`).run(`ORD-CANCEL-${suffix}`, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-CANCEL-${suffix}`) as any).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, inventory_deducted_quantity, created_at, updated_at)
    VALUES (?, ?, 'Item', 100, 1, 100, 0, 100, ?, ?, ?, ?)`).run(orderId, productId, itemStatus, deducted, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
  if (deducted > 0) db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?').run(deducted, productId);
  return { orderId, itemId };
}

const stockOf = (db: any, productId: string) => Number((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId) as any).stock_quantity);

async function main() {
  console.log('Order-item cancel/restore characterization');
  console.log('='.repeat(60));
  resetCounters();

  resetPinRateLimitForTests();
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-cancel', 'Cancel', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-cancel', 'cat-cancel', 'Cancel item', 100, 'none', 1, 1, 1, 20, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-cancel-plain', 'cat-cancel', 'Plain item', 100, 'none', 1, 2, ?, ?)`).run(now(), now());

  const managerAuth = seedUser(db, 'mgr-cancel', 'manager', '1234');
  const ownerAuth = seedUser(db, 'owner-cancel', 'owner', '5678');
  // A cashier holds `orders.item.void` (SALES) but not `orders.item.cancel`
  // (owner+manager), so a cashier can start a void but needs a manager PIN to
  // finish one, and cannot cancel a pending item at all.
  const cashierAuth = seedUser(db, 'cashier-cancel', 'cashier', '9876');
  const waiterAuth = seedUser(db, 'waiter-cancel', 'server');

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try { req.user = jwt.verify(header.slice(7), getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/orders', orderRoutes);
  app.use('/api/bills', billRoutes);
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const cancel = (orderId: any, itemId: any, body: any, headers: any) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/cancel`, { method: 'PATCH', body, headers });
  const restore = (orderId: any, itemId: any, headers: any) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/restore`, { method: 'PATCH', body: {}, headers });
  const itemStatus = (itemId: any) => (db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemId) as any).status;

  try {
    console.log('\n─── Manager-PIN override on an in-progress item ───');
    {
      const order = seedOrderWithItem(db, 'VOID-PREPARING', 'prod-cancel', 'preparing', 3);
      const stockBefore = stockOf(db, 'prod-cancel');
      const response = await cancel(order.orderId, order.itemId, { override_pin: '1234' }, cashierAuth);
      assertEqualOrThrow(response.status, 200, 'cashier may void a preparing item with a valid manager PIN');
      assertEqualOrThrow(itemStatus(order.itemId), 'voided', 'voiding marks the original item voided');
      const adjustment = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(order.orderId) as any;
      assertEqualOrThrow(adjustment?.subtotal, -100, 'void records a mirrored negative adjustment line');
      assertEqualOrThrow(adjustment?.tax_amount, 0, 'the adjustment mirrors the item tax amount');
      assertEqualOrThrow(adjustment?.total, -100, 'the adjustment mirrors the item total');
      assertEqualOrThrow(stockOf(db, 'prod-cancel'), stockBefore, 'voiding does not restore deducted inventory');
      const audit = db.prepare("SELECT * FROM order_audit_log WHERE order_item_id = ? AND action = 'item_voided' ORDER BY id DESC LIMIT 1").get(order.itemId) as any;
      assertEqualOrThrow(audit?.actor_user_id, 'cashier-cancel', 'void audit attributes the authenticated actor');
      assertOrThrow(JSON.parse(audit?.details_json || '{}').approved_by === 'mgr-cancel', 'void audit records the approving manager');
    }
    {
      const order = seedOrderWithItem(db, 'VOID-READY', 'prod-cancel', 'ready');
      const response = await cancel(order.orderId, order.itemId, { override_pin: '1234' }, cashierAuth);
      assertEqualOrThrow(response.status, 200, 'cashier may void a ready item with a valid manager PIN');
      assertEqualOrThrow(itemStatus(order.itemId), 'voided', 'the ready item ends up voided');
    }
    {
      const order = seedOrderWithItem(db, 'VOID-NO-PIN', 'prod-cancel', 'preparing');
      const response = await cancel(order.orderId, order.itemId, {}, cashierAuth);
      assertEqualOrThrow(response.status, 400, 'a void without a manager PIN is refused');
      assertEqualOrThrow(response.data.error, 'Manager PIN required to void an item already in progress', 'the missing-PIN refusal names the override');
      assertEqualOrThrow(itemStatus(order.itemId), 'preparing', 'a refused void leaves the item untouched');
    }
    {
      const order = seedOrderWithItem(db, 'VOID-CASHIER-PIN', 'prod-cancel', 'preparing');
      const response = await cancel(order.orderId, order.itemId, { override_pin: '9876' }, cashierAuth);
      assertEqualOrThrow(response.status, 403, "a cashier's own PIN cannot authorize a void");
      assertEqualOrThrow(response.data.error, 'Invalid manager PIN', 'the own-PIN refusal identifies the PIN, not the role');
      assertEqualOrThrow(itemStatus(order.itemId), 'preparing', 'a rejected PIN leaves the item untouched');
    }

    console.log('\n─── Role policy on a pending item ───');
    {
      const order = seedOrderWithItem(db, 'CANCEL-CASHIER', 'prod-cancel', 'pending');
      const response = await cancel(order.orderId, order.itemId, {}, cashierAuth);
      assertEqualOrThrow(response.status, 403, 'a cashier may not cancel a pending item');
      assertEqualOrThrow(response.data.error, 'Only owner or manager can cancel this item', 'the cancel refusal names the role policy');
    }
    {
      const order = seedOrderWithItem(db, 'CANCEL-MANAGER', 'prod-cancel', 'pending', 2);
      const stockBefore = stockOf(db, 'prod-cancel');
      const response = await cancel(order.orderId, order.itemId, { reason: 'out of stock' }, managerAuth);
      assertEqualOrThrow(response.status, 200, 'a manager may cancel a pending item without a PIN');
      assertEqualOrThrow(itemStatus(order.itemId), 'cancelled', 'the item is cancelled');
      assertEqualOrThrow(stockOf(db, 'prod-cancel'), stockBefore + 2, 'cancelling restores the deducted inventory');
      const movement = db.prepare("SELECT * FROM inventory_movements WHERE reference_id LIKE ? ORDER BY id DESC LIMIT 1").get(`${order.itemId}:%`) as any;
      assertEqualOrThrow(movement?.movement_type, 'cancel_restore', 'the restock is recorded as a cancel_restore movement');
    }
    {
      // Orders are never ownership-gated: authorization is by role, never by
      // order creator (docs/reference/product-invariants.md).
      const order = seedOrderWithItem(db, 'CANCEL-WAITER-OTHER', 'prod-cancel', 'pending');
      const forbidden = await cancel(order.orderId, order.itemId, {}, waiterAuth);
      assertEqualOrThrow(forbidden.status, 403, 'a server cannot cancel a pending item (it holds no orders.item.cancel)');
      const allowed = await cancel(order.orderId, order.itemId, {}, ownerAuth);
      assertEqualOrThrow(allowed.status, 200, 'the owner can cancel the same order');
    }

    console.log('\n─── Paid and terminal guards ───');
    {
      const order = seedOrderWithItem(db, 'PAID', 'prod-cancel', 'pending');
      db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
        VALUES (?, ?, 100, 100, 100, 0, 'paid', ?, ?)`).run(`INV-CANCEL-PAID`, order.orderId, now(), now());
      const response = await cancel(order.orderId, order.itemId, {}, managerAuth);
      assertEqualOrThrow(response.status, 409, 'cancelling an item on a paid order is a 409');
      assertEqualOrThrow(response.data.error, 'Cannot cancel items on a paid or partially paid order', 'the 409 names the paid-order reason');
    }
    {
      const order = seedOrderWithItem(db, 'COMPLETED', 'prod-cancel', 'pending');
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(order.orderId);
      const response = await cancel(order.orderId, order.itemId, {}, managerAuth);
      assertEqualOrThrow(response.status, 400, 'cancelling an item on a completed order is a 400');
      assertEqualOrThrow(response.data.error, 'Cannot cancel items on completed or cancelled orders', 'the 400 names the terminal-state reason');
    }

    console.log('\n─── Restore ───');
    {
      const order = seedOrderWithItem(db, 'RESTORE-CASHIER', 'prod-cancel', 'cancelled');
      const forbidden = await restore(order.orderId, order.itemId, cashierAuth);
      assertEqualOrThrow(forbidden.status, 403, 'a cashier may not restore a cancelled item (it holds no orders.item.restore)');
      assertEqualOrThrow(forbidden.data.error, 'Only owner or manager can restore items', 'the restore refusal names the role policy');
    }
    {
      const order = seedOrderWithItem(db, 'RESTORE-MANAGER', 'prod-cancel', 'cancelled', 1);
      const stockBefore = stockOf(db, 'prod-cancel');
      const response = await restore(order.orderId, order.itemId, managerAuth);
      assertEqualOrThrow(response.status, 200, 'a manager may restore a cancelled item');
      assertEqualOrThrow(itemStatus(order.itemId), 'pending', 'the restored item is pending again');
      assertEqualOrThrow(stockOf(db, 'prod-cancel'), stockBefore - 1, 'restoring re-deducts the inventory the item consumed');
    }
    {
      const order = seedOrderWithItem(db, 'RESTORE-ACTIVE', 'prod-cancel', 'pending');
      const response = await restore(order.orderId, order.itemId, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'restoring an already-active item is a no-op 200');
      assertEqualOrThrow(itemStatus(order.itemId), 'pending', 'the active item is unchanged');
    }

    console.log('\n─── Transaction ownership ───');
    {
      // withTxn is `db.transaction(fn)()`, so counting calls to the underlying
      // better-sqlite3 `transaction()` counts transaction scopes. A route that
      // re-wrapped the service call would open a second, nested scope.
      const database: any = db;
      const order = seedOrderWithItem(db, 'TXN', 'prod-cancel-plain', 'pending');
      const original = database.transaction.bind(database);
      let scopes = 0;
      database.transaction = function patched(...args: any[]) { scopes += 1; return original(...args); };
      let response: any;
      try {
        response = await cancel(order.orderId, order.itemId, {}, managerAuth);
      } finally {
        database.transaction = original;
      }
      assertEqualOrThrow(response.status, 200, 'the instrumented cancel still succeeds');
      assertEqualOrThrow(scopes, 1, 'cancel opens exactly one transaction scope - the route does not double-wrap it');
    }
    {
      // One scope is only safe because withTxn nests: better-sqlite3 falls back
      // to a SAVEPOINT for an inner scope and rolls it back with the outer one.
      // Nothing else pins that contract, so pin it here.
      db.prepare('CREATE TABLE txn_nesting (id TEXT PRIMARY KEY)').run();
      withTxn(() => {
        db.prepare('INSERT INTO txn_nesting (id) VALUES (?)').run('outer');
        withTxn(() => { db.prepare('INSERT INTO txn_nesting (id) VALUES (?)').run('inner'); });
      });
      assertEqualOrThrow((db.prepare('SELECT COUNT(*) AS n FROM txn_nesting').get() as any).n, 2, 'a nested transaction commits with its parent');
      let threw = false;
      try {
        withTxn(() => {
          db.prepare('INSERT INTO txn_nesting (id) VALUES (?)').run('kept-outer');
          withTxn(() => { throw new Error('inner failure'); });
        });
      } catch { threw = true; }
      assertOrThrow(threw, 'a failing nested transaction propagates its error');
      assertEqualOrThrow((db.prepare("SELECT COUNT(*) AS n FROM txn_nesting WHERE id = 'kept-outer'").get() as any).n, 0, 'a failed nested transaction rolls back the parent scope');
    }

    console.log('\n─── Audit trail ───');
    assertOrThrow(!!db.prepare("SELECT 1 FROM order_audit_log WHERE action = 'item_cancelled'").get(), 'cancel writes an item_cancelled audit entry');
    assertOrThrow(!!db.prepare("SELECT 1 FROM order_audit_log WHERE action = 'item_restored'").get(), 'restore writes an item_restored audit entry');
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
