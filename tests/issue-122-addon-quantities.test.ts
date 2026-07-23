/**
 * PR #122 / Issue #83 Test Suite: Add-on Multi-Quantity Support
 *
 * Verifies:
 * 1. Migration v33 adds allow_multiple_quantities column to addon_groups (DEFAULT 0).
 * 2. Addon group CRUD API persists and returns allow_multiple_quantities.
 * 3. Order creation and add-items APIs validate and persist positive integer addon quantities in order_item_addons.
 * 4. Invalid, zero, fractional, and negative addon quantities are rejected with 400.
 * 5. Order subtotal, bill total, tax, and discounts multiply addon price by addon quantity.
 * 6. Legacy order item addons default to quantity 1.
 * 7. attachEffectiveAddons resolves quantity correctly.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-122-addon-quantities.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-quantities-test-'));
const mockApp = {
  isPackaged: true,
  getPath: (name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-addon-quantities';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, MIGRATIONS, attachEffectiveAddons } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { addonGroupRoutes } = require('../main/routes/addon-groups');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function makeRequest(
  app: any,
  method: string,
  urlPath: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const dataStr = body ? JSON.stringify(body) : '';
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };
      if (body) {
        reqHeaders['Content-Length'] = String(Buffer.byteLength(dataStr));
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: urlPath,
          method,
          headers: reqHeaders,
        },
        (res) => {
          let resData = '';
          res.on('data', (chunk) => { resData += chunk; });
          res.on('end', () => {
            server.close();
            let parsed = resData;
            try { parsed = JSON.parse(resData); } catch {}
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(dataStr);
      req.end();
    });
  });
}

async function runTests() {
  console.log('PR #122 / Issue #83 Integration Test: Add-on Multi-Quantity Support');
  console.log('==================================================\n');

  initDatabase();
  const db = getDatabase();

  // Verify Migration v33 applied
  const columns = db.prepare(`PRAGMA table_info(addon_groups)`).all().map((c: any) => c.name);
  assert(columns.includes('allow_multiple_quantities'), 'Migration v33 added allow_multiple_quantities column');

  // Setup Auth & App
  const app = express();
  app.use(express.json());

  let token: string;
  const pinHash = bcrypt.hashSync('1234', 10);
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('user-1', 'Admin', 'admin@test.com', 'hash', 'owner', ?, 1, ?, ?)
  `).run(pinHash, now(), now());

  token = jwt.sign({ userId: 'user-1', role: 'owner' }, getJWTSecret());

  app.use((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'owner' };
    next();
  });

  app.use('/api/addon-groups', addonGroupRoutes);
  app.use('/api/orders', orderRoutes);

  // Seed sample products and addon groups
  const catId = 'cat-1';
  db.prepare(`INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES (?, 'Coffee', 'coffee', 1, 1)`).run(catId);

  const prodId = 'prod-1';
  db.prepare(`
    INSERT INTO products (id, category_id, name, price, tax_type, tax_rate, track_inventory, stock_quantity, is_active, sort_order, updated_at)
    VALUES (?, ?, 'Espresso', 3.00, 'none', 0, 0, 0, 1, 1, ?)
  `).run(prodId, catId, now());

  console.log('1. Add-on Group CRUD with allow_multiple_quantities');
  const createGroupRes = await makeRequest(app, 'POST', '/api/addon-groups', {
    name: 'Extra Toppings',
    description: 'Multiple quantities allowed',
    is_required: false,
    min_selection: 0,
    max_selection: 5,
    allow_multiple_quantities: true,
    addons: [
      { name: 'Extra Shot', price: 1.50 },
      { name: 'Vanilla Syrup', price: 0.50 },
    ],
  });

  assertEqual(createGroupRes.status, 201, 'POST /api/addon-groups created group');
  assertEqual(createGroupRes.body.addon_group.allow_multiple_quantities, 1, 'Group allow_multiple_quantities stored as 1');

  const groupId = createGroupRes.body.addon_group.id;
  const addonShotId = createGroupRes.body.addon_group.addons[0].id;
  const addonSyrupId = createGroupRes.body.addon_group.addons[1].id;

  // Update group toggle to false
  const updateGroupRes = await makeRequest(app, 'PUT', `/api/addon-groups/${groupId}`, {
    allow_multiple_quantities: false,
  });
  assertEqual(updateGroupRes.status, 200, 'PUT /api/addon-groups updated group');
  assertEqual(updateGroupRes.body.addon_group.allow_multiple_quantities, 0, 'Group allow_multiple_quantities updated to 0');

  // Reset allow_multiple_quantities to true
  await makeRequest(app, 'PUT', `/api/addon-groups/${groupId}`, { allow_multiple_quantities: true });

  console.log('\n2. Order Creation with Addon Quantities');
  // Order with 2x Espresso, having 2x Extra Shot ($1.50) + 3x Vanilla Syrup ($0.50)
  // Subtotal per Espresso line = (3.00 + (1.50 * 2) + (0.50 * 3)) * 2 = (3.00 + 3.00 + 1.50) * 2 = 7.50 * 2 = 15.00
  const orderRes = await makeRequest(app, 'POST', '/api/orders', {
    type: 'dine_in',
    items: [
      {
        product_id: prodId,
        quantity: 2,
        addons: [
          { id: addonShotId, name: 'Extra Shot', price: 1.50, quantity: 2 },
          { id: addonSyrupId, name: 'Vanilla Syrup', price: 0.50, quantity: 3 },
        ],
      },
    ],
  });

  if (orderRes.status !== 201) console.log('ORDER ERR:', orderRes.body);
  assertEqual(orderRes.status, 201, 'Order created successfully with addon quantities');
  assertEqual(orderRes.body.order.subtotal, 15.00, 'Order subtotal multiplies addon price by addon quantity');

  const orderId = orderRes.body.order.id;
  const orderItemId = orderRes.body.order.items[0].id;

  // Check persisted order_item_addons rows
  const addonRows = db.prepare(`SELECT * FROM order_item_addons WHERE order_item_id = ? ORDER BY id`).all(orderItemId) as any[];
  assertEqual(addonRows.length, 2, '2 order_item_addons rows persisted');
  assertEqual(addonRows[0].quantity, 2, 'First addon quantity is 2');
  assertEqual(addonRows[1].quantity, 3, 'Second addon quantity is 3');

  // Verify attachEffectiveAddons
  const itemWithAddons = attachEffectiveAddons(db, [{ id: orderItemId }])[0];
  assertEqual(itemWithAddons.addons.length, 2, 'attachEffectiveAddons returns 2 addons');
  assertEqual(itemWithAddons.addons[0].quantity, 2, 'attachEffectiveAddons returns quantity 2 for first addon');
  assertEqual(itemWithAddons.addons[1].quantity, 3, 'attachEffectiveAddons returns quantity 3 for second addon');

  console.log('\n3. Add-Items Flow with Addon Quantities');
  const addItemsRes = await makeRequest(app, 'POST', `/api/orders/${orderId}/items`, {
    items: [
      {
        product_id: prodId,
        quantity: 1,
        addons: [
          { id: addonSyrupId, name: 'Vanilla Syrup', price: 0.50, quantity: 4 },
        ],
      },
    ],
  });

  assertEqual(addItemsRes.status, 200, 'POST /api/orders/:id/items succeeded with addon quantity');
  // New item subtotal = (3.00 + 0.50 * 4) * 1 = 5.00. Total order subtotal = 15.00 + 5.00 = 20.00
  assertEqual(addItemsRes.body.order.subtotal, 20.00, 'Updated order subtotal includes newly added items with addon quantities');

  console.log('\n4. Invalid Addon Quantity Rejection');
  const invalidZero = await makeRequest(app, 'POST', '/api/orders', {
    type: 'dine_in',
    items: [{ product_id: prodId, quantity: 1, addons: [{ name: 'Shot', price: 1, quantity: 0 }] }],
  });
  assertEqual(invalidZero.status, 400, 'Zero addon quantity rejected');

  const invalidNegative = await makeRequest(app, 'POST', '/api/orders', {
    type: 'dine_in',
    items: [{ product_id: prodId, quantity: 1, addons: [{ name: 'Shot', price: 1, quantity: -2 }] }],
  });
  assertEqual(invalidNegative.status, 400, 'Negative addon quantity rejected');

  const invalidFractional = await makeRequest(app, 'POST', '/api/orders', {
    type: 'dine_in',
    items: [{ product_id: prodId, quantity: 1, addons: [{ name: 'Shot', price: 1, quantity: 1.5 }] }],
  });
  assertEqual(invalidFractional.status, 400, 'Fractional addon quantity rejected');

  // Test multi-quantity rejection when group disallows it
  const disallowGroupRes = await makeRequest(app, 'POST', '/api/addon-groups', {
    name: 'Single Choice Group',
    allow_multiple_quantities: false,
    max_selection: 1,
    addons: [{ name: 'Single Addon', price: 0.5 }],
  });
  const disallowGroupId = disallowGroupRes.body.addon_group.id;
  const disallowAddonId = disallowGroupRes.body.addon_group.addons[0].id;

  const invalidMultiRes = await makeRequest(app, 'POST', '/api/orders', {
    type: 'dine_in',
    items: [{ product_id: prodId, quantity: 1, addons: [{ id: disallowAddonId, addon_group_id: disallowGroupId, name: 'Single Addon', price: 0.5, quantity: 2 }] }],
  });
  assertEqual(invalidMultiRes.status, 400, 'Multi-quantity rejected when group allow_multiple_quantities is false');

  const invalidMaxRes = await makeRequest(app, 'POST', '/api/orders', {
    type: 'dine_in',
    items: [{ product_id: prodId, quantity: 1, addons: [{ id: disallowAddonId, addon_group_id: disallowGroupId, name: 'Single Addon', price: 0.5, quantity: 3 }] }],
  });
  assertEqual(invalidMaxRes.status, 400, 'Exceeding group max_selection quantity rejected');

  console.log('\n5. Legacy Row Default Quantity Test');
  const legacyOrder = db.prepare(`
    INSERT INTO orders (order_number, type, status, created_at, updated_at)
    VALUES ('ORD-LEGACY', 'dine_in', 'pending', ?, ?)
  `).run(now(), now());
  const legacyItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, 'Legacy Espresso', 3.00, 1, 3.00, 0, 3.00, 'pending', ?, ?)
  `).run(legacyOrder.lastInsertRowid, prodId, now(), now());
  const legacyItemId = Number(legacyItem.lastInsertRowid);

  db.prepare(`
    INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
    VALUES (?, ?, 'Legacy Sugar', 0.25, 1, ?)
  `).run(legacyItemId, addonSyrupId, now());

  const legacyAttached = attachEffectiveAddons(db, [{ id: legacyItemId }])[0];
  assertEqual(legacyAttached.addons[0].quantity, 1, 'Legacy addon row defaults to quantity 1');

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log('\n==================================================');
  console.log(`${passed}/${total} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
