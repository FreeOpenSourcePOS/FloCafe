/**
 * Product variants API and inventory rules.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-variants-api.test.ts
 *
 * Covers the two behaviours the rest of the variant stack depends on:
 * product create/update owns its variant list (transactional upsert, generated
 * ids, catalog-wide barcode uniqueness, soft deactivation instead of deletion)
 * and the inventory service prefers a variant's recipe multiplier, then the
 * variant's own stock pool, then the base product.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-variants-api-'));

Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-product-variants-api';

const assert = require('node:assert/strict');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, api, closeDatabase,
} = require('./helpers/test-setup');
const { productRoutes } = require('../main/routes/products');
const { resolveInventoryDeduction, adjustProductStock } = require('../main/services/inventory');

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-drinks', 'Drinks');
  seedCategory(db, 'cat-food', 'Food');

  // The recipe base ingredient a variant depletes instead of itself.
  db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, created_at, updated_at)
    VALUES ('prod-dough', 'cat-food', 'Pizza dough', 40, 1, 100, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`).run();

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);
  const variantCount = (productId: string, activeOnly = true) =>
    (db.prepare(
      `SELECT COUNT(*) AS count FROM product_variants WHERE product_id = ?${activeOnly ? ' AND is_active = 1' : ''}`,
    ).get(productId) as { count: number }).count;

  try {
    // ── A second product, so cross-product rules have something to bite on ──
    const cookie = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        category_id: 'cat-food',
        name: 'Cookie',
        price: 120,
        variants: [{ name: 'Chunky', price: 120, barcode: 'CK-1' }],
      },
    });
    assert.equal(cookie.status, 201, `a second product with a variant is created (${JSON.stringify(cookie.data)})`);
    const cookieVariantId = cookie.data.product.variants[0].id;
    assert.equal(typeof cookieVariantId, 'string', 'the create response carries the generated variant');

    // ── Create with variants ─────────────────────────────────────────────
    const created = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        category_id: 'cat-drinks',
        name: 'Cappuccino',
        price: 400,
        dietary_tags: ['veg', 'veg', 'gluten-free'],
        variants: [
          { name: 'Small', price: 300, sku: 'CAP-S', barcode: 'CAP-S', stock_quantity: 5, track_inventory: true },
          { name: 'Large', price: 500, barcode: 'CAP-L', online_price: 520 },
          { name: 'Twelve inch', price: 700, inventory_product_id: 'prod-dough', inventory_deduction_quantity: 2 },
        ],
      },
    });
    assert.equal(created.status, 201, `product with variants is created (${JSON.stringify(created.data)})`);
    const productId = created.data.product.id;
    assert.deepEqual(created.data.product.dietary_tags, ['veg', 'gluten-free'], 'dietary tags are stored deduplicated');

    const createdVariants = db.prepare(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, name',
    ).all(productId) as any[];
    assert.equal(createdVariants.length, 3, 'every submitted variant is written');
    assert.ok(
      createdVariants.every((variant) => typeof variant.id === 'string' && variant.id.length > 0),
      'a missing variant id is generated server-side',
    );
    assert.deepEqual(
      createdVariants.map((variant) => [variant.name, variant.track_inventory, variant.stock_quantity]),
      [['Small', 1, 5], ['Large', 0, 0], ['Twelve inch', 0, 0]],
      'variants keep their submitted order, tracking flag, and opening stock',
    );
    const smallVariant = createdVariants.find((variant) => variant.name === 'Small');
    const largeVariant = createdVariants.find((variant) => variant.name === 'Large');
    const doughVariant = createdVariants.find((variant) => variant.name === 'Twelve inch');
    assert.equal(doughVariant.inventory_product_id, 'prod-dough', 'a recipe variant keeps its base ingredient');
    assert.equal(doughVariant.inventory_deduction_quantity, 2, 'an explicit recipe multiplier is stored');

    const variantStockMovements = db.prepare(
      'SELECT * FROM inventory_movements WHERE variant_id IS NOT NULL',
    ).all() as any[];
    assert.equal(variantStockMovements.length, 1, 'opening variant stock is recorded in the ledger');
    assert.equal(variantStockMovements[0].product_id, productId, 'the variant ledger row names the owning product');
    assert.equal(variantStockMovements[0].variant_id, smallVariant.id, 'the variant ledger row names the variant');
    assert.equal(variantStockMovements[0].quantity_delta, 5, 'the variant ledger row records the opening delta');

    // ── Reads carry the serialized variants ──────────────────────────────
    const single = await api(baseUrl, `/api/products/${productId}`, { headers: owner.authHeader });
    assert.equal(single.status, 200);
    assert.deepEqual(
      single.data.product.variants.map((variant: any) => [variant.name, variant.track_inventory, variant.is_active]),
      [['Small', true, true], ['Large', false, true], ['Twelve inch', false, true]],
      'the single-product read returns active variants in sort order',
    );
    assert.deepEqual(single.data.product.dietary_tags, ['veg', 'gluten-free'], 'the read returns dietary tags as an array');

    const list = await api(baseUrl, '/api/products', { headers: owner.authHeader });
    const listed = list.data.products.find((product: any) => product.id === productId);
    assert.equal(listed.variants.length, 3, 'the bulk read batch-loads variants');
    assert.deepEqual(listed.dietary_tags, ['veg', 'gluten-free'], 'the bulk read returns dietary tags as an array');

    // ── Barcode uniqueness spans products and variants ────────────────────
    const duplicateVariantBarcode = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: { category_id: 'cat-drinks', name: 'Tea', price: 200, variants: [{ name: 'Regular', price: 200, barcode: 'CAP-S' }] },
    });
    assert.equal(duplicateVariantBarcode.status, 400, 'a barcode already held by another product variant is rejected');
    assert.match(duplicateVariantBarcode.data.error, /barcode/i, 'the rejection names the barcode conflict');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM products WHERE name = 'Tea'").get() as { count: number }).count,
      0,
      'a create rejected over a variant barcode leaves no product behind',
    );

    const productTakesVariantBarcode = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { barcode: 'CAP-S' },
    });
    assert.equal(productTakesVariantBarcode.status, 400, 'a product cannot take a barcode one of its variants holds');

    // ── Rejections are atomic and leave the catalog untouched ────────────
    const variantsBefore = variantCount(productId, false);
    const invalidCreate = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        category_id: 'cat-drinks',
        name: 'Broken',
        price: 100,
        variants: [{ name: 'Fine', price: 100 }, { name: 'No price' }],
      },
    });
    assert.equal(invalidCreate.status, 400, 'a variant without a price is rejected');
    assert.equal(variantCount(productId, false), variantsBefore, 'no variant from a rejected request is written');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM products WHERE name = 'Broken'").get() as { count: number }).count,
      0,
      'no product from a rejected request is written',
    );

    for (const [label, body] of [
      ['a non-array variants payload', { variants: 'Small' }],
      ['a variant claiming another product\'s variant id', { variants: [{ id: cookieVariantId, name: 'Hijack', price: 1 }] }],
      ['a variant with an unknown recipe product', { variants: [{ name: 'Dough', price: 1, inventory_product_id: 'missing' }] }],
      ['a variant with a self recipe link', { variants: [{ name: 'Dough', price: 1, inventory_product_id: productId }] }],
      ['a variant with a non-positive multiplier', { variants: [{ name: 'Dough', price: 1, inventory_product_id: 'prod-dough', inventory_deduction_quantity: 0 }] }],
      ['a variant with a negative price', { variants: [{ name: 'Bad', price: -1 }] }],
      ['a duplicated variant id', { variants: [{ id: smallVariant.id, name: 'A', price: 1 }, { id: smallVariant.id, name: 'B', price: 1 }] }],
      ['a variant claiming a barcode of another product variant', { variants: [{ name: 'Clone', price: 1, barcode: 'CK-1' }] }],
    ] as [string, Record<string, unknown>][]) {
      const rejected = await api(baseUrl, `/api/products/${productId}`, {
        method: 'PUT', headers: owner.authHeader, body,
      });
      assert.equal(rejected.status, 400, `${label} is rejected`);
    }
    assert.equal(variantCount(productId, false), variantsBefore, 'no rejected update wrote a variant');
    assert.deepEqual(
      created.data.product.variants.map((variant: any) => variant.name),
      ['Small', 'Large', 'Twelve inch'],
      'rejected updates leave the active variant list untouched',
    );

    const dietaryTagRejection = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { dietary_tags: 'vegan' },
    });
    assert.equal(dietaryTagRejection.status, 400, 'a non-array dietary_tags payload is rejected');
    assert.equal(
      db.prepare('SELECT dietary_tags FROM products WHERE id = ?').get(productId).dietary_tags,
      '["veg","gluten-free"]',
      'a rejected dietary_tags payload leaves the stored value untouched',
    );

    // ── Update: upsert, restock, soft-deactivate what the client drops ────
    const updated = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        price: 450,
        variants: [
          { id: smallVariant.id, name: 'Small', price: 300, sku: 'CAP-S', barcode: 'CAP-S', stock_quantity: 8, track_inventory: true },
          { name: 'Medium', price: 400, barcode: 'CAP-M', stock_quantity: 2 },
          { id: doughVariant.id, name: 'Twelve inch', price: 700, inventory_product_id: 'prod-dough', inventory_deduction_quantity: 2 },
        ],
      },
    });
    assert.equal(updated.status, 200, `the variant list round-trips (${JSON.stringify(updated.data)})`);
    assert.equal(updated.data.product.price, 450, 'the product update still applies alongside variants');
    assert.deepEqual(
      updated.data.product.variants.map((variant: any) => variant.name),
      ['Small', 'Medium', 'Twelve inch'],
      'a variant the client omitted is soft-deactivated, not deleted',
    );
    assert.equal(
      db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(smallVariant.id).stock_quantity,
      8,
      'a variant stock change is applied through the ledger path',
    );
    assert.equal(
      db.prepare('SELECT is_active FROM product_variants WHERE id = ?').get(largeVariant.id).is_active,
      0,
      'the dropped variant keeps its row with is_active = 0',
    );
    assert.equal(
      db.prepare('SELECT price FROM products WHERE id = ?').get(productId).price,
      450,
      'the base product price survives the variant update',
    );
    assert.deepEqual(
      (db.prepare('SELECT quantity_delta FROM inventory_movements WHERE variant_id = ? ORDER BY id').all(smallVariant.id) as any[])
        .map((movement) => movement.quantity_delta),
      [5, 3],
      'variant stock moves through the ledger as deltas, one row per write',
    );

    // A soft-deactivated variant releases its barcode.
    const reusedBarcode = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: { category_id: 'cat-drinks', name: 'Tea', price: 200, variants: [{ name: 'Regular', price: 200, barcode: 'CAP-L' }] },
    });
    assert.equal(reusedBarcode.status, 201, 'a soft-deactivated variant releases its barcode');

    // ── Partial updates leave variants alone ─────────────────────────────
    const renamedOnly = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { name: 'Cappuccino Bar' },
    });
    assert.equal(renamedOnly.status, 200);
    assert.equal(variantCount(productId), 3, 'an update without a variants key does not deactivate anything');

    const clearedTags = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { dietary_tags: null },
    });
    assert.equal(clearedTags.status, 200);
    assert.equal(
      db.prepare('SELECT dietary_tags FROM products WHERE id = ?').get(productId).dietary_tags,
      null,
      'an explicit null clears the dietary tags',
    );

    // ── Guards the review round added ───────────────────────────────────
    // The product-barcode guard also covers the stored barcode: a variant may
    // not claim the barcode of the product it belongs to, even when the
    // request omits the barcode key entirely.
    const sharedBarcodeProduct = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: { category_id: 'cat-drinks', name: 'Shared', price: 100, barcode: 'SHARED-1' },
    });
    assert.equal(sharedBarcodeProduct.status, 201, 'a product with a barcode is created');
    const variantTakesProductBarcode = await api(baseUrl, `/api/products/${sharedBarcodeProduct.data.product.id}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { variants: [{ name: 'Solo', price: 100, barcode: 'SHARED-1' }] },
    });
    assert.equal(variantTakesProductBarcode.status, 400, 'a variant cannot take its own product barcode');

    // A variant may be deactivated in the same request that keeps its barcode
    // in the payload: Component 2 accepts is_active, and the row survives.
    const deactivateBarcodedVariant = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        variants: db.prepare('SELECT id, name, price, barcode, sku FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order')
          .all(productId)
          .map((variant: any) => ({ ...variant, is_active: false })),
      },
    });
    assert.equal(
      deactivateBarcodedVariant.status,
      200,
      `a barcoded variant can be deactivated in the same request (${JSON.stringify(deactivateBarcodedVariant.data)})`,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM product_variants WHERE product_id = ? AND is_active = 1').get(productId) as { count: number }).count,
      0,
      'every variant in the payload is deactivated',
    );
    assert.equal(
      (db.prepare('SELECT is_active FROM product_variants WHERE id = ?').get(smallVariant.id) as { is_active: number }).is_active,
      0,
      'the deactivated variant keeps its row for historical references',
    );

    // The delete guard covers recipe bases referenced by a live variant, not
    // only by a product's own inventory link.
    const recipeProduct = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        category_id: 'cat-food',
        name: 'Recipe Pizza',
        price: 700,
        variants: [{ name: 'Large', price: 700, inventory_product_id: 'prod-dough' }],
      },
    });
    assert.equal(recipeProduct.status, 201, 'a product with a live recipe variant is created');
    const recipeGuard = await api(baseUrl, '/api/products/prod-dough', {
      method: 'DELETE', headers: owner.authHeader,
    });
    assert.equal(recipeGuard.status, 409, 'a product used as a live variant recipe base cannot be deleted');
    assert.equal(
      (db.prepare('SELECT deleted_at FROM products WHERE id = ?').get('prod-dough') as { deleted_at: string | null }).deleted_at,
      null,
      'the rejected delete leaves the recipe base active',
    );

    // An over-long variants array is a client-input rejection, like every other
    // 400 in this file, not an HTTP 500 from an oversized statement.
    const tooManyVariants = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        category_id: 'cat-drinks',
        name: 'Too Many',
        price: 100,
        variants: Array.from({ length: 65 }, (_, index) => ({ name: `V${index}`, price: 100 })),
      },
    });
    assert.equal(tooManyVariants.status, 400, 'more than 64 variants is rejected as a client error');
    assert.match(tooManyVariants.data.error, /at most 64/, 'the rejection states the cap');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM products WHERE name = 'Too Many'").get() as { count: number }).count,
      0,
      'the rejected over-long request writes nothing',
    );

    // A variant id from another product can never be written through this
    // product, and that product's variant row stays untouched.
    const cookieVariantBefore = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(cookieVariantId);
    const crossProductVariantId = await api(baseUrl, `/api/products/${productId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { variants: [{ id: cookieVariantId, name: 'Hijacked', price: 1 }] },
    });
    assert.equal(crossProductVariantId.status, 400, 'a variant id owned by another product is rejected');
    assert.deepEqual(
      db.prepare('SELECT * FROM product_variants WHERE id = ?').get(cookieVariantId),
      cookieVariantBefore,
      "the other product's variant row is byte-identical after the rejected write",
    );

    // ── Transaction atomicity ───────────────────────────────────────────
    // Force a failure inside the product transaction and prove nothing the
    // request wrote survives, including the field update that ran first.
    db.exec(`
      CREATE TRIGGER test_variant_write_failure BEFORE INSERT ON product_variants
      WHEN NEW.name = 'Explode'
      BEGIN SELECT RAISE(ABORT, 'forced variant write failure'); END;
    `);
    const variantMovementsBefore = (db.prepare(
      `SELECT COUNT(*) AS count FROM inventory_movements WHERE variant_id IS NOT NULL`,
    ).get() as { count: number }).count;
    try {
      const failedCreate = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          category_id: 'cat-drinks',
          name: 'Atomic Product',
          price: 100,
          variants: [{ name: 'Good', price: 100, stock_quantity: 3 }, { name: 'Explode', price: 100 }],
        },
      });
      assert.equal(failedCreate.status, 500, 'a mid-transaction failure surfaces as a server error');
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM products WHERE name = 'Atomic Product'").get() as { count: number }).count,
        0,
        'the product insert is rolled back with the failed variant write',
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM product_variants WHERE name IN ('Good', 'Explode')").get() as { count: number }).count,
        0,
        'no variant from the failed request survives',
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE variant_id IS NOT NULL').get() as { count: number }).count,
        variantMovementsBefore,
        'the variant ledger row written before the failure is rolled back too',
      );

      const before = db.prepare('SELECT price FROM products WHERE id = ?').get(productId) as { price: number };
      const failedUpdate = await api(baseUrl, `/api/products/${productId}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: {
          price: 999,
          variants: [{ name: 'Survivor', price: 100 }, { name: 'Explode', price: 100 }],
        },
      });
      assert.equal(failedUpdate.status, 500, 'a mid-transaction failure aborts the update');
      assert.deepEqual(
        db.prepare('SELECT price FROM products WHERE id = ?').get(productId),
        before,
        'the product field update is rolled back with the failed variant write',
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM product_variants WHERE name = 'Survivor'").get() as { count: number }).count,
        0,
        'the variant written before the failure is rolled back',
      );
    } finally {
      db.exec('DROP TRIGGER IF EXISTS test_variant_write_failure');
    }

    // ── Inventory rules ──────────────────────────────────────────────────
    assert.deepEqual(
      resolveInventoryDeduction(
        { id: 'pizza', track_inventory: 0 },
        3,
        { id: 'v-large', inventory_product_id: 'prod-dough', inventory_deduction_quantity: 2 },
      ),
      { productId: 'prod-dough', deductedQuantity: 6 },
      'a recipe multiplier wins and scales by quantity',
    );
    assert.deepEqual(
      resolveInventoryDeduction(
        { id: 'pizza', track_inventory: 1, stock_quantity: 9 },
        2,
        { id: 'v-small', track_inventory: true },
      ),
      { productId: 'pizza', deductedQuantity: 2, variantId: 'v-small' },
      'a tracked variant deducts its own stock pool and names itself',
    );
    assert.deepEqual(
      resolveInventoryDeduction({ id: 'pizza', track_inventory: 1 }, 2, { id: 'v-plain', track_inventory: false }),
      { productId: 'pizza', deductedQuantity: 2 },
      'a variant that tracks nothing falls back to the base product rule',
    );
    assert.equal(
      resolveInventoryDeduction({ id: 'pizza', track_inventory: 1 }, 2, { id: 'v-bad', inventory_product_id: 'prod-dough', inventory_deduction_quantity: -1 }),
      null,
      'an invalid recipe multiplier yields no deduction instead of falling through',
    );
    assert.deepEqual(
      resolveInventoryDeduction({ id: 'pizza', track_inventory: 1 }, 2),
      { productId: 'pizza', deductedQuantity: 2 },
      'the two-argument form still resolves exactly as before',
    );

    db.prepare(`INSERT INTO product_variants (id, product_id, name, price, track_inventory, stock_quantity, is_active, created_at, updated_at)
      VALUES ('v-seeded', ?, 'Seeded', 100, 1, 4, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`).run(productId);

    adjustProductStock(db, {
      productId,
      variantId: 'v-seeded',
      quantityDelta: -3,
      movementType: 'sale',
      referenceType: 'order_item',
      referenceId: '7',
      actorUserId: owner.userId,
    });
    assert.equal(
      db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get('v-seeded').stock_quantity,
      1,
      'a variant stock delta moves the variant pool',
    );
    assert.equal(
      db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity,
      0,
      'a variant stock delta leaves the product pool alone',
    );

    assert.throws(
      () => adjustProductStock(db, {
        productId,
        variantId: 'v-seeded',
        quantityDelta: -50,
        movementType: 'sale',
        actorUserId: owner.userId,
      }),
      /Insufficient stock/,
      'a variant cannot be driven below zero',
    );
    assert.throws(
      () => adjustProductStock(db, {
        productId,
        variantId: 'v-missing',
        quantityDelta: 1,
        movementType: 'adjustment',
        actorUserId: owner.userId,
      }),
      /Variant not found/,
      'adjusting an unknown variant is rejected, not silently written to the product',
    );

    // The variant pool is scoped to its owning product: another product's id
    // must not move this variant's stock, even with a real variant id.
    assert.throws(
      () => adjustProductStock(db, {
        productId: 'prod-dough',
        variantId: 'v-seeded',
        quantityDelta: 1,
        movementType: 'adjustment',
        actorUserId: owner.userId,
      }),
      /Variant not found/,
      "a variant cannot be adjusted through a product that does not own it",
    );
    assert.equal(
      db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get('v-seeded').stock_quantity,
      1,
      "the rejected cross-product adjustment leaves the owner's variant stock untouched",
    );

    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'the catalog has no foreign-key violations');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✅ Product variants API tests passed');
}

main().catch((error) => {
  try { closeDatabase(); } catch { }
  console.error(error);
  process.exit(1);
});
