import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now, utcTodayDate, utcDayBounds } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

const router = Router();
const cashCounterWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

/**
 * Same "business date, defaults to today, may be backdated, never postdated"
 * rule used by the expense tracker (main/routes/expenses.ts) — a cash count
 * or opening float can't be logged for a day that hasn't happened yet.
 */
function normalizeRecordDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return utcTodayDate();
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw Object.assign(new Error('date must be in YYYY-MM-DD format'), { statusCode: 400 });
  }
  if (value > utcTodayDate()) {
    throw Object.assign(new Error('date cannot be in the future'), { statusCode: 400 });
  }
  return value;
}

function normalizeNonNegativeAmount(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative number`), { statusCode: 400 });
  }
  return Math.round(amount * 100) / 100;
}

function normalizeNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function monthBounds(month: string): [string, string] {
  if (!MONTH_PATTERN.test(month)) {
    throw Object.assign(new Error('month must be in YYYY-MM format'), { statusCode: 400 });
  }
  const [year, mon] = month.split('-').map(Number);
  if (mon < 1 || mon > 12) {
    throw Object.assign(new Error('month must be in YYYY-MM format'), { statusCode: 400 });
  }
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(lastDay).padStart(2, '0')}`];
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
 * Individual cash payment lines from bills.payment_details in a UTC
 * half-open range [start, end). Deliberately mirrors the CTE shape in
 * main/routes/reports.ts's paymentMethodBreakdown() — same JSON1 handling of
 * legacy object-shaped payment_details, split-check bills (each a separate
 * bills row), partial payments, and the timestamp -> paid_at -> created_at
 * fallback — but returns row-level lines (reports.ts only aggregates) and is
 * filtered to method = 'cash'. Not filtered by payment_status = 'paid': cash
 * physically received counts immediately even if the rest of a
 * partially-paid bill is still outstanding.
 */
function cashOrderPaymentLines(db: ReturnType<typeof getDatabase>, start: string, end: string): CashOrderPaymentLine[] {
  return db.prepare(`
    WITH payment_lines AS (
      SELECT b.id AS bill_id, b.bill_number, b.paid_at, b.created_at, je.value AS line
      FROM bills b
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
          THEN b.payment_details
        WHEN json_valid(b.payment_details)
          THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.payment_details IS NOT NULL
        AND json_type(je.value) = 'object'
        AND COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), 'unknown') = 'cash'
    ), normalized AS (
      SELECT
        bill_id, bill_number,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(json_extract(line, '$.timestamp'), '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
    )
    SELECT bill_id, bill_number,
      CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END AS amount,
      payment_time
    FROM normalized
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    ORDER BY payment_time DESC
  `).all(start, end) as CashOrderPaymentLine[];
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

router.get('/daily', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const date = normalizeRecordDate(req.query.date);
    const db = getDatabase();
    const [start, end] = utcDayBounds(date);

    const openingFloat = db.prepare(`
      SELECT f.*, u.name AS created_by_name
      FROM cash_opening_floats f
      LEFT JOIN users u ON u.id = f.created_by
      WHERE f.date = ?
    `).get(date) as any;

    const orderLines = cashOrderPaymentLines(db, start, end);
    const orderTotal = Math.round(orderLines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;

    const expensePayments = listCashExpensePayments(db, date) as any[];
    const expenseTotal = Math.round(expensePayments.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;

    const openingAmount = openingFloat?.amount ?? 0;
    const expectedCash = Math.round((openingAmount + orderTotal - expenseTotal) * 100) / 100;

    const counts = db.prepare(`
      SELECT c.*, u.name AS created_by_name
      FROM cash_count_records c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.date = ?
      ORDER BY c.created_at DESC, c.id DESC
    `).all(date) as any[];
    const latestCount = counts[0] ?? null;
    const variance = latestCount ? Math.round((latestCount.counted_amount - expectedCash) * 100) / 100 : null;

    res.json({
      date,
      opening_float: openingFloat || null,
      cash_from_orders: { total: orderTotal, payments: orderLines },
      cash_expenses: { total: expenseTotal, payments: expensePayments },
      expected_cash: expectedCash,
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
    const date = normalizeRecordDate(req.body?.date);
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
    const date = normalizeRecordDate(req.body?.date);
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

    const [rangeStart] = utcDayBounds(from);
    const [, rangeEnd] = utcDayBounds(to);
    const orderLines = cashOrderPaymentLines(db, rangeStart, rangeEnd);
    const ordersByDate = new Map<string, number>();
    for (const line of orderLines) {
      const day = line.payment_time.slice(0, 10);
      ordersByDate.set(day, Math.round(((ordersByDate.get(day) || 0) + line.amount) * 100) / 100);
    }

    const expensesByDate = cashExpenseTotalsByDate(db, from, to);
    const openingByDate = openingFloatsByDate(db, from, to);
    const latestCountByDate = latestCountsByDate(db, from, to);

    let totalOpeningFloats = 0;
    let totalCashFromOrders = 0;
    let totalCashExpenses = 0;

    const days = datesInRange(from, to).map((date) => {
      const opening = openingByDate.get(date) || 0;
      const orders = ordersByDate.get(date) || 0;
      const expenses = expensesByDate.get(date) || 0;
      const expectedCash = Math.round((opening + orders - expenses) * 100) / 100;
      const latestCount = latestCountByDate.has(date) ? latestCountByDate.get(date)! : null;
      const variance = latestCount !== null ? Math.round((latestCount - expectedCash) * 100) / 100 : null;

      totalOpeningFloats = Math.round((totalOpeningFloats + opening) * 100) / 100;
      totalCashFromOrders = Math.round((totalCashFromOrders + orders) * 100) / 100;
      totalCashExpenses = Math.round((totalCashExpenses + expenses) * 100) / 100;

      return {
        date,
        opening_float: opening,
        cash_from_orders: orders,
        cash_expenses: expenses,
        expected_cash: expectedCash,
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
        total_cash_expenses: totalCashExpenses,
        net: Math.round((totalCashFromOrders - totalCashExpenses) * 100) / 100,
      },
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to load the monthly cash counter report' });
  }
});

export { router as cashCounterRoutes };
