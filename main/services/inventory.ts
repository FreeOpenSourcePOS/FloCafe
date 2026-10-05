import { getDatabase, now } from '../db';

export type InventoryMovementType = 'sale' | 'cancel_restore' | 'adjustment';

const INVENTORY_QUANTITY_PRECISION = 8;
const INVENTORY_QUANTITY_TOLERANCE = 1e-8;

export class InventoryServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'InventoryServiceError';
    this.statusCode = statusCode;
  }
}

export interface StockChangeOptions {
  /** Null when the delta moves an add-on pool, which has no owning product. */
  productId: string | number | null;
  variantId?: string | null;
  addonId?: string | null;
  quantityDelta: number;
  movementType: InventoryMovementType;
  actorUserId: string;
  referenceType?: string | null;
  referenceId?: string | number | bigint | null;
  reason?: string | null;
  createdAt?: string;
}

export interface InventoryMovementFilters {
  productId?: string;
  movementType?: InventoryMovementType;
  referenceType?: string;
  referenceId?: string;
  beforeId?: number;
  perPage?: number;
}

export interface InventoryMovement {
  id: number;
  product_id: string | null;
  product_name: string | null;
  variant_id: string | null;
  addon_id: string | null;
  quantity_delta: number;
  movement_type: InventoryMovementType;
  reference_type: string | null;
  reference_id: string | null;
  reason: string | null;
  actor_user_id: string;
  actor_name: string | null;
  stock_after: number;
  created_at: string;
  imported_by_user_id: string | null;
  import_batch_id: string | null;
  source_actor_user_id: string | null;
  source_reference_type: string | null;
  source_reference_id: string | null;
  source_reason: string | null;
  source_created_at: string | null;
}

export interface InventoryMovementPage {
  movements: InventoryMovement[];
  nextCursor: number | null;
}

/** Apply a stock delta and append its ledger row. Callers must provide the transaction boundary. */
export interface InventoryDeduction {
  productId: string;
  deductedQuantity: number;
  /** Set when the delta moves a variant's own stock pool rather than the product's. */
  variantId?: string;
}

export interface InventoryProductLike {
  id: string | number;
  track_inventory?: number | boolean | null;
  inventory_product_id?: string | null;
  inventory_deduction_quantity?: number | null;
}

/**
 * Resolve which stock a sale quantity consumes.
 *
 * A variant decides first: a recipe link depletes the base ingredient by a
 * multiplier, otherwise a tracked variant depletes its own stock pool. With no
 * variant the product's own link/track_inventory rules apply, so existing
 * callers keep their behaviour.
 */
export function resolveInventoryDeduction(
  product: InventoryProductLike,
  quantity: number,
  variant?: InventoryProductLike | null,
): InventoryDeduction | null {
  if (variant) {
    if (variant.inventory_product_id) {
      const factor = Number(variant.inventory_deduction_quantity ?? 1);
      if (!Number.isFinite(factor) || factor <= 0) return null;
      const deductedQuantity = quantity * factor;
      if (!Number.isFinite(deductedQuantity) || deductedQuantity <= 0) return null;
      return { productId: variant.inventory_product_id, deductedQuantity };
    }
    if (Number(variant.track_inventory) === 1 || variant.track_inventory === true) {
      if (!Number.isFinite(quantity) || quantity <= 0) return null;
      return { productId: String(product.id), deductedQuantity: quantity, variantId: String(variant.id) };
    }
  }
  if (product.inventory_product_id) {
    const factor = Number(product.inventory_deduction_quantity ?? 1);
    if (!Number.isFinite(factor) || factor <= 0) return null;
    const deductedQuantity = quantity * factor;
    if (!Number.isFinite(deductedQuantity) || deductedQuantity <= 0) return null;
    return { productId: product.inventory_product_id, deductedQuantity };
  }
  if (Number(product.track_inventory) === 1 || product.track_inventory === true) {
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    return { productId: String(product.id), deductedQuantity: quantity };
  }
  return null;
}

export function adjustProductStock(
  db: ReturnType<typeof getDatabase>,
  options: StockChangeOptions,
): { stockBefore: number; stockAfter: number } {
  if (!Number.isFinite(options.quantityDelta) || options.quantityDelta === 0) {
    throw new InventoryServiceError(400, 'quantity_delta must be a non-zero finite number');
  }
  const normalizedQuantityDelta = Number(options.quantityDelta.toFixed(INVENTORY_QUANTITY_PRECISION));
  if (normalizedQuantityDelta === 0) {
    throw new InventoryServiceError(400, 'quantity_delta is too small to change stock');
  }
  if (!options.actorUserId) {
    throw new InventoryServiceError(400, 'actor_user_id is required');
  }
  if (options.reason !== undefined && options.reason !== null && typeof options.reason !== 'string') {
    throw new InventoryServiceError(400, 'reason must be a string');
  }
  if (typeof options.reason === 'string' && options.reason.length > 500) {
    throw new InventoryServiceError(400, 'reason is too long');
  }
  const addonId = options.addonId ?? null;
  const variantId = options.variantId ?? null;
  // One movement moves one pool. Naming two would write a ledger row that the
  // validator cannot attribute to a single snapshot row.
  if (addonId && variantId) {
    throw new InventoryServiceError(400, 'A movement moves either a variant pool or an add-on pool, not both');
  }
  if (!options.productId && !addonId) {
    throw new InventoryServiceError(400, 'product_id or addon_id is required');
  }

  const updatedAt = options.createdAt || now();
  // A variant keeps its own stock pool but shares the product id, and an add-on
  // owns a pool with no product at all, so the ledger row names only the pool
  // the delta actually moved.
  let stockTable = 'products';
  let stockKey = 'id = ?';
  let stockLabel = 'Product';
  let stockIdArgs: (string | number)[] = [options.productId as string | number];
  if (addonId) {
    stockTable = 'addons';
    stockLabel = 'Add-on';
    stockIdArgs = [String(addonId)];
  } else if (variantId) {
    stockTable = 'product_variants';
    stockKey = 'id = ? AND product_id = ?';
    stockLabel = 'Variant';
    stockIdArgs = [variantId, options.productId as string | number];
  }
  const readStock = db.prepare(`SELECT stock_quantity FROM ${stockTable} WHERE ${stockKey}`);
  const current = readStock.get(...stockIdArgs) as { stock_quantity: number | null } | undefined;
  const stockBefore = Number(current?.stock_quantity ?? 0);
  const update = db.prepare(`
    UPDATE ${stockTable}
    SET stock_quantity = CASE
      WHEN ABS(COALESCE(stock_quantity, 0) + ?) <= ? THEN 0
      ELSE ROUND(COALESCE(stock_quantity, 0) + ?, ?)
    END, updated_at = ?
    WHERE ${stockKey}
      AND COALESCE(stock_quantity, 0) + ? >= -?
      AND CASE
        WHEN ABS(COALESCE(stock_quantity, 0) + ?) <= ? THEN 0
        ELSE ROUND(COALESCE(stock_quantity, 0) + ?, ?)
      END != COALESCE(stock_quantity, 0)
  `);
  const result = update.run(
    normalizedQuantityDelta,
    INVENTORY_QUANTITY_TOLERANCE,
    normalizedQuantityDelta,
    INVENTORY_QUANTITY_PRECISION,
    updatedAt,
    ...stockIdArgs,
    normalizedQuantityDelta,
    INVENTORY_QUANTITY_TOLERANCE,
    normalizedQuantityDelta,
    INVENTORY_QUANTITY_TOLERANCE,
    normalizedQuantityDelta,
    INVENTORY_QUANTITY_PRECISION,
  );
  if (result.changes !== 1) {
    if (!current) {
      throw new InventoryServiceError(404, `${stockLabel} not found`);
    }
    throw new InventoryServiceError(400, 'Insufficient stock');
  }

  const updatedStock = readStock.get(...stockIdArgs) as { stock_quantity: number };
  const stockAfter = Number(updatedStock.stock_quantity);
  const effectiveQuantityDelta = stockAfter - stockBefore;

  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, variant_id, addon_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.productId ?? null,
    variantId,
    addonId,
    effectiveQuantityDelta,
    options.movementType,
    options.referenceType ?? null,
    options.referenceId === null || options.referenceId === undefined ? null : String(options.referenceId),
    options.reason ?? null,
    options.actorUserId,
    stockAfter,
    updatedAt,
  );

  return { stockBefore, stockAfter };
}

export function listInventoryMovements(
  db: ReturnType<typeof getDatabase>,
  filters: InventoryMovementFilters = {},
): InventoryMovementPage {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.productId) {
    conditions.push('m.product_id = ?');
    params.push(filters.productId);
  }
  if (filters.movementType) {
    conditions.push('m.movement_type = ?');
    params.push(filters.movementType);
  }
  if (filters.referenceType && filters.referenceId) {
    conditions.push('((m.reference_type = ? AND m.reference_id = ?) OR (m.source_reference_type = ? AND m.source_reference_id = ?))');
    params.push(filters.referenceType, filters.referenceId, filters.referenceType, filters.referenceId);
  } else if (filters.referenceType) {
    conditions.push('(m.reference_type = ? OR m.source_reference_type = ?)');
    params.push(filters.referenceType, filters.referenceType);
  } else if (filters.referenceId) {
    conditions.push('(m.reference_id = ? OR m.source_reference_id = ?)');
    params.push(filters.referenceId, filters.referenceId);
  }
  if (filters.beforeId !== undefined) {
    const cursor = db.prepare('SELECT created_at FROM inventory_movements WHERE id = ?').get(filters.beforeId) as
      | { created_at: string }
      | undefined;
    if (cursor) {
      conditions.push('(m.created_at, m.id) < (?, ?)');
      params.push(cursor.created_at, filters.beforeId);
    }
  }

  const perPage = filters.perPage ?? 50;
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      m.id,
      m.product_id,
      p.name AS product_name,
      m.variant_id,
      m.addon_id,
      m.quantity_delta,
      m.movement_type,
      m.reference_type,
      m.reference_id,
      m.reason,
      m.actor_user_id,
      u.name AS actor_name,
      m.stock_after,
      m.created_at,
      m.imported_by_user_id,
      m.import_batch_id,
      m.source_actor_user_id,
      m.source_reference_type,
      m.source_reference_id,
      m.source_reason,
      m.source_created_at
    FROM inventory_movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    ${whereSql}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as InventoryMovement[];

  const hasMore = rows.length > perPage;
  const movements = hasMore ? rows.slice(0, perPage) : rows;
  return {
    movements,
    nextCursor: hasMore ? movements[movements.length - 1].id : null,
  };
}
