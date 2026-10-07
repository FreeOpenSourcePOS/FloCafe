/**
 * Order placement against catalog variants.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-variants-orders.test.ts
 *
 * Covers the backend-authoritative half of the variant stack on both item
 * creation paths (POST /api/orders and POST /api/orders/:id/items): the server
 * owns the price, a missing / foreign / inactive variant is rejected instead of
 * falling back to the base price, a tracked variant consumes and refunds its own
 * stock pool, a recipe variant consumes and refunds quantity * multiplier of its
 * base ingredient, and cancel/restore never credits a pool the sale did not debit.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-variants-orders-'));

Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-product-variants-orders';

const assert = require('node:assert/strict');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, api, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { orderItemRoutes } = require('../main/routes/order-items');

const stockOfVariant = (db: any, variantId: string) =>
  Number((db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(variantId) as any).stock_quantity);
const stockOfProduct = (db: any, productId: string) =>
  Number((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId) as any).stock_quantity);

async function main() {
  console.log('Product variants on order items');
  console.log('='.repeat(60));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  // Voiding a prepared item needs an owner/manager PIN, which the manager holds.
  seedManagerUser(db);
  seedCategory(db, 'cat-var-orders', 'Variant orders');

  // A recipe base ingredient, and a product whose own stock is tracked so a
  // variant pool leak would be visible as a change on the parent product.
  db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-dough', 'cat-var-orders', 'Pizza dough', 40, 1, 100, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-cappuccino', 'cat-var-orders', 'Cappuccino', 400, 1, 50, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-pizza', 'cat-var-orders', 'Pizza', 700, 0, 0, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, created_at, updated_at)
    VALUES ('prod-plain', 'cat-var-orders', 'Flat white', 350, ?, ?)`).run(now(), now());

  const insertVariant = (db2: any, variant: Record<string, unknown>) => db2.prepare(`
    INSERT INTO product_variants (id, product_id, name, sku, price, online_price, track_inventory, stock_quantity,
      inventory_product_id, inventory_deduction_quantity, recipe_multiplier, is_active, created_at, updated_at)
    VALUES (@id, @product_id, @name, @sku, @price, @online_price, @track_inventory, @stock_quantity,
      @inventory_product_id, @inventory_deduction_quantity, @recipe_multiplier, @is_active, @created_at, @updated_at)
  `).run({
    sku: null, online_price: null, track_inventory: 0, stock_quantity: 0,
    inventory_product_id: null, inventory_deduction_quantity: 1, recipe_multiplier: 1, is_active: 1,
    created_at: now(), updated_at: now(),
    ...variant,
  } as any);

  insertVariant(db, { id: 'var-small', product_id: 'prod-cappuccino', name: 'Small', sku: 'CAP-S', price: 300, track_inventory: 1, stock_quantity: 5 });
  insertVariant(db, { id: 'var-large', product_id: 'prod-cappuccino', name: 'Large', price: 500, online_price: 550 });
  insertVariant(db, { id: 'var-retired', product_id: 'prod-cappuccino', name: 'Retired', price: 500, is_active: 0 });
  insertVariant(db, { id: 'var-tenth', product_id: 'prod-pizza', name: 'Ten inch', price: 600 });
  insertVariant(db, { id: 'var-sixteen', product_id: 'prod-pizza', name: 'Sixteen inch', price: 900, inventory_product_id: 'prod-dough', inventory_deduction_quantity: 2 });
  insertVariant(db, { id: 'var-pizza-retired', product_id: 'prod-pizza', name: 'Retired slice', price: 800, is_active: 0 });

  const app = createApp({ '/api/orders': orderRoutes, '/api/order-items': orderItemRoutes });
  // The prepaid checkout modal prices the cart through this endpoint before the
  // order exists, so the suite exercises the same handler main/routes mounts.
  app.post('/api/tax/preview', async (req: any, res: any) => {
    const { calculateTaxPreview } = require('../main/services/tax');
    await calculateTaxPreview(req, res);
  });
  const { baseUrl, server } = await startServer(app);

  const createOrder = (body: Record<string, unknown>, headers = owner.authHeader) =>
    api(baseUrl, '/api/orders', { method: 'POST', headers, body });
  const previewBasket = (body: Record<string, unknown>) =>
    api(baseUrl, '/api/tax/preview', { method: 'POST', headers: owner.authHeader, body });
  const addItems = (orderId: string | number, items: unknown[], headers = owner.authHeader) =>
    api(baseUrl, `/api/orders/${orderId}/items`, { method: 'POST', headers, body: { items } });
  const itemOf = (orderId: string | number) =>
    db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id LIMIT 1').get(orderId) as any;

  try {
    // ── Server owns the price, snapshot, and stock pool ───────────────────
    {
      const response = await createOrder({
        type: 'takeaway',
        items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 2, unit_price: 1, total: 1 }],
      });
      assert.equal(response.status, 201, `a variant order is created (${JSON.stringify(response.data)})`);

      const item = itemOf(response.data.order.id);
      assert.equal(item.unit_price, 500, 'the client unit price is ignored and the variant price is stored');
      assert.equal(item.subtotal, 1000, 'the subtotal is built from the variant price');
      assert.equal(item.variant_id, 'var-large', 'the ordered variant is persisted on the line');
      assert.deepEqual(
        JSON.parse(item.variant_selection),
        { id: 'var-large', name: 'Large', price: 500, sku: null },
        'the variant snapshot records the catalog identity',
      );
      assert.equal(item.inventory_product_id, 'prod-cappuccino', 'a variant without a recipe link keeps the base product pool');
      // The variant tracks no stock of its own, so the product's own rule applies.
      assert.equal(stockOfProduct(db, 'prod-cappuccino'), 48, 'an untracked variant falls back to the base product pool');

      const cancelled = await api(baseUrl, `/api/orders/${response.data.order.id}/items/${item.id}/cancel`, {
        method: 'PATCH', headers: owner.authHeader, body: {},
      });
      assert.equal(cancelled.status, 200, `a variant item can be cancelled (${JSON.stringify(cancelled.data)})`);
      assert.equal(stockOfProduct(db, 'prod-cappuccino'), 50, 'cancelling returns the base product stock exactly');
    }

    // ── Tracked variant: its own stock, lost and regained ─────────────────
    {
      const before = stockOfVariant(db, 'var-small');
      const productStockBefore = stockOfProduct(db, 'prod-cappuccino');
      const response = await createOrder({
        type: 'takeaway',
        // A second line keeps the order itself active when the variant line is cancelled.
        items: [{ product_id: 'prod-cappuccino', variant_id: 'var-small', quantity: 3 }, { product_id: 'prod-plain', quantity: 1 }],
      });
      assert.equal(response.status, 201, 'a tracked variant order is created');
      const orderId = response.data.order.id;
      const item = itemOf(orderId);
      assert.equal(stockOfVariant(db, 'var-small'), before - 3, 'a tracked variant loses its own stock');
      assert.equal(stockOfProduct(db, 'prod-cappuccino'), productStockBefore, 'a tracked variant does not touch the base product pool');
      assert.equal(item.inventory_deducted_quantity, 3, 'the line records the quantity it consumed');

      const cancelled = await api(baseUrl, `/api/orders/${orderId}/items/${item.id}/cancel`, { method: 'PATCH', headers: owner.authHeader, body: {} });
      assert.equal(cancelled.status, 200, 'the tracked-variant item is cancelled');
      assert.equal(stockOfVariant(db, 'var-small'), before, 'cancelling restores the tracked variant stock exactly');

      const restored = await api(baseUrl, `/api/orders/${orderId}/items/${item.id}/restore`, { method: 'PATCH', headers: owner.authHeader, body: {} });
      assert.equal(restored.status, 200, 'the tracked-variant item is restored');
      assert.equal(stockOfVariant(db, 'var-small'), before - 3, 'restoring re-consumes the tracked variant stock exactly');

      const movements = db.prepare(
        "SELECT quantity_delta FROM inventory_movements WHERE variant_id = 'var-small' ORDER BY id DESC LIMIT 3",
      ).all() as any[];
      assert.deepEqual(movements.map((m) => m.quantity_delta), [-3, 3, -3], 'the ledger alternates consume and return without doubling up');
    }

    // ── Recipe variant: multiplier of the base ingredient ─────────────────
    {
      const before = stockOfProduct(db, 'prod-dough');
      const response = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-pizza', variant_id: 'var-sixteen', quantity: 3 }] });
      assert.equal(response.status, 201, 'a recipe variant order is created');
      const orderId = response.data.order.id;
      const item = itemOf(orderId);
      assert.equal(item.inventory_deducted_quantity, 6, 'the line records quantity * multiplier');
      assert.equal(stockOfProduct(db, 'prod-dough'), before - 6, 'the base ingredient loses quantity * multiplier');
      assert.equal(stockOfProduct(db, 'prod-pizza'), 0, 'the recipe variant does not consume the sellable product');

      await api(baseUrl, `/api/orders/${orderId}/items/${item.id}/cancel`, { method: 'PATCH', headers: owner.authHeader, body: {} });
      assert.equal(stockOfProduct(db, 'prod-dough'), before, 'cancelling returns the recipe multiplier to the base ingredient');
    }

    // ── Order cancellation restores the variant pool ──────────────────────
    {
      const before = stockOfVariant(db, 'var-small');
      const response = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-small', quantity: 2 }] });
      const cancelled = await api(baseUrl, `/api/orders/${response.data.order.id}/status`, {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'cancelled', override_pin: '1234' },
      });
      assert.equal(cancelled.status, 200, `a variant order can be cancelled (${JSON.stringify(cancelled.data)})`);
      assert.equal(stockOfVariant(db, 'var-small'), before, 'cancelling the order returns the tracked variant stock');
    }

    // ── A post-sale variant edit cannot redirect the refund ────────────────
    {
      const before = stockOfVariant(db, 'var-small');
      const productBefore = stockOfProduct(db, 'prod-cappuccino');
      const response = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-small', quantity: 2 }] });
      const orderId = response.data.order.id;
      const item = itemOf(orderId);
      assert.equal(item.inventory_variant_id, 'var-small', 'the line records the variant pool it debited');
      assert.equal(stockOfVariant(db, 'var-small'), before - 2, 'the tracked variant pool is debited at sale');

      // The owner turns tracking off after the sale; the cancel must still credit
      // the pool the sale debited, not the product pool the new settings select.
      db.prepare('UPDATE product_variants SET track_inventory = 0 WHERE id = ?').run('var-small');
      const cancelled = await api(baseUrl, `/api/orders/${orderId}/items/${item.id}/cancel`, { method: 'PATCH', headers: owner.authHeader, body: {} });
      assert.equal(cancelled.status, 200, 'the tracked-variant item is cancelled after a settings edit');
      assert.equal(stockOfVariant(db, 'var-small'), before, 'cancelling credits the recorded variant pool');
      assert.equal(stockOfProduct(db, 'prod-cappuccino'), productBefore, 'the product pool is not credited instead');
      db.prepare('UPDATE product_variants SET track_inventory = 1 WHERE id = ?').run('var-small');
    }

    // ── Online orders use the platform price ──────────────────────────────
    {
      const response = await createOrder({
        type: 'takeaway', online_platform: 'zomato',
        items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 1 }],
      });
      assert.equal(response.status, 201, 'an online variant order is created');
      assert.equal(itemOf(response.data.order.id).unit_price, 550, 'an online order is priced from variant.online_price');

      const local = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 1 }] });
      assert.equal(itemOf(local.data.order.id).unit_price, 500, 'a counter order is priced from variant.price');

      const blank = await createOrder({
        type: 'takeaway', online_platform: '   ',
        items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 1 }],
      });
      assert.equal(blank.status, 201, 'an order with a blank online platform is created');
      assert.equal(itemOf(blank.data.order.id).unit_price, 500, 'a blank online platform is priced as a counter order');
    }

    // ── Rejections: never a silent fall back to the base price ────────────
    {
      const ordersBefore = (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count;
      const variantStockBefore = stockOfVariant(db, 'var-small');
      const missing = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', quantity: 1 }] });
      assert.equal(missing.status, 400, 'a product with variants cannot be sold without one');
      assert.match(missing.data.error, /variant must be selected/i, 'the missing-variant error names the cause');

      const unknown = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-missing', quantity: 1 }] });
      assert.equal(unknown.status, 400, 'an unknown variant is rejected');

      const foreign = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-sixteen', quantity: 1 }] });
      assert.equal(foreign.status, 400, "another product's variant is rejected");
      assert.match(foreign.data.error, /not an option/i, 'the foreign-variant error names the cause');

      const inactive = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-retired', quantity: 1 }] });
      assert.equal(inactive.status, 400, 'an inactive variant is rejected');
      assert.match(inactive.data.error, /not available/i, 'the inactive-variant error names the cause');

      const malformed = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 42, quantity: 1 }] });
      assert.equal(malformed.status, 400, 'a non-string variant id is rejected');

      const ordersAfter = (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count;
      assert.equal(ordersAfter, ordersBefore, 'a rejected variant leaves no order behind');
      assert.equal(stockOfVariant(db, 'var-small'), variantStockBefore, 'a rejected variant deducts nothing');
    }

    // ── The same rules apply when adding to an existing order ─────────────
    {
      const created = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-plain', quantity: 1, unit_price: 1 }] });
      assert.equal(created.status, 201, 'a variant-free order is created');
      const plain = itemOf(created.data.order.id);
      assert.equal(plain.unit_price, 350, 'a product without variants keeps its base price');
      assert.equal(plain.variant_id, null, 'a variant-free line records no variant');
      assert.equal(plain.variant_selection, 'null', 'a variant-free line records no variant snapshot');

      const orderId = created.data.order.id;
      const before = stockOfVariant(db, 'var-small');
      const added = await addItems(orderId, [{ product_id: 'prod-cappuccino', variant_id: 'var-small', quantity: 1, unit_price: 1 }]);
      assert.equal(added.status, 200, `a variant item can be added to an existing order (${JSON.stringify(added.data)})`);

      const variantItem = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND variant_id = 'var-small'").get(orderId) as any;
      assert.equal(variantItem.unit_price, 300, 'the added line is priced from the variant, not the client');
      assert.deepEqual(JSON.parse(variantItem.variant_selection), { id: 'var-small', name: 'Small', price: 300, sku: 'CAP-S' }, 'the added line snapshots the variant');
      assert.equal(stockOfVariant(db, 'var-small'), before - 1, 'the added line consumes the tracked variant pool');

      assert.equal((await addItems(orderId, [{ product_id: 'prod-cappuccino', quantity: 1 }])).status, 400, 'adding a variant product without a variant is rejected');
      assert.equal((await addItems(orderId, [{ product_id: 'prod-pizza', variant_id: 'var-pizza-retired', quantity: 1 }])).status, 400, "adding an inactive variant is rejected");

      await api(baseUrl, `/api/orders/${orderId}/items/${variantItem.id}/cancel`, { method: 'PATCH', headers: owner.authHeader, body: {} });
      assert.equal(stockOfVariant(db, 'var-small'), before, 'cancelling the added line returns the tracked variant stock');
    }

    // ── A soft-deactivated variant keeps the product sellable ──────────────
    {
      db.prepare('UPDATE product_variants SET is_active = 0 WHERE id = ?').run('var-large');
      const response = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-small', quantity: 1 }] });
      assert.equal(response.status, 201, 'the remaining active variant is still sellable');
      db.prepare('UPDATE product_variants SET is_active = 1 WHERE id = ?').run('var-large');
    }

    // ── The prepaid preview and the order it becomes cannot disagree ───────
    {
      const quoted = await previewBasket({ items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 2, addons: [] }] });
      assert.equal(quoted.status, 200, `a variant basket is previewable (${JSON.stringify(quoted.data)})`);
      assert.equal(quoted.data.items[0].unit_price, 500, 'the preview is priced from the variant, not the parent product');

      const charged = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 2 }] });
      assert.equal(charged.status, 201, 'the previewed basket can be ordered');
      assert.equal(quoted.data.summary.subtotal, charged.data.order.subtotal, 'the previewed subtotal is the charged subtotal');
      assert.equal(quoted.data.summary.tax_amount, charged.data.order.tax_amount, 'the previewed tax is the charged tax');
      assert.equal(quoted.data.summary.total, charged.data.order.total, 'the previewed total is the charged total');
    }
    {
      const onlineBasket = { items: [{ product_id: 'prod-cappuccino', variant_id: 'var-large', quantity: 1, addons: [] }] };
      const quoted = await previewBasket({ ...onlineBasket, online_platform: 'zomato' });
      const charged = await createOrder({ type: 'takeaway', online_platform: 'zomato', items: onlineBasket.items });
      assert.equal(quoted.data.items[0].unit_price, 550, 'an online preview uses the variant platform price');
      assert.equal(quoted.data.summary.total, charged.data.order.total, 'an online preview matches the online order total');
    }
    {
      const quote = await previewBasket({ items: [{ product_id: 'prod-cappuccino', quantity: 1, addons: [] }] });
      const order = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', quantity: 1 }] });
      assert.equal(quote.status, 400, 'a preview of a variant product without a variant is refused');
      assert.equal(order.status, 400, 'the same basket is refused by the order');
      assert.equal(quote.data.error, order.data.error, 'both surfaces refuse identically');

      const inactive = await previewBasket({ items: [{ product_id: 'prod-cappuccino', variant_id: 'var-retired', quantity: 1, addons: [] }] });
      assert.equal(inactive.status, 400, 'a preview with an inactive variant is refused');
      const inactiveOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-cappuccino', variant_id: 'var-retired', quantity: 1 }] });
      assert.equal(inactive.data.error, inactiveOrder.data.error, 'both surfaces refuse an inactive variant identically');
    }

    // ── A variant's portion scales the product's own ingredient recipe ────
    {
      const { createSupply, getSupply } = require('../main/services/supplies');
      const { saveRecipe } = require('../main/services/recipes');
      const beans = createSupply(db, { name: 'Portion beans', baseUnit: 'g', stockQuantity: 2000, actorUserId: owner.userId });
      const milk = createSupply(db, { name: 'Portion milk', baseUnit: 'ml', stockQuantity: 5000, actorUserId: owner.userId });
      const stockOfSupply = (id: string) => Number(getSupply(db, id).stock_quantity);
      const supplyMovements = (id: string, type: string) =>
        (db.prepare('SELECT quantity_delta FROM supply_movements WHERE supply_id = ? AND movement_type = ? ORDER BY id')
          .all(id, type) as any[]).map((movement) => movement.quantity_delta);
      const componentOf = (item: any, supplyId: string) =>
        JSON.parse(item.recipe_snapshot).components.find((component: any) => component.supply_id === supplyId).quantity;

      db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES ('prod-portion', 'cat-var-orders', 'Cortado', 300, 0, 0, ?, ?)`).run(now(), now());
      db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES ('prod-portion-plain', 'cat-var-orders', 'Plain portion', 300, 0, 0, ?, ?)`).run(now(), now());

      insertVariant(db, { id: 'var-half', product_id: 'prod-portion', name: 'Half', price: 200, recipe_multiplier: 0.5 });
      insertVariant(db, { id: 'var-whole', product_id: 'prod-portion', name: 'Whole', price: 300 });
      insertVariant(db, { id: 'var-double', product_id: 'prod-portion', name: 'Double', price: 500, recipe_multiplier: 2 });
      insertVariant(db, { id: 'var-plain-double', product_id: 'prod-portion-plain', name: 'Double', price: 500, recipe_multiplier: 2 });

      saveRecipe(db, {
        productId: 'prod-portion',
        yieldQuantity: 1,
        items: [
          { supplyId: beans.id, quantity: 18, unit: 'g' },
          { supplyId: milk.id, quantity: 200, unit: 'ml' },
        ],
      });
      assert.equal(db.prepare('SELECT recipe_multiplier FROM product_variants WHERE id = ?').get('var-whole').recipe_multiplier, 1, 'a variant without a portion column value consumes one portion');

      // Half portion, two ordered: half of the base recipe, twice over.
      const beansBeforeHalf = stockOfSupply(beans.id);
      const milkBeforeHalf = stockOfSupply(milk.id);
      const halfOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion', variant_id: 'var-half', quantity: 2 }] });
      assert.equal(halfOrder.status, 201, `a half-portion variant order is created (${JSON.stringify(halfOrder.data)})`);
      const halfItem = itemOf(halfOrder.data.order.id);
      assert.equal(componentOf(halfItem, beans.id), 18, 'a half portion depletes half of 18 g x 2');
      assert.equal(componentOf(halfItem, milk.id), 200, 'the ml ingredient scales by the same portion');
      assert.equal(stockOfSupply(beans.id), beansBeforeHalf - 18, 'half-portion bean stock follows the snapshot');
      assert.equal(stockOfSupply(milk.id), milkBeforeHalf - 200, 'half-portion milk stock follows the snapshot');
      assert.deepEqual(supplyMovements(beans.id, 'recipe_depletion'), [-18], 'one depletion movement carries the scaled amount');

      // Double portion on the append path, which is the other authoritative writer.
      const beansBeforeDouble = stockOfSupply(beans.id);
      const doubleOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-plain', quantity: 1 }] });
      const appended = await addItems(doubleOrder.data.order.id, [{ product_id: 'prod-portion', variant_id: 'var-double', quantity: 1 }]);
      assert.equal(appended.status, 200, `a double-portion variant can be appended (${JSON.stringify(appended.data)})`);
      const doubleItem = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND variant_id = 'var-double'").get(doubleOrder.data.order.id) as any;
      assert.equal(componentOf(doubleItem, beans.id), 36, 'a double portion appended to an order depletes twice the base recipe');
      assert.equal(stockOfSupply(beans.id), beansBeforeDouble - 36, 'appending depletes the supply once for the doubled amount');

      // A whole portion is the untouched default.
      const wholeOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion', variant_id: 'var-whole', quantity: 1 }] });
      assert.equal(componentOf(itemOf(wholeOrder.data.order.id), beans.id), 18, 'a whole portion depletes exactly the base recipe');

      // A later portion edit cannot rewrite what an order already recorded.
      const beansBeforeEdit = stockOfSupply(beans.id);
      db.prepare('UPDATE product_variants SET recipe_multiplier = 0.5 WHERE id = ?').run('var-double');
      const cancelDouble = await api(baseUrl, `/api/orders/${doubleOrder.data.order.id}/items/${doubleItem.id}/cancel`, {
        method: 'PATCH', headers: owner.authHeader, body: {},
      });
      assert.equal(cancelDouble.status, 200, 'a portion-variant item can be cancelled');
      assert.equal(stockOfSupply(beans.id), beansBeforeEdit + 36, 'cancelling restores the snapshotted double portion, not the edited one');

      const restoreDouble = await api(baseUrl, `/api/orders/${doubleOrder.data.order.id}/items/${doubleItem.id}/restore`, {
        method: 'PATCH', headers: owner.authHeader, body: {},
      });
      assert.equal(restoreDouble.status, 200, 'a portion-variant item can be restored');
      assert.equal(stockOfSupply(beans.id), beansBeforeEdit, 'restoring re-depletes the snapshotted amount');
      db.prepare('UPDATE product_variants SET recipe_multiplier = 2 WHERE id = ?').run('var-double');

      // Void after preparation is waste: the portion is not returned.
      const voidOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion', variant_id: 'var-double', quantity: 1 }] });
      const voidItem = itemOf(voidOrder.data.order.id);
      await api(baseUrl, `/api/order-items/${voidItem.id}/status`, { method: 'PATCH', headers: owner.authHeader, body: { status: 'preparing' } });
      const beansBeforeVoid = stockOfSupply(beans.id);
      const voided = await api(baseUrl, `/api/orders/${voidOrder.data.order.id}/items/${voidItem.id}/cancel`, {
        method: 'PATCH', headers: owner.authHeader, body: { override_pin: '1234' },
      });
      assert.equal(voided.status, 200, 'a prepared portion-variant item can be voided');
      assert.equal(stockOfSupply(beans.id), beansBeforeVoid, 'voiding a prepared portion restores none of its ingredients');

      // A portion on a product with no recipe has no effect, and does not block the sale.
      const movementsBeforePlain = supplyMovements(beans.id, 'recipe_depletion').length;
      const plainOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion-plain', variant_id: 'var-plain-double', quantity: 1 }] });
      assert.equal(plainOrder.status, 201, 'a portion variant of a product without a recipe is still sellable');
      assert.equal(itemOf(plainOrder.data.order.id).recipe_snapshot, null, 'a product without a recipe records no snapshot');
      assert.equal(supplyMovements(beans.id, 'recipe_depletion').length, movementsBeforePlain, 'a portion without a recipe depletes nothing');

      // An inactive recipe skips depletion whatever the portion says.
      saveRecipe(db, { productId: 'prod-portion', yieldQuantity: 1, isActive: false, items: [{ supplyId: beans.id, quantity: 18, unit: 'g' }] });
      const beansBeforeInactive = stockOfSupply(beans.id);
      const inactiveOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion', variant_id: 'var-double', quantity: 1 }] });
      assert.equal(inactiveOrder.status, 201, 'an inactive recipe does not block the sale');
      assert.equal(stockOfSupply(beans.id), beansBeforeInactive, 'an inactive recipe depletes nothing for any portion');

      // A non-unit yield still divides, with the portion applied on top.
      saveRecipe(db, {
        productId: 'prod-portion',
        yieldQuantity: 4,
        items: [{ supplyId: beans.id, quantity: 100, unit: 'g' }],
      });
      const beansBeforeYield = stockOfSupply(beans.id);
      const yieldOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion', variant_id: 'var-double', quantity: 2 }] });
      assert.equal(componentOf(itemOf(yieldOrder.data.order.id), beans.id), 100, 'a double portion of a 4-portion recipe follows base x qty x portion / yield');
      assert.equal(stockOfSupply(beans.id), beansBeforeYield - 100, 'the yield-scaled portion reaches supply stock');

      // Linked product stock and the ingredient portion are independent.
      db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES ('prod-portion-linked', 'cat-var-orders', 'Linked portion', 300, 1, 20, ?, ?)`).run(now(), now());
      insertVariant(db, {
        id: 'var-linked-half', product_id: 'prod-portion-linked', name: 'Half linked', price: 300,
        inventory_product_id: 'prod-dough', inventory_deduction_quantity: 2, recipe_multiplier: 0.5,
      });
      saveRecipe(db, { productId: 'prod-portion-linked', yieldQuantity: 1, items: [{ supplyId: beans.id, quantity: 60, unit: 'g' }] });
      const doughBefore = stockOfProduct(db, 'prod-dough');
      const beansBeforeLinked = stockOfSupply(beans.id);
      const linkedOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion-linked', variant_id: 'var-linked-half', quantity: 3 }] });
      assert.equal(linkedOrder.status, 201, 'a portioned variant with a linked stock factor is sellable');
      assert.equal(stockOfProduct(db, 'prod-dough'), doughBefore - 6, 'the linked stock factor still moves its own pool');
      assert.equal(stockOfSupply(beans.id), beansBeforeLinked - 90, 'the ingredient portion scales the product recipe independently');

      // A negative balance is allowed: portion scaling must not gate order taking.
      const scarce = createSupply(db, { name: 'Portion scarce', baseUnit: 'g', stockQuantity: 5, actorUserId: owner.userId });
      db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
        VALUES ('prod-portion-scarce', 'cat-var-orders', 'Scarce portion', 300, 0, 0, ?, ?)`).run(now(), now());
      insertVariant(db, { id: 'var-scarce-double', product_id: 'prod-portion-scarce', name: 'Double', price: 500, recipe_multiplier: 2 });
      saveRecipe(db, { productId: 'prod-portion-scarce', yieldQuantity: 1, items: [{ supplyId: scarce.id, quantity: 18, unit: 'g' }] });
      const scarceOrder = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion-scarce', variant_id: 'var-scarce-double', quantity: 1 }] });
      assert.equal(scarceOrder.status, 201, 'a portioned sale still goes through when the ingredient runs out');
      assert.equal(stockOfSupply(scarce.id), 5 - 36, 'the scaled amount is deducted even past zero');

      // A corrupt portion is refused and rolls the whole order back.
      db.prepare('UPDATE product_variants SET recipe_multiplier = ? WHERE id = ?').run(Infinity, 'var-double');
      const ordersBeforeInvalid = (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count;
      const movementsBeforeInvalid = supplyMovements(beans.id, 'recipe_depletion').length;
      const invalid = await createOrder({ type: 'takeaway', items: [{ product_id: 'prod-portion', variant_id: 'var-double', quantity: 1 }] });
      assert.equal(invalid.status, 400, `a non-finite portion is refused rather than depleting a nonsense amount (${JSON.stringify(invalid.data)})`);
      assert.match(String(invalid.data.error), /multiplier|finite/i, 'the refusal names the scaling problem');
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count, ordersBeforeInvalid, 'a refused portion leaves no order behind');
      assert.equal(supplyMovements(beans.id, 'recipe_depletion').length, movementsBeforeInvalid, 'a refused portion depletes nothing');
      db.prepare('UPDATE product_variants SET recipe_multiplier = 2 WHERE id = ?').run('var-double');
    }

    console.log('\n✅ Product variant order tests passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('\n❌ Test failed:');
  console.error(err);
  process.exit(1);
});