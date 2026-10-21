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
      '\n─── Started Quantity Decrease (In-Place, No Stock Movement, Waste Stays Out) ───',
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
        2,
        'the line keeps holding only the 2 remaining units; the wasted unit stays out of stock',
      );
      assertEqualOrThrow(
        allLines[0].recipe_snapshot,
        JSON.stringify(buildRecipeSnapshot(db, 'prod-edit', 2)),
        'the recipe snapshot shrinks to the 2 remaining units',
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
        2,
        'the add-on held stock shrinks to the 2 remaining units',
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

    console.log('\n─── Started decrease: later pending edit cannot resell wasted stock ───');
    {
      // Regression (Greptile P1): after a started 3 -> 2 wastes one unit,
      // moving the line back to pending and reducing 2 -> 1 must restore only
      // what the line still holds - never the wasted unit.
      const order = seedOrder(db, 'WASTE-KEEP', 'preparing', 3, 3);
      const snap3 = buildRecipeSnapshot(db, 'prod-edit', 3);
      db.prepare('UPDATE order_items SET recipe_snapshot = ? WHERE id = ?').run(
        JSON.stringify(snap3),
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
      db.prepare('UPDATE order_items SET subtotal = 300, total = 300 WHERE id = ?').run(
        order.itemId,
      );
      db.prepare('UPDATE orders SET subtotal = 300, total = 300 WHERE id = ?').run(order.orderId);
      seedBill(db, order.orderId, 300, 0, 'unpaid');

      const stock0 = stockOf(db);
      const addon0 = stockOfAddon('addon-edit');
      const supply0 = stockOfSupply(beans.id);

      const startedDown = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(startedDown.status, 200, 'owner can reduce a started quantity');
      assertEqualOrThrow(itemStatus(order.itemId), 'preparing', 'the started line stays as it is');
      assertEqualOrThrow(stockOf(db), stock0, 'a started decrease moves no product stock');
      assertEqualOrThrow(
        stockOfAddon('addon-edit'),
        addon0,
        'a started decrease moves no add-on stock',
      );
      assertEqualOrThrow(
        stockOfSupply(beans.id),
        supply0,
        'a started decrease moves no recipe stock',
      );
      const heldItem = db
        .prepare('SELECT inventory_deducted_quantity FROM order_items WHERE id = ?')
        .get(order.itemId) as any;
      assertEqualOrThrow(
        Number(heldItem.inventory_deducted_quantity),
        2,
        'the line keeps holding only the 2 remaining units',
      );

      // KDS sends the line back to the kitchen queue.
      db.prepare("UPDATE order_items SET status = 'pending', updated_at = ? WHERE id = ?").run(
        now(),
        order.itemId,
      );

      const pendingDown = await edit(
        order.orderId,
        order.itemId,
        {
          expected_edit_version: Number(
            (
              db
                .prepare(
                  'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
                )
                .get(order.orderId, order.itemId) as any
            ).v,
          ),
          quantity: 1,
        },
        ownerAuth,
      );
      assertEqualOrThrow(pendingDown.status, 200, 'owner can reduce the back-to-pending line');
      assertEqualOrThrow(
        stockOf(db),
        stock0 + 1,
        'net +1: restore the 2 held units, deduct the 1-unit line - the wasted unit stays out',
      );
      assertEqualOrThrow(stockOfAddon('addon-edit'), addon0 + 1, 'add-on waste stays out of stock');
      assertEqualOrThrow(
        stockOfSupply(beans.id),
        supply0 + 10,
        'recipe waste stays out of stock (restores 20g, re-depletes 10g)',
      );
    }

    console.log('\n─── Pending reduction keeps disabled variant and add-on selections ───');
    {
      // Regression (Greptile P2): disabling the sold variant or add-on must
      // not block reducing a pending line - no extra units are needed, so the
      // stored selections remain authoritative.
      db.prepare(
        `INSERT INTO product_variants (id, product_id, name, price, track_inventory, is_active, created_at, updated_at)
         VALUES ('var-edit', 'prod-edit', 'Large', 150, 0, 1, ?, ?)`,
      ).run(now(), now());
      const order = seedOrder(db, 'DISABLED-SEL', 'pending', 3, 3);
      db.prepare(
        'UPDATE order_items SET variant_id = ?, unit_price = 150, subtotal = 450, total = 450 WHERE id = ?',
      ).run('var-edit', order.itemId);
      db.prepare('UPDATE orders SET subtotal = 450, total = 450 WHERE id = ?').run(order.orderId);
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
      seedBill(db, order.orderId, 450, 0, 'unpaid');

      db.prepare("UPDATE product_variants SET is_active = 0 WHERE id = 'var-edit'").run();
      db.prepare("UPDATE addons SET is_active = 0 WHERE id = 'addon-edit'").run();

      const reduced = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(
        reduced.status,
        200,
        'a reduction succeeds even when the stored selections are disabled',
      );
      const active = db
        .prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'")
        .all(order.orderId) as any[];
      assertEqualOrThrow(active.length, 1, 'the replacement line is the only pending line');
      assertEqualOrThrow(active[0].quantity, 2, 'the reduced quantity is applied');
      assertEqualOrThrow(
        active[0].variant_id,
        'var-edit',
        'the stored variant selection is preserved',
      );
      const newAddons = db
        .prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?')
        .all(active[0].id) as any[];
      assertEqualOrThrow(newAddons.length, 1, 'the stored add-on selection is preserved');
      assertEqualOrThrow(newAddons[0].addon_id, 'addon-edit', 'the add-on id survives');

      // Conformance: only reductions preserve stored selections; a quantity
      // increase still re-validates them against the current catalog.
      const increase = await edit(order.orderId, active[0].id, { quantity: 3 }, ownerAuth);
      assertEqualOrThrow(
        increase.status,
        400,
        'a quantity increase re-validates the disabled selections and is rejected',
      );
    }

    console.log('\n─── Reduction of a pre-variant line once the product gains variants ───');
    {
      // A line sold before the product had variants carries variant_id null;
      // a later reduction must not demand a selection the line never had.
      db.prepare(
        `INSERT INTO product_variants (id, product_id, name, price, track_inventory, is_active, created_at, updated_at)
         VALUES ('var-late', 'prod-edit', 'Regular', 100, 0, 1, ?, ?)`,
      ).run(now(), now());
      const order = seedOrder(db, 'LATE-VARIANT', 'pending', 2, 2);
      const reduced = await edit(order.orderId, order.itemId, { quantity: 1 }, ownerAuth);
      assertEqualOrThrow(
        reduced.status,
        200,
        'reducing a pre-variant line succeeds after the product gains variants',
      );
      const active = db
        .prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'")
        .all(order.orderId) as any[];
      assertEqualOrThrow(active.length, 1, 'the replacement line exists');
      assertEqualOrThrow(active[0].quantity, 1, 'the reduced quantity is applied');
      assertEqualOrThrow(active[0].variant_id, null, 'the stored null selection is preserved');
      // Remove the variant again so later cases see the original variantless product.
      db.prepare("DELETE FROM product_variants WHERE id = 'var-late'").run();
    }

    console.log('\n─── Reduction carries the stored variant_selection snapshot verbatim ───');
    {
      // Renaming the variant after the sale must not rewrite the selection the
      // line was sold with.
      const order = seedOrder(db, 'SNAP-KEEP', 'pending', 3, 3);
      db.prepare(
        'UPDATE order_items SET variant_id = ?, variant_selection = ?, unit_price = 150 WHERE id = ?',
      ).run('var-edit', JSON.stringify({ id: 'var-edit', name: 'Large' }), order.itemId);
      db.prepare("UPDATE product_variants SET name = 'Huge' WHERE id = 'var-edit'").run();
      const reduced = await edit(order.orderId, order.itemId, { quantity: 2 }, ownerAuth);
      assertEqualOrThrow(reduced.status, 200, 'reduction of a line with a stored variant succeeds');
      const active = db
        .prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'")
        .all(order.orderId) as any[];
      assertEqualOrThrow(active.length, 1, 'the replacement line exists');
      const selection = JSON.parse(active[0].variant_selection);
      assertEqualOrThrow(
        selection.name,
        'Large',
        'the carried variant_selection snapshot survives the reduction unchanged',
      );
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
      const pendingBill = seedBill(db, pendingOrder.orderId, 200, 0, 'unpaid');
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
      assertEqualOrThrow(
        (db.prepare('SELECT total FROM bills WHERE id = ?').get(pendingBill.id) as any).total,
        300,
        'the pending order bill is re-synced to 300',
      );

      // Started replacement: rejected with 400 because kitchen prep has already started
      const order = seedOrder(db, 'REPLACE-STARTED', 'preparing', 2, 2);
      seedBill(db, order.orderId, 200, 0, 'unpaid');
      const response = await edit(
        order.orderId,
        order.itemId,
        { replacement: { product_id: 'prod-other', quantity: 2 } },
        ownerAuth,
      );
      assertEqualOrThrow(response.status, 400, 'replacing a started item is rejected with 400');
      assertEqualOrThrow(
        response.data.error,
        'Cannot replace an item once kitchen preparation has started; reduce quantity or void instead',
        'helpful error message returned for started replacement',
      );

      // Regression: pending quantity reduction scales stored recipe snapshot & deduction
      // even after catalog recipe has been modified.
      const catalogShiftOrder = seedOrder(db, 'CATALOG-SHIFT', 'pending', 3, 3);
      const shiftSnap = buildRecipeSnapshot(db, 'prod-edit', 3);
      db.prepare('UPDATE order_items SET recipe_snapshot = ? WHERE id = ?').run(
        JSON.stringify(shiftSnap),
        catalogShiftOrder.itemId,
      );
      applyRecipeSnapshot(db, shiftSnap, {
        direction: 'deplete',
        actorUserId: 'owner-edit',
        referenceId: String(catalogShiftOrder.itemId),
      });

      // Change catalog recipe from 10g to 20g beans
      db.prepare('UPDATE recipe_items SET quantity = 20 WHERE supply_id = ?').run(beans.id);
      const supplyBeforeShift = stockOfSupply(beans.id);

      const shiftResp = await edit(
        catalogShiftOrder.orderId,
        catalogShiftOrder.itemId,
        { quantity: 2 },
        ownerAuth,
      );
      assertEqualOrThrow(
        shiftResp.status,
        200,
        'pending reduction succeeds under catalog recipe shift',
      );
      assertEqualOrThrow(
        stockOfSupply(beans.id),
        supplyBeforeShift + 10,
        'scaled snapshot restores 30g and deducts 20g (net +10g), NOT deducting 40g (net -10g)',
      );
      // Restore recipe back to 10 for subsequent tests
      db.prepare('UPDATE recipe_items SET quantity = 10 WHERE supply_id = ?').run(beans.id);

      const noRecipeOrder = seedOrder(db, 'NO-RECIPE-PENDING', 'pending', 3, 3);
      db.prepare('UPDATE order_items SET recipe_snapshot = NULL WHERE id = ?').run(
        noRecipeOrder.itemId,
      );
      const supplyBeforeNoRecipe = stockOfSupply(beans.id);
      const noRecipeResp = await edit(
        noRecipeOrder.orderId,
        noRecipeOrder.itemId,
        { quantity: 2 },
        ownerAuth,
      );
      assertEqualOrThrow(
        noRecipeResp.status,
        200,
        'pending reduction succeeds when line had no recipe snapshot',
      );
      assertEqualOrThrow(
        stockOfSupply(beans.id),
        supplyBeforeNoRecipe,
        'reducing a line with no recipe snapshot does not deplete catalog recipe supplies',
      );
      const noRecipeNewItem = db
        .prepare('SELECT recipe_snapshot FROM order_items WHERE order_id = ? AND status = ?')
        .get(noRecipeOrder.orderId, 'pending') as any;
      assertEqualOrThrow(
        noRecipeNewItem?.recipe_snapshot,
        null,
        'new pending line keeps null recipe snapshot',
      );

      // Verify bill print preview excludes cancelled/voided/superseded lines and matches totals
      const printPreview = await api(baseUrl, '/api/printers/print-bill', {
        method: 'POST',
        body: { billId: pendingBill.id, preview: true },
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
          get length() {
            return store.size;
          },
          key: (i: number) => Array.from(store.keys())[i] ?? null,
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        },
        CustomEvent: class CustomEventTest {
          type: string;
          detail: unknown;
          constructor(type: string, init?: { detail?: unknown }) {
            this.type = type;
            this.detail = init?.detail;
          }
        },
        dispatchEvent: () => true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
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

    console.log('\n─── Scoped attempt discovery and replay semantics ───');
    {
      const {
        clearOrderItemEditAttempt,
        classifyOrderItemEditFailure,
        listOrderItemEditAttempts,
        newOrderItemEditAttempt,
        notifyOrderItemEditAttemptsChanged,
        orderItemEditAttemptsEquivalent,
        orderItemEditAttemptStorageKey,
        orderItemEditCanonicalPath,
        persistOrderItemEditAttempt,
        readOrderItemEditAttempt,
        replayOrderItemEditAttempt,
        subscribeOrderItemEditAttemptsChanged,
      } = require('../frontend/src/lib/order-item-edit-attempt');

      type AttemptSnapshot = {
        mode: string;
        path: string;
        orderId: number;
        itemId: number;
        idempotencyKey: string;
        body: { expected_edit_version: number; quantity?: number };
        actorId: string;
        tenantId: number;
        createdAt: string;
      };

      const store = new Map<string, string>();
      (globalThis as any).window = {
        localStorage: {
          get length() {
            return store.size;
          },
          key: (i: number) => Array.from(store.keys())[i] ?? null,
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        },
        customEventListeners: (() => {
          // Minimal event bus so subscribe/dispatch behave like the browser.
          const listeners = new Map<string, Set<(event: any) => void>>();
          return { listeners };
        })(),
        CustomEvent: class CustomEventTest {
          type: string;
          detail: unknown;
          constructor(type: string, init?: { detail?: unknown }) {
            this.type = type;
            this.detail = init?.detail;
          }
        },
        dispatchEvent: (event: any) => {
          const set = window.customEventListeners.listeners.get(event.type);
          set?.forEach((listener) => listener(event));
          return true;
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
          const set = window.customEventListeners.listeners.get(type) ?? new Set();
          set.add(listener);
          window.customEventListeners.listeners.set(type, set);
        },
        removeEventListener: (type: string, listener: (event: any) => void) => {
          window.customEventListeners.listeners.get(type)?.delete(listener);
        },
      };

      const snapshotFor = (itemId: number, overrides: Partial<AttemptSnapshot> = {}) => {
        const snapshot = newOrderItemEditAttempt({
          mode: 'quantity',
          path: orderItemEditCanonicalPath(30, itemId),
          orderId: 30,
          itemId,
          body: { expected_edit_version: 2, quantity: 2 },
          actorId: 'actor-scope',
          tenantId: 5,
        });
        return { ...snapshot, ...overrides };
      };

      // Valid in-scope records list; other scopes never appear.
      persistOrderItemEditAttempt(snapshotFor(40));
      persistOrderItemEditAttempt(snapshotFor(41));
      persistOrderItemEditAttempt(snapshotFor(40, { tenantId: 6 }));
      persistOrderItemEditAttempt(snapshotFor(40, { actorId: 'someone-else' }));
      const listed = listOrderItemEditAttempts(5, 'actor-scope', 30);
      assertEqualOrThrow(
        listed.attempts.map((a: any) => a.itemId).join(','),
        '40,41',
        'scoped listing returns only this tenant/actor/order, sorted by item',
      );
      assertOrThrow(!listed.hasUnreadableRecords, 'clean scope reports no unreadable records');

      // A stored path that is not the canonical PATCH path is never offered.
      store.set(
        orderItemEditAttemptStorageKey(5, 'actor-scope', 30, 42),
        JSON.stringify(snapshotFor(42, { path: '/orders/999/items/1/edit' })),
      );
      const withEvilPath = listOrderItemEditAttempts(5, 'actor-scope', 30);
      assertEqualOrThrow(
        withEvilPath.attempts.map((a: any) => a.itemId).join(','),
        '40,41',
        'a record with an arbitrary stored path is not offered',
      );
      assertOrThrow(
        withEvilPath.hasUnreadableRecords,
        'an out-of-contract record is reported as unreadable',
      );
      assertOrThrow(
        store.has(orderItemEditAttemptStorageKey(5, 'actor-scope', 30, 42)),
        'out-of-contract records are left intact',
      );

      // Malformed JSON in scope is flagged and kept, valid siblings still list.
      store.set(orderItemEditAttemptStorageKey(5, 'actor-scope', 30, 43), '{not json');
      const withMalformed = listOrderItemEditAttempts(5, 'actor-scope', 30);
      assertOrThrow(withMalformed.hasUnreadableRecords, 'malformed JSON is flagged');
      assertEqualOrThrow(
        withMalformed.attempts.length,
        2,
        'valid records remain recoverable beside a malformed one',
      );
      assertOrThrow(
        store.has(orderItemEditAttemptStorageKey(5, 'actor-scope', 30, 43)),
        'malformed JSON is left intact',
      );

      // Fractional quantities stay recoverable: the edit contract accepts
      // positive finite quantities; precision enforcement stays with the backend.
      persistOrderItemEditAttempt(
        snapshotFor(44, { body: { expected_edit_version: 2, quantity: 1.25 } }),
      );
      const withFractional = listOrderItemEditAttempts(5, 'actor-scope', 30);
      assertOrThrow(
        withFractional.attempts.some((a: any) => a.itemId === 44),
        'a fractional-quantity edit is offered for recovery',
      );
      // The malformed fixture record from the earlier block keeps the
      // unreadable flag on; the fractional offer itself proves validation.

      // Non-quantities are still out of contract.
      store.set(
        orderItemEditAttemptStorageKey(5, 'actor-scope', 30, 45),
        JSON.stringify(snapshotFor(45, { body: { expected_edit_version: 2, quantity: 0 } })),
      );
      const withZero = listOrderItemEditAttempts(5, 'actor-scope', 30);
      assertOrThrow(
        !withZero.attempts.some((a: any) => a.itemId === 45),
        'a zero-quantity record is not offered',
      );

      // Canonical path helper rejects fabricated URLs by construction.
      assertEqualOrThrow(
        orderItemEditCanonicalPath(30, 40),
        '/orders/30/items/40/edit',
        'replay paths are always derived from the validated IDs',
      );

      // Outcome classification: uncertain vs definitive vs auth barriers.
      assertEqualOrThrow(
        classifyOrderItemEditFailure({ response: { status: 401 } }),
        'authRequired',
        '401 keeps the record',
      );
      assertEqualOrThrow(
        classifyOrderItemEditFailure({ response: { status: 403 } }),
        'forbidden',
        '403 keeps the record',
      );
      assertEqualOrThrow(
        classifyOrderItemEditFailure({ response: { status: 429 } }),
        'rateLimited',
        '429 keeps the record',
      );
      assertEqualOrThrow(
        classifyOrderItemEditFailure({ response: { status: 409 } }),
        'rejected',
        '409 is a definitive rejection',
      );
      assertEqualOrThrow(
        classifyOrderItemEditFailure(new Error('Network Error')),
        'unresolved',
        'network errors are unresolved',
      );
      assertEqualOrThrow(
        classifyOrderItemEditFailure({ response: { status: 503 } }),
        'unresolved',
        '5xx is unresolved',
      );

      // Replay sends the stored path/body/key exactly once through the sender.
      let sent: any = null;
      const persistedReader = readOrderItemEditAttempt(5, 'actor-scope', 30, 40);
      assertOrThrow(persistedReader, 'a persisted record is readable for replay');
      const replay = require('../frontend/src/lib/order-item-edit-attempt') as any;
      const result = await replay.replayOrderItemEditAttempt({
        snapshot: persistedReader,
        send: async (path: string, body: any, idempotencyKey: string) => {
          sent = { path, body, idempotencyKey };
          return 'ok';
        },
      });
      assertEqualOrThrow(result.outcome, 'committed', 'replay reports committed');
      assertEqualOrThrow(sent.path, '/orders/30/items/40/edit', 'replay sends the canonical path');
      assertEqualOrThrow(sent.body.quantity, 2, 'replay sends the stored body unchanged');
      assertEqualOrThrow(
        sent.idempotencyKey,
        readOrderItemEditAttempt(5, 'actor-scope', 30, 40)?.idempotencyKey,
        'replay sends the stored idempotency key',
      );

      // Equivalence distinguishes same payload from changed payload.
      const reRead = readOrderItemEditAttempt(5, 'actor-scope', 30, 40);
      assertOrThrow(
        reRead && orderItemEditAttemptsEquivalent(reRead, persistedReader),
        'equivalence matches identical saved records',
      );
      assertOrThrow(
        reRead &&
          !orderItemEditAttemptsEquivalent(
            reRead,
            snapshotFor(40, { idempotencyKey: 'different' }),
          ),
        'equivalence rejects a different idempotency key',
      );

      // Scoped change notifications: same-tab publish, subscription filter.
      let notifications = 0;
      const scopeSubscription = subscribeOrderItemEditAttemptsChanged(
        { tenantId: 5, actorId: 'actor-scope', orderId: 30 },
        () => {
          notifications += 1;
        },
      );
      notifyOrderItemEditAttemptsChanged({ tenantId: 5, actorId: 'actor-scope', orderId: 30 });
      notifyOrderItemEditAttemptsChanged({ tenantId: 8, actorId: 'actor-scope', orderId: 30 });
      notifyOrderItemEditAttemptsChanged({ tenantId: 5, actorId: 'other', orderId: 30 });
      scopeSubscription();
      assertEqualOrThrow(notifications, 1, 'out-of-scope notifications are filtered');

      // Definitive rejection clears the attempt via clearOrderItemEditAttempt
      const toReject = snapshotFor(46, { idempotencyKey: 'key-46' });
      persistOrderItemEditAttempt(toReject);
      assertOrThrow(
        readOrderItemEditAttempt(5, 'actor-scope', 30, 46),
        'saved attempt exists before 409 rejection',
      );
      const replay409 = await replay.replayOrderItemEditAttempt({
        snapshot: toReject,
        send: async () => {
          const err: any = new Error('Conflict');
          err.response = { status: 409, data: { error: 'edit version conflict' } };
          throw err;
        },
      });
      assertEqualOrThrow(replay409.outcome, 'rejected', '409 is classified as rejected');
      const clearedOn409 = clearOrderItemEditAttempt(5, 'actor-scope', 30, 46, 'key-46');
      assertOrThrow(clearedOn409, 'clearing attempt on 409 rejection succeeds');
      assertEqualOrThrow(
        readOrderItemEditAttempt(5, 'actor-scope', 30, 46),
        null,
        'definitive rejection clears the stored attempt',
      );

      // In-lock equivalence check: if a record is modified while waiting for the lock,
      // orderItemEditAttemptsEquivalent returns false and prevents sending.
      const originalRecord = snapshotFor(47, { idempotencyKey: 'orig-key' });
      persistOrderItemEditAttempt(originalRecord);
      const changedRecord = snapshotFor(47, { idempotencyKey: 'changed-key' });
      assertOrThrow(
        !orderItemEditAttemptsEquivalent(originalRecord, changedRecord),
        'equivalence check catches mismatch before dispatch',
      );
      clearOrderItemEditAttempt(5, 'actor-scope', 30, 47, 'orig-key');

      // ─── N5 regression: PendingOrderItemEdits scope isolation (#1257) ───
      console.log('\n─── PendingOrderItemEdits scope isolation (#1257) ───');

      const savedModuleLoad = Module._load;
      const savedResolveFilename = (Module as any)._resolveFilename;
      const projectRoot = path.resolve(__dirname, '..');

      (Module as any)._resolveFilename = function (
        request: string,
        parent: any,
        isMain: boolean,
        options?: any,
      ) {
        if (request.startsWith('@/')) {
          return path.resolve(projectRoot, 'frontend/src', request.slice(2));
        }
        return savedResolveFilename.call(this, request, parent, isMain, options);
      };

      let uiStates: any[] = [];
      let uiStateIdx = 0;
      let uiRefs: any[] = [];
      let uiRefIdx = 0;
      let uiCallbacks: any[] = [];
      let uiCbIdx = 0;
      let uiEffects: any[] = [];
      let uiEffectIdx = 0;
      let uiPendingEffects: Array<() => void> = [];

      const uiReactHooks = {
        useState: (initial: any) => {
          const idx = uiStateIdx++;
          if (idx >= uiStates.length) {
            uiStates.push(typeof initial === 'function' ? initial() : initial);
          }
          const setState = (next: any) => {
            uiStates[idx] = typeof next === 'function' ? next(uiStates[idx]) : next;
          };
          return [uiStates[idx], setState];
        },
        useRef: (initial: any) => {
          const idx = uiRefIdx++;
          if (idx >= uiRefs.length) {
            uiRefs.push({ current: initial });
          }
          return uiRefs[idx];
        },
        useCallback: (fn: any, deps?: any[]) => {
          const idx = uiCbIdx++;
          const prev = uiCallbacks[idx];
          const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
          if (changed) {
            uiCallbacks[idx] = { fn, deps };
            return fn;
          }
          return prev.fn;
        },
        useEffect: (effect: any, deps?: any[]) => {
          const idx = uiEffectIdx++;
          const prev = uiEffects[idx];
          const changed =
            !prev ||
            !deps ||
            !prev.deps ||
            deps.length !== prev.deps.length ||
            deps.some((d, i) => !Object.is(d, prev.deps[i]));
          if (changed) {
            uiPendingEffects.push(() => {
              if (prev && typeof prev.cleanup === 'function') prev.cleanup();
              const cleanup = effect();
              uiEffects[idx] = { deps, cleanup };
            });
          }
        },
      };

      const mockApi: any = {
        patch: async () => ({ data: { order: {} } }),
      };

      Module._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === 'react') return uiReactHooks;
        if (request === 'react/jsx-runtime') {
          const jsx = (type: any, props: any, key?: any) => ({ type, props, key });
          return { jsx, jsxs: jsx, Fragment: 'Fragment' };
        }
        if (request === 'use-intl') {
          return { useTranslations: (ns: string) => (key: string) => `${ns}.${key}` };
        }
        if (request === 'lucide-react') {
          return { Loader2: () => null };
        }
        if (request === '@/components/ui/button') {
          return {
            Button: 'ButtonComponent',
          };
        }
        if (request === '@/store/auth') {
          const authState = { currentTenant: { id: 5 }, user: { id: 'actor-scope' } };
          const useAuthStore = () => authState;
          useAuthStore.getState = () => authState;
          return { useAuthStore };
        }
        if (request === '@/lib/permissions') {
          return { tenantCan: () => true };
        }
        if (request === '@/lib/api') {
          return { __esModule: true, default: mockApi };
        }
        if (request.startsWith('@/')) {
          return require(path.resolve(projectRoot, 'frontend/src', request.slice(2)));
        }
        return savedModuleLoad.apply(this, arguments as any);
      };

      const PendingOrderItemEdits =
        require('../frontend/src/components/orders/PendingOrderItemEdits').default;

      function collectUiElements(
        node: any,
        predicate: (el: any) => boolean,
        acc: any[] = [],
      ): any[] {
        if (Array.isArray(node)) {
          for (const child of node) collectUiElements(child, predicate, acc);
          return acc;
        }
        if (!node || typeof node !== 'object') return acc;
        if (predicate(node)) acc.push(node);
        const children = node.props?.children;
        if (children !== undefined) collectUiElements(children, predicate, acc);
        return acc;
      }

      function uiTreeContainsText(node: any, text: string): boolean {
        if (typeof node === 'string') return node.includes(text);
        if (typeof node === 'number') return String(node).includes(text);
        if (Array.isArray(node)) return node.some((child) => uiTreeContainsText(child, text));
        if (!node || typeof node !== 'object') return false;
        if (node.props?.children) return uiTreeContainsText(node.props.children, text);
        return false;
      }

      function flushUiEffects() {
        while (uiPendingEffects.length > 0) {
          const fn = uiPendingEffects.shift()!;
          fn();
        }
      }

      async function flushUiMicrotasks() {
        await new Promise((r) => queueMicrotask(r));
        await new Promise((r) => queueMicrotask(r));
        await new Promise((r) => setTimeout(r, 0));
      }

      function renderPendingEdits(props: any) {
        uiStateIdx = 0;
        uiRefIdx = 0;
        uiCbIdx = 0;
        uiEffectIdx = 0;
        return PendingOrderItemEdits(props);
      }

      function resetUiHarness() {
        for (const eff of uiEffects) {
          if (eff && typeof eff.cleanup === 'function') eff.cleanup();
        }
        uiStates = [];
        uiRefs = [];
        uiCallbacks = [];
        uiEffects = [];
        uiPendingEffects = [];
      }

      // ── a) Switching orderId clears notices immediately (including first frame) ──
      resetUiHarness();
      store.clear();

      persistOrderItemEditAttempt(
        newOrderItemEditAttempt({
          mode: 'quantity',
          path: orderItemEditCanonicalPath(101, 10),
          orderId: 101,
          itemId: 10,
          body: { expected_edit_version: 1, quantity: 2 },
          actorId: 'actor-scope',
          tenantId: 5,
        }),
      );

      let order101ResolveFinished: (() => void) | null = null;
      const order101ResolvePromise = new Promise<void>((r) => {
        order101ResolveFinished = r;
      });

      mockApi.patch = async () => {
        const err: any = new Error('Conflict');
        err.response = { status: 409, data: { error: 'edit version conflict' } };
        throw err;
      };

      const onItemEditResolvedA = async (targetOrderId: number) => {
        if (targetOrderId === 101 && order101ResolveFinished) {
          setTimeout(order101ResolveFinished, 10);
        }
        return false; // failed follow-up refresh
      };

      let treeA = renderPendingEdits({
        orderId: 101,
        items: [{ id: 10, product_name: 'Espresso' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedA,
      });
      flushUiEffects();
      await flushUiMicrotasks();
      treeA = renderPendingEdits({
        orderId: 101,
        items: [{ id: 10, product_name: 'Espresso' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedA,
      });

      const resolveBtnA = collectUiElements(
        treeA,
        (el) => el.type === 'ButtonComponent' && el.props?.onClick,
      )[0];
      assertOrThrow(resolveBtnA, 'resolve button exists for order 101 item 10');
      resolveBtnA.props.onClick();

      await order101ResolvePromise;
      await new Promise((r) => setTimeout(r, 25)); // await resolve finally block

      treeA = renderPendingEdits({
        orderId: 101,
        items: [{ id: 10, product_name: 'Espresso' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedA,
      });

      assertOrThrow(
        collectUiElements(
          treeA,
          (el) => el.props?.['data-testid'] === 'pending-item-edit-rejection',
        ).length > 0,
        'order 101 shows rejection notice after 409',
      );
      assertOrThrow(
        collectUiElements(
          treeA,
          (el) => el.props?.['data-testid'] === 'pending-item-edit-refresh-failed',
        ).length > 0,
        'order 101 shows refresh error after failed follow-up refresh',
      );

      // Switch orderId from 101 to 202: FIRST SYNCHRONOUS RENDER FRAME before effects or microtasks
      const treeA202SyncFrame = renderPendingEdits({
        orderId: 202,
        items: [{ id: 10, product_name: 'Croissant' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedA,
      });

      const rejections202Sync = collectUiElements(
        treeA202SyncFrame,
        (el) => el.props?.['data-testid'] === 'pending-item-edit-rejection',
      );
      const refreshErrors202Sync = collectUiElements(
        treeA202SyncFrame,
        (el) => el.props?.['data-testid'] === 'pending-item-edit-refresh-failed',
      );
      const retryButtons202Sync = collectUiElements(
        treeA202SyncFrame,
        (el) => el.props?.['data-testid'] === 'retry-refresh-button',
      );

      assertEqualOrThrow(
        rejections202Sync.length,
        0,
        'no rejection notices visible on first synchronous render frame of new orderId',
      );
      assertEqualOrThrow(
        refreshErrors202Sync.length,
        0,
        'no refresh errors visible on first synchronous render frame of new orderId',
      );
      assertEqualOrThrow(
        retryButtons202Sync.length,
        0,
        'no retry buttons visible on first synchronous render frame of new orderId',
      );
      assertOrThrow(
        !uiTreeContainsText(treeA202SyncFrame, 'Espresso') &&
          !uiTreeContainsText(treeA202SyncFrame, 'Croissant'),
        'no misattributed item label or notice on first synchronous render frame of new orderId',
      );
      assertEqualOrThrow(
        treeA202SyncFrame,
        null,
        'Order 202 with no pending edits renders null on first synchronous frame',
      );

      // After microtasks and effects run for Order 202, state must also be cleanly reset
      flushUiEffects();
      await flushUiMicrotasks();
      const treeA202AfterMicrotasks = renderPendingEdits({
        orderId: 202,
        items: [{ id: 10, product_name: 'Croissant' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedA,
      });
      assertEqualOrThrow(
        treeA202AfterMicrotasks,
        null,
        'Order 202 remains completely null after effects and microtasks flush',
      );

      // ── b) In-flight resolve / retryRefresh does not leak to new orderId ──
      // Sub-case 1: resolve() in flight during order switch
      resetUiHarness();
      store.clear();

      persistOrderItemEditAttempt(
        newOrderItemEditAttempt({
          mode: 'quantity',
          path: orderItemEditCanonicalPath(101, 10),
          orderId: 101,
          itemId: 10,
          body: { expected_edit_version: 1, quantity: 2 },
          actorId: 'actor-scope',
          tenantId: 5,
        }),
      );

      let patchResolverB: (() => void) | null = null;
      mockApi.patch = async () => {
        return new Promise((resolve, reject) => {
          patchResolverB = () => {
            const err: any = new Error('Conflict');
            err.response = { status: 409, data: { error: 'late 409 conflict' } };
            reject(err);
          };
        });
      };

      const refreshCallsB: number[] = [];
      const onItemEditResolvedB = async (targetOrderId: number) => {
        refreshCallsB.push(targetOrderId);
        return true;
      };

      let treeB = renderPendingEdits({
        orderId: 101,
        items: [{ id: 10, product_name: 'Espresso' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB,
      });
      flushUiEffects();
      await flushUiMicrotasks();
      treeB = renderPendingEdits({
        orderId: 101,
        items: [{ id: 10, product_name: 'Espresso' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB,
      });

      const resolveBtnB = collectUiElements(
        treeB,
        (el) => el.type === 'ButtonComponent' && el.props?.onClick,
      )[0];
      assertOrThrow(resolveBtnB, 'resolve button exists for order 101 in-flight test');
      resolveBtnB.props.onClick();

      await new Promise((r) => setTimeout(r, 15)); // wait until in-flight inside patch promise

      // Switch to Order 202 while resolve is in flight
      treeB = renderPendingEdits({
        orderId: 202,
        items: [],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB,
      });
      flushUiEffects();
      await flushUiMicrotasks();
      treeB = renderPendingEdits({
        orderId: 202,
        items: [],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB,
      });

      // Now settle the late 409 from Order 101
      assertOrThrow(patchResolverB, 'patchResolver was assigned');
      patchResolverB!();
      await new Promise((r) => setTimeout(r, 30));

      assertEqualOrThrow(
        refreshCallsB.length,
        0,
        'late completion from Order 101 does not call onItemEditResolved while viewing Order 202',
      );
      assertEqualOrThrow(
        readOrderItemEditAttempt(5, 'actor-scope', 101, 10),
        null,
        'Order 101 attempt is still cleared from localStorage upon 409 rejection',
      );

      const treeB202AfterLatePatch = renderPendingEdits({
        orderId: 202,
        items: [],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB,
      });
      assertEqualOrThrow(
        treeB202AfterLatePatch,
        null,
        'Order 202 has no notices or banners from late Order 101 completion',
      );

      // Sub-case 2: retryRefresh() in flight during order switch
      resetUiHarness();
      store.clear();

      persistOrderItemEditAttempt(
        newOrderItemEditAttempt({
          mode: 'quantity',
          path: orderItemEditCanonicalPath(101, 11),
          orderId: 101,
          itemId: 11,
          body: { expected_edit_version: 1, quantity: 3 },
          actorId: 'actor-scope',
          tenantId: 5,
        }),
      );

      mockApi.patch = async () => ({ data: { order: { id: 101 } } });

      let refreshResolverB2: ((val: boolean) => void) | null = null;
      const onItemEditResolvedB2 = async (targetOrderId: number) => {
        if (targetOrderId === 101) {
          return new Promise<boolean>((resolve) => {
            refreshResolverB2 = resolve;
          });
        }
        return true;
      };

      let treeB2 = renderPendingEdits({
        orderId: 101,
        items: [{ id: 11, product_name: 'Mocha' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB2,
      });
      flushUiEffects();
      await flushUiMicrotasks();
      treeB2 = renderPendingEdits({
        orderId: 101,
        items: [{ id: 11, product_name: 'Mocha' }],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB2,
      });

      const resolveBtnB2 = collectUiElements(
        treeB2,
        (el) => el.type === 'ButtonComponent' && el.props?.onClick,
      )[0];
      assertOrThrow(resolveBtnB2, 'resolve button exists for retryRefresh test');
      resolveBtnB2.props.onClick();

      await new Promise((r) => setTimeout(r, 20)); // committed, waiting in retryRefresh

      // Switch to Order 202 while retryRefresh is in flight
      treeB2 = renderPendingEdits({
        orderId: 202,
        items: [],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB2,
      });
      flushUiEffects();
      await flushUiMicrotasks();
      treeB2 = renderPendingEdits({
        orderId: 202,
        items: [],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB2,
      });

      // Now late refresh fails
      assertOrThrow(refreshResolverB2, 'refreshResolverB2 was assigned');
      refreshResolverB2!(false);
      await new Promise((r) => setTimeout(r, 25));

      const treeB202AfterLateRefresh = renderPendingEdits({
        orderId: 202,
        items: [],
        canEditItems: true,
        onItemEditResolved: onItemEditResolvedB2,
      });
      assertEqualOrThrow(
        treeB202AfterLateRefresh,
        null,
        'Order 202 has no refresh errors from late retryRefresh completion',
      );

      // ── c) OrderDetailPanel wiring check ──
      const orderDetailPanelSource = fs.readFileSync(
        path.join(projectRoot, 'frontend/src/components/orders/OrderDetailPanel.tsx'),
        'utf8',
      );
      assertOrThrow(
        orderDetailPanelSource.includes('<OrderDetailContent key={props.order.id}'),
        'OrderDetailContent has key={props.order.id}',
      );
      assertOrThrow(
        /<PendingOrderItemEdits\s+key=\{order\.id\}/.test(orderDetailPanelSource),
        'PendingOrderItemEdits has key={order.id}',
      );

      // Clean up harnesses and restores
      resetUiHarness();
      Module._load = savedModuleLoad;
      (Module as any)._resolveFilename = savedResolveFilename;

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
