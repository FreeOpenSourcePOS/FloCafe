/**
 * Cash drawer movement writes shared by the standalone cash-closures routes and
 * the expense payment ledger. One place owns the closed-day rule, so an expense
 * correction can never move money into a day the store already closed.
 *
 * Leaf module: route modules and services import from here, and nothing here
 * imports a route, so no require cycle exists. Callers open the transaction and
 * own their session gate — the standalone routes keep the configurable
 * `require_open_shift` behaviour, while expense cash entries require a real
 * open session unconditionally.
 */
import { getDatabase, now } from '../db';

type CashDrawerDb = ReturnType<typeof getDatabase>;

export type CashDrawerMovementType = 'opening_float' | 'pay_in' | 'pay_out' | 'safe_drop';

export const MAX_MOVEMENT_REASON_LENGTH = 500;

function movementError(message: string, statusCode: number, code: string | null = null): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/** A closed day refuses new drawer money even while a session is still open. */
export function closedDayExists(db: CashDrawerDb, businessDate: string): boolean {
  return !!db.prepare(
    `SELECT id FROM cash_closures WHERE business_date = ? AND scope = 'day' LIMIT 1`,
  ).get(businessDate);
}

export interface CashDrawerMovementInput {
  businessDate: string;
  movementType: CashDrawerMovementType;
  amountCents: number;
  reason: string | null;
  createdBy: string;
  cashSessionId: number;
}

/**
 * Inserts one drawer movement inside the caller's transaction. Amount and
 * session are validated by the caller; this owns the closed-day guard and the
 * shared reason bound.
 */
export function insertCashDrawerMovement(db: CashDrawerDb, input: CashDrawerMovementInput): number {
  if (closedDayExists(db, input.businessDate)) {
    throw movementError('This day is already closed', 409, 'day_closed');
  }
  if (input.reason !== null && input.reason.length > MAX_MOVEMENT_REASON_LENGTH) {
    throw movementError('reason is too long', 400);
  }
  const result = db.prepare(`
    INSERT INTO cash_drawer_movements (
      business_date, movement_type, amount_cents, reason, created_by, created_at, cash_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.businessDate,
    input.movementType,
    input.amountCents,
    input.reason,
    input.createdBy,
    now(),
    input.cashSessionId,
  );
  return Number(result.lastInsertRowid);
}
