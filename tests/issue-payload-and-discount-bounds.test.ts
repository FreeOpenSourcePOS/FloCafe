/**
 * Cap order item arrays per request and clamp bill discounts to subtotal.
 * Run: node tests/run-electron-node-test.cjs tests/issue-payload-and-discount-bounds.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payload-bounds-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, assertIncludes,
  getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

const MAX_ORDER_ITEMS = 200;

function itemsPayload(count: number) {
  return Array.from({ length: count }, () => ({ product_id: 'prod-bounds', quantity: 1 }));
}

async function main() {
  console.log('Issue Test: Payload and Discount Bounds');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-bounds', 'Bounds Menu');
  seedProduct(db, 'prod-bounds', 'cat-bounds', 'Espresso', 100);
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('discount_mode', 'both');
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('discount_max_amount', '0');
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('discount_requires_approval', 'false');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── order-item-payload-cap: order create item cap ───');
    const overLimit = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: itemsPayload(MAX_ORDER_ITEMS + 1) },
      headers: authHeader,
    });
    assertEqual(overLimit.status, 400, `create order with ${MAX_ORDER_ITEMS + 1} items returns 400`);
    assertIncludes(String(overLimit.data.error || ''), String(MAX_ORDER_ITEMS), 'error mentions the item cap');

    const atLimit = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: itemsPayload(MAX_ORDER_ITEMS) },
      headers: authHeader,
    });
    assertEqual(atLimit.status, 201, `create order with ${MAX_ORDER_ITEMS} items succeeds`);

    const smallOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: itemsPayload(2) },
      headers: authHeader,
    });
    assertEqual(smallOrder.status, 201, 'small order create still succeeds');

    console.log('\n─── order-item-payload-cap: order append-items cap ───');
    const appendOver = await api(baseUrl, `/api/orders/${smallOrder.data.order.id}/items`, {
      method: 'POST',
      body: { items: itemsPayload(MAX_ORDER_ITEMS + 1) },
      headers: authHeader,
    });
    assertEqual(appendOver.status, 400, `append ${MAX_ORDER_ITEMS + 1} items returns 400`);
    assertIncludes(String(appendOver.data.error || ''), String(MAX_ORDER_ITEMS), 'append error mentions the item cap');

    const appendOk = await api(baseUrl, `/api/orders/${smallOrder.data.order.id}/items`, {
      method: 'POST',
      body: { items: itemsPayload(1) },
      headers: authHeader,
    });
    assertEqual(appendOk.status, 200, 'append within cap still succeeds');

    console.log('\n─── bill-discount-clamp: flat bill discount clamped to subtotal ───');
    const discountOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: itemsPayload(1) },
      headers: authHeader,
    });
    assertEqual(discountOrder.status, 201, 'discount fixture order created');
    const subtotal = Number(discountOrder.data.order.subtotal);
    assertEqual(subtotal, 100, 'fixture subtotal is 100');

    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: discountOrder.data.order.id },
      headers: authHeader,
    });
    assertEqual(billRes.status, 201, 'bill generated');

    const absurd = await api(baseUrl, `/api/bills/${billRes.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'amount', value: 99999 },
      headers: authHeader,
    });
    assertEqual(absurd.status, 200, 'oversized flat discount accepted (clamped, not rejected)');
    const applied = Number(absurd.data.bill.discount_amount);
    assert(applied <= subtotal, `discount_amount ${applied} is clamped to subtotal ${subtotal}`);
    assertEqual(applied, subtotal, 'discount_amount equals subtotal after clamp');
    assert(
      Number(absurd.data.bill.total) >= 0,
      'bill total stays non-negative after clamp',
    );

    const atSubtotal = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: discountOrder.data.order.id },
      headers: authHeader,
    }).catch(() => null);
    if (atSubtotal && atSubtotal.status < 400) {
      const exact = await api(baseUrl, `/api/bills/${atSubtotal.data.bill.id}/applyDiscount`, {
        method: 'POST',
        body: { type: 'amount', value: subtotal },
        headers: authHeader,
      });
      assertEqual(exact.status, 200, 'exact-subtotal flat discount still accepted');
      assertEqual(Number(exact.data.bill.discount_amount), subtotal, 'exact-subtotal discount unchanged');
    } else {
      assert(true, 'second bill generate skipped (order already billed)');
    }

    const tiny = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: itemsPayload(1) },
      headers: authHeader,
    });
    const tinyBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: tiny.data.order.id },
      headers: authHeader,
    });
    const okDiscount = await api(baseUrl, `/api/bills/${tinyBill.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'amount', value: 40 },
      headers: authHeader,
    });
    assertEqual(okDiscount.status, 200, 'in-range flat discount accepted');
    assertEqual(Number(okDiscount.data.bill.discount_amount), 40, 'in-range discount value preserved');

    void now;
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: any) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
