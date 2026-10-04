/**
 * Product variants schema foundation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-variants-db.test.ts
 *
 * Migration v99 adds the product_variants table plus the two dormant-column
 * hooks the catalog relies on. It is proven twice: on a fresh install, and by
 * rewinding a populated database to the pre-v99 shape and replaying the
 * migration, which is the only way to show a pre-existing store keeps its
 * products and orders.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-variants-db-'));

Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const assert = require('node:assert/strict');
const { initDatabase, getDatabase, closeDatabase, now, MIGRATIONS, getCurrentSchemaVersion, buildIdealSchemaDb } = require('../main/db');

const LATEST_VERSION = 99;

function columnsOf(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
}

function main() {
  console.log('Product Variants Schema Test');
  console.log('='.repeat(60));

  initDatabase();
  const db = getDatabase();

  // ── The migration is registered and applied on a fresh install ──────────
  const variantsMigration = MIGRATIONS.find((migration: any) => migration.version === LATEST_VERSION);
  assert.ok(variantsMigration, 'the product variants migration is registered');
  assert.equal(variantsMigration.name, 'add_product_variants_table', 'the migration is named add_product_variants_table');
  const tailVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
  assert.ok(tailVersion >= LATEST_VERSION, 'the product variants migration is not orphaned behind the registry tail');
  assert.equal(getCurrentSchemaVersion(), tailVersion, 'a fresh install reaches the last registry version');

  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_variants'").get(),
    'product_variants exists on a fresh install',
  );
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_product_variants_product'").get(),
    'idx_product_variants_product exists on a fresh install',
  );
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_product_variants_barcode'").get(),
    'idx_product_variants_barcode exists on a fresh install',
  );
  assert.ok(columnsOf(db, 'order_items').includes('variant_id'), 'order_items.variant_id exists on a fresh install');
  assert.ok(columnsOf(db, 'products').includes('dietary_tags'), 'products.dietary_tags exists on a fresh install');
  console.log('   ✓ a fresh install carries the table, both indexes, and both new columns');

  // A fresh install and the in-memory ideal schema are built by the same
  // pipeline, so a shape difference here means one of them drifted.
  const idealDb = buildIdealSchemaDb();
  const idealDdl = (idealDb.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'product_variants'",
  ).get() as { sql: string }).sql;
  idealDb.close();
  const liveDdl = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'product_variants'",
  ).get() as { sql: string }).sql;
  assert.equal(liveDdl, idealDdl, 'product_variants DDL matches the ideal schema');
  assert.match(
    liveDdl,
    /FOREIGN KEY \(product_id\) REFERENCES products\(id\) ON DELETE CASCADE/,
    'product_variants cascades from products on delete',
  );
  console.log('   ✓ the table definition matches the ideal schema, including the cascade foreign key');

  // ── A populated pre-v99 database upgrades cleanly ──────────────────────
  const stamp = now();
  db.prepare(`INSERT INTO categories (id, name, is_active, created_at, updated_at) VALUES ('cat', 'Coffee', 1, ?, ?)`)
    .run(stamp, stamp);
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, stock_quantity, is_active, created_at, updated_at)
    VALUES ('latte', 'cat', 'Latte', 250, 75, 12, 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@example.com', 'hash', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO orders (order_number, user_id, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-1', 'owner', 'completed', 500, 500, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
    VALUES (1, 'latte', 'Latte', 250, 2, 500, 500, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO product_variants (id, product_id, name, price, stock_quantity, is_active, created_at, updated_at)
    VALUES ('var-small', 'latte', 'Small', 200, 4, 1, ?, ?)`).run(stamp, stamp);

  // Rewind to the shape a pre-v99 store has: no table, no columns.
  db.pragma(`user_version = ${LATEST_VERSION - 1}`);
  db.exec('DROP TABLE product_variants');
  db.exec('ALTER TABLE order_items DROP COLUMN variant_id');
  db.exec('ALTER TABLE products DROP COLUMN dietary_tags');
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_variants'").get(),
    undefined,
    'the rewound database has no product_variants table',
  );
  assert.ok(!columnsOf(db, 'order_items').includes('variant_id'), 'the rewound database has no order_items.variant_id');
  assert.ok(!columnsOf(db, 'products').includes('dietary_tags'), 'the rewound database has no products.dietary_tags');

  MIGRATIONS.find((migration: any) => migration.version === LATEST_VERSION).up();

  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_variants'").get(),
    'the migration recreates product_variants on an upgraded database',
  );
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_product_variants_product'").get(),
    'the migration recreates the product index on an upgraded database',
  );
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_product_variants_barcode'").get(),
    'the migration recreates the barcode index on an upgraded database',
  );
  assert.ok(columnsOf(db, 'order_items').includes('variant_id'), 'the migration adds order_items.variant_id');
  assert.ok(columnsOf(db, 'products').includes('dietary_tags'), 'the migration adds products.dietary_tags');
  console.log('   ✓ replaying the migration on a pre-v99 store restores the table, indexes, and columns');

  assert.deepEqual(
    db.prepare('SELECT id, name, price, cost, stock_quantity FROM products').all(),
    [{ id: 'latte', name: 'Latte', price: 250, cost: 75, stock_quantity: 12 }],
    'existing products survive the upgrade untouched',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count, 1,
    'existing orders survive the upgrade',
  );
  assert.deepEqual(
    db.prepare('SELECT product_id, product_name, unit_price, quantity, total FROM order_items').all(),
    [{ product_id: 'latte', product_name: 'Latte', unit_price: 250, quantity: 2, total: 500 }],
    'existing order items survive the upgrade',
  );
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'the upgraded schema has no foreign-key violations');
  console.log('   ✓ the upgrade loses no existing products, orders, or order items');

  // ── New columns default to NULL and the migration is re-runnable ────────
  db.prepare(
    `INSERT INTO products (id, name, price, created_at, updated_at) VALUES ('tea', 'Tea', 100, ?, ?)`,
  ).run(stamp, stamp);
  assert.equal(
    db.prepare('SELECT dietary_tags FROM products WHERE id = ?').get('tea').dietary_tags, null,
    'products.dietary_tags defaults to NULL',
  );
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
    VALUES (1, ?, ?, 100, 1, 100, 100, ?, ?)`).run('tea', 'Tea', stamp, stamp);
  assert.equal(
    db.prepare('SELECT variant_id FROM order_items WHERE product_id = ?').get('tea').variant_id, null,
    'order_items.variant_id defaults to NULL for existing order lines',
  );

  const variantUpsert = MIGRATIONS.find((migration: any) => migration.version === LATEST_VERSION).up;
  variantUpsert();
  variantUpsert();
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_product_variants_barcode'`).get() as { count: number }).count,
    1,
    'replaying the migration does not duplicate the barcode index',
  );
  console.log('   ✓ both new columns default to NULL and the migration is safe to replay');

  // ── Cascade deletes, and the dormant variant_selection column is reused ──
  db.prepare(`INSERT INTO products (id, name, price, created_at, updated_at) VALUES ('pizza', 'Pizza', 500, ?, ?)`)
    .run(stamp, stamp);
  db.prepare(`INSERT INTO product_variants (id, product_id, name, price, created_at, updated_at)
    VALUES ('var-large', 'pizza', 'Large', 700, ?, ?)`).run(stamp, stamp);
  db.prepare(`DELETE FROM products WHERE id = 'pizza'`).run();
  assert.equal(
    db.prepare('SELECT 1 FROM product_variants WHERE id = ?').get('var-large'), undefined,
    'deleting a product removes its variants through the cascade',
  );

  assert.ok(
    columnsOf(db, 'order_items').includes('variant_selection'),
    'the pre-existing order_items.variant_selection snapshot column is still present',
  );
  assert.ok(
    columnsOf(db, 'order_items').filter((column) => column.startsWith('variant_')).length === 2,
    'exactly one identity column (variant_id) and one snapshot column (variant_selection) exist',
  );
  console.log('   ✓ variants cascade with their product and the dormant variant_selection column is reused');

  console.log('\n✅ Product variants schema tests passed');
}

try {
  main();
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
} catch (error) {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
}
