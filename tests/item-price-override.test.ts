/**
 * Owner-only manual item price override: route, create/add-items paths, totals, audit and report.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/item-price-override.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-item-price-override-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-item-price-override';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { registerRoutes } = require('../main/routes/index');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Item price override');
  console.log('='.repeat(60));
  resetCounters();
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-po', 'PO', 1)`).run();
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
     VALUES ('prod-po', 'cat-po', 'Steak', 500, 'none', 1, 1, ?, ?)`,
  ).run(now(), now());
  const ownerAuth = seedUser(db, 'owner-po', 'owner');
  const managerAuth = seedUser(db, 'mgr-po', 'manager');
  const cashierAuth = seedUser(db, 'cash-po', 'cashier');

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const createOrder = (headers: any, item: Record<string, unknown> = {}) =>
    api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-po', quantity: 2, ...item }] },
      headers: { ...headers, 'Idempotency-Key': `po-${Math.random()}` },
    });
  const price = (orderId: any, itemId: any, body: any, headers: any) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/price`, {
      method: 'PATCH',
      body,
      headers,
    });
  const itemRow = (id: any) => db.prepare('SELECT * FROM order_items WHERE id = ?').get(id) as any;
  const orderRow = (id: any) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;

  try {
    console.log('\n--- Override after the order exists ---');
    const created = await createOrder(ownerAuth);
    assertEqualOrThrow(created.status, 201, 'order is created at menu price');
    const orderId = created.data.order.id;
    const itemId = created.data.order.items[0].id;
    assertEqualOrThrow(orderRow(orderId).total, 1000, 'menu total is 2 x 500');

    for (const [name, headers] of [
      ['manager', managerAuth],
      ['cashier', cashierAuth],
    ] as const) {
      const denied = await price(orderId, itemId, { price: 350, reason: 'regular' }, headers);
      assertEqualOrThrow(denied.status, 403, `${name} cannot override a price`);
    }
    assertEqualOrThrow(itemRow(itemId).unit_price, 500, 'a rejected request changes nothing');

    assertEqualOrThrow(
      (await price(orderId, itemId, { price: 350 }, ownerAuth)).status,
      400,
      'a reason is required',
    );
    assertEqualOrThrow(
      (await price(orderId, itemId, { price: -1, reason: 'x' }, ownerAuth)).status,
      400,
      'a negative price is rejected',
    );

    const ok = await price(orderId, itemId, { price: 350, reason: 'Regular customer' }, ownerAuth);
    assertEqualOrThrow(ok.status, 200, 'the owner can override a price');
    const row = itemRow(itemId);
    assertEqualOrThrow(row.unit_price, 350, 'effective price is the override');
    assertEqualOrThrow(row.price_overridden, 1, 'the item is flagged');
    assertEqualOrThrow(row.original_unit_price, 500, 'the menu price is retained');
    assertEqualOrThrow(row.price_override_reason, 'Regular customer', 'the reason is stored');
    assertEqualOrThrow(row.price_overridden_by, 'owner-po', 'the actor is stored');
    assertOrThrow(!!row.price_overridden_at, 'the time is stored');
    assertEqualOrThrow(row.subtotal, 700, 'item subtotal uses the override');
    assertEqualOrThrow(orderRow(orderId).total, 700, 'order total is recomputed by the backend');

    const second = await price(orderId, itemId, { price: 0, reason: 'Comp' }, ownerAuth);
    assertEqualOrThrow(second.status, 200, 'a complimentary zero price is allowed');
    assertEqualOrThrow(itemRow(itemId).unit_price, 0, 'price is zero');
    assertEqualOrThrow(itemRow(itemId).original_unit_price, 500, 'the first menu price is kept');
    assertEqualOrThrow(orderRow(orderId).total, 0, 'order total follows a zero price');

    const audit = db
      .prepare(
        "SELECT details_json FROM order_audit_log WHERE order_id = ? AND action = 'item_price_overridden' ORDER BY id",
      )
      .all(orderId) as any[];
    assertEqualOrThrow(audit.length, 2, 'every override is audited');
    assertEqualOrThrow(
      JSON.parse(audit[1].details_json).previous_unit_price,
      350,
      'audit has the previous price',
    );

    console.log('\n--- Quantity edits keep the override ---');
    const edited = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/edit`, {
      method: 'PATCH',
      body: { expected_edit_version: ok.data.item.edit_version + 1, quantity: 1 },
      headers: { ...ownerAuth, 'Idempotency-Key': `po-edit-${Math.random()}` },
    });
    assertEqualOrThrow(edited.status, 200, 'the quantity edit succeeds');
    const activeLine = db
      .prepare(
        "SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided')",
      )
      .get(orderId) as any;
    assertEqualOrThrow(activeLine.unit_price, 0, 'the override price survives a quantity edit');
    assertEqualOrThrow(
      activeLine.price_overridden,
      1,
      'the override flag survives a quantity edit',
    );
    assertEqualOrThrow(
      activeLine.original_unit_price,
      500,
      'the menu price survives a quantity edit',
    );

    console.log('\n--- Cart-time override on create and add-items ---');
    const denied = await createOrder(managerAuth, { price_override: { price: 1, reason: 'x' } });
    assertEqualOrThrow(denied.status, 403, 'a non-owner cannot override on create');
    const viaCart = await createOrder(ownerAuth, {
      price_override: { price: 300, reason: 'Negotiated' },
    });
    assertEqualOrThrow(viaCart.status, 201, 'the owner can override on create');
    const cartItem = itemRow(viaCart.data.order.items[0].id);
    assertEqualOrThrow(cartItem.unit_price, 300, 'cart override sets the price');
    assertEqualOrThrow(cartItem.original_unit_price, 500, 'cart override keeps the menu price');
    assertEqualOrThrow(
      orderRow(viaCart.data.order.id).total,
      600,
      'create total uses the override',
    );

    console.log('\n--- Blocked states ---');
    const paidOrder = await createOrder(ownerAuth);
    const paidOrderId = paidOrder.data.order.id;
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
       VALUES ('BILL-PO-1', ?, 1000, 1000, 1000, 0, 'paid', ?, ?)`,
    ).run(paidOrderId, now(), now());
    const blocked = await price(
      paidOrderId,
      paidOrder.data.order.items[0].id,
      { price: 1, reason: 'late' },
      ownerAuth,
    );
    assertEqualOrThrow(blocked.status, 409, 'a paid bill blocks an override');

    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    assertEqualOrThrow(
      (await price(orderId, itemId, { price: 10, reason: 'x' }, ownerAuth)).status,
      400,
      'a cancelled order blocks an override',
    );
    db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(orderId);

    console.log('\n--- Price exceptions report ---');
    const day = new Date().toISOString().slice(0, 10);
    const report = await api(
      baseUrl,
      `/api/reports/price-exceptions?start_date=${day}&end_date=${day}`,
      { headers: ownerAuth },
    );
    assertEqualOrThrow(report.status, 200, 'the report loads');
    const rows = report.data.priceExceptions.rows as any[];
    assertOrThrow(rows.length >= 2, 'overridden lines are listed');
    const zero = rows.find((r) => r.order_id === orderId);
    assertEqualOrThrow(zero.original_unit_price, 500, 'report shows the menu price');
    assertEqualOrThrow(zero.billed_unit_price, 0, 'report shows the billed price');
    assertEqualOrThrow(zero.difference, -500, 'report shows the difference');
    assertEqualOrThrow(zero.changed_by_id, 'owner-po', 'report shows who changed it');
    assertEqualOrThrow(zero.reason, 'Comp', 'report shows the reason');
    assertEqualOrThrow(
      report.data.priceExceptions.complimentaryCount >= 1,
      true,
      'comps are counted',
    );
    assertEqualOrThrow(
      (
        await api(baseUrl, `/api/reports/price-exceptions?start_date=${day}&end_date=${day}`, {
          headers: cashierAuth,
        })
      ).status,
      403,
      'a role without reports.view is refused',
    );
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
