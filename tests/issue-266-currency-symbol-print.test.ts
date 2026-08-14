/**
 * Regression test for #266.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-266-currency-symbol-print.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-266-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assert,
  assertEqual,
  assertIncludes,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { settingsRoutes } = require('../main/routes/settings');
const { printerRoutes } = require('../main/routes/printers');

function upsertSetting(db: any, key: string, value: string) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
}

function seedPrintableBill(db: any) {
  db.prepare(`
    INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, paper_width, created_at, updated_at)
    VALUES ('printer-266', 'Preview Printer', 'network', '127.0.0.1', 9100, 1, '80mm', ?, ?)
  `).run(now(), now());

  const order = db.prepare(`
    INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-266', 'takeaway', 'completed', 100, 100, ?, ?)
    RETURNING id
  `).get(now(), now()) as { id: number };

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
    VALUES (?, 'prod-266', 'Mint Tea', 100, 1, 100, 100, ?, ?)
  `).run(order.id, now(), now());

  const bill = db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
    VALUES ('BILL-266', ?, 100, 100, 100, 'unpaid', ?, ?)
    RETURNING id
  `).get(order.id, now(), now()) as { id: number };

  return { orderId: order.id, billId: bill.id };
}

async function main() {
  console.log('Issue #266: currency symbol stays in sync for Electron receipts');
  console.log('='.repeat(70));

  let server;
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const { billId } = seedPrintableBill(db);

  const app = createApp({
    '/api/settings': settingsRoutes,
    '/api/printers': printerRoutes,
  });
  const started = await startServer(app);
  server = started.server;
  const baseUrl = started.baseUrl;

  try {
    console.log('\n1. Settings save updates the derived currency symbol');
    upsertSetting(db, 'country', 'IN');
    upsertSetting(db, 'currency', 'INR');
    upsertSetting(db, 'currency_symbol', '₹');

    const settingsRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeader,
      body: {
        business_name: 'Cafe MAD',
        country: 'MA',
        currency: 'MAD',
        timezone: 'Africa/Casablanca',
      },
    });
    assertEqual(settingsRes.status, 200, 'business settings update succeeds');
    assertEqual(settingsRes.data.country, 'MA', 'settings response uses Morocco country');
    assertEqual(settingsRes.data.currency, 'MAD', 'settings response uses MAD currency');
    const savedSymbol = db.prepare("SELECT value FROM settings WHERE key = 'currency_symbol'").get() as { value: string };
    assertEqual(savedSymbol.value, 'MAD', 'settings.currency_symbol is derived from MAD');

    console.log('\n2. Electron preview derives from current currency even if stored symbol is stale');
    upsertSetting(db, 'currency_symbol', '₹');
    const madPreview = await api(baseUrl, '/api/printers/print-bill', {
      method: 'POST',
      headers: authHeader,
      body: { billId, preview: true, useUnicode: false },
    });
    assertEqual(madPreview.status, 200, 'MAD print preview succeeds');
    assertIncludes(madPreview.data.text, 'MAD', 'MAD preview uses MAD prefix');
    assert(!madPreview.data.text.includes('Rs'), 'MAD preview does not use stale INR ASCII prefix');

    console.log('\n3. Existing INR ASCII fallback remains unchanged');
    upsertSetting(db, 'country', 'IN');
    upsertSetting(db, 'currency', 'INR');
    upsertSetting(db, 'currency_symbol', '₹');
    const inrPreview = await api(baseUrl, '/api/printers/print-bill', {
      method: 'POST',
      headers: authHeader,
      body: { billId, preview: true, useUnicode: false },
    });
    assertEqual(inrPreview.status, 200, 'INR print preview succeeds');
    assertIncludes(inrPreview.data.text, 'Rs', 'INR ASCII fallback still uses Rs');
  } finally {
    if (server) server.close();
    closeDatabase();
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(70));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  try { closeDatabase(); } catch { /* ignore */ }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  Module._load = originalLoad;
  process.exit(1);
});
