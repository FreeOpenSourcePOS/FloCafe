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
 * Since #877 the freshly summed subtotal is the only basis at every site. The
 * two discount paths heal the stored `subtotal` column to that sum in the same
 * transaction that writes the discount, and the shared recomputation clamps the
 * discount to the subtotal it is deducted from. The cases below pin that,
 * including the sharp one: a stored subtotal that has fallen below the discount
 * used to produce a zero ratio and wipe the order's entire tax.
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
const { recomputeOrderTotals } = require('../main/services/orders');
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
  const orderFlatDiscount = (orderId: any, value: number) =>
    api(baseUrl, `/api/orders/${orderId}/discount`, { method: 'PATCH', body: { discount_type: 'amount', discount_value: value, override_pin: '1234' }, headers: authHeader });
  const billDiscount = (billId: any, type: string, value: number) =>
    api(baseUrl, `/api/bills/${billId}/applyDiscount`, { method: 'POST', body: { type, value, override_pin: '1234' }, headers: authHeader });
  // The flat-discount cases need a store that allows both discount types.
  const allowFlatDiscounts = () => db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('discount_mode', 'both');
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

    console.log('\n─── PATCH /:id/discount (fresh subtotal basis, heals the column) ───');
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
        subtotal: 400, tax_amount: 18, discount_amount: 40, total: 408, round_off: 0,
        components: '[[["Tax A",2.5,9],["Tax B",2.5,9]]]',
      }), 'the fresh 400 heals the stored column and is the discount basis: 40 off, tax = 20 x (360/400) = 18, total 408');

      // The same order recomputed after adding an item: fresh 500, so the
      // percentage discount re-derives to 50 and tax to 25 x 0.9 = 22.5.
      const added = await addItems(orderId, [{ product_id: 'prod-totals-100', quantity: 1 }]);
      assertEqualOrThrow(added.status, 200, 'add-items recomputes the same order on the fresh basis');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 500, tax_amount: 22.5, discount_amount: 50, total: 502.5, round_off: 0,
        components: '[[["Tax A",2.5,9],["Tax B",2.5,9]],[["Tax A",2.5,2.25],["Tax B",2.5,2.25]]]',
      }), 'add-items keeps using the fresh 500 for both the discount and the rescale');
    }

    console.log('\n─── PATCH /:id/discount over a stored subtotal below the discount (#877) ───');
    {
      const created = await createOrder({ type: 'takeaway', delivery_charge: 30, items: [{ product_id: 'prod-totals-200', quantity: 2 }] });
      const orderId = created.data.order.id;
      // Stored 100 against a fresh 400. The stored basis capped the 300 discount
      // at 100, which left a 0 subtotal, a 0 ratio and wiped the whole 20 of tax.
      allowFlatDiscounts();
      db.prepare('UPDATE orders SET subtotal = ? WHERE id = ?').run(100, orderId);
      const discounted = await orderFlatDiscount(orderId, 300);
      assertEqualOrThrow(discounted.status, 200, 'flat 300 discount applied over a stored subtotal below the discount');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 400, tax_amount: 5, discount_amount: 300, total: 135, round_off: 0,
        components: '[[["Tax A",2.5,2.5],["Tax B",2.5,2.5]]]',
      }), 'the fresh basis leaves 100 of subtotal, so tax stands at 20 x (100/400) = 5 instead of being wiped to 0');
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

    console.log('\n─── POST /bills/:id/applyDiscount (fresh basis, heals both rows) ───');
    {
      const created = await createOrder({ type: 'takeaway', delivery_charge: 30, items: [{ product_id: 'prod-totals-200', quantity: 1 }] });
      const orderId = created.data.order.id;
      const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orderId }, headers: authHeader });
      assertEqualOrThrow(bill.status, 201, 'bill generated');
      const billId = bill.data.bill.id;
      const applied = await billDiscount(billId, 'percentage', 10);
      assertEqualOrThrow(applied.status, 200, '10% bill discount applied');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'bills', billId)), JSON.stringify({
        subtotal: 200, tax_amount: 9, discount_amount: 20, total: 219, round_off: 0,
        components: '[[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'bill: 20 off, tax 10 x (180/200) = 9, total 219 with no payable round-off');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', orderId)), JSON.stringify({
        subtotal: 200, tax_amount: 9, discount_amount: 20, total: 219, round_off: 0,
        components: '[[["Tax A",2.5,4.5],["Tax B",2.5,4.5]]]',
      }), 'the order mirrors the bill exactly (total unrounded, round_off 0)');

      // Stale subtotals on both rows against a fresh 400, with a flat 300: the
      // stored bill basis capped the discount at 100 and zeroed the tax.
      allowFlatDiscounts();
      const staleOrder = await createOrder({ type: 'takeaway', delivery_charge: 30, items: [{ product_id: 'prod-totals-200', quantity: 2 }] });
      const staleOrderId = staleOrder.data.order.id;
      const staleBill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: staleOrderId }, headers: authHeader });
      const staleBillId = staleBill.data.bill.id;
      db.prepare('UPDATE bills SET subtotal = ? WHERE id = ?').run(100, staleBillId);
      db.prepare('UPDATE orders SET subtotal = ? WHERE id = ?').run(100, staleOrderId);
      const staleApplied = await billDiscount(staleBillId, 'amount', 300);
      assertEqualOrThrow(staleApplied.status, 200, 'flat 300 bill discount applied over stale bill and order subtotals');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'bills', staleBillId)), JSON.stringify({
        subtotal: 400, tax_amount: 5, discount_amount: 300, total: 135, round_off: 0,
        components: '[[["Tax A",2.5,2.5],["Tax B",2.5,2.5]]]',
      }), 'bill heals its own subtotal to 400 and keeps 5 of tax standing (was 0)');
      assertEqualOrThrow(JSON.stringify(totalsRow(db, 'orders', staleOrderId)), JSON.stringify({
        subtotal: 400, tax_amount: 5, discount_amount: 300, total: 135, round_off: 0,
        components: '[[["Tax A",2.5,2.5],["Tax B",2.5,2.5]]]',
      }), 'the order row is healed in the same transaction as the bill');
    }

    console.log('\n─── POST /bills/:id/applyDiscount refusals (unchanged) ───');
    {
      const paidOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-totals-100', quantity: 1 }] });
      const paidBill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: paidOrder.data.order.id }, headers: authHeader });
      const paidBillId = paidBill.data.bill.id;
      db.prepare("UPDATE bills SET payment_status = 'paid' WHERE id = ?").run(paidBillId);
      const paidApplied = await billDiscount(paidBillId, 'percentage', 10);
      assertEqualOrThrow(paidApplied.status, 400, 'a paid bill is still refused');
      assertEqualOrThrow(totalsRow(db, 'bills', paidBillId).discount_amount, 0, 'the paid bill is untouched');

      const splitOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-totals-100', quantity: 1 }] });
      const splitBill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: splitOrder.data.order.id }, headers: authHeader });
      const splitBillId = splitBill.data.bill.id;
      db.prepare('UPDATE bills SET split_group_id = ? WHERE id = ?').run('split-877', splitBillId);
      const splitApplied = await billDiscount(splitBillId, 'percentage', 10);
      assertEqualOrThrow(splitApplied.status, 409, 'a split bill is still refused');
      assertEqualOrThrow(totalsRow(db, 'bills', splitBillId).discount_amount, 0, 'the split bill is untouched');
    }

    console.log('\n─── recomputeOrderTotals: the discount clamp, directly ───');
    {
      const tenantInfo = { country: 'IN', business_type: 'restaurant', state_code: '', currency: 'INR', taxes_enabled: true };
      const recompute = (subtotal: number, discountAmount: number) => recomputeOrderTotals({
        tenantInfo,
        chargeContext: {},
        customer: null,
        totals: {
          subtotal, totalTax: 20, exclusiveTax: 20, allTaxBreakdowns: [], allTaxSnapshots: [], activeItems: [],
        },
        discountAmount,
        taxScaling: 'when-discounted',
      });

      const overDiscount = recompute(100, 500);
      assertEqualOrThrow(overDiscount.discountedSubtotal, 0, 'a discount larger than the subtotal clamps to the whole subtotal, never below it');
      assertEqualOrThrow(overDiscount.taxRatio, 0, 'the ratio bottoms out at 0');
      assertEqualOrThrow(overDiscount.taxAmount, 0, 'tax follows the clamp to 0');

      const negativeDiscount = recompute(100, -50);
      assertEqualOrThrow(negativeDiscount.discountedSubtotal, 100, 'a negative discount cannot raise the discounted subtotal');
      assertEqualOrThrow(negativeDiscount.taxRatio, 1, 'a negative discount leaves the tax ratio at 1');
      assertEqualOrThrow(negativeDiscount.taxAmount, 20, 'a negative discount leaves the full 20 of tax standing');

      const zeroSubtotal = recompute(0, 50);
      assertEqualOrThrow(zeroSubtotal.taxRatio, 1, 'a zero subtotal is not divided by: the ratio stays 1');
      assertEqualOrThrow(zeroSubtotal.discountedSubtotal, 0, 'a zero subtotal stays zero');
      assertEqualOrThrow(zeroSubtotal.taxAmount, 20, 'a zero subtotal leaves the full 20 of tax standing');

      const negativeSubtotal = recompute(-50, 10);
      assertEqualOrThrow(negativeSubtotal.taxRatio, 1, 'a negative subtotal is not divided by: the ratio stays 1');
      assertEqualOrThrow(negativeSubtotal.taxAmount, 20, 'a negative subtotal leaves the full 20 of tax standing');
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
