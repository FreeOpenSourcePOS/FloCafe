/**
 * Inventory movement ledger and history API coverage.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/inventory-ledger.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inventory-ledger-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase, now,
} = require('../main/db');
const {
  createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, api,
  assertEqual, assert, getResults, resetCounters,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { registerRoutes } = require('../main/routes/index');

function runPendingMigrations() {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

function tableColumns(db: any, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column: any) => column.name);
}

function signedToken(userId: string, role: string): Record<string, string> {
  const token = jwt.sign({ userId, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function closeTestServer(server: any): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
}

async function main() {
  resetCounters();
  const originalMigrations = MIGRATIONS.slice();
  const latestVersion = originalMigrations[originalMigrations.length - 1].version;
  const inventoryMigration = originalMigrations.find((migration: any) => migration.version === 85);

  // Fresh install schema.
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), latestVersion, 'fresh install reaches the latest schema');
  const columns = tableColumns(db, 'inventory_movements');
  assert(
    ['product_id', 'quantity_delta', 'movement_type', 'reference_type', 'reference_id', 'reason', 'actor_user_id', 'stock_after', 'created_at']
      .every((column) => columns.includes(column)),
    'fresh install creates the append-only inventory movement columns',
  );
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inventory_movements'")
    .all().map((row: any) => row.name);
  assert(indexes.includes('idx_inventory_movements_product_created'), 'fresh install creates the product/time movement index');
  assert(indexes.includes('idx_inventory_movements_reference'), 'fresh install creates the reference index');
  assert(indexes.includes('idx_inventory_movements_created'), 'fresh install creates the time movement index');
  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });

  // Upgrade and rollback-safe additive migration.
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inventory-ledger-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 84));
  initDatabase();
  db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), 84, 'upgrade fixture starts at schema v84');
  assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'").get(), 'upgrade fixture starts without the ledger table');
  db.prepare(`
    INSERT INTO users (id, name, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run('legacy-owner', 'Legacy Owner', 'hash', 'owner', now(), now());
  db.prepare(`
    INSERT INTO products (id, name, price, track_inventory, stock_quantity, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run('legacy-stock-product', 'Legacy Stock Product', 10, 10, now(), now());

  let rolledBack = false;
  try {
    db.transaction(() => {
      inventoryMigration.up();
      throw new Error('test rollback');
    })();
  } catch {
    rolledBack = true;
  }
  assert(rolledBack, 'failed additive migration is rolled back');
  assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'").get(), 'rolled-back migration leaves no partial ledger table');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), latestVersion, 'upgraded store reaches the latest schema');
  assert(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'").get(), 'upgraded store receives the ledger table');
  const migratedOpening = db.prepare(`
    SELECT quantity_delta, movement_type, reference_type, actor_user_id, stock_after
    FROM inventory_movements
    WHERE product_id = ?
  `).get('legacy-stock-product') as any;
  assertEqual(migratedOpening.quantity_delta, 10, 'upgrade backfill records the legacy stock quantity');
  assertEqual(migratedOpening.movement_type, 'adjustment', 'upgrade backfill uses an adjustment movement');
  assertEqual(migratedOpening.reference_type, 'opening_balance', 'upgrade backfill records an opening balance');
  assertEqual(migratedOpening.actor_user_id, 'legacy-owner', 'upgrade backfill attributes the opening balance');
  assertEqual(migratedOpening.stock_after, 10, 'upgrade backfill records the legacy cache as resulting stock');
  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });

  // Behavior and API authorization/filtering.
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inventory-ledger-behavior-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  initDatabase();
  db = getDatabase();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-ledger', 'Ledger Category');
  const cashierHeaders = signedToken('cashier-ledger', 'cashier');

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run('cashier-ledger', 'Ledger Cashier', 'cashier-ledger@test.local', 'x', 'cashier', now(), now());

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    const created = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        category_id: 'cat-ledger',
        name: 'Ledger Burger',
        price: 100,
        track_inventory: true,
        stock_quantity: 10,
        reason: 'Opening count',
      },
    });
    assertEqual(created.status, 201, 'product opening balance creates the product');
    const productId = created.data.product.id;
    let movements = db.prepare('SELECT * FROM inventory_movements WHERE product_id = ? ORDER BY id').all(productId) as any[];
    assertEqual(movements.length, 1, 'opening balance appends one movement');
    assertEqual(movements[0].quantity_delta, 10, 'opening balance stores the signed quantity');
    assertEqual(movements[0].movement_type, 'adjustment', 'opening balance uses the adjustment movement type');
    assertEqual(movements[0].reference_type, 'opening_balance', 'opening balance stores its reference type');
    assertEqual(movements[0].reason, 'Opening count', 'opening balance stores its reason');
    assertEqual(movements[0].actor_user_id, owner.userId, 'opening balance stores the authenticated actor');
    assertEqual(movements[0].stock_after, 10, 'opening balance stores resulting stock');

    const manualIncrease = await api(baseUrl, `/api/products/${productId}/stock`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { action: 'increase', quantity: 2, reason: 'Delivery received' },
    });
    assertEqual(manualIncrease.status, 200, 'reasoned manual increase succeeds');
    assertEqual(manualIncrease.data.product.stock_quantity, 12, 'manual increase updates the stock cache');

    const manualDecrease = await api(baseUrl, `/api/products/${productId}/stock`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { action: 'decrease', quantity: 2, reason: 'Count correction' },
    });
    assertEqual(manualDecrease.status, 200, 'reasoned manual decrease succeeds');
    assertEqual(manualDecrease.data.product.stock_quantity, 10, 'manual decrease updates the stock cache');

    const defaultReasonAdjustment = await api(baseUrl, `/api/products/${productId}/stock`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { action: 'increase', quantity: 1 },
    });
    assertEqual(defaultReasonAdjustment.status, 200, 'manual adjustment without a reason preserves the stock route');
    assertEqual(defaultReasonAdjustment.data.product.stock_quantity, 11, 'manual adjustment without a reason updates the cache');
    assertEqual(
      db.prepare('SELECT reason FROM inventory_movements WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(productId).reason,
      'Manual stock adjustment',
      'manual adjustment without a reason stores a default audit reason',
    );

    const failedDecrease = await api(baseUrl, `/api/products/${productId}/stock`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { action: 'decrease', quantity: 100, reason: 'Too much' },
    });
    assertEqual(failedDecrease.status, 400, 'insufficient manual decrease is rejected');
    assertEqual(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity, 11, 'failed manual decrease leaves the cache unchanged');

    const productUpdate = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { stock_quantity: 8, reason: 'Physical count' },
    });
    assertEqual(productUpdate.status, 200, 'absolute stock update succeeds');
    assertEqual(productUpdate.data.product.stock_quantity, 8, 'absolute stock update uses the cache as current state');
    const absoluteAdjustment = db.prepare('SELECT quantity_delta, movement_type, reason FROM inventory_movements WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(productId);
    assertEqual(absoluteAdjustment.quantity_delta, -3, 'absolute stock update appends the signed adjustment');
    assertEqual(absoluteAdjustment.movement_type, 'adjustment', 'absolute stock update uses the adjustment movement type');
    assertEqual(absoluteAdjustment.reason, 'Physical count', 'absolute stock update stores its reason');

    const firstOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { ...owner.authHeader, 'Idempotency-Key': 'ledger-sale-1' },
      body: { type: 'takeaway', items: [{ product_id: productId, quantity: 2 }] },
    });
    assertEqual(firstOrder.status, 201, 'order sale deducts stock');
    const replayOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { ...owner.authHeader, 'Idempotency-Key': 'ledger-sale-1' },
      body: { type: 'takeaway', items: [{ product_id: productId, quantity: 2 }] },
    });
    assertEqual(replayOrder.status, 200, 'idempotent order retry replays the original order');
    assertEqual(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity, 6, 'idempotent order retry does not double-deduct stock');

    const orderId = firstOrder.data.order.id;
    const added = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { items: [{ product_id: productId, quantity: 1 }] },
    });
    assertEqual(added.status, 200, 'adding an order item deducts stock');
    const addedItem = added.data.order.items.find((item: any) => item.product_id === productId && item.id !== firstOrder.data.order.items[0].id);

    const itemCancel = await api(baseUrl, `/api/orders/${orderId}/items/${addedItem.id}/cancel`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { reason: 'Customer removed item' },
    });
    assertEqual(itemCancel.status, 200, 'item cancellation restores stock');
    const itemRestore = await api(baseUrl, `/api/orders/${orderId}/items/${addedItem.id}/restore`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: {},
    });
    assertEqual(itemRestore.status, 200, 'item restore re-deducts stock');
    const repeatedRestore = await api(baseUrl, `/api/orders/${orderId}/items/${addedItem.id}/restore`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: {},
    });
    assertEqual(repeatedRestore.status, 200, 'repeated item restore is idempotent');

    const orderCancel = await api(baseUrl, `/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'cancelled', reason: 'Customer left' },
    });
    assertEqual(orderCancel.status, 200, 'whole-order cancellation restores remaining stock');
    const repeatedOrderCancel = await api(baseUrl, `/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'cancelled', reason: 'Retry' },
    });
    assertEqual(repeatedOrderCancel.status, 200, 'repeated whole-order cancellation is idempotent');
    assertEqual(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity, 8, 'all sale/restoration paths leave the expected cache');

    movements = db.prepare('SELECT * FROM inventory_movements WHERE product_id = ? ORDER BY id').all(productId) as any[];
    assertEqual(movements.filter((movement) => movement.movement_type === 'sale').length, 2, 'create and add-item sales both append movements');
    assertEqual(movements.filter((movement) => movement.movement_type === 'cancel_restore').length, 4, 'item cancel, item restore, and order cancellation append movements');
    assertEqual(movements[movements.length - 1].stock_after, 8, 'latest movement records resulting stock');

    const unauthorized = await api(baseUrl, '/api/inventory/movements', { headers: cashierHeaders });
    assertEqual(unauthorized.status, 403, 'cashier cannot read inventory history');
    const managerHistory = await api(baseUrl, '/api/inventory/movements?product_id=' + encodeURIComponent(productId) + '&movement_type=cancel_restore&per_page=2', {
      headers: manager.authHeader,
    });
    assertEqual(managerHistory.status, 200, 'manager can read inventory history');
    assertEqual(managerHistory.data.movements.length, 2, 'history applies movement type and page-size filters');
    assert(managerHistory.data.nextCursor > 0, 'history returns a stable next cursor');
    assert(managerHistory.data.movements[0].id > managerHistory.data.movements[1].id, 'history is ordered newest first with id tie-breaker');
    assertEqual(managerHistory.data.movements[0].actor_user_id, owner.userId, 'history includes the movement actor');

    const nextPage = await api(baseUrl, `/api/inventory/movements?product_id=${encodeURIComponent(productId)}&movement_type=cancel_restore&per_page=2&before_id=${managerHistory.data.nextCursor}`, {
      headers: manager.authHeader,
    });
    assertEqual(nextPage.status, 200, 'history cursor fetch succeeds');
    assert(nextPage.data.movements.every((movement: any) => movement.id < managerHistory.data.nextCursor), 'history cursor advances without overlap');
  } finally {
    await closeTestServer(server);
    fs.rmSync(activeTestDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
