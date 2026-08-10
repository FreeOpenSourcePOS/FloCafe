const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payment-methods-split-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, assert, assertEqual, getResults, closeDatabase, now } = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { settingsRoutes } = require('../main/routes/settings');

async function main() {
  const db = initTestDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)").run(now());
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'split-cat', 'Split menu');
  seedProduct(db, 'split-coffee', 'split-cat', 'Coffee', 100);
  seedProduct(db, 'split-toast', 'split-cat', 'Toast', 90);
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/payment-methods': paymentMethodRoutes, '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const freshMethods = await api(baseUrl, '/api/payment-methods', { headers: authHeader });
    assertEqual(freshMethods.data.payment_methods.length, 0, 'fresh install has no custom methods and no seeded UPI');
    const add = await api(baseUrl, '/api/payment-methods', { method: 'POST', body: { name: 'Google Pay' }, headers: authHeader });
    assertEqual(add.status, 201, 'custom payment method added');
    const googlePayId = add.data.payment_method.id;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', ?)").run(now());

    const orderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }, { product_id: 'split-toast', quantity: 1 }] }, headers: authHeader });
    assertEqual(orderRes.status, 201, 'two-pax order created');
    const order = orderRes.data.order;
    const coffee = order.items.find((item: any) => item.product_id === 'split-coffee');
    const toast = order.items.find((item: any) => item.product_id === 'split-toast');
    const billRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order.id }, headers: authHeader });
    const split = await api(baseUrl, `/api/bills/${billRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: coffee.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: coffee.id, quantity: 1 }, { order_item_id: toast.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(split.status, 201, 'check split by whole item quantity');
    assertEqual(split.data.bills.length, 2, 'two guest bills created');
    assertEqual(Number((split.data.bills[0].total + split.data.bills[1].total).toFixed(2)), billRes.data.bill.total, 'split totals preserve original bill total');

    const firstPay = await api(baseUrl, `/api/bills/${split.data.bills[0].id}/payments`, { method: 'POST', body: { payments: [{ method: 'cash', amount: split.data.bills[0].total }] }, headers: authHeader });
    assertEqual(firstPay.status, 200, 'first guest check paid');
    assert(db.prepare("SELECT status FROM orders WHERE id = ? AND status != 'completed'").get(order.id), 'order stays open while a sibling check is unpaid');
    const secondPay = await api(baseUrl, `/api/bills/${split.data.bills[1].id}/payments`, { method: 'POST', body: { payments: [{ method: 'custom', payment_method_id: googlePayId, amount: split.data.bills[1].total }] }, headers: authHeader });
    assertEqual(secondPay.status, 200, 'second guest check paid with custom method');
    assertEqual((db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id) as any).status, 'completed', 'order completes only after every check is paid');

    const addTarget = await api(baseUrl, '/api/payment-methods', { method: 'POST', body: { name: 'GPay' }, headers: authHeader });
    const merged = await api(baseUrl, `/api/payment-methods/${googlePayId}/merge`, { method: 'POST', body: { target_type: 'custom', target_id: addTarget.data.payment_method.id }, headers: authHeader });
    assertEqual(merged.status, 200, 'used custom method merged');
    const rewritten = JSON.parse((db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(split.data.bills[1].id) as any).payment_details);
    assertEqual(rewritten[0].method, 'GPay', 'historical payment name replaced');
    assertEqual((db.prepare('SELECT COUNT(*) AS n FROM payment_method_merges').get() as any).n, 1, 'one compact local merge record retained');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  }
  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (results.failed) process.exit(1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
