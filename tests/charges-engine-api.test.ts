/**
 * Unified charges & fees engine — API integration.
 *
 * These are the guardrails PR #829 got wrong, asserted end to end through the
 * real HTTP surface:
 *   - the wildcard `PUT /settings/:key` route must not accept custom_charges,
 *   - waiver state is persisted as an explicit boolean, not inferred from a 0,
 *   - re-selecting the same order type must not un-waive, and a recompute that
 *     changes the subtotal must preserve the recorded waiver,
 *   - a waiver is refused on a split check and on a mandatory charge,
 *   - a zero-decimal currency never persists a fractional subunit.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-charges-api-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  installAndActivateTestTaxPack,
  api, assertEqualOrThrow, assertOrThrow, getResults, closeDatabase, getDatabase,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { escPosToText, formatReceipt } = require('../main/printers/thermal');
const flatRateTaxPack = require('./fixtures/synthetic-flat-rate-pack.json');

const SERVICE_CHARGE = {
  id: 'service_charge',
  name: 'Service Charge',
  type: 'percentage',
  value: 10,
  calculation_basis: 'gross',
  order_types: ['dine_in'],
  is_optional: true,
  is_default_active: true,
  is_active: true,
};
const LATE_NIGHT = {
  id: 'late_night',
  name: 'Late Night',
  type: 'fixed',
  value: 7,
  calculation_basis: 'gross',
  order_types: ['dine_in'],
  is_optional: false,
  is_default_active: true,
  is_active: true,
};

function setCurrency(currency: string, country: string) {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  stmt.run('currency', currency);
  stmt.run('country', country);
}

function setSetting(key: string, value: string) {
  getDatabase().prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Installs a country-pack receipt template that declares the standard charge
 * rows, so the thermal compliance renderer is the one under test.
 */
function installThermalChargeTemplate(db: any, templateId: string): void {
  const payload = {
    format: 'escpos-line-template-v1',
    widthProfiles: [{ columns: 48, layout: {} }],
    header: { businessNameTransform: 'uppercase', titleWhenTaxAbsent: 'INVOICE', taxTitleWhenTaxPresent: 'TAX INVOICE' },
    totals: {
      showSubtotal: true,
      grandTotalLabel: 'GRAND TOTAL',
      chargeRows: ['serviceCharge', 'packagingCharge', 'deliveryCharge'],
    },
  };
  db.prepare(`INSERT INTO country_packs (id, publisher, country, jurisdiction, status) VALUES (?, 'test', 'US', 'US-FED', 'active')`).run('pack-charges');
  db.prepare(`
    INSERT INTO country_pack_versions (id, pack_id, version, schema_version, manifest_json, pack_json, effective_from, min_flo_version, published_at, status)
    VALUES (?, 'pack-charges', '1.0.0', 1, '{}', '{}', '2026-01-01', '3.0.0', '2026-01-01', 'installed')
  `).run('pack-charges-v1');
  db.prepare(`
    INSERT INTO installed_print_templates (template_id, pack_id, pack_version_id, country, jurisdiction, display_name, paper_widths_json, renderer_json, template_payload_json, status)
    VALUES (?, 'pack-charges', 'pack-charges-v1', 'US', 'US-FED', 'Charges receipt', '[48]', ?, ?, 'installed')
  `).run(
    templateId,
    JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
    JSON.stringify(payload),
  );
}

async function main() {
  const db = initTestDb();
  const { userId: ownerId, authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-charges', 'Menu');
  seedProduct(db, 'prod-charges', 'cat-charges', 'Dish', 100, { tax_behavior: 'exempt' });
  setCurrency('USD', 'US');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/settings': settingsRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const putCharges = (charges: unknown) => api(baseUrl, '/api/settings/charges', {
    method: 'PUT', body: { charges }, headers: authHeader,
  });
  const createOrder = (type: string) => api(baseUrl, '/api/orders', {
    method: 'POST', body: { type, items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
  });

  try {
    console.log('\n1. Dedicated endpoints validate; the wildcard route cannot write custom_charges');
    const ok = await putCharges([SERVICE_CHARGE, LATE_NIGHT]);
    assertEqualOrThrow(ok.status, 200, 'valid charge definitions are accepted');
    assertEqualOrThrow(ok.data.charges.length, 2, 'both charges are stored');

    const wildcard = await api(baseUrl, '/api/settings/custom_charges', {
      method: 'PUT', body: { value: '[]' }, headers: authHeader,
    });
    assertEqualOrThrow(wildcard.status, 403, 'the wildcard PUT route refuses custom_charges');
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'custom_charges'").get() as { value: string };
    assertEqualOrThrow(JSON.parse(stored.value).length, 2, 'the refused wildcard write left the setting intact');

    for (const [label, charge] of [
      ['an out-of-range percentage', { ...SERVICE_CHARGE, id: 'bad1', value: 101 }],
      ['a negative value', { ...SERVICE_CHARGE, id: 'bad2', value: -1 }],
      ['an unknown order type', { ...SERVICE_CHARGE, id: 'bad3', order_types: ['bar'] }],
      ['a non-slug id', { ...SERVICE_CHARGE, id: 'Bad Id' }],
      ['an unsupported type', { ...SERVICE_CHARGE, id: 'bad4', type: 'per_order' }],
      ['a fixed amount outside the supported currency precision', { ...LATE_NIGHT, id: 'bad5', value: Number.MAX_VALUE }],
    ] as const) {
      const res = await putCharges([charge]);
      assertEqualOrThrow(res.status, 400, `rejects ${label}`);
    }
    assertEqualOrThrow(
      JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'custom_charges'").get() as any).value).length,
      2,
      'no rejected write partially replaced the stored list',
    );

    const largestUsdAmount = Number.MAX_SAFE_INTEGER / 100;
    const overflowDefinitions = ['large_a', 'large_b'].map((id) => ({
      id,
      name: id,
      type: 'fixed',
      value: largestUsdAmount,
      calculation_basis: 'gross',
      order_types: ['dine_in'],
      is_optional: false,
      is_default_active: true,
      is_active: true,
    }));
    assertEqualOrThrow((await putCharges(overflowDefinitions)).status, 200, 'individually safe large fees are accepted');
    const beforeOverflowOrderCount = (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as any).count;
    const beforeOverflowItemCount = (db.prepare('SELECT COUNT(*) AS count FROM order_items').get() as any).count;
    const overflowOrder = await createOrder('dine_in');
    assertEqualOrThrow(overflowOrder.status, 400, 'combined unsafe charge totals return a client error');
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as any).count,
      beforeOverflowOrderCount,
      'a rejected total rolls back its order insert',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM order_items').get() as any).count,
      beforeOverflowItemCount,
      'a rejected total rolls back its item insert',
    );
    assertEqualOrThrow((await putCharges([SERVICE_CHARGE, LATE_NIGHT])).status, 200, 'valid charges are restored after overflow');

    console.log('\n2. Order create applies charges and maps the standard id onto its column');
    const order = await createOrder('dine_in');
    assertEqualOrThrow(order.status, 201, 'dine-in order created');
    const orderId = order.data.order.id;
    assertEqualOrThrow(order.data.order.subtotal, 100, 'subtotal is 100');
    assertEqualOrThrow(order.data.order.service_charge, 10, 'service_charge column holds the engine value');
    assertEqualOrThrow(order.data.order.total, 117, 'total = 100 + 10% service + 7 late night');
    const breakdown = JSON.parse(order.data.order.charges_breakdown);
    assertEqualOrThrow(breakdown.length, 2, 'charges_breakdown holds both charges');
    assertEqualOrThrow(breakdown[0].waived, false, 'an applied charge persists waived: false');
    assertEqualOrThrow(breakdown[0].amount, 10, 'the service charge records its computed amount');
    assertEqualOrThrow(breakdown[1].amount, 7, 'the late-night fee records its computed amount');

    console.log('\n3. Waiving a charge persists waived: true, not an inferred zero');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: orderId }, headers: authHeader,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    const billId = bill.data.bill.id;
    assertEqualOrThrow(
      JSON.parse(bill.data.bill.charges_breakdown).length, 2, 'the bill inherits the order breakdown',
    );

    const waived = await api(baseUrl, `/api/bills/${billId}/charges`, {
      method: 'PATCH', body: { charge_id: 'service_charge', waived: true }, headers: authHeader,
    });
    assertEqualOrThrow(waived.status, 200, 'optional charge waived (200)');
    const waivedCharges = JSON.parse(waived.data.bill.charges_breakdown);
    assertEqualOrThrow(waivedCharges.find((c: any) => c.id === 'service_charge').waived, true, 'waived: true is persisted');
    assertEqualOrThrow(waivedCharges.find((c: any) => c.id === 'service_charge').amount, 0, 'a waived charge records amount 0');
    assertEqualOrThrow(waived.data.bill.service_charge, 0, 'the service_charge column is cleared');
    assertEqualOrThrow(waived.data.bill.total, 107, 'the total drops the waived fee');

    const mandatory = await api(baseUrl, `/api/bills/${billId}/charges`, {
      method: 'PATCH', body: { charge_id: 'late_night', waived: true }, headers: authHeader,
    });
    assertEqualOrThrow(mandatory.status, 400, 'a mandatory charge cannot be waived');

    console.log('\n4. A recompute preserves the recorded waiver');
    const added = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(added.status, 200, 'item added to the order');
    const afterAdd = JSON.parse(added.data.order.charges_breakdown);
    assertEqualOrThrow(afterAdd.find((c: any) => c.id === 'service_charge').waived, true, 'adding an item does not un-waive the fee');
    assertEqualOrThrow(added.data.order.service_charge, 0, 'the service_charge column stays cleared');
    assertEqualOrThrow(
      afterAdd.find((c: any) => c.id === 'late_night').amount,
      7,
      'a fixed fee is unchanged by a subtotal change',
    );
    assertEqualOrThrow(
      afterAdd.find((c: any) => c.id === 'service_charge').amount,
      0,
      'the waived fee stays at zero',
    );

    console.log('\n5. A changed order-type rule applies only to new orders');
    await putCharges([SERVICE_CHARGE, LATE_NIGHT]);
    const retainedOrder = await createOrder('dine_in');
    assertEqualOrThrow(retainedOrder.status, 201, 'the original dine-in order is created');
    assertEqualOrThrow(retainedOrder.data.order.service_charge, 10, 'the original snapshot stores the applied fee');
    await putCharges([{ ...SERVICE_CHARGE, order_types: ['takeaway'] }, LATE_NIGHT]);
    const retainedOrderAfterItem = await api(baseUrl, `/api/orders/${retainedOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(retainedOrderAfterItem.status, 200, 'the existing order can still be recomputed');
    const retainedBreakdown = JSON.parse(retainedOrderAfterItem.data.order.charges_breakdown);
    assertEqualOrThrow(retainedBreakdown.find((charge: any) => charge.id === 'service_charge').amount, 10, 'the excluded fee keeps its stored amount');
    assertEqualOrThrow(retainedOrderAfterItem.data.order.service_charge, 10, 'the legacy service column keeps the stored amount');
    assertEqualOrThrow(retainedOrderAfterItem.data.order.total, 217, 'the retained fee is not recalculated on the existing order');
    const newDineInOrder = await createOrder('dine_in');
    assertEqualOrThrow(newDineInOrder.status, 201, 'a new dine-in order is created after the rule changes');
    assertEqualOrThrow(newDineInOrder.data.order.service_charge, 0, 'the new order does not receive the excluded fee');
    assertEqualOrThrow(newDineInOrder.data.order.total, 107, 'only the remaining dine-in fee applies to the new order');

    const orderCreatorId = 'server-charge-reader';
    const orderCreatorEmail = 'server-charge-reader@test.local';
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'unused-test-hash', 'server', 1, datetime('now'), datetime('now'))
    `).run(orderCreatorId, 'Server Charge Reader', orderCreatorEmail);
    const addUserPermission = db.prepare(`
      INSERT INTO user_permission_overrides
        (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    addUserPermission.run(orderCreatorId, 'orders.create', 'allow', ownerId);
    addUserPermission.run(orderCreatorId, 'settings.view', 'deny', ownerId);
    const jwt = require('jsonwebtoken');
    const { getJWTSecret } = require('../main/routes/auth');
    const orderCreatorAuth = { Authorization: `Bearer ${jwt.sign(
      { userId: orderCreatorId, email: orderCreatorEmail, role: 'server' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}` };

    const createdByOrderCreator = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: orderCreatorAuth,
    });
    assertEqualOrThrow(createdByOrderCreator.status, 201, 'the limited server can create an order');
    const readableCharges = await api(baseUrl, '/api/settings/charges', { headers: orderCreatorAuth });
    assertEqualOrThrow(readableCharges.status, 200, 'order creators can read charges for checkout without settings.view');
    assertEqualOrThrow(readableCharges.data.charges.length, 2, 'the checkout fee definitions are available');
    const deniedSettingsRead = await api(baseUrl, '/api/settings/business', { headers: orderCreatorAuth });
    assertEqualOrThrow(deniedSettingsRead.status, 403, 'order creators still cannot read general settings');
    const deniedChargesWrite = await api(baseUrl, '/api/settings/charges', {
      method: 'PUT', body: { charges: [] }, headers: orderCreatorAuth,
    });
    assertEqualOrThrow(deniedChargesWrite.status, 403, 'order creators cannot edit fee settings');

    const billDiscountUserId = 'server-charge-bill-discount-reader';
    const billDiscountEmail = 'server-charge-bill-discount-reader@test.local';
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'unused-test-hash', 'server', 1, datetime('now'), datetime('now'))
    `).run(billDiscountUserId, 'Server Charge Bill Discount', billDiscountEmail);
    addUserPermission.run(billDiscountUserId, 'bills.discount.apply', 'allow', ownerId);
    addUserPermission.run(billDiscountUserId, 'settings.view', 'deny', ownerId);
    addUserPermission.run(billDiscountUserId, 'orders.create', 'deny', ownerId);
    const billDiscountAuth = { Authorization: `Bearer ${jwt.sign(
      { userId: billDiscountUserId, email: billDiscountEmail, role: 'server' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}` };
    const billDiscountCharges = await api(baseUrl, '/api/settings/charges', { headers: billDiscountAuth });
    assertEqualOrThrow(billDiscountCharges.status, 200, 'bill charge editors can read fee definitions without settings.view or orders.create');
    const billDiscountSettings = await api(baseUrl, '/api/settings/business', { headers: billDiscountAuth });
    assertEqualOrThrow(billDiscountSettings.status, 403, 'bill charge editors cannot read general settings');
    const billDiscountWrite = await api(baseUrl, '/api/settings/charges', {
      method: 'PUT', body: { charges: [] }, headers: billDiscountAuth,
    });
    assertEqualOrThrow(billDiscountWrite.status, 403, 'bill charge editors cannot edit fee settings');
    const billDiscountOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: billDiscountAuth,
    });
    assertEqualOrThrow(billDiscountOrder.status, 403, 'bill charge editors cannot create orders without orders.create');

    console.log('\n6. A waiver is refused once the check has been split');
    setCurrency('USD', 'US');
    setSetting('split_checks_enabled', 'true');
    const previousTaxesEnabled = (db.prepare("SELECT value FROM settings WHERE key = 'taxes_enabled'").get() as any)?.value || 'false';
    installAndActivateTestTaxPack(db, { ...flatRateTaxPack, id: 'charges-api-us-tax', country: 'US', currency: 'USD' });
    db.prepare("UPDATE products SET tax_category_id = 'standard', tax_behavior = 'exclusive' WHERE id = 'prod-charges'").run();
    await putCharges([SERVICE_CHARGE, LATE_NIGHT]);
    const splitOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', items: [{ product_id: 'prod-charges', quantity: 1 }, { product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(splitOrder.status, 201, 'two-item dine-in order created for the split');
    const splitBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: splitOrder.data.order.id }, headers: authHeader,
    });
    const [firstItem, secondItem] = splitOrder.data.order.items;
    const splitRes = await api(baseUrl, `/api/bills/${splitBill.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Guest 1', items: [{ order_item_id: firstItem.id, quantity: 1 }] },
        { label: 'Guest 2', items: [{ order_item_id: secondItem.id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqualOrThrow(splitRes.status, 201, 'the check split into two guest checks');
    const splitBillRows = splitRes.data.bills.map((bill: { id: number }) => (
      db.prepare('SELECT total, subtotal, discount_amount, tax_amount, delivery_charge, packaging_charge, service_charge, round_off, charges_breakdown FROM bills WHERE id = ?').get(bill.id) as any
    ));
    assertEqualOrThrow(
      Number(splitBillRows.reduce((sum: number, bill: any) => sum + bill.total, 0).toFixed(2)),
      splitBill.data.bill.total,
      'exclusive-tax split totals preserve the parent total including custom charges',
    );
    assertEqualOrThrow(
      Number(splitBillRows.reduce((sum: number, bill: any) => sum + JSON.parse(bill.charges_breakdown).find((charge: any) => charge.id === 'late_night').amount, 0).toFixed(2)),
      7,
      'exclusive-tax split breakdown allocates the full non-standard fee',
    );
    splitBillRows.forEach((bill: any) => {
      const customFee = JSON.parse(bill.charges_breakdown).find((charge: any) => charge.id === 'late_night').amount;
      const composedChildTotal = Number((
        bill.subtotal - bill.discount_amount + bill.tax_amount + bill.delivery_charge
        + bill.packaging_charge + bill.service_charge + bill.round_off + customFee
      ).toFixed(2));
      assertEqualOrThrow(bill.total, composedChildTotal, 'each exclusive-tax split total includes its allocated non-standard fee');
    });
    const sibling = splitRes.data.bills[1];
    const splitWaiver = await api(baseUrl, `/api/bills/${sibling.id}/charges`, {
      method: 'PATCH', body: { charge_id: 'service_charge', waived: true }, headers: authHeader,
    });
    assertEqualOrThrow(splitWaiver.status, 409, 'a waiver on a split check is refused');
    const siblingRow = getDatabase().prepare('SELECT charges_breakdown, service_charge FROM bills WHERE id = ?').get(sibling.id) as any;
    const siblingCharges = JSON.parse(siblingRow.charges_breakdown);
    assertEqualOrThrow(siblingCharges.length, 2, 'the split check carries its own itemised charges');
    assertEqualOrThrow(
      siblingCharges.find((c: any) => c.id === 'service_charge').amount,
      10,
      'a split check carries its proportional share of the service charge (10% of its 100 share)',
    );
    assertEqualOrThrow(siblingRow.service_charge, 10, 'the split service_charge column matches its allocated share');

    const cancelledSplitItem = await api(baseUrl, `/api/orders/${splitOrder.data.order.id}/items/${firstItem.id}/cancel`, {
      method: 'PATCH', body: {}, headers: authHeader,
    });
    assertEqualOrThrow(cancelledSplitItem.status, 200, 'an unpaid split order item can be cancelled');
    const syncedSplitRows = db.prepare('SELECT total, charges_breakdown FROM bills WHERE order_id = ? ORDER BY id').all(splitOrder.data.order.id) as any[];
    const syncedSplitOrder = db.prepare('SELECT total FROM orders WHERE id = ?').get(splitOrder.data.order.id) as any;
    assertEqualOrThrow(
      Number(syncedSplitRows.reduce((sum, bill) => sum + bill.total, 0).toFixed(2)),
      syncedSplitOrder.total,
      'unpaid split synchronization preserves the updated parent total',
    );
    assertEqualOrThrow(
      Number(syncedSplitRows.reduce((sum, bill) => sum + JSON.parse(bill.charges_breakdown).find((charge: any) => charge.id === 'late_night').amount, 0).toFixed(2)),
      7,
      'unpaid split synchronization allocates the custom fee exactly once',
    );

    db.prepare("UPDATE products SET tax_behavior = 'inclusive' WHERE id = 'prod-charges'").run();
    const inclusiveSplitOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', items: [{ product_id: 'prod-charges', quantity: 1 }, { product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    const inclusiveSplitBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: inclusiveSplitOrder.data.order.id }, headers: authHeader,
    });
    const inclusiveItems = inclusiveSplitOrder.data.order.items;
    const inclusiveSplit = await api(baseUrl, `/api/bills/${inclusiveSplitBill.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [
        { label: 'Inclusive Guest 1', items: [{ order_item_id: inclusiveItems[0].id, quantity: 1 }] },
        { label: 'Inclusive Guest 2', items: [{ order_item_id: inclusiveItems[1].id, quantity: 1 }] },
      ] },
      headers: authHeader,
    });
    assertEqualOrThrow(inclusiveSplit.status, 201, 'inclusive-tax split with a custom fee succeeds');
    const inclusiveSplitRows = db.prepare('SELECT total, charges_breakdown FROM bills WHERE order_id = ? ORDER BY id').all(inclusiveSplitOrder.data.order.id) as any[];
    assertEqualOrThrow(
      Number(inclusiveSplitRows.reduce((sum, bill) => sum + bill.total, 0).toFixed(2)),
      inclusiveSplitBill.data.bill.total,
      'inclusive-tax split totals preserve the parent amount including custom charges',
    );
    assertEqualOrThrow(
      Number(inclusiveSplitRows.reduce((sum, bill) => sum + JSON.parse(bill.charges_breakdown).find((charge: any) => charge.id === 'late_night').amount, 0).toFixed(2)),
      7,
      'inclusive-tax split breakdown allocates the full non-standard fee',
    );

    db.prepare("UPDATE products SET tax_category_id = NULL, tax_behavior = 'exempt' WHERE id = 'prod-charges'").run();
    setSetting('taxes_enabled', previousTaxesEnabled);

    console.log('\n7. A zero-decimal currency never persists a fractional subunit');
    setCurrency('JPY', 'JP');
    await putCharges([{ ...SERVICE_CHARGE, id: 'service_charge', name: 'Service Charge', type: 'percentage', value: 10 }]);
    const jpyOrder = await createOrder('dine_in');
    assertEqualOrThrow(jpyOrder.status, 201, 'JPY dine-in order created');
    const jpyBreakdown = JSON.parse(jpyOrder.data.order.charges_breakdown);
    assertOrThrow(Number.isInteger(jpyBreakdown[0].amount), 'a JPY fee is stored as whole yen');
    assertOrThrow(Number.isInteger(jpyOrder.data.order.service_charge), 'the JPY service_charge column is integral');
    assertEqualOrThrow(jpyOrder.data.order.service_charge, 10, '10% of 100 JPY is 10 JPY');
    setCurrency('USD', 'US');

    console.log('\n8. A thermal receipt prints an engine charge exactly once');
    await putCharges([SERVICE_CHARGE, LATE_NIGHT]);
    const RECEIPT_TEMPLATE_ID = 'tpl-charges-dup';
    installThermalChargeTemplate(getDatabase(), RECEIPT_TEMPLATE_ID);
    const receiptOrder = await createOrder('dine_in');
    const receiptBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: receiptOrder.data.order.id }, headers: authHeader,
    });
    const receiptText = escPosToText(formatReceipt(
      receiptOrder.data.order,
      receiptBill.data.bill,
      { name: 'Store', address: '', phone: '', taxRegistrationNumber: '', country: 'US', currency: 'USD' },
      RECEIPT_TEMPLATE_ID,
      48,
    ));
    assertEqualOrThrow(countOccurrences(receiptText, 'Service Charge'), 1, 'the declared service-charge row is not repeated by the itemised line');
    assertEqualOrThrow(countOccurrences(receiptText, 'Late Night'), 1, 'the merchant-named surcharge prints once');

    console.log('\n9. Converting to takeaway recomputes totals and clears the dine-in charge');
    await putCharges([SERVICE_CHARGE, LATE_NIGHT]);
    const dineIn = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    const dineInBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: dineIn.data.order.id }, headers: authHeader,
    });
    assertEqualOrThrow(dineIn.data.order.service_charge, 10, 'the dine-in order carries the 10% service charge');
    const converted = await api(baseUrl, `/api/orders/${dineIn.data.order.id}/convert-to-takeaway`, {
      method: 'PATCH', body: {}, headers: authHeader,
    });
    assertEqualOrThrow(converted.status, 200, 'the dine-in order converts to takeaway');
    assertEqualOrThrow(converted.data.order.type, 'takeaway', 'the order type is takeaway');
    assertEqualOrThrow(converted.data.order.service_charge, 0, 'the dine-in service charge is cleared');
    assertEqualOrThrow(JSON.parse(converted.data.order.charges_breakdown).length, 0, 'the stale dine-in breakdown is emptied');
    assertEqualOrThrow(converted.data.order.total, 100, 'the total drops both dine-in fees');
    const syncedBill = getDatabase().prepare('SELECT * FROM bills WHERE id = ?').get(dineInBill.data.bill.id) as any;
    assertEqualOrThrow(Number(syncedBill.service_charge), 0, 'the unpaid bill service charge is synced to zero');
    assertEqualOrThrow(Number(syncedBill.total), 100, 'the unpaid bill total is synced to the converted total');
    assertEqualOrThrow(JSON.parse(syncedBill.charges_breakdown).length, 0, 'the unpaid bill breakdown is synced empty');

    console.log('\n10. Removing the last charge stores [] instead of resurrecting the stale breakdown');
    await putCharges([{ ...LATE_NIGHT, id: 'packaging_fee', name: 'Packaging Fee', value: 5, is_optional: true, is_default_active: false }]);
    const removeOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', opted_in_charge_ids: ['packaging_fee'], items: [{ product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(removeOrder.data.order.total, 105, 'the opted-in packaging fee is charged at creation');
    const removeBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: removeOrder.data.order.id }, headers: authHeader,
    });
    const removeBillId = removeBill.data.bill.id;
    const removed = await api(baseUrl, `/api/bills/${removeBillId}/charges`, {
      method: 'PATCH', body: { charge_id: 'packaging_fee', applied: false }, headers: authHeader,
    });
    assertEqualOrThrow(removed.status, 200, 'the last charge is removed');
    assertEqualOrThrow(removed.data.bill.charges_breakdown, '[]', 'removing the last charge stores an empty array, not null');
    assertEqualOrThrow(JSON.parse(removed.data.bill.charges_breakdown).length, 0, 'the bill breakdown is empty');
    const orderAfterRemove = getDatabase().prepare('SELECT charges_breakdown FROM orders WHERE id = ?').get(removeOrder.data.order.id) as any;
    assertEqualOrThrow(orderAfterRemove.charges_breakdown, '[]', 'the order breakdown is emptied too');

    console.log('\n10a. Removing a standard opted-in charge clears its legacy column');
    await putCharges([{ ...SERVICE_CHARGE, type: 'fixed', value: 5, is_optional: false, is_default_active: false }]);
    const standardRemoveOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', opted_in_charge_ids: ['service_charge'], items: [{ product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(standardRemoveOrder.status, 201, 'the opted-in standard charge is applied');
    assertEqualOrThrow(standardRemoveOrder.data.order.service_charge, 5, 'the standard column stores the engine charge');
    const standardRemoveBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: standardRemoveOrder.data.order.id }, headers: authHeader,
    });
    const standardRemoved = await api(baseUrl, `/api/bills/${standardRemoveBill.data.bill.id}/charges`, {
      method: 'PATCH', body: { charge_id: 'service_charge', applied: false }, headers: authHeader,
    });
    assertEqualOrThrow(standardRemoved.status, 200, 'the standard charge is removed');
    assertEqualOrThrow(standardRemoved.data.bill.service_charge, 0, 'the removed standard charge does not return from its legacy column');
    assertEqualOrThrow(standardRemoved.data.bill.total, 100, 'the removed standard charge is excluded from the bill total');
    const afterStandardRemoveAppend = await api(baseUrl, `/api/orders/${standardRemoveOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(afterStandardRemoveAppend.status, 200, 'the order recomputes after removing the standard charge');
    assertEqualOrThrow(afterStandardRemoveAppend.data.order.service_charge, 0, 'an item append does not resurrect the removed charge');
    assertEqualOrThrow(afterStandardRemoveAppend.data.order.total, 200, 'an item append totals without the removed charge');
    const afterStandardRemoveDiscount = await api(baseUrl, `/api/orders/${standardRemoveOrder.data.order.id}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 10 }, headers: authHeader,
    });
    assertEqualOrThrow(afterStandardRemoveDiscount.status, 200, 'the order can be discounted after removing the standard charge');
    assertEqualOrThrow(afterStandardRemoveDiscount.data.order.service_charge, 0, 'a discount recompute does not resurrect the removed charge');
    assertEqualOrThrow(afterStandardRemoveDiscount.data.order.total, 180, 'the discount total excludes the removed charge');

    console.log('\n10b. Cancelling the last item clears engine-owned fixed charges');
    await putCharges([{ ...SERVICE_CHARGE, type: 'fixed', value: 5, is_optional: false }]);
    const cancelFeeOrder = await createOrder('dine_in');
    const cancelFeeBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: cancelFeeOrder.data.order.id }, headers: authHeader,
    });
    const cancelledFeeOrder = await api(baseUrl, `/api/orders/${cancelFeeOrder.data.order.id}/items/${cancelFeeOrder.data.order.items[0].id}/cancel`, {
      method: 'PATCH', body: {}, headers: authHeader,
    });
    assertEqualOrThrow(cancelledFeeOrder.status, 200, 'the last item is cancelled');
    assertEqualOrThrow(cancelledFeeOrder.data.order.status, 'cancelled', 'the order is marked cancelled');
    assertEqualOrThrow(cancelledFeeOrder.data.order.service_charge, 0, 'the cancelled order clears its engine-owned standard fee');
    assertEqualOrThrow(cancelledFeeOrder.data.order.charges_breakdown, '[]', 'the cancelled order has no collectible charge snapshots');
    assertEqualOrThrow(cancelledFeeOrder.data.order.total, 0, 'the cancelled order total is zero');
    const cancelledFeeBillRow = db.prepare('SELECT total, service_charge, charges_breakdown FROM bills WHERE id = ?').get(cancelFeeBill.data.bill.id) as any;
    assertEqualOrThrow(cancelledFeeBillRow.total, 0, 'the unpaid bill total is zero after cancellation');
    assertEqualOrThrow(cancelledFeeBillRow.service_charge, 0, 'the unpaid bill clears the engine-owned fee');

    await putCharges([{ ...SERVICE_CHARGE, type: 'fixed', value: 7, is_optional: true }]);
    const cancelledOptionalOrder = await createOrder('dine_in');
    const cancelledOptionalBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: cancelledOptionalOrder.data.order.id }, headers: authHeader,
    });
    await api(baseUrl, `/api/orders/${cancelledOptionalOrder.data.order.id}/items/${cancelledOptionalOrder.data.order.items[0].id}/cancel`, {
      method: 'PATCH', body: {}, headers: authHeader,
    });
    const cancelledToggle = await api(baseUrl, `/api/bills/${cancelledOptionalBill.data.bill.id}/charges`, {
      method: 'PATCH', body: { charge_id: 'service_charge', waived: false }, headers: authHeader,
    });
    assertEqualOrThrow(cancelledToggle.status, 409, 'charges cannot be restored on a cancelled order');
    const cancelledAfterToggle = db.prepare('SELECT total, balance, charges_breakdown FROM bills WHERE id = ?').get(cancelledOptionalBill.data.bill.id) as any;
    assertEqualOrThrow(cancelledAfterToggle.total, 0, 'the cancelled bill stays at zero after a rejected toggle');
    assertEqualOrThrow(cancelledAfterToggle.balance, 0, 'the cancelled bill stays without a balance');
    assertEqualOrThrow(cancelledAfterToggle.charges_breakdown, '[]', 'the rejected toggle preserves cleared charges');

    const cancelledDiscount = await api(baseUrl, `/api/bills/${cancelFeeBill.data.bill.id}/applyDiscount`, {
      method: 'POST', body: { type: 'percentage', value: 10, reason: 'cancelled order' }, headers: authHeader,
    });
    assertEqualOrThrow(cancelledDiscount.status, 409, 'discounts cannot restore fees on a cancelled order');
    const cancelledAfterDiscount = db.prepare('SELECT total, balance FROM bills WHERE id = ?').get(cancelFeeBill.data.bill.id) as any;
    assertEqualOrThrow(cancelledAfterDiscount.total, 0, 'the cancelled bill stays at zero after a rejected discount');
    assertEqualOrThrow(cancelledAfterDiscount.balance, 0, 'the cancelled bill balance stays zero after a rejected discount');

    console.log('\n11. Order create keeps a manual charge column the engine has no rule for');
    await putCharges([{ ...LATE_NIGHT, id: 'late_night', order_types: ['dine_in'] }]);
    const manual = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', service_charge: 4, packaging_charge: 3, items: [{ product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(manual.status, 201, 'an order with manual charge columns is created');
    assertEqualOrThrow(manual.data.order.service_charge, 4, 'a manual service charge survives an engine that owns no service_charge');
    assertEqualOrThrow(manual.data.order.packaging_charge, 3, 'a manual packaging charge survives too');
    assertEqualOrThrow(manual.data.order.total, 114, 'the total still includes the manual columns');
    const manualBreakdown = JSON.parse(manual.data.order.charges_breakdown);
    assertEqualOrThrow(manualBreakdown.some((charge: any) => charge.id === 'service_charge'), false, 'the manual column is not faked as an engine charge');

    await putCharges([]);
    const legacyManual = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', service_charge: 4, packaging_charge: 3, items: [{ product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyManual.status, 201, 'a legacy order with manual standard columns is created');
    assertEqualOrThrow(legacyManual.data.order.charges_breakdown, null, 'the legacy manual order has no engine snapshot');
    await putCharges([{ ...SERVICE_CHARGE, type: 'fixed', value: 5, is_optional: true, is_default_active: false }]);
    const legacyManualAppend = await api(baseUrl, `/api/orders/${legacyManual.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(legacyManualAppend.status, 200, 'the legacy order recomputes with an unapplied default-off fee definition');
    assertEqualOrThrow(legacyManualAppend.data.order.service_charge, 4, 'an unapplied default-off definition preserves the legacy service column');
    assertEqualOrThrow(legacyManualAppend.data.order.packaging_charge, 3, 'the legacy packaging column also survives');
    assertEqualOrThrow(legacyManualAppend.data.order.total, 207, 'the legacy manual amounts remain in the recomputed total');

    console.log('\n12. Cart charge decisions survive order creation');
    await putCharges([
      { ...SERVICE_CHARGE, is_optional: true },
      { ...LATE_NIGHT, id: 'nightly', is_default_active: false, is_optional: false },
    ]);
    const withDecisions = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        waived_charge_ids: ['service_charge'],
        opted_in_charge_ids: ['nightly'],
        items: [{ product_id: 'prod-charges', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(withDecisions.status, 201, 'an order carrying cart charge decisions is created');
    const decided = JSON.parse(withDecisions.data.order.charges_breakdown);
    assertEqualOrThrow(decided.find((c: any) => c.id === 'service_charge').waived, true, 'the cashier waiver is applied at creation');
    assertEqualOrThrow(decided.find((c: any) => c.id === 'service_charge').amount, 0, 'the waived fee is not charged');
    assertEqualOrThrow(decided.find((c: any) => c.id === 'nightly').amount, 7, 'the opted-in charge the cashier added is applied');
    assertEqualOrThrow(withDecisions.data.order.service_charge, 0, 'the waived column is cleared');
    assertEqualOrThrow(withDecisions.data.order.total, 107, 'the total reflects the waiver and the opt-in');
    await putCharges([{ ...LATE_NIGHT, id: 'waived_opt_in', is_optional: true, is_default_active: false }]);
    const waivedOptInOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        waived_charge_ids: ['waived_opt_in'],
        opted_in_charge_ids: ['waived_opt_in'],
        items: [{ product_id: 'prod-charges', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(waivedOptInOrder.status, 201, 'a waived optional opt-in is recorded');
    const waivedOptInAppend = await api(baseUrl, `/api/orders/${waivedOptInOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(waivedOptInAppend.status, 200, 'the waived optional opt-in order recomputes');
    const waivedOptInSnapshot = JSON.parse(waivedOptInAppend.data.order.charges_breakdown)
      .find((charge: any) => charge.id === 'waived_opt_in');
    assertEqualOrThrow(waivedOptInSnapshot?.waived, true, 'a recompute preserves the waived opt-in decision');
    assertEqualOrThrow(waivedOptInSnapshot?.amount, 0, 'the waived opt-in remains zero after a recompute');
    const badIds = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', waived_charge_ids: 'service_charge', items: [{ product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(badIds.status, 400, 'a non-array waived_charge_ids is rejected');

    console.log('\n13. Recomputed orders retain inactive fee snapshots without charging new orders');
    await putCharges([SERVICE_CHARGE, LATE_NIGHT]);
    const inactiveOrder = await createOrder('dine_in');
    const inactiveBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: inactiveOrder.data.order.id }, headers: authHeader,
    });
    await putCharges([SERVICE_CHARGE, { ...LATE_NIGHT, is_active: false }]);
    const inactiveAppend = await api(baseUrl, `/api/orders/${inactiveOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(inactiveAppend.status, 200, 'item append succeeds after a fee is disabled');
    const inactiveCharges = JSON.parse(inactiveAppend.data.order.charges_breakdown);
    assertEqualOrThrow(inactiveCharges.find((charge: any) => charge.id === 'late_night')?.amount, 7, 'disabled fixed fee snapshot remains unchanged');
    assertEqualOrThrow(inactiveCharges.find((charge: any) => charge.id === 'service_charge')?.amount, 20, 'still-active percentage fee recalculates against the new subtotal');
    assertEqualOrThrow(inactiveAppend.data.order.total, 227, 'the total includes the retained fee once');
    const inactiveBillRow = db.prepare('SELECT total, charges_breakdown FROM bills WHERE id = ?').get(inactiveBill.data.bill.id) as any;
    assertEqualOrThrow(inactiveBillRow.total, 227, 'the unpaid bill total follows the recomputed order');
    assertEqualOrThrow(JSON.parse(inactiveBillRow.charges_breakdown).find((charge: any) => charge.id === 'late_night')?.amount, 7, 'the unpaid bill keeps the same retained fee snapshot');
    const afterDisable = await createOrder('dine_in');
    assertEqualOrThrow(afterDisable.data.order.total, 110, 'a new order does not receive the disabled fee');
    assertEqualOrThrow(JSON.parse(afterDisable.data.order.charges_breakdown).some((charge: any) => charge.id === 'late_night'), false, 'the disabled fee is absent from a new order');

    console.log('\n14. Recomputed orders retain deleted fee snapshots while preserving unpaid bill totals');
    await putCharges([LATE_NIGHT]);
    const deletedOrder = await createOrder('dine_in');
    const deletedBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: deletedOrder.data.order.id }, headers: authHeader,
    });
    await putCharges([]);
    const deletedAppend = await api(baseUrl, `/api/orders/${deletedOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(deletedAppend.status, 200, 'item append succeeds after the fee definition is removed');
    assertEqualOrThrow(JSON.parse(deletedAppend.data.order.charges_breakdown).find((charge: any) => charge.id === 'late_night')?.amount, 7, 'deleted fee remains as the original snapshot');
    assertEqualOrThrow(deletedAppend.data.order.total, 207, 'the total includes the retained deleted fee once');
    const deletedBillRow = db.prepare('SELECT total, charges_breakdown FROM bills WHERE id = ?').get(deletedBill.data.bill.id) as any;
    assertEqualOrThrow(deletedBillRow.total, 207, 'the unpaid bill retains the deleted fee in its total');
    assertEqualOrThrow(JSON.parse(deletedBillRow.charges_breakdown).find((charge: any) => charge.id === 'late_night')?.amount, 7, 'the unpaid bill keeps the original deleted fee snapshot');
    const afterDelete = await createOrder('dine_in');
    assertEqualOrThrow(afterDelete.data.order.total, 100, 'a new order receives no deleted fee');
    assertEqualOrThrow(afterDelete.data.order.charges_breakdown == null || JSON.parse(afterDelete.data.order.charges_breakdown).length === 0, true, 'the deleted fee is absent from a new order');

    console.log('\n15. Bill discounts recompute configured percentage fees and retain fixed fees');
    await putCharges([{ ...SERVICE_CHARGE, calculation_basis: 'net' }, LATE_NIGHT]);
    const discountedOrder = await createOrder('dine_in');
    const discountedBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: discountedOrder.data.order.id }, headers: authHeader,
    });
    const discounted = await api(baseUrl, `/api/bills/${discountedBill.data.bill.id}/applyDiscount`, {
      method: 'POST', body: { type: 'percentage', value: 10, reason: 'charge recalculation test' }, headers: authHeader,
    });
    assertEqualOrThrow(discounted.status, 200, 'bill discount succeeds with configured charges');
    assertEqualOrThrow(discounted.data.bill.total, 106, 'bill total includes discounted net percentage and fixed charges');
    assertEqualOrThrow(discounted.data.bill.service_charge, 9, 'bill service charge recalculates from the discounted net');
    const discountedCharges = JSON.parse(discounted.data.bill.charges_breakdown);
    assertEqualOrThrow(discountedCharges.find((charge: any) => charge.id === 'service_charge')?.amount, 9, 'order snapshot stores the recomputed percentage fee');
    assertEqualOrThrow(discountedCharges.find((charge: any) => charge.id === 'late_night')?.amount, 7, 'order snapshot retains the fixed fee');
    const discountedOrderRow = db.prepare('SELECT total, charges_breakdown FROM orders WHERE id = ?').get(discountedOrder.data.order.id) as any;
    assertEqualOrThrow(discountedOrderRow.total, 106, 'order exact total agrees with the discounted bill');
    assertEqualOrThrow(JSON.parse(discountedOrderRow.charges_breakdown).find((charge: any) => charge.id === 'late_night')?.amount, 7, 'order and bill share the same charge breakdown');

    console.log('\n16. Packaging columns stay in sync through item and bill discounts');
    await putCharges([{
      id: 'packaging_charge',
      name: 'Net Packaging',
      type: 'percentage',
      value: 10,
      calculation_basis: 'net',
      order_types: ['dine_in'],
      is_optional: false,
      is_default_active: true,
      is_active: true,
    }]);
    const packagingOrder = await createOrder('dine_in');
    const packagingBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: packagingOrder.data.order.id }, headers: authHeader,
    });
    assertEqualOrThrow(packagingBill.data.bill.packaging_charge, 10, 'the initial bill has its packaging fee');
    const packagingOrderDiscount = await api(baseUrl, `/api/orders/${packagingOrder.data.order.id}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 10 }, headers: authHeader,
    });
    assertEqualOrThrow(packagingOrderDiscount.status, 200, 'an order discount recalculates packaging');
    assertEqualOrThrow(packagingOrderDiscount.data.order.packaging_charge, 9, 'order packaging uses the discounted net');
    const orderDiscountBill = db.prepare('SELECT packaging_charge, charges_breakdown, total, balance FROM bills WHERE id = ?').get(packagingBill.data.bill.id) as any;
    assertEqualOrThrow(orderDiscountBill.packaging_charge, 9, 'bill packaging column follows the order discount');
    assertEqualOrThrow(JSON.parse(orderDiscountBill.charges_breakdown)[0].amount, 9, 'bill breakdown agrees with its packaging column');
    assertEqualOrThrow(orderDiscountBill.total, 99, 'bill total includes the discounted packaging');
    assertEqualOrThrow(orderDiscountBill.balance, 99, 'bill balance agrees with the discounted total');
    await api(baseUrl, `/api/orders/${packagingOrder.data.order.id}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 0 }, headers: authHeader,
    });
    const packagingAppend = await api(baseUrl, `/api/orders/${packagingOrder.data.order.id}/items`, {
      method: 'POST', body: { items: [{ product_id: 'prod-charges', quantity: 1 }] }, headers: authHeader,
    });
    assertEqualOrThrow(packagingAppend.status, 200, 'a second item is added');
    assertEqualOrThrow(packagingAppend.data.order.packaging_charge, 20, 'the order packaging fee follows the new subtotal');
    let packagingBillRow = db.prepare('SELECT packaging_charge FROM bills WHERE id = ?').get(packagingBill.data.bill.id) as any;
    assertEqualOrThrow(packagingBillRow.packaging_charge, 20, 'the unpaid bill packaging fee follows the new subtotal');
    const itemDiscount = await api(baseUrl, `/api/orders/${packagingOrder.data.order.id}/items/${packagingOrder.data.order.items[0].id}/discount`, {
      method: 'PATCH', body: { discount_type: 'percentage', discount_value: 10 }, headers: authHeader,
    });
    assertEqualOrThrow(itemDiscount.status, 200, 'an item discount recalculates the packaging fee');
    packagingBillRow = db.prepare('SELECT packaging_charge FROM bills WHERE id = ?').get(packagingBill.data.bill.id) as any;
    assertEqualOrThrow(packagingBillRow.packaging_charge, 19, 'the unpaid bill packaging fee follows an item discount');
    const packagingBillDiscount = await api(baseUrl, `/api/bills/${packagingBill.data.bill.id}/applyDiscount`, {
      method: 'POST', body: { type: 'percentage', value: 10, reason: 'packaging charge sync test' }, headers: authHeader,
    });
    assertEqualOrThrow(packagingBillDiscount.status, 200, 'a bill discount recalculates packaging');
    assertEqualOrThrow(packagingBillDiscount.data.bill.packaging_charge, 17.1, 'the bill packaging fee uses the discounted net subtotal');
    const packagingOrderRow = db.prepare('SELECT packaging_charge FROM orders WHERE id = ?').get(packagingOrder.data.order.id) as any;
    assertEqualOrThrow(packagingOrderRow.packaging_charge, 17.1, 'the order packaging column matches the discounted bill');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\nCharges engine API: ${results.passed}/${results.total} checks passed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  try { closeDatabase(); } catch { /* already closed */ }
  process.exit(1);
});
