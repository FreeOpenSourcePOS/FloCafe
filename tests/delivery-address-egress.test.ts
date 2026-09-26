/**
 * Order-level delivery address persistence and egress contract (#830 S4, #694).
 *
 * Three things this suite holds, and the middle one is the one that matters:
 *
 *   1. `orders.delivery_address` exists, is written from the order payload, is
 *      capped at the boundary, and is not written for a non-delivery order.
 *   2. **It never leaves the machine.** The cloud-sync order snapshot is a
 *      `SELECT *` spread, so a new free-text address column leaves the shop
 *      unless it is named in the strip list. `cloud_sync_enabled` ships ON, so
 *      getting this wrong is a customer-data incident, not a code smell. This
 *      test reads the actual outbox row that would be transmitted.
 *   3. The merchant's delivery customer-number override is a real, persisted
 *      setting beside `bill_show_customer_phone`, writable through the same
 *      batch route, and the Settings panel states what it does.
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

import express from 'express';
import jwt from 'jsonwebtoken';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-delivery-address-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, startServer, api, seedOwnerUser, seedCategory, seedProduct,
  assertEqual, closeDatabase, getDatabase,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { settingsRoutes } = require('../main/routes/settings');
const { getJWTSecret } = require('../main/routes/auth');

const DELIVERY_ADDRESS = 'Flat 4B, 123A-Anecacuilco 04330, Colonia Naucalpan';
const OVER_CAP_ADDRESS = 'x'.repeat(400);

function testApp(): any {
  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try { req.user = jwt.verify(header.slice(7), getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/orders', orderRoutes);
  app.use('/api/settings', settingsRoutes);
  return app;
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
    assertEqual(created.status, 200, 'the delivery order is accepted');
    assertEqual(
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
    assertEqual(created.status, 200, 'the order is accepted');
    assertEqual(
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
    assertEqual(rejected.status, 400, 'an address past the cap is refused, not stored and not printed');
    assert.match(String(rejected.data.error), /Delivery address exceed maximum length/);
    assertEqual(
      db.prepare("SELECT COUNT(*) AS c FROM orders WHERE delivery_address IS NOT NULL AND delivery_address != ''").get().c,
      0,
      'nothing over-long was persisted',
    );

    const wrongType = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'delivery', delivery_address: { not: 'a string' }, items: [{ product_id: 'product-1', quantity: 1 }] },
    });
    assertEqual(wrongType.status, 400, 'a non-string address is refused');
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery address: it never reaches the cloud sync outbox', async () => {
  // The egress guard. The outbox row IS what leaves the machine: cloud sync ships
  // enabled by default, and the snapshot is built from `SELECT * FROM orders`, so
  // this only holds while the strip list names the column.
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
    assertEqual(created.status, 200, 'the delivery order is accepted');

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
    assertEqual(business.status, 200, 'the business settings are readable');
    assertEqual(
      business.data.bill_delivery_show_customer_phone_always,
      true,
      'a fresh install ships the delivery exception on',
    );

    const saved = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        printer_trim_decimals: true,
        bill_show_customer_phone: false,
        bill_delivery_show_customer_phone_always: false,
      },
    });
    assertEqual(saved.status, 200, 'the printing batch accepts the override');
    assertEqual(
      db.prepare("SELECT value FROM settings WHERE key = 'bill_delivery_show_customer_phone_always'").get().value,
      'false',
      'the override persists through the same batch route as the receipt toggles',
    );
    assertEqual(
      db.prepare("SELECT value FROM settings WHERE key = 'bill_show_customer_phone'").get().value,
      'false',
      'and the receipt toggle beside it is unaffected',
    );
  } finally {
    server.close();
    closeDatabase();
  }
});

test('delivery exception: the Settings panel states the consequence next to the toggle', () => {
  // Placement and copy, at the only level available without a DOM harness: the
  // panel must carry all three strings, and the warning must sit in the same
  // block as the Customer Number toggle and its override, not somewhere else in
  // the page where a merchant turning the toggle off would never see it.
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
  // div, which is what the override and warning sit inside.
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
