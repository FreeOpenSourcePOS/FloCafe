/** The till says what it showed for the lines it sends; an order at another amount is refused. */
import type Database from 'better-sqlite3';
import Decimal from 'decimal.js';

export const PRICES_CHANGED = 'PRICES_CHANGED';

/**
 * Refuses the request when `expected`, the optional `expected_subtotal` of an order request,
 * differs by a cent or more from the sum of the line amounts the server worked out for the lines
 * of that request. Throwing rolls the route's transaction back, so nothing of the order stays.
 */
export function assertExpectedSubtotal(
  expected: unknown,
  lineSubtotals: number[],
  decimals: number,
): void {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    throw Object.assign(new Error('expected_subtotal must be a number'), { statusCode: 400 });
  }
  const charged = lineSubtotals.reduce((sum, line) => sum.plus(line), new Decimal(0));
  if (charged.minus(expected).abs().gte(new Decimal(10).pow(-decimals))) {
    throw Object.assign(new Error('Prices have changed. Check the order and place it again.'), {
      statusCode: 409,
      code: PRICES_CHANGED,
    });
  }
}

/** The stored line amounts of the order lines a request has just inserted. */
export function lineSubtotalsOf(db: Database.Database, itemIds: (number | bigint)[]): number[] {
  const find = db.prepare('SELECT subtotal FROM order_items WHERE id = ?');
  return itemIds.map((id) => (find.get(id) as { subtotal: number }).subtotal);
}
