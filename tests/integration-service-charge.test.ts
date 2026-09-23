/**
 * Integration coverage for the optional discretionary service charge.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-service-charge.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-service-charge-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual,
  getResults, closeDatabase,
} = require('./helpers/test-setup');

const { settingsRoutes } = require('../main/routes/settings');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { reportRoutes } = require('../main/routes/reports');

async function main() {
  console.log('Integration Test: Service Charge');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-service-charge', 'Service Charge Menu');
  seedProduct(db, 'prod-service-charge', 'cat-service-charge', 'Test Item', 100);

  const app = createApp({
    '/api/settings': settingsRoutes,
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/reports': reportRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. Settings defaults and validation');
    const defaults = await api(baseUrl, '/api/settings/business', { headers: authHeader });
    assertEqual(defaults.status, 200, 'business settings return 200');
    assertEqual(defaults.data.service_charge_enabled, false, 'service charge is disabled by default');
    assertEqual(defaults.data.service_charge_rate, 0, 'service charge rate defaults to 0');
    assertEqual(JSON.stringify(defaults.data.service_charge_order_types), JSON.stringify(['dine_in']), 'service charge defaults to dine-in');

    const invalidRate = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeader,
      body: { service_charge_enabled: true, service_charge_rate: 101, service_charge_order_types: ['dine_in'] },
    });
    assertEqual(invalidRate.status, 400, 'rates above 100 percent are rejected');

    const invalidType = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeader,
      body: { service_charge_enabled: true, service_charge_rate: 10, service_charge_order_types: ['invalid'] },
    });
    assertEqual(invalidType.status, 400, 'unknown order types are rejected');

    const savedSettings = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeader,
      body: { service_charge_enabled: true, service_charge_rate: 10, service_charge_order_types: ['dine_in'] },
    });
    assertEqual(savedSettings.status, 200, 'valid service charge settings save');
    assertEqual(savedSettings.data.service_charge_enabled, true, 'service charge is enabled');
    assertEqual(savedSettings.data.service_charge_rate, 10, 'service charge rate is 10 percent');

    console.log('\n2. Order type calculation and discount basis');
    const dineIn = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'dine_in', items: [{ product_id: 'prod-service-charge', quantity: 1 }] },
    });
    assertEqual(dineIn.status, 201, 'dine-in order is created');
    assertEqual(dineIn.data.order.service_charge, 10, 'dine-in service charge is 10 percent');
    assertEqual(dineIn.data.order.total, 110, 'dine-in total includes service charge');

    const takeaway = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-service-charge', quantity: 1 }] },
    });
    assertEqual(takeaway.status, 201, 'takeaway order is created');
    assertEqual(takeaway.data.order.service_charge, 0, 'takeaway is excluded by policy');
    assertEqual(takeaway.data.order.total, 100, 'takeaway total has no service charge');

    const orderId = dineIn.data.order.id;
    const discounted = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      headers: authHeader,
      body: { discount_type: 'percentage', discount_value: 10 },
    });
    assertEqual(discounted.status, 200, 'order discount is accepted');
    assertEqual(discounted.data.order.discount_amount, 10, 'discount amount is 10');
    assertEqual(discounted.data.order.service_charge, 9, 'service charge uses discounted net subtotal');
    assertEqual(discounted.data.order.total, 99, 'discounted total includes the recalculated charge');

    console.log('\n3. Bill waiver and reapply without PIN');
    const generated = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: orderId },
    });
    assertEqual(generated.status, 201, 'bill is generated');
    const billId = generated.data.bill.id;
    assertEqual(generated.data.bill.service_charge, 9, 'bill carries the service charge');

    const waived = await api(baseUrl, `/api/bills/${billId}/service-charge`, {
      method: 'PATCH',
      headers: authHeader,
      body: { waived: true },
    });
    assertEqual(waived.status, 200, 'cashier can waive service charge without PIN');
    assertEqual(waived.data.bill.service_charge, 0, 'waived bill has no service charge');
    assertEqual(waived.data.bill.total, 90, 'waived bill total is reduced');

    const reapplied = await api(baseUrl, `/api/bills/${billId}/service-charge`, {
      method: 'PATCH',
      headers: authHeader,
      body: { waived: false },
    });
    assertEqual(reapplied.status, 200, 'service charge can be reapplied without PIN');
    assertEqual(reapplied.data.bill.service_charge, 9, 'reapplied bill restores the charge');
    assertEqual(reapplied.data.bill.total, 99, 'reapplied bill total is restored');

    const paid = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      headers: authHeader,
      body: { method: 'cash', amount: 99 },
    });
    assertEqual(paid.status, 200, 'bill with service charge is paid');
    assertEqual(paid.data.bill.payment_status, 'paid', 'bill is marked paid');

    console.log('\n4. Paid-bill report aggregation');
    const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const report = await api(baseUrl, `/api/reports/financial-summary?start_date=${reportDate}&end_date=${reportDate}`, { headers: authHeader });
    assertEqual(report.status, 200, 'financial summary returns 200');
    assertEqual(report.data.financialSummary.serviceChargeTotal, 9, 'financial summary aggregates paid service charges');
    assert(report.data.financialSummary.grossCollected >= 99, 'gross collections include the paid bill');
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
