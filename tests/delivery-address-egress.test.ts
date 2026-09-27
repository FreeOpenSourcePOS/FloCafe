// Delivery-address contract: the column exists and is bounded, the address never
// reaches the cloud outbox, and the merchant's number override is a real setting.

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-delivery-address-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, api, seedOwnerUser, seedCategory, seedProduct,
  closeDatabase,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { settingsRoutes } = require('../main/routes/settings');

const DELIVERY_ADDRESS = 'Flat 4B, 123A-Anecacuilco 04330, Colonia Naucalpan';
const OVER_CAP_ADDRESS = 'x'.repeat(400);

/** The shared factory, not a hand-rolled app.
 * `createApp` mounts the same middleware production mounts, in the same order,
 */
function testApp(): any {
  return createApp({ '/api/orders': orderRoutes, '/api/settings': settingsRoutes });
}

/** Wait for the outbox row that cloud sync would transmit. */
async function waitForOutboxRow(db: any, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare(
      "SELECT payload FROM cloud_sync_outbox WHERE entity_type = 'order' ORDER BY created_at DESC LIMIT 1",
    ).get();
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('delivery address: a delivery order persists the address the cashier typed', async () => {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-1', 'Coffee');
  seedProduct(db, 'product-1', 'cat-1', 'Espresso', 250);
  const { baseUrl, server } = await startServer(testApp());
  try {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'delivery', delivery_address: DELIVERY_ADDRESS, items: [{ product_id: 'product-1', quantity: 1 }] },
    });
    assert.equal(created.status, 201, 'the delivery order is accepted');
    assert.equal(
      db.prepare('SELECT delivery_address FROM orders WHERE id = ?').get(created.data.order.id).delivery_address,
      DELIVERY_ADDRESS,
      'the order row carries the delivery address',
    );
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery address: a non-delivery order stores no address', async () => {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-1', 'Coffee');
  seedProduct(db, 'product-1', 'cat-1', 'Espresso', 250);
  const { baseUrl, server } = await startServer(testApp());
  try {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'dine_in', items: [{ product_id: 'product-1', quantity: 1 }] },
    });
    assert.equal(created.status, 201, 'the order is accepted');
    assert.equal(
      db.prepare('SELECT delivery_address FROM orders WHERE id = ?').get(created.data.order.id).delivery_address,
      null,
      'no address is stored for an order that is not a delivery',
    );
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery address: an over-long address is refused at the boundary', async () => {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-1', 'Coffee');
  seedProduct(db, 'product-1', 'cat-1', 'Espresso', 250);
  const { baseUrl, server } = await startServer(testApp());
  try {
    const rejected = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'delivery', delivery_address: OVER_CAP_ADDRESS, items: [{ product_id: 'product-1', quantity: 1 }] },
    });
    assert.equal(rejected.status, 400, 'an address past the cap is refused, not stored and not printed');
    assert.match(String(rejected.data.error), /Delivery address exceed maximum length/);
    // Scoped to the cap, not to any non-empty address: earlier cases in this
    // suite legitimately persist short addresses.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM orders WHERE LENGTH(delivery_address) > ?').get(300).c,
      0,
      'nothing over-long was persisted',
    );

    const wrongType = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'delivery', delivery_address: { not: 'a string' }, items: [{ product_id: 'product-1', quantity: 1 }] },
    });
    assert.equal(wrongType.status, 400, 'a non-string address is refused');
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery address: it never reaches the cloud sync outbox', async () => {
  // The egress guard. The outbox row IS what leaves the machine: cloud sync ships
  // enabled by default, and the snapshot is built from `SELECT * FROM orders`, so
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-1', 'Coffee');
  seedProduct(db, 'product-1', 'cat-1', 'Espresso', 250);
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'cloud_sync_enabled'").run();
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'cloud_orders_enabled'").run();
  const { baseUrl, server } = await startServer(testApp());
  try {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'delivery', delivery_address: DELIVERY_ADDRESS, items: [{ product_id: 'product-1', quantity: 1 }] },
    });
    assert.equal(created.status, 201, 'the delivery order is accepted');

    const { cloudSync } = require('../main/services/cloud-sync');
    cloudSync.recordOrderChanged(created.data.order.id);

    const row = await waitForOutboxRow(db);
    assert.ok(row, 'cloud sync queued an order snapshot');
    const payload = JSON.parse(row.payload);

    assert.ok(!('delivery_address' in payload), 'the delivery address must not be in the payload that leaves the machine');
    assert.ok(
      !JSON.stringify(payload).includes('Anecacuilco'),
      'nor any fragment of the address, wherever in the snapshot it would otherwise sit',
    );
    // The row is still a real order snapshot: this is a redaction, not a snapshot
    // that silently stopped being built.
    assert.ok(payload.order_number, 'the snapshot is otherwise intact');
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery exception: the override is a persisted setting beside the receipt toggle', async () => {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const { baseUrl, server } = await startServer(testApp());
  try {
    const business = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
    assert.equal(business.status, 200, 'the business settings are readable');
    assert.equal(
      business.data.bill_delivery_show_customer_phone_always,
      true,
      'a fresh install ships the delivery exception on',
    );

    // The batch route validates every accepted key, so the payload is complete
    // rather than partial. A partial payload is rejected for an unrelated key
    const saved = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: owner.authHeader,
      // Every accepted key, because the batch route is all-or-nothing: a
      // partial payload is rejected for whichever key it omits, which would mask
      body: {
        printer_trim_decimals: true,
        bill_show_name: true,
        bill_show_address: true,
        bill_show_phone: true,
        bill_show_tax_id: false,
        bill_show_tax_breakdown: true,
        bill_show_customer_name: true,
        bill_show_customer_phone: false,
        bill_show_table_number: true,
        bill_delivery_show_customer_phone_always: false,
        bill_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        kot_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        z_report_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        cash_drawer_pulse_enabled: true,
        cash_drawer_pulse_methods: ['cash', 'card'],
      },
    });
    assert.equal(saved.status, 200, 'the printing batch accepts the override');
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key = 'bill_delivery_show_customer_phone_always'").get().value,
      'false',
      'the override persists through the same batch route as the receipt toggles',
    );
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key = 'bill_show_customer_phone'").get().value,
      'false',
      'and the receipt toggle beside it is unaffected',
    );

    // The round trip, not just the write. A setting that is accepted and then
    // quietly dropped is a different bug from one that is refused, and only a
    const readBack = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
    assert.equal(readBack.status, 200, 'the settings can be read back after the save');
    assert.equal(
      readBack.data.bill_delivery_show_customer_phone_always,
      false,
      'a save followed by a read returns what was saved, so the switch is live and not inert',
    );
    assert.equal(readBack.data.bill_show_customer_phone, false, 'and the receipt toggle round-trips beside it');

    // And it survives a restart, because the merchant's choice is persisted.
    const reopened = initTestDb();
    assert.equal(
      reopened.prepare("SELECT value FROM settings WHERE key = 'bill_delivery_show_customer_phone_always'").get().value,
      'false',
      'the override is durable, not session state',
    );
    closeDatabase();
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery exception: the settings page sends the override on save, not only on load', () => {
  // Hydration and saving are separate code paths. A key wired into the read but
  // not the write hydrates the switch and then does nothing when it is flipped,
  const page = fs.readFileSync(path.join(__dirname, '../frontend/src/app/(dashboard)/settings/page.tsx'), 'utf8');
  // Take the whole handler body by brace depth, not to the next `const`: the
  // body opens several `const` declarations of its own.
  const saveStart = page.indexOf('const savePrinting');
  assert.ok(saveStart > 0, 'the printing save handler exists');
  const open = page.indexOf('{', saveStart);
  let depth = 0;
  let close = open;
  for (; close < page.length; close += 1) {
    if (page[close] === '{') depth += 1;
    else if (page[close] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const saveBody = page.slice(saveStart, close);
  assert.ok(
    /bill_delivery_show_customer_phone_always: formSnapshot\.billDeliveryShowCustomerPhoneAlways/.test(saveBody),
    'the save payload carries the override',
  );
  assert.ok(
    /setBillDeliveryShowCustomerPhoneAlways\(formSnapshot\.billDeliveryShowCustomerPhoneAlways\)/.test(saveBody),
    'and the POS store is updated from the saved value, not only on load',
  );
  // The load path must have it too, or the switch starts from the wrong value.
  assert.ok(
    /d\.bill_delivery_show_customer_phone_always !== false/.test(page),
    'hydration reads the override back',
  );
});

test('delivery exception: the Settings panel states the consequence next to the toggle', () => {
  // Placement and copy, at the only level available without a DOM harness: the
  // panel must carry all three strings, and the warning must sit in the same
  const panel = fs.readFileSync(path.join(__dirname, '../frontend/src/components/settings/PrintersSettingsTab.tsx'), 'utf8');

  assert.ok(panel.includes('deliveryCustomerPhoneWarning'), 'the panel states what delivery orders and slips will do');
  assert.ok(panel.includes('deliveryShowCustomerPhoneAlways'), 'the override is discoverable in the same panel');
  assert.ok(panel.includes('deliveryShowCustomerPhoneAlwaysHint'), 'and its delivery-only scope is stated on its own row');

  const toggleAt = panel.indexOf("key: 'billShowCustomerPhone'");
  const warningAt = panel.indexOf('deliveryCustomerPhoneWarning');
  const overrideAt = panel.indexOf('billDeliveryShowCustomerPhoneAlways}');
  assert.ok(toggleAt > 0, 'the Customer Number toggle is present');
  assert.ok(warningAt > toggleAt, 'the warning follows the toggle it contradicts');
  assert.ok(overrideAt > warningAt, 'the override sits with the warning, not elsewhere on the page');
  // The warning must land inside the same bill-content block as the toggle, so a
  // merchant reading down that column meets it. The block ends at its closing
  const listAt = panel.lastIndexOf('billContentHint', toggleAt);
  assert.ok(listAt > 0, 'the bill-content block is identifiable');
  const blockEnd = panel.indexOf('</div>', warningAt);
  assert.ok(
    blockEnd > 0 && panel.slice(listAt, blockEnd).includes('deliveryCustomerPhoneWarning'),
    'the warning is rendered inside the bill-content block, beside the toggle',
  );
});

test('delivery exception: the warning and override copy exist in every locale', () => {
  const dir = path.join(__dirname, '../frontend/src/lib/i18n/messages');
  const keys = ['deliveryCustomerPhoneWarning', 'deliveryShowCustomerPhoneAlways', 'deliveryShowCustomerPhoneAlwaysHint'];
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 24, `expected the full locale set, found ${files.length} files`);
  for (const name of files) {
    const messages = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const key of keys) {
      const value = messages.settings?.[key];
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `${name}: settings.${key} is missing, so the merchant reads an untranslated warning`,
      );
    }
  }
});
