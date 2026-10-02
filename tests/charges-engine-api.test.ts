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