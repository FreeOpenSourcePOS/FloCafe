import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now, generateShortId } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import {
  monthBounds,
  normalizeBusinessDate,
  normalizeNote,
  roundMoney,
  storeToday,
} from './finance-shared';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PAYMENT_METHODS = ['cash', 'card', 'upi'] as const;
type PaymentMethod = typeof PAYMENT_METHODS[number];

// Built-ins plus any active custom method (same rule as bill payments in
// main/routes/bills.ts, which resolve customs to their stored name): the
// stored string is the audit trail, so match case-insensitively but keep
// the canonical name. Only 'cash' ever counts as drawer cash downstream,
// and custom names can never collide with it (reserved at creation).
function normalizePaymentMethod(db: ReturnType<typeof getDatabase>, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('method is required and must be cash, card, upi, or an active custom payment method'), { statusCode: 400 });
  }
  const trimmed = value.trim();
  if ((PAYMENT_METHODS as readonly string[]).includes(trimmed)) return trimmed;
  const custom = db.prepare('SELECT name FROM payment_methods WHERE lower(name) = lower(?) AND is_active = 1').get(trimmed) as { name: string } | undefined;
  if (!custom) {
    throw Object.assign(new Error('method is required and must be cash, card, upi, or an active custom payment method'), { statusCode: 400 });
  }
  return custom.name;
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
  return roundMoney(amount);
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
    LEFT JOIN (SELECT category_id, SUM(amount) AS total FROM expense_entries WHERE voided_at IS NULL GROUP BY category_id) entries
      ON entries.category_id = ec.id
    LEFT JOIN (SELECT category_id, SUM(amount) AS total FROM expense_due_payments WHERE voided_at IS NULL GROUP BY category_id) payments
      ON payments.category_id = ec.id
    ${includeInactive ? '' : 'WHERE ec.deleted_at IS NULL AND ec.is_active = 1'}
    ORDER BY ec.name COLLATE NOCASE
  `).all() as any[];
  // Round due to cents: the raw SUM difference can carry binary float
  // residue (e.g. 5e-17), which would read as a nonzero due and block
  // category deletion even though nothing is owed. DELETE rechecks via
  // categoryDue(), which rounds the same way, so both gates agree.
  return rows.map((row) => ({ ...row, is_active: Boolean(row.is_active), due: roundMoney(row.due) }));
}

function categoryDue(db: ReturnType<typeof getDatabase>, categoryId: string): number {
  const entries = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE category_id = ? AND voided_at IS NULL').get(categoryId) as { total: number };
  const payments = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expense_due_payments WHERE category_id = ? AND voided_at IS NULL').get(categoryId) as { total: number };
  return roundMoney(entries.total - payments.total);
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
    WHERE 1 = 1 AND t.voided_at IS NULL
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
    const date = normalizeBusinessDate(req.body?.date);
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

// Typo correction without rewriting history: stamping voided_at drops the row
// from every due, total, and ledger read below, while the row itself stays as
// the audit trail. Staff re-enter the correct figure as a new row. Counts are
// excluded on purpose: a wrong count is already superseded by appending a new
// one, since variance always compares the latest count.
function voidLedgerRow(table: 'expense_entries' | 'expense_due_payments', id: string) {
  const db = getDatabase();
  const result = db.prepare(`UPDATE ${table} SET voided_at = ? WHERE id = ? AND voided_at IS NULL`).run(now(), id);
  if (result.changes === 0) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

router.post('/entries/:id/void', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  const entry = voidLedgerRow('expense_entries', String(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Expense entry not found or already voided' });
  res.json({ entry });
});

router.post('/payments/:id/void', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  const payment = voidLedgerRow('expense_due_payments', String(req.params.id));
  if (!payment) return res.status(404).json({ error: 'Due payment not found or already voided' });
  res.json({ payment });
});

router.post('/payments', expenseWriteRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const category = requireActiveCategory(db, req.body?.category_id);
    const amount = normalizeAmount(req.body?.amount);
    const note = normalizeNote(req.body?.note);
    const date = normalizeBusinessDate(req.body?.date);
    const method = normalizePaymentMethod(db, req.body?.method);
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
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : storeToday().slice(0, 7);
    const [from, to] = monthBounds(month);
    const db = getDatabase();

    const expenseTotals = new Map((db.prepare(
      'SELECT category_id, COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE voided_at IS NULL AND expense_date >= ? AND expense_date <= ? GROUP BY category_id'
    ).all(from, to) as { category_id: string; total: number }[]).map((row) => [row.category_id, row.total]));

    const paymentTotals = new Map<string, { total: number; byMethod: Record<PaymentMethod, number>; custom: Record<string, number> }>();
    for (const row of db.prepare(
      'SELECT category_id, method, COALESCE(SUM(amount), 0) AS total FROM expense_due_payments WHERE voided_at IS NULL AND payment_date >= ? AND payment_date <= ? GROUP BY category_id, method'
    ).all(from, to) as { category_id: string; method: string | null; total: number }[]) {
      let bucket = paymentTotals.get(row.category_id);
      if (!bucket) {
        bucket = { total: 0, byMethod: { cash: 0, card: 0, upi: 0 }, custom: {} };
        paymentTotals.set(row.category_id, bucket);
      }
      bucket.total = roundMoney(bucket.total + row.total);
      if (row.method && PAYMENT_METHODS.includes(row.method as PaymentMethod)) {
        bucket.byMethod[row.method as PaymentMethod] = row.total;
      } else if (row.method) {
        bucket.custom[row.method] = roundMoney((bucket.custom[row.method] || 0) + row.total);
      }
    }

    const categories = listCategories(false).map((category) => {
      const payments = paymentTotals.get(category.id) ?? { total: 0, byMethod: { cash: 0, card: 0, upi: 0 }, custom: {} };
      return {
        category_id: category.id,
        category_name: category.name,
        due: category.due,
        total_expenses: roundMoney(expenseTotals.get(category.id) ?? 0),
        total_payments: payments.total,
        payments_by_method: payments.byMethod,
        custom_payments: payments.custom,
      };
    });

    const overallCustom: Record<string, number> = {};
    const overall = categories.reduce((acc, category) => {
      acc.total_expenses = roundMoney(acc.total_expenses + category.total_expenses);
      acc.total_payments = roundMoney(acc.total_payments + category.total_payments);
      acc.payments_by_method.cash = roundMoney(acc.payments_by_method.cash + category.payments_by_method.cash);
      acc.payments_by_method.card = roundMoney(acc.payments_by_method.card + category.payments_by_method.card);
      acc.payments_by_method.upi = roundMoney(acc.payments_by_method.upi + category.payments_by_method.upi);
      for (const [method, total] of Object.entries(category.custom_payments)) {
        overallCustom[method] = roundMoney((overallCustom[method] || 0) + total);
      }
      return acc;
    }, { total_expenses: 0, total_payments: 0, payments_by_method: { cash: 0, card: 0, upi: 0 } });

    res.json({ month, from, to, categories, overall: { ...overall, custom_payments: overallCustom } });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to load the monthly expense summary' });
  }
});

export { router as expenseRoutes };
