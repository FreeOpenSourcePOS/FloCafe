import Decimal from 'decimal.js';
import { getDatabase, now } from '../db';

type Database = ReturnType<typeof getDatabase>;

export const ITEM_PRICE_OVERRIDE_PERMISSION = 'orders.item.price_override';
export const MAX_PRICE_OVERRIDE_REASON_LENGTH = 200;

export interface PriceOverrideInput {
  price: number;
  reason: string;
}

export interface PriceOverrideState {
  originalUnitPrice: number;
  reason: string;
  actorUserId: string;
  at: string;
}

/** Rounds a non-negative unit price to currency precision using half-up rounding. */
export function normalizeOverridePrice(price: number, decimals: number): number {
  return new Decimal(price).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

/** Validates a client override: a finite non-negative price (0 allowed) and a required reason. */
export function parsePriceOverrideInput(raw: unknown, decimals: number): PriceOverrideInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const price = typeof input.price === 'string' ? Number(input.price) : input.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    throw Object.assign(new Error('price must be a non-negative number'), { statusCode: 400 });
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0) {
    throw Object.assign(new Error('A reason is required for a price override'), {
      statusCode: 400,
    });
  }
  if (reason.length > MAX_PRICE_OVERRIDE_REASON_LENGTH) {
    throw Object.assign(
      new Error(`reason must be at most ${MAX_PRICE_OVERRIDE_REASON_LENGTH} characters`),
      { statusCode: 400 },
    );
  }
  return { price: normalizeOverridePrice(price, decimals), reason };
}

/** Flags an item as price-overridden, keeping the first menu price when overridden repeatedly. */
export function markItemPriceOverridden(
  db: Database,
  itemId: number | bigint | string,
  state: PriceOverrideState,
): void {
  db.prepare(
    `UPDATE order_items SET price_overridden = 1, original_unit_price = ?, price_override_reason = ?,
       price_overridden_by = ?, price_overridden_at = ? WHERE id = ?`,
  ).run(state.originalUnitPrice, state.reason, state.actorUserId, state.at, itemId);
}

/** Copies the override flag from a replaced line onto its same-product successor. */
export function carryPriceOverride(
  db: Database,
  fromItemId: number | bigint | string,
  toItemId: number | bigint | string,
): void {
  db.prepare(
    `UPDATE order_items SET
       price_overridden = (SELECT price_overridden FROM order_items WHERE id = ?),
       original_unit_price = (SELECT original_unit_price FROM order_items WHERE id = ?),
       price_override_reason = (SELECT price_override_reason FROM order_items WHERE id = ?),
       price_overridden_by = (SELECT price_overridden_by FROM order_items WHERE id = ?),
       price_overridden_at = (SELECT price_overridden_at FROM order_items WHERE id = ?)
     WHERE id = ?`,
  ).run(fromItemId, fromItemId, fromItemId, fromItemId, fromItemId, toItemId);
}

export interface PriceExceptionRow {
  order_id: number;
  order_number: string;
  item_id: number;
  product_name: string;
  quantity: number;
  original_unit_price: number;
  billed_unit_price: number;
  difference: number;
  reason: string | null;
  changed_by_id: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/** Overridden, non-cancelled lines whose override time falls in [fromIso, toIso). */
export function listPriceExceptions(
  db: Database,
  fromIso: string,
  toIso: string,
): PriceExceptionRow[] {
  return db
    .prepare(
      `SELECT oi.order_id AS order_id, o.order_number AS order_number, oi.id AS item_id,
              oi.product_name AS product_name, oi.quantity AS quantity,
              COALESCE(oi.original_unit_price, oi.unit_price) AS original_unit_price,
              oi.unit_price AS billed_unit_price,
              oi.unit_price - COALESCE(oi.original_unit_price, oi.unit_price) AS difference,
              oi.price_override_reason AS reason,
              oi.price_overridden_by AS changed_by_id, u.name AS changed_by_name,
              oi.price_overridden_at AS changed_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN users u ON u.id = oi.price_overridden_by
       WHERE oi.price_overridden = 1
         AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
         AND oi.price_overridden_at >= ? AND oi.price_overridden_at < ?
       ORDER BY oi.price_overridden_at ASC, oi.id ASC`,
    )
    .all(fromIso, toIso) as PriceExceptionRow[];
}

export interface ShiftWindow {
  id: number;
  opened_by_name: string;
  opened_at: string;
  closed_at: string | null;
}

export function listShiftsOverlapping(db: Database, fromIso: string, toIso: string): ShiftWindow[] {
  return db
    .prepare(
      `SELECT id, opened_by_name, opened_at, closed_at
       FROM cash_sessions
       WHERE opened_at < ? AND COALESCE(closed_at, ?) >= ?
       ORDER BY opened_at DESC, id DESC
       LIMIT 20`,
    )
    .all(toIso, toIso, fromIso) as ShiftWindow[];
}

export function getShiftWindow(db: Database, id: number): ShiftWindow | undefined {
  return db
    .prepare('SELECT id, opened_by_name, opened_at, closed_at FROM cash_sessions WHERE id = ?')
    .get(id) as ShiftWindow | undefined;
}

export { now };
