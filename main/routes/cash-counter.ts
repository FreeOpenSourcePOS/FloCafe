import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { dayBoundsInTimezone, getDatabase, getSettingValue, localDateInTimezone, now, parseDbTimestamp, utcTodayDate } from '../db';
import { getCurrencyMinorUnitFactor } from '../countries';
import { getTenantCurrency } from '../services/refund';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  monthBounds,
  normalizeBusinessDate,
  normalizeNote,
  roundMoney,
} from './finance-shared';

function normalizeNonNegativeAmount(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative number`), { statusCode: 400 });
  }
  return roundMoney(amount);
}

const router = Router();
const cashCounterWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

// Store timezone for day boundaries (reports and the Z day-close read the same setting).
function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

/** Every YYYY-MM-DD date from `from` to `to`, inclusive. */
function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

type CashOrderPaymentLine = { bill_id: number; bill_number: string; amount: number; payment_time: string };

/**
 * Cash payment lines for bills paid inside a store-timezone day window.
 * Same drawer-reality rule as the Z day-close (main/routes/cash-closures.ts):
 * lines are keyed by the bill's paid_at, not per-line timestamps, so an
 * installment lands on the settlement day; unpaid bills have no paid_at
 * and drop out on their own, no payment_status filter needed. Returns
 * row-level lines (the Z only aggregates) for the daily breakdown.
 */
function cashOrderPaymentLines(db: ReturnType<typeof getDatabase>, start: string, end: string): CashOrderPaymentLine[] {
  return db.prepare(`
    SELECT b.id AS bill_id, b.bill_number,
      CASE WHEN typeof(json_extract(je.value, '$.amount')) IN ('integer', 'real')
        THEN json_extract(je.value, '$.amount') ELSE 0 END AS amount,
      b.paid_at AS payment_time
    FROM bills b
    JOIN json_each(CASE
      WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
        THEN b.payment_details
      WHEN json_valid(b.payment_details)
        THEN json_array(b.payment_details)
      ELSE '[]'
    END) je
    WHERE b.paid_at >= ? AND b.paid_at < ?
      AND json_type(je.value) = 'object'
      AND COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), 'unknown') = 'cash'
    ORDER BY b.paid_at DESC, b.id DESC
  `).all(start, end) as CashOrderPaymentLine[];
}

// Cash that left the drawer as refunds, by the day the refund was issued
// (refunds.created_at) — same as the Z day-close. Stored in minor units,
// converted at the boundary like every other major-unit figure here.
function cashRefundsTotal(db: ReturnType<typeof getDatabase>, start: string, end: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM refunds
    WHERE method = 'cash' AND created_at >= ? AND created_at < ?
  `).get(start, end) as { cents: number };
  const factor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  return roundMoney(row.cents / factor);
}

// Same totals as cashRefundsTotal but bucketed per store-local day, mirroring
// how the monthly handler buckets order lines below: one range query, then
// group in JS on the store-local calendar date.
function cashRefundsByDate(db: ReturnType<typeof getDatabase>, start: string, end: string, timezone: string): Map<string, number> {
  const factor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  const rows = db.prepare(`
    SELECT created_at, amount_cents AS cents FROM refunds
    WHERE method = 'cash' AND created_at >= ? AND created_at < ?
  `).all(start, end) as { created_at: string; cents: number }[];
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const day = localDateInTimezone(parseDbTimestamp(row.created_at), timezone);
    byDate.set(day, roundMoney((byDate.get(day) || 0) + row.cents / factor));
  }
  return byDate;
}

function listCashExpensePayments(db: ReturnType<typeof getDatabase>, date: string) {
  return db.prepare(`
    SELECT t.*, t.payment_date AS date, ec.name AS category_name, u.name AS created_by_name
    FROM expense_due_payments t
    JOIN expense_categories ec ON ec.id = t.category_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.method = 'cash' AND t.payment_date = ?
    ORDER BY t.created_at DESC, t.id DESC
  `).all(date);
}

function cashExpenseTotalsByDate(db: ReturnType<typeof getDatabase>, from: string, to: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT payment_date AS date, COALESCE(SUM(amount), 0) AS total
    FROM expense_due_payments
    WHERE method = 'cash' AND payment_date >= ? AND payment_date <= ?
    GROUP BY payment_date
  `).all(from, to) as { date: string; total: number }[];
  return new Map(rows.map((row) => [row.date, row.total]));
}

function openingFloatsByDate(db: ReturnType<typeof getDatabase>, from: string, to: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT date, amount FROM cash_opening_floats WHERE date >= ? AND date <= ?
  `).all(from, to) as { date: string; amount: number }[];
  return new Map(rows.map((row) => [row.date, row.amount]));
}

/** Latest count per day, via a window function — one guaranteed-correct row per date, ranked by created_at/id. */
function latestCountsByDate(db: ReturnType<typeof getDatabase>, from: string, to: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT date, counted_amount FROM (
      SELECT date, counted_amount,
        ROW_NUMBER() OVER (PARTITION BY date ORDER BY created_at DESC, id DESC) AS rn
      FROM cash_count_records
      WHERE date >= ? AND date <= ?
    ) WHERE rn = 1
  `).all(from, to) as { date: string; counted_amount: number }[];
  return new Map(rows.map((row) => [row.date, row.counted_amount]));
}

function expectedCash(opening: number, orders: number, refunds: number, expenses: number): number {
  return roundMoney(opening + orders - refunds - expenses);
}

router.get('/daily', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const date = normalizeBusinessDate(req.query.date);
    const db = getDatabase();
    const [start, end] = dayBoundsInTimezone(date, tenantTimezone());

    const openingFloat = db.prepare(`
      SELECT f.*, u.name AS created_by_name
      FROM cash_opening_floats f
      LEFT JOIN users u ON u.id = f.created_by
      WHERE f.date = ?
    `).get(date) as any;

    const orderLines = cashOrderPaymentLines(db, start, end);
    const orderTotal = roundMoney(orderLines.reduce((sum, line) => sum + line.amount, 0));

    const refundTotal = cashRefundsTotal(db, start, end);

    const expensePayments = listCashExpensePayments(db, date) as any[];
    const expenseTotal = roundMoney(expensePayments.reduce((sum, row) => sum + row.amount, 0));

    const openingAmount = openingFloat?.amount ?? 0;
    const expected = expectedCash(openingAmount, orderTotal, refundTotal, expenseTotal);

    const counts = db.prepare(`
      SELECT c.*, u.name AS created_by_name
      FROM cash_count_records c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.date = ?
      ORDER BY c.created_at DESC, c.id DESC
    `).all(date) as any[];
    const latestCount = counts[0] ?? null;
    const variance = latestCount ? roundMoney(latestCount.counted_amount - expected) : null;

    res.json({
      date,
      opening_float: openingFloat || null,
      cash_from_orders: { total: orderTotal, payments: orderLines },
      cash_refunds: { total: refundTotal },
      cash_expenses: { total: expenseTotal, payments: expensePayments },
      expected_cash: expected,
      counts,
      latest_count: latestCount,
      variance,
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to load the daily cash counter' });
  }
});

router.post('/opening-float', cashCounterWriteRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const date = normalizeBusinessDate(req.body?.date);
    const amount = normalizeNonNegativeAmount(req.body?.amount, 'amount');
    const note = normalizeNote(req.body?.note);
    const db = getDatabase();
    const result = db.prepare(`
      INSERT INTO cash_opening_floats (date, amount, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, amount, note, (req as any).user.userId, now());
    const opening_float = db.prepare(`
      SELECT f.*, u.name AS created_by_name FROM cash_opening_floats f LEFT JOIN users u ON u.id = f.created_by WHERE f.id = ?
    `).get(result.lastInsertRowid);
    res.status(201).json({ opening_float });
  } catch (error: any) {
    const duplicate = String(error.message || '').includes('UNIQUE constraint');
    res.status(duplicate ? 409 : error.statusCode || 500).json({ error: duplicate ? 'An opening float is already set for this date' : error.message || 'Unable to set the opening float' });
  }
});

router.post('/count', cashCounterWriteRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const date = normalizeBusinessDate(req.body?.date);
    const counted_amount = normalizeNonNegativeAmount(req.body?.counted_amount, 'counted_amount');
    const note = normalizeNote(req.body?.note);
    const db = getDatabase();
    const result = db.prepare(`
      INSERT INTO cash_count_records (date, counted_amount, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, counted_amount, note, (req as any).user.userId, now());
    const count = db.prepare(`
      SELECT c.*, u.name AS created_by_name FROM cash_count_records c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?
    `).get(result.lastInsertRowid);
    res.status(201).json({ count });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to record the cash count' });
  }
});

router.get('/monthly', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : utcTodayDate().slice(0, 7);
    const [from, to] = monthBounds(month);
    const db = getDatabase();
    const timezone = tenantTimezone();

    const [rangeStart] = dayBoundsInTimezone(from, timezone);
    const [, rangeEnd] = dayBoundsInTimezone(to, timezone);
    const orderLines = cashOrderPaymentLines(db, rangeStart, rangeEnd);
    const ordersByDate = new Map<string, number>();
    for (const line of orderLines) {
      // paid_at is UTC; the window above is store-local, so bucket by the
      // store-local calendar date, not the UTC date prefix.
      const day = localDateInTimezone(parseDbTimestamp(line.payment_time), timezone);
      ordersByDate.set(day, roundMoney((ordersByDate.get(day) || 0) + line.amount));
    }

    const expensesByDate = cashExpenseTotalsByDate(db, from, to);
    const refundsByDate = cashRefundsByDate(db, rangeStart, rangeEnd, timezone);
    const openingByDate = openingFloatsByDate(db, from, to);
    const latestCountByDate = latestCountsByDate(db, from, to);

    let totalOpeningFloats = 0;
    let totalCashFromOrders = 0;
    let totalCashRefunds = 0;
    let totalCashExpenses = 0;

    const days = datesInRange(from, to).map((date) => {
      const opening = openingByDate.get(date) || 0;
      const orders = ordersByDate.get(date) || 0;
      const refunds = refundsByDate.get(date) || 0;
      const expenses = expensesByDate.get(date) || 0;
      const expected = expectedCash(opening, orders, refunds, expenses);
      const latestCount = latestCountByDate.get(date) ?? null;
      const variance = latestCount !== null ? roundMoney(latestCount - expected) : null;

      totalOpeningFloats = roundMoney(totalOpeningFloats + opening);
      totalCashFromOrders = roundMoney(totalCashFromOrders + orders);
      totalCashRefunds = roundMoney(totalCashRefunds + refunds);
      totalCashExpenses = roundMoney(totalCashExpenses + expenses);

      return {
        date,
        opening_float: opening,
        cash_from_orders: orders,
        cash_refunds: refunds,
        cash_expenses: expenses,
        expected_cash: expected,
        latest_count: latestCount,
        variance,
      };
    });

    res.json({
      month,
      from,
      to,
      days,
      totals: {
        total_opening_floats: totalOpeningFloats,
        total_cash_from_orders: totalCashFromOrders,
        total_cash_refunds: totalCashRefunds,
        total_cash_expenses: totalCashExpenses,
        net: roundMoney(totalCashFromOrders - totalCashRefunds - totalCashExpenses),
      },
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to load the monthly cash counter report' });
  }
});

export { router as cashCounterRoutes };
