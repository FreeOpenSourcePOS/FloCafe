/**
 * Regression tests for legacy high-precision inventory stock quantities and backup/restore.
 *
 * Covers defect F6 (Issue #1217):
 * Preserving ledger chain continuity across stock adjustments for legacy
 * 12-, 15-, and 16-decimal IEEE-754 stock values across product, variant,
 * and add-on pools, plus backup snapshot and restore round-trips, and
 * historical v114 restore with populated data.
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
  createBackup,
  restoreBackup,
  buildIdealSchemaDb,
} = require('../main/db');
const { adjustProductStock } = require('../main/services/inventory');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

async function run() {
  console.log('Running legacy inventory precision and backup/restore tests...');
  initDatabase();
  const db = getDatabase();

  try {
    // Seed prerequisite categories and user
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

    // Test adjustment +0.01 on 15 decimals (primary F6 reproduction trigger)
    console.log('Applying adjustment +0.01 to product with 0.123456789012345...');
    adjustProductStock(db, {
      productId: 'p-legacy-15',
      quantityDelta: 0.01,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'F6 repro delta +0.01',
    });

    const ledgerErrProduct15 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrProduct15,
      null,
      `Ledger must validate after +0.01 adjustment on 15-decimal product stock (got: ${ledgerErrProduct15})`,
    );

    // Test adjustment -0.05 on 16 decimals
    adjustProductStock(db, {
      productId: 'p-legacy-16',
      quantityDelta: -0.05,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Delta -0.05 on 16 decimals',
    });

    const ledgerErrProduct16 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrProduct16,
      null,
      `Ledger must validate after -0.05 adjustment on 16-decimal product stock (got: ${ledgerErrProduct16})`,
    );

    // Test repeated fractional adjustments on 12 decimals
    for (const delta of [0.01, -0.005, 0.125, -0.02]) {
      adjustProductStock(db, {
        productId: 'p-legacy-12',
        quantityDelta: delta,
        movementType: 'adjustment',
        actorUserId: 'u-owner',
        reason: `Repeated delta ${delta}`,
      });
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

    adjustProductStock(db, {
      productId: 'p-parent-var',
      variantId: 'v-legacy-15',
      quantityDelta: 0.01,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Variant F6 delta +0.01',
    });

    const ledgerErrVariant15 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrVariant15,
      null,
      `Ledger must validate after +0.01 adjustment on 15-decimal variant stock (got: ${ledgerErrVariant15})`,
    );

    adjustProductStock(db, {
      productId: 'p-parent-var',
      variantId: 'v-legacy-16',
      quantityDelta: -0.05,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Variant delta -0.05',
    });

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

    adjustProductStock(db, {
      productId: null,
      addonId: 'a-legacy-15',
      quantityDelta: 0.01,
      movementType: 'adjustment',
      actorUserId: 'u-owner',
      reason: 'Addon F6 delta +0.01',
    });

    const ledgerErrAddon15 = validateInventoryLedgerDatabase(db);
    assertEqualOrThrow(
      ledgerErrAddon15,
      null,
      `Ledger must validate after +0.01 adjustment on 15-decimal addon stock (got: ${ledgerErrAddon15})`,
    );

    console.log(
      '\n--- Scenario 4: Backup and restore round-trip with legacy high-precision stocks ---',
    );
    const backupResult = await createBackup();
    assertOrThrow(Boolean(backupResult?.path), 'createBackup returns valid backup path');
    const restoreResult = restoreBackup(backupResult.path, true);
    assertOrThrow(
      restoreResult.success,
      `restoreBackup succeeds (got ${JSON.stringify(restoreResult)})`,
    );

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(getDatabase()),
      null,
      'Restored database passes ledger validation',
    );

    console.log('\n--- Scenario 5: Historical v114 restore fixture with populated data ---');
    // Build ideal v114 database and populate with orders, bills, payments, and movements
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

    // Now restore the populated v114 backup into current running database
    console.log('Restoring populated v114 backup into live database...');
    const v114RestoreResult = restoreBackup(v114BackupPath, false);
    assertOrThrow(
      v114RestoreResult.success,
      `v114 restore must succeed (got ${JSON.stringify(v114RestoreResult)})`,
    );

    const postRestoreDb = getDatabase();
    assertEqualOrThrow(
      getCurrentSchemaVersion(),
      115,
      'Database upgrades from v114 to latest v115 schema after restore',
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
