import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now, generateShortId, utcTodayDate } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The business date an expense/payment is FOR — defaults to today, may be
 * backdated, but never postdated (a record can't be for a day that hasn't
 * happened yet). Distinct from created_at (main/db.ts:5156's UTC-day
 * convention — see utcTodayDate), which always stamps the real moment of
 * recording and is never client-supplied.
 */
function normalizeEntryDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return utcTodayDate();
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw Object.assign(new Error('date must be in YYYY-MM-DD format'), { statusCode: 400 });
  }
  if (value > utcTodayDate()) {
    throw Object.assign(new Error('date cannot be in the future'), { statusCode: 400 });
  }
  return value;
}

const PAYMENT_METHODS = ['cash', 'card', 'upi'] as const;
type PaymentMethod = typeof PAYMENT_METHODS[number];

function normalizePaymentMethod(value: unknown): PaymentMethod {
  if (typeof value !== 'string' || !PAYMENT_METHODS.includes(value as PaymentMethod)) {
    throw Object.assign(new Error(`method is required and must be one of: ${PAYMENT_METHODS.join(', ')}`), { statusCode: 400 });
  }
  return value as PaymentMethod;
}

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** [firstDay, lastDay] of a `YYYY-MM` month, both inclusive `YYYY-MM-DD` strings. */
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

const router = Router();
const expenseWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

function normalizeCategoryName(value: unknown): string {
  if (typeof value !== 'string') throw Object.assign(new Error('Name is required'), { statusCode: 400 });
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw Object.assign(new Error('Name must be between 1 and 60 characters'), { statusCode: 400 });
  return name;
}

function normalizeAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Amount must be a positive number'), { statusCode: 400 });
  }
  return Math.round(amount * 100) / 100;
}

function normalizeNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function requireActiveCategory(db: ReturnType<typeof getDatabase>, categoryId: unknown) {
  if (typeof categoryId !== 'string' || !categoryId) {
    throw Object.assign(new Error('category_id is required'), { statusCode: 400 });
  }
  const category = db.prepare('SELECT * FROM expense_categories WHERE id = ? AND deleted_at IS NULL AND is_active = 1').get(categoryId) as any;
  if (!category) throw Object.assign(new Error('Expense category not found or inactive'), { statusCode: 404 });
  return category;
}

function listCategories(includeInactive: boolean) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      ec.*,
      COALESCE(entries.total, 0) AS total_expenses,
      COALESCE(payments.total, 0) AS total_payments,
      COALESCE(entries.total, 0) - COALESCE(payments.total, 0) AS due
    FROM expense_categories ec
    LEFT JOIN (SELECT category_id, SUM(amount) AS total FROM expense_entries GROUP BY category_id) entries
      ON entries.category_id = ec.id
    LEFT JOIN (SELECT category_id, SUM(amount) AS total FROM expense_due_payments GROUP BY category_id) payments
      ON payments.category_id = ec.id
    ${includeInactive ? '' : 'WHERE ec.deleted_at IS NULL AND ec.is_active = 1'}
    ORDER BY ec.name COLLATE NOCASE
  `).all() as any[];
  return rows.map((row) => ({ ...row, is_active: Boolean(row.is_active) }));
}

function categoryDue(db: ReturnType<typeof getDatabase>, categoryId: string): number {
  const entries = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE category_id = ?').get(categoryId) as { total: number };
  const payments = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expense_due_payments WHERE category_id = ?').get(categoryId) as { total: number };
  return Math.round((entries.total - payments.total) * 100) / 100;
}

const LEDGER_DATE_COLUMN = {
  expense_entries: 'expense_date',
  expense_due_payments: 'payment_date',
} as const;

function listLedger(table: 'expense_entries' | 'expense_due_payments', query: Request['query']) {
  const db = getDatabase();
  const dateColumn = LEDGER_DATE_COLUMN[table];
  let sql = `
    SELECT t.*, t.${dateColumn} AS date, ec.name AS category_name, u.name AS created_by_name
    FROM ${table} t
    JOIN expense_categories ec ON ec.id = t.category_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE 1 = 1
  `;
  const params: any[] = [];
  if (typeof query.category_id === 'string' && query.category_id) {
    sql += ' AND t.category_id = ?';
    params.push(query.category_id);
  }
  // `date` is an exact-day convenience filter; `from`/`to` give an inclusive
  // range. Both filter on the business date column, not created_at.
  if (typeof query.date === 'string' && DATE_PATTERN.test(query.date)) {
    sql += ` AND t.${dateColumn} = ?`;
    params.push(query.date);
  }
  if (typeof query.from === 'string' && DATE_PATTERN.test(query.from)) {
    sql += ` AND t.${dateColumn} >= ?`;
    params.push(query.from);
  }
  if (typeof query.to === 'string' && DATE_PATTERN.test(query.to)) {
    sql += ` AND t.${dateColumn} <= ?`;
    params.push(query.to);
  }
  sql += ` ORDER BY t.${dateColumn} DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`;
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

router.get('/categories', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  const includeInactive = req.query.include_inactive === 'true' && hasRole((req as any).user.role, ROLE_ACCESS.ownerManager);
  res.json({ categories: listCategories(includeInactive) });
});

router.post('/categories', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const name = normalizeCategoryName(req.body?.name);
    const db = getDatabase();
    const id = generateShortId('expense_categories');
    db.prepare(`
      INSERT INTO expense_categories (id, name, is_active, created_at, updated_at, created_by)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(id, name, now(), now(), (req as any).user.userId);
    res.status(201).json({ category: listCategories(true).find((row) => row.id === id) });
  } catch (error: any) {
    const duplicate = String(error.message || '').includes('UNIQUE constraint');
    res.status(duplicate ? 409 : error.statusCode || 500).json({ error: duplicate ? 'An expense category with this name already exists' : error.message || 'Unable to add category' });
  }
});

router.delete('/categories/:id', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  const db = getDatabase();
  const categoryId = String(req.params.id);
  const category = db.prepare('SELECT * FROM expense_categories WHERE id = ? AND deleted_at IS NULL').get(categoryId);
  if (!category) return res.status(404).json({ error: 'Expense category not found' });
  const due = categoryDue(db, categoryId);
  if (due !== 0) {
    return res.status(400).json({ error: `Category has an outstanding due balance of ${due}. Settle it before deleting.`, due });
  }
  db.prepare('UPDATE expense_categories SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?').run(now(), now(), categoryId);
  res.json({ success: true });
});

router.get('/entries', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  res.json({ entries: listLedger('expense_entries', req.query) });
});

router.post('/entries', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const category = requireActiveCategory(db, req.body?.category_id);
    const amount = normalizeAmount(req.body?.amount);
    const note = normalizeNote(req.body?.note);
    const date = normalizeEntryDate(req.body?.date);
    const result = db.prepare(`
      INSERT INTO expense_entries (category_id, amount, note, expense_date, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(category.id, amount, note, date, (req as any).user.userId, now());
    const entry = db.prepare(`
      SELECT t.*, t.expense_date AS date, ec.name AS category_name, u.name AS created_by_name
      FROM expense_entries t
      JOIN expense_categories ec ON ec.id = t.category_id
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = ?
    `).get(result.lastInsertRowid);
    res.status(201).json({ entry });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to add expense' });
  }
});

router.get('/payments', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  res.json({ payments: listLedger('expense_due_payments', req.query) });
});

router.post('/payments', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const category = requireActiveCategory(db, req.body?.category_id);
    const amount = normalizeAmount(req.body?.amount);
    const note = normalizeNote(req.body?.note);
    const date = normalizeEntryDate(req.body?.date);
    const method = normalizePaymentMethod(req.body?.method);
    // A payment may legally exceed the category's current due (e.g. prepaying
    // a vendor) — this is allowed on purpose, not clamped or rejected.
    const result = db.prepare(`
      INSERT INTO expense_due_payments (category_id, amount, note, payment_date, method, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(category.id, amount, note, date, method, (req as any).user.userId, now());
    const payment = db.prepare(`
      SELECT t.*, t.payment_date AS date, ec.name AS category_name, u.name AS created_by_name
      FROM expense_due_payments t
      JOIN expense_categories ec ON ec.id = t.category_id
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = ?
    `).get(result.lastInsertRowid);
    res.status(201).json({ payment });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to record payment' });
  }
});

router.get('/summary', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : utcTodayDate().slice(0, 7);
    const [from, to] = monthBounds(month);
    const db = getDatabase();

    const categories = listCategories(false).map((category) => {
      const expenses = db.prepare(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE category_id = ? AND expense_date >= ? AND expense_date <= ?'
      ).get(category.id, from, to) as { total: number };
      const paymentsByMethod = db.prepare(
        'SELECT method, COALESCE(SUM(amount), 0) AS total FROM expense_due_payments WHERE category_id = ? AND payment_date >= ? AND payment_date <= ? GROUP BY method'
      ).all(category.id, from, to) as { method: string | null; total: number }[];
      const byMethod: Record<PaymentMethod, number> = { cash: 0, card: 0, upi: 0 };
      let totalPayments = 0;
      for (const row of paymentsByMethod) {
        totalPayments += row.total;
        if (row.method && PAYMENT_METHODS.includes(row.method as PaymentMethod)) {
          byMethod[row.method as PaymentMethod] = row.total;
        }
      }
      return {
        category_id: category.id,
        category_name: category.name,
        due: category.due,
        total_expenses: expenses.total,
        total_payments: Math.round(totalPayments * 100) / 100,
        payments_by_method: byMethod,
      };
    });

    const overall = categories.reduce((acc, category) => {
      acc.total_expenses += category.total_expenses;
      acc.total_payments += category.total_payments;
      acc.payments_by_method.cash += category.payments_by_method.cash;
      acc.payments_by_method.card += category.payments_by_method.card;
      acc.payments_by_method.upi += category.payments_by_method.upi;
      return acc;
    }, { total_expenses: 0, total_payments: 0, payments_by_method: { cash: 0, card: 0, upi: 0 } });

    res.json({ month, from, to, categories, overall });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to load the monthly expense summary' });
  }
});

export { router as expenseRoutes };
