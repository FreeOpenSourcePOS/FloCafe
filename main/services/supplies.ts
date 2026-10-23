import { randomBytes } from 'crypto';
import Decimal from 'decimal.js';
import { getCurrencyFractionDigits } from '../countries';
import { getDatabase, now, withTxn } from '../db';
import { getTenantCurrency } from './refund';
import { SupplyUnit, assertSupplyUnit, convertQuantity, roundQuantity } from './units';

export const COST_PRECISION = 10;

export function roundUnitCost(value: number | Decimal): number {
  const rounded = new Decimal(value)
    .toDecimalPlaces(COST_PRECISION, Decimal.ROUND_HALF_UP)
    .toNumber();
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundCurrencyCost(value: number | Decimal, fractionDigits: number): number {
  const rounded = new Decimal(value)
    .toDecimalPlaces(fractionDigits, Decimal.ROUND_HALF_UP)
    .toNumber();
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function resolveDbCurrencyFractionDigits(db: ReturnType<typeof getDatabase>): number {
  try {
    return getCurrencyFractionDigits(getTenantCurrency(db));
  } catch {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as
        | { value?: string | null }
        | undefined;
      return getCurrencyFractionDigits(row?.value || '');
    } catch {
      return 2;
    }
  }
}

export type SupplyMovementType =
  | 'receive'
  | 'count'
  | 'adjustment'
  | 'waste'
  | 'recipe_depletion'
  | 'recipe_restore';
export type SupplyServiceDiagnosticCode =
  | 'recipe_linked'
  | 'name_required'
  | 'name_too_long'
  | 'quantity_invalid'
  | 'unit_invalid'
  | 'threshold_invalid'
  | 'cost_invalid'
  | 'movement_reason_required'
  | 'movement_reason_too_long'
  | 'movement_quantity_invalid'
  | 'movement_zero'
  | 'movement_negative';

export class SupplyServiceError extends Error {
  readonly statusCode: number;
  readonly diagnosticCode?: SupplyServiceDiagnosticCode;

  constructor(statusCode: number, message: string, diagnosticCode?: SupplyServiceDiagnosticCode) {
    super(message);
    this.name = 'SupplyServiceError';
    this.statusCode = statusCode;
    this.diagnosticCode = diagnosticCode;
  }
}

export interface SupplyRecord {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  low_stock_threshold: number | null;
  unit_cost: number | null;
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
  unit_cost: number | null;
  total_cost: number | null;
  unit_cost_after: number | null;
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
  unitCost?: number | null;
  unitCostUnit?: string;
  isActive?: boolean;
  actorUserId?: string;
}

export interface RecordMovementInput {
  supplyId: string;
  movementType: 'receive' | 'count' | 'adjustment' | 'waste';
  quantity: number;
  unit?: string;
  unitCost?: number | null;
  totalCost?: number | null;
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
  const reason =
    input.reason === undefined || input.reason === null ? null : String(input.reason).trim();
  if ((input.movementType === 'adjustment' || input.movementType === 'waste') && !reason) {
    throw new SupplyServiceError(
      400,
      'reason is required for adjustment and waste movements',
      'movement_reason_required',
    );
  }
  if (reason && reason.length > 500) {
    throw new SupplyServiceError(400, 'reason is too long', 'movement_reason_too_long');
  }
  return reason || null;
}

function normalizeQuantity(
  value: unknown,
  field = 'quantity',
  diagnosticCode:
    | 'quantity_invalid'
    | 'threshold_invalid'
    | 'movement_quantity_invalid' = 'quantity_invalid',
): number {
  const quantity = typeof value === 'string' ? Number(value) : value;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    throw new SupplyServiceError(400, `${field} must be a finite number`, diagnosticCode);
  }
  return quantity;
}

function normalizeCost(value: unknown, field = 'unit_cost'): number {
  const cost = typeof value === 'string' ? Number(value) : value;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw new SupplyServiceError(
      400,
      `${field} must be a non-negative finite number`,
      'cost_invalid',
    );
  }
  return cost;
}

function normalizeUnitCostInBase(
  rawCost: unknown,
  costUnitRaw: string | undefined,
  baseUnit: SupplyUnit,
  field = 'unit_cost',
): number {
  const cost = normalizeCost(rawCost, field);
  const costUnit =
    costUnitRaw === undefined || costUnitRaw === null
      ? baseUnit
      : assertSupplyUnit(costUnitRaw, `${field}_unit`);
  const factorToBase = convertQuantity(1, costUnit, baseUnit);
  return roundUnitCost(new Decimal(cost).div(factorToBase));
}

export function getSupply(db: ReturnType<typeof getDatabase>, id: string): SupplyRecord {
  const row = db.prepare('SELECT * FROM supplies WHERE id = ? AND deleted_at IS NULL').get(id) as
    | SupplyRecord
    | undefined;
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

export function createSupply(
  db: ReturnType<typeof getDatabase>,
  input: CreateSupplyInput,
): SupplyRecord {
  const name = String(input.name || '').trim();
  if (!name) throw new SupplyServiceError(400, 'name is required', 'name_required');
  if (name.length > 200) throw new SupplyServiceError(400, 'name is too long', 'name_too_long');
  const baseUnit = assertSupplyUnit(input.baseUnit, 'base_unit');
  const stockQuantity =
    input.stockQuantity === undefined
      ? 0
      : roundQuantity(normalizeQuantity(input.stockQuantity, 'stock_quantity'));
  if (input.lowStockThreshold !== undefined && input.lowStockThreshold !== null) {
    const threshold = normalizeQuantity(
      input.lowStockThreshold,
      'low_stock_threshold',
      'threshold_invalid',
    );
    if (threshold < 0)
      throw new SupplyServiceError(
        400,
        'low_stock_threshold must be non-negative',
        'threshold_invalid',
      );
  }
  const lowStockThreshold =
    input.lowStockThreshold === undefined || input.lowStockThreshold === null
      ? null
      : roundQuantity(normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold'));
  const unitCost =
    input.unitCost === undefined || input.unitCost === null
      ? null
      : normalizeUnitCostInBase(input.unitCost, input.unitCostUnit, baseUnit, 'unit_cost');
  const id = input.id || newId();
  const timestamp = now();
  const isActive = input.isActive === false ? 0 : 1;

  withTxn(() => {
    db.prepare(`
      INSERT INTO supplies (id, name, base_unit, stock_quantity, low_stock_threshold, unit_cost, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(id, name, baseUnit, lowStockThreshold, unitCost, isActive, timestamp, timestamp);

    if (stockQuantity !== 0) {
      if (!input.actorUserId)
        throw new SupplyServiceError(400, 'actor_user_id is required for opening stock');
      const fractionDigits = resolveDbCurrencyFractionDigits(db);
      const openingTotalCost =
        unitCost !== null && stockQuantity > 0
          ? roundCurrencyCost(new Decimal(stockQuantity).mul(unitCost), fractionDigits)
          : null;
      applySupplyStockChange(db, {
        supplyId: id,
        quantityDelta: stockQuantity,
        movementType: 'adjustment',
        unit: baseUnit,
        unitCost: unitCost !== null && stockQuantity > 0 ? unitCost : null,
        totalCost: openingTotalCost,
        unitCostAfter: unitCost,
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
  input: {
    name?: string;
    isActive?: boolean;
    lowStockThreshold?: number | null;
    unitCost?: number | null;
    unitCostUnit?: string;
  },
): SupplyRecord {
  const supply = getSupply(db, id);
  const name = input.name === undefined ? supply.name : String(input.name).trim();
  if (!name) throw new SupplyServiceError(400, 'name is required', 'name_required');
  if (name.length > 200) throw new SupplyServiceError(400, 'name is too long', 'name_too_long');
  let lowStockThreshold: number | null = supply.low_stock_threshold;
  if (input.lowStockThreshold !== undefined) {
    if (input.lowStockThreshold === null) {
      lowStockThreshold = null;
    } else {
      const threshold = normalizeQuantity(
        input.lowStockThreshold,
        'low_stock_threshold',
        'threshold_invalid',
      );
      if (threshold < 0)
        throw new SupplyServiceError(
          400,
          'low_stock_threshold must be non-negative',
          'threshold_invalid',
        );
      lowStockThreshold = roundQuantity(threshold);
    }
  }
  let unitCost: number | null =
    supply.unit_cost === undefined || supply.unit_cost === null ? null : Number(supply.unit_cost);
  if (input.unitCost !== undefined) {
    if (input.unitCost === null) {
      unitCost = null;
    } else {
      unitCost = normalizeUnitCostInBase(
        input.unitCost,
        input.unitCostUnit,
        supply.base_unit,
        'unit_cost',
      );
    }
  }
  const isActive = input.isActive === undefined ? supply.is_active : input.isActive ? 1 : 0;
  db.prepare(`
    UPDATE supplies SET name = ?, low_stock_threshold = ?, unit_cost = ?, is_active = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(name, lowStockThreshold, unitCost, isActive, now(), id);
  return getSupply(db, id);
}

export function softDeleteSupply(db: ReturnType<typeof getDatabase>, id: string): void {
  getSupply(db, id);
  const linkedRecipe = db.prepare('SELECT 1 FROM recipe_items WHERE supply_id = ? LIMIT 1').get(id);
  if (linkedRecipe)
    throw new SupplyServiceError(409, 'Cannot delete a supply used by a recipe', 'recipe_linked');
  const timestamp = now();
  db.prepare(
    'UPDATE supplies SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
  ).run(timestamp, timestamp, id);
}

export function applySupplyStockChange(
  db: ReturnType<typeof getDatabase>,
  options: {
    supplyId: string;
    quantityDelta: number;
    movementType: SupplyMovementType;
    unit?: string;
    unitCost?: number | null;
    totalCost?: number | null;
    unitCostAfter?: number | null;
    reason?: string | null;
    actorUserId: string;
    referenceType?: string | null;
    referenceId?: string | number | null;
    createdAt?: string;
  },
): { stockBefore: number; stockAfter: number; movementId: number } {
  const supply = db.prepare('SELECT * FROM supplies WHERE id = ?').get(options.supplyId) as
    | SupplyRecord
    | undefined;
  if (!supply) throw new SupplyServiceError(404, 'Supply not found');
  if (!options.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');

  const unit =
    options.unit === undefined ? supply.base_unit : assertSupplyUnit(options.unit, 'unit');
  const deltaInBase = convertQuantity(options.quantityDelta, unit, supply.base_unit);
  if (deltaInBase === 0 && options.movementType !== 'count') {
    throw new SupplyServiceError(
      400,
      'quantity_delta is too small to change stock',
      'movement_zero',
    );
  }

  const stockBefore = Number(supply.stock_quantity);
  const stockAfter = roundQuantity(stockBefore + deltaInBase);
  const timestamp = options.createdAt || now();
  const currentUnitCost =
    supply.unit_cost === undefined || supply.unit_cost === null ? null : Number(supply.unit_cost);
  const nextUnitCost =
    options.unitCostAfter === undefined ? currentUnitCost : options.unitCostAfter;

  db.prepare(
    'UPDATE supplies SET stock_quantity = ?, unit_cost = ?, updated_at = ? WHERE id = ?',
  ).run(stockAfter, nextUnitCost, timestamp, options.supplyId);

  const movement = db
    .prepare(`
    INSERT INTO supply_movements (
      supply_id, quantity_delta, movement_type, unit, stock_after,
      unit_cost, total_cost, unit_cost_after,
      reason, actor_user_id, reference_type, reference_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      options.supplyId,
      deltaInBase,
      options.movementType,
      supply.base_unit,
      stockAfter,
      options.unitCost ?? null,
      options.totalCost ?? null,
      nextUnitCost,
      options.reason ?? null,
      options.actorUserId,
      options.referenceType ?? null,
      options.referenceId === null || options.referenceId === undefined
        ? null
        : String(options.referenceId),
      timestamp,
    );

  return { stockBefore, stockAfter, movementId: Number(movement.lastInsertRowid) };
}

function recordSupplyMovementInTxn(
  db: ReturnType<typeof getDatabase>,
  input: RecordMovementInput,
): SupplyMovement | null {
  const supply = getSupply(db, input.supplyId);
  if (!input.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');
  const quantity = normalizeQuantity(input.quantity, 'quantity', 'movement_quantity_invalid');
  const unit = input.unit === undefined ? supply.base_unit : assertSupplyUnit(input.unit, 'unit');
  const reason = assertReason(input);
  const timestamp = input.createdAt || now();

  const hasUnitCostInput = input.unitCost !== undefined && input.unitCost !== null;
  const hasTotalCostInput = input.totalCost !== undefined && input.totalCost !== null;
  if ((hasUnitCostInput || hasTotalCostInput) && input.movementType !== 'receive') {
    throw new SupplyServiceError(
      400,
      'Purchase cost can only be recorded on receive movements',
      'cost_invalid',
    );
  }

  let delta: number;
  switch (input.movementType) {
    case 'receive':
      if (quantity <= 0)
        throw new SupplyServiceError(
          400,
          'receive quantity must be positive',
          quantity === 0 ? 'movement_zero' : 'movement_negative',
        );
      delta = convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'waste':
      if (quantity <= 0)
        throw new SupplyServiceError(
          400,
          'waste quantity must be positive',
          quantity === 0 ? 'movement_zero' : 'movement_negative',
        );
      delta = -convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'adjustment':
      if (quantity === 0)
        throw new SupplyServiceError(400, 'adjustment quantity must be non-zero', 'movement_zero');
      delta = convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'count': {
      if (quantity < 0)
        throw new SupplyServiceError(
          400,
          'count quantity must be non-negative',
          'movement_negative',
        );
      const target = convertQuantity(quantity, unit, supply.base_unit);
      delta = roundQuantity(target - Number(supply.stock_quantity));
      break;
    }
    default:
      throw new SupplyServiceError(
        400,
        `movement_type ${input.movementType} is not allowed via this path`,
      );
  }

  const oldUnitCost =
    supply.unit_cost === undefined || supply.unit_cost === null ? null : Number(supply.unit_cost);
  let batchUnitCostInBase: number | null = null;
  let batchTotalCost: number | null = null;
  let nextUnitCost: number | null = oldUnitCost;

  if (input.movementType === 'receive' && (hasUnitCostInput || hasTotalCostInput)) {
    const fractionDigits = resolveDbCurrencyFractionDigits(db);
    if (hasUnitCostInput) {
      const enteredUnitCost = normalizeCost(input.unitCost, 'unit_cost');
      const factorToBase = convertQuantity(1, unit, supply.base_unit);
      batchUnitCostInBase = roundUnitCost(new Decimal(enteredUnitCost).div(factorToBase));
      batchTotalCost = hasTotalCostInput
        ? roundCurrencyCost(normalizeCost(input.totalCost, 'total_cost'), fractionDigits)
        : roundCurrencyCost(new Decimal(enteredUnitCost).mul(quantity), fractionDigits);
    } else if (hasTotalCostInput) {
      const enteredTotalCost = normalizeCost(input.totalCost, 'total_cost');
      batchTotalCost = roundCurrencyCost(enteredTotalCost, fractionDigits);
      batchUnitCostInBase = roundUnitCost(new Decimal(enteredTotalCost).div(delta));
    }

    const stockBefore = Number(supply.stock_quantity);
    if (batchUnitCostInBase !== null) {
      if (oldUnitCost === null || stockBefore <= 0) {
        nextUnitCost = batchUnitCostInBase;
      } else {
        const weightedTotal = new Decimal(stockBefore)
          .mul(oldUnitCost)
          .plus(new Decimal(delta).mul(batchUnitCostInBase));
        const newStock = new Decimal(stockBefore).plus(delta);
        nextUnitCost = roundUnitCost(weightedTotal.div(newStock));
      }
    }
  }

  const { movementId } = applySupplyStockChange(db, {
    supplyId: input.supplyId,
    quantityDelta: delta,
    movementType: input.movementType,
    unit: supply.base_unit,
    unitCost: batchUnitCostInBase,
    totalCost: batchTotalCost,
    unitCostAfter: nextUnitCost,
    reason,
    actorUserId: input.actorUserId,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    createdAt: timestamp,
  });

  const row = db
    .prepare(`
    SELECT
      m.id, m.supply_id, s.name AS supply_name, m.quantity_delta, m.movement_type, m.unit,
      m.stock_after, m.unit_cost, m.total_cost, m.unit_cost_after,
      m.reason, m.actor_user_id, u.name AS actor_name,
      m.reference_type, m.reference_id, m.created_at
    FROM supply_movements m
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    WHERE m.id = ?
  `)
    .get(movementId) as SupplyMovement | undefined;
  return row || null;
}

export function recordSupplyMovement(
  db: ReturnType<typeof getDatabase>,
  input: RecordMovementInput,
): SupplyMovement | null {
  return withTxn(() => recordSupplyMovementInTxn(db, input));
}

export function listSupplyMovements(
  db: ReturnType<typeof getDatabase>,
  filters: {
    supplyId?: string;
    movementType?: SupplyMovementType;
    search?: string;
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
  if (filters.search) {
    conditions.push(
      "(s.name LIKE ? ESCAPE '!' OR m.reason LIKE ? ESCAPE '!' OR u.name LIKE ? ESCAPE '!')",
    );
    const searchTerm = `%${filters.search.replace(/[!%_]/g, '!$&')}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  if (filters.beforeId !== undefined) {
    const cursor = db
      .prepare('SELECT created_at FROM supply_movements WHERE id = ?')
      .get(filters.beforeId) as { created_at: string } | undefined;
    if (cursor) {
      conditions.push('(m.created_at, m.id) < (?, ?)');
      params.push(cursor.created_at, filters.beforeId);
    }
  }
  const perPage = filters.perPage ?? 50;
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`
    SELECT
      m.id, m.supply_id, s.name AS supply_name, m.quantity_delta, m.movement_type, m.unit,
      m.stock_after, m.unit_cost, m.total_cost, m.unit_cost_after,
      m.reason, m.actor_user_id, u.name AS actor_name,
      m.reference_type, m.reference_id, m.created_at
    FROM supply_movements m
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    ${whereSql}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `)
    .all(...params, perPage + 1) as SupplyMovement[];

  const hasMore = rows.length > perPage;
  const movements = hasMore ? rows.slice(0, perPage) : rows;
  return {
    movements,
    nextCursor: hasMore ? movements[movements.length - 1].id : null,
  };
}
