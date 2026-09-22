/**
 * Supplies service: CRUD, movements, low stock, soft delete.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supplies-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supplies-service-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedCategory, seedProduct,
} = require('./helpers/test-setup');
const {
  applySupplyStockChange, createSupply, getSupply, listSupplies, listSupplyMovements, recordSupplyMovement,
  softDeleteSupply, updateSupply, SupplyServiceError,
} = require('../main/services/supplies');
const { saveRecipe } = require('../main/services/recipes');
const { convertQuantity } = require('../main/services/units');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Supplies service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  // ── Create ──
  const coffee = createSupply(db, {
    name: 'Coffee beans', baseUnit: 'kg', stockQuantity: 5, lowStockThreshold: 2, actorUserId: actor,
  });
  assertEqual(coffee.name, 'Coffee beans', 'create stores name');
  assertEqual(coffee.base_unit, 'kg', 'create stores base unit');
  assertEqual(coffee.stock_quantity, 5, 'create stores initial stock');
  assertEqual(coffee.low_stock_threshold, 2, 'create stores threshold');
  assertEqual(coffee.is_active, 1, 'create defaults to active');
  assert(coffee.id.startsWith('sup_'), 'create generates supply id');
  assertEqual(
    db.prepare('SELECT movement_type FROM supply_movements WHERE supply_id = ?').get(coffee.id).movement_type,
    'adjustment',
    'create records opening stock in the supply ledger',
  );

  seedCategory(db, 'cat-supplies', 'Supply Recipes');
  seedProduct(db, 'prod-supply-recipe', 'cat-supplies', 'Recipe product', 100);
  saveRecipe(db, {
    productId: 'prod-supply-recipe',
    items: [{ supplyId: coffee.id, quantity: 1, unit: 'kg' }],
  });
  expectServiceError(() => softDeleteSupply(db, coffee.id), 409, 'cannot delete a recipe-linked supply');

  expectServiceError(() => createSupply(db, { name: '   ', baseUnit: 'g' }), 400, 'create rejects blank name');
  expectServiceError(() => createSupply(db, { name: 'Bad', baseUnit: 'lb' as any }), 400, 'create rejects unknown base unit');
  expectServiceError(() => createSupply(db, { name: 'Neg', baseUnit: 'g', lowStockThreshold: -1 }), 400, 'create rejects negative threshold');

  // ── List filters ──
  const milk = createSupply(db, { name: 'Milk', baseUnit: 'ml', stockQuantity: 100, lowStockThreshold: 50, actorUserId: actor });
  const cups = createSupply(db, { name: 'Cups', baseUnit: 'each', stockQuantity: 10, actorUserId: actor });
  updateSupply(db, cups.id, { isActive: false });

  const active = listSupplies(db, {});
  assertEqual(active.length, 2, 'list excludes inactive by default');
  assert(active.some((s: any) => s.id === coffee.id), 'list includes coffee');
  const withInactive = listSupplies(db, { includeInactive: true });
  assertEqual(withInactive.length, 3, 'list includes inactive when requested');
  const searched = listSupplies(db, { search: 'cof' });
  assertEqual(searched.length, 1, 'search filters by name');
  const names = listSupplies(db, {}).map((s: any) => s.name);
  assertEqual(names[0], 'Coffee beans', 'list sorted by name nocase (Coffee before Milk)');

  // ── Low stock ──
  assertEqual(milk.is_low_stock, undefined, 'raw create row has no computed flag yet');
  const listedMilk = listSupplies(db, {}).find((s: any) => s.id === milk.id);
  assertEqual(listedMilk.is_low_stock, 0, 'milk above threshold is not low stock');
  recordSupplyMovement(db, {
    supplyId: milk.id, movementType: 'count', quantity: 40, unit: 'ml', actorUserId: actor,
  });
  const lowList = listSupplies(db, { lowStockOnly: true });
  assertEqual(lowList.length, 1, 'low stock filter returns only milk');
  assertEqual(lowList[0].id, milk.id, 'low stock filter returns the milk supply');
  assertEqual(lowList[0].is_low_stock, 1, 'milk flagged low stock');

  // ── Movements ──
  const recv = recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'receive', quantity: 2, unit: 'kg', actorUserId: actor, reason: 'Delivery',
  });
  assert(recv, 'receive returns movement row');
  assertEqual(getSupply(db, coffee.id).stock_quantity, 7, 'receive adds 2 kg (5 → 7)');

  const recipeMovement = applySupplyStockChange(db, {
    supplyId: cups.id,
    quantityDelta: -1,
    movementType: 'recipe_depletion',
    unit: 'each',
    actorUserId: actor,
    createdAt: '2026-01-01 00:00:00',
  });
  assertEqual(
    db.prepare('SELECT id FROM supply_movements WHERE id = ?').get(recipeMovement.movementId).id,
    recipeMovement.movementId,
    'stock change returns inserted movement id',
  );

  // unit conversion on receive: 500 g into kg-based supply
  recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'receive', quantity: 500, unit: 'g', actorUserId: actor,
  });
  assertEqual(getSupply(db, coffee.id).stock_quantity, 7.5, 'receive converts g → kg (7 → 7.5)');

  // count sets absolute stock in base unit
  recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'count', quantity: 4, unit: 'kg', actorUserId: actor,
  });
  assertEqual(getSupply(db, coffee.id).stock_quantity, 4, 'count sets absolute stock (7.5 → 4)');

  // adjustment signed
  recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'adjustment', quantity: -1.5, unit: 'kg', actorUserId: actor, reason: 'Spilled',
  });
  assertEqual(getSupply(db, coffee.id).stock_quantity, 2.5, 'adjustment applies signed delta');

  // waste positive input subtracts
  recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'waste', quantity: 0.5, unit: 'kg', actorUserId: actor, reason: 'Expired',
  });
  assertEqual(getSupply(db, coffee.id).stock_quantity, 2, 'waste subtracts quantity');

  // negative stock allowed
  recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'waste', quantity: 10, unit: 'kg', actorUserId: actor, reason: 'Over-waste',
  });
  assertEqual(getSupply(db, coffee.id).stock_quantity, -8, 'stock may go negative');

  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'receive', quantity: -1, unit: 'kg', actorUserId: actor,
  }), 400, 'receive rejects negative quantity');
  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'adjustment', quantity: 0, unit: 'kg', actorUserId: actor, reason: 'noop',
  }), 400, 'adjustment rejects zero');
  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'adjustment', quantity: 1, unit: 'kg', actorUserId: actor,
  }), 400, 'adjustment requires reason');
  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'waste', quantity: 1, unit: 'kg', actorUserId: actor,
  }), 400, 'waste requires reason');
  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'receive', quantity: 1, unit: 'lb' as any, actorUserId: actor,
  }), 400, 'rejects unknown movement unit');
  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: coffee.id, movementType: 'count', quantity: 1, unit: 'ml', actorUserId: actor,
  }), 400, 'count rejects cross-dimension unit (ml on kg supply)');
  expectServiceError(() => recordSupplyMovement(db, {
    supplyId: 'missing', movementType: 'receive', quantity: 1, actorUserId: actor,
  }), 404, 'movement on missing supply is 404');

  // movement history
  const page = listSupplyMovements(db, { supplyId: coffee.id, perPage: 3 });
  assertEqual(page.movements.length, 3, 'cursor page respects perPage');
  assert(page.nextCursor !== null, 'nextCursor present when more rows exist');
  const older = listSupplyMovements(db, { supplyId: coffee.id, beforeId: page.nextCursor, perPage: 100 });
  assert(older.movements.every((m: any) => m.id < page.nextCursor), 'cursor returns older movements only');
  const filtered = listSupplyMovements(db, { supplyId: coffee.id, movementType: 'receive' });
  assert(filtered.movements.every((m: any) => m.movement_type === 'receive'), 'type filter works');
  assertEqual(filtered.movements.length, 2, 'two receive movements recorded');

  // ── Soft delete ──
  softDeleteSupply(db, cups.id);
  expectServiceError(() => getSupply(db, cups.id), 404, 'soft-deleted supply is not found');
  assertEqual(listSupplies(db, { includeInactive: true }).length, 2, 'soft-deleted supply excluded from list');
  expectServiceError(() => softDeleteSupply(db, cups.id), 404, 'soft delete is not repeatable on missing supply');

  // update keeps base_unit immutable (not in update input)
  const updated = updateSupply(db, coffee.id, { name: 'Espresso beans', lowStockThreshold: null });
  assertEqual(updated.name, 'Espresso beans', 'update renames supply');
  assertEqual(updated.base_unit, 'kg', 'update leaves base unit unchanged');
  assertEqual(updated.low_stock_threshold, null, 'update can clear threshold');

  // conversion helper still available
  assertEqual(convertQuantity(1, 'kg', 'g'), 1000, 'units helper re-export path works');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
