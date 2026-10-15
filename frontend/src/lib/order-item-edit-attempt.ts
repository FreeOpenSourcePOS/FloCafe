import { createPaymentIdempotencyKey } from './payment-idempotency';

/**
 * Durable record of an in-flight order-item edit mutation, scoped to tenant,
 * actor, order, and item. Persisted BEFORE the request is sent so an uncertain
 * network/server failure reuses the same Idempotency-Key and request payload
 * (including expected_edit_version) on retry.
 */
export const ORDER_ITEM_EDIT_ATTEMPT_STORAGE_KEY = 'flo.orders.item-edit.attempt.v1';

export const orderItemEditAttemptStorageKey = (
  tenantId: number | string,
  actorId: string,
  orderId: number | string,
  itemId: number | string,
): string =>
  `${ORDER_ITEM_EDIT_ATTEMPT_STORAGE_KEY}:${tenantId}:${actorId}:${orderId}:${itemId}`;

export type OrderItemEditAttemptMode = 'quantity' | 'replace';

export interface OrderItemEditAttemptBody {
  expected_edit_version: number;
  quantity?: number;
  replacement?: {
    product_id: string;
    quantity: number;
    variant_id?: string;
  };
  reason?: string;
}

export interface OrderItemEditAttemptSnapshot {
  mode: OrderItemEditAttemptMode;
  path: string;
  orderId: number;
  itemId: number;
  idempotencyKey: string;
  body: OrderItemEditAttemptBody;
  actorId: string;
  tenantId: number;
  createdAt: string;
}

/** Raised when attempt storage is unavailable or already holds a conflicting submission. */
export class OrderItemEditAttemptStorageError extends Error {
  constructor() {
    super('Order item edit attempt storage is unavailable');
    this.name = 'OrderItemEditAttemptStorageError';
  }
}

export function withOrderItemEditAttemptLock<T>(
  scopedKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return operation();
  }
  return navigator.locks.request(scopedKey, (lock) => {
    if (!lock) throw new OrderItemEditAttemptStorageError();
    return operation();
  }) as Promise<T>;
}

function attemptStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new OrderItemEditAttemptStorageError();
  }
  return window.localStorage;
}

function isSnapshot(value: unknown): value is OrderItemEditAttemptSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attempt = value as Partial<OrderItemEditAttemptSnapshot>;
  return (
    (attempt.mode === 'quantity' || attempt.mode === 'replace') &&
    typeof attempt.path === 'string' &&
    attempt.path.length > 0 &&
    typeof attempt.orderId === 'number' &&
    Number.isSafeInteger(attempt.orderId) &&
    typeof attempt.itemId === 'number' &&
    Number.isSafeInteger(attempt.itemId) &&
    typeof attempt.idempotencyKey === 'string' &&
    attempt.idempotencyKey.length > 0 &&
    typeof attempt.actorId === 'string' &&
    attempt.actorId.length > 0 &&
    typeof attempt.tenantId === 'number' &&
    Number.isSafeInteger(attempt.tenantId) &&
    !!attempt.body &&
    typeof attempt.body === 'object' &&
    !Array.isArray(attempt.body) &&
    typeof attempt.body.expected_edit_version === 'number' &&
    Number.isSafeInteger(attempt.body.expected_edit_version) &&
    attempt.body.expected_edit_version >= 0
  );
}

/** Builds a new attempt snapshot with a fresh Idempotency-Key. */
export function newOrderItemEditAttempt(input: {
  mode: OrderItemEditAttemptMode;
  path: string;
  orderId: number;
  itemId: number;
  body: OrderItemEditAttemptBody;
  actorId: string;
  tenantId: number;
}): OrderItemEditAttemptSnapshot {
  return {
    ...input,
    idempotencyKey: createPaymentIdempotencyKey(),
    createdAt: new Date().toISOString(),
  };
}

/** Reads the persisted attempt for (tenantId, actorId, orderId, itemId). */
export function readOrderItemEditAttempt(
  tenantId: number,
  actorId: string,
  orderId: number,
  itemId: number,
): OrderItemEditAttemptSnapshot | null {
  const scopedKey = orderItemEditAttemptStorageKey(tenantId, actorId, orderId, itemId);
  let raw: string | null;
  try {
    const storage = attemptStorage();
    raw = storage.getItem(scopedKey);
    if (raw === null) return null;
  } catch {
    throw new OrderItemEditAttemptStorageError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrderItemEditAttemptStorageError();
  }
  if (!isSnapshot(parsed)) throw new OrderItemEditAttemptStorageError();
  if (
    parsed.tenantId !== tenantId ||
    parsed.actorId !== actorId ||
    parsed.orderId !== orderId ||
    parsed.itemId !== itemId
  ) {
    throw new OrderItemEditAttemptStorageError();
  }
  return parsed;
}

/** Persists to an empty slot before the request is sent, verified by read-back. */
export function persistOrderItemEditAttempt(snapshot: OrderItemEditAttemptSnapshot): void {
  const scopedKey = orderItemEditAttemptStorageKey(
    snapshot.tenantId,
    snapshot.actorId,
    snapshot.orderId,
    snapshot.itemId,
  );
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    throw new OrderItemEditAttemptStorageError();
  }
  let stored = false;
  try {
    const storage = attemptStorage();
    if (storage.getItem(scopedKey) !== null) throw new OrderItemEditAttemptStorageError();
    storage.setItem(scopedKey, serialized);
    stored = storage.getItem(scopedKey) === serialized;
  } catch {
    stored = false;
  }
  if (!stored) throw new OrderItemEditAttemptStorageError();
}

/** Clears the slot once the mutation is confirmed committed or definitively rejected. */
export function clearOrderItemEditAttempt(
  tenantId: number,
  actorId: string,
  orderId: number,
  itemId: number,
  idempotencyKey: string,
): boolean {
  const scopedKey = orderItemEditAttemptStorageKey(tenantId, actorId, orderId, itemId);
  try {
    const storage = attemptStorage();
    const raw = storage.getItem(scopedKey);
    if (raw === null) return true;
    const parsed: unknown = JSON.parse(raw);
    if (isSnapshot(parsed) && parsed.idempotencyKey === idempotencyKey) {
      storage.removeItem(scopedKey);
      return storage.getItem(scopedKey) === null;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * True when a failure left the mutation outcome uncertain (network/timeout or 5xx),
 * requiring the attempt to stay locked so retries reuse the same key and body.
 */
export function isUnresolvedOrderItemEditFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === 'number') return status >= 500;
  return true;
}
