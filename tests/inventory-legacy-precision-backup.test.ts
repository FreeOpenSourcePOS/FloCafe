/**
 * Regression tests for legacy high-precision inventory stock quantities and backup/restore.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inv-legacy-precision-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => activeTestDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  closeDatabase,
  now,
  getCurrentSchemaVersion,
  validateInventoryLedgerDatabase,
  validateInventoryLedgerRows,
  getInventoryMovementRows,
  createBackup,
  restoreBackup,
  buildIdealSchemaDb,
} = require('../main/db');
const { adjustProductStock } = require('../main/services/inventory');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

function assertProductStockPrecision(
  db: any,
  productId: string,
  expectedStock: number,
  expectedDelta: number,
  adjResult: { stockBefore: number; stockAfter: number },
) {
  assertEqualOrThrow(
    adjResult.stockAfter,
    expectedStock,
    `Returned stockAfter matches expected precision for product ${productId}`,
  );
  const row = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId) as {
    stock_quantity: number;
  };
  assertEqualOrThrow(
    row.stock_quantity,
    expectedStock,
    `Saved products.stock_quantity matches exact IEEE-754 precision for ${productId}`,
  );
  const movement = db
    .prepare(
      'SELECT stock_after, quantity_delta FROM inventory_movements WHERE product_id = ? AND variant_id IS NULL AND addon_id IS NULL ORDER BY id DESC LIMIT 1',
    )
    .get(productId) as { stock_after: number; quantity_delta: number };
  assertEqualOrThrow(
    movement.stock_after,
    expectedStock,
    `Movement stock_after matches exact IEEE-754 precision for ${productId}`,
  );
  assertEqualOrThrow(
    movement.quantity_delta,
    expectedDelta,
    `Movement quantity_delta matches exact delta for ${productId}`,
  );
}

function assertVariantStockPrecision(
  db: any,
  variantId: string,
  expectedStock: number,
  expectedDelta: number,
  adjResult: { stockBefore: number; stockAfter: number },
) {
  assertEqualOrThrow(
    adjResult.stockAfter,
    expectedStock,
    `Returned stockAfter matches expected precision for variant ${variantId}`,
  );
  const row = db
    .prepare('SELECT stock_quantity FROM product_variants WHERE id = ?')
    .get(variantId) as { stock_quantity: number };
  assertEqualOrThrow(
    row.stock_quantity,
    expectedStock,
    `Saved product_variants.stock_quantity matches exact IEEE-754 precision for ${variantId}`,
  );
  const movement = db
    .prepare(
      'SELECT stock_after, quantity_delta FROM inventory_movements WHERE variant_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(variantId) as { stock_after: number; quantity_delta: number };
  assertEqualOrThrow(
    movement.stock_after,
    expectedStock,
    `Movement stock_after matches exact IEEE-754 precision for ${variantId}`,
  );
  assertEqualOrThrow(
    movement.quantity_delta,
    expectedDelta,
    `Movement quantity_delta matches exact delta for ${variantId}`,
  );
}

function assertAddonStockPrecision(
  db: any,
  addonId: string,
  expectedStock: number,
  expectedDelta: number,
  adjResult: { stockBefore: number; stockAfter: number },
) {
  assertEqualOrThrow(
    adjResult.stockAfter,
    expectedStock,
    `Returned stockAfter matches expected precision for addon ${addonId}`,
  );
  const row = db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get(addonId) as {
    stock_quantity: number;
  };
  assertEqualOrThrow(
    row.stock_quantity,
    expectedStock,
    `Saved addons.stock_quantity matches exact IEEE-754 precision for ${addonId}`,
  );
  const movement = db
    .prepare(
      'SELECT stock_after, quantity_delta FROM inventory_movements WHERE addon_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(addonId) as { stock_after: number; quantity_delta: number };
  assertEqualOrThrow(
    movement.stock_after,
    expectedStock,
    `Movement stock_after matches exact IEEE-754 precision for ${addonId}`,
  );
  assertEqualOrThrow(
    movement.quantity_delta,
    expectedDelta,
    `Movement quantity_delta matches exact delta for ${addonId}`,
  );
}

async function run() {
  console.log('Running legacy inventory precision and backup/restore tests...');
  initDatabase();
  const db = getDatabase();

  try {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, name, email, password, role, pin, created_at, updated_at)
      VALUES ('u-owner', 'Owner', 'owner@example.com', 'hash', 'owner', '1234', ?, ?)
    `).run(now(), now());

    db.prepare(`
      INSERT OR IGNORE INTO categories (id, name, created_at, updated_at)
      VALUES ('cat-precision', 'Precision Cat', ?, ?)
    `).run(now(), now());

    db.prepare(`
      INSERT OR IGNORE INTO addon_groups (id, name, min_selection, max_selection, is_active)
      VALUES ('ag-precision', 'Precision Extras', 0, 5, 1)
    `).run();

    console.log(
      '\n--- Scenario 1: Product stock pool with 12-, 15-, and 16-decimal legacy quantities ---',
    );
    const productCases = [
      { id: 'p-legacy-15', name: 'Product 15 Decimals', stock: 0.123456789012345 },
      { id: 'p-legacy-16', name: 'Product 16 Decimals', stock: 0.1234567890123456 },
      { id: 'p-legacy-12', name: 'Product 12 Decimals', stock: 10.123456789012 },
    ];

    for (const item of productCases) {
      db.prepare(`
        INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES (?, 'cat-precision', ?, 10, 1, ?, ?, ?)
      `).run(item.id, item.name, item.stock, now(), now());

      db.prepare(`
        INSERT INTO inventory_movements (
          product_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, 'u-owner', ?)
      `).run(item.id, item.stock, item.stock, now());
    }

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'Product pools validate before adjustments',
    );

    // Test adjustment +0.01 on 15 decimals
    console.log('Applying adjustment +0.01 to product with 0.123456789012345...');
    const expectedStockP15 = 0.123456789012345 + 0.01;
    const expectedDeltaP15 = expectedStockP15 - 0.123456789012345;
    const adjResultP15 = adjustProductStock(db, {
      productId: 'p-legacy-15',
      quantityDelta: 0.01,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Adjustment +0.01 on 15 decimals',
    });
    assertProductStockPrecision(
      db,
      'p-legacy-15',
      expectedStockP15,
      expectedDeltaP15,
      adjResultP15,
    );

    const ledgerErrProduct15 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrProduct15,
      null,
      `Ledger must validate after +0.01 adjustment on 15-decimal product stock (got: ${ledgerErrProduct15})`,
    );

    // Test adjustment -0.05 on 16 decimals
    const expectedStockP16 = 0.1234567890123456 - 0.05;
    const expectedDeltaP16 = expectedStockP16 - 0.1234567890123456;
    const adjResultP16 = adjustProductStock(db, {
      productId: 'p-legacy-16',
      quantityDelta: -0.05,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Delta -0.05 on 16 decimals',
    });
    assertProductStockPrecision(
      db,
      'p-legacy-16',
      expectedStockP16,
      expectedDeltaP16,
      adjResultP16,
    );

    const ledgerErrProduct16 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrProduct16,
      null,
      `Ledger must validate after -0.05 adjustment on 16-decimal product stock (got: ${ledgerErrProduct16})`,
    );

    // Test repeated fractional adjustments on 12 decimals
    let currentStockP12 = 10.123456789012;
    for (const delta of [0.01, -0.005, 0.125, -0.02]) {
      const prevStockP12 = currentStockP12;
      currentStockP12 = prevStockP12 + delta;
      const expDeltaP12 = currentStockP12 - prevStockP12;
      const adjP12 = adjustProductStock(db, {
        productId: 'p-legacy-12',
        quantityDelta: delta,
        movementType: 'adjustment',
        actorUserId: 'u-owner',
        reason: `Repeated delta ${delta}`,
      });
      assertProductStockPrecision(db, 'p-legacy-12', currentStockP12, expDeltaP12, adjP12);
    }
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'Ledger must validate after repeated fractional adjustments on 12-decimal product stock',
    );

    console.log(
      '\n--- Scenario 2: Variant stock pool with 15- and 16-decimal legacy quantities ---',
    );
    db.prepare(`
      INSERT INTO products (id, category_id, name, price, track_inventory, created_at, updated_at)
      VALUES ('p-parent-var', 'cat-precision', 'Parent Product for Variants', 15, 0, ?, ?)
    `).run(now(), now());

    const variantCases = [
      { id: 'v-legacy-15', name: 'Variant 15 Dec', stock: 0.123456789012345 },
      { id: 'v-legacy-16', name: 'Variant 16 Dec', stock: 0.1234567890123456 },
    ];

    for (const v of variantCases) {
      db.prepare(`
        INSERT INTO product_variants (id, product_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES (?, 'p-parent-var', ?, 15, 1, ?, ?, ?)
      `).run(v.id, v.name, v.stock, now(), now());

      db.prepare(`
        INSERT INTO inventory_movements (
          product_id, variant_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES ('p-parent-var', ?, ?, 'adjustment', 'opening_balance', ?, 'u-owner', ?)
      `).run(v.id, v.stock, v.stock, now());
    }

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'Variant pools validate before adjustments',
    );

    const expectedStockV15 = 0.123456789012345 + 0.01;
    const expectedDeltaV15 = expectedStockV15 - 0.123456789012345;
    const adjResultV15 = adjustProductStock(db, {
      productId: 'p-parent-var',
      variantId: 'v-legacy-15',
      quantityDelta: 0.01,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Variant delta +0.01',
    });
    assertVariantStockPrecision(
      db,
      'v-legacy-15',
      expectedStockV15,
      expectedDeltaV15,
      adjResultV15,
    );

    const ledgerErrVariant15 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrVariant15,
      null,
      `Ledger must validate after +0.01 adjustment on 15-decimal variant stock (got: ${ledgerErrVariant15})`,
    );

    const expectedStockV16 = 0.1234567890123456 - 0.05;
    const expectedDeltaV16 = expectedStockV16 - 0.1234567890123456;
    const adjResultV16 = adjustProductStock(db, {
      productId: 'p-parent-var',
      variantId: 'v-legacy-16',
      quantityDelta: -0.05,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Variant delta -0.05',
    });
    assertVariantStockPrecision(
      db,
      'v-legacy-16',
      expectedStockV16,
      expectedDeltaV16,
      adjResultV16,
    );

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'Ledger must validate after -0.05 adjustment on 16-decimal variant stock',
    );

    console.log(
      '\n--- Scenario 3: Add-on stock pool with 15- and 16-decimal legacy quantities ---',
    );
    const addonCases = [
      { id: 'a-legacy-15', name: 'Addon 15 Dec', stock: 0.123456789012345 },
      { id: 'a-legacy-16', name: 'Addon 16 Dec', stock: 0.1234567890123456 },
    ];

    for (const a of addonCases) {
      db.prepare(`
        INSERT INTO addons (id, addon_group_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES (?, 'ag-precision', ?, 2.5, 1, ?, ?, ?)
      `).run(a.id, a.name, a.stock, now(), now());

      db.prepare(`
        INSERT INTO inventory_movements (
          addon_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, 'u-owner', ?)
      `).run(a.id, a.stock, a.stock, now());
    }

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'Addon pools validate before adjustments',
    );

    const expectedStockA15 = 0.123456789012345 + 0.01;
    const expectedDeltaA15 = expectedStockA15 - 0.123456789012345;
    const adjResultA15 = adjustProductStock(db, {
      productId: null,
      addonId: 'a-legacy-15',
      quantityDelta: 0.01,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Addon delta +0.01',
    });
    assertAddonStockPrecision(db, 'a-legacy-15', expectedStockA15, expectedDeltaA15, adjResultA15);

    const ledgerErrAddon15 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrAddon15,
      null,
      `Ledger must validate after +0.01 adjustment on 15-decimal addon stock (got: ${ledgerErrAddon15})`,
    );

    const expectedStockA16 = 0.1234567890123456 - 0.05;
    const expectedDeltaA16 = expectedStockA16 - 0.1234567890123456;
    const adjResultA16 = adjustProductStock(db, {
      productId: null,
      addonId: 'a-legacy-16',
      quantityDelta: -0.05,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Addon delta -0.05',
    });
    assertAddonStockPrecision(db, 'a-legacy-16', expectedStockA16, expectedDeltaA16, adjResultA16);

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'Ledger must validate after -0.05 adjustment on 16-decimal addon stock',
    );

    console.log(
      '\n--- Scenario 4: Backup and restore round-trip with legacy high-precision stocks ---',
    );
    const preBackupProducts = db
      .prepare('SELECT id, stock_quantity FROM products WHERE track_inventory = 1 ORDER BY id')
      .all() as { id: string; stock_quantity: number }[];
    const preBackupVariants = db
      .prepare(
        'SELECT id, stock_quantity FROM product_variants WHERE track_inventory = 1 ORDER BY id',
      )
      .all() as { id: string; stock_quantity: number }[];
    const preBackupAddons = db
      .prepare('SELECT id, stock_quantity FROM addons WHERE track_inventory = 1 ORDER BY id')
      .all() as { id: string; stock_quantity: number }[];
    const preBackupMovements = db
      .prepare(
        'SELECT id, product_id, variant_id, addon_id, stock_after, quantity_delta FROM inventory_movements ORDER BY id',
      )
      .all() as {
      id: number;
      product_id: string | null;
      variant_id: string | null;
      addon_id: string | null;
      stock_after: number;
      quantity_delta: number;
    }[];

    const backupResult = await createBackup();
    assertOrThrow(Boolean(backupResult?.path), 'createBackup returns valid backup path');
    const restoreResult = restoreBackup(backupResult.path, true);
    assertOrThrow(
      restoreResult.success,
      `restoreBackup succeeds (got ${JSON.stringify(restoreResult)})`,
    );

    const restoredDb = getDatabase();
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(restoredDb),
      null,
      'Restored database passes ledger validation',
    );

    for (const pre of preBackupProducts) {
      const post = restoredDb
        .prepare('SELECT stock_quantity FROM products WHERE id = ?')
        .get(pre.id) as { stock_quantity: number };
      assertEqualOrThrow(
        post.stock_quantity,
        pre.stock_quantity,
        `Restored product ${pre.id} stock_quantity matches exact pre-backup value`,
      );
    }
    for (const pre of preBackupVariants) {
      const post = restoredDb
        .prepare('SELECT stock_quantity FROM product_variants WHERE id = ?')
        .get(pre.id) as { stock_quantity: number };
      assertEqualOrThrow(
        post.stock_quantity,
        pre.stock_quantity,
        `Restored variant ${pre.id} stock_quantity matches exact pre-backup value`,
      );
    }
    for (const pre of preBackupAddons) {
      const post = restoredDb
        .prepare('SELECT stock_quantity FROM addons WHERE id = ?')
        .get(pre.id) as { stock_quantity: number };
      assertEqualOrThrow(
        post.stock_quantity,
        pre.stock_quantity,
        `Restored addon ${pre.id} stock_quantity matches exact pre-backup value`,
      );
    }
    for (const pre of preBackupMovements) {
      const post = restoredDb
        .prepare('SELECT stock_after, quantity_delta FROM inventory_movements WHERE id = ?')
        .get(pre.id) as { stock_after: number; quantity_delta: number };
      assertEqualOrThrow(
        post.stock_after,
        pre.stock_after,
        `Restored movement ${pre.id} stock_after matches exact pre-backup value`,
      );
      assertEqualOrThrow(
        post.quantity_delta,
        pre.quantity_delta,
        `Restored movement ${pre.id} quantity_delta matches exact pre-backup value`,
      );
    }

    console.log('\n--- Scenario 5: Historical v114 restore fixture with populated data ---');
    const v114Db = buildIdealSchemaDb(114);
    const v114BackupPath = path.join(activeTestDir, 'fixture-v114-populated.db');
    try {
      v114Db
        .prepare(`
        INSERT OR IGNORE INTO users (id, name, email, password, role, pin, created_at, updated_at)
        VALUES ('u-v114', 'V114 Staff', 'v114staff@example.com', 'hash', 'owner', '1234', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      `)
        .run();

      v114Db
        .prepare(`
        INSERT INTO categories (id, name, created_at, updated_at)
        VALUES ('cat-v114', 'V114 Category', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      `)
        .run();

      v114Db
        .prepare(`
        INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES ('prod-v114', 'cat-v114', 'V114 Product', 25.0, 1, 50.0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      `)
        .run();

      v114Db
        .prepare(`
        INSERT INTO inventory_movements (
          product_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES ('prod-v114', 50.0, 'adjustment', 'opening_balance', 50.0, 'u-v114', '2026-01-01 00:00:00')
      `)
        .run();

      v114Db
        .prepare(`
        INSERT INTO orders (id, order_number, type, status, subtotal, total, created_at, updated_at)
        VALUES (9901, 'ORD-V114-1', 'takeaway', 'completed', 25.0, 25.0, '2026-01-01 12:00:00', '2026-01-01 12:00:00')
      `)
        .run();

      v114Db
        .prepare(`
        INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
        VALUES (9901, 9901, 'prod-v114', 'V114 Product', 1, 25.0, 25.0, 25.0, '2026-01-01 12:00:00', '2026-01-01 12:00:00')
      `)
        .run();

      v114Db
        .prepare(`
        INSERT INTO bills (id, order_id, bill_number, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES (9901, 9901, 'BILL-V114-1', 25.0, 25.0, 25.0, 0, 'paid', ?, '2026-01-01 12:05:00', '2026-01-01 12:00:00', '2026-01-01 12:05:00')
      `)
        .run(JSON.stringify([{ method: 'cash', amount: 25.0 }]));

      v114Db
        .prepare(`
        INSERT INTO payment_transaction_refs (method, transaction_id, bill_id, created_at)
        VALUES ('cash', 'txn-v114-1', '9901', '2026-01-01 12:05:00')
      `)
        .run();

      v114Db.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
      v114Db
        .prepare("INSERT OR REPLACE INTO _flo_meta (key, value) VALUES ('schema_version', '114')")
        .run();
      v114Db.pragma('user_version = 114');

      await v114Db.backup(v114BackupPath);
    } finally {
      v114Db.close();
    }

    // Clear current store data so the replacement restore does not conflict with existing movements
    const liveDb = getDatabase();
    liveDb.exec(`
      DELETE FROM order_item_addons;
      DELETE FROM order_items;
      DELETE FROM payment_transaction_refs;
      DELETE FROM bills;
      DELETE FROM orders;
      DELETE FROM inventory_movements;
      DELETE FROM product_variants;
      DELETE FROM products;
      DELETE FROM addons;
      DELETE FROM addon_groups;
      DELETE FROM categories;
    `);

    console.log('Restoring populated v114 backup into live database...');
    const expectedSchemaVersion = getCurrentSchemaVersion();
    const v114RestoreResult = restoreBackup(v114BackupPath, false);
    assertOrThrow(
      v114RestoreResult.success,
      `v114 restore must succeed (got ${JSON.stringify(v114RestoreResult)})`,
    );

    const postRestoreDb = getDatabase();
    assertEqualOrThrow(
      getCurrentSchemaVersion(),
      expectedSchemaVersion,
      'Database upgrades from v114 to current schema after restore',
    );

    const integrityCheck = postRestoreDb.pragma('integrity_check', { simple: true });
    assertEqualOrThrow(integrityCheck, 'ok', 'PRAGMA integrity_check passes after v114 restore');

    const ledgerCheck = validateInventoryLedgerDatabase(postRestoreDb);
    assertEqualOrThrow(
      ledgerCheck,
      null,
      'validateInventoryLedgerDatabase passes after v114 restore',
    );

    const restoredOrder = postRestoreDb
      .prepare('SELECT * FROM orders WHERE id = 9901')
      .get() as any;
    assertOrThrow(Boolean(restoredOrder), 'Restored order 9901 exists');
    assertEqualOrThrow(restoredOrder.order_number, 'ORD-V114-1', 'Restored order number matches');

    const restoredBill = postRestoreDb.prepare('SELECT * FROM bills WHERE id = 9901').get() as any;
    assertOrThrow(Boolean(restoredBill), 'Restored bill 9901 exists');

    const restoredPayment = postRestoreDb
      .prepare("SELECT * FROM payment_transaction_refs WHERE transaction_id = 'txn-v114-1'")
      .get() as any;
    assertOrThrow(Boolean(restoredPayment), 'Restored payment transaction ref txn-v114-1 exists');

    console.log('\n--- Scenario 6: Backward clock and durable append order validation & backup/restore (#1272) ---');

    // Part A: validateInventoryLedgerRows under backward clock jumps
    // Case 1: Backward clock before opening balance across product, variant, and add-on pools
    const testProducts = [{ id: 'p-clock-1', stock_quantity: 8.0 }];
    const testVariants = [{ id: 'v-clock-1', product_id: 'p-clock-1', stock_quantity: 15.0 }];
    const testAddons = [{ id: 'a-clock-1', stock_quantity: 27.0 }];

    const testMovementsBackwardOpening = [
      // Product: opening balance at 12:00:00 (+10 -> 10), sale at 11:59:00 (-2 -> 8)
      { id: 1, product_id: 'p-clock-1', quantity_delta: 10.0, stock_after: 10.0, movement_type: 'adjustment', created_at: '2026-10-21T12:00:00.000Z' },
      { id: 2, product_id: 'p-clock-1', quantity_delta: -2.0, stock_after: 8.0, movement_type: 'sale', created_at: '2026-10-21T11:59:00.000Z' },
      // Variant: opening balance at 12:00:00 (+20 -> 20), sale at 11:59:00 (-5 -> 15)
      { id: 3, product_id: 'p-clock-1', variant_id: 'v-clock-1', quantity_delta: 20.0, stock_after: 20.0, movement_type: 'adjustment', created_at: '2026-10-21T12:00:00.000Z' },
      { id: 4, product_id: 'p-clock-1', variant_id: 'v-clock-1', quantity_delta: -5.0, stock_after: 15.0, movement_type: 'sale', created_at: '2026-10-21T11:59:00.000Z' },
      // Addon: opening balance at 12:00:00 (+30 -> 30), sale at 11:59:00 (-3 -> 27)
      { id: 5, addon_id: 'a-clock-1', quantity_delta: 30.0, stock_after: 30.0, movement_type: 'adjustment', created_at: '2026-10-21T12:00:00.000Z' },
      { id: 6, addon_id: 'a-clock-1', quantity_delta: -3.0, stock_after: 27.0, movement_type: 'sale', created_at: '2026-10-21T11:59:00.000Z' },
    ];
    const backwardOpeningValidation = validateInventoryLedgerRows(testProducts, testMovementsBackwardOpening, testVariants, testAddons);
    assertEqualOrThrow(
      backwardOpeningValidation,
      null,
      'validateInventoryLedgerRows succeeds for backward clock before opening balance across product, variant, and addon pools',
    );

    // Case 2: Backward clock mid-chain (12:00:00 opening +10 -> 10, 12:05:00 sale -2 -> 8, 12:03:00 sale -1 -> 7)
    const midChainMovements = [
      { id: 10, product_id: 'p-mid-1', quantity_delta: 10.0, stock_after: 10.0, movement_type: 'adjustment', created_at: '2026-10-21T12:00:00.000Z' },
      { id: 11, product_id: 'p-mid-1', quantity_delta: -2.0, stock_after: 8.0, movement_type: 'sale', created_at: '2026-10-21T12:05:00.000Z' },
      { id: 12, product_id: 'p-mid-1', quantity_delta: -1.0, stock_after: 7.0, movement_type: 'sale', created_at: '2026-10-21T12:03:00.000Z' },
    ];
    const midChainValidation = validateInventoryLedgerRows([{ id: 'p-mid-1', stock_quantity: 7.0 }], midChainMovements);
    assertEqualOrThrow(
      midChainValidation,
      null,
      'validateInventoryLedgerRows succeeds for backward clock mid-chain',
    );

    // Case 3: Equal-second movements (12:00:00 across multiple transitions)
    const equalSecondMovements = [
      { id: 20, product_id: 'p-eq-1', quantity_delta: 10.0, stock_after: 10.0, movement_type: 'adjustment', created_at: '2026-10-21T12:00:00.000Z' },
      { id: 21, product_id: 'p-eq-1', quantity_delta: -2.0, stock_after: 8.0, movement_type: 'sale', created_at: '2026-10-21T12:00:00.000Z' },
      { id: 22, product_id: 'p-eq-1', quantity_delta: -3.0, stock_after: 5.0, movement_type: 'sale', created_at: '2026-10-21T12:00:00.000Z' },
    ];
    const equalSecondValidation = validateInventoryLedgerRows([{ id: 'p-eq-1', stock_quantity: 5.0 }], equalSecondMovements);
    assertEqualOrThrow(
      equalSecondValidation,
      null,
      'validateInventoryLedgerRows succeeds for equal-second movements',
    );

    // Part B: Database native direct backup/restore round-trip with backward clock movements
    const liveDbDirect = getDatabase();
    liveDbDirect.exec(`
      DELETE FROM order_item_addons;
      DELETE FROM order_items;
      DELETE FROM payment_transaction_refs;
      DELETE FROM bills;
      DELETE FROM orders;
      DELETE FROM inventory_movements;
      DELETE FROM product_variants;
      DELETE FROM products;
      DELETE FROM addons;
      DELETE FROM addon_groups;
      DELETE FROM categories;
    `);

    liveDbDirect.prepare(`
      INSERT INTO categories (id, name, created_at, updated_at)
      VALUES ('cat-clock', 'Clock Category', '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.000Z')
    `).run();

    liveDbDirect.prepare(`
      INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
      VALUES ('prod-clock-1', 'cat-clock', 'Clock Product 1', 10.0, 1, 8.0, '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.000Z')
    `).run();

    liveDbDirect.prepare(`
      INSERT INTO product_variants (id, product_id, name, price, stock_quantity, created_at, updated_at)
      VALUES ('var-clock-1', 'prod-clock-1', 'Clock Variant 1', 12.0, 15.0, '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.000Z')
    `).run();

    liveDbDirect.prepare(`
      INSERT INTO addon_groups (id, name, min_selection, max_selection, is_active)
      VALUES ('ag-clock', 'Clock Extras', 0, 5, 1)
    `).run();

    liveDbDirect.prepare(`
      INSERT INTO addons (id, addon_group_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
      VALUES ('addon-clock-1', 'ag-clock', 'Clock Addon 1', 2.0, 1, 27.0, '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.000Z')
    `).run();

    const insertMovement = liveDbDirect.prepare(`
      INSERT INTO inventory_movements (
        id, product_id, variant_id, addon_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'adjustment', ?, 'u-owner', ?)
    `);

    // Insert movements with backward timestamps:
    // Product: opening 12:00, sale 11:59
    insertMovement.run(101, 'prod-clock-1', null, null, 10.0, 'adjustment', 10.0, '2026-10-21T12:00:00.000Z');
    insertMovement.run(102, 'prod-clock-1', null, null, -2.0, 'sale', 8.0, '2026-10-21T11:59:00.000Z');
    // Variant: opening 12:00, sale 11:59
    insertMovement.run(103, 'prod-clock-1', 'var-clock-1', null, 20.0, 'adjustment', 20.0, '2026-10-21T12:00:00.000Z');
    insertMovement.run(104, 'prod-clock-1', 'var-clock-1', null, -5.0, 'sale', 15.0, '2026-10-21T11:59:00.000Z');
    // Addon: opening 12:00, sale 11:59
    insertMovement.run(105, null, null, 'addon-clock-1', 30.0, 'adjustment', 30.0, '2026-10-21T12:00:00.000Z');
    insertMovement.run(106, null, null, 'addon-clock-1', -3.0, 'sale', 27.0, '2026-10-21T11:59:00.000Z');

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(liveDbDirect),
      null,
      'validateInventoryLedgerDatabase passes on pre-backup live db with backward clock movements',
    );

    const clockBackup = await createBackup();
    assertOrThrow(clockBackup && clockBackup.path, 'Backup of backward clock database created');

    // Wipe and restore direct
    liveDbDirect.exec(`
      DELETE FROM inventory_movements;
      DELETE FROM product_variants;
      DELETE FROM products;
      DELETE FROM addons;
      DELETE FROM categories;
    `);

    const directRestoreResult = restoreBackup(clockBackup.path, true);
    assertOrThrow(directRestoreResult.success, 'Direct restore of backward clock backup succeeds');

    const restoredDirectDb = getDatabase();
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(restoredDirectDb),
      null,
      'validateInventoryLedgerDatabase passes after direct restore of backward clock backup',
    );

    const directMovements = getInventoryMovementRows(restoredDirectDb);
    assertEqualOrThrow(directMovements.length, 6, 'All 6 movements restored in direct restore');
    assertEqualOrThrow(directMovements[0].id, 101, 'Movement 101 id preserved');
    assertEqualOrThrow(directMovements[0].created_at, '2026-10-21T12:00:00.000Z', 'Movement 101 created_at preserved');
    assertEqualOrThrow(directMovements[1].id, 102, 'Movement 102 id preserved');
    assertEqualOrThrow(directMovements[1].created_at, '2026-10-21T11:59:00.000Z', 'Movement 102 created_at preserved');

    // Part C: Data-only restore (v114 -> v115) with backward clock movements
    const v114ClockDb = buildIdealSchemaDb(114);
    const v114ClockBackupPath = path.join(activeTestDir, 'fixture-v114-clock.db');
    try {
      v114ClockDb.prepare(`
        INSERT OR IGNORE INTO users (id, name, email, password, role, pin, created_at, updated_at)
        VALUES ('u-v114-clk', 'Clock Staff', 'clkstaff@example.com', 'hash', 'owner', '1234', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      `).run();

      v114ClockDb.prepare(`
        INSERT INTO categories (id, name, created_at, updated_at)
        VALUES ('cat-v114-clk', 'V114 Clock Category', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      `).run();

      v114ClockDb.prepare(`
        INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES ('prod-v114-clk', 'cat-v114-clk', 'V114 Clock Prod', 20.0, 1, 7.0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      `).run();

      v114ClockDb.prepare(`
        INSERT INTO inventory_movements (
          id, product_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES (1, 'prod-v114-clk', 10.0, 'adjustment', 'opening_balance', 10.0, 'u-v114-clk', '2026-01-01 12:00:00')
      `).run();

      v114ClockDb.prepare(`
        INSERT INTO inventory_movements (
          id, product_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES (2, 'prod-v114-clk', -2.0, 'sale', 'sale', 8.0, 'u-v114-clk', '2026-01-01 12:05:00')
      `).run();

      v114ClockDb.prepare(`
        INSERT INTO inventory_movements (
          id, product_id, quantity_delta, movement_type, reference_type, stock_after, actor_user_id, created_at
        ) VALUES (3, 'prod-v114-clk', -1.0, 'sale', 'sale', 7.0, 'u-v114-clk', '2026-01-01 12:03:00')
      `).run();

      v114ClockDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
      v114ClockDb
        .prepare("INSERT OR REPLACE INTO _flo_meta (key, value) VALUES ('schema_version', '114')")
        .run();
      v114ClockDb.pragma('user_version = 114');

      await v114ClockDb.backup(v114ClockBackupPath);
    } finally {
      v114ClockDb.close();
    }

    // Clear live db before data-only restore
    const liveDbDataOnly = getDatabase();
    liveDbDataOnly.exec(`
      DELETE FROM order_item_addons;
      DELETE FROM order_items;
      DELETE FROM payment_transaction_refs;
      DELETE FROM bills;
      DELETE FROM orders;
      DELETE FROM inventory_movements;
      DELETE FROM product_variants;
      DELETE FROM products;
      DELETE FROM addons;
      DELETE FROM addon_groups;
      DELETE FROM categories;
    `);

    const v114ClockRestoreResult = restoreBackup(v114ClockBackupPath, false);
    assertOrThrow(
      v114ClockRestoreResult.success,
      `v114 backward clock data-only restore must succeed (got ${JSON.stringify(v114ClockRestoreResult)})`,
    );

    const postClockRestoreDb = getDatabase();
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(postClockRestoreDb),
      null,
      'validateInventoryLedgerDatabase passes after v114 data-only restore with backward clock movements',
    );

    console.log('All legacy inventory precision and backup/restore tests passed!');
  } finally {
    closeDatabase();
    try {
      fs.rmSync(activeTestDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
