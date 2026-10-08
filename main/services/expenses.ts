/**
 * Expense records: categories, immutable expenses, the payment/reversal
 * ledger reads, and the idempotent mutation contract behind them.
 *
 * Money lives in integer minor units with a currency snapshot on the expense;
 * nothing here converts currencies or infers an amount from a display string.
 * Payment/reversal writes arrive in a later work order — this module already
 * owns the read math (net paid = payments minus reversals) and the batch
 * transaction they will join.
 */
import { createHash, randomUUID } from 'crypto';
import {
  getDatabase, getSettingValue, localDateInTimezone, now, tenantBusinessDayStartTime, withTxn,
} from '../db';
import { resolveRegionalSnapshot } from '../countries';
import { getOpenSession } from './shift-session-gate';

type ExpenseDb = ReturnType<typeof getDatabase>;

export type ExpensePaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'other';
export type ExpenseStatus = 'active' | 'voided' | 'replaced';
export type ExpenseStatusFilter = ExpenseStatus | 'all';

export const EXPENSE_STATUS_FILTERS = ['active', 'voided', 'replaced', 'all'] as const satisfies readonly ExpenseStatusFilter[];

export const EXPENSE_LIST_DEFAULT_LIMIT = 50;
export const EXPENSE_LIST_MAX_LIMIT = 100;
export const EXPENSE_CATEGORY_LIST_LIMIT = 500;

const CATEGORY_NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 200;
const PAYEE_LIMIT = 200;
const NOTES_LIMIT = 500;
const REASON_LIMIT = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DB_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export class ExpenseServiceError extends Error {
  readonly statusCode: number;
  readonly code: string | null;

  constructor(statusCode: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ExpenseServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ExpenseCategoryRecord {
  id: string;
  name: string;
  is_active: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ExpenseRecord {
  id: string;
  category_id: string;
  category_name: string;
  description: string;
  payee: string | null;
  notes: string | null;
  amount_minor: number;
  currency_code: string;
  incurred_on: string;
  created_by: string;
  created_at: string;
  replaces_expense_id: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  status: ExpenseStatus;
  paid_minor: number;
  due_minor: number;
}

export interface ExpensePaymentRecord {
  id: string;
  expense_id: string;
  amount_minor: number;
  method: ExpensePaymentMethod;
  business_date: string;
  reversal_of: string | null;
  reason: string | null;
  cash_movement_id: number | null;
  created_by: string;
  created_at: string;
}

export interface ExpenseSummaryGroup {
  currency_code: string;
  category_id: string;
  category_name: string;
  expense_count: number;
  incurred_minor: number;
  net_paid_minor: number;
  due_minor: number;
}

export interface ExpenseSummaryTotals {
  currency_code: string;
  expense_count: number;
  incurred_minor: number;
  net_paid_minor: number;
  due_minor: number;
}

export interface ExpenseSummary {
  basis: 'active_expenses_incurred_in_range_paid_to_date';
  filters: {
    from: string | null;
    to: string | null;
    category_id: string | null;
    currency_code: string | null;
    status: 'active';
  };
  groups: ExpenseSummaryGroup[];
  totals: ExpenseSummaryTotals[];
}

export interface ExpenseListFilters {
  from?: string | null;
  to?: string | null;
  categoryId?: string | null;
  status?: ExpenseStatusFilter;
  currencyCode?: string | null;
  limit?: unknown;
  cursor?: string | null;
}

export interface ExpenseWriteFields {
  category_id?: unknown;
  description?: unknown;
  amount_minor?: unknown;
  currency_code?: unknown;
  incurred_on?: unknown;
  payee?: unknown;
  notes?: unknown;
  replaces_expense_id?: unknown;
}

export interface MutationOutcome<T> {
  status: number;
  body: T;
  replayed: boolean;
}

// ── Validation primitives ────────────────────────────────────────────────────

function badRequest(message: string, code: string | null = null): ExpenseServiceError {
  return new ExpenseServiceError(400, message, code);
}

function conflict(message: string, code: string | null = null): ExpenseServiceError {
  return new ExpenseServiceError(409, message, code);
}

export function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const key = String(value).trim();
  if (!key) return null;
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    throw badRequest('Idempotency-Key is invalid or too long', 'invalid_idempotency_key');
  }
  return key;
}

/** Stable JSON for hashing: object keys sorted, arrays kept in order. */
export function canonicalizeExpenseRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeExpenseRequest).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeExpenseRequest((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

export function expenseRequestHash(operation: string, resourceId: string, fields: unknown): string {
  return createHash('sha256')
    .update(canonicalizeExpenseRequest({ operation, resource_id: resourceId, fields }))
    .digest('hex');
}

function requireTrimmedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw badRequest(`${field} is required`);
  if (text.length > maxLength) throw badRequest(`${field} must be at most ${maxLength} characters`);
  return text;
}

function optionalTrimmedText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw badRequest(`${field} must be at most ${maxLength} characters`);
  return text;
}

function requirePositiveMinorUnits(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a positive integer number of minor units`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`);
  return value;
}

/** Gregorian calendar validation: the date shape alone would accept 2026-02-30. */
export function isValidBusinessDate(value: string): boolean {
  if (!BUSINESS_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function requireBusinessDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidBusinessDate(value)) {
    throw badRequest(`${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function requireCurrencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value.trim().toUpperCase())) {
    throw badRequest('currency_code must be a three-letter currency code');
  }
  return value.trim().toUpperCase();
}

function tenantRegionalSnapshot(): { currency: string; timezone: string } {
  const snapshot = resolveRegionalSnapshot({
    country: getSettingValue('country') ?? undefined,
    currency: getSettingValue('currency') ?? undefined,
    timezone: getSettingValue('timezone') ?? undefined,
  });
  return { currency: snapshot.currency, timezone: snapshot.timezone };
}

/** Store-local business date, so an expense can be dated to a closed trading day. */
export function currentBusinessDate(): string {
  const regional = tenantRegionalSnapshot();
  return localDateInTimezone(new Date(), regional.timezone, tenantBusinessDayStartTime());
}

function requireSafeTotal(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new ExpenseServiceError(500, `${label} exceeds the supported amount range`);
  }
  return value;
}

// ── Cursors ──────────────────────────────────────────────────────────────────

function encodeCursor(parts: string[]): string {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, expectedParts: number): string[] {
  const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const parts = decoded.split('|');
  if (parts.length !== expectedParts || parts.some((part) => part.length === 0)) {
    throw badRequest('cursor is invalid');
  }
  return parts;
}

// ── Categories ───────────────────────────────────────────────────────────────

function normalizeCategoryName(value: unknown): { name: string; nameKey: string } {
  const name = requireTrimmedText(value, 'name', CATEGORY_NAME_LIMIT);
  return { name, nameKey: name.toLowerCase() };
}

export function listExpenseCategories(
  db: ExpenseDb,
  filters: { includeInactive?: boolean } = {},
): { categories: ExpenseCategoryRecord[]; truncated: boolean } {
  const rows = db.prepare(`
    SELECT * FROM expense_categories
    ${filters.includeInactive ? '' : 'WHERE is_active = 1'}
    ORDER BY is_active DESC, name COLLATE NOCASE, id
    LIMIT ?
  `).all(EXPENSE_CATEGORY_LIST_LIMIT + 1) as ExpenseCategoryRecord[];
  const truncated = rows.length > EXPENSE_CATEGORY_LIST_LIMIT;
  return { categories: truncated ? rows.slice(0, EXPENSE_CATEGORY_LIST_LIMIT) : rows, truncated };
}

export function getExpenseCategory(db: ExpenseDb, id: string): ExpenseCategoryRecord {
  const row = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id) as ExpenseCategoryRecord | undefined;
  if (!row) throw new ExpenseServiceError(404, 'Expense category not found');
  return row;
}

function isCategoryNameConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && String((error as { code?: unknown }).code || '').includes('CONSTRAINT')
    && String((error as { message?: unknown }).message || '').includes('expense_categories.name_key');
}

export function createExpenseCategory(
  db: ExpenseDb,
  input: { name?: unknown; is_active?: unknown; actorUserId: string; idempotencyKey?: string | null },
): MutationOutcome<{ category: ExpenseCategoryRecord }> {
  const { name, nameKey } = normalizeCategoryName(input.name);
  const isActive = input.is_active === undefined ? true : requireBoolean(input.is_active, 'is_active');
  const id = `expcat_${randomUUID()}`;

  return withTxn(() => runExpenseMutation(
    db,
    {
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      operation: 'create_expense_category',
      resourceId: '',
      fields: { name: nameKey, is_active: isActive ? 1 : 0 },
    },
    () => {
      const timestamp = now();
      try {
        db.prepare(`
          INSERT INTO expense_categories (id, name, name_key, is_active, created_by, updated_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, nameKey, isActive ? 1 : 0, input.actorUserId, input.actorUserId, timestamp, timestamp);
      } catch (error) {
        if (isCategoryNameConflict(error)) throw conflict('An expense category with this name already exists', 'category_name_taken');
        throw error;
      }
      return { status: 201, body: { category: getExpenseCategory(db, id) } };
    },
  ));
}

export function updateExpenseCategory(
  db: ExpenseDb,
  id: string,
  input: { name?: unknown; is_active?: unknown; actorUserId: string; idempotencyKey?: string | null },
): MutationOutcome<{ category: ExpenseCategoryRecord }> {
  if (input.name === undefined && input.is_active === undefined) {
    throw badRequest('name or is_active is required');
  }
  const namePatch = input.name === undefined ? null : normalizeCategoryName(input.name);
  const isActivePatch = input.is_active === undefined ? null : requireBoolean(input.is_active, 'is_active');

  return withTxn(() => runExpenseMutation(
    db,
    {
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      operation: 'update_expense_category',
      resourceId: id,
      fields: {
        name: namePatch ? namePatch.nameKey : null,
        is_active: isActivePatch === null ? null : (isActivePatch ? 1 : 0),
      },
    },
    () => {
      const category = getExpenseCategory(db, id);
      const nextName = namePatch ? namePatch.name : category.name;
      const nextActive = isActivePatch === null ? category.is_active : (isActivePatch ? 1 : 0);
      try {
        if (namePatch) {
          db.prepare(`
            UPDATE expense_categories SET name = ?, name_key = ?, is_active = ?, updated_by = ?, updated_at = ?
            WHERE id = ?
          `).run(nextName, namePatch.nameKey, nextActive, input.actorUserId, now(), id);
        } else {
          db.prepare(`
            UPDATE expense_categories SET is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?
          `).run(nextActive, input.actorUserId, now(), id);
        }
      } catch (error) {
        if (isCategoryNameConflict(error)) throw conflict('An expense category with this name already exists', 'category_name_taken');
        throw error;
      }
      return { status: 200, body: { category: getExpenseCategory(db, id) } };
    },
  ));
}

// ── Expense reads ────────────────────────────────────────────────────────────

const EXPENSE_PROJECTION = `
  e.*,
  CASE
    WHEN e.voided_at IS NULL THEN 'active'
    WHEN EXISTS (SELECT 1 FROM expenses r WHERE r.replaces_expense_id = e.id) THEN 'replaced'
    ELSE 'voided'
  END AS status,
  COALESCE((
    SELECT SUM(CASE WHEN p.reversal_of IS NULL THEN p.amount_minor ELSE -p.amount_minor END)
    FROM expense_payments p WHERE p.expense_id = e.id
  ), 0) AS net_paid_minor
`;

function projectExpenseRow(row: ExpenseRecord & { net_paid_minor: number }): ExpenseRecord {
  const paidMinor = requireSafeTotal(Number(row.net_paid_minor), 'Expense paid total');
  const amountMinor = Number(row.amount_minor);
  return {
    id: row.id,
    category_id: row.category_id,
    category_name: row.category_name,
    description: row.description,
    payee: row.payee,
    notes: row.notes,
    amount_minor: amountMinor,
    currency_code: row.currency_code,
    incurred_on: row.incurred_on,
    created_by: row.created_by,
    created_at: row.created_at,
    replaces_expense_id: row.replaces_expense_id,
    voided_at: row.voided_at,
    voided_by: row.voided_by,
    void_reason: row.void_reason,
    status: row.status,
    paid_minor: paidMinor,
    due_minor: requireSafeTotal(amountMinor - paidMinor, 'Expense due total'),
  };
}

interface ExpenseFilterSql {
  whereSql: string;
  params: (string | number)[];
  applied: {
    from: string | null;
    to: string | null;
    category_id: string | null;
    currency_code: string | null;
    status: ExpenseStatusFilter;
  };
}

function buildExpenseFilterSql(filters: ExpenseListFilters): ExpenseFilterSql {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const from = filters.from === undefined || filters.from === null ? null : requireBusinessDate(filters.from, 'from');
  const to = filters.to === undefined || filters.to === null ? null : requireBusinessDate(filters.to, 'to');
  if (from && to && from > to) throw badRequest('from must not be after to');
  if (from) {
    conditions.push('e.incurred_on >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('e.incurred_on <= ?');
    params.push(to);
  }
  const categoryId = filters.categoryId ? String(filters.categoryId) : null;
  if (categoryId) {
    conditions.push('e.category_id = ?');
    params.push(categoryId);
  }
  const currencyCode = filters.currencyCode ? requireCurrencyCode(filters.currencyCode) : null;
  if (currencyCode) {
    conditions.push('e.currency_code = ?');
    params.push(currencyCode);
  }
  const status: ExpenseStatusFilter = filters.status ?? 'active';
  if (!(EXPENSE_STATUS_FILTERS as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of: ${EXPENSE_STATUS_FILTERS.join(', ')}`);
  }
  if (status === 'active') conditions.push('e.voided_at IS NULL');
  else if (status === 'voided') {
    conditions.push('e.voided_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expenses r WHERE r.replaces_expense_id = e.id)');
  }
  else if (status === 'replaced') {
    conditions.push('e.voided_at IS NOT NULL AND EXISTS (SELECT 1 FROM expenses r WHERE r.replaces_expense_id = e.id)');
  }
  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    applied: { from, to, category_id: categoryId, currency_code: currencyCode, status },
  };
}

export function normalizeExpenseLimit(value: unknown, fallback = EXPENSE_LIST_DEFAULT_LIMIT): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest('limit must be a positive integer');
  return Math.min(parsed, EXPENSE_LIST_MAX_LIMIT);
}

export function listExpenses(
  db: ExpenseDb,
  filters: ExpenseListFilters = {},
): { expenses: ExpenseRecord[]; nextCursor: string | null; limit: number } {
  const { whereSql, params } = buildExpenseFilterSql(filters);
  const limit = normalizeExpenseLimit(filters.limit);
  const cursor = filters.cursor ? decodeCursor(String(filters.cursor), 2) : null;
  if (cursor && !isValidBusinessDate(cursor[0])) throw badRequest('cursor is invalid');
  const cursorSql = cursor ? `${whereSql ? 'AND' : 'WHERE'} (e.incurred_on, e.id) < (?, ?)` : '';
  const rows = db.prepare(`
    SELECT ${EXPENSE_PROJECTION}
    FROM expenses e
    ${whereSql}
    ${cursorSql}
    ORDER BY e.incurred_on DESC, e.id DESC
    LIMIT ?
  `).all(
    ...params,
    ...(cursor ? [cursor[0], cursor[1]] : []),
    limit + 1,
  ) as (ExpenseRecord & { net_paid_minor: number })[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    expenses: page.map(projectExpenseRow),
    nextCursor: hasMore && last ? encodeCursor([last.incurred_on, last.id]) : null,
    limit,
  };
}

export function getExpense(db: ExpenseDb, id: string): ExpenseRecord {
  const row = db.prepare(`SELECT ${EXPENSE_PROJECTION} FROM expenses e WHERE e.id = ?`).get(id) as
    | (ExpenseRecord & { net_paid_minor: number })
    | undefined;
  if (!row) throw new ExpenseServiceError(404, 'Expense not found');
  return projectExpenseRow(row);
}

/** Payment history, newest first; reversals stay in the ledger as their own entries. */
export function listExpensePayments(
  db: ExpenseDb,
  expenseId: string,
  options: { limit?: unknown; cursor?: string | null } = {},
): { payments: ExpensePaymentRecord[]; nextCursor: string | null } {
  const limit = normalizeExpenseLimit(options.limit);
  const cursor = options.cursor ? decodeCursor(String(options.cursor), 2) : null;
  if (cursor && !DB_TIMESTAMP_PATTERN.test(cursor[0])) throw badRequest('cursor is invalid');
  const rows = db.prepare(`
    SELECT * FROM expense_payments p
    ${cursor ? 'WHERE p.expense_id = ? AND (p.created_at, p.id) < (?, ?)' : 'WHERE p.expense_id = ?'}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?
  `).all(...(cursor ? [expenseId, cursor[0], cursor[1]] : [expenseId]), limit + 1) as ExpensePaymentRecord[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    payments: page,
    nextCursor: hasMore && last ? encodeCursor([last.created_at, last.id]) : null,
  };
}

interface ExpenseAggregateRow {
  currency_code: string;
  category_id?: string;
  category_name?: string;
  expense_count: number;
  incurred_minor: number;
  net_paid_minor: number;
}

function aggregateExpenses(db: ExpenseDb, filter: ExpenseFilterSql, grouped: boolean): ExpenseAggregateRow[] {
  return db.prepare(`
    SELECT
      e.currency_code AS currency_code,
      ${grouped ? 'e.category_id AS category_id, MAX(COALESCE(c.name, e.category_name)) AS category_name,' : ''}
      COUNT(*) AS expense_count,
      COALESCE(SUM(e.amount_minor), 0) AS incurred_minor,
      COALESCE(SUM(COALESCE((
        SELECT SUM(CASE WHEN p.reversal_of IS NULL THEN p.amount_minor ELSE -p.amount_minor END)
        FROM expense_payments p WHERE p.expense_id = e.id
      ), 0)), 0) AS net_paid_minor
    FROM expenses e
    LEFT JOIN expense_categories c ON c.id = e.category_id
    ${filter.whereSql}
    GROUP BY e.currency_code${grouped ? ', e.category_id' : ''}
    ORDER BY e.currency_code${grouped ? ', MAX(COALESCE(c.name, e.category_name)) COLLATE NOCASE' : ''}
  `).all(...filter.params) as ExpenseAggregateRow[];
}

/**
 * Current net paid/due against the active expenses incurred in the filter
 * range — not payments made in the period, and never subtracted from sales.
 */
export function summarizeExpenses(db: ExpenseDb, filters: ExpenseListFilters = {}): ExpenseSummary {
  const filter = buildExpenseFilterSql({ ...filters, status: 'active' });
  const groups = aggregateExpenses(db, filter, true).map((row) => {
    const incurredMinor = requireSafeTotal(Number(row.incurred_minor), 'Expense incurred total');
    const netPaidMinor = requireSafeTotal(Number(row.net_paid_minor), 'Expense paid total');
    return {
      currency_code: row.currency_code,
      category_id: String(row.category_id),
      category_name: String(row.category_name),
      expense_count: Number(row.expense_count),
      incurred_minor: incurredMinor,
      net_paid_minor: netPaidMinor,
      due_minor: requireSafeTotal(incurredMinor - netPaidMinor, 'Expense due total'),
    };
  });
  const totals = aggregateExpenses(db, filter, false).map((row) => {
    const incurredMinor = requireSafeTotal(Number(row.incurred_minor), 'Expense incurred total');
    const netPaidMinor = requireSafeTotal(Number(row.net_paid_minor), 'Expense paid total');
    return {
      currency_code: row.currency_code,
      expense_count: Number(row.expense_count),
      incurred_minor: incurredMinor,
      net_paid_minor: netPaidMinor,
      due_minor: requireSafeTotal(incurredMinor - netPaidMinor, 'Expense due total'),
    };
  });
  return {
    basis: 'active_expenses_incurred_in_range_paid_to_date',
    filters: {
      from: filter.applied.from,
      to: filter.applied.to,
      category_id: filter.applied.category_id,
      currency_code: filter.applied.currency_code,
      status: 'active',
    },
    groups,
    totals,
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Actor-scoped idempotency: a committed mutation is replayed from its stored
 * receipt when the same key arrives with the same normalized request, and is a
 * conflict otherwise. Callers open the transaction, so the receipt and the
 * write commit together — a rolled-back attempt is never recorded.
 */
function runExpenseMutation<T>(
  db: ExpenseDb,
  input: { actorUserId: string; idempotencyKey: string | null; operation: string; resourceId: string; fields: unknown },
  work: () => { status: number; body: T },
): MutationOutcome<T> {
  const key = input.idempotencyKey;
  const hash = key ? expenseRequestHash(input.operation, input.resourceId, input.fields) : null;
  if (key) {
    const existing = db.prepare(`
      SELECT operation, resource_id, request_hash, response_json
      FROM expense_mutations WHERE actor_user_id = ? AND idempotency_key = ?
    `).get(input.actorUserId, key) as
      | { operation: string; resource_id: string; request_hash: string; response_json: string }
      | undefined;
    if (existing) {
      if (existing.operation !== input.operation || existing.resource_id !== input.resourceId || existing.request_hash !== hash) {
        throw conflict('Idempotency-Key was already used for a different expense request', 'idempotency_conflict');
      }
      const stored = JSON.parse(existing.response_json) as { status: number; body: T };
      return { status: stored.status, body: stored.body, replayed: true };
    }
  }
  const outcome = work();
  if (key && hash) {
    db.prepare(`
      INSERT INTO expense_mutations (actor_user_id, idempotency_key, operation, resource_id, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.actorUserId,
      key,
      input.operation,
      input.resourceId,
      hash,
      JSON.stringify({ status: outcome.status, body: outcome.body }),
      now(),
    );
  }
  return { ...outcome, replayed: false };
}

function requireActiveCategory(db: ExpenseDb, categoryId: string): ExpenseCategoryRecord {
  const category = getExpenseCategory(db, categoryId);
  if (category.is_active !== 1) throw conflict('Expense category is inactive', 'category_inactive');
  return category;
}

/** The store currency at creation time; expenses never carry a foreign snapshot. */
function resolveExpenseCurrency(currencyCode: unknown): string {
  const storeCurrency = tenantRegionalSnapshot().currency;
  if (currencyCode === undefined || currencyCode === null || currencyCode === '') return storeCurrency;
  const requested = requireCurrencyCode(currencyCode);
  if (requested !== storeCurrency) {
    throw badRequest(`currency_code must match the store currency (${storeCurrency})`);
  }
  return storeCurrency;
}

interface ValidatedExpenseFields {
  categoryId: string;
  categoryName: string;
  description: string;
  amountMinor: number;
  currencyCode: string;
  incurredOn: string;
  payee: string | null;
  notes: string | null;
}

function validateExpenseFields(db: ExpenseDb, input: ExpenseWriteFields): ValidatedExpenseFields {
  const categoryId = requireTrimmedText(input.category_id, 'category_id', 128);
  const category = requireActiveCategory(db, categoryId);
  const description = requireTrimmedText(input.description, 'description', DESCRIPTION_LIMIT);
  const amountMinor = requirePositiveMinorUnits(input.amount_minor, 'amount_minor');
  const currencyCode = resolveExpenseCurrency(input.currency_code);
  const incurredOn = requireBusinessDate(input.incurred_on, 'incurred_on');
  if (incurredOn > currentBusinessDate()) throw badRequest('incurred_on cannot be in the future');
  return {
    categoryId,
    categoryName: category.name,
    description,
    amountMinor,
    currencyCode,
    incurredOn,
    payee: optionalTrimmedText(input.payee, 'payee', PAYEE_LIMIT),
    notes: optionalTrimmedText(input.notes, 'notes', NOTES_LIMIT),
  };
}

function insertExpense(
  db: ExpenseDb,
  fields: ValidatedExpenseFields,
  actorUserId: string,
  replacesExpenseId: string | null,
): string {
  const id = `exp_${randomUUID()}`;
  db.prepare(`
    INSERT INTO expenses (
      id, category_id, category_name, description, payee, notes, amount_minor,
      currency_code, incurred_on, created_by, created_at, replaces_expense_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.categoryId,
    fields.categoryName,
    fields.description,
    fields.payee,
    fields.notes,
    fields.amountMinor,
    fields.currencyCode,
    fields.incurredOn,
    actorUserId,
    now(),
    replacesExpenseId,
  );
  return id;
}

/** Net paid across the immutable ledger: payments minus their reversals. */
function netPaidMinor(db: ExpenseDb, expenseId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN reversal_of IS NULL THEN amount_minor ELSE -amount_minor END), 0) AS net_paid
    FROM expense_payments WHERE expense_id = ?
  `).get(expenseId) as { net_paid: number };
  return requireSafeTotal(Number(row.net_paid), 'Expense paid total');
}

function requireUnpaidOpenExpense(db: ExpenseDb, id: string): void {
  const expense = getExpense(db, id);
  if (expense.status === 'replaced') throw conflict('Expense was already replaced', 'expense_replaced');
  if (expense.voided_at) throw conflict('Expense is already voided', 'expense_voided');
  if (netPaidMinor(db, id) !== 0) {
    throw conflict('Expense has recorded payments; reverse them before voiding or replacing', 'expense_has_payments');
  }
}

function requireReason(value: unknown): string {
  return requireTrimmedText(value, 'reason', REASON_LIMIT);
}

function expenseMutationFields(input: ExpenseWriteFields): Record<string, unknown> {
  const normalizeText = (value: unknown) => typeof value === 'string' ? value.trim() : value;
  const normalizeOptionalText = (value: unknown) => {
    if (value === undefined || value === null) return null;
    const normalized = normalizeText(value);
    return normalized === '' ? null : normalized;
  };
  const storeCurrency = tenantRegionalSnapshot().currency;
  const rawCurrency = typeof input.currency_code === 'string' ? input.currency_code.trim().toUpperCase() : input.currency_code;
  const canonicalCurrency = rawCurrency === undefined || rawCurrency === null || rawCurrency === '' || rawCurrency === storeCurrency
    ? storeCurrency
    : rawCurrency;
  return {
    category_id: normalizeText(input.category_id),
    description: normalizeText(input.description),
    amount_minor: input.amount_minor,
    currency_code: canonicalCurrency,
    incurred_on: input.incurred_on,
    payee: normalizeOptionalText(input.payee),
    notes: normalizeOptionalText(input.notes),
  };
}

/** A new expense never starts paid: the ledger is the only source of paid state. */
export function createExpense(
  db: ExpenseDb,
  input: ExpenseWriteFields & { actorUserId: string; idempotencyKey?: string | null },
): MutationOutcome<{ expense: ExpenseRecord }> {
  if (input.replaces_expense_id !== undefined && input.replaces_expense_id !== null) {
    throw badRequest('replaces_expense_id can only be set by the replace operation');
  }
  return withTxn(() => runExpenseMutation(
    db,
    {
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      operation: 'create_expense',
      resourceId: '',
      fields: expenseMutationFields(input),
    },
    () => {
      const fields = validateExpenseFields(db, input);
      const id = insertExpense(db, fields, input.actorUserId, null);
      return { status: 201, body: { expense: getExpense(db, id) } };
    },
  ));
}

/** Keeps the original expense row, values and audit trail; only adds void metadata. */
export function voidExpense(
  db: ExpenseDb,
  id: string,
  input: { reason?: unknown; actorUserId: string; idempotencyKey?: string | null },
): MutationOutcome<{ expense: ExpenseRecord }> {
  const reason = requireReason(input.reason);
  return withTxn(() => runExpenseMutation(
    db,
    {
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      operation: 'void_expense',
      resourceId: id,
      fields: { reason },
    },
    () => {
      requireUnpaidOpenExpense(db, id);
      db.prepare('UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?')
        .run(now(), input.actorUserId, reason, id);
      return { status: 200, body: { expense: getExpense(db, id) } };
    },
  ));
}

/** Voids the source and creates the linked replacement in one transaction. */
export function replaceExpense(
  db: ExpenseDb,
  id: string,
  input: ExpenseWriteFields & { reason?: unknown; actorUserId: string; idempotencyKey?: string | null },
): MutationOutcome<{ expense: ExpenseRecord; replaced_expense_id: string }> {
  const reason = requireReason(input.reason);
  return withTxn(() => runExpenseMutation(
    db,
    {
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      operation: 'replace_expense',
      resourceId: id,
      fields: { reason, ...expenseMutationFields(input) },
    },
    () => {
      requireUnpaidOpenExpense(db, id);
      const fields = validateExpenseFields(db, input);
      const replacementId = insertExpense(db, fields, input.actorUserId, id);
      db.prepare('UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?')
        .run(now(), input.actorUserId, reason, id);
      return { status: 201, body: { expense: getExpense(db, replacementId), replaced_expense_id: id } };
    },
  ));
}

// ── Context ──────────────────────────────────────────────────────────────────

export interface ExpenseContext {
  currency_code: string;
  business_date: string;
  cash_session_open: boolean;
}

/** Entry defaults for the expense surfaces: store currency, store business date, drawer state. */
export function getExpenseContext(db: ExpenseDb): ExpenseContext {
  return {
    currency_code: tenantRegionalSnapshot().currency,
    business_date: currentBusinessDate(),
    cash_session_open: getOpenSession(db) !== undefined,
  };
}
