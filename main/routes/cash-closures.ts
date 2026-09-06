/**
 * Day-close (cierre de caja, issue #649).
 *
 * One close per store per tenant-local day. POST /api/cash-closures:
 *  - Owner-only (manager/cashier/server are 403).
 *  - Validates: YYYY-MM-DD format, not in the future, integer cents >= 0.
 *  - Recomputes the day's aggregates server-side (never trusts client totals)
 *    using the verbatim financial-summary template (main/routes/reports.ts)
 *    for display totals, plus two spec-mandated drawer-reality deviations:
 *      * `expected_cash_cents`: raw pre-join `method = 'cash'` filter; refunds
 *        by `refunds.created_at` (the day the cash left the drawer, not the
 *        day the original bill was paid).
 *      * `tax_components_json`: aggregated via `aggregateTaxComponents`
 *        against the spec's DisplayTaxComponent[] shape, so Z rows carry the
 *        same tax components the live report endpoint returns.
 *  - Snapshots the result with the operator's counted cash and stores one
 *    immutable row in `cash_closures`. Duplicate POST against the same
 *    `business_date` (scope='day') is rejected with 409 via SELECT-then-INSERT
 *    inside `withTxn`; the partial index `cash_closures_one_day` is the
 *    concurrency safety net.
 *
 * Sales flow is deliberately untouched: `createRefund`, `shift_id`, and
 * `refunds.shift_id` are unchanged — the drawer-reality attribution
 * (cash refunds by `refunds.created_at`) is read straight from the existing
 * `refunds` table without backfilling any column. The `scope='session'`
 * extension door is intentionally unused by this endpoint; session-style
 * closes arrive as separate rows with a different `scope` value.
 */
import { Router, Request, Response } from 'express';
import {
  dayBoundsInTimezone, getDatabase, getSettingValue, localDateInTimezone, now, withTxn,
} from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { nextZNumber } from '../db';
import { getTenantCurrency } from '../services/refund';
import { getCurrencyMinorUnitFactor } from '../countries';
import { getOrdersWithItemsForBills } from './bills';
import { getHttpRequestSignal } from '../shutdown';
import { tenantLanguage as resolveTenantLanguage } from './printers';
import {
  DisplayTaxComponent,
  aggregateTaxComponents,
} from '../services/tax-components';

const router = Router();
const MAX_NOTES_LENGTH = 500;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

function validateBusinessDate(raw: unknown): string {
  if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) {
    throw httpError('business_date must use YYYY-MM-DD format', 400);
  }
  // Real-calendar-date guard: `Date.UTC(2026, 1, 30)` silently rolls over
  // into March, so a regex match is not enough. Round-trip the parsed
  // year/month/day and confirm the calendar matches the input.
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    throw httpError('business_date is not a real calendar date', 400);
  }
  // Tenant-local today, not the host UTC clock: a date that is "today" in
  // the store's configured timezone must never be rejected as future even
  // when the host's UTC clock is still on yesterday. ISO date arithmetic on
  // the YYYY-MM-DD string is timezone-safe.
  const todayLocal = localDateInTimezone(new Date(), tenantTimezone());
  if (raw > todayLocal) {
    throw httpError('business_date cannot be in the future', 400);
  }
  return raw;
}

function validateCents(raw: unknown, field: string, allowZero = true): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw httpError(`${field} must be an integer`, 400);
  }
  if (raw < 0 || (!allowZero && raw === 0)) {
    throw httpError(`${field} must be >= ${allowZero ? 0 : 1}`, 400);
  }
  if (!Number.isSafeInteger(raw)) {
    throw httpError(`${field} is out of range`, 400);
  }
  return raw;
}

interface PaymentMethodRow {
  method: string;
  count: number;
  total: number;
}

interface StaffSalesRow {
  user_id: string;
  name: string;
  role: string;
  revenue: number;
  orderCount: number;
}

export interface DayAggregates {
  billCount: number;
  refundCount: number;
  grossCollectedCents: number;
  refundedCents: number;
  netCollectedCents: number;
  cashSalesCents: number;
  cashRefundsByCreatedAtCents: number;
  paymentMethods: { method: string; count: number; total_cents: number }[];
  staffSales: { user_id: string; name: string; role: string; revenue_cents: number; orderCount: number }[];
  taxComponents: DisplayTaxComponent[];
}

/**
 * Shared by financial-summary (reports.ts, called with paidOnly/attributeRefundsToBillDate=true)
 * and cash-closure snapshots; defaults false/false.
 */
export function paymentMethodBreakdown(
  db: ReturnType<typeof getDatabase>,
  startDate: string,
  endDate: string = startDate,
  paidOnly: boolean = false,
  attributeRefundsToBillDate: boolean = false,
): PaymentMethodRow[] {
  const [start] = dayBoundsInTimezone(startDate, tenantTimezone());
  const [, end] = dayBoundsInTimezone(endDate, tenantTimezone());
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  return db.prepare(`
    WITH payment_lines AS (
      SELECT b.paid_at, b.created_at, je.value AS line
      FROM bills b
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
        AND json_type(je.value) = 'object'
    ), normalized AS (
      SELECT
        COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
        CAST(json_extract(line, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(json_extract(line, '$.timestamp'), '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
      UNION ALL
      SELECT r.method, NULL, -(CAST(r.amount_cents AS REAL) / ?),
        datetime(CASE WHEN ? = 1 THEN b.paid_at ELSE r.created_at END)
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
    )
    SELECT COALESCE(pm.name, normalized.method) AS method, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END), 0) AS total
    FROM normalized LEFT JOIN payment_methods pm ON pm.id = normalized.payment_method_id
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    GROUP BY COALESCE(pm.name, normalized.method)
    ORDER BY total DESC
  `).all(end, start, paidOnly ? 1 : 0, minorFactor, attributeRefundsToBillDate ? 1 : 0, start, end) as PaymentMethodRow[];
}

/**
 * Recompute every snapshot field for one tenant-local business_date.
 *
 * Display totals deliberately include cancelled-order bills: a paid bill's
 * cash already left the drawer and remains there until counted, regardless
 * of the order's later status. `financial-summary` does not apply a
 * cancelled-order filter either — this snapshot matches its display
 * totals by construction. The two spec-mandated drawer-reality deviations
 * (`expected_cash_cents` cash-only raw filter and refunds-by-created_at)
 * are applied separately so the rest of the snapshot reconciles with
 * financial-summary.
 *
 * Exported so Wave 3 (the live X-report) can reuse this pipeline without
 * duplicating the template or the tax-components hydration. Returns a
 * plain `DayAggregates` shape already converted to INTEGER minor units.
 */
export function computeDayAggregates(db: ReturnType<typeof getDatabase>, businessDate: string): DayAggregates {
  const [start, end] = dayBoundsInTimezone(businessDate, tenantTimezone());

  // Display gross — `SUM(paid_amount)` over the paid_at day window (NOT
  // SUM(total) over created_at). This matches financial-summary so display
  // totals reconcile with the existing report endpoint for the same day.
  const billRow = db.prepare(`
    SELECT
      COUNT(*) AS bill_count,
      COALESCE(SUM(b.paid_amount), 0) AS gross_collected
    FROM bills b
    WHERE b.paid_at >= ? AND b.paid_at < ?
  `).get(start, end) as { bill_count: number; gross_collected: number };

  // Display refunds — paid_at attribution, same as financial-summary.
  // Stored as INTEGER cents to match the `refunded_cents` column type and the
  // schema convention (`bills.paid_amount`, `refunds.amount_cents`). Display
  // / response-edge conversion happens only at the { zReport } boundary, never
  // in storage or in the storage-time net subtraction.
  const refundRow = db.prepare(`
    SELECT
      COUNT(*) AS refund_count,
      COALESCE(SUM(r.amount_cents), 0) AS refunded_cents
    FROM refunds r
    JOIN bills b ON b.id = r.bill_id
    WHERE b.paid_at >= ? AND b.paid_at < ?
  `).get(start, end) as { refund_count: number; refunded_cents: number };

  // cash sales (drawer-reality side of the split): raw pre-join `method='cash'`
  // filter, paid_at window, no `payment_methods` name join. Reads amount via
  // json_extract on the line object (the same scalar format used elsewhere).
  // Cash refunds by `created_at` (drawer reality: cash left the drawer on
  // the day the refund was issued, not the day the original bill was paid).
  // `minorFactor` is bound as a SQL parameter (matching the refund CTE
  // pattern immediately below) so non-100 currencies (KWD factor 1000,
  // JPY factor 1) round-trip exactly.
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  const cashDrawerRow = db.prepare(`
    WITH cash_sales AS (
      SELECT COALESCE(SUM(CAST(json_extract(je.value, '$.amount') AS REAL) * ?), 0) AS sales_cents
      FROM bills b
      JOIN json_each(
        CASE
          WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
            THEN b.payment_details
          WHEN json_valid(b.payment_details)
            THEN json_array(b.payment_details)
          ELSE '[]'
        END
      ) je
      WHERE b.paid_at >= ? AND b.paid_at < ?
        AND json_type(je.value) = 'object'
        AND COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), '') = 'cash'
    ), cash_refunds AS (
      SELECT COALESCE(SUM(amount_cents), 0) AS refunds_cents
      FROM refunds
      WHERE method = 'cash'
        AND created_at >= ? AND created_at < ?
    )
    SELECT
      (SELECT sales_cents FROM cash_sales) AS sales_cents,
      (SELECT refunds_cents FROM cash_refunds) AS refunds_cents
  `).get(minorFactor, start, end, start, end) as { sales_cents: number; refunds_cents: number };

  // Display payment-method totals — reuse paymentMethodBreakdown so display
  // numbers reconcile with the live financial-summary endpoint for the same day.
  const paymentMethodsRows = paymentMethodBreakdown(db, businessDate, businessDate, true, true);

  // Per-staff sales — same window as the bill count, keyed by paid_at so a
  // cross-midnight bill (created day-1, paid day-2) rolls into day-2's Z
  // (matches the gross/payment/expected windows above; cancels the prior
  // creation-time key, which produced a non-reconciling Z with respect to
  // the rest of the snapshot). Unpaid orders drop out: uncollected money
  // is not staff revenue for the day it was created.
  const staffSalesRows = db.prepare(`
    SELECT u.id AS user_id, u.name AS name, u.role AS role,
      COALESCE(SUM(b.paid_amount), 0) AS revenue,
      COUNT(b.id) AS orderCount
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    JOIN users u ON u.id = o.user_id
    WHERE b.paid_at >= ? AND b.paid_at < ?
    GROUP BY u.id
    ORDER BY revenue DESC
    LIMIT 20
  `).all(start, end) as StaffSalesRow[];

  // Tax components — keyed by paid_at window to stay reconciled with the
  // rest of the Z. Bills are hydrated with their order items and then
  // aggregated via the existing `aggregateTaxComponents` pipeline, unchanged.
  // Unpaid bills drop out by the same logic as the staff query above.
  const bills = db.prepare(`
    SELECT b.*
    FROM bills b
    WHERE b.paid_at >= ? AND b.paid_at < ?
    ORDER BY b.paid_at, b.id
  `).all(start, end) as any[];
  const orders = getOrdersWithItemsForBills(db, bills);
  const taxDocuments = bills.map((bill) => ({
    tax_amount: bill.tax_amount,
    tax_snapshot: bill.tax_snapshot,
    tax_breakdown: bill.tax_breakdown,
    items: orders.get(Number(bill.id))?.items || [],
  }));
  const taxComponents = aggregateTaxComponents(taxDocuments);

  const grossCollectedCents = Math.round(Number(billRow.gross_collected || 0) * minorFactor);
  const refundedCents = Number(refundRow.refunded_cents || 0);

  return {
    billCount: Number(billRow.bill_count || 0),
    refundCount: Number(refundRow.refund_count || 0),
    grossCollectedCents,
    refundedCents,
    netCollectedCents: grossCollectedCents - refundedCents,
    cashSalesCents: Math.round(Number(cashDrawerRow.sales_cents || 0)),
    cashRefundsByCreatedAtCents: Number(cashDrawerRow.refunds_cents || 0),
    paymentMethods: paymentMethodsRows.map((row) => ({
      method: row.method,
      count: Number(row.count || 0),
      total_cents: Math.round(Number(row.total || 0) * minorFactor),
    })),
    staffSales: staffSalesRows.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      role: row.role,
      revenue_cents: Math.round(Number(row.revenue || 0) * minorFactor),
      orderCount: Number(row.orderCount || 0),
    })),
    taxComponents,
  };
}

router.post('/', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const businessDate = validateBusinessDate(body.business_date);
    const openingFloatCents = validateCents(body.opening_float_cents, 'opening_float_cents');
    const countedCashCents = validateCents(body.counted_cash_cents, 'counted_cash_cents');
    if (typeof body.notes === 'string' && body.notes.length > MAX_NOTES_LENGTH) {
      throw httpError('notes is too long', 400);
    }
    const notes = typeof body.notes === 'string' ? body.notes : null;
    const closedBy = String((req as any).user?.userId || '');
    if (!closedBy) throw httpError('Authentication required', 401);

    const db = getDatabase();
    const [periodStart, periodEnd] = dayBoundsInTimezone(businessDate, tenantTimezone());

    // SELECT-then-INSERT inside withTxn matches the customers.ts uniqueness
    // pattern; the partial index `cash_closures_one_day ... WHERE scope='day'`
    // is the concurrency safety net (a concurrent winner sees 409 here, a
    // race that slips past SELECT hits SQLITE_CONSTRAINT, mapped below).
    const result = withTxn(() => {
      const existing = db.prepare(
        `SELECT id FROM cash_closures WHERE business_date = ? AND scope = 'day' LIMIT 1`
      ).get(businessDate);
      if (existing) {
        throw httpError('This day is already closed', 409);
      }

      const aggregates = computeDayAggregates(db, businessDate);

      // Snapshot math (verbatim from spec):
      // expected = opening_float + cashSales − cashRefunds(created_at)
      // variance = counted − expected
      const expectedCashCents = openingFloatCents
        + aggregates.cashSalesCents
        - aggregates.cashRefundsByCreatedAtCents;
      const varianceCents = countedCashCents - expectedCashCents;

      let zNumber: number;
      try {
        zNumber = nextZNumber();
      } catch (err: any) {
        throw httpError(`Could not allocate Z number: ${err?.message || 'sequence failure'}`, 500);
      }

      const createdAt = now();
      try {
        db.prepare(`
          INSERT INTO cash_closures (
            scope, business_date, period_start, period_end,
            opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents,
            gross_collected_cents, refunded_cents, net_collected_cents,
            bill_count, refund_count,
            payment_methods_json, staff_sales_json, tax_components_json,
            z_number, closed_by, notes, created_at
          ) VALUES (
            'day', ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?
          )
        `).run(
          businessDate, periodStart, periodEnd,
          openingFloatCents, expectedCashCents, countedCashCents, varianceCents,
          aggregates.grossCollectedCents, aggregates.refundedCents, aggregates.netCollectedCents,
          aggregates.billCount, aggregates.refundCount,
          JSON.stringify(aggregates.paymentMethods),
          JSON.stringify(aggregates.staffSales),
          JSON.stringify(aggregates.taxComponents),
          zNumber, closedBy, notes, createdAt,
        );
      } catch (err: any) {
        // Race: another writer slipped through between the SELECT and this
        // INSERT — the partial index turns this into a clean 409.
        const msg = String(err?.message || '');
        if (msg.includes('UNIQUE') || msg.includes('cash_closures_one_day')) {
          throw httpError('This day is already closed', 409);
        }
        throw err;
      }

      const id = Number((db.prepare(
        `SELECT id FROM cash_closures WHERE business_date = ? AND scope = 'day'`
      ).get(businessDate) as { id: number }).id);

      return {
        id,
        scope: 'day',
        business_date: businessDate,
        period_start: periodStart,
        period_end: periodEnd,
        opening_float_cents: openingFloatCents,
        expected_cash_cents: expectedCashCents,
        counted_cash_cents: countedCashCents,
        variance_cents: varianceCents,
        gross_collected_cents: aggregates.grossCollectedCents,
        refunded_cents: aggregates.refundedCents,
        net_collected_cents: aggregates.netCollectedCents,
        bill_count: aggregates.billCount,
        refund_count: aggregates.refundCount,
        payment_methods: aggregates.paymentMethods,
        staff_sales: aggregates.staffSales,
        tax_components: aggregates.taxComponents,
        z_number: zNumber,
        closed_by: closedBy,
        notes,
        created_at: createdAt,
      };
    });

    res.status(201).json({ zReport: result });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('[CashClosures] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message || 'Internal server error' });
  }
});

export { router as cashClosureRoutes };

// ── POST /:id/print — dispatch the stored Z to the default printer ──────────
// Owner-only. The forced drawer pulse is appended by `printZReport` itself
// (bypassing bill-bound `shouldPulseForPayment`, spec #649). WebUSB printers
// return `{ bytes: number[] }` for the frontend to dispatch; network/usb
// printers go through the backend socket. The Z row is never mutated.
router.post('/:id/print', requireRole(...ROLE_ACCESS.owner), async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const row = db.prepare(`SELECT * FROM cash_closures WHERE id = ?`).get(id) as any;
    if (!row) return res.status(404).json({ error: 'Cash closure not found' });
    const isReprint = req.body && req.body.isReprint === true;
    // F6: resolve the operator's display name via users(id → name) so the
    // printed Z shows the operator (not the raw user id). Falls back to the
    // id string when the user row is missing (e.g. historical data after a
    // staff deletion).
    const userRow = db.prepare(`SELECT name FROM users WHERE id = ?`).get(row.closed_by) as { name: string } | undefined;
    // Shape the snapshot for the body builder; the route carries the reprint
    // marker as a synthetic field the print primitive recognizes.
    const snapshot = {
      ...row,
      closed_by_name: userRow?.name ?? row.closed_by,
      payment_methods: JSON.parse(row.payment_methods_json || '[]'),
      staff_sales: JSON.parse(row.staff_sales_json || '[]'),
      tax_components: JSON.parse(row.tax_components_json || '[]'),
      __isReprint: isReprint,
    };
    // Resolve the default receipt printer server-side so the WebUSB branch
    // is reachable end-to-end (mirrors `main/routes/printers.ts:304-339`,
    // bytes branch `:329-331`). `getPrinterConfig()` inside the helper
    // excludes webusb; selecting it here closes that gap.
    const printer = db.prepare(`SELECT * FROM printers WHERE is_default = 1`).get() as any;
    if (!printer) return res.status(409).json({ error: 'No default printer configured' });
    const { printZReport } = require('../printers/thermal');
    // F7: thread request signal through so a server shutdown aborts the
    // print job (pattern at `main/routes/printers.ts:119,323`).
    // `tenantLanguage` resolves the receipt-language bundle id; the body is
    // built with English literals, so the language argument is currently
    // reserved/unused on this path (the value flows into a `buildEscPos`
    // option that this document does not read). Shaping and code-page
    // selection come from the printer-profile capabilities, not from this
    // argument.
    const result = await printZReport(snapshot, resolveTenantLanguage(db), getHttpRequestSignal(req), printer);
    if (printer.connection_type === 'webusb' && result?.bytes) {
      // Return the FULL bytes including the forced drawer pulse; the renderer
      // dispatches them over WebUSB exactly as the test-page endpoint does.
      return res.json({ success: true, webusb: true, isReprint, bytes: Array.from(result.bytes) });
    }
    if (!result.ok) {
      return res.status(502).json({ error: result.detail || 'Printer did not respond or print failed', detail: result.detail });
    }
    res.json({ success: true, isReprint });
  } catch (error: any) {
    console.error('[CashClosures] Print error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
