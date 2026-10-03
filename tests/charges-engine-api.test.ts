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
  api, assertEqualOrThrow, assertOrThrow, getResults, closeDatabase, getDatabase,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { escPosToText, formatReceipt } = require('../main/printers/thermal');

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
  const { authHeader } = seedOwnerUser(db);
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
    ] as const) {
      const res = await putCharges([charge]);
      assertEqualOrThrow(res.status, 400, `rejects ${label}`);
    }
    assertEqualOrThrow(
      JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'custom_charges'").get() as any).value).length,
      2,
      'no rejected write partially replaced the stored list',
    );

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

    console.log('\n5. A waiver is refused once the check has been split');
    setCurrency('USD', 'US');
    setSetting('split_checks_enabled', 'true');
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

    console.log('\n6. A zero-decimal currency never persists a fractional subunit');
    setCurrency('JPY', 'JP');
    await putCharges([{ ...SERVICE_CHARGE, id: 'service_charge', name: 'Service Charge', type: 'percentage', value: 10 }]);
    const jpyOrder = await createOrder('dine_in');
    assertEqualOrThrow(jpyOrder.status, 201, 'JPY dine-in order created');
    const jpyBreakdown = JSON.parse(jpyOrder.data.order.charges_breakdown);
    assertOrThrow(Number.isInteger(jpyBreakdown[0].amount), 'a JPY fee is stored as whole yen');
    assertOrThrow(Number.isInteger(jpyOrder.data.order.service_charge), 'the JPY service_charge column is integral');
    assertEqualOrThrow(jpyOrder.data.order.service_charge, 10, '10% of 100 JPY is 10 JPY');
    setCurrency('USD', 'US');

    console.log('\n7. A thermal receipt prints an engine charge exactly once');
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

    console.log('\n8. Converting to takeaway recomputes totals and clears the dine-in charge');
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

    console.log('\n9. Removing the last charge stores [] instead of resurrecting the stale breakdown');
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

    console.log('\n10. Order create keeps a manual charge column the engine has no rule for');
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

    console.log('\n11. Cart charge decisions survive order creation');
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
    const badIds = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', waived_charge_ids: 'service_charge', items: [{ product_id: 'prod-charges', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(badIds.status, 400, 'a non-array waived_charge_ids is rejected');

    console.log('\n12. Recomputed orders retain inactive fee snapshots without charging new orders');
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

    console.log('\n13. Recomputed orders retain deleted fee snapshots while preserving unpaid bill totals');
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

    console.log('\n14. Bill discounts recompute configured percentage fees and retain fixed fees');
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
