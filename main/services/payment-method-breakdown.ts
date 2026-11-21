import { dayBoundsInTimezone, getDatabase, tenantBusinessDayStartTime } from '../db';
import { getCurrencyMinorUnitFactor } from '../countries';
import { tenantTimezone } from './cash-drawer-movements';
import { getTenantCurrency } from './refund';

export interface PaymentMethodRow {
  method: string;
  count: number;
  total: number;
}

/**
 * Shared by reports (financial-summary, summary, sales, daily-stats, daily-sales-export)
 * and cash-closure snapshots; boolean flags default to false.
 *
 * `keyByPaidAt` is true only for the day-close snapshot: a bill paid in
 * installments carries one `timestamp` per payment line, so keying lines
 * by their own timestamp would scatter one bill's cash across several
 * business days while gross/staff/tax (all keyed by `b.paid_at`) land on
 * the settlement day. Keying by `paid_at` keeps every Z section on the
 * same day so the immutable snapshot reconciles with itself. Live reports
 * keep the default: a partial payment belongs to the day it was taken.
 */
export interface PaymentMethodBreakdownOptions {
  /** Day-based calls: tenant-local business date(s). Ignored when explicitWindow is set. */
  startDate?: string;
  endDate?: string;
  paidOnly?: boolean;
  excludeCancelledOrders?: boolean;
  attributeRefundsToBillDate?: boolean;
  keyByPaidAt?: boolean;
  /** Raw timestamp window for session attribution (#279). */
  explicitWindow?: [string, string];
}

export function paymentMethodBreakdown(
  db: ReturnType<typeof getDatabase>,
  opts: PaymentMethodBreakdownOptions,
): PaymentMethodRow[] {
  const {
    startDate = '',
    endDate,
    paidOnly = false,
    excludeCancelledOrders = false,
    attributeRefundsToBillDate = false,
    keyByPaidAt = false,
    explicitWindow,
  } = opts;
  if (!explicitWindow && !startDate) {
    throw new Error('paymentMethodBreakdown requires startDate or explicitWindow');
  }
  const resolvedEndDate = endDate ?? startDate;
  const startTime = tenantBusinessDayStartTime(db);
  const [start, end] = explicitWindow ?? [
    dayBoundsInTimezone(startDate, tenantTimezone(), startTime)[0],
    dayBoundsInTimezone(resolvedEndDate, tenantTimezone(), startTime)[1],
  ];
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  return db
    .prepare(
      `
    WITH payment_lines AS (
      SELECT b.paid_at, b.created_at, je.value AS line
      FROM bills b
      LEFT JOIN orders o ON o.id = b.order_id
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
          THEN b.payment_details
        WHEN json_valid(b.payment_details)
          THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.payment_details IS NOT NULL
        AND b.created_at < ?
        AND (b.paid_at IS NULL OR b.paid_at >= ?)
        AND (? = 0 OR b.paid_at IS NOT NULL)
        AND (? = 0 OR COALESCE(o.status, '') != 'cancelled')
        AND json_type(je.value) = 'object'
    ), normalized AS (
      SELECT
        COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
        CAST(json_extract(line, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(CASE WHEN ? = 1 THEN NULL ELSE json_extract(line, '$.timestamp') END, '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
      UNION ALL
      SELECT r.method, NULL, -(CAST(r.amount_cents AS REAL) / ?),
        datetime(CASE WHEN ? = 1 THEN b.paid_at ELSE r.created_at END)
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
      LEFT JOIN orders o ON o.id = b.order_id
      WHERE (? = 0 OR COALESCE(o.status, '') != 'cancelled')
    )
    SELECT COALESCE(pm.name, normalized.method) AS method, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END), 0) AS total
    FROM normalized LEFT JOIN payment_methods pm ON pm.id = normalized.payment_method_id
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    GROUP BY COALESCE(pm.name, normalized.method)
    ORDER BY total DESC
  `,
    )
    .all(
      end,
      start,
      paidOnly ? 1 : 0,
      excludeCancelledOrders ? 1 : 0,
      keyByPaidAt ? 1 : 0,
      minorFactor,
      attributeRefundsToBillDate ? 1 : 0,
      excludeCancelledOrders ? 1 : 0,
      start,
      end,
    ) as PaymentMethodRow[];
}
