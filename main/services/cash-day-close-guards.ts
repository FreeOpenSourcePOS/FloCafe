/**
 * Day-close guards and shared shift-close unpaid queries. Leaf module: no
 * route imports, so cash-closures and cash-sessions can both depend on it.
 */
import {
  getDatabase,
  getSettingValue,
  localDateInTimezone,
  parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../db';
import { getCurrencyMinorUnitFactor, resolveRegionalSnapshot } from '../countries';
import { getTenantCurrency } from './refund';
import { getOpenSession, type CashSessionRow } from './shift-session-gate';

function tenantTimezone(): string {
  return resolveRegionalSnapshot({
    country: getSettingValue('country') ?? undefined,
    currency: getSettingValue('currency') ?? undefined,
    timezone: getSettingValue('timezone') ?? undefined,
  }).timezone;
}

/** Tenant-local business date when the shift was opened. */
export function sessionBusinessDate(
  db: ReturnType<typeof getDatabase>,
  session: Pick<CashSessionRow, 'opened_at'>,
): string {
  return localDateInTimezone(
    parseDbTimestamp(session.opened_at),
    tenantTimezone(),
    tenantBusinessDayStartTime(db),
  );
}

/** Open shift that must close before day-close for `businessDate`, if any. */
export function openSessionBlockingDayClose(
  db: ReturnType<typeof getDatabase>,
  businessDate: string,
): CashSessionRow | undefined {
  const session = getOpenSession(db);
  if (!session) return undefined;
  if (sessionBusinessDate(db, session) > businessDate) return undefined;
  return session;
}

export interface ShiftUnpaidOrderSample {
  order_id: number;
  order_number: string;
  bill_id: number;
  bill_number: string;
  status: string;
  payment_status: string;
  total: number;
  balance: number;
  balance_cents: number;
  created_at: string;
}

export interface ShiftUnpaidInWindowSummary {
  count: number;
  bill_count: number;
  pending_cents: number;
  sample: ShiftUnpaidOrderSample[];
}

/**
 * Unpaid or partially-paid bills created during [openedAt, end] - informational
 * carry-over preview for shift close. Cancelled orders are excluded.
 */
export function shiftUnpaidBillsInWindow(
  db: ReturnType<typeof getDatabase>,
  openedAt: string,
  end: string,
): ShiftUnpaidInWindowSummary {
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  const row = db
    .prepare(
      `
    SELECT
      COUNT(*) AS bill_count,
      COALESCE(SUM(CAST(ROUND(COALESCE(b.balance, b.total, 0) * ?) AS INTEGER)), 0) AS pending_cents
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    WHERE b.payment_status NOT IN ('paid', 'refunded', 'partially_refunded')
      AND o.status != 'cancelled'
      AND COALESCE(b.balance, b.total, 0) > 0
      AND b.created_at >= ? AND b.created_at <= ?
  `,
    )
    .get(minorFactor, openedAt, end) as { bill_count: number; pending_cents: number };
  const sampleRows = db
    .prepare(
      `
    SELECT
      o.id AS order_id,
      o.order_number AS order_number,
      b.id AS bill_id,
      b.bill_number AS bill_number,
      o.status AS status,
      b.payment_status AS payment_status,
      COALESCE(b.total, 0) AS total,
      COALESCE(b.balance, b.total, 0) AS balance,
      CAST(ROUND(COALESCE(b.balance, b.total, 0) * ?) AS INTEGER) AS balance_cents,
      b.created_at AS created_at
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    WHERE b.payment_status NOT IN ('paid', 'refunded', 'partially_refunded')
      AND o.status != 'cancelled'
      AND COALESCE(b.balance, b.total, 0) > 0
      AND b.created_at >= ? AND b.created_at <= ?
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT 5
  `,
    )
    .all(minorFactor, openedAt, end) as ShiftUnpaidOrderSample[];
  const count = Number(row.bill_count || 0);
  return {
    count,
    bill_count: count,
    pending_cents: Number(row.pending_cents || 0),
    sample: sampleRows.map((item) => ({
      order_id: Number(item.order_id),
      order_number: String(item.order_number || ''),
      bill_id: Number(item.bill_id),
      bill_number: String(item.bill_number || ''),
      status: String(item.status || ''),
      payment_status: String(item.payment_status || ''),
      total: Number(item.total || 0),
      balance: Number(item.balance || 0),
      balance_cents: Number(item.balance_cents || 0),
      created_at: String(item.created_at || ''),
    })),
  };
}

export function findUnpaidInShiftOrders(
  db: ReturnType<typeof getDatabase>,
  session: Pick<CashSessionRow, 'opened_at'>,
  asOf: string,
): ShiftUnpaidInWindowSummary {
  return shiftUnpaidBillsInWindow(db, session.opened_at, asOf);
}
