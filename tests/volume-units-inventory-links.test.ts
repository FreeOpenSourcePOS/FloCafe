/**
 * Volume sale units (ml/cl/l/fl oz/oz), fractional quantity validation,
 * and 1-to-1 inventory-link deduction/restore coverage.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/volume-units-inventory-links.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-volume-units-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase, now,
} = require('../main/db');
const {
  createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api,
  assertEqual, assert, getResults, resetCounters,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { registerRoutes } = require('../main/routes/index');
const { resolveInventoryDeduction } = require('../main/services/inventory');
const { validateProductQuantity } = require('../main/routes/orders-validation');

function tableColumns(db: any, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column: any) => column.name);
}

function signedToken(userId: string, role: string): Record<string, string> {
  const token = jwt.sign({ userId, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

function stockOf(db: any, productId: string): number {
  const row = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId) as { stock_quantity: number } | undefined;
  return row ? row.stock_quantity : NaN;
}

async function main() {
  resetCounters();

  console.log('─── Schema: fresh install has volume units + link columns ───');
  {
    initDatabase();
    const db = getDatabase();
    const productColumns = tableColumns(db, 'products');
    assert(productColumns.includes('inventory_product_id'), 'products has inventory_product_id');
    assert(productColumns.includes('inventory_deduction_quantity'), 'products has inventory_deduction_quantity');
    const itemColumns = tableColumns(db, 'order_items');
    assert(itemColumns.includes('inventory_product_id'), 'order_items has inventory_product_id');
    const saleUnitSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'",
    ).get() as { sql: string }).sql;
    assert(/sale_unit[^)]*'ml'/.test(saleUnitSql), 'sale_unit CHECK accepts ml');
    assert(/sale_unit[^)]*'fl oz'/.test(saleUnitSql), 'sale_unit CHECK accepts fl oz');
    closeDatabase();
    fs.rmSync(activeTestDir, { recursive: true, force: true });
  }

  console.log('─── Schema: upgrade from v86 adds columns and widens sale_unit ───');
  {
    const originalMigrations = MIGRATIONS.slice();
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-volume-units-upgrade-'));
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 86));
    initDatabase();
    const db = getDatabase();
    assertEqual(getCurrentSchemaVersion(), 86, 'upgrade fixture starts at schema v86');
    // createSchema builds the final shape; strip the v87 columns to simulate a legacy store.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('ALTER TABLE products DROP COLUMN inventory_product_id');
    db.exec('ALTER TABLE products DROP COLUMN inventory_deduction_quantity');
    db.exec('ALTER TABLE order_items DROP COLUMN inventory_product_id');
    db.exec('PRAGMA foreign_keys = ON');
    assert(!tableColumns(db, 'products').includes('inventory_product_id'), 'v86 products lacks inventory_product_id');
    assert(!tableColumns(db, 'order_items').includes('inventory_product_id'), 'v86 order_items lacks inventory_product_id');

    db.prepare(`
      INSERT INTO products (id, name, price, sale_unit, track_inventory, stock_quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run('legacy-volume', 'Legacy Volume', 10, 'kg', 5, now(), now());

    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations);
    db.transaction(() => {
      const migration = MIGRATIONS.find((m: any) => m.version === 87);
      migration.up();
      db.pragma('user_version = 87');
    })();

    const productColumns = tableColumns(db, 'products');
    assert(productColumns.includes('inventory_product_id'), 'upgrade adds products.inventory_product_id');
    assert(productColumns.includes('inventory_deduction_quantity'), 'upgrade adds products.inventory_deduction_quantity');
    assert(tableColumns(db, 'order_items').includes('inventory_product_id'), 'upgrade adds order_items.inventory_product_id');
    const saleUnitSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'",
    ).get() as { sql: string }).sql;
    assert(/sale_unit[^)]*'ml'/.test(saleUnitSql), 'upgrade widens sale_unit CHECK');
    const legacy = db.prepare('SELECT sale_unit, stock_quantity FROM products WHERE id = ?').get('legacy-volume') as any;
    assertEqual(legacy.sale_unit, 'kg', 'existing product data survives the rebuild');
    assertEqual(legacy.stock_quantity, 5, 'existing stock survives the rebuild');
    closeDatabase();
    fs.rmSync(activeTestDir, { recursive: true, force: true });
  }

  console.log('─── Unit: validateProductQuantity with volume units ───');
  {
    const ml = { name: 'Latte', sale_unit: 'ml', allow_fractional_quantity: 1, weight_precision: 3 };
    try {
      validateProductQuantity(ml, 0.5);
      assert(true, '0.5 ml accepted at precision 3');
    } catch (err: any) {
      assert(false, `0.5 ml accepted at precision 3 — threw ${err.message}`);
    }
    try {
      validateProductQuantity(ml, 0.12345);
      assert(false, '0.12345 ml rejected at precision 3');
    } catch {
      assert(true, '0.12345 ml rejected at precision 3');
    }
    try {
      validateProductQuantity({ name: 'Each', sale_unit: 'each', allow_fractional_quantity: 0 }, 1.5);
      assert(false, 'fractional each rejected');
    } catch {
      assert(true, 'fractional each rejected');
    }
    try {
      validateProductQuantity({ name: 'NoFrac', sale_unit: 'ml', allow_fractional_quantity: 0 }, 1.5);
      assert(false, 'fractional quantity rejected when allow_fractional_quantity is off');
    } catch {
      assert(true, 'fractional quantity rejected when allow_fractional_quantity is off');
    }
    for (const unit of ['cl', 'l', 'fl oz', 'oz']) {
      try {
        validateProductQuantity({ name: unit, sale_unit: unit, allow_fractional_quantity: 1, weight_precision: 2 }, 1.25);
        assert(true, `fractional quantity accepted for sale_unit ${unit}`);
      } catch (err: any) {
        assert(false, `fractional quantity accepted for sale_unit ${unit} — threw ${err.message}`);
      }
    }
  }

  console.log('─── Unit: resolveInventoryDeduction precedence ───');
  {
    const linked = resolveInventoryDeduction(
      { id: 'latte', track_inventory: 1, inventory_product_id: 'milk', inventory_deduction_quantity: 0.25 },
      2,
    );
    assertEqual(linked && linked.productId, 'milk', 'link target wins over self track_inventory');
    assertEqual(linked && linked.deductedQuantity, 0.5, 'deduction is quantity x factor');

    const self = resolveInventoryDeduction({ id: 'bun', track_inventory: 1 }, 3);
    assertEqual(self && self.productId, 'bun', 'unlinked tracked product deducts itself');
    assertEqual(self && self.deductedQuantity, 3, 'unlinked deduction equals quantity');

    const untracked = resolveInventoryDeduction({ id: 'napkin', track_inventory: 0 }, 1);
    assertEqual(untracked, null, 'untracked unlinked product deducts nothing');

    const badFactor = resolveInventoryDeduction(
      { id: 'latte', track_inventory: 1, inventory_product_id: 'milk', inventory_deduction_quantity: 0 },
      1,
    );
    assertEqual(badFactor, null, 'non-positive link factor yields no deduction');
  }

  console.log('─── API: volume units accepted, invalid unit rejected ───');
  {
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-volume-units-api-'));
    initDatabase();
    const owner = seedOwnerUser(getDatabase());
    seedCategory(getDatabase(), 'cat-vol', 'Drinks');
    const app = createApp({});
    registerRoutes(app);
    const { baseUrl, server } = await startServer(app);
    try {
      const created = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { category_id: 'cat-vol', name: 'Cola', price: 40, sale_unit: 'ml', allow_fractional_quantity: true, weight_precision: 3 },
      });
      assertEqual(created.status, 201, `volume sale_unit product created (got ${created.status} ${JSON.stringify(created.data)})`);
      assertEqual(created.data.product.sale_unit, 'ml', 'ml sale unit persisted');

      const invalid = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { category_id: 'cat-vol', name: 'Bad', price: 10, sale_unit: 'gallon' },
      });
      assertEqual(invalid.status, 400, 'invalid sale_unit rejected with 400');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDatabase();
      fs.rmSync(activeTestDir, { recursive: true, force: true });
    }
  }

  console.log('─── API: inventory link validation ───');
  {
    const originalMigrations = MIGRATIONS.slice();
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-volume-units-links-'));
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations);
    initDatabase();
    const db = getDatabase();
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?) ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`).run(now());
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'Asia/Kolkata', ?) ON CONFLICT(key) DO UPDATE SET value='Asia/Kolkata', updated_at=excluded.updated_at`).run(now());
    const owner = seedOwnerUser(db);
    seedCategory(db, 'cat-link', 'Menu');
    seedProduct(db, 'milk-bottle', 'cat-link', 'Milk Bottle', 60, { track_inventory: true, stock_quantity: 10 });
    seedProduct(db, 'syrup-bottle', 'cat-link', 'Syrup Bottle', 80, { track_inventory: true, stock_quantity: 5 });

    const app = createApp({});
    registerRoutes(app);
    const { baseUrl, server } = await startServer(app);
    try {
      const latte = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { category_id: 'cat-link', name: 'Latte', price: 120 },
      });
      const latteId = latte.data.product.id;
      db.prepare('UPDATE products SET stock_quantity = 999 WHERE id = ?').run(latteId);

      const selfRef = await api(baseUrl, `/api/products/${latteId}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { inventory_product_id: latteId },
      });
      assertEqual(selfRef.status, 400, 'self-reference link rejected');

      const missing = await api(baseUrl, `/api/products/${latteId}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { inventory_product_id: 'no-such-product' },
      });
      assertEqual(missing.status, 400, 'missing target link rejected');

      const negativeQty = await api(baseUrl, `/api/products/${latteId}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { inventory_product_id: 'milk-bottle', inventory_deduction_quantity: -1 },
      });
      assertEqual(negativeQty.status, 400, 'non-positive deduction quantity rejected');

      const linked = await api(baseUrl, `/api/products/${latteId}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { inventory_product_id: 'milk-bottle', inventory_deduction_quantity: 0.25 },
      });
      assertEqual(linked.status, 200, `valid link accepted (got ${linked.status} ${JSON.stringify(linked.data)})`);
      assertEqual(linked.data.product.inventory_product_id, 'milk-bottle', 'link target persisted');
      assertEqual(linked.data.product.inventory_deduction_quantity, 0.25, 'link factor persisted');

      const exclusive = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { category_id: 'cat-link', name: 'Mocha', price: 130, inventory_product_id: 'milk-bottle' },
      });
      assertEqual(exclusive.status, 400, 'target already linked by another product rejected');

      const syrupLink = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { category_id: 'cat-link', name: 'Syrup Link', price: 10, inventory_product_id: 'syrup-bottle' },
      });
      assertEqual(syrupLink.status, 201, 'second independent link to a free target accepted');
      const chainTarget = await api(baseUrl, `/api/products/${syrupLink.data.product.id}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { inventory_product_id: 'milk-bottle' },
      });
      assertEqual(chainTarget.status, 400, 'relinking an already-targeted product rejected');

      const deleteTarget = await api(baseUrl, '/api/products/milk-bottle', {
        method: 'DELETE',
        headers: owner.authHeader,
      });
      assertEqual(deleteTarget.status, 409, 'deleting product targeted by active inventory link rejected with 409');

      console.log('\n─── API: linked deduction on order create + restore on cancel ───');
      const order = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { ...owner.authHeader, 'Idempotency-Key': 'vol-link-order-1' },
        body: { type: 'takeaway', items: [{ product_id: latteId, quantity: 2 }] },
      });
      assertEqual(order.status, 201, `order with linked product created (got ${order.status} ${JSON.stringify(order.data)})`);

      const milkStockAfterSale = stockOf(db, 'milk-bottle');
      assertEqual(milkStockAfterSale, 9.5, 'milk deducted by quantity x factor (2 x 0.25)');
      assertEqual(stockOf(db, latteId), 999, 'latte self stock untouched (no track_inventory)');

      const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(order.data.order.id) as any;
      assertEqual(item.inventory_product_id, 'milk-bottle', 'order item records inventory_product_id');
      assertEqual(item.inventory_deducted_quantity, 0.5, 'order item records deducted quantity');

      const movement = db.prepare(
        "SELECT * FROM inventory_movements WHERE product_id = 'milk-bottle' AND movement_type = 'sale' ORDER BY id DESC LIMIT 1",
      ).get() as any;
      assert(!!movement, 'sale movement appended for link target');
      assertEqual(movement && movement.quantity_delta, -0.5, 'sale movement deducts the linked quantity');

      const cancel = await api(baseUrl, `/api/orders/${order.data.order.id}/status`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { status: 'cancelled', reason: 'Test cancel' },
      });
      assertEqual(cancel.status, 200, `order cancelled (got ${cancel.status} ${JSON.stringify(cancel.data)})`);
      assertEqual(stockOf(db, 'milk-bottle'), 10, 'milk restored on order cancel via inventory_product_id');

      console.log('\n─── API: fractional order quantity for volume product ───');
      const cola = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { category_id: 'cat-link', name: 'Cola', price: 40, sale_unit: 'ml', allow_fractional_quantity: true, weight_precision: 3 },
      });
      assertEqual(cola.status, 201, 'ml fractional product created for order test');
      const colaId = cola.data.product.id;

      const fracOk = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { ...owner.authHeader, 'Idempotency-Key': 'vol-frac-ok' },
        body: { type: 'takeaway', items: [{ product_id: colaId, quantity: 0.5 }] },
      });
      assertEqual(fracOk.status, 201, '0.5 fractional quantity accepted for ml product');

      const fracBad = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: { ...owner.authHeader, 'Idempotency-Key': 'vol-frac-bad' },
        body: { type: 'takeaway', items: [{ product_id: colaId, quantity: 0.12345 }] },
      });
      assert(fracBad.status >= 400, `over-precision fractional quantity rejected (got ${fracBad.status})`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDatabase();
      fs.rmSync(activeTestDir, { recursive: true, force: true });
    }
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
