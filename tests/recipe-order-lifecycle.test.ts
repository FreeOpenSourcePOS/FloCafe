/**
 * Recipe/BOM depletion across the order lifecycle (issues #768/#769).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/recipe-order-lifecycle.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-recipe-lifecycle-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct, seedTable,
  api, assertEqual, assert, getResults, resetCounters, closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { createSupply, getSupply } = require('../main/services/supplies');
const { saveRecipe, buildRecipeSnapshot } = require('../main/services/recipes');

function stockOf(db: any, id: string): number {
  return Number(getSupply(db, id).stock_quantity);
}

function movementCount(db: any, supplyId: string, type: string): number {
  return db.prepare('SELECT COUNT(*) AS c FROM supply_movements WHERE supply_id = ? AND movement_type = ?')
    .get(supplyId, type).c;
}

async function main() {
  console.log('Recipe order lifecycle test');
  console.log('='.repeat(65));
  resetCounters();

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedManagerUser(db);
  seedCategory(db, 'cat-rec', 'Recipes');

  seedProduct(db, 'prod-latte', 'cat-rec', 'Latte', 250, { track_inventory: false, stock_quantity: 0 });
  seedProduct(db, 'prod-water', 'cat-rec', 'Water', 50, { track_inventory: false, stock_quantity: 0 });
  seedTable(db, 'tbl-rec-1', 1, 4);

  const beans = createSupply(db, { name: 'Beans', baseUnit: 'g', stockQuantity: 1000, lowStockThreshold: 100 });
  const milkS = createSupply(db, { name: 'Milk', baseUnit: 'ml', stockQuantity: 5000, lowStockThreshold: 500 });

  saveRecipe(db, {
    productId: 'prod-latte',
    yieldQuantity: 1,
    items: [
      { supplyId: beans.id, quantity: 18, unit: 'g' },
      { supplyId: milkS.id, quantity: 200, unit: 'ml' },
    ],
  });

  const snap2 = buildRecipeSnapshot(db, 'prod-latte', 2);
  assert(snap2 !== null, 'snapshot built for active recipe');
  assertEqual(snap2!.components.find((c: any) => c.supply_id === beans.id)!.quantity, 36, 'snapshot scales linearly (2 x 18 g)');
  assertEqual(snap2!.components.find((c: any) => c.supply_id === milkS.id)!.quantity, 400, 'snapshot scales milk (2 x 200 ml)');
  assertEqual(buildRecipeSnapshot(db, 'prod-water', 1), null, 'product without recipe yields null snapshot');
  assertEqual(buildRecipeSnapshot(db, 'prod-latte', 0), null, 'non-positive order quantity yields null snapshot');

  const { orderRoutes } = require('../main/routes/orders');
  const { orderItemRoutes } = require('../main/routes/order-items');
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/order-items': orderItemRoutes,
  });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n--- 1. Deplete at order creation ---');
    const beansBefore = stockOf(db, beans.id);
    const milkBefore = stockOf(db, milkS.id);

    // Two items so cancelling one does not auto-cancel the whole order.
    const order1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-rec-1',
        items: [
          { product_id: 'prod-latte', quantity: 3 },
          { product_id: 'prod-water', quantity: 1 },
        ],
      },
    });
    assertEqual(order1.status, 201, 'order with recipe product created');

    assertEqual(stockOf(db, beans.id), beansBefore - 54, 'beans depleted by 3 x 18 g');
    assertEqual(stockOf(db, milkS.id), milkBefore - 600, 'milk depleted by 3 x 200 ml');
    assertEqual(movementCount(db, beans.id, 'recipe_depletion'), 1, 'one recipe_depletion movement for beans');

    const item1 = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND product_id = 'prod-latte' LIMIT 1")
      .get(order1.data.order.id);
    const parsedSnap = JSON.parse(item1.recipe_snapshot);
    assertEqual(parsedSnap.product_id, 'prod-latte', 'recipe_snapshot stores product id');
    assertEqual(parsedSnap.components.length, 2, 'recipe_snapshot stores both components');
    assertEqual(
      parsedSnap.components.find((c: any) => c.supply_id === beans.id).quantity,
      54,
      'recipe_snapshot stores scaled bean amount',
    );

    console.log('\n--- 2. Pending item cancel restores ---');
    const beansMid = stockOf(db, beans.id);
    const milkMid = stockOf(db, milkS.id);

    const cancelRes = await api(baseUrl, `/api/orders/${order1.data.order.id}/items/${item1.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(cancelRes.status, 200, 'pending item cancel succeeds');
    assertEqual(db.prepare('SELECT status FROM orders WHERE id = ?').get(order1.data.order.id).status, 'pending', 'order stays active with remaining item');
    assertEqual(stockOf(db, beans.id), beansMid + 54, 'beans restored on pending cancel');
    assertEqual(stockOf(db, milkS.id), milkMid + 600, 'milk restored on pending cancel');
    assertEqual(movementCount(db, beans.id, 'recipe_restore'), 1, 'one recipe_restore movement for beans');

    console.log('\n--- 3. Item restore re-depletes ---');
    const beansPostCancel = stockOf(db, beans.id);
    const restoreRes = await api(baseUrl, `/api/orders/${order1.data.order.id}/items/${item1.id}/restore`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(restoreRes.status, 200, 'item restore succeeds');
    assertEqual(stockOf(db, beans.id), beansPostCancel - 54, 'beans re-depleted on restore');
    assertEqual(movementCount(db, beans.id, 'recipe_depletion'), 2, 'second recipe_depletion recorded');

    console.log('\n--- 4. Whole-order cancel restores ---');
    const beansBeforeCancel = stockOf(db, beans.id);
    const milkBeforeCancel = stockOf(db, milkS.id);
    const orderCancel = await api(baseUrl, `/api/orders/${order1.data.order.id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', reason: 'Customer left' },
    });
    assertEqual(orderCancel.status, 200, 'order cancel succeeds');
    assertEqual(stockOf(db, beans.id), beansBeforeCancel + 54, 'beans restored on order cancel');
    assertEqual(stockOf(db, milkS.id), milkBeforeCancel + 600, 'milk restored on order cancel');

    console.log('\n--- 5. Append items depletes ---');
    const order2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-water', quantity: 1 }] },
    });
    assertEqual(order2.status, 201, 'base order created without recipe');
    const beansBeforeAppend = stockOf(db, beans.id);
    const appendRes = await api(baseUrl, `/api/orders/${order2.data.order.id}/items`, {
      method: 'POST',
      headers: authHeader,
      body: { items: [{ product_id: 'prod-latte', quantity: 2 }] },
    });
    assertEqual(appendRes.status, 200, 'append succeeds');
    assertEqual(stockOf(db, beans.id), beansBeforeAppend - 36, 'append depletes beans (2 x 18 g)');

    console.log('\n--- 6. Void does not restore ---');
    const order3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'dine_in', table_id: 'tbl-rec-1', items: [{ product_id: 'prod-latte', quantity: 1 }] },
    });
    const item3Id = order3.data.order.items[0].id;
    const beansBeforeVoid = stockOf(db, beans.id);

    await api(baseUrl, `/api/order-items/${item3Id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'preparing' },
    });
    const voidRes = await api(baseUrl, `/api/orders/${order3.data.order.id}/items/${item3Id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: { override_pin: '1234' },
    });
    assertEqual(voidRes.status, 200, 'void of in-prep item succeeds');
    assertEqual(stockOf(db, beans.id), beansBeforeVoid, 'void does NOT restore bean stock');

    const beansBeforeOrder3Cancel = stockOf(db, beans.id);
    const cancel3 = await api(baseUrl, `/api/orders/${order3.data.order.id}/status`, {
      method: 'PATCH',
      headers: authHeader,
      body: { status: 'cancelled', override_pin: '1234' },
    });
    assertEqual(cancel3.status, 200, 'order with only voided item cancels');
    assertEqual(stockOf(db, beans.id), beansBeforeOrder3Cancel, 'whole-order cancel skips voided item supplies');

    console.log('\n--- 7. Inactive recipe skips depletion ---');
    saveRecipe(db, {
      productId: 'prod-latte',
      yieldQuantity: 1,
      isActive: false,
      items: [{ supplyId: beans.id, quantity: 18, unit: 'g' }],
    });
    const beansInactive = stockOf(db, beans.id);
    const order4 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-latte', quantity: 1 }] },
    });
    assertEqual(order4.status, 201, 'order with inactive recipe created');
    assertEqual(stockOf(db, beans.id), beansInactive, 'inactive recipe does not deplete');
    const item4 = db.prepare('SELECT recipe_snapshot FROM order_items WHERE order_id = ? LIMIT 1').get(order4.data.order.id);
    assertEqual(item4.recipe_snapshot, null, 'inactive recipe stores null snapshot');

    console.log('\n--- 8. Yield scaling ---');
    saveRecipe(db, {
      productId: 'prod-latte',
      yieldQuantity: 4,
      items: [{ supplyId: beans.id, quantity: 72, unit: 'g' }],
    });
    const beansYield = stockOf(db, beans.id);
    const order5 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-latte', quantity: 2 }] },
    });
    assertEqual(order5.status, 201, 'order with scaled yield recipe created');
    assertEqual(stockOf(db, beans.id), beansYield - 36, 'yield scales depletion (72 g per 4 -> 36 g for 2)');

    console.log('\n--- 9. Product inventory independent of supplies ---');
    seedProduct(db, 'prod-track-both', 'cat-rec', 'Tracked', 100, { track_inventory: true, stock_quantity: 10 });
    saveRecipe(db, {
      productId: 'prod-track-both',
      yieldQuantity: 1,
      items: [{ supplyId: beans.id, quantity: 10, unit: 'g' }],
    });
    const beansBoth = stockOf(db, beans.id);
    const order6 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-track-both', quantity: 1 }] },
    });
    assertEqual(order6.status, 201, 'tracked product with recipe created');
    assertEqual(stockOf(db, beans.id), beansBoth - 10, 'supplies depleted for tracked product with recipe');
    assertEqual(
      db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-track-both').stock_quantity,
      9,
      'product stock also deducted (10 -> 9)',
    );

    console.log('\n--- 10. Recipe edit does not alter historical restore ---');
    saveRecipe(db, {
      productId: 'prod-latte',
      yieldQuantity: 1,
      items: [{ supplyId: beans.id, quantity: 18, unit: 'g' }],
    });
    const order7 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-latte', quantity: 2 }] },
    });
    assertEqual(order7.status, 201, 'order created under original recipe');
    // Edit the recipe after the order exists.
    saveRecipe(db, {
      productId: 'prod-latte',
      yieldQuantity: 1,
      items: [{ supplyId: beans.id, quantity: 30, unit: 'g' }],
    });
    const item7 = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND product_id = 'prod-latte' LIMIT 1")
      .get(order7.data.order.id);
    const beansBeforeSnapshotCancel = stockOf(db, beans.id);
    const cancel7 = await api(baseUrl, `/api/orders/${order7.data.order.id}/items/${item7.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(cancel7.status, 200, 'item cancel after recipe edit succeeds');
    assertEqual(
      stockOf(db, beans.id),
      beansBeforeSnapshotCancel + 36,
      'restore uses original snapshot (2 x 18 g), not edited recipe (2 x 30 g)',
    );

    console.log('='.repeat(65));
    const { passed, failed, total } = getResults();
    console.log(`${passed}/${total} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
