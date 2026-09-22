import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import {
  SupplyUnit,
  assertSupplyUnit,
  convertQuantity,
  roundQuantity,
} from './units';
import { applySupplyStockChange } from './supplies';

export class RecipeServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RecipeServiceError';
    this.statusCode = statusCode;
  }
}

export interface RecipeComponent {
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit: SupplyUnit;
  quantity_in_base: number;
}

export interface RecipeSnapshot {
  recipe_id: string;
  product_id: string;
  yield_quantity: number;
  /** Scaled amounts for this order item quantity, already in each supply's base unit. */
  components: {
    supply_id: string;
    supply_name: string;
    base_unit: SupplyUnit;
    quantity: number;
  }[];
}

export interface RecipeRecord {
  id: string;
  product_id: string;
  product_name: string | null;
  yield_quantity: number;
  is_active: number;
  created_at: string;
  updated_at: string;
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

function assertPositiveFinite(value: unknown, field: string): number {
  const quantity = typeof value === 'string' ? Number(value) : value;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    throw new RecipeServiceError(400, `${field} must be a finite number`);
  }
  if (quantity <= 0) {
    throw new RecipeServiceError(400, `${field} must be greater than zero`);
  }
  return quantity;
}

function loadRecipeItems(db: ReturnType<typeof getDatabase>, recipeId: string): RecipeComponent[] {
  const rows = db.prepare(`
    SELECT
      ri.supply_id,
      s.name AS supply_name,
      s.base_unit,
      ri.quantity,
      ri.unit
    FROM recipe_items ri
    JOIN supplies s ON s.id = ri.supply_id
    WHERE ri.recipe_id = ?
    ORDER BY ri.created_at, ri.id
  `).all(recipeId) as {
    supply_id: string;
    supply_name: string;
    base_unit: SupplyUnit;
    quantity: number;
    unit: SupplyUnit;
  }[];
  return rows.map((row) => ({
    ...row,
    quantity_in_base: convertQuantity(row.quantity, row.unit, row.base_unit),
  }));
}

export function getRecipeByProduct(db: ReturnType<typeof getDatabase>, productId: string): RecipeRecord | null {
  const row = db.prepare(`
    SELECT r.*, p.name AS product_name
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.product_id = ?
  `).get(productId) as (Omit<RecipeRecord, 'items'> & { product_name: string | null }) | undefined;
  if (!row) return null;
  return { ...row, items: loadRecipeItems(db, row.id) };
}

export function getRecipe(db: ReturnType<typeof getDatabase>, id: string): RecipeRecord | null {
  const row = db.prepare(`
    SELECT r.*, p.name AS product_name
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.id = ?
  `).get(id) as (Omit<RecipeRecord, 'items'> & { product_name: string | null }) | undefined;
  if (!row) return null;
  return { ...row, items: loadRecipeItems(db, row.id) };
}

export function listRecipes(db: ReturnType<typeof getDatabase>): RecipeRecord[] {
  const rows = db.prepare(`
    SELECT r.*, p.name AS product_name
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY p.name COLLATE NOCASE
  `).all() as (Omit<RecipeRecord, 'items'> & { product_name: string | null })[];
  return rows.map((row) => ({ ...row, items: loadRecipeItems(db, row.id) }));
}

export function saveRecipe(db: ReturnType<typeof getDatabase>, input: SaveRecipeInput): RecipeRecord {
  const productId = String(input.productId || '').trim();
  if (!productId) throw new RecipeServiceError(400, 'product_id is required');
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) throw new RecipeServiceError(404, 'Product not found');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new RecipeServiceError(400, 'items must contain at least one supply');
  }

  const seenSupplies = new Set<string>();
  const normalizedItems: { supplyId: string; quantity: number; unit: SupplyUnit }[] = [];
  for (const item of input.items) {
    const supplyId = String(item?.supply_id || item?.supplyId || '').trim();
    if (!supplyId) throw new RecipeServiceError(400, 'each item requires a supply_id');
    if (seenSupplies.has(supplyId)) {
      throw new RecipeServiceError(400, 'duplicate supply_id in recipe');
    }
    seenSupplies.add(supplyId);
    const supply = db.prepare('SELECT id, base_unit FROM supplies WHERE id = ? AND deleted_at IS NULL').get(supplyId) as
      | { id: string; base_unit: SupplyUnit }
      | undefined;
    if (!supply) throw new RecipeServiceError(404, `Supply ${supplyId} not found`);
    const quantity = assertPositiveFinite(item.quantity, 'item.quantity');
    const unit = assertSupplyUnit(item.unit, 'item.unit');
    // Validate convertibility at save time so depletion cannot fail later.
    convertQuantity(quantity, unit, supply.base_unit);
    normalizedItems.push({ supplyId, quantity, unit });
  }

  const yieldQuantity = input.yieldQuantity === undefined ? 1 : assertPositiveFinite(input.yieldQuantity, 'yield_quantity');
  const isActive = input.isActive === false ? 0 : 1;
  const timestamp = now();

  const recipeId = withTxn(() => {
    const existing = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId) as { id: string } | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE recipes SET yield_quantity = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(yieldQuantity, isActive, timestamp, id);
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
  const existing = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId) as { id: string } | undefined;
  if (!existing) throw new RecipeServiceError(404, 'Recipe not found');
  withTxn(() => {
    db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(existing.id);
    db.prepare('DELETE FROM recipes WHERE id = ?').run(existing.id);
  });
}

/**
 * Build an immutable per-order-item snapshot of the recipe scaled to the
 * ordered quantity. Returns null when the product has no active recipe.
 */
export function buildRecipeSnapshot(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  orderQuantity: number,
): RecipeSnapshot | null {
  const recipe = getRecipeByProduct(db, productId);
  if (!recipe || recipe.is_active !== 1 || recipe.items.length === 0) return null;
  if (!Number.isFinite(orderQuantity) || orderQuantity <= 0) return null;

  const scale = orderQuantity / recipe.yield_quantity;
  const components = recipe.items.map((item) => ({
    supply_id: item.supply_id,
    supply_name: item.supply_name,
    base_unit: item.base_unit,
    quantity: roundQuantity(item.quantity_in_base * scale),
  }));

  return {
    recipe_id: recipe.id,
    product_id: recipe.product_id,
    yield_quantity: recipe.yield_quantity,
    components,
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
