/**
 * Add-on inventory schema, ledger, and currency-reset foundation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/addon-inventory-db.test.ts
 *
 * Migration v103 gives add-ons their own stock pool. The load-bearing part is
 * the ledger: inventory_movements now carries a third pool, and every read path
 * of the append-only ledger has to recognise it. A pool the validator does not
 * know fails quietly - the store simply can never restore its own backup again -
 * so this suite proves the add-on pool is carried through the selectable
 * columns, the history key, the chain keying, the replacement check, and the
 * currency reset that restarts the ledger empty.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-inventory-db-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase, getDatabase, closeDatabase, now, MIGRATIONS, getCurrentSchemaVersion,
  getInventoryMovementRows, validateInventoryLedgerDatabase, validateInventoryLedgerRows,
  validateInventoryLedgerReplacement, resetDatabaseForCurrencyChange, createBackup, restoreBackup,
} = require('../main/db');
const { adjustProductStock } = require('../main/services/inventory');
const {
  assertOrThrow, assertEqualOrThrow, getResults, resetCounters,
} = require('./helpers/test-setup');

const ADDON_INVENTORY_VERSION = 103;

function columnInfo(db: any, table: string, column: string): any {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).find((info) => info.name === column);
}

function columnsOf(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
}

function indexNames(db: any, table: string): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as { name: string }[])
    .map((row) => row.name);
}

function seedAddonPool(db: any, addonId: string, stock: number, actorId = 'owner'): void {
  const stamp = now();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, track_inventory, stock_quantity,
      low_stock_threshold, is_active, created_at, updated_at)
    VALUES (?, 'milk', ?, 40, 1, ?, 2, 1, ?, ?)`).run(addonId, addonId, stock, stamp, stamp);
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, addon_id, quantity_delta, movement_type,
      reference_type, reference_id, reason, actor_user_id, stock_after, created_at)
    VALUES (NULL, NULL, ?, ?, 'adjustment', 'opening_balance', ?, 'Opening count', ?, ?, ?)`)
    .run(addonId, stock, addonId, actorId, stock, stamp);
}

function seedMenu(db: any): void {
  const stamp = now();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@example.com', 'hash', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO categories (id, name, is_active, created_at, updated_at)
    VALUES ('cat', 'Coffee', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, stock_quantity, is_active, created_at, updated_at)
    VALUES ('latte', 'cat', 'Latte', 250, 75, 12, 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO products (id, category_id, name, price, stock_quantity, is_active, created_at, updated_at)
    VALUES ('tea', 'cat', 'Tea', 100, 0, 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO addon_groups (id, name, is_active, created_at, updated_at)
    VALUES ('milk', 'Milk', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, quantity_delta, movement_type,
      reference_type, reference_id, reason, actor_user_id, stock_after, created_at)
    VALUES ('latte', NULL, 12, 'adjustment', 'opening_balance', 'latte', 'Opening count', 'owner', 12, ?)`)
    .run(stamp);
}

async function closeStore(): Promise<void> {
  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-inventory-db-'));
}

function freshInstallAssertions(): void {
  const db = getDatabase();
  const migration = MIGRATIONS.find((entry: any) => entry.version === ADDON_INVENTORY_VERSION);
  assertOrThrow(!!migration, 'the add-on inventory migration is registered');
  assertEqualOrThrow(migration.name, 'add_addon_inventory', 'the migration is named add_addon_inventory');
  assertEqualOrThrow(
    getCurrentSchemaVersion(),
    MIGRATIONS[MIGRATIONS.length - 1].version,
    'a fresh install reaches the last registry version',
  );

  for (const column of ['track_inventory', 'stock_quantity', 'low_stock_threshold']) {
    assertOrThrow(
      columnsOf(db, 'addons').includes(column),
      `addons.${column} exists on a fresh install`,
    );
  }
  assertOrThrow(
    columnsOf(db, 'order_item_addons').includes('inventory_deducted_quantity'),
    'order_item_addons.inventory_deducted_quantity exists on a fresh install',
  );
  assertOrThrow(
    columnsOf(db, 'inventory_movements').includes('addon_id'),
    'inventory_movements.addon_id exists on a fresh install',
  );

  // An add-on pool has no owning product, so product_id must be nullable and
  // must keep its product foreign key for product and variant pools.
  const productId = columnInfo(db, 'inventory_movements', 'product_id');
  assertEqualOrThrow(productId.notnull, 0, 'inventory_movements.product_id accepts a pool with no product');
  const movementDdl = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'",
  ).get() as { sql: string }).sql;
  assertOrThrow(
    /product_id TEXT DEFAULT NULL REFERENCES products\(id\)/.test(movementDdl),
    'the rebuilt ledger still references products(id) from product_id',
  );
  for (const index of [
    'idx_inventory_movements_product_created',
    'idx_inventory_movements_reference',
    'idx_inventory_movements_created',
  ]) {
    assertOrThrow(indexNames(db, 'inventory_movements').includes(index), `the rebuilt ledger keeps ${index}`);
  }

  seedMenu(db);
  const stamp = now();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
    VALUES ('untracked', 'milk', 'Untracked add-on', 10, 1, ?, ?)`).run(stamp, stamp);
  const untracked = db.prepare('SELECT track_inventory, stock_quantity, low_stock_threshold FROM addons WHERE id = ?')
    .get('untracked');
  assertOrThrow(
    Number(untracked.track_inventory) === 0 && Number(untracked.stock_quantity) === 0 && Number(untracked.low_stock_threshold) === 0,
    'an add-on defaults to an untracked, zero-stock pool',
  );

  db.prepare(`INSERT INTO orders (order_number, user_id, status, subtotal, total, created_at, updated_at)
    VALUES ('ORD-1', 'owner', 'pending', 250, 250, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
    VALUES (1, 'latte', 'Latte', 250, 1, 250, 250, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
    VALUES (1, 'untracked', 'Untracked add-on', 10, 1, ?)`).run(stamp);
  assertEqualOrThrow(
    db.prepare('SELECT inventory_deducted_quantity FROM order_item_addons WHERE addon_id = ?').get('untracked').inventory_deducted_quantity,
    0,
    'an add-on line defaults to no deducted quantity',
  );
}

function inventoryServiceAssertions(): void {
  const db = getDatabase();
  seedAddonPool(db, 'oat', 5);
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    'a tracked add-on with an opening balance validates against the ledger',
  );

  const sold = adjustProductStock(db, {
    productId: null,
    addonId: 'oat',
    quantityDelta: -2,
    movementType: 'sale',
    referenceType: 'order_item',
    referenceId: 'oi-1',
    actorUserId: 'owner',
  });
  assertEqualOrThrow(sold.stockAfter, 3, 'an add-on sale reduces the add-on pool');
  const movement = db.prepare('SELECT * FROM inventory_movements WHERE addon_id = ? ORDER BY id DESC LIMIT 1').get('oat');
  assertEqualOrThrow(movement.product_id, null, 'an add-on movement carries no product id');
  assertEqualOrThrow(movement.variant_id, null, 'an add-on movement carries no variant id');
  assertEqualOrThrow(movement.actor_user_id, 'owner', 'an add-on movement is attributed to the authenticated actor');
  assertEqualOrThrow(movement.stock_after, 3, 'an add-on movement records the resulting add-on stock');
  assertEqualOrThrow(
    db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('latte').stock_quantity,
    12,
    'moving an add-on pool leaves the product pool untouched',
  );

  adjustProductStock(db, {
    productId: null,
    addonId: 'oat',
    quantityDelta: 2,
    movementType: 'cancel_restore',
    referenceType: 'order_item',
    referenceId: 'oi-1',
    actorUserId: 'owner',
  });
  assertEqualOrThrow(
    db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get('oat').stock_quantity,
    5,
    'a cancelled add-on line returns exactly what it deducted',
  );
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    'the restored add-on chain still validates',
  );

  let insufficient = '';
  try {
    adjustProductStock(db, {
      productId: null,
      addonId: 'oat',
      quantityDelta: -6,
      movementType: 'sale',
      actorUserId: 'owner',
    });
  } catch (error: any) {
    insufficient = error.message;
  }
  assertEqualOrThrow(insufficient, 'Insufficient stock', 'an add-on pool cannot be driven negative');
  assertEqualOrThrow(
    db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get('oat').stock_quantity,
    5,
    'the refused add-on sale left the pool unchanged',
  );

  let mixedPool = '';
  try {
    adjustProductStock(db, {
      productId: 'latte',
      variantId: 'variant-oat',
      addonId: 'oat',
      quantityDelta: -1,
      movementType: 'sale',
      actorUserId: 'owner',
    });
  } catch (error: any) {
    mixedPool = error.message;
  }
  assertOrThrow(
    mixedPool.includes('not both'),
    `a movement naming two pools is refused (got ${JSON.stringify(mixedPool)})`,
  );

  let unknownAddon = '';
  try {
    adjustProductStock(db, {
      productId: null,
      addonId: 'missing-addon',
      quantityDelta: -1,
      movementType: 'sale',
      actorUserId: 'owner',
    });
  } catch (error: any) {
    unknownAddon = error.message;
  }
  assertEqualOrThrow(unknownAddon, 'Add-on not found', 'an unknown add-on pool is a 404, not a silent write');
}

function ledgerValidatorAssertions(): void {
  const addons = [{ id: 'oat', stock_quantity: 5 }];
  const movements = [
    {
      id: 1, product_id: null, variant_id: null, addon_id: 'oat', quantity_delta: 5,
      movement_type: 'adjustment', reference_type: 'opening_balance', reference_id: 'oat',
      reason: 'Opening count', actor_user_id: 'owner', stock_after: 5, created_at: '2026-01-01 00:00:00',
    },
    {
      id: 2, product_id: null, variant_id: null, addon_id: 'oat', quantity_delta: -2,
      movement_type: 'sale', reference_type: 'order_item', reference_id: 'oi-1',
      reason: null, actor_user_id: 'owner', stock_after: 3, created_at: '2026-01-02 00:00:00',
    },
    {
      id: 3, product_id: null, variant_id: null, addon_id: 'oat', quantity_delta: 2,
      movement_type: 'cancel_restore', reference_type: 'order_item', reference_id: 'oi-1',
      reason: null, actor_user_id: 'owner', stock_after: 5, created_at: '2026-01-03 00:00:00',
    },
  ];

  assertEqualOrThrow(
    validateInventoryLedgerRows([], movements, [], addons),
    null,
    'the ledger accepts a consistent add-on chain',
  );
  // A product and an add-on may share an id: the chain key keeps their pools
  // apart, so an add-on chain is never compared against a product snapshot.
  assertEqualOrThrow(
    validateInventoryLedgerRows([{ id: 'oat', stock_quantity: 0 }], movements, [], addons),
    null,
    'an add-on chain is never compared against a product pool of the same id',
  );

  const brokenChain = movements.map((row) => (row.id === 3 ? { ...row, stock_after: 4 } : row));
  assertEqualOrThrow(
    validateInventoryLedgerRows([], brokenChain, [], addons),
    'Inventory movement history contains a broken stock chain',
    'the ledger refuses a broken add-on chain',
  );

  assertEqualOrThrow(
    validateInventoryLedgerRows([], movements.slice(1), [], addons),
    'Inventory movement history is missing an opening balance',
    'the ledger refuses an add-on chain with no opening balance',
  );

  assertEqualOrThrow(
    validateInventoryLedgerRows([], movements, [], [{ id: 'oat', stock_quantity: 4 }]),
    'Add-on stock does not match the latest inventory movement',
    'add-on stock with no matching history is refused',
  );

  assertEqualOrThrow(
    validateInventoryLedgerRows([], [{ ...movements[1], product_id: 'latte' }], [], addons),
    'Inventory movement history contains an invalid stock state',
    'a movement claiming both a product and an add-on pool is refused',
  );

  assertEqualOrThrow(
    validateInventoryLedgerRows([], [{ ...movements[1], addon_id: null }], [], addons),
    'Inventory movement history contains an invalid stock state',
    'a movement claiming no pool at all is refused',
  );

  // The append-only guarantee covers add-on pools too: a replacement that drops
  // or re-pools an add-on movement is refused even though its stock matches.
  const currentMovements = getInventoryMovements();
  const withoutAddOnHistory = currentMovements.filter((row: any) => row.addon_id !== 'oat');
  assertEqualOrThrow(
    validateInventoryLedgerReplacement(
      getProducts(),
      currentMovements,
      getProducts(),
      withoutAddOnHistory,
    ),
    'Inventory movement history cannot be erased by a replacement',
    'a replacement cannot erase add-on movement history',
  );
  assertEqualOrThrow(
    validateInventoryLedgerReplacement(
      getProducts(),
      currentMovements,
      getProducts(),
      currentMovements.map((row: any) => (row.addon_id === 'oat' ? { ...row, addon_id: null, product_id: 'latte' } : row)),
    ),
    'Inventory movement history cannot be erased by a replacement',
    'a replacement cannot re-pool add-on history onto the product pool',
  );
  assertEqualOrThrow(
    validateInventoryLedgerReplacement(getProducts(), currentMovements, getProducts(), currentMovements),
    null,
    'replacing a store with identical add-on history is allowed',
  );
}

function getProducts(): any[] {
  return getDatabase().prepare('SELECT id, stock_quantity FROM products').all();
}

function getInventoryMovements(): any[] {
  return getInventoryMovementRows(getDatabase());
}

function replaySafetyAssertions(): void {
  const db = getDatabase();
  const migration = MIGRATIONS.find((entry: any) => entry.version === ADDON_INVENTORY_VERSION);
  const beforeColumns = columnsOf(db, 'inventory_movements');
  const beforeRows = db.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count;
  const beforeIndexes = indexNames(db, 'inventory_movements').sort();
  const beforeAddons = db.prepare('SELECT id, stock_quantity FROM addons ORDER BY id').all();

  migration.up();
  migration.up();

  assertOrThrow(
    JSON.stringify(columnsOf(db, 'inventory_movements')) === JSON.stringify(beforeColumns),
    'replaying v103 adds no duplicate ledger columns',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count,
    beforeRows,
    'replaying v103 keeps every movement row',
  );
  assertOrThrow(
    JSON.stringify(indexNames(db, 'inventory_movements').sort()) === JSON.stringify(beforeIndexes),
    'replaying v103 does not duplicate ledger indexes',
  );
  assertOrThrow(
    JSON.stringify(db.prepare('SELECT id, stock_quantity FROM addons ORDER BY id').all()) === JSON.stringify(beforeAddons),
    'replaying v103 keeps add-on stock untouched',
  );
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    'the store still validates after a v103 replay',
  );
}

async function upgradeFromPreV103Assertions(): Promise<void> {
  await closeStore();
  const db = initAtVersion(102);
  const stamp = now();
  db.prepare(`INSERT INTO users (id, name, password, role, is_active, created_at, updated_at)
    VALUES ('owner', 'Owner', 'hash', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO categories (id, name, is_active, created_at, updated_at)
    VALUES ('cat', 'Coffee', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO products (id, category_id, name, price, stock_quantity, is_active, created_at, updated_at)
    VALUES ('latte', 'cat', 'Latte', 250, 12, 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO products (id, category_id, name, price, stock_quantity, is_active, created_at, updated_at)
    VALUES ('tea', 'cat', 'Tea', 100, 0, 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO addon_groups (id, name, is_active, created_at, updated_at)
    VALUES ('milk', 'Milk', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
    VALUES ('oat', 'milk', 'Oat milk', 40, 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO inventory_movements (product_id, quantity_delta, movement_type,
      reference_type, reference_id, reason, actor_user_id, stock_after, created_at)
    VALUES ('latte', 12, 'adjustment', 'opening_balance', 'latte', 'Opening count', 'owner', 12, ?)`).run(stamp);
  const legacyMovementId = (db.prepare('SELECT MAX(id) AS id FROM inventory_movements').get() as { id: number }).id;

  assertOrThrow(
    !columnsOf(db, 'addons').includes('stock_quantity'),
    'the pre-v103 fixture has no add-on stock column',
  );
  assertEqualOrThrow(
    columnInfo(db, 'inventory_movements', 'product_id').notnull,
    1,
    'the pre-v103 fixture still requires a product on every movement',
  );

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...FULL_REGISTRY);
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  assertEqualOrThrow(getCurrentSchemaVersion(), ADDON_INVENTORY_VERSION, 'the upgraded store reaches v103');
  assertOrThrow(
    columnsOf(db, 'addons').includes('low_stock_threshold'),
    'the upgrade adds the add-on inventory columns',
  );
  assertOrThrow(
    columnsOf(db, 'order_item_addons').includes('inventory_deducted_quantity'),
    'the upgrade adds order_item_addons.inventory_deducted_quantity',
  );
  assertEqualOrThrow(
    columnInfo(db, 'inventory_movements', 'product_id').notnull,
    0,
    'the upgrade relaxes inventory_movements.product_id',
  );
  assertOrThrow(
    columnsOf(db, 'inventory_movements').includes('addon_id'),
    'the upgrade adds the add-on pool column to the ledger',
  );
  assertOrThrow(
    JSON.stringify(db.prepare('SELECT id, name, price, stock_quantity FROM products ORDER BY id').all())
      === JSON.stringify([
        { id: 'latte', name: 'Latte', price: 250, stock_quantity: 12 },
        { id: 'tea', name: 'Tea', price: 100, stock_quantity: 0 },
      ]),
    'existing products survive the upgrade untouched',
  );
  assertOrThrow(
    db.prepare("SELECT id FROM addons WHERE id = 'oat'").get(),
    'the existing add-on survives the upgrade',
  );
  assertEqualOrThrow(
    db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get('oat').stock_quantity,
    0,
    'an upgraded add-on starts at zero stock',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count,
    1,
    'the ledger keeps its pre-migration row',
  );
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    'the upgraded store still validates against the ledger pre-check',
  );

  const nextMovementId = db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, addon_id,
      quantity_delta, movement_type, reference_type, reference_id, reason, actor_user_id, stock_after, created_at)
    VALUES (NULL, NULL, 'oat', 5, 'adjustment', 'opening_balance', 'oat', 'Opening count', 'owner', 5, ?)`)
    .run(stamp).lastInsertRowid;
  assertOrThrow(
    Number(nextMovementId) > legacyMovementId,
    `movement ids keep ascending after the rebuild (got ${nextMovementId} after ${legacyMovementId})`,
  );
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    'Add-on stock does not match the latest inventory movement',
    'an add-on movement against untouched add-on stock is refused',
  );
  db.prepare('UPDATE addons SET stock_quantity = 5 WHERE id = ?').run('oat');
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    'the upgraded ledger accepts a new add-on movement once the pool agrees with it',
  );
  assertEqualOrThrow(
    db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('latte').stock_quantity,
    12,
    'writing add-on stock leaves the product pool untouched',
  );
  assertOrThrow(
    JSON.stringify(db.pragma('foreign_key_check')) === '[]',
    'the upgraded schema has no foreign-key violations',
  );
}

async function currencyResetAssertions(): Promise<void> {
  await closeStore();
  initDatabase();
  const db = getDatabase();
  const stamp = now();
  const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  setting.run('country', 'IN', stamp);
  setting.run('currency', 'INR', stamp);
  setting.run('timezone', 'Asia/Kolkata', stamp);

  seedMenu(db);
  seedAddonPool(db, 'oat', 5);
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    'the stocked add-on store validates before the currency reset',
  );

  await resetDatabaseForCurrencyChange('USD', 'INR');

  const fresh = getDatabase();
  assertEqualOrThrow(
    fresh.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get('oat').stock_quantity,
    0,
    'a currency reset zeroes add-on stock like product and variant stock',
  );
  assertEqualOrThrow(
    fresh.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count,
    0,
    'the currency reset leaves the ledger empty',
  );
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(fresh),
    null,
    'a reset store with add-ons still passes the ledger pre-check',
  );

  const backup = await createBackup();
  const restored = restoreBackup(backup.path, true);
  assertOrThrow(
    restored.success,
    `a backup taken after a currency reset with add-ons still restores (got ${JSON.stringify(restored)})`,
  );
  assertEqualOrThrow(
    getDatabase().prepare("SELECT COUNT(*) AS count FROM addons WHERE id = 'oat'").get().count,
    1,
    'the reset add-on survives the restore of the reset store',
  );
}

const FULL_REGISTRY = MIGRATIONS.map((entry: any) => entry);

function initAtVersion(version: number): any {
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...FULL_REGISTRY.filter((entry: any) => entry.version <= version));
  initDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), version, `the upgrade fixture starts at schema v${version}`);
  return getDatabase();
}

async function main() {
  resetCounters();
  console.log('Add-on inventory foundation');
  console.log('='.repeat(60));

  initDatabase();
  console.log('─── Fresh install schema ───');
  freshInstallAssertions();
  console.log('  ✓ add-ons, order lines, and the ledger carry the add-on pool');

  console.log('─── Inventory service add-on branch ───');
  inventoryServiceAssertions();
  console.log('  ✓ add-on stock moves, refuses negatives, and writes attributed ledger rows');

  console.log('─── Ledger validation ───');
  ledgerValidatorAssertions();
  console.log('  ✓ the ledger accepts an add-on chain and refuses broken, colliding, and erased ones');

  console.log('─── Replay safety ───');
  replaySafetyAssertions();
  console.log('  ✓ v103 can be replayed without duplicating columns, indexes, or rows');

  console.log('─── Upgrade from a pre-v103 store ───');
  await upgradeFromPreV103Assertions();
  console.log('  ✓ a populated pre-v103 store upgrades without losing data or reusing movement ids');

  console.log('─── Currency reset ───');
  await currencyResetAssertions();
  console.log('  ✓ a reset store with add-ons validates and restores');

  const results = getResults();
  console.log(`\nAdd-on inventory: ${results.passed}/${results.total} checks passed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  process.exit(1);
});