/**
 * Add-on inventory, end to end (#358).
 *
 * One story, one fixture, one database: the registry carries the add-on stock
 * columns, the catalog takes a tracked add-on with opening stock, a till sells
 * it and is refused when the pool cannot cover the line, cancelling gives back
 * exactly what was taken, a void stays a waste, a restore re-deducts the
 * recorded snapshot, and the POS refuses to sell a row the pool has emptied.
 *
 * Every assertion is on observable behaviour - a stock figure, a ledger row, an
 * HTTP status, a message - so a regression has to break one of those to pass.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/addon-inventory-lifecycle.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-inventory-lifecycle-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assertEqualOrThrow, assertIncludesOrThrow, assertOrThrow,
  getResults, resetCounters, closeDatabase, now,
} = require('./helpers/test-setup');
const { MIGRATIONS, validateInventoryLedgerDatabase } = require('../main/db');
const { addonGroupRoutes } = require('../main/routes/addon-groups');
const { orderRoutes } = require('../main/routes/orders');
const { isAddonSoldOut, isAddonLowStock, addonStockCeiling } = require('../frontend/src/lib/addon-inventory');

/** Version the add-on inventory migration ships as, and the registry tail it must own. */
const ADDON_MIGRATION_VERSION = 103;
// The catalog assigns the ids, so these are filled in once the group is created.
let OAT = '';
let WHOLE = '';
/** Reorder threshold the fixture creates the pool with. */
const OAT_THRESHOLD = 8;

/** Stock a pool holds right now. */
const stockOf = (db: any, addonId: string) =>
  Number((db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get(addonId) as any)?.stock_quantity ?? 0);

/** Every ledger row an add-on pool has accumulated, oldest first. */
const movementsFor = (db: any, addonId: string): any[] =>
  db.prepare('SELECT * FROM inventory_movements WHERE addon_id = ? ORDER BY id').all(addonId);

/** What a line recorded it took, per add-on row. */
const snapshotOf = (db: any, orderItemId: any): any[] =>
  db.prepare('SELECT addon_id, quantity, inventory_deducted_quantity FROM order_item_addons WHERE order_item_id = ? ORDER BY id')
    .all(orderItemId);

function columnsOf(db: any, table: string): { name: string; notnull: number; dflt_value: unknown }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

async function main() {
  console.log('Integration Test: add-on inventory lifecycle (#358)');
  console.log('='.repeat(62));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);

  seedCategory(db, 'cat-lifecycle', 'Lifecycle');
  seedProduct(db, 'prod-burger', 'cat-lifecycle', 'Burger', 100, { tax_type: 'none', stock_quantity: 0 });
  seedProduct(db, 'prod-wrap', 'cat-lifecycle', 'Wrap', 100, { tax_type: 'none', stock_quantity: 0 });

  const app = createApp({ '/api/addon-groups': addonGroupRoutes, '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);

  const createOrder = (items: any[], headers: Record<string, string> = owner.authHeader) =>
    api(baseUrl, '/api/orders', { method: 'POST', headers, body: { type: 'takeaway', items } });
  const burgerWith = (quantity: number, addons: any[]) => ({ product_id: 'prod-burger', quantity, addons });
  const countOrders = () => Number((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n);
  let groupId: string;

  try {
    // ── 1. The registry carries the add-on stock columns ───────────────────
    console.log('\n--- The registry carries the add-on stock columns ---');
    {
      const tail = MIGRATIONS[MIGRATIONS.length - 1];
      assertEqualOrThrow(tail.version, ADDON_MIGRATION_VERSION, 'the add-on inventory migration is the registry tail');
      assertEqualOrThrow(tail.name, 'add_addon_inventory', 'the tail migration is add_addon_inventory');

      const addonColumns = columnsOf(db, 'addons').map((column) => column.name);
      for (const column of ['track_inventory', 'stock_quantity', 'low_stock_threshold']) {
        assertOrThrow(addonColumns.includes(column), `addons.${column} exists`);
      }
      const snapshotColumn = columnsOf(db, 'order_item_addons').find((c) => c.name === 'inventory_deducted_quantity');
      assertOrThrow(snapshotColumn, 'order_item_addons.inventory_deducted_quantity exists');
      assertEqualOrThrow(snapshotColumn.notnull, 1, 'the deduction snapshot is NOT NULL, so a line cannot record nothing');
      assertEqualOrThrow(String(snapshotColumn.dflt_value), '0', 'the deduction snapshot defaults to 0 for an untracked add-on');

      const movementColumns = columnsOf(db, 'inventory_movements');
      assertOrThrow(movementColumns.some((c) => c.name === 'addon_id'), 'inventory_movements.addon_id exists');
      const productId = movementColumns.find((c) => c.name === 'product_id');
      assertEqualOrThrow(productId.notnull, 0, 'a movement may name no product, which is how an add-on pool is recorded');
    }

    // ── 2. A tracked add-on is created with its opening stock ─────────────
    console.log('\n--- A tracked add-on is created with its opening stock ---');
    {
      const created = await api(baseUrl, '/api/addon-groups', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          name: 'Milk Options',
          min_selection: 0,
          // Wide open: the group cap is enforced elsewhere; this pool's limit is its own stock.
          max_selection: 99,
          allow_multiple_quantities: true,
          addons: [
            { name: 'Oat Milk', price: 1, track_inventory: true, stock_quantity: 40, low_stock_threshold: OAT_THRESHOLD },
            { name: 'Whole Milk', price: 0 },
          ],
        },
      });
      assertEqualOrThrow(created.status, 201, 'the add-on group is created');
      groupId = created.data.addon_group.id;
      const oat = created.data.addon_group.addons.find((a: any) => a.name === 'Oat Milk');
      const whole = created.data.addon_group.addons.find((a: any) => a.name === 'Whole Milk');
      OAT = oat.id;
      WHOLE = whole.id;
      assertEqualOrThrow(oat.track_inventory, true, 'the catalog reports the add-on as tracked');
      assertEqualOrThrow(oat.stock_quantity, 40, 'the catalog reports the opening stock');
      assertEqualOrThrow(oat.low_stock_threshold, 8, 'the catalog reports the reorder threshold');
      assertEqualOrThrow(whole.track_inventory, false, 'an add-on created without tracking is untracked');
      assertEqualOrThrow(stockOf(db, oat.id), 40, 'the opening stock is on the pool');
      assertEqualOrThrow(stockOf(db, whole.id), 0, 'an untracked add-on starts with nothing to sell');

      // Opening stock has to exist as a ledger event, or the pool is the exact
      // silent failure the backup validator exists to reject.
      const opening = movementsFor(db, oat.id);
      assertEqualOrThrow(opening.length, 1, 'opening stock appends one ledger movement');
      assertEqualOrThrow(opening[0].movement_type, 'adjustment', 'the opening movement is an adjustment');
      assertEqualOrThrow(opening[0].reference_type, 'opening_balance', 'the opening movement is an opening balance');
      assertEqualOrThrow(opening[0].quantity_delta, 40, 'the opening movement carries the full quantity');
      assertEqualOrThrow(opening[0].stock_after, 40, 'the opening movement records the resulting stock');
      assertEqualOrThrow(opening[0].actor_user_id, owner.userId, 'the opening movement names the operator who set it');
      assertEqualOrThrow(movementsFor(db, whole.id).length, 0, 'an untracked add-on writes no ledger row');
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'a newly created pool reconciles against its ledger');

      // The pool is only reachable from a till once the group is linked to the
      // products that offer it.
      for (const productId of ['prod-burger', 'prod-wrap']) {
        db.prepare('INSERT INTO addon_group_product (addon_group_id, product_id) VALUES (?, ?)')
          .run(groupId, productId);
      }
    }

    // ── 3. A line consumes item quantity x add-on quantity ────────────────
    console.log('\n--- A line consumes item quantity x add-on quantity ---');
    {
      const before = stockOf(db, OAT);
      // Three burgers with two extra oat milk each: six, not two.
      const res = await createOrder([burgerWith(3, [{ id: OAT, quantity: 2 }])]);
      assertEqualOrThrow(res.status, 201, 'the order is created');
      assertEqualOrThrow(stockOf(db, OAT), before - 6, 'the pool is debited by the multiplied requirement');

      const snapshot = snapshotOf(db, res.data.order.items[0].id);
      assertEqualOrThrow(snapshot.length, 1, 'the line records one add-on row');
      assertEqualOrThrow(snapshot[0].quantity, 2, 'the row keeps the customer-facing add-on quantity');
      assertEqualOrThrow(snapshot[0].inventory_deducted_quantity, 6, 'the row snapshots what it actually took');

      const sale = movementsFor(db, OAT)[1];
      assertEqualOrThrow(sale.movement_type, 'sale', 'the debit is a sale movement');
      assertEqualOrThrow(sale.quantity_delta, -6, 'the ledger row carries the full multiplied debit');
      assertEqualOrThrow(sale.stock_after, before - 6, 'the ledger row records the resulting pool');
      assertEqualOrThrow(sale.actor_user_id, owner.userId, 'the debit names the authenticated operator');
      assertEqualOrThrow(sale.product_id, null, 'an add-on pool movement names no product');
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'the pool reconciles after a sale');
    }

    // ── 4. A pool that cannot cover the line refuses the order ────────────
    console.log('\n--- A pool that cannot cover the line refuses the order ---');
    {
      const before = stockOf(db, OAT);
      const ordersBefore = countOrders();
      const perItem = Math.floor(before / 2) + 1;   // two items of this each exceed the pool
      const res = await createOrder([burgerWith(2, [{ id: OAT, quantity: perItem }])]);
      assertEqualOrThrow(res.status, 400, 'an order the pool cannot cover is refused');
      assertIncludesOrThrow(res.data.error, 'Oat Milk', 'the refusal names the add-on');
      assertIncludesOrThrow(res.data.error, `requested ${perItem * 2}`, 'the refusal names the multiplied requirement');
      assertIncludesOrThrow(res.data.error, `available ${before}`, 'the refusal names what is left in the pool');
      assertEqualOrThrow(stockOf(db, OAT), before, 'a refused order moves no stock');
      assertEqualOrThrow(countOrders(), ordersBefore, 'a refused order writes no order');
      assertEqualOrThrow(movementsFor(db, OAT).length, 2, 'a refused order appends no ledger row');
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'the pool reconciles after a refusal');
    }
    {
      // An untracked add-on has no pool to move and must keep selling at zero.
      const res = await createOrder([burgerWith(1, [{ id: WHOLE, quantity: 4 }])]);
      assertEqualOrThrow(res.status, 201, 'an untracked add-on still orders normally');
      assertEqualOrThrow(snapshotOf(db, res.data.order.items[0].id)[0].inventory_deducted_quantity, 0, 'an untracked add-on records no deduction');
      await api(baseUrl, `/api/orders/${res.data.order.id}/status`, {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'cancelled' },
      });
    }

    // ── 5. Cancelling the order returns exactly what the lines took ────────
    console.log('\n--- Cancelling the order returns exactly what the lines took ---');
    {
      const before = stockOf(db, OAT);
      const res = await createOrder([
        burgerWith(2, [{ id: OAT, quantity: 3 }]),
        { product_id: 'prod-wrap', quantity: 1, addons: [{ id: OAT, quantity: 1 }] },
      ]);
      assertEqualOrThrow(res.status, 201, 'the order is created');
      assertEqualOrThrow(stockOf(db, OAT), before - 7, 'the two lines debit 6 and 1');
      const movementsBefore = movementsFor(db, OAT).length;

      const cancelled = await api(baseUrl, `/api/orders/${res.data.order.id}/status`, {
        method: 'PATCH', headers: manager.authHeader, body: { status: 'cancelled', reason: 'customer left' },
      });
      assertEqualOrThrow(cancelled.status, 200, 'the order cancels');
      assertEqualOrThrow(stockOf(db, OAT), before, 'cancelling returns exactly what the lines took');

      const restores = movementsFor(db, OAT).slice(movementsBefore);
      assertEqualOrThrow(restores.length, 2, 'each debited line appends its own restore');
      assertEqualOrThrow(restores[0].movement_type, 'cancel_restore', 'a restore is a cancel_restore movement');
      assertEqualOrThrow(restores[0].quantity_delta, 6, 'the first line restores its own 6');
      assertEqualOrThrow(restores[1].quantity_delta, 1, 'the second line restores its own 1');
      assertEqualOrThrow(restores[0].actor_user_id, manager.userId, 'the restore names the operator who cancelled');
      assertIncludesOrThrow(String(restores[0].reason), 'customer left', 'the restore carries the cancellation reason');

      await api(baseUrl, `/api/orders/${res.data.order.id}/status`, {
        method: 'PATCH', headers: manager.authHeader, body: { status: 'cancelled' },
      });
      assertEqualOrThrow(stockOf(db, OAT), before, 're-cancelling does not hand the pool a second time');
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'the pool reconciles after a cancel');
    }

    // ── 6. A cancelled line returns its stock; a voided line does not ──────
    console.log('\n--- A cancelled line returns its stock; a voided line does not ---');
    {
      const cancelledBefore = stockOf(db, OAT);
      const cancellable = (await createOrder([
        burgerWith(2, [{ id: OAT, quantity: 3 }]),
        { product_id: 'prod-wrap', quantity: 1 },
      ])).data.order;
      const cancellableItem = cancellable.items[0].id;
      assertEqualOrThrow(stockOf(db, OAT), cancelledBefore - 6, 'the pending line debited 6');

      const cancelled = await api(baseUrl, `/api/orders/${cancellable.id}/items/${cancellableItem}/cancel`, {
        method: 'PATCH', headers: manager.authHeader, body: { reason: 'sent back' },
      });
      assertEqualOrThrow(cancelled.status, 200, 'a pending line cancels');
      assertEqualOrThrow(stockOf(db, OAT), cancelledBefore, 'cancelling the line returns its 6');
      assertEqualOrThrow(snapshotOf(db, cancellableItem)[0].inventory_deducted_quantity, 6, 'the cancelled line keeps its record of what it took');

      // A void is kitchen waste: the milk was poured, so the stock stays gone.
      const voidBefore = stockOf(db, OAT);
      const voided = (await createOrder([burgerWith(2, [{ id: OAT, quantity: 3 }])])).data.order;
      const voidedItem = voided.items[0].id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(voidedItem);
      const movementsBefore = movementsFor(db, OAT).length;

      const voidedResponse = await api(baseUrl, `/api/orders/${voided.id}/items/${voidedItem}/cancel`, {
        method: 'PATCH', headers: owner.authHeader, body: { override_pin: '1234' },
      });
      assertEqualOrThrow(voidedResponse.status, 200, 'the in-progress line voids');
      assertEqualOrThrow((db.prepare('SELECT status FROM order_items WHERE id = ?').get(voidedItem) as any).status, 'voided', 'the line is marked voided');
      assertEqualOrThrow(stockOf(db, OAT), voidBefore - 6, 'voiding leaves the add-on stock consumed');
      assertEqualOrThrow(movementsFor(db, OAT).length, movementsBefore, 'a void appends no add-on movement at all');
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'the pool reconciles after a void');
    }

    // ── 7. Restoring a line re-deducts what it recorded ───────────────────
    console.log('\n--- Restoring a line re-deducts what it recorded ---');
    {
      const live = (await createOrder([
        burgerWith(2, [{ id: OAT, quantity: 3 }]),
        { product_id: 'prod-wrap', quantity: 1 },
      ])).data.order;
      const itemId = (db.prepare('SELECT order_item_id FROM order_item_addons WHERE addon_id = ? ORDER BY id DESC LIMIT 1')
        .get(OAT) as any).order_item_id;
      const before = stockOf(db, OAT);

      assertEqualOrThrow((await api(baseUrl, `/api/orders/${live.id}/items/${itemId}/cancel`, {
        method: 'PATCH', headers: manager.authHeader, body: {},
      })).status, 200, 'the live line cancels');
      assertEqualOrThrow(stockOf(db, OAT), before + 6, 'cancelling returned the 6 it took');

      // The merchant restocks through the catalog while the line sits
      // cancelled, so the catalog and the snapshot disagree. Restoring must
      // move the recorded 6, never a figure recomputed from the catalog.
      const movementsBeforeRestock = movementsFor(db, OAT).length;
      await api(baseUrl, `/api/addon-groups/${groupId}/addons/${OAT}`, {
        method: 'PUT', headers: owner.authHeader, body: { stock_quantity: 100 },
      });
      const restocked = stockOf(db, OAT);
      assertEqualOrThrow(restocked, 100, 'the restock lands on the catalog API');
      assertEqualOrThrow(movementsFor(db, OAT).length, movementsBeforeRestock + 1, 'the restock is a ledger event, not a silent overwrite');

      const restored = await api(baseUrl, `/api/orders/${live.id}/items/${itemId}/restore`, {
        method: 'PATCH', headers: manager.authHeader, body: {},
      });
      assertEqualOrThrow(restored.status, 200, 'the cancelled line restores');
      assertEqualOrThrow((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemId) as any).status, 'pending', 'the restored line is active again');
      assertEqualOrThrow(stockOf(db, OAT), restocked - 6, 'restore re-deducts the recorded snapshot, not a recomputation');
      assertEqualOrThrow(snapshotOf(db, itemId)[0].inventory_deducted_quantity, 6, 'the snapshot row is unchanged by the restore');

      assertEqualOrThrow((await api(baseUrl, `/api/orders/${live.id}/items/${itemId}/restore`, {
        method: 'PATCH', headers: manager.authHeader, body: {},
      })).status, 200, 'restoring an already-active line is accepted');
      assertEqualOrThrow(stockOf(db, OAT), restocked - 6, 'restoring an already-active line moves no stock');
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'the pool reconciles after a restore');
    }

    // ── 8. The POS refuses to sell what the pool has emptied ───────────────
    console.log('\n--- The POS refuses to sell what the pool has emptied ---');
    {
      const served = await api(baseUrl, `/api/addon-groups/${groupId}`, { headers: owner.authHeader });
      const whole = served.data.addon_group.addons.find((a: any) => a.id === WHOLE);

      // Rake the pool down to just under its reorder threshold: the state a
      // kitchen actually sees before it runs out of anything.
      await api(baseUrl, `/api/addon-groups/${groupId}/addons/${OAT}`, {
        method: 'PUT', headers: owner.authHeader, body: { stock_quantity: OAT_THRESHOLD - 1 },
      });
      const low = (await api(baseUrl, `/api/addon-groups/${groupId}`, { headers: owner.authHeader }))
        .data.addon_group.addons.find((a: any) => a.id === OAT);
      assertEqualOrThrow(isAddonSoldOut(low), false, 'a tracked add-on with stock left still sells');
      assertEqualOrThrow(isAddonLowStock(low), true, 'a pool below its threshold warns the cashier');
      assertEqualOrThrow(addonStockCeiling(low), OAT_THRESHOLD - 1, 'the cashier cannot dial beyond the pool');
      assertEqualOrThrow(served.data.addon_group.addons.find((a: any) => a.id === OAT).low_stock_threshold, OAT_THRESHOLD, 'the reorder threshold the POS reads is the one the catalog stores');

      // An untracked add-on keeps selling at zero, exactly as an untracked
      // product does, so switching tracking off never blocks a sale.
      assertEqualOrThrow(isAddonSoldOut(whole), false, 'an untracked add-on at zero still sells');
      assertEqualOrThrow(isAddonLowStock(whole), false, 'an untracked add-on never warns');
      assertEqualOrThrow(addonStockCeiling(whole), null, 'an untracked add-on has no quantity ceiling');

      // Drain the pool through the real order path and the POS must catch up.
      const drainable = stockOf(db, OAT);
      const drain = await createOrder([burgerWith(1, [{ id: OAT, quantity: drainable }])]);
      assertEqualOrThrow(drain.status, 201, 'the pool is emptied through a real sale');
      assertEqualOrThrow(stockOf(db, OAT), 0, 'the pool lands on zero, not below it');

      const emptied = (await api(baseUrl, `/api/addon-groups/${groupId}`, { headers: owner.authHeader }))
        .data.addon_group.addons.find((a: any) => a.id === OAT);
      assertEqualOrThrow(isAddonSoldOut(emptied), true, 'an emptied tracked add-on is sold out');
      assertEqualOrThrow(isAddonLowStock(emptied), false, 'a sold-out add-on does not also warn, so it never carries both badges');
      assertEqualOrThrow(addonStockCeiling(emptied), 0, 'a sold-out add-on has no headroom');
      assertIncludesOrThrow(
        String((await createOrder([burgerWith(1, [{ id: OAT, quantity: 1 }])])).data.error),
        'out of stock',
        'the backend refuses the sale the POS would have blocked',
      );
      assertEqualOrThrow(validateInventoryLedgerDatabase(db), null, 'the pool reconciles at the end of the lifecycle');
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