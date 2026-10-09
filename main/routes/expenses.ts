/**
 * Expense records API. Reads need `expenses.view`; every mutation needs
 * `expenses.manage` as well as view, so an actor can always inspect the row
 * they just wrote. Amounts are integer minor units end to end.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { getDatabase } from '../db';
import { hasPermission, requirePermission } from '../services/authorization';
import {
  EXPENSE_LIST_MAX_LIMIT,
  EXPENSE_STATUS_FILTERS,
  ExpenseServiceError,
  type ExpenseListFilters,
  type ExpenseStatusFilter,
  createExpense,
  createExpenseCategory,
  getExpense,
  getExpenseContext,
  getExpensePayment,
  listExpenseCategories,
  listExpensePayments,
  listExpenses,
  normalizeExpensePaymentMethod,
  normalizeIdempotencyKey,
  recordExpensePayment,
  replaceExpense,
  reverseExpensePayment,
  summarizeExpenses,
  updateExpenseCategory,
  voidExpense,
} from '../services/expenses';

const router = Router();

interface AuthedRequest extends Request {
  user?: { userId?: string; role?: string };
}

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown; code?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
  if (statusCode >= 500) console.error('[API] Internal error:', error);
  const body: Record<string, unknown> = { error: statusCode >= 500 ? 'Internal server error' : details.message };
  if (typeof details.code === 'string' && details.code) body.code = details.code;
  res.status(statusCode).json(body);
}

function actorId(req: AuthedRequest): string {
  const id = String(req.user?.userId || '');
  if (!id) throw new ExpenseServiceError(401, 'Authentication required', 'authentication_required');
  return id;
}

/** Writes need both manage and view; manage alone cannot inspect the result. */
function requireExpenseWrite(req: Request, res: Response, next: NextFunction): void {
  const id = String((req as AuthedRequest).user?.userId || '');
  if (!id) {
    res.status(401).json({ error: 'Authentication required', code: 'authentication_required' });
    return;
  }
  if (!hasPermission(id, 'expenses.manage') || !hasPermission(id, 'expenses.view')) {
    res.status(403).json({ error: 'Insufficient permissions', code: 'permission_denied' });
    return;
  }
  next();
}

/** Payments and reversals are separate authorities layered on top of read access. */
function requireExpenseAuthority(permissionId: 'expenses.pay' | 'expenses.reverse') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = String((req as AuthedRequest).user?.userId || '');
    if (!id) {
      res.status(401).json({ error: 'Authentication required', code: 'authentication_required' });
      return;
    }
    if (!hasPermission(id, 'expenses.view') || !hasPermission(id, permissionId)) {
      res.status(403).json({ error: 'Insufficient permissions', code: 'permission_denied' });
      return;
    }
    next();
  };
}

/** Cash entries move drawer money, so they also need live drawer authority. */
function requireCashDrawerAuthority(req: Request, needsDrawer: boolean): void {
  if (!needsDrawer) return;
  if (!hasPermission(actorId(req as AuthedRequest), 'cash.movements.manage')) {
    throw new ExpenseServiceError(403, 'Insufficient permissions', 'permission_denied');
  }
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) {
    throw new ExpenseServiceError(400, `${field} must be a string of at most 256 characters`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function listFiltersFromQuery(query: Request['query']): ExpenseListFilters {
  const status = queryString(query.status, 'status');
  if (status !== undefined && !(EXPENSE_STATUS_FILTERS as readonly string[]).includes(status)) {
    throw new ExpenseServiceError(400, `status must be one of: ${EXPENSE_STATUS_FILTERS.join(', ')}`);
  }
  return {
    from: queryString(query.from, 'from') ?? null,
    to: queryString(query.to, 'to') ?? null,
    categoryId: queryString(query.category_id, 'category_id') ?? null,
    status: status as ExpenseStatusFilter | undefined,
    currencyCode: queryString(query.currency, 'currency') ?? null,
    limit: query.limit,
    cursor: queryString(query.cursor, 'cursor') ?? null,
  };
}

/** Client mutations must carry the header: a retry without it is a new expense. */
function requireIdempotencyKey(req: Request): string {
  const key = normalizeIdempotencyKey(req.get('Idempotency-Key'));
  if (!key) throw new ExpenseServiceError(400, 'Idempotency-Key header is required for this operation', 'idempotency_key_required');
  return key;
}

router.get('/categories', requirePermission('expenses.view'), (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
    const page = listExpenseCategories(getDatabase(), { includeInactive });
    res.json({ categories: page.categories, truncated: page.truncated });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/categories', requireExpenseWrite, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const outcome = createExpenseCategory(getDatabase(), {
      name: body.name,
      is_active: body.is_active,
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.patch('/categories/:id', requireExpenseWrite, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const outcome = updateExpenseCategory(getDatabase(), String(req.params.id), {
      name: body.name,
      is_active: body.is_active,
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/context', requirePermission('expenses.view'), (_req: Request, res: Response) => {
  try {
    res.json(getExpenseContext(getDatabase()));
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/summary', requirePermission('expenses.view'), (req: Request, res: Response) => {
  try {
    const filters = listFiltersFromQuery(req.query);
    res.json(summarizeExpenses(getDatabase(), filters));
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/', requirePermission('expenses.view'), (req: Request, res: Response) => {
  try {
    const filters = listFiltersFromQuery(req.query);
    const page = listExpenses(getDatabase(), filters);
    res.json({
      expenses: page.expenses,
      limit: page.limit,
      maxLimit: EXPENSE_LIST_MAX_LIMIT,
      ...(page.nextCursor !== null && { nextCursor: page.nextCursor }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requirePermission('expenses.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = String(req.params.id);
    const expense = getExpense(db, id);
    const history = listExpensePayments(db, id, {
      limit: req.query.payments_limit,
      cursor: queryString(req.query.payments_cursor, 'payments_cursor') ?? null,
    });
    res.json({
      expense,
      payments: history.payments,
      ...(history.nextCursor !== null && { paymentsNextCursor: history.nextCursor }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireExpenseWrite, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const outcome = createExpense(getDatabase(), {
      ...body,
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/void', requireExpenseWrite, (req: Request, res: Response) => {
  try {
    const outcome = voidExpense(getDatabase(), String(req.params.id), {
      reason: (req.body || {}).reason,
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/replace', requireExpenseWrite, (req: Request, res: Response) => {
  try {
    const outcome = replaceExpense(getDatabase(), String(req.params.id), {
      ...(req.body || {}),
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/** Amounts settle against the immutable ledger; a cash entry also writes a linked Pay Out. */
router.post('/:id/payments', requireExpenseAuthority('expenses.pay'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    requireCashDrawerAuthority(req, normalizeExpensePaymentMethod(body.method) === 'cash');
    const outcome = recordExpensePayment(getDatabase(), String(req.params.id), {
      ...body,
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/** Reversals copy the committed payment; a correction is never an in-place edit. */
router.post('/:id/payments/:paymentId/reverse', requireExpenseAuthority('expenses.reverse'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const expenseId = String(req.params.id);
    const paymentId = String(req.params.paymentId);
    requireCashDrawerAuthority(req, getExpensePayment(db, expenseId, paymentId).method === 'cash');
    const outcome = reverseExpensePayment(db, expenseId, paymentId, {
      reason: (req.body || {}).reason,
      actorUserId: actorId(req as AuthedRequest),
      idempotencyKey: requireIdempotencyKey(req),
    });
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.body);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const expenseRoutes = router;
