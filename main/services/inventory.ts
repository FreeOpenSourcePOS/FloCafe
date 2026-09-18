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
  productId: string | number;
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
  product_id: string;
  product_name: string | null;
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
export function adjustProductStock(
  db: ReturnType<typeof getDatabase>,
  options: StockChangeOptions,
): { stockBefore: number; stockAfter: number } {
  if (!Number.isFinite(options.quantityDelta) || options.quantityDelta === 0) {
    throw new InventoryServiceError(400, 'quantity_delta must be a non-zero finite number');
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

  const updatedAt = options.createdAt || now();
  const update = db.prepare(`
    UPDATE products
    SET stock_quantity = CASE
      WHEN ABS(COALESCE(stock_quantity, 0) + ?) <= ? THEN 0
      ELSE ROUND(COALESCE(stock_quantity, 0) + ?, ?)
    END, updated_at = ?
    WHERE id = ? AND COALESCE(stock_quantity, 0) + ? >= -?
  `);
  const result = update.run(
    options.quantityDelta,
    INVENTORY_QUANTITY_TOLERANCE,
    options.quantityDelta,
    INVENTORY_QUANTITY_PRECISION,
    updatedAt,
    options.productId,
    options.quantityDelta,
    INVENTORY_QUANTITY_TOLERANCE,
  );
  if (result.changes !== 1) {
    const current = db.prepare('SELECT id FROM products WHERE id = ?').get(options.productId);
    throw new InventoryServiceError(current ? 400 : 404, current ? 'Insufficient stock' : 'Product not found');
  }

  const updated = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(options.productId) as { stock_quantity: number };
  const stockAfter = Number(updated.stock_quantity);
  const stockBefore = stockAfter - options.quantityDelta;

  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.productId,
    options.quantityDelta,
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
  if (filters.referenceType) {
    conditions.push('m.reference_type = ?');
    params.push(filters.referenceType);
  }
  if (filters.referenceId) {
    conditions.push('m.reference_id = ?');
    params.push(filters.referenceId);
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
