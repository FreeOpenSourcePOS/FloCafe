import { randomBytes } from 'crypto';
import Decimal from 'decimal.js';
import { getDatabase, now, withTxn } from '../db';
import {
  SupplyUnit,
  UnitConversionError,
  assertSupplyUnit,
  convertQuantity,
  roundQuantity,
} from './units';
import {
  applySupplyStockChange,
  resolveDbCurrencyFractionDigits,
  roundCurrencyCost,
  roundUnitCost,
} from './supplies';

export type RecipeValidationCode =
  | 'product_missing'
  | 'items_missing'
  | 'supply_id_missing'
  | 'duplicate_supply'
  | 'supply_missing'
  | 'quantity_invalid'
  | 'unit_invalid'
  | 'yield_invalid';

export class RecipeServiceError extends Error {
  readonly statusCode: number;
  readonly diagnosticCode?: RecipeValidationCode;

  constructor(statusCode: number, message: string, diagnosticCode?: RecipeValidationCode) {
    super(message);
    this.name = 'RecipeServiceError';
    this.statusCode = statusCode;
    this.diagnosticCode = diagnosticCode;
  }
}

export interface RecipeComponent {
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit: SupplyUnit;
  quantity_in_base: number;
  supply_unit_cost: number | null;
  component_cost: number | null;
}

export interface RecipeSnapshotComponent {
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit_cost?: number | null;
  line_cost?: number | null;
}

export interface RecipeSnapshot {
  recipe_id: string;
  product_id: string;
  yield_quantity: number;
  cost_known?: boolean;
  total_ingredient_cost?: number | null;
  /** Scaled amounts for this order item quantity, already in each supply's base unit. */
  components: RecipeSnapshotComponent[];
}

export interface RecipeRecord {
  id: string;
  product_id: string;
  product_name: string | null;
  yield_quantity: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  cost_known: boolean;
  total_cost: number | null;
  unit_cost: number | null;
  items: RecipeComponent[];
}

export interface SaveRecipeInput {
  productId: string;
  yieldQuantity?: number;
  isActive?: boolean;
  items: { supplyId?: string; supply_id?: string; quantity: number; unit: string }[];
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function assertPositiveFinite(
  value: unknown,
  field: string,
  diagnosticCode: 'quantity_invalid' | 'yield_invalid',
): number {
  const quantity = typeof value === 'string' ? Number(value) : value;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    throw new RecipeServiceError(400, `${field} must be a finite number`, diagnosticCode);
  }
  if (quantity <= 0) {
    throw new RecipeServiceError(400, `${field} must be greater than zero`, diagnosticCode);
  }
  return quantity;
}

function loadRecipeItems(db: ReturnType<typeof getDatabase>, recipeId: string): RecipeComponent[] {
  const rows = db
    .prepare(`
    SELECT
      ri.supply_id,
      s.name AS supply_name,
      s.base_unit,
      s.unit_cost AS supply_unit_cost,
      ri.quantity,
      ri.unit
    FROM recipe_items ri
    JOIN supplies s ON s.id = ri.supply_id
    WHERE ri.recipe_id = ?
    ORDER BY ri.created_at, ri.id
  `)
    .all(recipeId) as {
    supply_id: string;
    supply_name: string;
    base_unit: SupplyUnit;
    supply_unit_cost: number | null;
    quantity: number;
    unit: SupplyUnit;
  }[];
  return rows.map((row) => {
    const quantityInBase = convertQuantity(row.quantity, row.unit, row.base_unit);
    const supplyUnitCost =
      row.supply_unit_cost === null || row.supply_unit_cost === undefined
        ? null
        : Number(row.supply_unit_cost);
    const componentCost =
      supplyUnitCost !== null && Number.isFinite(supplyUnitCost)
        ? roundUnitCost(new Decimal(quantityInBase).mul(supplyUnitCost))
        : null;
    return {
      supply_id: row.supply_id,
      supply_name: row.supply_name,
      base_unit: row.base_unit,
      quantity: row.quantity,
      unit: row.unit,
      quantity_in_base: quantityInBase,
      supply_unit_cost: supplyUnitCost,
      component_cost: componentCost,
    };
  });
}

function hydrateRecipeRecord(
  db: ReturnType<typeof getDatabase>,
  row: Omit<RecipeRecord, 'items' | 'cost_known' | 'total_cost' | 'unit_cost'> & {
    product_name: string | null;
  },
): RecipeRecord {
  const items = loadRecipeItems(db, row.id);
  const fractionDigits = resolveDbCurrencyFractionDigits(db);
  const costKnown =
    items.length > 0 &&
    items.every(
      (item) => typeof item.supply_unit_cost === 'number' && Number.isFinite(item.supply_unit_cost),
    );
  const totalCostDecimal = costKnown
    ? items.reduce(
        (sum, item) => sum.plus(new Decimal(item.quantity_in_base).mul(item.supply_unit_cost!)),
        new Decimal(0),
      )
    : null;
  const totalCost = totalCostDecimal !== null ? roundUnitCost(totalCostDecimal) : null;
  const unitCost =
    totalCostDecimal !== null
      ? roundCurrencyCost(totalCostDecimal.div(row.yield_quantity), fractionDigits)
      : null;
  return {
    ...row,
    cost_known: costKnown,
    total_cost: totalCost,
    unit_cost: unitCost,
    items,
  };
}

export function getRecipeByProduct(
  db: ReturnType<typeof getDatabase>,
  productId: string,
): RecipeRecord | null {
  const row = db
    .prepare(`
    SELECT r.*, p.name AS product_name
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.product_id = ?
  `)
    .get(productId) as
    | (Omit<RecipeRecord, 'items' | 'cost_known' | 'total_cost' | 'unit_cost'> & {
        product_name: string | null;
      })
    | undefined;
  if (!row) return null;
  return hydrateRecipeRecord(db, row);
}

export function getRecipe(db: ReturnType<typeof getDatabase>, id: string): RecipeRecord | null {
  const row = db
    .prepare(`
    SELECT r.*, p.name AS product_name
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.id = ?
  `)
    .get(id) as
    | (Omit<RecipeRecord, 'items' | 'cost_known' | 'total_cost' | 'unit_cost'> & {
        product_name: string | null;
      })
    | undefined;
  if (!row) return null;
  return hydrateRecipeRecord(db, row);
}

export function listRecipes(db: ReturnType<typeof getDatabase>): RecipeRecord[] {
  const rows = db
    .prepare(`
    SELECT r.*, p.name AS product_name
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY p.name COLLATE NOCASE
  `)
    .all() as (Omit<RecipeRecord, 'items' | 'cost_known' | 'total_cost' | 'unit_cost'> & {
    product_name: string | null;
  })[];
  return rows.map((row) => hydrateRecipeRecord(db, row));
}

export function saveRecipe(
  db: ReturnType<typeof getDatabase>,
  input: SaveRecipeInput,
): RecipeRecord {
  const productId = String(input.productId || '').trim();
  if (!productId) throw new RecipeServiceError(400, 'product_id is required', 'product_missing');
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) throw new RecipeServiceError(404, 'Product not found', 'product_missing');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new RecipeServiceError(400, 'items must contain at least one supply', 'items_missing');
  }

  const seenSupplies = new Set<string>();
  const normalizedItems: { supplyId: string; quantity: number; unit: SupplyUnit }[] = [];
  for (const item of input.items) {
    const supplyId = String(item?.supply_id || item?.supplyId || '').trim();
    if (!supplyId)
      throw new RecipeServiceError(400, 'each item requires a supply_id', 'supply_id_missing');
    if (seenSupplies.has(supplyId)) {
      throw new RecipeServiceError(400, 'duplicate supply_id in recipe', 'duplicate_supply');
    }
    seenSupplies.add(supplyId);
    const supply = db
      .prepare('SELECT id, base_unit FROM supplies WHERE id = ? AND deleted_at IS NULL')
      .get(supplyId) as { id: string; base_unit: SupplyUnit } | undefined;
    if (!supply)
      throw new RecipeServiceError(404, `Supply ${supplyId} not found`, 'supply_missing');
    const quantity = assertPositiveFinite(item.quantity, 'item.quantity', 'quantity_invalid');
    let unit: SupplyUnit;
    try {
      unit = assertSupplyUnit(item.unit, 'item.unit');
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new RecipeServiceError(error.statusCode, error.message, error.diagnosticCode);
      }
      throw error;
    }
    // Validate convertibility at save time so depletion cannot fail later.
    try {
      convertQuantity(quantity, unit, supply.base_unit);
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new RecipeServiceError(error.statusCode, error.message, error.diagnosticCode);
      }
      throw error;
    }
    normalizedItems.push({ supplyId, quantity, unit });
  }

  const yieldQuantity =
    input.yieldQuantity === undefined
      ? 1
      : assertPositiveFinite(input.yieldQuantity, 'yield_quantity', 'yield_invalid');
  const isActive = input.isActive === false ? 0 : 1;
  const timestamp = now();

  const recipeId = withTxn(() => {
    const existing = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId) as
      | { id: string }
      | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare(
        'UPDATE recipes SET yield_quantity = ?, is_active = ?, updated_at = ? WHERE id = ?',
      ).run(yieldQuantity, isActive, timestamp, id);
      db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(id);
    } else {
      id = newId('rcp');
      db.prepare(`
        INSERT INTO recipes (id, product_id, yield_quantity, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, productId, yieldQuantity, isActive, timestamp, timestamp);
    }

    const insertItem = db.prepare(`
      INSERT INTO recipe_items (id, recipe_id, supply_id, quantity, unit, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of normalizedItems) {
      insertItem.run(newId('rci'), id, item.supplyId, item.quantity, item.unit, timestamp);
    }
    return id;
  });

  const recipe = getRecipe(db, recipeId);
  if (!recipe) throw new RecipeServiceError(500, 'Failed to save recipe');
  return recipe;
}

export function deleteRecipe(db: ReturnType<typeof getDatabase>, productId: string): void {
  const existing = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId) as
    | { id: string }
    | undefined;
  if (!existing) throw new RecipeServiceError(404, 'Recipe not found');
  withTxn(() => {
    db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(existing.id);
    db.prepare('DELETE FROM recipes WHERE id = ?').run(existing.id);
  });
}

/**
 * Build an immutable per-order-item snapshot of the recipe scaled to the
 * ordered quantity and to the ordered variant's portion. `recipeMultiplier`
 * is how many base recipe portions the variant consumes and comes from the
 * resolved catalog variant, never from the client. Returns null when the
 * product has no active recipe, in which case a portion has no effect.
 */
export function buildRecipeSnapshot(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  orderQuantity: number,
  recipeMultiplier = 1,
): RecipeSnapshot | null {
  const recipe = getRecipeByProduct(db, productId);
  if (!recipe || recipe.is_active !== 1 || recipe.items.length === 0) return null;
  if (!Number.isFinite(orderQuantity) || orderQuantity <= 0) return null;
  // A zero, negative, or non-finite portion would silently under-deplete and
  // record a snapshot that cancel and restore would faithfully reproduce.
  // roundQuantity refuses an overflowed product below.
  if (!Number.isFinite(recipeMultiplier) || recipeMultiplier <= 0) {
    throw new RecipeServiceError(400, 'recipe multiplier must be a positive finite number');
  }

  const fractionDigits = resolveDbCurrencyFractionDigits(db);
  const scale = (orderQuantity * recipeMultiplier) / recipe.yield_quantity;
  const components: RecipeSnapshotComponent[] = recipe.items.map((item) => {
    const quantity = roundQuantity(item.quantity_in_base * scale);
    const unitCost =
      typeof item.supply_unit_cost === 'number' && Number.isFinite(item.supply_unit_cost)
        ? item.supply_unit_cost
        : null;
    const lineCost = unitCost !== null ? roundUnitCost(new Decimal(quantity).mul(unitCost)) : null;
    return {
      supply_id: item.supply_id,
      supply_name: item.supply_name,
      base_unit: item.base_unit,
      quantity,
      unit_cost: unitCost,
      line_cost: lineCost,
    };
  });

  const costKnown =
    components.length > 0 &&
    components.every(
      (component) =>
        typeof component.unit_cost === 'number' && Number.isFinite(component.unit_cost),
    );
  const totalIngredientCost = costKnown
    ? roundCurrencyCost(
        components.reduce(
          (sum, component) => sum.plus(new Decimal(component.quantity).mul(component.unit_cost!)),
          new Decimal(0),
        ),
        fractionDigits,
      )
    : null;

  return {
    recipe_id: recipe.id,
    product_id: recipe.product_id,
    yield_quantity: recipe.yield_quantity,
    cost_known: costKnown,
    total_ingredient_cost: totalIngredientCost,
    components,
  };
}

export function scaleRecipeSnapshot(
  snapshot: RecipeSnapshot,
  ratio: number,
  fractionDigits: number,
): RecipeSnapshot {
  const components: RecipeSnapshotComponent[] = snapshot.components.map((component) => {
    const quantity = Number((component.quantity * ratio).toFixed(6));
    const hasUnitCost =
      typeof component.unit_cost === 'number' && Number.isFinite(component.unit_cost);
    const lineCost = hasUnitCost
      ? roundUnitCost(new Decimal(quantity).mul(component.unit_cost!))
      : component.line_cost !== undefined
        ? null
        : undefined;
    return {
      ...component,
      quantity,
      ...(lineCost !== undefined ? { line_cost: lineCost } : {}),
    };
  });
  const costKnown =
    snapshot.cost_known === true &&
    components.length > 0 &&
    components.every(
      (component) =>
        typeof component.unit_cost === 'number' && Number.isFinite(component.unit_cost),
    );
  const totalIngredientCost = costKnown
    ? roundCurrencyCost(
        components.reduce(
          (sum, component) => sum.plus(new Decimal(component.quantity).mul(component.unit_cost!)),
          new Decimal(0),
        ),
        fractionDigits,
      )
    : snapshot.cost_known !== undefined
      ? null
      : undefined;

  return {
    ...snapshot,
    ...(snapshot.cost_known !== undefined ? { cost_known: costKnown } : {}),
    ...(totalIngredientCost !== undefined ? { total_ingredient_cost: totalIngredientCost } : {}),
    components,
  };
}

export function extractOrderItemCostFromSnapshot(snapshot: RecipeSnapshot | null | undefined): {
  ingredientCost: number | null;
  ingredientCostKnown: 0 | 1;
} {
  if (
    snapshot &&
    snapshot.cost_known === true &&
    typeof snapshot.total_ingredient_cost === 'number' &&
    Number.isFinite(snapshot.total_ingredient_cost)
  ) {
    return {
      ingredientCost: snapshot.total_ingredient_cost,
      ingredientCostKnown: 1,
    };
  }
  return {
    ingredientCost: null,
    ingredientCostKnown: 0,
  };
}

export function parseRecipeSnapshot(raw: unknown): RecipeSnapshot | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as RecipeSnapshot;
    if (!parsed || !Array.isArray(parsed.components)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Apply snapshot component deltas to supply stock. Positive deltas restore,
 * negative deltas deplete. Callers must already be inside a transaction.
 */
export function applyRecipeSnapshot(
  db: ReturnType<typeof getDatabase>,
  snapshot: RecipeSnapshot,
  options: {
    direction: 'deplete' | 'restore';
    actorUserId: string;
    referenceId: string | number;
    createdAt?: string;
  },
): void {
  const movementType = options.direction === 'deplete' ? 'recipe_depletion' : 'recipe_restore';
  const sign = options.direction === 'deplete' ? -1 : 1;
  for (const component of snapshot.components) {
    const magnitude = roundQuantity(Math.abs(component.quantity));
    if (magnitude === 0) continue;
    applySupplyStockChange(db, {
      supplyId: component.supply_id,
      quantityDelta: sign * magnitude,
      movementType,
      unit: component.base_unit,
      reason: options.direction === 'deplete' ? 'Recipe depletion' : 'Recipe restore',
      actorUserId: options.actorUserId,
      referenceType: 'order_item',
      referenceId: options.referenceId,
      createdAt: options.createdAt,
    });
  }
}
