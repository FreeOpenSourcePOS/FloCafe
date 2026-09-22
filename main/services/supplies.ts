import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import {
  SupplyUnit,
  assertSupplyUnit,
  convertQuantity,
  roundQuantity,
} from './units';

export type SupplyMovementType = 'receive' | 'count' | 'adjustment' | 'waste' | 'recipe_depletion' | 'recipe_restore';

export class SupplyServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'SupplyServiceError';
    this.statusCode = statusCode;
  }
}

export interface SupplyRecord {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  low_stock_threshold: number | null;
  is_active: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  is_low_stock?: number;
}

export interface SupplyMovement {
  id: number;
  supply_id: string;
  supply_name: string | null;
  quantity_delta: number;
  movement_type: SupplyMovementType;
  unit: SupplyUnit;
  stock_after: number;
  reason: string | null;
  actor_user_id: string;
  actor_name: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface CreateSupplyInput {
  id?: string;
  name: string;
  baseUnit: string;
  stockQuantity?: number;
  lowStockThreshold?: number | null;
  isActive?: boolean;
  actorUserId?: string;
}

export interface RecordMovementInput {
  supplyId: string;
  movementType: 'receive' | 'count' | 'adjustment' | 'waste';
  quantity: number;
  unit?: string;
  reason?: string | null;
  actorUserId: string;
  referenceType?: string | null;
  referenceId?: string | number | null;
  createdAt?: string;
}

function newId(): string {
  return `sup_${randomBytes(12).toString('hex')}`;
}

function assertReason(input: RecordMovementInput): string | null {
  const reason = input.reason === undefined || input.reason === null ? null : String(input.reason).trim();
  if ((input.movementType === 'adjustment' || input.movementType === 'waste') && !reason) {
    throw new SupplyServiceError(400, 'reason is required for adjustment and waste movements');
  }
  if (reason && reason.length > 500) {
    throw new SupplyServiceError(400, 'reason is too long');
  }
  return reason || null;
}

function normalizeQuantity(value: unknown, field = 'quantity'): number {
  const quantity = typeof value === 'string' ? Number(value) : value;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    throw new SupplyServiceError(400, `${field} must be a finite number`);
  }
  return quantity;
}

export function getSupply(db: ReturnType<typeof getDatabase>, id: string): SupplyRecord {
  const row = db.prepare('SELECT * FROM supplies WHERE id = ? AND deleted_at IS NULL').get(id) as SupplyRecord | undefined;
  if (!row) throw new SupplyServiceError(404, 'Supply not found');
  return row;
}

export function listSupplies(
  db: ReturnType<typeof getDatabase>,
  filters: { includeInactive?: boolean; search?: string; lowStockOnly?: boolean } = {},
): SupplyRecord[] {
  const conditions = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (!filters.includeInactive) conditions.push('is_active = 1');
  if (filters.search) {
    conditions.push('name LIKE ?');
    params.push(`%${filters.search}%`);
  }
  let sql = `
    SELECT *,
      CASE
        WHEN low_stock_threshold IS NOT NULL AND stock_quantity <= low_stock_threshold THEN 1
        ELSE 0
      END AS is_low_stock
    FROM supplies
    WHERE ${conditions.join(' AND ')}
    ORDER BY name COLLATE NOCASE
  `;
  if (filters.lowStockOnly) {
    sql = `
      SELECT *,
        CASE
          WHEN low_stock_threshold IS NOT NULL AND stock_quantity <= low_stock_threshold THEN 1
          ELSE 0
        END AS is_low_stock
      FROM supplies
      WHERE ${conditions.join(' AND ')}
        AND low_stock_threshold IS NOT NULL
        AND stock_quantity <= low_stock_threshold
      ORDER BY name COLLATE NOCASE
    `;
  }
  return db.prepare(sql).all(...params) as SupplyRecord[];
}

export function createSupply(db: ReturnType<typeof getDatabase>, input: CreateSupplyInput): SupplyRecord {
  const name = String(input.name || '').trim();
  if (!name) throw new SupplyServiceError(400, 'name is required');
  if (name.length > 200) throw new SupplyServiceError(400, 'name is too long');
  const baseUnit = assertSupplyUnit(input.baseUnit, 'base_unit');
  const stockQuantity = input.stockQuantity === undefined ? 0 : roundQuantity(normalizeQuantity(input.stockQuantity, 'stock_quantity'));
  if (input.lowStockThreshold !== undefined && input.lowStockThreshold !== null) {
    const threshold = normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold');
    if (threshold < 0) throw new SupplyServiceError(400, 'low_stock_threshold must be non-negative');
  }
  const lowStockThreshold = input.lowStockThreshold === undefined || input.lowStockThreshold === null
    ? null
    : roundQuantity(normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold'));
  const id = input.id || newId();
  const timestamp = now();
  const isActive = input.isActive === false ? 0 : 1;

  withTxn(() => {
    db.prepare(`
      INSERT INTO supplies (id, name, base_unit, stock_quantity, low_stock_threshold, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, name, baseUnit, lowStockThreshold, isActive, timestamp, timestamp);

    if (stockQuantity !== 0) {
      if (!input.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required for opening stock');
      applySupplyStockChange(db, {
        supplyId: id,
        quantityDelta: stockQuantity,
        movementType: 'adjustment',
        unit: baseUnit,
        reason: 'Opening balance',
        actorUserId: input.actorUserId,
        referenceType: 'opening_balance',
        referenceId: id,
        createdAt: timestamp,
      });
    }
  });

  return getSupply(db, id);
}

export function updateSupply(
  db: ReturnType<typeof getDatabase>,
  id: string,
  input: { name?: string; isActive?: boolean; lowStockThreshold?: number | null },
): SupplyRecord {
  const supply = getSupply(db, id);
  const name = input.name === undefined ? supply.name : String(input.name).trim();
  if (!name) throw new SupplyServiceError(400, 'name is required');
  if (name.length > 200) throw new SupplyServiceError(400, 'name is too long');
  let lowStockThreshold: number | null = supply.low_stock_threshold;
  if (input.lowStockThreshold !== undefined) {
    if (input.lowStockThreshold === null) {
      lowStockThreshold = null;
    } else {
      const threshold = normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold');
      if (threshold < 0) throw new SupplyServiceError(400, 'low_stock_threshold must be non-negative');
      lowStockThreshold = roundQuantity(threshold);
    }
  }
  const isActive = input.isActive === undefined ? supply.is_active : (input.isActive ? 1 : 0);
  db.prepare(`
    UPDATE supplies SET name = ?, low_stock_threshold = ?, is_active = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(name, lowStockThreshold, isActive, now(), id);
  return getSupply(db, id);
}

export function softDeleteSupply(db: ReturnType<typeof getDatabase>, id: string): void {
  getSupply(db, id);
  const linkedRecipe = db.prepare('SELECT 1 FROM recipe_items WHERE supply_id = ? LIMIT 1').get(id);
  if (linkedRecipe) throw new SupplyServiceError(409, 'Cannot delete a supply used by a recipe');
  const timestamp = now();
  db.prepare('UPDATE supplies SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(timestamp, timestamp, id);
}

export function applySupplyStockChange(
  db: ReturnType<typeof getDatabase>,
  options: {
    supplyId: string;
    quantityDelta: number;
    movementType: SupplyMovementType;
    unit?: string;
    reason?: string | null;
    actorUserId: string;
    referenceType?: string | null;
    referenceId?: string | number | null;
    createdAt?: string;
  },
): { stockBefore: number; stockAfter: number } {
  const supply = db.prepare('SELECT * FROM supplies WHERE id = ? AND deleted_at IS NULL').get(options.supplyId) as
    | SupplyRecord
    | undefined;
  if (!supply) throw new SupplyServiceError(404, 'Supply not found');
  if (!options.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');

  const unit = options.unit === undefined ? supply.base_unit : assertSupplyUnit(options.unit, 'unit');
  const deltaInBase = convertQuantity(options.quantityDelta, unit, supply.base_unit);
  if (deltaInBase === 0 && options.movementType !== 'count') {
    throw new SupplyServiceError(400, 'quantity_delta is too small to change stock');
  }

  const stockBefore = Number(supply.stock_quantity);
  const stockAfter = roundQuantity(stockBefore + deltaInBase);
  const timestamp = options.createdAt || now();

  db.prepare('UPDATE supplies SET stock_quantity = ?, updated_at = ? WHERE id = ?')
    .run(stockAfter, timestamp, options.supplyId);

  db.prepare(`
    INSERT INTO supply_movements (
      supply_id, quantity_delta, movement_type, unit, stock_after,
      reason, actor_user_id, reference_type, reference_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.supplyId,
    deltaInBase,
    options.movementType,
    supply.base_unit,
    stockAfter,
    options.reason ?? null,
    options.actorUserId,
    options.referenceType ?? null,
    options.referenceId === null || options.referenceId === undefined ? null : String(options.referenceId),
    timestamp,
  );

  return { stockBefore, stockAfter };
}

function recordSupplyMovementInTxn(db: ReturnType<typeof getDatabase>, input: RecordMovementInput): SupplyMovement | null {
  const supply = getSupply(db, input.supplyId);
  if (!input.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');
  const quantity = normalizeQuantity(input.quantity);
  const unit = input.unit === undefined ? supply.base_unit : assertSupplyUnit(input.unit, 'unit');
  const reason = assertReason(input);
  const timestamp = input.createdAt || now();

  let delta: number;
  switch (input.movementType) {
    case 'receive':
      if (quantity <= 0) throw new SupplyServiceError(400, 'receive quantity must be positive');
      delta = convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'waste':
      if (quantity <= 0) throw new SupplyServiceError(400, 'waste quantity must be positive');
      delta = -convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'adjustment':
      if (quantity === 0) throw new SupplyServiceError(400, 'adjustment quantity must be non-zero');
      delta = convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'count': {
      if (quantity < 0) throw new SupplyServiceError(400, 'count quantity must be non-negative');
      const target = convertQuantity(quantity, unit, supply.base_unit);
      delta = roundQuantity(target - Number(supply.stock_quantity));
      break;
    }
    default:
      throw new SupplyServiceError(400, `movement_type ${input.movementType} is not allowed via this path`);
  }

  const { stockAfter } = applySupplyStockChange(db, {
    supplyId: input.supplyId,
    quantityDelta: delta,
    movementType: input.movementType,
    unit: supply.base_unit,
    reason,
    actorUserId: input.actorUserId,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    createdAt: timestamp,
  });

  const row = db.prepare(`
    SELECT
      m.id, m.supply_id, s.name AS supply_name, m.quantity_delta, m.movement_type, m.unit,
      m.stock_after, m.reason, m.actor_user_id, u.name AS actor_name,
      m.reference_type, m.reference_id, m.created_at
    FROM supply_movements m
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    WHERE m.supply_id = ? AND m.created_at = ? AND m.stock_after = ?
    ORDER BY m.id DESC
    LIMIT 1
  `).get(input.supplyId, timestamp, stockAfter) as SupplyMovement | undefined;
  return row || null;
}

export function recordSupplyMovement(db: ReturnType<typeof getDatabase>, input: RecordMovementInput): SupplyMovement | null {
  return withTxn(() => recordSupplyMovementInTxn(db, input));
}

export function listSupplyMovements(
  db: ReturnType<typeof getDatabase>,
  filters: {
    supplyId?: string;
    movementType?: SupplyMovementType;
    beforeId?: number;
    perPage?: number;
  } = {},
): { movements: SupplyMovement[]; nextCursor: number | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.supplyId) {
    conditions.push('m.supply_id = ?');
    params.push(filters.supplyId);
  }
  if (filters.movementType) {
    conditions.push('m.movement_type = ?');
    params.push(filters.movementType);
  }
  if (filters.beforeId !== undefined) {
    const cursor = db.prepare('SELECT created_at FROM supply_movements WHERE id = ?').get(filters.beforeId) as
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
      m.id, m.supply_id, s.name AS supply_name, m.quantity_delta, m.movement_type, m.unit,
      m.stock_after, m.reason, m.actor_user_id, u.name AS actor_name,
      m.reference_type, m.reference_id, m.created_at
    FROM supply_movements m
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    ${whereSql}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as SupplyMovement[];

  const hasMore = rows.length > perPage;
  const movements = hasMore ? rows.slice(0, perPage) : rows;
  return {
    movements,
    nextCursor: hasMore ? movements[movements.length - 1].id : null,
  };
}
