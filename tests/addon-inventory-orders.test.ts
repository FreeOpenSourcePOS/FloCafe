/**
 * Behavioral coverage for the add-on inventory order lifecycle (#358).
 *
 * An add-on with its own stock pool has to be as load-bearing on the order path
 * as a product or a variant pool, so these assert the whole cycle: the quantity
 * a line consumes is the item quantity times the add-on quantity, a tracked
 * add-on that cannot cover that requirement refuses the order instead of
 * selling into a negative pool, cancel returns exactly what the line took, item
 * restore re-deducts the recorded snapshot rather than recomputing it from the
 * catalog, and a kitchen void stays a waste. Every movement carries the
 * authenticated operator and an addon_id, and every add-on pool still reconciles
 * against its own ledger afterwards.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/addon-inventory-orders.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-inventory-orders-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assertEqualOrThrow, assertOrThrow, assertIncludesOrThrow,
  getResults, resetCounters, closeDatabase, now,
} = require('./helpers/test-setup');
const { validateInventoryLedgerDatabase, withTxn } = require('../main/db');
const { adjustProductStock } = require('../main/services/inventory');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

const OAT = 'addon-oat-milk';
const WHOLE = 'addon-whole-milk';

/** Stock a pool holds right now. */
const stockOf = (db: any, addonId: string) =>
  Number((db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get(addonId) as any)?.stock_quantity ?? 0);

/** Every ledger row an add-on pool has accumulated, oldest first. */
const movementsFor = (db: any, addonId: string): any[] =>
  db.prepare('SELECT * FROM inventory_movements WHERE addon_id = ? ORDER BY id').all(addonId);

/** What a line recorded it took, per add-on row. */
const snapshotOf = (db: any, orderItemId: any) =>
  db.prepare('SELECT addon_id, addon_name, quantity, inventory_deducted_quantity FROM order_item_addons WHERE order_item_id = ? ORDER BY id').all(orderItemId) as any[];

/**
 * Every pool must reconcile against its own ledger: an add-on chain that the
 * validator cannot attribute to `addons.stock_quantity` is exactly the silent
 * failure this feature exists to prevent.
 */
function assertPoolsReconcile(db: any, note: string) {
  assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, `add-on pools reconcile after ${note}`);
}

async function main() {
  console.log('Integration Test: add-on inventory order lifecycle (#358)');
  console.log('='.repeat(66));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);

  seedCategory(db, 'cat-addon-inv', 'Addon Inventory');
  // Zero product stock on purpose: the products here are untracked menu lines,
  // and a seeded stock figure with no ledger behind it is what the backup
  // validator is there to reject.
  seedProduct(db, 'prod-burger', 'cat-addon-inv', 'Burger', 100, { tax_type: 'none', stock_quantity: 0 });
  seedProduct(db, 'prod-wrap', 'cat-addon-inv', 'Wrap', 100, { tax_type: 'none', stock_quantity: 0 });

  // Group limits are deliberately wide open: this fixture is about the add-on
  // stock pool, not about the group caps enforced elsewhere.
  db.prepare(`INSERT INTO addon_groups (id, name, min_selection, max_selection, allow_multiple_quantities, is_required, is_active, created_at, updated_at)
    VALUES ('grp-milk', 'Milk Options', 0, NULL, 1, 0, 1, ?, ?)`).run(now(), now());
  // Oat milk is the tracked pool this feature is about; whole milk is the
  // untracked control that must keep moving with no stock at all.
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
    VALUES (?, 'grp-milk', 'Oat Milk', 1.5, 1, 1, 40, 5, ?, ?)`).run(OAT, now(), now());
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, track_inventory, stock_quantity, created_at, updated_at)
    VALUES (?, 'grp-milk', 'Whole Milk', 0, 1, 0, 0, ?, ?)`).run(WHOLE, now(), now());
  db.prepare(`INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('prod-burger', 'grp-milk')`).run();
  db.prepare(`INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('prod-wrap', 'grp-milk')`).run();
  // Opening stock has to exist as a ledger event: a pool whose first movement
  // does not equal its own resulting stock is one the backup validator rejects.
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, addon_id, quantity_delta, movement_type, reference_type, reference_id, reason, actor_user_id, stock_after, created_at)
    VALUES (NULL, NULL, ?, 40, 'adjustment', 'opening_balance', NULL, 'Opening stock', ?, 40, ?)`).run(OAT, owner.userId, now());

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);

  const createOrder = (headers: any, items: any[]) =>
    api(baseUrl, '/api/orders', { method: 'POST', headers, body: { type: 'takeaway', items } });
  const burgerWith = (quantity: number, addons: any[]) => ({ product_id: 'prod-burger', quantity, addons });
  const oatMovement = (db: any, index: number) => movementsFor(db, OAT)[index];

  try {
    console.log('\n--- A line consumes item quantity x add-on quantity ---');
    {
      // Three burgers with two extra oat milk each: six, not two.
      const res = await createOrder(owner.authHeader, [burgerWith(3, [{ id: OAT, quantity: 2 }])]);
      assertEqualOrThrow(res.status, 201, 'the order is created');
      const item = res.data.order.items[0];
      assertEqualOrThrow(stockOf(db, OAT), 34, 'the tracked pool is debited by the multiplied requirement');
      const snapshot = snapshotOf(db, item.id);
      assertEqualOrThrow(snapshot.length, 1, 'the line records one add-on row');
      assertEqualOrThrow(snapshot[0].addon_id, OAT, 'the row names the catalog add-on');
      assertEqualOrThrow(snapshot[0].quantity, 2, 'the row keeps the customer-facing add-on quantity');
      assertEqualOrThrow(snapshot[0].inventory_deducted_quantity, 6, 'the row snapshots the multiplied deduction');

      const sale = oatMovement(db, 1);
      assertEqualOrThrow(sale.movement_type, 'sale', 'the debit is a sale movement');
      assertEqualOrThrow(sale.addon_id, OAT, 'the ledger row names the add-on pool');
      assertEqualOrThrow(sale.product_id, null, 'an add-on pool movement names no product');
      assertEqualOrThrow(sale.quantity_delta, -6, 'the ledger row carries the full multiplied debit');
      assertEqualOrThrow(sale.stock_after, 34, 'the ledger row records the resulting pool');
      assertEqualOrThrow(sale.actor_user_id, owner.userId, 'the ledger attributes the authenticated operator');
      assertEqualOrThrow(sale.reference_type, 'order_item', 'the ledger points at the order line');
      assertPoolsReconcile(db, 'a tracked sale');
    }
    {
      // An untracked add-on has no pool to move, whatever its stock column says.
      const res = await createOrder(owner.authHeader, [burgerWith(1, [{ id: WHOLE, quantity: 2 }])]);
      assertEqualOrThrow(res.status, 201, 'an untracked add-on still orders normally');
      assertEqualOrThrow(movementsFor(db, WHOLE).length, 0, 'an untracked add-on writes no ledger row');
      assertEqualOrThrow(stockOf(db, WHOLE), 0, 'an untracked add-on keeps its zero stock');
      assertEqualOrThrow(snapshotOf(db, res.data.order.items[0].id)[0].inventory_deducted_quantity, 0, 'an untracked add-on snapshots no deduction');
    }

    console.log('\n--- A tracked add-on that cannot cover the line refuses the order ---');
    {
      const before = stockOf(db, OAT);
      const ordersBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n);
      // Three items of this add-on cannot fit in what is left in the pool.
      const perItem = Math.floor(before / 3) + 1;
      const res = await createOrder(owner.authHeader, [burgerWith(3, [{ id: OAT, quantity: perItem }])]);
      assertEqualOrThrow(res.status, 400, 'an order the pool cannot cover is refused');
      assertIncludesOrThrow(res.data.error, 'Oat Milk', 'the refusal names the add-on');
      assertIncludesOrThrow(res.data.error, `requested ${perItem * 3}`, 'the refusal names the requested amount');
      assertIncludesOrThrow(res.data.error, `available ${before}`, 'the refusal names the available amount');
      assertEqualOrThrow(stockOf(db, OAT), before, 'a refused order moves no stock');
      assertEqualOrThrow(Number((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n), ordersBefore, 'a refused order writes no order row');
      assertPoolsReconcile(db, 'a refused sale');
    }
    {
      // Two lines can each pass the per-line check and jointly exceed the pool.
      // The ledger guard is what catches that, so the refusal still names the
      // add-on and no part of the order survives.
      const before = stockOf(db, OAT);
      const half = Math.floor(before / 2) + 1;
      const eachItem = burgerWith(1, [{ id: OAT, quantity: half }]);
      const res = await createOrder(owner.authHeader, [eachItem, eachItem]);
      assertEqualOrThrow(res.status, 400, 'lines that jointly exceed the pool are refused together');
      assertIncludesOrThrow(res.data.error, 'Oat Milk', 'the aggregate refusal names the add-on');
      assertEqualOrThrow(stockOf(db, OAT), before, 'the rolled-back order moves no stock at all');
      assertPoolsReconcile(db, 'an over-committed order');
    }
    {
      // Appending to a live order enforces the same rule.
      const order = (await createOrder(owner.authHeader, [burgerWith(1, [])])).data.order;
      const before = stockOf(db, OAT);
      const res = await api(baseUrl, `/api/orders/${order.id}/items`, {
        method: 'POST', headers: owner.authHeader, body: { items: [burgerWith(1, [{ id: OAT, quantity: before + 1 }])] },
      });
      assertEqualOrThrow(res.status, 400, 'appending a line the pool cannot cover is refused');
      assertIncludesOrThrow(res.data.error, 'Oat Milk', 'the append refusal names the add-on');
      assertEqualOrThrow(stockOf(db, OAT), before, 'the refused append moves no stock');
      assertEqualOrThrow(Number((db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(order.id) as any).n), 1, 'the refused append writes no line');
    }
    {
      // A line exactly equal to what is left is allowed: refusing at the
      // boundary would make the pool unusable.
      const before = stockOf(db, OAT);
      const res = await createOrder(owner.authHeader, [burgerWith(1, [{ id: OAT, quantity: before }])]);
      assertEqualOrThrow(res.status, 201, 'a line consuming exactly the remaining pool is accepted');
      assertEqualOrThrow(stockOf(db, OAT), 0, 'the pool lands on zero, not below it');
      const refill = await api(baseUrl, `/api/orders/${res.data.order.id}/status`, {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'cancelled' },
      });
      assertEqualOrThrow(refill.status, 200, 'the emptied order cancels');
      assertEqualOrThrow(stockOf(db, OAT), before, 'cancelling returns the whole pool');
    }

    console.log('\n--- Cancelling the order restores exactly what the lines took ---');
    {
      const before = stockOf(db, OAT);
      const order = (await createOrder(owner.authHeader, [
        burgerWith(2, [{ id: OAT, quantity: 3 }]),
        { product_id: 'prod-wrap', quantity: 1, addons: [{ id: OAT, quantity: 1 }] },
      ])).data.order;
      assertEqualOrThrow(stockOf(db, OAT), before - 7, 'the two lines debit 6 and 1');
      const movementsBefore = movementsFor(db, OAT).length;

      const res = await api(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH', headers: manager.authHeader, body: { status: 'cancelled', reason: 'customer left' },
      });
      assertEqualOrThrow(res.status, 200, 'the order cancels');
      assertEqualOrThrow(stockOf(db, OAT), before, 'cancelling returns exactly what the lines took');

      const restores = movementsFor(db, OAT).slice(movementsBefore);
      assertEqualOrThrow(restores.length, 2, 'each debited line appends its own restore movement');
      assertEqualOrThrow(restores[0].movement_type, 'cancel_restore', 'a restore is a cancel_restore movement');
      assertEqualOrThrow(restores[0].quantity_delta, 6, 'the first line restores its own 6');
      assertEqualOrThrow(restores[1].quantity_delta, 1, 'the second line restores its own 1');
      assertEqualOrThrow(restores[0].actor_user_id, manager.userId, 'the restore attributes the operator who cancelled');
      assertIncludesOrThrow(String(restores[0].reason), 'customer left', 'the restore carries the cancellation reason');

      // Cancelling again must not hand the pool a second time.
      const again = await api(baseUrl, `/api/orders/${order.id}/status`, {
        method: 'PATCH', headers: manager.authHeader, body: { status: 'cancelled' },
      });
      assertEqualOrThrow(again.status, 200, 're-cancelling is accepted');
      assertEqualOrThrow(stockOf(db, OAT), before, 're-cancelling is idempotent and does not re-restock');
      assertPoolsReconcile(db, 'a whole-order cancel');
    }

    console.log('\n--- A voided line is a waste, not a return ---');
    {
      const before = stockOf(db, OAT);
      const order = (await createOrder(owner.authHeader, [burgerWith(2, [{ id: OAT, quantity: 3 }])])).data.order;
      const itemId = order.items[0].id;
      assertEqualOrThrow(stockOf(db, OAT), before - 6, 'the line debited 6');
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(itemId);
      const movementsBefore = movementsFor(db, OAT).length;

      const res = await api(baseUrl, `/api/orders/${order.id}/items/${itemId}/cancel`, {
        method: 'PATCH', headers: owner.authHeader, body: { override_pin: '1234' },   // seedManagerUser's manager PIN
      });
      assertEqualOrThrow(res.status, 200, 'the in-progress line voids');
      assertEqualOrThrow((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemId) as any).status, 'voided', 'the line is marked voided');
      assertEqualOrThrow(stockOf(db, OAT), before - 6, 'voiding does not return the add-on stock');
      assertEqualOrThrow(movementsFor(db, OAT).length, movementsBefore, 'the void appends no add-on movement at all');
      assertPoolsReconcile(db, 'a void');
    }

    console.log('\n--- Cancelling and restoring one line moves the snapshot amount ---');
    {
      const before = stockOf(db, OAT);
      // A second untracked line keeps the order live: cancelling its only
      // active line would auto-cancel the order and close the restore route.
      const order = (await createOrder(owner.authHeader, [
        burgerWith(2, [{ id: OAT, quantity: 3 }]),
        { product_id: 'prod-wrap', quantity: 1 },
      ])).data.order;
      const itemId = (db.prepare('SELECT order_item_id FROM order_item_addons WHERE addon_id = ? ORDER BY id DESC LIMIT 1').get(OAT) as any).order_item_id;

      const cancelled = await api(baseUrl, `/api/orders/${order.id}/items/${itemId}/cancel`, {
        method: 'PATCH', headers: manager.authHeader, body: { reason: 'sent back' },
      });
      assertEqualOrThrow(cancelled.status, 200, 'a pending line cancels');
      assertEqualOrThrow(stockOf(db, OAT), before, 'cancelling the line returns its 6');

      // The merchant restocks the pool while the line sits cancelled. The
      // restore must still take the recorded 6, not anything recomputed - and
      // the restock goes through the ledger so the chain stays intact.
      withTxn(() => adjustProductStock(db, {
        productId: null,
        addonId: OAT,
        quantityDelta: 100,
        movementType: 'adjustment',
        referenceType: 'restock',
        reason: 'Delivery received',
        actorUserId: manager.userId,
      }));
      const inflated = stockOf(db, OAT);

      const restored = await api(baseUrl, `/api/orders/${order.id}/items/${itemId}/restore`, {
        method: 'PATCH', headers: manager.authHeader, body: {},
      });
      assertEqualOrThrow(restored.status, 200, 'the cancelled line restores');
      assertEqualOrThrow((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemId) as any).status, 'pending', 'the restored line is active again');
      assertEqualOrThrow(stockOf(db, OAT), inflated - 6, 'restore re-deducts the recorded snapshot, not a recomputation');
      assertEqualOrThrow(snapshotOf(db, itemId)[0].inventory_deducted_quantity, 6, 'the snapshot row is unchanged by the restore');

      // Cancelling the live line again is a real cancel; cancelling it once more
      // is a no-op, and neither may hand the pool a second time.
      const recancel = await api(baseUrl, `/api/orders/${order.id}/items/${itemId}/cancel`, {
        method: 'PATCH', headers: manager.authHeader, body: {},
      });
      assertEqualOrThrow(recancel.status, 200, 'the restored line cancels again');
      assertEqualOrThrow(stockOf(db, OAT), inflated, 'the second cancel returns the snapshot 6 once more');
      const noopCancel = await api(baseUrl, `/api/orders/${order.id}/items/${itemId}/cancel`, {
        method: 'PATCH', headers: manager.authHeader, body: {},
      });
      assertEqualOrThrow(noopCancel.status, 200, 'cancelling an already-cancelled line is accepted');
      assertEqualOrThrow(stockOf(db, OAT), inflated, 'cancelling an already-cancelled line moves no add-on stock');
      await api(baseUrl, `/api/orders/${order.id}/items/${itemId}/restore`, { method: 'PATCH', headers: manager.authHeader, body: {} });
      assertEqualOrThrow(stockOf(db, OAT), inflated - 6, 'restoring an already-active line moves no add-on stock');
      assertPoolsReconcile(db, 'a line cancel and restore');
    }

    console.log('\n--- A line with no tracked add-on writes no add-on movement ---');
    {
      const movementsBefore = movementsFor(db, OAT).length;
      const order = (await createOrder(owner.authHeader, [burgerWith(1, [])])).data.order;
      await api(baseUrl, `/api/orders/${order.id}/status`, { method: 'PATCH', headers: manager.authHeader, body: { status: 'cancelled' } });
      assertEqualOrThrow(movementsFor(db, OAT).length, movementsBefore, 'cancelling an untracked line appends no add-on movement');
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

main().catch((error: any) => { console.error(error); process.exit(1); });
