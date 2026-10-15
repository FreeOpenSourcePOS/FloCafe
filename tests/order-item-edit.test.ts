/**
 * Owner-only edit of live order items: quantity changes and replacements.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-item-edit.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-item-edit-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-item-edit';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { withTxn } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { registerRoutes } = require('../main/routes/index');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    id,
    email,
    bcrypt.hashSync('testpass123', 10),
    role,
    pin ? bcrypt.hashSync(pin, 10) : null,
    now(),
    now(),
  );
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

function seedOrder(db: any, suffix: string, itemStatus: string, quantity = 2, deducted = 0) {
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
    VALUES (?, 'takeaway', 'pending', ?, 0, ?, ?, ?)`).run(
    `ORD-EDIT-${suffix}`,
    quantity * 100,
    quantity * 100,
    now(),
    now(),
  );
  const orderId = (
    db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-EDIT-${suffix}`) as any
  ).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, inventory_deducted_quantity, created_at, updated_at)
    VALUES (?, 'prod-edit', 'Edit item', 100, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
    orderId,
    quantity,
    quantity * 100,
    quantity * 100,
    itemStatus,
    deducted,
    now(),
    now(),
  );
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any)
    .id;
  if (deducted > 0)
    db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?').run(
      deducted,
      'prod-edit',
    );
  return { orderId, itemId };
}
function seedBill(db: any, orderId: any, total: number, paid: number, status: string) {
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `BILL-EDIT-${orderId}`,
    orderId,
    total,
    total,
    paid,
    total - paid,
    status,
    now(),
    now(),
  );
  return db.prepare('SELECT * FROM bills WHERE order_id = ?').get(orderId) as any;
}
const stockOf = (db: any) =>
  Number(
    (db.prepare("SELECT stock_quantity FROM products WHERE id = 'prod-edit'").get() as any)
      .stock_quantity,
  );

async function main() {
  console.log('Owner-only order item edit');
  console.log('='.repeat(60));
  resetCounters();
  resetPinRateLimitForTests();
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-edit', 'Edit', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-edit', 'cat-edit', 'Edit item', 100, 'none', 1, 1, 1, 50, ?, ?)`).run(
    now(),
    now(),
  );
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-other', 'cat-edit', 'Other item', 150, 'none', 1, 2, ?, ?)`).run(now(), now());

  const { createSupply, getSupply } = require('../main/services/supplies');
  const {
    saveRecipe,
    buildRecipeSnapshot,
    applyRecipeSnapshot,
  } = require('../main/services/recipes');
  const { adjustProductStock } = require('../main/services/inventory');

  const ownerAuth = seedUser(db, 'owner-edit', 'owner', '5678');
  const managerAuth = seedUser(db, 'mgr-edit', 'manager', '1234');
  db.prepare(
    `UPDATE products SET track_inventory = 1, stock_quantity = 50 WHERE id = 'prod-other'`,
  ).run();
  const beans = createSupply(db, {
    name: 'Coffee Beans',
    baseUnit: 'g',
    stockQuantity: 1000,
    lowStockThreshold: 100,
    actorUserId: 'owner-edit',
  });
  saveRecipe(db, {
    productId: 'prod-edit',
    yieldQuantity: 1,
    items: [{ supply_id: beans.id, quantity: 10, unit: 'g' }],
  });
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active, created_at, updated_at)
     VALUES ('ag-edit', 'Shots', 0, 0, 5, 1, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('ag-edit', 'prod-edit')`,
  ).run();
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active, track_inventory, stock_quantity, created_at, updated_at)
     VALUES ('addon-edit', 'ag-edit', 'Extra Shot', 20, 1, 1, 100, ?, ?)`,
  ).run(now(), now());

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  let keyCounter = 0;
  const nextKey = (prefix = 'edit-key') => `${prefix}-${++keyCounter}`;
  const edit = (
    orderId: any,
    itemId: any,
    body: any,
    headers: any,
    idempotencyKey: string | null = nextKey(),
  ) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/edit`, {
      method: 'PATCH',
      body:
        body && typeof body === 'object' && !('expected_edit_version' in body)
          ? { expected_edit_version: 0, ...body }
          : body,
      headers: idempotencyKey ? { ...headers, 'Idempotency-Key': idempotencyKey } : headers,
    });
  const itemStatus = (id: any) =>
    (db.prepare('SELECT status FROM order_items WHERE id = ?').get(id) as any).status;
  const orderTotal = (id: any) =>
    Number((db.prepare('SELECT total FROM orders WHERE id = ?').get(id) as any).total);
  const stockOfProduct = (id: string) =>
    Number(
      (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any)
        .stock_quantity,
    );
  const stockOfAddon = (id: string) =>
    Number(
      (db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get(id) as any).stock_quantity,
    );
  const stockOfSupply = (id: string) => Number(getSupply(db, id).stock_quantity);

  try {
    console.log('\n─── Permission & Required Contract Fields ───');
    {
      const order = seedOrder(db, 'PERM', 'pending');
      const response = await edit(order.orderId, order.itemId, { quantity: 3 }, managerAuth);
      assertEqualOrThrow(response.status, 403, 'a manager cannot edit order items (owner-only)');
      assertEqualOrThrow(
        itemStatus(order.itemId),
        'pending',
        'a refused edit leaves the item untouched',
      );

      const missingKey = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 3 },
        ownerAuth,
        null,
      );
      assertEqualOrThrow(missingKey.status, 400, 'missing Idempotency-Key is rejected with 400');

      const missingVersion = await api(
        baseUrl,
        `/api/orders/${order.orderId}/items/${order.itemId}/edit`,
        {
          method: 'PATCH',
          body: { quantity: 3 },
          headers: { ...ownerAuth, 'Idempotency-Key': nextKey('missing-ver') },
        },
      );
      assertEqualOrThrow(
        missingVersion.status,
        400,
        'missing expected_edit_version is rejected with 400',
      );
    }

    console.log('\n─── Retry & Concurrent-Edit Safety (Idempotency + edit_version) ───');
    {
      // Regression: preparing 3 -> 5 replay stays at 5; same key with different body returns 409
      const order = seedOrder(db, 'PREP-REPLAY', 'preparing', 3, 3);
      const stockBefore = stockOf(db);
      const replayKey = nextKey('prep-3-to-5');
      const first = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 5 },
        ownerAuth,
        replayKey,
      );
      assertEqualOrThrow(first.status, 200, 'first preparing 3 -> 5 succeeds');
      const editedLineAfterFirst = (first.data.order.items as any[]).find(
        (line) => line.id === order.itemId,
      );
      assertOrThrow(
        typeof editedLineAfterFirst?.edit_version === 'number' &&
          editedLineAfterFirst.edit_version > 0,
        'edit_version advances to latest item audit ID after edit',
      );

      const auditCountAfterFirst = Number(
        (
          db
            .prepare('SELECT COUNT(*) as cnt FROM order_audit_log WHERE order_id = ?')
            .get(order.orderId) as any
        ).cnt,
      );

      const replay = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 5 },
        ownerAuth,
        replayKey,
      );
      assertEqualOrThrow(replay.status, 200, 'replaying same key + request returns 200');
      const activeItems = (replay.data.order.items as any[]).filter(
        (line) => line.status !== 'cancelled' && line.status !== 'voided',
      );
      const totalQty = activeItems.reduce((sum, line) => sum + Number(line.quantity), 0);
      assertEqualOrThrow(totalQty, 5, 'preparing 3 -> 5 replay stays at total quantity 5');
      assertEqualOrThrow(
        stockOf(db),
        stockBefore - 2,
        'replay does not deduct stock a second time',
      );
      const auditCountAfterReplay = Number(
        (
          db
            .prepare('SELECT COUNT(*) as cnt FROM order_audit_log WHERE order_id = ?')
            .get(order.orderId) as any
        ).cnt,
      );
      assertEqualOrThrow(
        auditCountAfterReplay,
        auditCountAfterFirst,
        'replay writes no additional audit rows',
      );

      const conflictSameKey = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 6 },
        ownerAuth,
        replayKey,
      );
      assertEqualOrThrow(
        conflictSameKey.status,
        409,
        'reusing Idempotency-Key with a different request payload returns 409',
      );

      // Regression: two distinct stale edits (both with expected_edit_version: 0) cannot produce 7
      const staleSecondEdit = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 5 },
        ownerAuth,
        nextKey('stale-distinct'),
      );
      assertEqualOrThrow(
        staleSecondEdit.status,
        409,
        'distinct stale edit with outdated expected_edit_version returns 409',
      );
      const itemsAfterStale = db
        .prepare(
          "SELECT SUM(quantity) as total_qty FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided')",
        )
        .get(order.orderId) as any;
      assertEqualOrThrow(
        Number(itemsAfterStale.total_qty),
        5,
        'two distinct stale edits cannot produce 7',
      );
    }

    console.log('\n─── Pending Quantity Edit & Superseded Restore Rejection ───');
    {
      // Regression: pending 3 -> 2 restores product/add-on/recipe once, marks superseded, and cannot restore to 5
      const order = seedOrder(db, 'QTY-DOWN', 'pending', 3, 3);
      const snap3 = buildRecipeSnapshot(db, 'prod-edit', 3);
      const recipeSnapJson = JSON.stringify(snap3);
      db.prepare('UPDATE order_items SET recipe_snapshot = ? WHERE id = ?').run(
        recipeSnapJson,
        order.itemId,
      );
      applyRecipeSnapshot(db, snap3, {
        direction: 'deplete',
        actorUserId: 'owner-edit',
        referenceId: String(order.itemId),
      });
      db.prepare(
        `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, inventory_deducted_quantity, created_at)
         VALUES (?, 'addon-edit', 'Extra Shot', 20, 1, 3, ?)`,
      ).run(order.itemId, now());
      adjustProductStock(db, {
        productId: null,
        addonId: 'addon-edit',
        quantityDelta: -3,
        movementType: 'sale',
        referenceType: 'order_item',
        referenceId: String(order.itemId),
        actorUserId: 'owner-edit',
      });
      db.prepare('UPDATE order_items SET subtotal = 360, total = 360 WHERE id = ?').run(
        order.itemId,
      );
      db.prepare('UPDATE orders SET subtotal = 360, total = 360 WHERE id = ?').run(order.orderId);

      const bill = seedBill(db, order.orderId, 360, 0, 'unpaid');
      const prodStockBefore = stockOf(db);
      const addonStockBefore = stockOfAddon('addon-edit');
      const supplyStockBefore = stockOfSupply(beans.id);

      const pendingEditKey = nextKey('pending-3-to-2');
      const response = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 2, reason: 'typo' },
        ownerAuth,
        pendingEditKey,
      );
      assertEqualOrThrow(response.status, 200, 'owner can reduce a pending quantity');
      assertEqualOrThrow(itemStatus(order.itemId), 'cancelled', 'the original line is superseded');
      assertEqualOrThrow(orderTotal(order.orderId), 240, 'order total follows the new quantity');
      assertEqualOrThrow(
        stockOf(db),
        prodStockBefore + 1,
        'product stock net change is +1 (restored 3, deducted 2)',
      );
      assertEqualOrThrow(
        stockOfAddon('addon-edit'),
        addonStockBefore + 1,
        'add-on stock net change is +1 (restored 3, deducted 2)',
      );
      assertEqualOrThrow(
        stockOfSupply(beans.id),
        supplyStockBefore + 10,
        'recipe supply stock net change is +10g (restored 30g, deducted 20g)',
      );

      // Replay after original line became terminal ('cancelled') still returns 200!
      const replayTerminal = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 2, reason: 'typo' },
        ownerAuth,
        pendingEditKey,
      );
      assertEqualOrThrow(
        replayTerminal.status,
        200,
        'replaying same key after pending line was superseded still returns stored 200',
      );

      const updatedBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id) as any;
      assertEqualOrThrow(updatedBill.total, 240, 'the unpaid bill total is re-synced');
      assertEqualOrThrow(updatedBill.balance, 240, 'the unpaid bill balance is re-synced');
      const active = db
        .prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'")
        .all(order.orderId) as any[];
      assertEqualOrThrow(active.length, 1, 'one active line remains');
      assertEqualOrThrow(active[0].quantity, 2, 'the active line has the new quantity');
      assertEqualOrThrow(active[0].unit_price, 100, 'the original unit price is preserved');
      const audit = db
        .prepare("SELECT * FROM order_audit_log WHERE order_item_id = ? AND action = 'item_edited'")
        .get(order.itemId) as any;
      assertEqualOrThrow(audit?.actor_user_id, 'owner-edit', 'the edit is attributed to the owner');
      const auditDetails = JSON.parse(audit.details_json);
      assertEqualOrThrow(
        auditDetails.superseded,
        true,
        'pending edit audit records superseded: true',
      );

      // Attempt to restore the superseded cancelled line must fail with 400 and not produce 5
      const restoreAttempt = await api(
        baseUrl,
        `/api/orders/${order.orderId}/items/${order.itemId}/restore`,
        {
          method: 'PATCH',
          headers: ownerAuth,
        },
      );
      assertEqualOrThrow(
        restoreAttempt.status,
        400,
        'restoring a superseded cancelled line is rejected inside the transaction',
      );
      const activeQtyAfterRestoreAttempt = db
        .prepare(
          "SELECT SUM(quantity) as qty FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided')",
        )
        .get(order.orderId) as any;
      assertEqualOrThrow(
        Number(activeQtyAfterRestoreAttempt.qty),
        2,
        'pending 3 -> 2 cannot restore to 5',
      );
    }

    console.log(
      '\n─── Started Quantity Decrease (In-Place, No Stock Restore, Preserves Snapshots & Waste) ───',
    );
    {
      const order = seedOrder(db, 'QTY-DOWN-PREP', 'preparing', 3, 3);
      const snap3 = buildRecipeSnapshot(db, 'prod-edit', 3);
      const recipeSnapJson = JSON.stringify(snap3);
      db.prepare(
        `UPDATE order_items
         SET recipe_snapshot = ?, discount_amount = 36, subtotal = 324, total = 324
         WHERE id = ?`,
      ).run(recipeSnapJson, order.itemId);
      db.prepare(
        `INSERT INTO order_audit_log (order_id, order_item_id, actor_user_id, action, details_json, created_at)
         VALUES (?, ?, 'owner-edit', 'item_discount_applied', ?, ?)`,
      ).run(
        order.orderId,
        order.itemId,
        JSON.stringify({ discount_type: 'percentage', discount_value: 10 }),
        now(),
      );
      const initialEditVersion = Number(
        (
          db
            .prepare(
              'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
            )
            .get(order.orderId, order.itemId) as any
        ).v,
      );
      applyRecipeSnapshot(db, snap3, {
        direction: 'deplete',
        actorUserId: 'owner-edit',
        referenceId: String(order.itemId),
      });
      db.prepare(
        `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, inventory_deducted_quantity, created_at)
         VALUES (?, 'addon-edit', 'Extra Shot', 20, 1, 3, ?)`,
      ).run(order.itemId, now());
      adjustProductStock(db, {
        productId: null,
        addonId: 'addon-edit',
        quantityDelta: -3,
        movementType: 'sale',
        referenceType: 'order_item',
        referenceId: String(order.itemId),
        actorUserId: 'owner-edit',
      });
      db.prepare('UPDATE orders SET subtotal = 324, total = 324 WHERE id = ?').run(order.orderId);

      const prodStockBefore = stockOf(db);
      const addonStockBefore = stockOfAddon('addon-edit');
      const supplyStockBefore = stockOfSupply(beans.id);

      const response = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: initialEditVersion, quantity: 2, reason: 'guest changed mind' },
        ownerAuth,
      );
      assertEqualOrThrow(
        response.status,
        200,
        'owner can reduce a line the kitchen already started',
      );
      const allLines = db
        .prepare('SELECT * FROM order_items WHERE order_id = ?')
        .all(order.orderId) as any[];
      assertEqualOrThrow(
        allLines.length,
        1,
        'started decrease updates the existing row in place without cancelling/reinserting',
      );
      assertEqualOrThrow(allLines[0].id, order.itemId, 'original item ID is preserved');
      assertEqualOrThrow(
        allLines[0].status,
        'preparing',
        'the reduced line keeps its kitchen status',
      );
      assertEqualOrThrow(allLines[0].quantity, 2, 'billable quantity is updated to 2');
      assertEqualOrThrow(
        Number(allLines[0].inventory_deducted_quantity),
        3,
        'already-consumed inventory_deducted_quantity (3) is preserved on the line',
      );
      assertEqualOrThrow(
        allLines[0].recipe_snapshot,
        recipeSnapJson,
        'already-consumed recipe_snapshot is preserved on the line',
      );
      assertEqualOrThrow(
        Number(allLines[0].discount_amount),
        24,
        'item percentage discount is recomputed for the new billable quantity (10% of 240 = 24)',
      );
      assertEqualOrThrow(
        Number(allLines[0].total),
        216,
        'item total is recomputed (240 - 24 = 216)',
      );
      assertEqualOrThrow(
        orderTotal(order.orderId),
        216,
        'order total is recomputed via backend financial calculation',
      );
      const addonRow = db
        .prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?')
        .get(order.itemId) as any;
      assertEqualOrThrow(
        Number(addonRow.price),
        20,
        'stored add-on per-unit price (20) is preserved',
      );
      assertEqualOrThrow(
        Number(addonRow.inventory_deducted_quantity),
        3,
        'already-consumed add-on inventory_deducted_quantity (3) is preserved',
      );
      assertEqualOrThrow(
        stockOf(db),
        prodStockBefore,
        'started decrease restores NO product stock and does not re-deduct',
      );
      assertEqualOrThrow(
        stockOfAddon('addon-edit'),
        addonStockBefore,
        'started decrease restores NO add-on stock',
      );
      assertEqualOrThrow(
        stockOfSupply(beans.id),
        supplyStockBefore,
        'started decrease restores NO recipe/supply stock',
      );

      const audit = db
        .prepare("SELECT * FROM order_audit_log WHERE order_item_id = ? AND action = 'item_edited'")
        .get(order.itemId) as any;
      const details = JSON.parse(audit.details_json);
      assertEqualOrThrow(
        details.wasted_quantity,
        1,
        'started decrease records removed quantity as wasted_quantity in edit audit',
      );
      assertEqualOrThrow(
        details.superseded,
        false,
        'started decrease records superseded: false in edit audit',
      );
    }

    console.log('\n─── Started Quantity Increase & Legitimate Cancellation Classification ───');
    {
      const order = seedOrder(db, 'QTY-UP-PREP', 'preparing', 2, 2);
      const stockBefore = stockOf(db);
      const response = await edit(order.orderId, order.itemId, { quantity: 5 }, ownerAuth);
      assertEqualOrThrow(response.status, 200, 'owner can raise a quantity');
      assertEqualOrThrow(
        itemStatus(order.itemId),
        'preparing',
        'the started line is left as it is',
      );
      const extra = db
        .prepare('SELECT * FROM order_items WHERE order_id = ? AND id != ?')
        .get(order.orderId, order.itemId) as any;
      assertEqualOrThrow(extra?.quantity, 3, 'only the extra units become a new line');
      assertEqualOrThrow(extra?.status, 'pending', 'the extra line goes to the kitchen as pending');
      assertEqualOrThrow(orderTotal(order.orderId), 500, 'order total covers the new quantity');
      assertEqualOrThrow(stockOf(db), stockBefore - 3, 'stock is deducted for the extra units');

      // Regression: legitimate cancellation of an item (even on an order with edit audits) is NOT superseded and CAN be restored
      const cancelExtra = await api(
        baseUrl,
        `/api/orders/${order.orderId}/items/${extra.id}/cancel`,
        {
          method: 'PATCH',
          body: { reason: 'customer cancelled extra' },
          headers: ownerAuth,
        },
      );
      assertEqualOrThrow(
        cancelExtra.status,
        200,
        'ordinary cancellation of pending extra line succeeds',
      );
      const cancelledExtraHydrated = (cancelExtra.data.order.items as any[]).find(
        (line) => line.id === extra.id,
      );
      assertOrThrow(
        !cancelledExtraHydrated?.superseded,
        'legitimate cancellation is not flagged superseded',
      );

      // Also test ordinary cancellation of a pending line that was previously edited in-place or has a non-superseding edit audit
      const restoreExtra = await api(
        baseUrl,
        `/api/orders/${order.orderId}/items/${extra.id}/restore`,
        {
          method: 'PATCH',
          headers: ownerAuth,
        },
      );
      assertEqualOrThrow(
        restoreExtra.status,
        200,
        'ordinary eligible cancellation can still be restored',
      );
      assertEqualOrThrow(itemStatus(extra.id), 'pending', 'restored line returns to pending');
    }

    {
      const order = seedOrder(db, 'QTY-SAME', 'pending', 2);
      const response = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(response.status, 400, 'an unchanged quantity is rejected');
      const bad = await edit(order.orderId, order.itemId, { quantity: 0 }, ownerAuth);
      assertEqualOrThrow(bad.status, 400, 'a non-positive quantity is rejected');
      const both = await edit(
        order.orderId,
        order.itemId,
        { quantity: 3, replacement: { product_id: 'prod-other', quantity: 1 } },
        ownerAuth,
      );
      assertEqualOrThrow(both.status, 400, 'quantity and replacement together are rejected');
    }

    console.log('\n─── Superseded lines ───');
    {
      const order = seedOrder(db, 'SUPERSEDED', 'pending', 2);
      await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      const fetched = await api(baseUrl, `/api/orders/${order.orderId}`, { headers: ownerAuth });
      const lines = fetched.data.order.items as any[];
      const old = lines.find((line) => line.id === order.itemId);
      assertEqualOrThrow(old?.superseded, true, 'the replaced line is flagged superseded');
      assertOrThrow(
        !lines.find((line) => line.id !== order.itemId)?.superseded,
        'the new line is not flagged',
      );
    }

    console.log('\n─── Replacement (Pending vs Started) ───');
    {
      // Pending replacement: restores original stock, cancels original as superseded, deducts replacement
      const pendingOrder = seedOrder(db, 'REPLACE-PENDING', 'pending', 2, 2);
      const prodEditBefore = stockOfProduct('prod-edit');
      const prodOtherBefore = stockOfProduct('prod-other');
      const pendingResp = await edit(
        pendingOrder.orderId,
        pendingOrder.itemId,
        { replacement: { product_id: 'prod-other', quantity: 2 } },
        ownerAuth,
      );
      assertEqualOrThrow(pendingResp.status, 200, 'owner can replace a pending item');
      assertEqualOrThrow(
        itemStatus(pendingOrder.itemId),
        'cancelled',
        'pending replaced line is cancelled as superseded',
      );
      assertEqualOrThrow(
        stockOfProduct('prod-edit'),
        prodEditBefore + 2,
        'pending replacement restores original item stock',
      );
      assertEqualOrThrow(
        stockOfProduct('prod-other'),
        prodOtherBefore - 2,
        'pending replacement deducts replacement item stock',
      );

      // Started replacement: voids original WITHOUT restoring stock, preserves waste, creates and deducts replacement as pending
      const order = seedOrder(db, 'REPLACE-STARTED', 'preparing', 2, 2);
      const bill = seedBill(db, order.orderId, 200, 0, 'unpaid');
      const startedProdEditBefore = stockOfProduct('prod-edit');
      const startedProdOtherBefore = stockOfProduct('prod-other');
      const response = await edit(
        order.orderId,
        order.itemId,
        { replacement: { product_id: 'prod-other', quantity: 2 } },
        ownerAuth,
      );
      assertEqualOrThrow(response.status, 200, 'owner can replace a started item');
      assertEqualOrThrow(
        itemStatus(order.itemId),
        'voided',
        'started replaced line is voided (not cancelled)',
      );
      const hydratedOld = (response.data.order.items as any[]).find(
        (line) => line.id === order.itemId,
      );
      assertEqualOrThrow(
        hydratedOld?.superseded,
        true,
        'started voided replaced line is flagged superseded',
      );
      const fresh = db
        .prepare('SELECT * FROM order_items WHERE order_id = ? AND id != ?')
        .get(order.orderId, order.itemId) as any;
      assertEqualOrThrow(
        fresh?.product_id,
        'prod-other',
        'the replacement line is the new product',
      );
      assertEqualOrThrow(
        fresh?.status,
        'pending',
        'the replacement goes to the kitchen as pending',
      );
      assertEqualOrThrow(orderTotal(order.orderId), 300, 'order total uses the replacement price');
      assertEqualOrThrow(
        stockOfProduct('prod-edit'),
        startedProdEditBefore,
        'started replacement does NOT restore original item stock (preserves waste)',
      );
      assertEqualOrThrow(
        stockOfProduct('prod-other'),
        startedProdOtherBefore - 2,
        'started replacement deducts replacement item stock',
      );
      const audit = db
        .prepare("SELECT * FROM order_audit_log WHERE order_item_id = ? AND action = 'item_edited'")
        .get(order.itemId) as any;
      const details = JSON.parse(audit.details_json);
      assertEqualOrThrow(
        details.wasted_quantity,
        2,
        'started replacement records wasted_quantity in edit audit',
      );
      assertEqualOrThrow(
        details.superseded,
        true,
        'started replacement records superseded: true in edit audit',
      );
      assertEqualOrThrow(
        (db.prepare('SELECT total FROM bills WHERE id = ?').get(bill.id) as any).total,
        300,
        'the bill is re-synced',
      );

      // Verify bill print preview excludes cancelled/voided/superseded lines and matches totals
      const printPreview = await api(baseUrl, '/api/printers/print-bill', {
        method: 'POST',
        body: { billId: bill.id, preview: true },
        headers: ownerAuth,
      });
      assertEqualOrThrow(printPreview.status, 200, 'bill print preview succeeds after edit');
      const receiptText = String(printPreview.data?.text || '');
      assertOrThrow(
        receiptText.includes('Other item'),
        'bill receipt text includes the active replacement item',
      );
      assertOrThrow(
        !receiptText.includes('Edit item'),
        'bill receipt text excludes the voided/superseded original item',
      );
      assertOrThrow(
        receiptText.includes('300'),
        'bill receipt text includes the updated 300 total',
      );
      // Regression: historical bill copy with a refunded item retains the refunded sale line
      // while excluding the negative void_adjustment row so printed items match the bill total
      const refundOrder = seedOrder(db, 'REFUND-PRINT', 'served', 1, 1);
      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, inventory_deducted_quantity, created_at, updated_at)
         VALUES (?, 'prod-other', 'Other item', 150, 1, 150, 0, 150, 'refunded', 1, ?, ?)`,
      ).run(refundOrder.orderId, now(), now());
      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, inventory_deducted_quantity, created_at, updated_at)
         VALUES (?, 'prod-other', 'Refund: Other item', -150, 1, -150, 0, -150, 'void_adjustment', 0, ?, ?)`,
      ).run(refundOrder.orderId, now(), now());
      db.prepare('UPDATE orders SET subtotal = 250, total = 250 WHERE id = ?').run(
        refundOrder.orderId,
      );
      const refundBill = seedBill(db, refundOrder.orderId, 250, 250, 'partially_refunded');
      const refundPrintPreview = await api(baseUrl, '/api/printers/print-bill', {
        method: 'POST',
        body: { billId: refundBill.id, preview: true },
        headers: ownerAuth,
      });
      assertEqualOrThrow(refundPrintPreview.status, 200, 'refunded bill print preview succeeds');
      const refundReceiptText = String(refundPrintPreview.data?.text || '');
      assertOrThrow(
        refundReceiptText.includes('Edit item') && refundReceiptText.includes('Other item'),
        'historical bill copy includes both original sale lines including the refunded item',
      );
      assertOrThrow(
        !refundReceiptText.includes('Refund: Other item'),
        'historical bill copy excludes the negative void_adjustment row',
      );
    }

    console.log('\n─── Pending Stockout Reduction & Repeated Edit Discounts ───');
    {
      // Regression: pending line of qty 3 that consumed the last 3 tracked add-ons can be reduced to 2
      const order = seedOrder(db, 'PENDING-STOCKOUT', 'pending', 3, 3);
      const savedAddonStock = stockOfAddon('addon-edit');
      db.prepare(`UPDATE addons SET stock_quantity = 0 WHERE id = 'addon-edit'`).run();
      db.prepare(
        `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, inventory_deducted_quantity, created_at)
         VALUES (?, 'addon-edit', 'Extra Shot', 20, 1, 3, ?)`,
      ).run(order.itemId, now());
      db.prepare(`UPDATE order_items SET subtotal = 360, total = 360 WHERE id = ?`).run(
        order.itemId,
      );
      db.prepare(`UPDATE orders SET subtotal = 360, total = 360 WHERE id = ?`).run(order.orderId);

      const reduceAtStockout = await edit(
        order.orderId,
        order.itemId,
        { expected_edit_version: 0, quantity: 2 },
        ownerAuth,
      );
      assertEqualOrThrow(
        reduceAtStockout.status,
        200,
        'pending reduction from 3 to 2 succeeds even when add-on stock was 0 before edit',
      );
      assertEqualOrThrow(
        stockOfAddon('addon-edit'),
        1,
        'restoring 3 and deducting 2 leaves 1 add-on in stock',
      );
      db.prepare(`UPDATE addons SET stock_quantity = ? WHERE id = 'addon-edit'`).run(
        savedAddonStock,
      );

      // Regression: repeated pending edits on a fixed-amount discounted line preserve the fixed discount
      const fixedDiscOrder = seedOrder(db, 'FIXED-DISC-CHAIN', 'pending', 3, 3);
      db.prepare(
        `UPDATE order_items SET discount_amount = 30, subtotal = 270, total = 270 WHERE id = ?`,
      ).run(fixedDiscOrder.itemId);
      db.prepare(`UPDATE orders SET subtotal = 270, total = 270 WHERE id = ?`).run(
        fixedDiscOrder.orderId,
      );
      db.prepare(
        `INSERT INTO order_audit_log (order_id, order_item_id, actor_user_id, action, details_json, created_at)
         VALUES (?, ?, 'owner-edit', 'item_discount_applied', ?, ?)`,
      ).run(
        fixedDiscOrder.orderId,
        fixedDiscOrder.itemId,
        JSON.stringify({ discount_type: 'amount', discount_value: 30 }),
        now(),
      );
      const fixedV1 = Number(
        (
          db
            .prepare(
              'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
            )
            .get(fixedDiscOrder.orderId, fixedDiscOrder.itemId) as any
        ).v,
      );
      const editFixed1 = await edit(
        fixedDiscOrder.orderId,
        fixedDiscOrder.itemId,
        { expected_edit_version: fixedV1, quantity: 2 },
        ownerAuth,
      );
      assertEqualOrThrow(
        editFixed1.status,
        200,
        'first pending edit on fixed-discount line succeeds',
      );
      const intermediateFixed = (editFixed1.data.order.items as any[]).find(
        (line) => line.status === 'pending',
      );
      assertEqualOrThrow(
        Number(intermediateFixed.discount_amount),
        30,
        'first pending edit preserves fixed discount of 30',
      );
      const editFixed2 = await edit(
        fixedDiscOrder.orderId,
        intermediateFixed.id,
        { expected_edit_version: intermediateFixed.edit_version, quantity: 1 },
        ownerAuth,
      );
      assertEqualOrThrow(
        editFixed2.status,
        200,
        'second pending edit on fixed-discount line succeeds',
      );
      const finalFixed = (editFixed2.data.order.items as any[]).find(
        (line) => line.status === 'pending',
      );
      assertEqualOrThrow(
        Number(finalFixed.discount_amount),
        30,
        'second pending edit still preserves fixed discount of 30 instead of scaling to 15',
      );

      // Regression: percentage discount carried onto generated pending line is preserved on later started increase
      const pctDiscOrder = seedOrder(db, 'PCT-DISC-CHAIN', 'pending', 2, 2);
      db.prepare(
        `UPDATE order_items SET discount_amount = 20, subtotal = 180, total = 180 WHERE id = ?`,
      ).run(pctDiscOrder.itemId);
      db.prepare(`UPDATE orders SET subtotal = 180, total = 180 WHERE id = ?`).run(
        pctDiscOrder.orderId,
      );
      db.prepare(
        `INSERT INTO order_audit_log (order_id, order_item_id, actor_user_id, action, details_json, created_at)
         VALUES (?, ?, 'owner-edit', 'item_discount_applied', ?, ?)`,
      ).run(
        pctDiscOrder.orderId,
        pctDiscOrder.itemId,
        JSON.stringify({ discount_type: 'percentage', discount_value: 10 }),
        now(),
      );
      const pctV1 = Number(
        (
          db
            .prepare(
              'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
            )
            .get(pctDiscOrder.orderId, pctDiscOrder.itemId) as any
        ).v,
      );
      const editPct1 = await edit(
        pctDiscOrder.orderId,
        pctDiscOrder.itemId,
        { expected_edit_version: pctV1, quantity: 3 },
        ownerAuth,
      );
      assertEqualOrThrow(editPct1.status, 200, 'pending edit on percentage-discount line succeeds');
      const generatedPctLine = (editPct1.data.order.items as any[]).find(
        (line) => line.status === 'pending',
      );
      assertEqualOrThrow(
        Number(generatedPctLine.discount_amount),
        30,
        'generated pending line has 10% discount (30 on 300)',
      );
      db.prepare(`UPDATE order_items SET status = 'preparing' WHERE id = ?`).run(
        generatedPctLine.id,
      );
      const editPct2 = await edit(
        pctDiscOrder.orderId,
        generatedPctLine.id,
        { expected_edit_version: generatedPctLine.edit_version, quantity: 5 },
        ownerAuth,
      );
      assertEqualOrThrow(
        editPct2.status,
        200,
        'started increase on generated percentage-discount line succeeds',
      );
      const extraPctLine = (editPct2.data.order.items as any[]).find(
        (line) => line.status === 'pending' && line.id !== generatedPctLine.id,
      );
      assertEqualOrThrow(
        Number(extraPctLine?.discount_amount),
        20,
        'extra line from started increase preserves 10% discount (20 on 200)',
      );
    }

    console.log('\n─── Collected payments ───');
    {
      const order = seedOrder(db, 'PARTIAL-OK', 'pending', 3);
      const bill = seedBill(db, order.orderId, 300, 100, 'partial');
      const response = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(
        response.status,
        200,
        'editing is allowed after a partial payment when the total stays above it',
      );
      const updated = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id) as any;
      assertEqualOrThrow(updated.total, 200, 'the partially paid bill total is re-synced');
      assertEqualOrThrow(updated.balance, 100, 'the balance accounts for what was collected');
    }
    {
      const order = seedOrder(db, 'PARTIAL-LOW', 'pending', 3, 3);
      seedBill(db, order.orderId, 300, 250, 'partial');
      const stockBefore = stockOf(db);
      const response = await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      assertEqualOrThrow(
        response.status,
        409,
        'an edit that drops the total below the collected amount is refused',
      );
      assertEqualOrThrow(itemStatus(order.itemId), 'pending', 'the refused edit rolls back');
      assertEqualOrThrow(
        stockOf(db),
        stockBefore,
        'refused edit rolls back inventory changes completely',
      );
      assertEqualOrThrow(
        orderTotal(order.orderId),
        300,
        'the order total is unchanged after the refusal',
      );
    }
    {
      const order = seedOrder(db, 'PAID', 'pending', 2);
      seedBill(db, order.orderId, 200, 200, 'paid');
      const response = await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      assertEqualOrThrow(response.status, 409, 'a fully paid order cannot be edited');
    }

    console.log('\n─── Durable Attempt Storage (order-item-edit-attempt) ───');
    {
      const {
        clearOrderItemEditAttempt,
        isUnresolvedOrderItemEditFailure,
        newOrderItemEditAttempt,
        persistOrderItemEditAttempt,
        readOrderItemEditAttempt,
      } = require('../frontend/src/lib/order-item-edit-attempt');

      const store = new Map<string, string>();
      (globalThis as any).window = {
        localStorage: {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        },
      };

      const snapshot = newOrderItemEditAttempt({
        mode: 'quantity',
        path: '/orders/10/items/20/edit',
        orderId: 10,
        itemId: 20,
        body: { expected_edit_version: 4, quantity: 3 },
        actorId: 'owner-edit',
        tenantId: 1,
      });
      persistOrderItemEditAttempt(snapshot);
      const readBack = readOrderItemEditAttempt(1, 'owner-edit', 10, 20);
      assertEqualOrThrow(
        readBack?.idempotencyKey,
        snapshot.idempotencyKey,
        'persisted attempt reads back with matching idempotencyKey',
      );
      assertEqualOrThrow(
        readBack?.body.expected_edit_version,
        4,
        'persisted attempt preserves expected_edit_version',
      );

      let overwriteThrew = false;
      try {
        persistOrderItemEditAttempt(
          newOrderItemEditAttempt({
            mode: 'quantity',
            path: '/orders/10/items/20/edit',
            orderId: 10,
            itemId: 20,
            body: { expected_edit_version: 4, quantity: 5 },
            actorId: 'owner-edit',
            tenantId: 1,
          }),
        );
      } catch {
        overwriteThrew = true;
      }
      assertOrThrow(overwriteThrew, 'persisting into an occupied attempt slot throws');

      assertOrThrow(
        isUnresolvedOrderItemEditFailure(new Error('Network Error')),
        'network error is classified as unresolved',
      );
      assertOrThrow(
        isUnresolvedOrderItemEditFailure({ response: { status: 503 } }),
        '5xx error is classified as unresolved',
      );
      assertOrThrow(
        !isUnresolvedOrderItemEditFailure({ response: { status: 409 } }),
        '409 conflict is classified as resolved',
      );

      const cleared = clearOrderItemEditAttempt(1, 'owner-edit', 10, 20, snapshot.idempotencyKey);
      assertOrThrow(cleared, 'clearOrderItemEditAttempt clears matching key');
      assertEqualOrThrow(
        readOrderItemEditAttempt(1, 'owner-edit', 10, 20),
        null,
        'attempt slot is empty after clear',
      );
      delete (globalThis as any).window;
    }
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
