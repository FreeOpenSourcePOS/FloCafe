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

const { initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct, installAndActivateTestTaxPack, api, assert, assertEqual, getResults, closeDatabase, now } = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes, allocateSignedMinorUnits, allocateTaxSnapshots } = require('../main/routes/bills');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { settingsRoutes } = require('../main/routes/settings');
const { reportRoutes } = require('../main/routes/reports');
const { resolveTaxComponents: resolveBackendTaxComponents } = require('../main/services/tax-components');
const { resolveTaxComponents: resolveFrontendTaxComponents } = require('../frontend/src/lib/printer/tax-components');
const { MIGRATIONS } = require('../main/db');
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');

async function main() {
  const db = initTestDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)").run(now());
  assertEqual(JSON.stringify(allocateSignedMinorUnits(-2, [1, 3])), JSON.stringify([-1, -1]), 'negative round-off uses signed largest-remainder allocation');
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'split-cat', 'Split menu');
  seedProduct(db, 'split-coffee', 'split-cat', 'Coffee', 100);
  seedProduct(db, 'split-toast', 'split-cat', 'Toast', 90);
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/payment-methods': paymentMethodRoutes, '/api/settings': settingsRoutes, '/api/reports': reportRoutes });
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

    const paidSiblingOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }] }, headers: authHeader });
    const paidSiblingItem = paidSiblingOrderRes.data.order.items[0];
    const paidSiblingBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: paidSiblingOrderRes.data.order.id }, headers: authHeader });
    const paidSiblingSplit = await api(baseUrl, `/api/bills/${paidSiblingBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Paid sibling', items: [{ order_item_id: paidSiblingItem.id, quantity: 1 }] },
      { label: 'Unpaid sibling', items: [{ order_item_id: paidSiblingItem.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(paidSiblingSplit.status, 201, 'paid-sibling mutation fixture splits successfully');
    const paidSiblingPayment = await api(baseUrl, `/api/bills/${paidSiblingSplit.data.bills[0].id}/payments`, { method: 'POST', body: { payments: [{ method: 'cash', amount: 10 }] }, headers: authHeader });
    assertEqual(paidSiblingPayment.status, 200, 'partially-paid sibling mutation fixture accepts a payment');
    assertEqual((db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(paidSiblingSplit.data.bills[0].id) as any).payment_status, 'partial', 'partially-paid sibling remains marked partial');
    const paidSiblingCancel = await api(baseUrl, `/api/orders/${paidSiblingOrderRes.data.order.id}/items/${paidSiblingItem.id}/cancel`, { method: 'PATCH', headers: authHeader });
    assertEqual(paidSiblingCancel.status, 409, 'cancelling an item with a partially-paid split sibling is rejected');
    assertEqual((db.prepare('SELECT status FROM order_items WHERE id = ?').get(paidSiblingItem.id) as any).status, 'pending', 'rejected partial-paid cancellation leaves the item active');
    assertEqual((db.prepare('SELECT COUNT(*) AS n FROM bills WHERE order_id = ? AND payment_status = \'unpaid\'').get(paidSiblingOrderRes.data.order.id) as any).n, 1, 'rejected partial-paid cancellation leaves the unpaid child intact');

    const addTarget = await api(baseUrl, '/api/payment-methods', { method: 'POST', body: { name: 'GPay' }, headers: authHeader });
    const merged = await api(baseUrl, `/api/payment-methods/${googlePayId}/merge`, { method: 'POST', body: { target_type: 'custom', target_id: addTarget.data.payment_method.id }, headers: authHeader });
    assertEqual(merged.status, 200, 'used custom method merged');
    const rewritten = JSON.parse((db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(split.data.bills[1].id) as any).payment_details);
    assertEqual(rewritten[0].method, 'GPay', 'historical payment name replaced');
    assertEqual((db.prepare('SELECT COUNT(*) AS n FROM payment_method_merges').get() as any).n, 1, 'one compact local merge record retained');

    // ── Issue #253 Regression Tests ──────────────────────────────────────────
    // A. Two-Cent / Four-Check Underflow
    seedProduct(db, 'split-tiny', 'split-cat', 'Tiny Product', 0.02);
    const underflowOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 4, items: [{ product_id: 'split-tiny', quantity: 4 }] }, headers: authHeader });
    const underflowItem = underflowOrderRes.data.order.items[0];
    const underflowBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: underflowOrderRes.data.order.id }, headers: authHeader });
    db.prepare('UPDATE bills SET subtotal = 0.02, total = 0.02, balance = 0.02 WHERE id = ?').run(underflowBillRes.data.bill.id);
    const underflowSplit = await api(baseUrl, `/api/bills/${underflowBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: underflowItem.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: underflowItem.id, quantity: 1 }] },
      { label: 'Guest 3', items: [{ order_item_id: underflowItem.id, quantity: 1 }] },
      { label: 'Guest 4', items: [{ order_item_id: underflowItem.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(underflowSplit.status, 201, 'underflow $0.02 split across 4 checks returns 201');
    assert(underflowSplit.data.bills.every((b: any) => b.total >= 0 && b.balance >= 0), 'no resulting total or balance is negative');
    const underflowSum = Number(underflowSplit.data.bills.reduce((sum: number, b: any) => sum + b.total, 0).toFixed(2));
    assertEqual(underflowSum, 0.02, 'allocated totals sum exactly to source total $0.02');

    // B. One-Cent Split
    seedProduct(db, 'split-1cent', 'split-cat', '1 Cent Product', 0.01);
    const oneCentOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-1cent', quantity: 2 }] }, headers: authHeader });
    const oneCentItem = oneCentOrderRes.data.order.items[0];
    const oneCentBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: oneCentOrderRes.data.order.id }, headers: authHeader });
    db.prepare('UPDATE bills SET subtotal = 0.01, total = 0.01, balance = 0.01 WHERE id = ?').run(oneCentBillRes.data.bill.id);
    const oneCentSplit = await api(baseUrl, `/api/bills/${oneCentBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: oneCentItem.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: oneCentItem.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(oneCentSplit.status, 201, 'one-cent split across 2 checks returns 201');
    assert(oneCentSplit.data.bills.every((b: any) => b.total >= 0), 'one-cent split has no negative totals');
    const oneCentSum = Number(oneCentSplit.data.bills.reduce((sum: number, b: any) => sum + b.total, 0).toFixed(2));
    assertEqual(oneCentSum, 0.01, 'one-cent split totals sum exactly to $0.01');

    // C. Unequal Weight Allocation
    seedProduct(db, 'split-unequal-a', 'split-cat', 'Product A', 6.00);
    seedProduct(db, 'split-unequal-b', 'split-cat', 'Product B', 4.00);
    const unevenOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-unequal-a', quantity: 1 }, { product_id: 'split-unequal-b', quantity: 1 }] }, headers: authHeader });
    const itemA = unevenOrderRes.data.order.items.find((i: any) => i.product_id === 'split-unequal-a');
    const itemB = unevenOrderRes.data.order.items.find((i: any) => i.product_id === 'split-unequal-b');
    const unevenBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: unevenOrderRes.data.order.id }, headers: authHeader });
    db.prepare('UPDATE bills SET subtotal = 10.01, total = 10.01, balance = 10.01 WHERE id = ?').run(unevenBillRes.data.bill.id);
    const unevenSplit = await api(baseUrl, `/api/bills/${unevenBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1 (Product A)', items: [{ order_item_id: itemA.id, quantity: 1 }] },
      { label: 'Guest 2 (Product B)', items: [{ order_item_id: itemB.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(unevenSplit.status, 201, 'unequal weight split returns 201');
    assertEqual(JSON.stringify(unevenSplit.data.bills.map((b: any) => b.total)), JSON.stringify([6.01, 4.00]), 'largest remainder distributes $10.01 into 6.01 and 4.00 according to 60/40 item weights');
    const unevenSum = Number(unevenSplit.data.bills.reduce((sum: number, b: any) => sum + b.total, 0).toFixed(2));
    assertEqual(unevenSum, 10.01, 'unequal split totals reconcile exactly to $10.01');

    // D. Void Adjustment Exclusion
    const { registerRoutes } = require('../main/routes/index');
    registerRoutes(app);
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', datetime('now'))").run();
    const mgrUser = seedManagerUser(db);
    const voidOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }, { product_id: 'split-toast', quantity: 1 }] }, headers: authHeader });
    const voidOrder = voidOrderRes.data.order;
    const voidItemToCancel = voidOrder.items.find((i: any) => i.product_id === 'split-toast');
    const activeItemToKeep = voidOrder.items.find((i: any) => i.product_id === 'split-coffee');
    const prepRes = await api(baseUrl, `/api/order-items/${voidItemToCancel.id}/status`, { method: 'PATCH', body: { status: 'preparing' }, headers: authHeader });
    assertEqual(prepRes.status, 200, 'item moved to preparing via order-items API');
    const cancelRes = await api(baseUrl, `/api/orders/${voidOrder.id}/items/${voidItemToCancel.id}/cancel`, { method: 'PATCH', body: { override_pin: '1234' }, headers: mgrUser.authHeader });
    assertEqual(cancelRes.status, 200, 'in-progress item voided with manager PIN');
    const voidAdjRow = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(voidOrder.id) as any;
    assert(voidAdjRow !== undefined, 'void_adjustment row created in order_items');
    const voidBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: voidOrder.id }, headers: authHeader });
    const voidSplit = await api(baseUrl, `/api/bills/${voidBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: activeItemToKeep.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: activeItemToKeep.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(voidSplit.status, 201, 'split check succeeds allocating only physical active items without allocating void_adjustment');
    const billItemRows = db.prepare('SELECT * FROM bill_items WHERE bill_id IN (?, ?)').all(voidSplit.data.bills[0].id, voidSplit.data.bills[1].id) as any[];
    assert(!billItemRows.some((bi: any) => bi.order_item_id === voidAdjRow.id), 'bill_items rows do not reference void_adjustment item ID');

    // E. Repeat Safety
    const repeatOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }] }, headers: authHeader });
    const repeatItem = repeatOrderRes.data.order.items[0];
    const repeatBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: repeatOrderRes.data.order.id }, headers: authHeader });
    const repeatSplitPayload = { checks: [
      { label: 'Guest 1', items: [{ order_item_id: repeatItem.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: repeatItem.id, quantity: 1 }] },
    ] };
    const firstRepeatSplit = await api(baseUrl, `/api/bills/${repeatBillRes.data.bill.id}/split-check`, { method: 'POST', body: repeatSplitPayload, headers: authHeader });
    assertEqual(firstRepeatSplit.status, 201, 'first split request returns 201');
    const secondRepeatSplit = await api(baseUrl, `/api/bills/${repeatBillRes.data.bill.id}/split-check`, { method: 'POST', body: repeatSplitPayload, headers: authHeader });
    assertEqual(secondRepeatSplit.status, 409, 'repeated split request returns 409 Conflict');
    const childSplit = await api(baseUrl, `/api/bills/${firstRepeatSplit.data.bills[1].id}/split-check`, { method: 'POST', body: repeatSplitPayload, headers: authHeader });
    assertEqual(childSplit.status, 409, 'splitting child bill returns 409 Conflict');
    const totalSplitGroups = db.prepare("SELECT COUNT(DISTINCT split_group_id) AS n FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL").get(repeatOrderRes.data.order.id) as any;
    assertEqual(totalSplitGroups.n, 1, 'only one split group exists in database for order');

    // F. Concurrent HTTP Request Regression
    const concOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }] }, headers: authHeader });
    const concItem = concOrderRes.data.order.items[0];
    const concBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: concOrderRes.data.order.id }, headers: authHeader });
    const concPayload1 = { checks: [
      { label: 'Group A Guest 1', items: [{ order_item_id: concItem.id, quantity: 1 }] },
      { label: 'Group A Guest 2', items: [{ order_item_id: concItem.id, quantity: 1 }] },
    ] };
    const concPayload2 = { checks: [
      { label: 'Group B Guest 1', items: [{ order_item_id: concItem.id, quantity: 1 }] },
      { label: 'Group B Guest 2', items: [{ order_item_id: concItem.id, quantity: 1 }] },
    ] };
    const [concRes1, concRes2] = await Promise.all([
      api(baseUrl, `/api/bills/${concBillRes.data.bill.id}/split-check`, { method: 'POST', body: concPayload1, headers: authHeader }),
      api(baseUrl, `/api/bills/${concBillRes.data.bill.id}/split-check`, { method: 'POST', body: concPayload2, headers: authHeader }),
    ]);
    const concStatuses = [concRes1.status, concRes2.status].sort();
    assertEqual(concStatuses[0], 201, 'concurrent HTTP request: exactly one request returns 201');
    assertEqual(concStatuses[1], 409, 'concurrent HTTP request: duplicate request returns 409');
    const concSplitGroups = db.prepare("SELECT COUNT(DISTINCT split_group_id) AS n FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL").get(concOrderRes.data.order.id) as any;
    assertEqual(concSplitGroups.n, 1, 'concurrent HTTP request: exactly one split group exists in database');

    // G. Nested Tax Breakdown Allocation & Reconciliation
    const taxOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }] }, headers: authHeader });
    const taxItem = taxOrderRes.data.order.items[0];
    const taxBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: taxOrderRes.data.order.id }, headers: authHeader });
    const nestedBreakdown = [
      [
        { title: 'Tax A', rate: 2.5, amount: 0.01 },
        { title: 'Tax B', rate: 2.5, amount: 0.01 },
      ],
    ];
    db.prepare('UPDATE bills SET subtotal = 1.00, tax_amount = 0.02, tax_breakdown = ?, total = 1.02, balance = 1.02 WHERE id = ?')
      .run(JSON.stringify(nestedBreakdown), taxBillRes.data.bill.id);

    const taxSplit = await api(baseUrl, `/api/bills/${taxBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: taxItem.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: taxItem.id, quantity: 1 }] },
    ] }, headers: authHeader });

    assertEqual(taxSplit.status, 201, 'nested tax breakdown split returns 201');
    assertEqual(taxSplit.data.bills.length, 2, 'returns 2 split bills');

    let totalTaxA = 0;
    let totalTaxB = 0;
    let totalTaxAmount = 0;

    for (const b of taxSplit.data.bills) {
      const dbRow = db.prepare('SELECT tax_breakdown FROM bills WHERE id = ?').get(b.id) as any;
      const dbBreakdown = JSON.parse(dbRow.tax_breakdown);
      assert(Array.isArray(dbBreakdown), 'persisted DB tax_breakdown is an array');
      assert(Array.isArray(dbBreakdown[0]), 'persisted DB tax_breakdown outer array preserved as nested array');

      assert(Array.isArray(b.tax_breakdown), 'API response tax_breakdown is an array');
      const innerComps = b.tax_breakdown;
      const compSum = Number(innerComps.reduce((s: number, c: any) => s + Number(c.amount || 0), 0).toFixed(2));
      assertEqual(compSum, b.tax_amount, 'sum of check component amounts equals bill tax_amount exactly');
      totalTaxAmount = Number((totalTaxAmount + b.tax_amount).toFixed(2));

      for (const comp of innerComps) {
        if (comp.title === 'Tax A') totalTaxA = Number((totalTaxA + comp.amount).toFixed(2));
        if (comp.title === 'Tax B') totalTaxB = Number((totalTaxB + comp.amount).toFixed(2));
      }
    }

    assertEqual(totalTaxAmount, 0.02, 'sum of split tax_amounts equals source tax_amount 0.02');
    assertEqual(totalTaxA, 0.01, 'Tax A reconciles across checks to 0.01');
    assertEqual(totalTaxB, 0.01, 'Tax B reconciles across checks to 0.01');

    // H. Legacy Flat Tax Breakdown Allocation
    const flatOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }] }, headers: authHeader });
    const flatItem = flatOrderRes.data.order.items[0];
    const flatBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: flatOrderRes.data.order.id }, headers: authHeader });
    const flatBreakdown = [
      { title: 'State Tax', rate: 5.0, amount: 0.50 },
      { title: 'Local Tax', rate: 2.0, amount: 0.20 },
    ];
    db.prepare('UPDATE bills SET subtotal = 10.00, tax_amount = 0.70, tax_breakdown = ?, total = 10.70, balance = 10.70 WHERE id = ?')
      .run(JSON.stringify(flatBreakdown), flatBillRes.data.bill.id);

    const flatSplit = await api(baseUrl, `/api/bills/${flatBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: flatItem.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: flatItem.id, quantity: 1 }] },
    ] }, headers: authHeader });

    assertEqual(flatSplit.status, 201, 'flat tax breakdown split returns 201');
    for (const b of flatSplit.data.bills) {
      assert(Array.isArray(b.tax_breakdown), 'flat tax_breakdown is an array');
      assert(!Array.isArray(b.tax_breakdown[0]), 'flat tax_breakdown elements are objects, not nested arrays');
      const compSum = Number(b.tax_breakdown.reduce((s: number, c: any) => s + Number(c.amount || 0), 0).toFixed(2));
      assertEqual(compSum, b.tax_amount, 'sum of flat component amounts equals bill tax_amount exactly');
    }

    const partialLegacyOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'split-coffee', quantity: 2 }] }, headers: authHeader });
    const partialLegacyItem = partialLegacyOrderRes.data.order.items[0];
    const partialLegacyBreakdown = JSON.stringify([[{ title: 'Legacy Tax A', rate: 2, amount: 0.01 }, { title: 'Legacy Tax B', rate: 2, amount: 0.01 }]]);
    const partialLegacyTotal = Number((partialLegacyOrderRes.data.order.subtotal + 0.02).toFixed(2));
    db.prepare('UPDATE order_items SET tax_amount = ?, tax_breakdown = ?, tax_snapshot = NULL, total = ? WHERE id = ?')
      .run(0.02, partialLegacyBreakdown, partialLegacyTotal, partialLegacyItem.id);
    db.prepare('UPDATE orders SET tax_amount = ?, tax_breakdown = ?, tax_snapshot = NULL, total = ? WHERE id = ?')
      .run(0.02, partialLegacyBreakdown, partialLegacyTotal, partialLegacyOrderRes.data.order.id);
    const partialLegacyBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: partialLegacyOrderRes.data.order.id }, headers: authHeader });
    const partialLegacySnapshot = JSON.stringify({ lines: [{ components: [{ label: 'Categorized Tax', rate: '5', amount: '0.00' }] }] });
    db.prepare('UPDATE bills SET tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?, balance = ? WHERE id = ?')
      .run(0.02, partialLegacyBreakdown, partialLegacySnapshot, partialLegacyTotal, partialLegacyTotal, partialLegacyBillRes.data.bill.id);
    const partialLegacySplit = await api(baseUrl, `/api/bills/${partialLegacyBillRes.data.bill.id}/split-check`, { method: 'POST', body: { checks: [
      { label: 'Partial legacy one', items: [{ order_item_id: partialLegacyItem.id, quantity: 1 }] },
      { label: 'Partial legacy two', items: [{ order_item_id: partialLegacyItem.id, quantity: 1 }] },
    ] }, headers: authHeader });
    assertEqual(partialLegacySplit.status, 201, 'partial-quantity legacy tax split returns 201');
    let partialLegacyTax = 0;
    for (const childBill of partialLegacySplit.data.bills) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const childItem = child.order.items[0];
      assertEqual(childItem.quantity, 1, 'partial-quantity child exposes only its billed quantity');
      assertEqual(Number(childItem.tax_breakdown[0].reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), 0.01, 'partial-quantity child scales nested legacy tax evidence to its tax target');
      const backendComponents = resolveBackendTaxComponents({ ...child, items: child.order.items });
      const frontendComponents = resolveFrontendTaxComponents(child);
      assertEqual(JSON.stringify(backendComponents), JSON.stringify(frontendComponents), 'backend and frontend split resolvers agree for partial legacy tax');
      assertEqual(Number(backendComponents.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'partial legacy tax components reconcile to each child tax amount');
      partialLegacyTax = Number((partialLegacyTax + child.tax_amount).toFixed(2));
    }
    assertEqual(partialLegacyTax, 0.02, 'partial-quantity legacy tax reconciles across children');

    // I. Split Tax Snapshot Attribution (categorized item + configured charge)
    const splitTaxPack = {
      ...dualRatePackData,
      id: 'test-split-tax-pack',
      country: 'IN',
      currency: 'INR',
      categories: dualRatePackData.categories.map((category: any) => ({
        ...category,
        ruleIds: category.id === 'standard'
          ? ['item-tax']
          : category.id === 'packaging'
            ? ['charge-tax']
            : [],
      })),
      rules: [
        { ...dualRatePackData.rules[0], id: 'item-tax', label: 'Item Tax', categoryIds: ['standard'], rate: '5' },
        { ...dualRatePackData.rules[1], id: 'charge-tax', label: 'Charge Tax', categoryIds: ['packaging'], rate: '5' },
      ],
    };
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?), ('business_type', 'restaurant', ?), ('state_code', '27', ?)")
      .run(now(), now(), now());
    installAndActivateTestTaxPack(db, splitTaxPack);
    seedCategory(db, 'split-tax-cat', 'Split tax menu');
    seedProduct(db, 'split-tax-item-a', 'split-tax-cat', 'Tax Item A', 20, { tax_category_id: 'standard', tax_behavior: 'exclusive' });
    seedProduct(db, 'split-tax-item-b', 'split-tax-cat', 'Tax Item B', 20, { tax_category_id: 'standard', tax_behavior: 'exclusive' });
    db.prepare(`
      INSERT OR REPLACE INTO tax_overrides (
        id, pack_version_id, entity_type, entity_id, field_name, value_json,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, 'packaging', NULL, 'tax_category_id', ?, NULL, ?, ?)
    `).run(
      'split-packaging-tax-override',
      `${splitTaxPack.id}@${splitTaxPack.version}`,
      JSON.stringify({ categoryId: 'packaging' }),
      now(),
      now(),
    );

    const snapshotOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        packaging_charge: 20,
        items: [
          { product_id: 'split-tax-item-a', quantity: 1 },
          { product_id: 'split-tax-item-b', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(snapshotOrderRes.status, 201, 'categorized items plus configured packaging charge order is created');
    assertEqual(snapshotOrderRes.data.order.tax_amount, 3, 'source tax includes two item taxes and one packaging tax');
    const snapshotBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: snapshotOrderRes.data.order.id },
      headers: authHeader,
    });
    const snapshotItems = snapshotOrderRes.data.order.items;
    const snapshotSplit = await api(baseUrl, `/api/bills/${snapshotBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Snapshot Guest 1', items: [{ order_item_id: snapshotItems[0].id, quantity: 1 }] },
        { label: 'Snapshot Guest 2', items: [{ order_item_id: snapshotItems[1].id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqual(snapshotSplit.status, 201, 'snapshot-tax split returns 201');

    const splitDiscountSnapshot = db.prepare('SELECT tax_snapshot FROM bills WHERE id = ?').get(snapshotSplit.data.bills[0].id) as any;
    const splitDiscountRes = await api(baseUrl, `/api/bills/${snapshotSplit.data.bills[0].id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 10 },
      headers: authHeader,
    });
    assertEqual(splitDiscountRes.status, 409, 'discounting a split child is rejected before overwriting its tax snapshot');
    const preservedDiscountBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(snapshotSplit.data.bills[0].id) as any;
    assertEqual(preservedDiscountBill.tax_snapshot, splitDiscountSnapshot.tax_snapshot, 'rejected split-child discount preserves the marked tax snapshot');
    const preservedDiscountComponents = resolveBackendTaxComponents({
      ...preservedDiscountBill,
      tax_breakdown: JSON.parse(preservedDiscountBill.tax_breakdown),
      tax_snapshot: preservedDiscountBill.tax_snapshot,
      items: snapshotItems,
    });
    assertEqual(JSON.stringify(preservedDiscountComponents.map((component: any) => component.title)), JSON.stringify(['Item Tax', 'Charge Tax']), 'rejected split-child discount preserves tax attribution');
    assertEqual(Number(preservedDiscountComponents.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), preservedDiscountBill.tax_amount, 'preserved split-child discount snapshot still reconciles to tax_amount');

    const expectedSnapshotComponents = [
      { title: 'Item Tax', rate: 5, amount: 1 },
      { title: 'Charge Tax', rate: 5, amount: 0.5 },
    ];
    const aggregateSnapshotComponents = new Map<string, number>();
    for (const splitBill of snapshotSplit.data.bills) {
      const childRes = await api(baseUrl, `/api/bills/${splitBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const backendComponents = resolveBackendTaxComponents({
        ...child,
        items: child.order.items,
      });
      const frontendComponents = resolveFrontendTaxComponents(child);
      assertEqual(JSON.stringify(backendComponents), JSON.stringify(expectedSnapshotComponents), 'backend thermal receipt tax components keep item and charge attribution per child');
      assertEqual(JSON.stringify(frontendComponents), JSON.stringify(expectedSnapshotComponents), 'frontend receipt tax components keep item and charge attribution per child');
      assertEqual(Number(backendComponents.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'resolved child tax components reconcile to child tax_amount');
      assertEqual(
        Number((child.subtotal - child.discount_amount + child.tax_amount + child.delivery_charge + child.packaging_charge + child.round_off).toFixed(2)),
        child.total,
        'split child total composes from allocated exclusive tax and bill fields',
      );
      for (const component of backendComponents) {
        aggregateSnapshotComponents.set(component.title, (aggregateSnapshotComponents.get(component.title) || 0) + component.amount);
      }
    }
    assertEqual(aggregateSnapshotComponents.get('Item Tax'), 2, 'item tax components reconcile across split children');
    assertEqual(aggregateSnapshotComponents.get('Charge Tax'), 1, 'configured charge tax components reconcile across split children');
    assertEqual(
      Number(Array.from(aggregateSnapshotComponents.values()).reduce((sum, amount) => sum + amount, 0).toFixed(2)),
      snapshotOrderRes.data.order.tax_amount,
      'aggregate resolved snapshot tax equals source order tax exactly',
    );

    const mixedLegacyDocument = {
      tax_amount: 1.5,
      tax_snapshot: JSON.stringify([{ splitAllocation: 'minor-unit-v1', lines: [{ components: [{ label: 'Item Tax', rate: '5', amount: '1.00' }] }] }]),
      tax_breakdown: JSON.stringify([[{ title: 'Legacy Tax', rate: 2, amount: 0.5 }]]),
      items: [
        { tax_snapshot: JSON.stringify({ splitAllocation: 'minor-unit-v1', lines: [{ components: [{ label: 'Item Tax', rate: '5', amount: '1.00' }] }]}), tax_breakdown: null, status: 'pending' },
        { tax_snapshot: null, tax_breakdown: JSON.stringify([{ title: 'Legacy Tax', rate: 2, amount: 0.5 }]), status: 'pending' },
      ],
    };
    const mixedLegacyExpected = [
      { title: 'Item Tax', rate: 5, amount: 1 },
      { title: 'Legacy Tax', rate: 2, amount: 0.5 },
    ];
    assertEqual(JSON.stringify(resolveBackendTaxComponents(mixedLegacyDocument)), JSON.stringify(mixedLegacyExpected), 'backend split resolver preserves legacy item tax beside marked snapshots');
    assertEqual(JSON.stringify(resolveFrontendTaxComponents(mixedLegacyDocument)), JSON.stringify(mixedLegacyExpected), 'frontend split resolver preserves legacy item tax beside marked snapshots');

    seedProduct(db, 'split-mixed-legacy-item', 'split-tax-cat', 'Mixed Legacy Item', 20);
    const mixedOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: 'split-tax-item-a', quantity: 1 },
          { product_id: 'split-mixed-legacy-item', quantity: 2 },
        ],
      },
      headers: authHeader,
    });
    const mixedCategorizedItem = mixedOrderRes.data.order.items.find((item: any) => item.product_id === 'split-tax-item-a');
    const mixedLegacyItem = mixedOrderRes.data.order.items.find((item: any) => item.product_id === 'split-mixed-legacy-item');
    const mixedLegacyBreakdown = [{ title: 'Legacy Item Tax', rate: 2, amount: 0.50 }];
    const mixedBreakdown = JSON.stringify([mixedCategorizedItem.tax_breakdown, mixedLegacyBreakdown]);
    const mixedTotal = Number((mixedOrderRes.data.order.subtotal + 1.50).toFixed(2));
    db.prepare('UPDATE order_items SET tax_amount = ?, tax_breakdown = ?, tax_snapshot = NULL, total = ? WHERE id = ?')
      .run(0.50, JSON.stringify(mixedLegacyBreakdown), 40.50, mixedLegacyItem.id);
    db.prepare('UPDATE orders SET tax_amount = ?, tax_breakdown = ?, total = ? WHERE id = ?')
      .run(1.50, mixedBreakdown, mixedTotal, mixedOrderRes.data.order.id);
    const mixedBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: mixedOrderRes.data.order.id }, headers: authHeader });
    const mixedDiscountRes = await api(baseUrl, `/api/bills/${mixedBillRes.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 20 },
      headers: authHeader,
    });
    assertEqual(mixedDiscountRes.status, 200, 'discounting an unsplit mixed-tax bill succeeds');
    assertEqual(mixedDiscountRes.data.bill.tax_amount, 1.2, 'discount scales mixed snapshot and legacy tax together');
    const reportDate = new Date().toISOString().slice(0, 10);
    const mixedReportBefore = await api(baseUrl, `/api/reports/tax-components?start_date=${reportDate}&end_date=${reportDate}`, { headers: authHeader });
    const mixedSplit = await api(baseUrl, `/api/bills/${mixedBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Mixed owner one', items: [{ order_item_id: mixedCategorizedItem.id, quantity: 1 }, { order_item_id: mixedLegacyItem.id, quantity: 1 }] },
        { label: 'Mixed owner two', items: [{ order_item_id: mixedLegacyItem.id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqual(mixedSplit.status, 201, 'mixed snapshot and legacy tax split returns 201');
    const mixedAggregate = new Map<string, number>();
    for (const childBill of mixedSplit.data.bills) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const childItemIds = new Set(child.order.items.map((item: any) => Number(item.id)));
      const expectedMixedComponents = childItemIds.has(Number(mixedCategorizedItem.id))
        ? [{ title: 'Item Tax', rate: 5, amount: 0.8 }, { title: 'Legacy Item Tax', rate: 2, amount: 0.2 }]
        : [{ title: 'Legacy Item Tax', rate: 2, amount: 0.2 }];
      const persistedBreakdown = (child.tax_breakdown || []).map((component: any) => ({
        title: component.title,
        rate: component.rate,
        amount: Number(Number(component.amount || 0).toFixed(2)),
      }));
      assertEqual(JSON.stringify(persistedBreakdown), JSON.stringify(expectedMixedComponents), 'persisted child breakdown preserves mixed item and legacy ownership');
      const backendComponents = resolveBackendTaxComponents({ ...child, items: child.order.items });
      const frontendComponents = resolveFrontendTaxComponents(child);
      assertEqual(JSON.stringify(backendComponents), JSON.stringify(expectedMixedComponents), 'mixed split backend resolver preserves item and legacy ownership');
      assertEqual(JSON.stringify(frontendComponents), JSON.stringify(expectedMixedComponents), 'mixed split frontend resolver preserves item and legacy ownership');
      assertEqual(Number(backendComponents.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'mixed split tax components reconcile to each child tax amount');
      for (const component of backendComponents) mixedAggregate.set(component.title, Number(((mixedAggregate.get(component.title) || 0) + component.amount).toFixed(2)));
    }
    assertEqual(mixedAggregate.get('Item Tax'), 0.8, 'mixed split item tax remains with its categorized owner after discount');
    assertEqual(mixedAggregate.get('Legacy Item Tax'), 0.4, 'mixed split legacy tax remains scaled across item quantities');
    assertEqual(Number(Array.from(mixedAggregate.values()).reduce((sum, amount) => sum + amount, 0).toFixed(2)), 1.2, 'mixed split tax categories reconcile to the discounted source tax');
    const mixedReportAfter = await api(baseUrl, `/api/reports/tax-components?start_date=${reportDate}&end_date=${reportDate}`, { headers: authHeader });
    const reportAmount = (response: any, title: string) => Number((response.data.taxComponents.components.find((component: any) => component.title === title)?.amount || 0).toFixed(2));
    assertEqual(reportAmount(mixedReportAfter, 'Legacy Item Tax'), reportAmount(mixedReportBefore, 'Legacy Item Tax'), 'tax component report keeps mixed legacy tax additive after splitting');

    seedProduct(db, 'split-rounding-legacy-item', 'split-tax-cat', 'Rounding Legacy Item', 40);
    const roundingOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: 'split-mixed-legacy-item', quantity: 1 },
          { product_id: 'split-rounding-legacy-item', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    const roundingItems = roundingOrderRes.data.order.items;
    const roundingBreakdown = [{ title: 'Rounded Legacy Tax', rate: 2, amount: 0.01 }];
    for (const item of roundingItems) {
      db.prepare('UPDATE order_items SET tax_amount = 0.01, tax_breakdown = ?, tax_snapshot = NULL, total = subtotal + 0.01 WHERE id = ?')
        .run(JSON.stringify(roundingBreakdown), item.id);
    }
    const roundingTotal = Number((roundingOrderRes.data.order.subtotal + 0.02).toFixed(2));
    db.prepare('UPDATE orders SET tax_amount = 0.02, tax_breakdown = ?, tax_snapshot = NULL, total = ? WHERE id = ?')
      .run(JSON.stringify([roundingBreakdown, roundingBreakdown]), roundingTotal, roundingOrderRes.data.order.id);
    const roundingBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: roundingOrderRes.data.order.id }, headers: authHeader });
    const maxDiscount = db.prepare("SELECT value FROM settings WHERE key = 'discount_max_percentage'").get() as any;
    db.prepare("UPDATE settings SET value = '100' WHERE key = 'discount_max_percentage'").run();
    const roundingDiscountRes = await api(baseUrl, `/api/bills/${roundingBillRes.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 66.67 },
      headers: authHeader,
    });
    if (maxDiscount) db.prepare("UPDATE settings SET value = ? WHERE key = 'discount_max_percentage'").run(maxDiscount.value);
    assertEqual(roundingDiscountRes.status, 200, 'discounted sub-cent legacy tax remains split-compatible');
    assertEqual(roundingDiscountRes.data.bill.tax_amount, 0.01, 'discounted sub-cent legacy tax keeps the aggregate source cent');
    const roundingSplit = await api(baseUrl, `/api/bills/${roundingBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Rounding owner one', items: [{ order_item_id: roundingItems[0].id, quantity: 1 }] },
        { label: 'Rounding owner two', items: [{ order_item_id: roundingItems[1].id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqual(roundingSplit.status, 201, 'discounted sub-cent legacy split returns 201');
    for (const childBill of roundingSplit.data.bills) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const ownsFirstItem = child.order.items.some((item: any) => Number(item.id) === Number(roundingItems[0].id));
      const expectedRounding = ownsFirstItem ? [{ title: 'Rounded Legacy Tax', rate: 2, amount: 0.01 }] : [];
      const components = resolveBackendTaxComponents({ ...child, items: child.order.items });
      assertEqual(JSON.stringify(components), JSON.stringify(expectedRounding), 'discounted sub-cent legacy tax stays with its owning child');
      assertEqual(Number(components.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'discounted sub-cent legacy components reconcile exactly');
    }

    const voidLegacyOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: 'split-mixed-legacy-item', quantity: 1 },
          { product_id: 'split-rounding-legacy-item', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    const voidLegacyItems = voidLegacyOrderRes.data.order.items;
    const voidLegacyBreakdown = [{ title: 'Void Legacy Tax', rate: 2, amount: 0.01 }];
    for (const item of voidLegacyItems) {
      db.prepare('UPDATE order_items SET tax_amount = 0.01, tax_breakdown = ?, tax_snapshot = NULL, total = subtotal + 0.01 WHERE id = ?')
        .run(JSON.stringify(voidLegacyBreakdown), item.id);
    }
    const voidLegacyTotal = Number((voidLegacyOrderRes.data.order.subtotal + 0.02).toFixed(2));
    db.prepare('UPDATE orders SET tax_amount = 0.02, tax_breakdown = ?, tax_snapshot = NULL, total = ? WHERE id = ?')
      .run(JSON.stringify([voidLegacyBreakdown, voidLegacyBreakdown]), voidLegacyTotal, voidLegacyOrderRes.data.order.id);
    const voidLegacyBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: voidLegacyOrderRes.data.order.id }, headers: authHeader });
    const voidLegacySplit = await api(baseUrl, `/api/bills/${voidLegacyBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Void legacy owner one', items: [{ order_item_id: voidLegacyItems[0].id, quantity: 1 }] },
        { label: 'Void legacy owner two', items: [{ order_item_id: voidLegacyItems[1].id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqual(voidLegacySplit.status, 201, 'legacy tax split for void ownership returns 201');
    const voidLegacyPrepare = await api(baseUrl, `/api/order-items/${voidLegacyItems[0].id}/status`, {
      method: 'PATCH',
      body: { status: 'preparing' },
      headers: authHeader,
    });
    assertEqual(voidLegacyPrepare.status, 200, 'legacy tax item can enter preparing before void');
    const voidLegacyCancel = await api(baseUrl, `/api/orders/${voidLegacyOrderRes.data.order.id}/items/${voidLegacyItems[0].id}/cancel`, {
      method: 'PATCH',
      body: { override_pin: '1234' },
      headers: mgrUser.authHeader,
    });
    assertEqual(voidLegacyCancel.status, 200, 'voiding legacy tax item remains supported after splitting');
    for (const childBill of db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY id').all(voidLegacyOrderRes.data.order.id) as any[]) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const ownsSurviving = child.order.items.some((item: any) => Number(item.id) === Number(voidLegacyItems[1].id));
      const expectedVoidLegacy = ownsSurviving ? [{ title: 'Void Legacy Tax', rate: 2, amount: 0.01 }] : [];
      const components = resolveBackendTaxComponents({ ...child, items: child.order.items });
      assertEqual(JSON.stringify(components), JSON.stringify(expectedVoidLegacy), 'void adjustment legacy tax stays with its original owner');
      assertEqual(Number(components.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'void adjustment legacy components reconcile exactly');
    }

    const voidSnapshotOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        packaging_charge: 20,
        items: [
          { product_id: 'split-tax-item-a', quantity: 1 },
          { product_id: 'split-tax-item-b', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    const voidSnapshotItems = voidSnapshotOrderRes.data.order.items;
    const voidSnapshotBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: voidSnapshotOrderRes.data.order.id },
      headers: authHeader,
    });
    const voidSnapshotSplit = await api(baseUrl, `/api/bills/${voidSnapshotBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Void Snapshot Guest 1', items: [{ order_item_id: voidSnapshotItems[0].id, quantity: 1 }] },
        { label: 'Void Snapshot Guest 2', items: [{ order_item_id: voidSnapshotItems[1].id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqual(voidSnapshotSplit.status, 201, 'snapshot-tax split for void regression returns 201');
    const voidTargetItem = voidSnapshotItems.find((item: any) => item.product_id === 'split-tax-item-a');
    const voidSurvivingItem = voidSnapshotItems.find((item: any) => item.product_id === 'split-tax-item-b');
    const voidPrepareRes = await api(baseUrl, `/api/order-items/${voidTargetItem.id}/status`, {
      method: 'PATCH',
      body: { status: 'preparing' },
      headers: authHeader,
    });
    assertEqual(voidPrepareRes.status, 200, 'snapshot item moves to preparing before the void regression');
    const voidSnapshotCancelRes = await api(baseUrl, `/api/orders/${voidSnapshotOrderRes.data.order.id}/items/${voidTargetItem.id}/cancel`, {
      method: 'PATCH',
      body: { override_pin: '1234' },
      headers: mgrUser.authHeader,
    });
    assertEqual(voidSnapshotCancelRes.status, 200, 'voiding a split snapshot item keeps the mutation supported');
    const voidSnapshotBills = db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY id').all(voidSnapshotOrderRes.data.order.id) as any[];
    let voidResolvedTax = 0;
    for (const childBill of voidSnapshotBills) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const components = resolveBackendTaxComponents({ ...child, items: child.order.items });
      const billItems = db.prepare('SELECT order_item_id FROM bill_items WHERE bill_id = ?').all(child.id) as any[];
      const ownsSurvivingItem = billItems.some((item: any) => Number(item.order_item_id) === Number(voidSurvivingItem.id));
      const expectedAmounts = ownsSurvivingItem ? [1, 1] : [0, 0];
      assertEqual(JSON.stringify(components.map((component: any) => component.title)), JSON.stringify(['Item Tax', 'Charge Tax']), 'voided split child keeps item and charge tax categories');
      assertEqual(JSON.stringify(components.map((component: any) => component.amount)), JSON.stringify(expectedAmounts), 'void evidence is not allocated to the sibling child');
      assertEqual(Number(components.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'voided split child tax components reconcile exactly');
      assert(child.tax_snapshot && JSON.parse(child.tax_snapshot).some((snapshot: any) => snapshot && snapshot.splitAllocation === 'minor-unit-v1'), 'void sync preserves marked child tax snapshots');
      voidResolvedTax = Number((voidResolvedTax + child.tax_amount).toFixed(2));
    }
    assertEqual(voidResolvedTax, voidSnapshotCancelRes.data.order.tax_amount, 'voided split child tax totals reconcile to the updated order');

    const unevenComponentSnapshot = JSON.stringify({
      lines: [{
        taxAmount: '0.02',
        components: [
          { label: 'Component A', rate: '5', amount: '0.01' },
          { label: 'Component B', rate: '5', amount: '0.01' },
        ],
      }],
    });
    const unevenComponentChildren = allocateTaxSnapshots(unevenComponentSnapshot, [1, 2]);
    const unevenComponentAmounts = unevenComponentChildren.map((raw: string | null) => {
      const snapshot = JSON.parse(raw as string);
      return snapshot.lines[0].components.map((component: any) => Number(component.amount));
    });
    assertEqual(JSON.stringify(unevenComponentAmounts.map((components: number[]) => Number(components.reduce((sum, amount) => sum + amount, 0).toFixed(2)))), JSON.stringify([0, 0.02]), 'uneven split snapshot components reconcile within their owner');
    assertEqual(JSON.stringify(unevenComponentAmounts.reduce((totals: number[], components: number[]) => components.map((amount, index) => Number((totals[index] + amount).toFixed(2))), [0, 0])), JSON.stringify([0.01, 0.01]), 'uneven split snapshot components remain additive across children');

    const ownedSnapshots = JSON.stringify([
      { lines: [{ grossAmount: '0.03', taxableBase: '0.03', taxAmount: '0.01', components: [{ label: 'Item A Tax', rate: '5', amount: '0.01' }] }] },
      { lines: [{ grossAmount: '0.04', taxableBase: '0.04', taxAmount: '0.01', components: [{ label: 'Item B Tax', rate: '5', amount: '0.01' }] }] },
    ]);
    const ownedChildren = allocateTaxSnapshots(ownedSnapshots, [1, 2], [[1, 0], [0, 1]]);
    const ownedValues = ownedChildren.map((raw: string | null) => {
      const snapshots = JSON.parse(raw as string);
      return snapshots.map((snapshot: any) => ({
        grossAmount: Number(snapshot.lines[0].grossAmount),
        taxAmount: Number(snapshot.lines[0].taxAmount),
        componentAmount: Number(snapshot.lines[0].components[0].amount),
      }));
    });
    assertEqual(JSON.stringify(ownedValues), JSON.stringify([
      [{ grossAmount: 0.03, taxAmount: 0.01, componentAmount: 0.01 }, { grossAmount: 0, taxAmount: 0, componentAmount: 0 }],
      [{ grossAmount: 0, taxAmount: 0, componentAmount: 0 }, { grossAmount: 0.04, taxAmount: 0.01, componentAmount: 0.01 }],
    ]), 'snapshot allocations preserve item ownership for tax and line bases');

    const cancelledSnapshotItem = snapshotItems[0];
    const cancelSnapshotRes = await api(baseUrl, `/api/orders/${snapshotOrderRes.data.order.id}/items/${cancelledSnapshotItem.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
    });
    assertEqual(cancelSnapshotRes.status, 200, 'cancelling an item after splitting keeps the order mutation supported');
    const cancelledSnapshotBills = db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY id').all(snapshotOrderRes.data.order.id) as any[];
    const cancelledSnapshotTotals = new Map<string, number>();
    for (const childBill of cancelledSnapshotBills) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const backendComponents = resolveBackendTaxComponents({ ...child, items: child.order.items });
      const frontendComponents = resolveFrontendTaxComponents(child);
      const childBillItems = db.prepare('SELECT order_item_id FROM bill_items WHERE bill_id = ?').all(childBill.id) as any[];
      const ownsSurvivingSnapshotItem = childBillItems.some((item: any) => Number(item.order_item_id) === Number(snapshotItems[1].id));
      const expectedCancelledComponents = ownsSurvivingSnapshotItem
        ? [{ title: 'Item Tax', rate: 5, amount: 1 }, { title: 'Charge Tax', rate: 5, amount: 1 }]
        : [{ title: 'Item Tax', rate: 5, amount: 0 }, { title: 'Charge Tax', rate: 5, amount: 0 }];
      assertEqual(JSON.stringify(backendComponents), JSON.stringify(expectedCancelledComponents), 'cancel sync preserves exact item and charge tax attribution');
      assertEqual(JSON.stringify(frontendComponents), JSON.stringify(expectedCancelledComponents), 'cancel sync preserves exact frontend item and charge tax attribution');
      assert(child.tax_snapshot && JSON.parse(child.tax_snapshot).some((snapshot: any) => snapshot.splitAllocation === 'minor-unit-v1'), 'cancel sync preserves marked child tax snapshots');
      assertEqual(JSON.stringify(backendComponents), JSON.stringify(frontendComponents), 'cancel sync keeps backend and frontend tax attribution aligned');
      assertEqual(Number(backendComponents.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'cancel sync resolved tax reconciles to each child tax amount');
      for (const component of backendComponents) {
        cancelledSnapshotTotals.set(component.title, Number(((cancelledSnapshotTotals.get(component.title) || 0) + component.amount).toFixed(2)));
      }
    }
    assertEqual(cancelledSnapshotTotals.get('Item Tax'), 1, 'cancel sync item tax reconciles across children');
    assertEqual(cancelledSnapshotTotals.get('Charge Tax'), 1, 'cancel sync charge tax reconciles across children');
    assertEqual(
      Number(Array.from(cancelledSnapshotTotals.values()).reduce((sum, amount) => sum + amount, 0).toFixed(2)),
      cancelSnapshotRes.data.order.tax_amount,
      'cancel sync aggregate tax attribution reconciles to the updated order',
    );

    const restoreSnapshotRes = await api(baseUrl, `/api/orders/${snapshotOrderRes.data.order.id}/items/${cancelledSnapshotItem.id}/restore`, {
      method: 'PATCH',
      headers: authHeader,
    });
    assertEqual(restoreSnapshotRes.status, 200, 'restoring an item after splitting keeps the order mutation supported');
    const restoredSnapshotBills = db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY id').all(snapshotOrderRes.data.order.id) as any[];
    for (const childBill of restoredSnapshotBills) {
      const childRes = await api(baseUrl, `/api/bills/${childBill.id}`, { headers: authHeader });
      const child = childRes.data.bill;
      const backendComponents = resolveBackendTaxComponents({ ...child, items: child.order.items });
      assertEqual(JSON.stringify(backendComponents), JSON.stringify(expectedSnapshotComponents), 'restore sync recomputes child item and charge tax attribution');
      assertEqual(Number(backendComponents.reduce((sum: number, component: any) => sum + component.amount, 0).toFixed(2)), child.tax_amount, 'restore sync resolved tax reconciles to each child tax amount');
    }

    const signedSnapshot = JSON.stringify({
      lines: [{
        grossAmount: '-0.03',
        taxableBase: '-0.03',
        taxAmount: '-0.03',
        components: [{ label: 'Signed Adjustment', rate: '5', amount: '-0.03' }],
      }],
    });
    const signedChildren = allocateTaxSnapshots(signedSnapshot, [1, 1]);
    const signedAmounts = signedChildren.map((raw: string | null) => Number(
      JSON.parse(raw as string).lines[0].components[0].amount,
    ));
    assertEqual(JSON.stringify(signedAmounts), JSON.stringify([-0.02, -0.01]), 'signed tax snapshot allocation keeps each child non-duplicated');
    assertEqual(Number(signedAmounts.reduce((sum: number, amount: number) => sum + amount, 0).toFixed(2)), -0.03, 'signed tax snapshot allocations reconcile exactly to the source');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  }
  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (results.failed) process.exit(1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
