/**
 * Ingredient cost tracking (#1283): migration v117, WAC + negative-stock reset,
 * unit normalization, 0/2/3-decimal currencies, recipe cost derivation, and
 * frozen order-item cost immutability across order lifecycle.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/ingredient-cost-lifecycle.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ingredient-cost-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
} = require('./helpers/test-setup');
const { MIGRATIONS, getCurrentSchemaVersion } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const {
  createSupply,
  getSupply,
  recordSupplyMovement,
  updateSupply,
} = require('../main/services/supplies');
const { buildRecipeSnapshot, getRecipeByProduct, saveRecipe } = require('../main/services/recipes');

const PRISTINE_MIGRATIONS = MIGRATIONS.slice();

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assertOrThrow(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqualOrThrow(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Ingredient cost lifecycle test');
  console.log('='.repeat(65));
  resetCounters();

  try {
    // ── 1. Migration v116 -> v117 upgrade path & fresh schema ──
    console.log('\n--- 1. Upgrade migration v116 -> v117 ---');
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...PRISTINE_MIGRATIONS.filter((m: any) => m.version <= 116));

    const db = initTestDb();
    assertEqualOrThrow(getCurrentSchemaVersion(), 116, 'fixture starts at schema v116');
    const { authHeader, userId } = seedOwnerUser(db);
    seedManagerUser(db);
    seedCategory(db, 'cat-cost', 'Coffee & Bakery');
    seedProduct(db, 'prod-latte', 'cat-cost', 'Latte', 5.0, {
      track_inventory: false,
      stock_quantity: 0,
      cost: 1.25, // legacy manual products.cost must be ignored by recipe costing
    });
    seedProduct(db, 'prod-muffin', 'cat-cost', 'Muffin (No Recipe)', 3.5, {
      track_inventory: false,
      stock_quantity: 0,
      cost: 0.9,
    });
    seedTable(db, 'tbl-cost-1', 1, 4);

    // Insert pre-v117 supply, movement, and order_item before running v117
    db.prepare(`
      INSERT INTO supplies (id, name, base_unit, stock_quantity, low_stock_threshold, is_active, created_at, updated_at)
      VALUES ('sup_legacy', 'Legacy Sugar', 'g', 500, 50, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `).run();
    db.prepare(`
      INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, reason, actor_user_id, created_at)
      VALUES ('sup_legacy', 500, 'receive', 'g', 500, 'Pre-v117 receive', ?, '2026-01-01 00:00:00')
    `).run(userId);
    db.prepare(`
      INSERT INTO orders (id, order_number, user_id, type, status, subtotal, total, created_at, updated_at)
      VALUES (1, 'ORD-LEGACY-1', ?, 'takeaway', 'completed', 5.0, 5.0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `).run(userId);
    db.prepare(`
      INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (1, 1, 'prod-latte', 'Latte', 5.0, 1, 5.0, 5.0, 'completed', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `).run();

    // Now restore full MIGRATIONS and apply v117
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...PRISTINE_MIGRATIONS);
    const v117 = MIGRATIONS.find((m: any) => m.version === 117);
    assertOrThrow(Boolean(v117), 'migration v117 exists in registry');
    db.transaction(() => {
      v117.up();
      db.pragma('user_version = 117');
    })();
    assertEqualOrThrow(getCurrentSchemaVersion(), 117, 'database upgraded to v117');

    const legacySupply = getSupply(db, 'sup_legacy');
    assertEqualOrThrow(legacySupply.unit_cost, null, 'upgraded supply has unit_cost = null');
    const legacyMovement = db
      .prepare(
        "SELECT unit_cost, total_cost, unit_cost_after FROM supply_movements WHERE supply_id = 'sup_legacy'",
      )
      .get();
    assertEqualOrThrow(legacyMovement.unit_cost, null, 'upgraded movement has unit_cost = null');
    assertEqualOrThrow(legacyMovement.total_cost, null, 'upgraded movement has total_cost = null');
    assertEqualOrThrow(
      legacyMovement.unit_cost_after,
      null,
      'upgraded movement has unit_cost_after = null',
    );
    const legacyOrderItem = db
      .prepare('SELECT ingredient_cost, ingredient_cost_known FROM order_items WHERE id = 1')
      .get();
    assertEqualOrThrow(
      legacyOrderItem.ingredient_cost,
      null,
      'upgraded order_item has ingredient_cost = null',
    );
    assertEqualOrThrow(
      legacyOrderItem.ingredient_cost_known,
      0,
      'upgraded order_item has ingredient_cost_known = 0',
    );

    // ── 2. Unit normalization & Weighted Average Cost (WAC) + negative stock reset ──
    console.log('\n--- 2. Unit normalization & WAC + negative stock reset ---');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('currency', 'USD')").run();

    const flour = createSupply(db, {
      name: 'Bread Flour',
      baseUnit: 'g',
      stockQuantity: 0,
      actorUserId: userId,
    });
    assertEqualOrThrow(flour.unit_cost, null, 'new supply without cost has unit_cost = null');

    // Receive 5 kg (5000 g) at $10.00 total -> $0.002 / g
    const recv1 = recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'receive',
      quantity: 5,
      unit: 'kg',
      totalCost: 10,
      actorUserId: userId,
      reason: 'Bag 1',
    });
    assertEqualOrThrow(recv1.quantity_delta, 5000, 'receive converts 5 kg to 5000 g');
    assertEqualOrThrow(recv1.unit_cost, 0.002, 'movement stores batch unit_cost per base_unit (g)');
    assertEqualOrThrow(recv1.total_cost, 10, 'movement stores batch total_cost');
    assertEqualOrThrow(recv1.unit_cost_after, 0.002, 'movement stores unit_cost_after');
    assertEqualOrThrow(
      getSupply(db, flour.id).unit_cost,
      0.002,
      'supply unit_cost set to 0.002 / g',
    );

    // Receive 5 kg (5000 g) at $4.00 per kg ($0.004 / g) -> WAC = (5000*0.002 + 5000*0.004)/10000 = 0.003 / g
    const recv2 = recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'receive',
      quantity: 5,
      unit: 'kg',
      unitCost: 4,
      actorUserId: userId,
      reason: 'Bag 2',
    });
    assertEqualOrThrow(recv2.unit_cost, 0.004, 'second receive normalizes $4/kg to $0.004/g');
    assertEqualOrThrow(recv2.total_cost, 20, 'second receive derives total_cost = $20');
    assertEqualOrThrow(
      recv2.unit_cost_after,
      0.003,
      'WAC blends 5000g @ 0.002 and 5000g @ 0.004 -> 0.003/g',
    );
    assertEqualOrThrow(
      getSupply(db, flour.id).unit_cost,
      0.003,
      'supply stores blended WAC 0.003/g',
    );

    // Receive 2 kg without entering cost -> preserves existing WAC (0.003/g)
    const recvNoCost = recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'receive',
      quantity: 2,
      unit: 'kg',
      actorUserId: userId,
      reason: 'Unpriced delivery',
    });
    assertEqualOrThrow(
      recvNoCost.unit_cost,
      null,
      'unpriced receive has movement unit_cost = null',
    );
    assertEqualOrThrow(
      recvNoCost.total_cost,
      null,
      'unpriced receive has movement total_cost = null',
    );
    assertEqualOrThrow(
      recvNoCost.unit_cost_after,
      0.003,
      'unpriced receive preserves unit_cost_after = 0.003',
    );
    assertEqualOrThrow(
      getSupply(db, flour.id).unit_cost,
      0.003,
      'unpriced receive does not wipe supply unit_cost',
    );

    // Waste down to negative stock (-500 g), then receive exactly 500 g (stockBefore = -500, stockAfter = 0)
    recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'waste',
      quantity: 12.5,
      unit: 'kg',
      actorUserId: userId,
      reason: 'Empty + rush negative stock',
    });
    assertEqualOrThrow(getSupply(db, flour.id).stock_quantity, -500, 'flour stock is -500 g');

    const recvFromNegativeToZero = recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'receive',
      quantity: 500,
      unit: 'g',
      unitCost: 0.005,
      actorUserId: userId,
      reason: 'Replenish to zero',
    });
    assertEqualOrThrow(recvFromNegativeToZero.stock_after, 0, 'stock reaches 0 g');
    assertEqualOrThrow(
      getSupply(db, flour.id).unit_cost,
      0.005,
      'receive when stockBefore < 0 resets unit_cost to batch cost without division by zero',
    );

    // Receive while negative but ending positive (-200 g + 1000 g = +800 g)
    recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'waste',
      quantity: 200,
      unit: 'g',
      actorUserId: userId,
      reason: 'Rush negative',
    });
    assertEqualOrThrow(getSupply(db, flour.id).stock_quantity, -200, 'flour stock is -200 g');
    recordSupplyMovement(db, {
      supplyId: flour.id,
      movementType: 'receive',
      quantity: 1,
      unit: 'kg',
      unitCost: 6, // $6/kg = $0.006/g
      actorUserId: userId,
    });
    assertEqualOrThrow(
      getSupply(db, flour.id).unit_cost,
      0.006,
      'receive from -200 g to +800 g resets unit_cost to $0.006/g instead of weighting negative stock',
    );

    // Validation errors on cost
    expectServiceError(
      () =>
        recordSupplyMovement(db, {
          supplyId: flour.id,
          movementType: 'receive',
          quantity: 100,
          unit: 'g',
          unitCost: -1,
          actorUserId: userId,
        }),
      400,
      'rejects negative unit_cost on receive',
    );
    expectServiceError(
      () =>
        recordSupplyMovement(db, {
          supplyId: flour.id,
          movementType: 'waste',
          quantity: 100,
          unit: 'g',
          unitCost: 0.01,
          actorUserId: userId,
          reason: 'Bad cost on waste',
        }),
      400,
      'rejects unit_cost on non-receive movement',
    );

    // ── 3. Currency precision (0-decimal JPY, 2-decimal USD, 3-decimal KWD) ──
    console.log('\n--- 3. Sub-minor-unit supply cost & 0/2/3-decimal currency rounding ---');
    const matcha = createSupply(db, {
      name: 'Matcha Powder',
      baseUnit: 'g',
      stockQuantity: 1000,
      unitCost: 250, // 250 per kg = 0.25 per g
      unitCostUnit: 'kg',
      actorUserId: userId,
    });
    assertEqualOrThrow(matcha.unit_cost, 0.25, 'createSupply normalizes 250/kg to 0.25/g');

    seedProduct(db, 'prod-matcha', 'cat-cost', 'Matcha Shot', 500, {
      track_inventory: false,
      stock_quantity: 0,
    });
    saveRecipe(db, {
      productId: 'prod-matcha',
      yieldQuantity: 1,
      items: [{ supplyId: matcha.id, quantity: 15, unit: 'g' }], // 15 * 0.25 = 3.75
    });

    // 0-decimal currency (JPY): 3.75 rounds to 4
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('currency', 'JPY')").run();
    const snapJpy = buildRecipeSnapshot(db, 'prod-matcha', 1);
    assertEqualOrThrow(snapJpy.cost_known, true, 'JPY snapshot cost is known');
    assertEqualOrThrow(
      snapJpy.components[0].unit_cost,
      0.25,
      'JPY snapshot preserves sub-yen 0.25/g component unit_cost',
    );
    assertEqualOrThrow(
      snapJpy.total_ingredient_cost,
      4,
      'JPY (0 decimals) rounds 3.75 total_ingredient_cost to 4',
    );

    // 3-decimal currency (KWD): 0.0015 KWD/g * 15 g = 0.0225 KWD -> rounds to 0.023 KWD
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('currency', 'KWD')").run();
    updateSupply(db, matcha.id, { unitCost: 1.5, unitCostUnit: 'kg' }); // 0.0015 KWD/g
    const snapKwd = buildRecipeSnapshot(db, 'prod-matcha', 1);
    assertEqualOrThrow(
      snapKwd.components[0].unit_cost,
      0.0015,
      'KWD snapshot preserves sub-fils 0.0015/g component unit_cost',
    );
    assertEqualOrThrow(
      snapKwd.total_ingredient_cost,
      0.023,
      'KWD (3 decimals) rounds 0.0225 total_ingredient_cost to 0.023',
    );

    // Country-only currency fallback (settings.country = 'JP' or 'KW' without settings.currency)
    db.prepare("DELETE FROM settings WHERE key = 'currency'").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'KW')").run();
    const snapKwCountry = buildRecipeSnapshot(db, 'prod-matcha', 1);
    assertEqualOrThrow(
      snapKwCountry.total_ingredient_cost,
      0.023,
      'settings.country = KW (without settings.currency) resolves 3 fraction digits (KWD)',
    );
    updateSupply(db, matcha.id, { unitCost: 250, unitCostUnit: 'kg' }); // 0.25/g -> 3.75 for 15g
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'JP')").run();
    const snapJpCountry = buildRecipeSnapshot(db, 'prod-matcha', 1);
    assertEqualOrThrow(
      snapJpCountry.total_ingredient_cost,
      4,
      'settings.country = JP (without settings.currency) resolves 0 fraction digits (JPY)',
    );

    // Restore USD (2 decimals)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'US')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('currency', 'USD')").run();

    // ── 4. Unknown cost, partial recipe cost, variant portions, and order lifecycle immutability ──
    console.log('\n--- 4. Order lifecycle cost freezing & immutability ---');
    const espressoBeans = createSupply(db, {
      name: 'Espresso Beans',
      baseUnit: 'g',
      stockQuantity: 2000,
      unitCost: 20, // $20/kg = $0.02/g
      unitCostUnit: 'kg',
      actorUserId: userId,
    });
    const wholeMilk = createSupply(db, {
      name: 'Whole Milk',
      baseUnit: 'ml',
      stockQuantity: 5000,
      // No unitCost yet!
      actorUserId: userId,
    });

    saveRecipe(db, {
      productId: 'prod-latte',
      yieldQuantity: 1,
      items: [
        { supplyId: espressoBeans.id, quantity: 18, unit: 'g' }, // 18 * 0.02 = $0.36
        { supplyId: wholeMilk.id, quantity: 200, unit: 'ml' }, // unknown cost
      ],
    });

    const partialRecipe = getRecipeByProduct(db, 'prod-latte');
    assertEqualOrThrow(
      partialRecipe.cost_known,
      false,
      'recipe with 1 uncosted supply has cost_known = false',
    );
    assertEqualOrThrow(
      partialRecipe.unit_cost,
      null,
      'recipe with 1 uncosted supply has unit_cost = null (never partial understatement)',
    );

    const { orderRoutes } = require('../main/routes/orders');
    const { orderItemRoutes } = require('../main/routes/order-items');
    const app = createApp({
      '/api/orders': orderRoutes,
      '/api/order-items': orderItemRoutes,
    });
    registerRoutes(app);
    const { baseUrl, server } = await startServer(app);

    try {
      // Order placed while Whole Milk has no cost AND Muffin has no recipe
      const uncostedOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: authHeader,
        body: {
          type: 'takeaway',
          items: [
            { product_id: 'prod-latte', quantity: 2 },
            { product_id: 'prod-muffin', quantity: 1 },
          ],
        },
      });
      assertEqualOrThrow(uncostedOrderRes.status, 201, 'uncosted order created');
      const uncostedItems = db
        .prepare(
          'SELECT product_id, ingredient_cost, ingredient_cost_known FROM order_items WHERE order_id = ? ORDER BY id',
        )
        .all(uncostedOrderRes.data.order.id);
      assertEqualOrThrow(
        uncostedItems[0].ingredient_cost,
        null,
        'partial-recipe item stores ingredient_cost = null',
      );
      assertEqualOrThrow(
        uncostedItems[0].ingredient_cost_known,
        0,
        'partial-recipe item stores ingredient_cost_known = 0',
      );
      assertEqualOrThrow(
        uncostedItems[1].ingredient_cost,
        null,
        'non-recipe item stores ingredient_cost = null (ignores products.cost)',
      );
      assertEqualOrThrow(
        uncostedItems[1].ingredient_cost_known,
        0,
        'non-recipe item stores ingredient_cost_known = 0',
      );

      // Now receive Whole Milk with cost via HTTP route: 5 L at $7.50 total -> $0.0015 / ml
      const milkRecvRes = await api(baseUrl, `/api/supplies/${wholeMilk.id}/movements`, {
        method: 'POST',
        headers: authHeader,
        body: {
          movement_type: 'receive',
          quantity: 5,
          unit: 'l',
          total_cost: 7.5,
          reason: 'Dairy delivery',
        },
      });
      assertEqualOrThrow(milkRecvRes.status, 201, 'receive movement via HTTP route succeeds');
      assertEqualOrThrow(
        milkRecvRes.data.movement.unit_cost,
        0.0015,
        'route returns normalized unit_cost 0.0015/ml',
      );
      assertEqualOrThrow(milkRecvRes.data.movement.total_cost, 7.5, 'route returns total_cost 7.5');

      // Verify full recipe cost is now known: 18g * $0.02 ($0.36) + 200ml * $0.0015 ($0.30) = $0.66
      const fullRecipe = getRecipeByProduct(db, 'prod-latte');
      assertEqualOrThrow(fullRecipe.cost_known, true, 'recipe cost is now known');
      assertEqualOrThrow(fullRecipe.unit_cost, 0.66, 'recipe unit_cost is $0.66');

      // Add a Large variant with recipe_multiplier = 1.5 -> unit ingredient cost = $0.66 * 1.5 = $0.99
      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO product_variants (id, product_id, name, price, track_inventory, stock_quantity, recipe_multiplier, is_active, created_at, updated_at)
         VALUES ('var-latte-reg', 'prod-latte', 'Regular', 5.0, 0, 0, 1, 1, ?, ?),
                ('var-latte-lg', 'prod-latte', 'Large', 6.5, 0, 0, 1.5, 1, ?, ?)`,
      ).run(nowIso, nowIso, nowIso, nowIso);
      const largeVariant = { id: 'var-latte-lg', name: 'Large' };

      // Place Order 2 with 2 Large Lattes -> frozen ingredient_cost = 2 * $0.99 = $1.98
      const costedOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: authHeader,
        body: {
          type: 'dine_in',
          table_id: 'tbl-cost-1',
          items: [
            {
              product_id: 'prod-latte',
              variant_id: largeVariant.id,
              quantity: 4,
            },
          ],
        },
      });
      assertEqualOrThrow(costedOrderRes.status, 201, 'costed order with Large variant created');
      const costedOrderId = costedOrderRes.data.order.id;
      const initialLine = db
        .prepare('SELECT * FROM order_items WHERE order_id = ? LIMIT 1')
        .get(costedOrderId);
      assertEqualOrThrow(
        initialLine.ingredient_cost_known,
        1,
        'frozen line marks ingredient_cost_known = 1',
      );
      assertEqualOrThrow(
        initialLine.ingredient_cost,
        3.96,
        '4x Large Latte (1.5x portion) freezes ingredient_cost = 4 * 0.99 = 3.96',
      );

      // Now double the supply cost of Espresso Beans ($0.02/g -> $0.04/g) AND edit recipe
      updateSupply(db, espressoBeans.id, { unitCost: 40, unitCostUnit: 'kg' });
      saveRecipe(db, {
        productId: 'prod-latte',
        yieldQuantity: 1,
        items: [
          { supplyId: espressoBeans.id, quantity: 25, unit: 'g' },
          { supplyId: wholeMilk.id, quantity: 250, unit: 'ml' },
        ],
      });

      // Verify historical line on costedOrder is untouched
      const afterCatalogChangeLine = db
        .prepare('SELECT * FROM order_items WHERE id = ?')
        .get(initialLine.id);
      assertEqualOrThrow(
        afterCatalogChangeLine.ingredient_cost,
        3.96,
        'supply cost and recipe edits do not alter existing order_items.ingredient_cost',
      );

      // Reduce pending quantity on costedOrder from 4 -> 2: must scale frozen cost (3.96 -> 1.98), NOT re-read catalog!
      const pendingReduceRes = await api(
        baseUrl,
        `/api/orders/${costedOrderId}/items/${initialLine.id}/edit`,
        {
          method: 'PATCH',
          headers: { ...authHeader, 'Idempotency-Key': 'idem-reduce-pending-cost-1' },
          body: { quantity: 2, expected_edit_version: Number(initialLine.edit_version ?? 0) },
        },
      );
      assertEqualOrThrow(pendingReduceRes.status, 200, 'pending quantity reduction succeeds');
      const activeReducedLine = db
        .prepare("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'")
        .get(costedOrderId);
      assertEqualOrThrow(
        activeReducedLine.ingredient_cost,
        1.98,
        'pending quantity reduction (4 -> 2) scales historical frozen cost (3.96 -> 1.98)',
      );
      assertEqualOrThrow(
        activeReducedLine.ingredient_cost_known,
        1,
        'pending quantity reduction preserves ingredient_cost_known = 1',
      );

      // Move line to preparing, then reduce quantity 2 -> 1 (started quantity reduction)
      await api(baseUrl, `/api/order-items/${activeReducedLine.id}/status`, {
        method: 'PATCH',
        headers: authHeader,
        body: { status: 'preparing' },
      });
      const preparingLine = db
        .prepare('SELECT * FROM order_items WHERE id = ?')
        .get(activeReducedLine.id);
      const startedReduceRes = await api(
        baseUrl,
        `/api/orders/${costedOrderId}/items/${activeReducedLine.id}/edit`,
        {
          method: 'PATCH',
          headers: { ...authHeader, 'Idempotency-Key': 'idem-reduce-started-cost-1' },
          body: {
            quantity: 1,
            reason: 'Customer changed mind',
            override_pin: '1234',
            expected_edit_version: Number(preparingLine.edit_version ?? 0),
          },
        },
      );
      assertEqualOrThrow(startedReduceRes.status, 200, 'started quantity reduction succeeds');
      const afterStartedReduce = db
        .prepare('SELECT * FROM order_items WHERE id = ?')
        .get(activeReducedLine.id);
      assertEqualOrThrow(
        afterStartedReduce.ingredient_cost,
        0.99,
        'started quantity reduction (2 -> 1) scales historical frozen cost (1.98 -> 0.99)',
      );
      assertEqualOrThrow(
        afterStartedReduce.ingredient_cost_known,
        1,
        'started quantity reduction preserves ingredient_cost_known = 1',
      );

      // -----------------------------------------------------------------
      // 5. Sales profitability reports & Daily Sales Export
      // -----------------------------------------------------------------
      console.log('\n--- 5. Sales profitability reports & Daily Sales Export ---');
      const reportDateStr = '2026-10-15';
      const reportTs = '2026-10-15 12:00:00';
      const manager = seedManagerUser(db);

      // Seed 3 orders on 2026-10-15 with paid bills:
      // - Order A: 1x Latte (unknown cost, $5.00 exclusive) + 1x Bottled Water (unknown cost, $3.00 exclusive)
      // - Order B: 2x Latte (known cost $1.98, $13.00 exclusive)
      // - Order C: 1x Tax-Inclusive Croissant ($11.00 inclusive with $1.00 tax -> $10.00 ex-tax net revenue, known cost $2.50 -> profit $7.50, margin 75%)
      seedProduct(db, 'prod-croissant', 'cat-cost', 'Croissant', 11.0, {
        track_inventory: false,
      });

      function seedReportOrderAndBill(
        suffix: string,
        total: number,
        lines: Array<{
          productId: string;
          productName: string;
          qty: number;
          unitPrice: number;
          subtotal: number;
          taxAmount: number;
          taxType: 'exclusive' | 'inclusive';
          ingredientCost: number | null;
          ingredientCostKnown: 0 | 1;
        }>,
      ) {
        db.prepare(
          `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
           VALUES (?, ?, 'takeaway', 'completed', ?, ?, ?, ?, ?)`,
        ).run(`ORD-REP-${suffix}`, userId, total, total, reportTs, reportTs, reportTs);
        const orderId = Number(
          db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-REP-${suffix}`).id,
        );
        for (const line of lines) {
          db.prepare(
            `INSERT INTO order_items (
               order_id, product_id, product_name, quantity, unit_price, subtotal,
               tax_amount, tax_type, total, status, ingredient_cost, ingredient_cost_known, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
          ).run(
            orderId,
            line.productId,
            line.productName,
            line.qty,
            line.unitPrice,
            line.subtotal,
            line.taxAmount,
            line.taxType,
            line.taxType === 'inclusive' ? line.subtotal : line.subtotal + line.taxAmount,
            line.ingredientCost,
            line.ingredientCostKnown,
            reportTs,
            reportTs,
          );
        }
        db.prepare(
          `INSERT INTO bills (
             bill_number, order_id, subtotal, total, paid_amount, balance, payment_status,
             payment_details, paid_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)`,
        ).run(
          `BILL-REP-${suffix}`,
          orderId,
          total,
          total,
          total,
          JSON.stringify([{ method: 'cash', amount: total, timestamp: reportTs }]),
          reportTs,
          reportTs,
          reportTs,
        );
      }

      seedReportOrderAndBill('A', 8, [
        {
          productId: 'prod-latte',
          productName: 'Latte',
          qty: 1,
          unitPrice: 5,
          subtotal: 5,
          taxAmount: 0,
          taxType: 'exclusive',
          ingredientCost: null,
          ingredientCostKnown: 0,
        },
        {
          productId: 'prod-water',
          productName: 'Bottled Water',
          qty: 1,
          unitPrice: 3,
          subtotal: 3,
          taxAmount: 0,
          taxType: 'exclusive',
          ingredientCost: null,
          ingredientCostKnown: 0,
        },
      ]);
      seedReportOrderAndBill('B', 13, [
        {
          productId: 'prod-latte',
          productName: 'Latte',
          qty: 2,
          unitPrice: 6.5,
          subtotal: 13,
          taxAmount: 0,
          taxType: 'exclusive',
          ingredientCost: 1.98,
          ingredientCostKnown: 1,
        },
      ]);
      seedReportOrderAndBill('C', 11, [
        {
          productId: 'prod-croissant',
          productName: 'Croissant',
          qty: 1,
          unitPrice: 11,
          subtotal: 11,
          taxAmount: 1,
          taxType: 'inclusive',
          ingredientCost: 2.5,
          ingredientCostKnown: 1,
        },
      ]);

      const topOwnerRes = await api(
        baseUrl,
        `/api/reports/topProducts?start_date=${reportDateStr}&end_date=${reportDateStr}&limit=10`,
        { headers: authHeader },
      );
      assertEqualOrThrow(topOwnerRes.status, 200, 'owner topProducts returns 200');
      const rows = topOwnerRes.data.topProducts as any[];
      const latteRow = rows.find((r) => r.product_id === 'prod-latte');
      const waterRow = rows.find((r) => r.product_id === 'prod-water');
      const croissantRow = rows.find((r) => r.product_id === 'prod-croissant');

      // Water: 100% unknown cost -> never 100% margin
      assertEqualOrThrow(waterRow.cost_status, 'unknown', 'water cost_status is unknown');
      assertEqualOrThrow(waterRow.ingredient_cost, null, 'water ingredient_cost is null');
      assertEqualOrThrow(waterRow.profit, null, 'water profit is null');
      assertEqualOrThrow(waterRow.margin_percent, null, 'water margin_percent is null');

      // Latte: 1 unknown ($5) + 2 known ($13, cost $1.98) -> partial cost, profit over $13 known_cost_revenue
      assertEqualOrThrow(latteRow.cost_status, 'partial', 'latte cost_status is partial');
      assertEqualOrThrow(latteRow.known_cost_quantity, 2, 'latte known_cost_quantity is 2');
      assertEqualOrThrow(latteRow.unknown_cost_quantity, 1, 'latte unknown_cost_quantity is 1');
      assertEqualOrThrow(latteRow.net_revenue, 18, 'latte total ex-tax net_revenue is 18');
      assertEqualOrThrow(latteRow.known_cost_revenue, 13, 'latte known_cost_revenue is 13');
      assertEqualOrThrow(latteRow.ingredient_cost, 1.98, 'latte ingredient_cost is 1.98');
      assertEqualOrThrow(latteRow.profit, 11.02, 'latte profit is 13 - 1.98 = 11.02');
      assertEqualOrThrow(
        latteRow.margin_percent,
        84.77,
        'latte margin_percent is 11.02 / 13 = 84.77%',
      );

      // Croissant: inclusive tax ($11 subtotal - $1 inclusive tax = $10 ex-tax revenue), cost $2.50 -> profit $7.50, margin 75%
      assertEqualOrThrow(croissantRow.cost_status, 'known', 'croissant cost_status is known');
      assertEqualOrThrow(
        croissantRow.net_revenue,
        10,
        'croissant ex-tax net_revenue subtracts inclusive tax ($11 - $1 = $10)',
      );
      assertEqualOrThrow(croissantRow.ingredient_cost, 2.5, 'croissant ingredient_cost is 2.5');
      assertEqualOrThrow(croissantRow.profit, 7.5, 'croissant profit is 7.5');
      assertEqualOrThrow(croissantRow.margin_percent, 75, 'croissant margin_percent is 75%');

      // Period summary in topProducts and financial-summary:
      // Total net_revenue = 18 + 3 + 10 = 31; known_cost_revenue = 13 + 10 = 23; ingredient_cost = 1.98 + 2.50 = 4.48; profit = 18.52; margin = 80.52%
      const periodProf = topOwnerRes.data.profitability;
      assertEqualOrThrow(periodProf.cost_status, 'partial', 'period cost_status is partial');
      assertEqualOrThrow(periodProf.net_revenue, 31, 'period ex-tax net_revenue is 31');
      assertEqualOrThrow(periodProf.known_cost_revenue, 23, 'period known_cost_revenue is 23');
      assertEqualOrThrow(periodProf.ingredient_cost, 4.48, 'period ingredient_cost is 4.48');
      assertEqualOrThrow(periodProf.profit, 18.52, 'period profit is 18.52');
      assertEqualOrThrow(periodProf.margin_percent, 80.52, 'period margin_percent is 80.52%');

      const finSumRes = await api(
        baseUrl,
        `/api/reports/financial-summary?start_date=${reportDateStr}&end_date=${reportDateStr}`,
        { headers: authHeader },
      );
      assertEqualOrThrow(finSumRes.status, 200, 'financial-summary returns 200');
      assertEqualOrThrow(
        finSumRes.data.financialSummary.profitability.profit,
        18.52,
        'financial-summary includes matching period profitability',
      );

      // Cross-midnight creation vs settlement + split-bill bill_items allocation
      const { buildDailySalesExportDataset } = require('../main/services/daily-sales-export');
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', 'UTC')").run();
      try {
        const day1Str = '2026-10-18';
        const day2Str = '2026-10-19';
        const day1CreatedTs = '2026-10-18 23:45:00';
        const day2PaidTs = '2026-10-19 00:15:00';

        db.prepare(
          `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
           VALUES ('ORD-CROSS-MIDNIGHT', ?, 'dine_in', 'completed', 13, 13, ?, ?, ?)`,
        ).run(userId, day1CreatedTs, day2PaidTs, day2PaidTs);
        const crossOrderId = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-CROSS-MIDNIGHT'").get().id,
        );
        db.prepare(
          `INSERT INTO order_items (
             order_id, product_id, product_name, quantity, unit_price, subtotal,
             tax_amount, tax_type, total, status, ingredient_cost, ingredient_cost_known, created_at, updated_at
           ) VALUES (?, 'prod-latte', 'Latte', 2, 6.5, 13, 0, 'exclusive', 13, 'completed', 1.98, 1, ?, ?)`,
        ).run(crossOrderId, day1CreatedTs, day1CreatedTs);
        db.prepare(
          `INSERT INTO bills (
             bill_number, order_id, subtotal, total, paid_amount, balance, payment_status,
             payment_details, paid_at, created_at, updated_at
           ) VALUES ('BILL-CROSS-MIDNIGHT', ?, 13, 13, 13, 0, 'paid', ?, ?, ?, ?)`,
        ).run(
          crossOrderId,
          JSON.stringify([{ method: 'cash', amount: 13, timestamp: day2PaidTs }]),
          day2PaidTs,
          day1CreatedTs,
          day2PaidTs,
        );

        const day1FinRes = await api(
          baseUrl,
          `/api/reports/financial-summary?start_date=${day1Str}&end_date=${day1Str}`,
          { headers: authHeader },
        );
        assertEqualOrThrow(day1FinRes.status, 200, 'Day 1 financial-summary returns 200');
        const day1Prof = day1FinRes.data.financialSummary.profitability;
        assertEqualOrThrow(
          day1Prof.total_quantity,
          0,
          'Day 1 creation-only order has 0 settled profitability quantity',
        );
        assertEqualOrThrow(
          day1Prof.known_cost_revenue,
          0,
          'Day 1 creation-only order has 0 known_cost_revenue',
        );
        assertEqualOrThrow(
          day1Prof.ingredient_cost,
          null,
          'Day 1 creation-only order has null ingredient_cost',
        );
        assertEqualOrThrow(day1Prof.profit, null, 'Day 1 creation-only order has null profit');
        assertEqualOrThrow(
          day1Prof.cost_status,
          'unknown',
          'Day 1 creation-only order has cost_status=unknown',
        );

        const day2FinRes = await api(
          baseUrl,
          `/api/reports/financial-summary?start_date=${day2Str}&end_date=${day2Str}`,
          { headers: authHeader },
        );
        assertEqualOrThrow(day2FinRes.status, 200, 'Day 2 financial-summary returns 200');
        const day2Prof = day2FinRes.data.financialSummary.profitability;
        const day2Export = buildDailySalesExportDataset(day2Str, db).summary;
        assertEqualOrThrow(
          day2Prof.total_quantity,
          2,
          'Day 2 settlement day attributes cross-midnight quantity=2',
        );
        assertEqualOrThrow(
          day2Prof.known_cost_quantity,
          2,
          'Day 2 settlement day attributes known_cost_quantity=2',
        );
        assertEqualOrThrow(
          day2Prof.known_cost_revenue,
          day2Export.known_cost_net_item_sales,
          'Day 2 financial-summary known_cost_revenue matches daily-sales export (13)',
        );
        assertEqualOrThrow(
          day2Prof.ingredient_cost,
          day2Export.ingredient_cost_total,
          'Day 2 financial-summary ingredient_cost matches daily-sales export (1.98)',
        );
        assertEqualOrThrow(
          day2Prof.profit,
          day2Export.gross_profit_total,
          'Day 2 financial-summary profit matches daily-sales export (11.02)',
        );
        assertEqualOrThrow(
          day2Prof.cost_status,
          day2Export.cost_coverage_status,
          'Day 2 financial-summary cost_status matches daily-sales export (known)',
        );

        // Split bills paid in separate windows
        const splitDay1Str = '2026-10-20';
        const splitDay2Str = '2026-10-21';
        const splitCreatedTs = '2026-10-20 12:00:00';
        const splitPaid1Ts = '2026-10-20 12:30:00';
        const splitPaid2Ts = '2026-10-21 10:00:00';

        db.prepare(
          `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
           VALUES ('ORD-SPLIT-PROF', ?, 'dine_in', 'completed', 19.5, 19.5, ?, ?, ?)`,
        ).run(userId, splitCreatedTs, splitPaid2Ts, splitPaid2Ts);
        const splitOrderId = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-SPLIT-PROF'").get().id,
        );
        const splitItemRes = db
          .prepare(
            `INSERT INTO order_items (
               order_id, product_id, product_name, quantity, unit_price, subtotal,
               tax_amount, tax_type, total, status, ingredient_cost, ingredient_cost_known, created_at, updated_at
             ) VALUES (?, 'prod-latte', 'Latte', 3, 6.5, 19.5, 0, 'exclusive', 19.5, 'completed', 2.97, 1, ?, ?)`,
          )
          .run(splitOrderId, splitCreatedTs, splitCreatedTs);
        const splitOrderItemId = Number(splitItemRes.lastInsertRowid);

        const splitBill1Res = db
          .prepare(
            `INSERT INTO bills (
               bill_number, order_id, subtotal, total, paid_amount, balance, payment_status,
               payment_details, paid_at, split_group_id, created_at, updated_at
             ) VALUES ('BILL-SPLIT-PROF-1', ?, 6.5, 6.5, 6.5, 0, 'paid', ?, ?, 'split-prof-grp', ?, ?)`,
          )
          .run(
            splitOrderId,
            JSON.stringify([{ method: 'cash', amount: 6.5, timestamp: splitPaid1Ts }]),
            splitPaid1Ts,
            splitCreatedTs,
            splitPaid1Ts,
          );
        const splitBill1Id = Number(splitBill1Res.lastInsertRowid);
        db.prepare(
          'INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)',
        ).run(splitBill1Id, splitOrderItemId);

        const splitBill2Res = db
          .prepare(
            `INSERT INTO bills (
               bill_number, order_id, subtotal, total, paid_amount, balance, payment_status,
               payment_details, paid_at, split_group_id, created_at, updated_at
             ) VALUES ('BILL-SPLIT-PROF-2', ?, 13, 13, 13, 0, 'paid', ?, ?, 'split-prof-grp', ?, ?)`,
          )
          .run(
            splitOrderId,
            JSON.stringify([{ method: 'card', amount: 13, timestamp: splitPaid2Ts }]),
            splitPaid2Ts,
            splitCreatedTs,
            splitPaid2Ts,
          );
        const splitBill2Id = Number(splitBill2Res.lastInsertRowid);
        db.prepare(
          'INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 2)',
        ).run(splitBill2Id, splitOrderItemId);

        const splitWin1Res = await api(
          baseUrl,
          `/api/reports/financial-summary?start_date=${splitDay1Str}&end_date=${splitDay1Str}`,
          { headers: authHeader },
        );
        assertEqualOrThrow(
          splitWin1Res.status,
          200,
          'split window 1 financial-summary returns 200',
        );
        const splitWin1Prof = splitWin1Res.data.financialSummary.profitability;
        assertEqualOrThrow(
          splitWin1Prof.total_quantity,
          1,
          'split window 1 attributes bill_items quantity=1',
        );
        assertEqualOrThrow(
          splitWin1Prof.known_cost_quantity,
          1,
          'split window 1 attributes known_cost_quantity=1',
        );
        assertEqualOrThrow(
          splitWin1Prof.known_cost_revenue,
          6.5,
          'split window 1 attributes 1/3 subtotal share (6.5)',
        );
        assertEqualOrThrow(
          splitWin1Prof.ingredient_cost,
          0.99,
          'split window 1 attributes 1/3 ingredient_cost share (0.99)',
        );
        assertEqualOrThrow(splitWin1Prof.profit, 5.51, 'split window 1 attributes profit=5.51');

        const splitWin2Res = await api(
          baseUrl,
          `/api/reports/financial-summary?start_date=${splitDay2Str}&end_date=${splitDay2Str}`,
          { headers: authHeader },
        );
        assertEqualOrThrow(
          splitWin2Res.status,
          200,
          'split window 2 financial-summary returns 200',
        );
        const splitWin2Prof = splitWin2Res.data.financialSummary.profitability;
        assertEqualOrThrow(
          splitWin2Prof.total_quantity,
          2,
          'split window 2 attributes bill_items quantity=2',
        );
        assertEqualOrThrow(
          splitWin2Prof.known_cost_quantity,
          2,
          'split window 2 attributes known_cost_quantity=2',
        );
        assertEqualOrThrow(
          splitWin2Prof.known_cost_revenue,
          13,
          'split window 2 attributes 2/3 subtotal share (13)',
        );
        assertEqualOrThrow(
          splitWin2Prof.ingredient_cost,
          1.98,
          'split window 2 attributes 2/3 ingredient_cost share (1.98)',
        );
        assertEqualOrThrow(splitWin2Prof.profit, 11.02, 'split window 2 attributes profit=11.02');
      } finally {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', 'Asia/Kolkata')",
        ).run();
      }

      // Manager without reports.financial.view can view topProducts quantities/revenue, but NOT cost/profit/margin
      const topManagerRes = await api(
        baseUrl,
        `/api/reports/topProducts?start_date=${reportDateStr}&end_date=${reportDateStr}&limit=10`,
        { headers: manager.authHeader },
      );
      assertEqualOrThrow(topManagerRes.status, 200, 'manager topProducts returns 200');
      assertEqualOrThrow(
        topManagerRes.data.profitability,
        undefined,
        'manager topProducts omits period profitability without reports.financial.view',
      );
      assertEqualOrThrow(
        topManagerRes.data.topProducts[0].ingredient_cost,
        undefined,
        'manager topProducts omits item ingredient_cost without reports.financial.view',
      );
      assertEqualOrThrow(
        topManagerRes.data.topProducts[0].profit,
        undefined,
        'manager topProducts omits item profit without reports.financial.view',
      );

      // Daily Sales Export CSV (summary + items) includes profitability columns and metrics
      const exportSummaryRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${reportDateStr}&format=csv&part=summary`,
        { headers: authHeader },
      );
      assertEqualOrThrow(exportSummaryRes.status, 200, 'daily-sales summary CSV returns 200');
      const exportSummaryCsv = await exportSummaryRes.text();
      assertOrThrow(
        exportSummaryCsv.includes('known_cost_net_item_sales,23'),
        'summary CSV includes known_cost_net_item_sales=23',
      );
      assertOrThrow(
        exportSummaryCsv.includes('ingredient_cost_total,4.48'),
        'summary CSV includes ingredient_cost_total=4.48',
      );
      assertOrThrow(
        exportSummaryCsv.includes('gross_profit_total,18.52'),
        'summary CSV includes gross_profit_total=18.52',
      );
      assertOrThrow(
        exportSummaryCsv.includes('gross_margin_percent,80.52'),
        'summary CSV includes gross_margin_percent=80.52',
      );
      assertOrThrow(
        exportSummaryCsv.includes('cost_coverage_status,partial'),
        'summary CSV includes cost_coverage_status=partial',
      );

      const exportItemsRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${reportDateStr}&format=csv&part=items`,
        { headers: authHeader },
      );
      assertEqualOrThrow(exportItemsRes.status, 200, 'daily-sales items CSV returns 200');
      const exportItemsCsv = await exportItemsRes.text();
      assertOrThrow(
        exportItemsCsv.includes(
          'product_id,product_name,product_sku,quantity,gross_item_sales,item_discounts,net_item_sales,tax_amount,ingredient_cost,profit,margin_percent,cost_status',
        ),
        'items CSV header includes ingredient_cost,profit,margin_percent,cost_status',
      );
      assertOrThrow(
        exportItemsCsv.includes('prod-water,Bottled Water,,1,3,0,3,0,,,,unknown'),
        'unknown-cost item exports empty cells for cost/profit/margin and cost_status=unknown',
      );
      assertOrThrow(
        exportItemsCsv.includes('prod-latte,Latte,,3,18,0,18,0,1.98,11.02,84.77,partial'),
        'partial-cost item exports known cost/profit/margin and cost_status=partial',
      );
      assertOrThrow(
        exportItemsCsv.includes('prod-croissant,Croissant,,1,11,0,11,1,2.5,7.5,75,known'),
        'known-cost tax-inclusive item exports ex-tax profit/margin and cost_status=known',
      );

      // Daily Sales Export XLSX includes profitability metrics on Summary and columns on Items
      const ExcelJS = require('exceljs');
      const exportXlsxRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${reportDateStr}&format=xlsx`,
        { headers: authHeader },
      );
      assertEqualOrThrow(exportXlsxRes.status, 200, 'daily-sales XLSX returns 200');
      const xlsxBuf = Buffer.from(await exportXlsxRes.arrayBuffer());
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(xlsxBuf);
      const summarySheet = workbook.getWorksheet('Summary');
      const itemsSheet = workbook.getWorksheet('Items');
      assertOrThrow(Boolean(summarySheet && itemsSheet), 'XLSX contains Summary and Items sheets');
      const summaryRows: Record<string, any> = {};
      summarySheet.eachRow((row: any, rowNumber: number) => {
        if (rowNumber > 1) {
          summaryRows[String(row.getCell(1).value)] = row.getCell(2).value;
        }
      });
      assertEqualOrThrow(
        summaryRows.known_cost_net_item_sales,
        23,
        'XLSX Summary known_cost_net_item_sales=23',
      );
      assertEqualOrThrow(
        summaryRows.ingredient_cost_total,
        4.48,
        'XLSX Summary ingredient_cost_total=4.48',
      );
      assertEqualOrThrow(
        summaryRows.gross_profit_total,
        18.52,
        'XLSX Summary gross_profit_total=18.52',
      );
      assertEqualOrThrow(
        summaryRows.gross_margin_percent,
        80.52,
        'XLSX Summary gross_margin_percent=80.52',
      );
      assertEqualOrThrow(
        summaryRows.cost_coverage_status,
        'partial',
        'XLSX Summary cost_coverage_status=partial',
      );
      const itemHeaderValues = itemsSheet.getRow(1).values as any[];
      assertOrThrow(
        itemHeaderValues.includes('ingredient_cost') &&
          itemHeaderValues.includes('profit') &&
          itemHeaderValues.includes('margin_percent') &&
          itemHeaderValues.includes('cost_status'),
        'XLSX Items sheet header includes ingredient_cost, profit, margin_percent, cost_status',
      );

      // -----------------------------------------------------------------
      // 6. Supply routes snake_case contract, database import validation, and item refund reversal
      // -----------------------------------------------------------------
      console.log(
        '\n--- 6. Snake_case contract, DB import validation, and item refund reversal ---',
      );
      const camelCreateRes = await api(baseUrl, '/api/supplies', {
        method: 'POST',
        headers: authHeader,
        body: {
          name: 'CamelCase Ignored Supply',
          base_unit: 'each',
          stock_quantity: 10,
          unitCost: 5.5,
          unitCostUnit: 'each',
        },
      });
      assertEqualOrThrow(camelCreateRes.status, 201, 'supply created when camelCase fields sent');
      assertEqualOrThrow(
        camelCreateRes.data.supply.unit_cost,
        null,
        'POST /api/supplies ignores camelCase unitCost without snake_case unit_cost',
      );

      const badImportRes = await api(baseUrl, '/api/db/import', {
        method: 'POST',
        headers: authHeader,
        body: {
          data: {
            schema_version: String(getCurrentSchemaVersion()),
            data: {
              settings: [],
              categories: [],
              products: [],
              users: [],
              supplies: [
                {
                  id: 'sup-bad-import',
                  name: 'Bad Cost Supply',
                  base_unit: 'g',
                  stock_quantity: 100,
                  unit_cost: -2.5,
                },
              ],
            },
          },
        },
      });
      assertEqualOrThrow(
        badImportRes.status,
        400,
        'POST /api/db/import rejects negative supplies[0].unit_cost with 400',
      );
      assertOrThrow(
        String(badImportRes.data?.error || '').includes(
          'supplies[0].unit_cost must be a non-negative finite number or null',
        ),
        'POST /api/db/import returns specific supplies[0].unit_cost error message',
      );

      // Item-level refund inserts void_adjustment with negated ingredient_cost
      const { createRefund } = require('../main/services/refund');
      const bcrypt = require('bcryptjs');
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
        bcrypt.hashSync('4321', 10),
        userId,
      );
      const nowOrderTs = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(
        `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
         VALUES ('ORD-REF-COST', ?, 'takeaway', 'completed', 11, 11, ?, ?, ?)`,
      ).run(userId, nowOrderTs, nowOrderTs, nowOrderTs);
      const refOrderId = Number(
        db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-REF-COST'").get().id,
      );
      const refItemInsert = db
        .prepare(
          `INSERT INTO order_items (
             order_id, product_id, product_name, quantity, unit_price, subtotal,
             tax_amount, tax_type, total, status, ingredient_cost, ingredient_cost_known, created_at, updated_at
           ) VALUES (?, 'prod-croissant', 'Croissant', 1, 11, 11, 1, 'inclusive', 11, 'completed', 2.5, 1, ?, ?)`,
        )
        .run(refOrderId, nowOrderTs, nowOrderTs);
      const refItemId = Number(refItemInsert.lastInsertRowid);
      const refBillInsert = db
        .prepare(
          `INSERT INTO bills (
             bill_number, order_id, subtotal, total, paid_amount, balance, payment_status,
             payment_details, paid_at, created_at, updated_at
           ) VALUES ('BILL-REF-COST', ?, 11, 11, 11, 0, 'paid', ?, ?, ?, ?)`,
        )
        .run(
          refOrderId,
          JSON.stringify([{ method: 'cash', amount: 11, timestamp: nowOrderTs }]),
          nowOrderTs,
          nowOrderTs,
          nowOrderTs,
        );
      const refBillId = Number(refBillInsert.lastInsertRowid);

      createRefund(db, {
        billId: refBillId,
        orderItemId: refItemId,
        method: 'cash',
        reason: 'Damaged pastry',
        approverId: userId,
        overridePin: '4321',
        createdByUserId: userId,
        clientIp: '127.0.0.1',
        isPinRateLimited: () => false,
        checkPinRateLimit: () => true,
        clearPinRateLimit: () => {},
      });

      const voidAdjRow = db
        .prepare(
          "SELECT ingredient_cost, ingredient_cost_known FROM order_items WHERE order_id = ? AND status = 'void_adjustment'",
        )
        .get(refOrderId);
      assertEqualOrThrow(
        voidAdjRow.ingredient_cost,
        -2.5,
        'item refund void_adjustment negates ingredient_cost (-2.5)',
      );
      assertEqualOrThrow(
        voidAdjRow.ingredient_cost_known,
        1,
        'item refund void_adjustment preserves ingredient_cost_known = 1',
      );
    } finally {
      server.close();
    }
  } finally {
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...PRISTINE_MIGRATIONS);
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('='.repeat(65));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
