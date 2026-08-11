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
const { MIGRATIONS } = require('../main/db');

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
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'split_checks_enabled'").get() as any).value, 'false', 'fresh database seeds split checks disabled');
    db.prepare("DELETE FROM settings WHERE key = 'split_checks_enabled'").run();
    const missingSplitSetting = await api(baseUrl, '/api/settings/split_checks_enabled', { headers: authHeader });
    assertEqual(missingSplitSetting.status, 200, 'missing split-check setting reads as a safe default');
    assertEqual(missingSplitSetting.data.setting.value, 'false', 'fallback keeps split checks disabled');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'printer_trim_decimals'").get() as any).value, 'false', 'fresh database seeds printer decimal trimming disabled');
    db.prepare("DELETE FROM settings WHERE key = 'printer_trim_decimals'").run();
    const missingPrinterTrimSetting = await api(baseUrl, '/api/settings/printer_trim_decimals', { headers: authHeader });
    assertEqual(missingPrinterTrimSetting.status, 200, 'missing printer decimal-trim setting reads as a safe default');
    assertEqual(missingPrinterTrimSetting.data.setting.value, 'false', 'fallback keeps printer decimal trimming disabled');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'bill_template'").get() as any).value, 'classic', 'fresh database seeds the classic bill template');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'bill_footer_message'").get() as any).value, '', 'fresh database seeds an empty bill footer');
    db.prepare("UPDATE settings SET value = 'compact' WHERE key = 'bill_template'").run();
    db.prepare("UPDATE settings SET value = 'See you soon' WHERE key = 'bill_footer_message'").run();
    MIGRATIONS.find((migration: any) => migration.version === 66).up();
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'bill_template'").get() as any).value, 'compact', 'bill-template migration preserves an existing template choice');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'bill_footer_message'").get() as any).value, 'See you soon', 'bill-template migration preserves an existing footer');
    db.prepare("DELETE FROM settings WHERE key IN ('bill_template', 'bill_footer_message')").run();
    const missingBillTemplate = await api(baseUrl, '/api/settings/bill_template', { headers: authHeader });
    const missingBillFooter = await api(baseUrl, '/api/settings/bill_footer_message', { headers: authHeader });
    assertEqual(missingBillTemplate.status, 200, 'missing bill template reads as a safe default');
    assertEqual(missingBillTemplate.data.setting.value, 'classic', 'missing bill template falls back to classic');
    assertEqual(missingBillFooter.status, 200, 'missing bill footer reads as a safe default');
    assertEqual(missingBillFooter.data.setting.value, '', 'missing bill footer falls back to an empty message');
    const billContentDefaults = Object.fromEntries(
      db.prepare("SELECT key, value FROM settings WHERE key LIKE 'bill_show_%'").all()
        .map((row: any) => [row.key, row.value]),
    );
    assertEqual(billContentDefaults.bill_show_name, 'true', 'fresh database shows restaurant name by default');
    assertEqual(billContentDefaults.bill_show_tax_id, 'false', 'fresh database hides tax ID by default');
    assertEqual(billContentDefaults.bill_show_tax_breakdown, 'true', 'fresh database shows tax breakdown by default');
    assertEqual(billContentDefaults.bill_show_customer_name, 'true', 'fresh database shows customer name by default');
    assertEqual(billContentDefaults.bill_show_customer_phone, 'true', 'fresh database shows customer number by default');
    assertEqual(billContentDefaults.bill_show_table_number, 'true', 'fresh database shows table number by default');
    const saveTemplate = await api(baseUrl, '/api/settings/bill_template', { method: 'PUT', body: { value: 'detailed' }, headers: authHeader });
    const saveFooter = await api(baseUrl, '/api/settings/bill_footer_message', { method: 'PUT', body: { value: 'Please visit us again' }, headers: authHeader });
    assertEqual(saveTemplate.status, 200, 'bill template setting can be saved for backend invoice printing');
    assertEqual(saveFooter.status, 200, 'bill footer setting can be saved for backend invoice printing');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'bill_template'").get() as any).value, 'detailed', 'backend printer reads the persisted template choice');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'bill_footer_message'").get() as any).value, 'Please visit us again', 'backend printer reads the persisted footer message');
    const printerColumns = db.prepare('PRAGMA table_info(printers)').all().map((column: any) => column.name);
    assert(!printerColumns.includes('usb_device_path'), 'fresh printer schema does not keep ignored USB device path column');
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
