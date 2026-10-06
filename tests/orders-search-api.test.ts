const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-orders-search-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-orders-search';

const { orderRoutes } = require('../main/routes/orders');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCustomer, api,
  assertEqualOrThrow, assertOrThrow, closeDatabase, getResults,
} = require('./helpers/test-setup');

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCustomer(db, 'orders-search-customer', 'Élodie Search Customer', '+1/555 ext 0199');

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, customer_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'completed', 100, 100, ?, ?)
  `);
  insertOrder.run('ORD-SEARCH-OLDER', 'orders-search-customer', '2020-01-01 00:00:00', '2020-01-01 00:00:00');
  for (let i = 0; i < 55; i++) {
    insertOrder.run(`ORD-SEARCH-NEWER-${i}`, 'orders-search-customer', '2021-01-01 00:00:00', '2021-01-01 00:00:00');
  }

  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const unfiltered = await api(baseUrl, '/api/orders?per_page=50', { headers: owner.authHeader });
    assertEqualOrThrow(unfiltered.status, 200, 'the newest page of orders is available');
    assertOrThrow(!unfiltered.data.orders.some((order: any) => order.order_number === 'ORD-SEARCH-OLDER'), 'the target order is outside the newest 50');

    const byOrderNumber = await api(baseUrl, `/api/orders?per_page=50&search=${encodeURIComponent('ORD-SEARCH-OLDER')}`, { headers: owner.authHeader });
    assertEqualOrThrow(byOrderNumber.status, 200, 'search by order number succeeds');
    assertOrThrow(byOrderNumber.data.orders.some((order: any) => order.order_number === 'ORD-SEARCH-OLDER'), 'search by order number returns the older matching order');

    for (const search of ['élo', '5550199']) {
      const response = await api(baseUrl, `/api/orders?per_page=50&search=${encodeURIComponent(search)}`, { headers: owner.authHeader });
      assertEqualOrThrow(response.status, 200, `search for ${search} succeeds`);
      assertEqualOrThrow(response.data.orders.length, 50, `search for ${search} returns the first full page`);
      assertOrThrow(typeof response.data.nextCursor === 'number', `search for ${search} exposes the next page`);

      const nextPage = await api(baseUrl, `/api/orders?per_page=50&search=${encodeURIComponent(search)}&before_id=${response.data.nextCursor}`, { headers: owner.authHeader });
      assertEqualOrThrow(nextPage.status, 200, `the next page for ${search} succeeds`);
      assertOrThrow(nextPage.data.orders.some((order: any) => order.order_number === 'ORD-SEARCH-OLDER'), `the next page for ${search} returns the older matching order`);
    }
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) process.exit(1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
