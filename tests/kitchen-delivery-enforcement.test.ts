const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kitchen-delivery-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assertEqualOrThrow, assertOrThrow, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes, resetPinRateLimitForTests } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'kitchen-delivery-category', 'Kitchen Delivery Test');
  seedProduct(db, 'kitchen-delivery-pending', 'kitchen-delivery-category', 'Taco', 500);
  seedProduct(db, 'kitchen-delivery-preparing', 'kitchen-delivery-category', 'Soup', 700);
  seedProduct(db, 'kitchen-delivery-ready', 'kitchen-delivery-category', 'Tea', 300);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/settings': settingsRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const setSetting = (key: string, value: string) => {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now());
  };
  const createBill = async (suffix: string, productId = 'kitchen-delivery-pending') => {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: productId, quantity: 1 }] },
      headers: owner.authHeader,
    });
    assertEqualOrThrow(created.status, 201, `order ${suffix} created`);
    const generated = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: created.data.order.id }, headers: owner.authHeader,
    });
    assertEqualOrThrow(generated.status, 201, `bill ${suffix} created`);
    return { orderId: created.data.order.id, bill: generated.data.bill };
  };
  const createBillWithKitchenStatuses = async (suffix: string) => {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'kitchen-delivery-pending', quantity: 1 },
          { product_id: 'kitchen-delivery-preparing', quantity: 1 },
          { product_id: 'kitchen-delivery-ready', quantity: 1 },
        ],
      },
      headers: owner.authHeader,
    });
    assertEqualOrThrow(created.status, 201, `order ${suffix} created`);
    db.prepare("UPDATE order_items SET status = 'preparing' WHERE order_id = ? AND product_id = 'kitchen-delivery-preparing'").run(created.data.order.id);
    db.prepare("UPDATE order_items SET status = 'ready' WHERE order_id = ? AND product_id = 'kitchen-delivery-ready'").run(created.data.order.id);
    const generated = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: created.data.order.id }, headers: owner.authHeader,
    });
    assertEqualOrThrow(generated.status, 201, `bill ${suffix} created`);
    return { orderId: created.data.order.id, bill: generated.data.bill };
  };
  const paySingle = (bill: any, body: Record<string, unknown> = {}) => api(baseUrl, `/api/bills/${bill.id}/payment`, {
    method: 'POST', body: { method: 'card', amount: bill.total, ...body }, headers: owner.authHeader,
  });
  const createSplitBills = async (suffix: string, items: any[], allocations: { itemIndex: number; quantity: number }[][]) => {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', items }, headers: owner.authHeader,
    });
    assertEqualOrThrow(created.status, 201, `split order ${suffix} created`);
    const generated = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: created.data.order.id }, headers: owner.authHeader,
    });
    assertEqualOrThrow(generated.status, 201, `split bill ${suffix} created`);
    const checks = allocations.map((entries, index) => ({
      label: `Check ${index + 1}`,
      items: entries.map((entry) => ({
        order_item_id: created.data.order.items[entry.itemIndex].id,
        quantity: entry.quantity,
      })),
    }));
    const split = await api(baseUrl, `/api/bills/${generated.data.bill.id}/split-check`, {
      method: 'POST', body: { checks }, headers: owner.authHeader,
    });
    assertEqualOrThrow(split.status, 201, `split checks ${suffix} created`);
    return { orderId: created.data.order.id, items: created.data.order.items, bills: split.data.bills };
  };

  try {
    assertEqualOrThrow(
      db.prepare("SELECT value FROM settings WHERE key = 'require_kitchen_delivered_before_settlement'").get()?.value,
      'false',
      'setting defaults to disabled',
    );

    const defaultBill = await createBill('default');
    const defaultPaid = await paySingle(defaultBill.bill);
    assertEqualOrThrow(defaultPaid.status, 200, 'payment proceeds when enforcement is disabled by default');

    const savedSetting = await api(baseUrl, '/api/settings/require_kitchen_delivered_before_settlement', {
      method: 'PUT', body: { value: 'true' }, headers: owner.authHeader,
    });
    assertEqualOrThrow(savedSetting.status, 200, 'settings route accepts the enforcement setting');
    setSetting('kds_enabled', 'false');
    const printerOnlyBill = await createBill('printer-only');
    const printerOnlyPaid = await paySingle(printerOnlyBill.bill);
    assertEqualOrThrow(printerOnlyPaid.status, 200, 'printer-only kitchens bypass enforcement');

    setSetting('kds_enabled', 'true');
    const singleBill = await createBill('single-block');
    const singleRejected = await paySingle(singleBill.bill);
    assertEqualOrThrow(singleRejected.status, 409, 'single-payment endpoint rejects undelivered items');
    assertEqualOrThrow(singleRejected.data.code, 'KITCHEN_ITEMS_UNDELIVERED', 'single-payment error has a stable code');
    assertEqualOrThrow(singleRejected.data.undeliveredItems[0], 'Taco', 'single-payment error includes item names');
    assertEqualOrThrow(db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(singleBill.bill.id).paid_amount, 0, 'rejected payment leaves the bill unpaid');

    const batchBill = await createBillWithKitchenStatuses('batch-block');
    const batchRejected = await api(baseUrl, `/api/bills/${batchBill.bill.id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'card', amount: batchBill.bill.total }] },
      headers: owner.authHeader,
    });
    assertEqualOrThrow(batchRejected.status, 409, 'split-payment endpoint rejects undelivered items');
    assertEqualOrThrow(batchRejected.data.undeliveredCount, 3, 'split-payment error reports all pending, preparing, and ready items');
    assertEqualOrThrow(batchRejected.data.undeliveredItems.slice().sort().join(','), 'Soup,Taco,Tea', 'split-payment error includes the undelivered item names');

    resetPinRateLimitForTests();
    const overrideBill = await createBill('override', 'kitchen-delivery-ready');
    for (let attempt = 1; attempt <= 4; attempt++) {
      const invalidPin = await api(baseUrl, `/api/bills/${overrideBill.bill.id}/payments`, {
        method: 'POST',
        body: { payments: [{ method: 'card', amount: overrideBill.bill.total }], override_pin: '9999' },
        headers: owner.authHeader,
      });
      assertEqualOrThrow(invalidPin.status, 403, `invalid manager PIN attempt ${attempt} is rejected`);
    }
    const overridePaid = await api(baseUrl, `/api/bills/${overrideBill.bill.id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'card', amount: overrideBill.bill.total }], override_pin: '1234' },
      headers: owner.authHeader,
    });
    assertEqualOrThrow(overridePaid.status, 200, 'valid manager PIN authorizes settlement and clears failed attempts');
    const overrideAudit = db.prepare("SELECT actor_user_id, details_json FROM order_audit_log WHERE order_id = ? AND action = 'kitchen_delivery_override'").get(overrideBill.orderId);
    assertOrThrow(Boolean(overrideAudit), 'manager override is recorded in the order audit log');
    assertEqualOrThrow(overrideAudit.actor_user_id, owner.userId, 'audit actor is the authenticated request user');
    assertEqualOrThrow(JSON.parse(overrideAudit.details_json).manager_user_id, manager.userId, 'audit details identify the authorizing manager');
    assertOrThrow(!JSON.stringify(overridePaid.data.bill.payment_details).includes('1234'), 'manager PIN is not stored with payment details');
    for (let attempt = 2; attempt <= 6; attempt++) {
      const nextOverrideBill = await createBill(`override-success-${attempt}`, 'kitchen-delivery-ready');
      const nextOverridePaid = await api(baseUrl, `/api/bills/${nextOverrideBill.bill.id}/payments`, {
        method: 'POST',
        body: { payments: [{ method: 'card', amount: nextOverrideBill.bill.total }], override_pin: '1234' },
        headers: owner.authHeader,
      });
      assertEqualOrThrow(nextOverridePaid.status, 200, `valid manager PIN attempt ${attempt} authorizes independent settlement`);
    }

    resetPinRateLimitForTests();
    const rateLimitedBill = await createBill('override-rate-limit', 'kitchen-delivery-ready');
    for (let attempt = 1; attempt <= 5; attempt++) {
      const invalidPin = await api(baseUrl, `/api/bills/${rateLimitedBill.bill.id}/payments`, {
        method: 'POST',
        body: { payments: [{ method: 'card', amount: rateLimitedBill.bill.total }], override_pin: '9999' },
        headers: owner.authHeader,
      });
      assertEqualOrThrow(invalidPin.status, 403, `invalid manager PIN attempt ${attempt} remains within the failure limit`);
    }
    const blockedPin = await api(baseUrl, `/api/bills/${rateLimitedBill.bill.id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'card', amount: rateLimitedBill.bill.total }], override_pin: '1234' },
      headers: owner.authHeader,
    });
    assertEqualOrThrow(blockedPin.status, 429, 'five failed manager PIN attempts block further attempts');
    resetPinRateLimitForTests();

    setSetting('split_checks_enabled', 'true');
    const independentChecks = await createSplitBills('independent-delivery', [
      { product_id: 'kitchen-delivery-pending', quantity: 1 },
      { product_id: 'kitchen-delivery-preparing', quantity: 1 },
    ], [
      [{ itemIndex: 0, quantity: 1 }],
      [{ itemIndex: 1, quantity: 1 }],
    ]);
    db.prepare("UPDATE order_items SET status = 'served' WHERE id = ?").run(independentChecks.items[0].id);
    const servedCheckPaid = await paySingle(independentChecks.bills[0]);
    assertEqualOrThrow(servedCheckPaid.status, 200, 'served split check settles while its sibling item is pending');
    const pendingCheckRejected = await paySingle(independentChecks.bills[1]);
    assertEqualOrThrow(pendingCheckRejected.status, 409, 'pending split check remains blocked while its item is undelivered');

    const sharedItemChecks = await createSplitBills('shared-item-quantity', [
      { product_id: 'kitchen-delivery-pending', quantity: 2 },
    ], [
      [{ itemIndex: 0, quantity: 1 }],
      [{ itemIndex: 0, quantity: 1 }],
    ]);
    const sharedFirstRejected = await paySingle(sharedItemChecks.bills[0]);
    const sharedSecondRejected = await paySingle(sharedItemChecks.bills[1]);
    assertEqualOrThrow(sharedFirstRejected.status, 409, 'a shared pending order item blocks the first check');
    assertEqualOrThrow(sharedSecondRejected.status, 409, 'a shared pending order item blocks the second check');

    const zeroQuantityMapping = await createSplitBills('zero-quantity-mapping', [
      { product_id: 'kitchen-delivery-pending', quantity: 1 },
      { product_id: 'kitchen-delivery-preparing', quantity: 1 },
    ], [
      [{ itemIndex: 0, quantity: 1 }],
      [{ itemIndex: 1, quantity: 1 }],
    ]);
    db.exec('PRAGMA ignore_check_constraints = ON');
    try {
      db.prepare('UPDATE bill_items SET quantity = 0 WHERE bill_id = ?').run(zeroQuantityMapping.bills[0].id);
    } finally {
      db.exec('PRAGMA ignore_check_constraints = OFF');
    }
    const zeroQuantityPaid = await paySingle(zeroQuantityMapping.bills[0]);
    assertEqualOrThrow(zeroQuantityPaid.status, 200, 'an allocation with zero quantity does not block its check');
    const positiveSiblingRejected = await paySingle(zeroQuantityMapping.bills[1]);
    assertEqualOrThrow(positiveSiblingRejected.status, 409, 'positive sibling allocation still enforces delivery');

    const deliveredBill = await createBill('delivered');
    db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(deliveredBill.orderId);
    const deliveredPaid = await paySingle(deliveredBill.bill);
    assertEqualOrThrow(deliveredPaid.status, 200, 'settlement proceeds when kitchen items are served');

    const prepaidBill = await createBill('prepaid');
    setSetting('billing_type', 'prepaid');
    const prepaidPaid = await paySingle(prepaidBill.bill);
    assertEqualOrThrow(prepaidPaid.status, 200, 'prepaid orders bypass enforcement');

    console.log('\nKitchen delivery enforcement checks passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
