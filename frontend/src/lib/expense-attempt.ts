import { createPaymentIdempotencyKey } from './payment-idempotency';

/**
 * Durable record of the operator mutation that is in flight. It is written
 * BEFORE the request is sent, so a timeout or a dropped response never leaves
 * the UI free to invent a new idempotency key for work that may already have
 * committed. One slot only: the workflow allows a single in-flight mutation.
 */
export const EXPENSE_ATTEMPT_STORAGE_KEY = 'flo.expenses.attempt.v1';

export type ExpenseAttemptKind =
  | 'expense.create'
  | 'expense.replace'
  | 'expense.void'
  | 'expense.payment'
  | 'expense.payment.reverse';

export interface ExpenseAttemptSnapshot {
  kind: ExpenseAttemptKind;
  /** The request path, so a retry reaches the same resource without re-deriving it. */
  path: string;
  /** Null for `expense.create`, which has no resource until the server assigns one. */
  expenseId: string | null;
  /** Set only for `expense.payment.reverse`, which targets one ledger row. */
  paymentId: string | null;
  idempotencyKey: string;
  body: Record<string, unknown>;
  actorId: number;
  tenantId: number;
  createdAt: string;
}

/** Raised when attempt state cannot be read or written. Callers must not send
 * the mutation when this is thrown: an unreadable slot may hold a committed
 * request that a fresh key would duplicate. */
export class ExpenseAttemptStorageError extends Error {
  constructor() {
    super('Expense attempt storage is unavailable');
    this.name = 'ExpenseAttemptStorageError';
  }
}

function attemptStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) throw new ExpenseAttemptStorageError();
  return window.localStorage;
}

function isSnapshot(value: unknown): value is ExpenseAttemptSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attempt = value as Partial<ExpenseAttemptSnapshot>;
  return typeof attempt.kind === 'string'
    && typeof attempt.path === 'string'
    && attempt.path.length > 0
    && typeof attempt.idempotencyKey === 'string'
    && attempt.idempotencyKey.length > 0
    && typeof attempt.actorId === 'number'
    && typeof attempt.tenantId === 'number'
    && !!attempt.body && typeof attempt.body === 'object' && !Array.isArray(attempt.body);
}

/** Builds the snapshot to persist, with a fresh key for a submission nothing has answered yet. */
export function newExpenseAttempt(input: {
  kind: ExpenseAttemptKind;
  path: string;
  expenseId: string | null;
  paymentId: string | null;
  body: Record<string, unknown>;
  actorId: number;
  tenantId: number;
}): ExpenseAttemptSnapshot {
  return {
    ...input,
    idempotencyKey: createPaymentIdempotencyKey(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Reads the slot for the given actor and store. Another actor's unresolved
 * attempt is "not mine" rather than damage: it is left where it is so their
 * retry still resolves, and this session never submits under their key.
 */
export function readExpenseAttempt(actorId: number, tenantId: number): ExpenseAttemptSnapshot | null {
  let raw: string | null;
  try {
    raw = attemptStorage().getItem(EXPENSE_ATTEMPT_STORAGE_KEY);
  } catch {
    throw new ExpenseAttemptStorageError();
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExpenseAttemptStorageError();
  }
  if (!isSnapshot(parsed)) throw new ExpenseAttemptStorageError();
  if (parsed.actorId !== actorId || parsed.tenantId !== tenantId) return null;
  return parsed;
}

/** Persists the snapshot before the request leaves the device, verified by read-back. */
export function persistExpenseAttempt(snapshot: ExpenseAttemptSnapshot): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    throw new ExpenseAttemptStorageError();
  }
  let stored = false;
  try {
    const storage = attemptStorage();
    storage.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, serialized);
    stored = storage.getItem(EXPENSE_ATTEMPT_STORAGE_KEY) === serialized;
  } catch {
    stored = false;
  }
  if (!stored) throw new ExpenseAttemptStorageError();
}

/** Clears the slot once the mutation is known to be committed or rejected. */
export function clearExpenseAttempt(): boolean {
  try {
    const storage = attemptStorage();
    storage.removeItem(EXPENSE_ATTEMPT_STORAGE_KEY);
    return storage.getItem(EXPENSE_ATTEMPT_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

/**
 * True when a failure left the mutation unresolved: the request may have
 * committed, so the attempt must stay locked until the operator resolves it.
 * A response the server produced without a server fault is an answer.
 */
export function isUnresolvedExpenseFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === 'number') return status >= 500;
  return true;
}
