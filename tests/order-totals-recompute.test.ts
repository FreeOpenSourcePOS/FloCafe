/**
 * Characterization coverage for every order-total recomputation site.
 *
 * The rule "rescale item tax by the discounted share of the subtotal, add
 * charge tax, add charges, round to the currency" was written out by hand at
 * six call sites (`POST /:id/items`, `PATCH /:id/discount`,
 * `PATCH /:id/items/:itemId/discount`, the item cancel and restore routes, and
 * `POST /bills/:id/applyDiscount`). Collapsing them into one function must not
 * move a number, so this file freezes what each site currently writes to
 * `orders` and `bills`.
 *
 * It also pins the one site that disagrees with the others: the order-level
 * discount scales tax against the *stored* `orders.subtotal` while every other
 * site scales against a freshly summed one. When the stored subtotal is stale
 * the two produce different tax, and the difference is visible below. That
 * divergence is preserved deliberately - resolving it is a money-formula
 * decision, not a refactor - so this test asserts the stored behavior, not the
 * behavior someone might prefer.
 *
 * The tax pack is the dual-rate fixture: two 2.5% components = 5% exclusive
 * on an uncategorized customer, in INR (2 decimals).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-totals-recompute.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-totals-recompute-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-totals-recompute';

const {
  initTestDb, createApp, startServer, api, assertEqualOrThrow, getResults, resetCounters, closeDatabase,
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct, installAndActivateTestTaxPack,
} = require('./helpers/test-setup');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { registerRoutes } = require('../main/routes/index');
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');
const testTaxPack = { ...dualRatePackData, id: 'test-in-pack', country: 'IN', currency: 'INR', publisher: 'FreeOpenSourcePOS' };

/** Frozen money columns, plus the per-rate tax components reduced to [title, rate, amount]. */
function totalsRow(db: any, table: string, id: any) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
  return {
    subtotal: row.subtotal,
    tax_amount: row.tax_amount,
    discount_amount: row.discount_amount,
    total: row.total,
    round_off: row.round_off,
    components: JSON.stringify(
      JSON.parse(row.tax_breakdown || '[]').map((group: any[]) => group.map((c: any) => [c.title, c.rate, c.amount])),
    ),
  };
}

async function main() {
  console.log('Order-total recomputation characterization');
  console.log('='.repeat(60));
  resetCounters();

  resetPinRateLimitForTests();
  const db = initTestDb();
  installAndActivateTestTaxPack(db, testTaxPack);
  const { authHeader } = seedOwnerUser(db);
  seedManagerUser(db); // the '1234' override PIN used by every mutation below
  seedCategory(db, 'cat-totals', 'Totals');
  const taxable = { tax_category_id: 'standard', tax_behavior: 'exclusive' };
  seedProduct(db, 'prod-totals-100', 'cat-totals', 'Hundred', 100, taxable);
  seedProduct(db, 'prod-totals-200', 'cat-totals', 'Two hundred', 200, taxable);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const createOrder = (body: any) => api(baseUrl, '/api/orders', { method: 'POST', body, headers: authHeader });
  const orderDiscount = (orderId: any, value: number) =>
    api(baseUrl, `/api/orders/${orderId}/discount`, { method: 'PATCH', body: { discount_type: 'percentage', discount_value: value, override_pin: '1234' }, headers: authHeader });
  const addItems = (orderId: any, items: any[]) =>
    api(baseUrl, `/api/orders/${orderId}/items`, { method: 'POST', body: { items }, headers: authHeader });
  const itemIdOf = (order: any, productId: string) => order.items.find((i: any) => i.product_id === productId).id;

  try {
    console.log('\n─── POST /:id/items (fresh subtotal basis) ───');
    {
      const created = await createOrder({
        type: 'takeaway', packaging_charge: 20, delivery_charge: 30, service_charge: 5,
        items: [{ product_id: 'prod-totals-100', quantity: 1 }, { product_id: 'prod-totals-200', quantity: 1 }],
      });
      assertEqualOrThrow(created.status, 201, 'order created');
      const orderId = created.data.order.id;
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 300, tax_amount: 15, discount_amount: 0, total: 370, round_off: 0,
        components: '[[["Tax A",2.5,2.5],["Tax B",2.5,2.5]],[["Tax A",2.5,5],["Tax B",2.5,5]]]',
      }), 'create: 300 + 15 tax + 55 charges = 370');

      const discounted = await orderDiscount(orderId, 10);
      assertEqualOrThrow(discounted.status, 200, '10% order discount applied');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 300, tax_amount: 13.5, discount_amount: 30, total: 338.5, round_off: 0,
        components: '[[["Tax A",2.5,2.25],["Tax B",2.5,2.25]],[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'order discount: 30 off, tax rescaled by 270/300 = 0.9, total 338.5');

      const added = await addItems(orderId, [{ product_id: 'prod-totals-100', quantity: 2 }]);
      assertEqualOrThrow(added.status, 200, 'items added to a discounted order');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 500, tax_amount: 22.5, discount_amount: 50, total: 527.5, round_off: 0,
        components: '[[["Tax A",2.5,2.25],["Tax B",2.5,2.25]],[["Tax A",2.5,4.5],["Tax B",2.5,4.5]],[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'add-items re-derives the percentage discount from the fresh 500 subtotal (50), rescaling tax to 22.5, total 527.5');
    }

    console.log('\n─── PATCH /:id/discount (stored subtotal basis) ───');
    {
      const created = await createOrder({ type: 'takeaway', delivery_charge: 30, items: [{ product_id: 'prod-totals-200', quantity: 2 }] });
      const orderId = created.data.order.id;
      // Age the stored subtotal so it no longer matches the sum of active items
      // (fresh = 400). Nothing in normal traffic does this; it isolates which
      // number the site scales tax by.
      db.prepare('UPDATE orders SET subtotal = ? WHERE id = ?').run(300, orderId);
      const discounted = await orderDiscount(orderId, 10);
      assertEqualOrThrow(discounted.status, 200, '10% discount applied over a stale stored subtotal');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 300, tax_amount: 18, discount_amount: 30, total: 318, round_off: 0,
        components: '[[["Tax A",2.5,9],["Tax B",2.5,9]]]',
      }), 'order discount scales the STORED 300: 30 off, tax = 20 x (270/300) = 18, total 318');
      assertEqualOrThrow(totalsRow(db, 'orders', orderId).subtotal, 300, 'this site does not refresh orders.subtotal from the items');

      // The same order recomputed on the fresh basis: 500 subtotal, discount
      // re-derived as 10% of 500, tax 25 x 0.9 = 22.5. A fresh basis for the
      // discount edit above would have produced 400/40/18.5/408.5 instead.
      const added = await addItems(orderId, [{ product_id: 'prod-totals-100', quantity: 1 }]);
      assertEqualOrThrow(added.status, 200, 'add-items recomputes the same order on the fresh basis');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 500, tax_amount: 22.5, discount_amount: 50, total: 502.5, round_off: 0,
        components: '[[["Tax A",2.5,9],["Tax B",2.5,9]],[["Tax A",2.5,2.25],["Tax B",2.5,2.25]]]',
      }), 'add-items ignores the stale stored subtotal and uses the fresh 500');
    }

    console.log('\n─── PATCH /:id/items/:itemId/discount (proportional rescale) ───');
    {
      const created = await createOrder({
        type: 'takeaway', delivery_charge: 30,
        items: [{ product_id: 'prod-totals-200', quantity: 1 }, { product_id: 'prod-totals-100', quantity: 1 }],
      });
      const orderId = created.data.order.id;
      const itemId = itemIdOf(created.data.order, 'prod-totals-100');
      assertEqualOrThrow((await orderDiscount(orderId, 10)).status, 200, '10% order discount applied');
      const itemDiscount = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
        method: 'PATCH', body: { discount_type: 'percentage', discount_value: 20, override_pin: '1234' }, headers: authHeader,
      });
      assertEqualOrThrow(itemDiscount.status, 200, '20% item discount applied to the 100 item');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 280, tax_amount: 12.6, discount_amount: 28, total: 294.6, round_off: 0,
        components: '[[["Tax A",2.5,4.5],["Tax B",2.5,4.5]],[["Tax A",2.5,1.8],["Tax B",2.5,1.8]]]',
      }), 'item discount: fresh subtotal 280, order discount rescaled 30 x (280/300) = 28, tax 14 x 0.9 = 12.6, total 294.6');
    }

    console.log('\n─── Item cancel (void and plain) and restore ───');
    {
      const created = await createOrder({
        type: 'takeaway', packaging_charge: 20, delivery_charge: 30,
        items: [{ product_id: 'prod-totals-100', quantity: 1 }, { product_id: 'prod-totals-200', quantity: 1 }],
      });
      const orderId = created.data.order.id;
      const itemId = itemIdOf(created.data.order, 'prod-totals-200');
      assertEqualOrThrow((await orderDiscount(orderId, 10)).status, 200, '10% order discount applied');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 300, tax_amount: 13.5, discount_amount: 30, total: 333.5, round_off: 0,
        components: '[[["Tax A",2.5,2.25],["Tax B",2.5,2.25]],[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'pre-cancel: 300 / 13.5 / 30 / 333.5');

      db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(itemId);
      const voided = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/cancel`, {
        method: 'PATCH', body: { override_pin: '1234' }, headers: authHeader,
      });
      assertEqualOrThrow(voided.status, 200, 'voiding the 200 item');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 100, tax_amount: 4.5, discount_amount: 10, total: 144.5, round_off: 0,
        components: '[[["Tax A",2.5,2.25],["Tax B",2.5,2.25]]]',
      }), 'void: the void_adjustment line is terminal, so the fresh sum is 100, discount 10, tax 4.5, total 144.5');

      const plainOrder = await createOrder({
        type: 'takeaway', packaging_charge: 20, delivery_charge: 30,
        items: [{ product_id: 'prod-totals-100', quantity: 1 }, { product_id: 'prod-totals-200', quantity: 1 }],
      });
      const plainId = plainOrder.data.order.id;
      const plainItemId = itemIdOf(plainOrder.data.order, 'prod-totals-200');
      assertEqualOrThrow((await orderDiscount(plainId, 10)).status, 200, '10% order discount applied');
      const cancelled = await api(baseUrl, `/api/orders/${plainId}/items/${plainItemId}/cancel`, {
        method: 'PATCH', body: {}, headers: authHeader,
      });
      assertEqualOrThrow(cancelled.status, 200, 'cancelling the 200 item without a PIN');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', plainId)), JSON.stringify({
        subtotal: 100, tax_amount: 4.5, discount_amount: 10, total: 144.5, round_off: 0,
        components: '[[["Tax A",2.5,2.25],["Tax B",2.5,2.25]]]',
      }), 'plain cancel: same recomputation as the void path (100 / 4.5 / 10 / 144.5)');

      const restored = await api(baseUrl, `/api/orders/${plainId}/items/${plainItemId}/restore`, {
        method: 'PATCH', body: {}, headers: authHeader,
      });
      assertEqualOrThrow(restored.status, 200, 'restoring the cancelled item');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', plainId)), JSON.stringify({
        subtotal: 300, tax_amount: 13.5, discount_amount: 30, total: 333.5, round_off: 0,
        components: '[[["Tax A",2.5,2.25],["Tax B",2.5,2.25]],[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'restore: the totals return to the pre-cancel values (300 / 13.5 / 30 / 333.5)');
    }

    console.log('\n─── POST /bills/:id/applyDiscount (bill subtotal basis) ───');
    {
      const created = await createOrder({ type: 'takeaway', delivery_charge: 30, items: [{ product_id: 'prod-totals-200', quantity: 1 }] });
      const orderId = created.data.order.id;
      const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orderId }, headers: authHeader });
      assertEqualOrThrow(bill.status, 201, 'bill generated');
      const billId = bill.data.bill.id;
      const applied = await api(baseUrl, `/api/bills/${billId}/applyDiscount`, {
        method: 'POST', body: { type: 'percentage', value: 10, override_pin: '1234' }, headers: authHeader,
      });
      assertEqualOrThrow(applied.status, 200, '10% bill discount applied');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'bills', billId)), JSON.stringify({
        subtotal: 200, tax_amount: 9, discount_amount: 20, total: 219, round_off: 0,
        components: '[[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'bill: 20 off, tax 10 x (180/200) = 9, total 219 with no payable round-off');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 200, tax_amount: 9, discount_amount: 20, total: 219, round_off: 0,
        components: '[[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'the order mirrors the bill exactly (total unrounded, round_off 0)');
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
