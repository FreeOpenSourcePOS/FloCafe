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

    // Restore USD (2 decimals)
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
