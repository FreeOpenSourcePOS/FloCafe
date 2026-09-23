const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-currency-reset-'));

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments);
};

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now, getCurrencyResetImpact, resetDatabaseForCurrencyChange } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');

async function main() {
  initDatabase();
  const db = getDatabase();
  const stamp = now();
  const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  setting.run('country', 'IN', stamp);
  setting.run('currency', 'INR', stamp);
  setting.run('timezone', 'Asia/Kolkata', stamp);

  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@example.com', 'hash', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO categories (id, name, is_active, created_at, updated_at)
    VALUES ('cat', 'Coffee', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO products (
      id, category_id, name, price, cost, stock_quantity, tax_type, tax_rate,
      tax_category_id, tax_behavior, cb_percent, is_active, created_at, updated_at
    ) VALUES ('latte', 'cat', 'Latte', 250, 75, 12, 'exclusive', 18, 'food', 'exclusive', 5, 1, ?, ?)`)
    .run(stamp, stamp);
  db.prepare(`INSERT INTO addon_groups (id, name, is_active, created_at, updated_at)
    VALUES ('milk', 'Milk', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO addons (
      id, addon_group_id, name, price, tax_category_id, tax_behavior,
      inherit_parent_tax_category, is_active, created_at, updated_at
    ) VALUES ('oat', 'milk', 'Oat milk', 40, 'food', 'exclusive', 0, 1, ?, ?)`)
    .run(stamp, stamp);
  db.prepare("INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('latte', 'milk')").run();
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO products (
      id, category_id, name, price, cost, stock_quantity, inventory_product_id,
      tax_type, tax_rate, tax_behavior, is_active, created_at, updated_at
    ) VALUES ('orphan-product', 'missing-category', 'Orphan', 99, 20, 3, 'missing-product',
      'exclusive', 5, 'exclusive', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
    VALUES ('orphan-addon', 'missing-group', 'Orphan add-on', 10, 1, ?, ?)`).run(stamp, stamp);
  db.prepare("INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('missing-product', 'milk')").run();
  db.prepare("INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('latte', 'missing-group')").run();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO customers (id, name, is_active, created_at, updated_at)
    VALUES ('customer', 'Customer', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO orders (order_number, user_id, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-1', 'owner', 'completed', 250, 250, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, payment_status, created_at, updated_at)
    VALUES ('INV-1', 1, 250, 250, 250, 'paid', ?, ?)`).run(stamp, stamp);

  const impact = getCurrencyResetImpact(db);
  assert.equal(impact.currentCurrency, 'INR');
  assert.equal(impact.invoices, 1);
  assert.equal(impact.orders, 1);
  assert.equal(impact.products, 2);

  const result = await resetDatabaseForCurrencyChange('USD', 'INR');
  assert.equal(fs.existsSync(result.backupPath), true, 'a recovery backup is created before reset');

  const fresh = getDatabase();
  const count = (table: string) => (fresh.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  assert.equal(count('users'), 0, 'staff accounts are erased');
  assert.equal(count('orders'), 0, 'orders are erased');
  assert.equal(count('bills'), 0, 'invoices are erased');
  assert.equal(count('customers'), 0, 'customers are erased');
  assert.equal(count('categories'), 1, 'categories are preserved');
  assert.equal(count('products'), 2, 'products are preserved');
  assert.equal(count('addon_groups'), 1, 'add-on groups are preserved');
  assert.equal(count('addons'), 1, 'add-ons are preserved');
  assert.equal(count('addon_group_product'), 1, 'menu relationships are preserved');
  assert.deepEqual(
    fresh.prepare("SELECT category_id, inventory_product_id FROM products WHERE id = 'orphan-product'").get(),
    { category_id: null, inventory_product_id: null },
    'orphaned product references are cleared',
  );
  assert.equal(fresh.prepare("SELECT id FROM addons WHERE id = 'orphan-addon'").get(), undefined, 'add-ons with missing groups are omitted');

  const product = fresh.prepare(`SELECT price, cost, stock_quantity, tax_type, tax_rate,
    tax_category_id, tax_behavior, cb_percent FROM products WHERE id = 'latte'`).get();
  assert.deepEqual(product, {
    price: 0, cost: 0, stock_quantity: 0, tax_type: 'none', tax_rate: 0,
    tax_category_id: null, tax_behavior: 'country_default', cb_percent: 0,
  });
  const addon = fresh.prepare("SELECT price, tax_category_id, tax_behavior, inherit_parent_tax_category FROM addons WHERE id = 'oat'").get();
  assert.deepEqual(addon, {
    price: 0, tax_category_id: null, tax_behavior: 'country_default', inherit_parent_tax_category: 1,
  });

  const regional = Object.fromEntries(
    (fresh.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency', 'timezone')").all() as { key: string; value: string }[])
      .map((row) => [row.key, row.value]),
  );
  assert.deepEqual(regional, { country: 'IN', currency: 'USD', timezone: 'Asia/Kolkata' });
  const pending = fresh.prepare("SELECT value FROM _flo_meta WHERE key = 'currency_reset_pending'").get() as { value: string };
  assert.deepEqual(JSON.parse(pending.value), regional);
  assert.deepEqual(fresh.pragma('foreign_key_check'), []);

  await assert.rejects(
    resetDatabaseForCurrencyChange('EUR', 'INR'),
    (error: { code?: string }) => error.code === 'ERR_CURRENCY_CHANGED',
    'a stale expected currency is rejected inside the maintenance lock',
  );
  assert.equal(fresh.prepare("SELECT value FROM settings WHERE key = 'currency'").get().value, 'USD');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const setup = await request(app).post('/api/auth/setup/initialize').send({
    name: 'New Owner',
    email: 'new-owner@example.com',
    password: 'TestPass123',
    business_type: 'restaurant',
    business_name: 'Reset Cafe',
    setup_profile: 'demo',
    service_model: 'qsr',
    terms_accepted: true,
    owner_approval_pin: '2468',
    owner_approval_pin_confirmation: '2468',
    country: 'IN',
    currency: 'USD',
    timezone: 'Asia/Kolkata',
  });
  assert.equal(setup.status, 200, `post-reset setup succeeds: ${JSON.stringify(setup.body)}`);
  assert.equal(count('products'), 2, 'post-reset setup skips demo menu seeding');
  assert.equal(fresh.prepare("SELECT value FROM _flo_meta WHERE key = 'currency_reset_pending'").get(), undefined, 'setup clears the pending reset marker');

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('Currency reset preservation checks passed');
}

main().catch((error: unknown) => {
  console.error(error);
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
