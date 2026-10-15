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
  const insertViewOrder = db.prepare(`
    INSERT INTO orders (order_number, customer_id, table_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 100, 100, ?, ?)
  `);
  const createViewOrder = (
    orderNumber: string,
    status: string,
    createdAt: string,
    type = 'takeaway',
    tableId: string | null = null,
    customerId: string | null = null,
  ) => Number(insertViewOrder.run(
    orderNumber,
    customerId,
    tableId,
    type,
    status,
    createdAt,
    createdAt,
  ).lastInsertRowid);

  for (let i = 0; i < 20; i++) {
    createViewOrder(`ORD-ACTIVE-OLDER-${i}`, 'pending', '2019-01-01 00:00:00');
  }
  createViewOrder(
    'ORD-SEARCH-MATCH-OLD',
    'preparing',
    '2018-01-01 00:00:00',
    'dine_in',
    'orders-search-table',
    'orders-search-customer',
  );

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status)
    VALUES (?, 'orders-search-product', ?, 10, 1, 10, 10, ?)
  `);
  for (const [number, itemStatus] of [
    ['ORD-COMPLETED-KITCHEN-PENDING', 'pending'],
    ['ORD-COMPLETED-KITCHEN-PREPARING', 'preparing'],
    ['ORD-COMPLETED-KITCHEN-READY', 'ready'],
    ['ORD-COMPLETED-KITCHEN-SERVED', 'served'],
    ['ORD-COMPLETED-KITCHEN-VOIDED', 'voided'],
    ['ORD-COMPLETED-KITCHEN-REFUNDED', 'refunded'],
  ] as const) {
    const orderId = createViewOrder(number, 'completed', '2022-01-01 00:00:00');
    insertItem.run(orderId, number, itemStatus);
  }

  const insertBill = db.prepare(`
    INSERT INTO bills (bill_number, order_id, total, paid_amount, balance, payment_status, split_group_id, split_label)
    VALUES (?, ?, 100, ?, ?, ?, ?, ?)
  `);
  const splitOrderId = createViewOrder('ORD-UNPAID-SPLIT', 'completed', '2017-01-01 00:00:00');
  insertBill.run('BILL-UNPAID-SPLIT-PAID', splitOrderId, 100, 0, 'paid', 'orders-search-split', 'Paid');
  insertBill.run('BILL-UNPAID-SPLIT-OPEN', splitOrderId, 0, 100, 'unpaid', 'orders-search-split', 'Open');
  const partialOrderId = createViewOrder('ORD-UNPAID-PARTIAL', 'completed', '2017-01-01 00:00:00');
  insertBill.run('BILL-UNPAID-PARTIAL', partialOrderId, 40, 60, 'partial', null, null);
  const settledOrderId = createViewOrder('ORD-UNPAID-SETTLED', 'completed', '2017-01-01 00:00:00');
  insertBill.run('BILL-UNPAID-SETTLED', settledOrderId, 100, 0, 'paid', null, null);
  const refundedOrderId = createViewOrder('ORD-UNPAID-REFUNDED', 'completed', '2017-01-01 00:00:00');
  insertBill.run('BILL-UNPAID-REFUNDED', refundedOrderId, 100, 0, 'refunded', null, null);
  const partiallyRefundedOrderId = createViewOrder('ORD-UNPAID-PARTIALLY-REFUNDED', 'completed', '2017-01-01 00:00:00');
  insertBill.run('BILL-UNPAID-PARTIALLY-REFUNDED', partiallyRefundedOrderId, 100, 0, 'partially_refunded', null, null);
  const zeroBalanceOrderId = createViewOrder('ORD-UNPAID-ZERO-BALANCE', 'completed', '2017-01-01 00:00:00');
  db.prepare(`INSERT INTO bills (bill_number, order_id, total, paid_amount, balance, payment_status)
    VALUES ('BILL-UNPAID-ZERO-BALANCE', ?, 0, 0, 0, 'unpaid')`).run(zeroBalanceOrderId);
  const cancelledOrderId = createViewOrder('ORD-UNPAID-CANCELLED', 'cancelled', '2017-01-01 00:00:00');
  insertBill.run('BILL-UNPAID-CANCELLED', cancelledOrderId, 0, 100, 'unpaid', null, null);

  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const unfiltered = await api(baseUrl, '/api/orders?per_page=50', { headers: owner.authHeader });
    assertEqualOrThrow(unfiltered.status, 200, 'the newest page of orders is available');
    assertOrThrow(!unfiltered.data.orders.some((order: any) => order.order_number === 'ORD-SEARCH-OLDER'), 'the target order is outside the newest 50');
    const invalidView = await api(baseUrl, '/api/orders?view=held', { headers: owner.authHeader });
    assertEqualOrThrow(invalidView.status, 400, 'unsupported order views are rejected');

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

    const activePage1 = await api(
      baseUrl,
      '/api/orders?view=active&type=takeaway&status=pending&per_page=15',
      { headers: owner.authHeader },
    );
    assertEqualOrThrow(activePage1.data.orders.length, 15, 'active view paginates matching older orders in groups of 15');
    assertOrThrow(activePage1.data.orders.every((order: any) => order.status === 'pending'), 'active page status filtering happens before pagination');
    assertOrThrow(typeof activePage1.data.nextCursor === 'number', 'the first active page exposes its numeric cursor');
    const activePage2 = await api(
      baseUrl,
      `/api/orders?view=active&type=takeaway&status=pending&per_page=15&before_id=${activePage1.data.nextCursor}`,
      { headers: owner.authHeader },
    );
    assertEqualOrThrow(activePage2.data.orders.length, 5, 'the next active page contains the remaining five matches');
    assertEqualOrThrow(
      new Set([...activePage1.data.orders, ...activePage2.data.orders].map((order: any) => order.id)).size,
      20,
      'the active cursor pages contain each older matching order exactly once',
    );

    const filteredSearch = await api(
      baseUrl,
      `/api/orders?type=dine_in&table_id=orders-search-table&status=preparing&search=${encodeURIComponent('ORD-SEARCH-MATCH-OLD')}&per_page=15`,
      { headers: owner.authHeader },
    );
    assertEqualOrThrow(filteredSearch.data.orders.length, 1, 'table, type, status and search filters match an older order before pagination');
    assertEqualOrThrow(filteredSearch.data.orders[0].order_number, 'ORD-SEARCH-MATCH-OLD', 'the combined filters return the older matching order');

    const activeCompleted = await api(
      baseUrl,
      '/api/orders?view=active&status=completed&per_page=50',
      { headers: owner.authHeader },
    );
    const activeCompletedNumbers = activeCompleted.data.orders.map((order: any) => order.order_number);
    for (const itemStatus of ['PENDING', 'PREPARING', 'READY']) {
      assertOrThrow(
        activeCompletedNumbers.includes(`ORD-COMPLETED-KITCHEN-${itemStatus}`),
        `completed orders with ${itemStatus.toLowerCase()} kitchen work stay active when KDS is enabled`,
      );
    }
    for (const itemStatus of ['SERVED', 'VOIDED', 'REFUNDED']) {
      assertOrThrow(
        !activeCompletedNumbers.includes(`ORD-COMPLETED-KITCHEN-${itemStatus}`),
        `completed orders with ${itemStatus.toLowerCase()} items are not active kitchen work`,
      );
    }
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'kds_enabled'").run();
    const activeWithoutKds = await api(
      baseUrl,
      '/api/orders?view=active&status=completed&per_page=50',
      { headers: owner.authHeader },
    );
    assertOrThrow(
      !activeWithoutKds.data.orders.some((order: any) => order.order_number.startsWith('ORD-COMPLETED-KITCHEN-')),
      'completed kitchen work is not active when KDS is disabled',
    );
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'kds_enabled'").run();

    const unpaid = await api(baseUrl, '/api/orders?view=unpaid&per_page=500', {
      headers: owner.authHeader,
    });
    const unpaidNumbers = unpaid.data.orders.map((order: any) => order.order_number);
    for (const number of ['ORD-UNPAID-SPLIT', 'ORD-UNPAID-PARTIAL']) {
      assertOrThrow(unpaidNumbers.includes(number), `${number} remains visible as payable`);
    }
    for (const number of [
      'ORD-UNPAID-SETTLED',
      'ORD-UNPAID-REFUNDED',
      'ORD-UNPAID-PARTIALLY-REFUNDED',
      'ORD-UNPAID-ZERO-BALANCE',
      'ORD-UNPAID-CANCELLED',
    ]) {
      assertOrThrow(!unpaidNumbers.includes(number), `${number} is excluded from unpaid orders`);
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
