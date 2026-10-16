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
): string => `${ORDER_ITEM_EDIT_ATTEMPT_STORAGE_KEY}:${tenantId}:${actorId}:${orderId}:${itemId}`;

export type OrderItemEditAttemptMode = 'quantity' | 'replace';

export interface OrderItemEditAttemptBody {
  expected_edit_version: number;
  quantity?: number;
  replacement?: {
    product_id: string;
    quantity: number;
    variant_id?: string;
    addons?: Array<{
      id?: string | number;
      name?: string;
      price?: number;
      quantity?: number;
    }>;
    special_instructions?: string;
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

/** Canonical PATCH path for an item edit; stored URLs are never trusted. */
export const orderItemEditCanonicalPath = (orderId: number, itemId: number): string =>
  `/orders/${orderId}/items/${itemId}/edit`;

/** Outcome of a replayed saved edit, from the domain's single classifier. */
export type OrderItemEditReplayOutcome =
  | 'committed'
  | 'rejected'
  | 'authRequired'
  | 'forbidden'
  | 'rateLimited'
  | 'unresolved';

export type OrderItemEditReplayResult<O> =
  | { outcome: 'committed'; data: O }
  | {
      outcome: Exclude<OrderItemEditReplayOutcome, 'committed'>;
      data?: undefined;
      error: unknown;
    };

export interface OrderItemEditAttemptList {
  attempts: OrderItemEditAttemptSnapshot[];
  /** Records in scope that are unreadable or out-of-contract; left intact. */
  hasUnreadableRecords: boolean;
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
  notifyOrderItemEditAttemptsChanged({
    tenantId: snapshot.tenantId,
    actorId: snapshot.actorId,
    orderId: snapshot.orderId,
  });
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
      const removed = storage.getItem(scopedKey) === null;
      if (removed) {
        notifyOrderItemEditAttemptsChanged({ tenantId, actorId, orderId });
      }
      return removed;
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

/**
 * Classifies a replay/save failure into the domain's outcome set. 401/403/429
 * cannot establish that a saved edit committed, so their records stay; only a
 * definitive route rejection or an observed commit clears them.
 */
export function classifyOrderItemEditFailure(
  error: unknown,
): Exclude<OrderItemEditReplayOutcome, 'committed'> {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  if (typeof status !== 'number') return 'unresolved';
  if (status === 401) return 'authRequired';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'unresolved';
  return 'rejected';
}

const ATTEMPTS_CHANGED_EVENT = 'flo.orders.item-edit.attempt.changed';

export interface OrderItemEditAttemptScope {
  tenantId: number;
  actorId: string;
  orderId: number;
}

/** Announces a same-tab persistence/clear; event details carry scope IDs only. */
export function notifyOrderItemEditAttemptsChanged(scope: OrderItemEditAttemptScope): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(
      new CustomEvent(ATTEMPTS_CHANGED_EVENT, {
        detail: { tenantId: scope.tenantId, actorId: scope.actorId, orderId: scope.orderId },
      }),
    );
  } catch {
    // Notifications are never worth breaking a save/clear over.
  }
}

function attemptsChangedEventMatches(
  event: Event,
  scope: OrderItemEditAttemptScope | null,
): boolean {
  if (event.type === ATTEMPTS_CHANGED_EVENT) {
    if (!scope) return true;
    const detail = (event as CustomEvent<{ tenantId?: number; actorId?: string; orderId?: number }>)
      .detail;
    return (
      detail?.tenantId === scope.tenantId &&
      detail?.actorId === scope.actorId &&
      detail?.orderId === scope.orderId
    );
  }
  if (event.type === 'storage') {
    if (!scope) return true;
    const key = (event as StorageEvent).key;
    if (key === null) return true;
    return key.startsWith(
      orderItemEditAttemptStorageKey(scope.tenantId, scope.actorId, scope.orderId, ''),
    );
  }
  return false;
}

/**
 * Listens for attempt changes in the current tab (custom event) and other tabs
 * (storage event) within one scope. Returns an unsubscribe function.
 */
export function subscribeOrderItemEditAttemptsChanged(
  scope: OrderItemEditAttemptScope | null,
  handler: () => void,
): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined;
  }
  const listener = (event: Event) => {
    if (attemptsChangedEventMatches(event, scope)) handler();
  };
  window.addEventListener(ATTEMPTS_CHANGED_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(ATTEMPTS_CHANGED_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

const scopedKeyPrefix = (tenantId: number, actorId: string, orderId: number): string =>
  `${ORDER_ITEM_EDIT_ATTEMPT_STORAGE_KEY}:${tenantId}:${actorId}:${orderId}:`;

/** The edit contract accepts positive finite quantities; fractional support is
 * product-dependent (sale unit and precision) and enforced by the backend, so
 * storage validation must not approximate that product context. */
function quantityIsValid(quantity: unknown): boolean {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0;
}

/** Validates the body's operation against its declared mode without trusting callers. */
function bodyOperationIsValid(snapshot: OrderItemEditAttemptSnapshot): boolean {
  if (snapshot.mode === 'quantity') {
    return quantityIsValid(snapshot.body.quantity) && snapshot.body.replacement === undefined;
  }
  const replacement = snapshot.body.replacement;
  return (
    !!replacement &&
    typeof replacement.product_id === 'string' &&
    replacement.product_id.length > 0 &&
    quantityIsValid(replacement.quantity)
  );
}

function storageKeys(storage: Storage): Array<string | null> {
  const keys: Array<string | null> = [];
  const enumerable = storage as unknown as { length?: unknown };
  if (typeof enumerable.length === 'number') {
    for (let index = 0; index < (enumerable as { length: number }).length; index += 1) {
      keys.push(storage.key(index));
    }
    return keys;
  }
  if (Array.isArray((enumerable as { keys?: unknown }).keys)) {
    return [...(enumerable as { keys: string[] }).keys];
  }
  throw new OrderItemEditAttemptStorageError();
}

/**
 * Enumerates every recoverable saved edit for one tenant/actor/order, without
 * touching or deleting records it cannot understand. A correction is offered
 * only when the record validates against the exact key suffix it was found
 * under and the canonical PATCH path derived from those IDs.
 */
export function listOrderItemEditAttempts(
  tenantId: number,
  actorId: string,
  orderId: number,
): OrderItemEditAttemptList {
  let storage: Storage;
  try {
    storage = attemptStorage();
  } catch {
    throw new OrderItemEditAttemptStorageError();
  }
  const prefix = scopedKeyPrefix(tenantId, actorId, orderId);
  const attempts: OrderItemEditAttemptSnapshot[] = [];
  let hasUnreadableRecords = false;

  for (const key of storageKeys(storage)) {
    if (!key || !key.startsWith(prefix)) continue;
    const itemId = Number(key.slice(prefix.length));
    let raw: string | null = null;
    let parsed: unknown = null;
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      hasUnreadableRecords = true;
      continue;
    }
    try {
      raw = storage.getItem(key);
    } catch {
      hasUnreadableRecords = true;
      continue;
    }
    if (raw === null) continue;
    try {
      parsed = JSON.parse(raw);
    } catch {
      hasUnreadableRecords = true;
      continue;
    }
    if (!isSnapshot(parsed)) {
      hasUnreadableRecords = true;
      continue;
    }
    const snapshot = parsed as OrderItemEditAttemptSnapshot;
    if (
      snapshot.tenantId !== tenantId ||
      snapshot.actorId !== actorId ||
      snapshot.orderId !== orderId ||
      snapshot.itemId !== itemId ||
      snapshot.path !== orderItemEditCanonicalPath(orderId, itemId) ||
      !bodyOperationIsValid(snapshot)
    ) {
      hasUnreadableRecords = true;
      continue;
    }
    attempts.push(snapshot);
  }

  attempts.sort((a, b) => a.itemId - b.itemId);
  return { attempts, hasUnreadableRecords };
}

/**
 * True when two snapshots carry the same identity (tenant/actor/order/item),
 * mode, body operation, and idempotency key. Used to verify that a re-read
 * record still matches the offered operation before sending.
 */
export function orderItemEditAttemptsEquivalent(
  a: OrderItemEditAttemptSnapshot,
  b: OrderItemEditAttemptSnapshot,
): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.actorId === b.actorId &&
    a.orderId === b.orderId &&
    a.itemId === b.itemId &&
    a.mode === b.mode &&
    a.idempotencyKey === b.idempotencyKey &&
    a.path === b.path &&
    attemptBodiesMatch(a.body, b.body)
  );
}

function attemptBodiesMatch(a: OrderItemEditAttemptBody, b: OrderItemEditAttemptBody): boolean {
  if (
    a.expected_edit_version !== b.expected_edit_version ||
    a.quantity !== b.quantity ||
    (a.reason ?? '') !== (b.reason ?? '')
  ) {
    return false;
  }
  if (a.replacement === undefined || b.replacement === undefined) {
    return a.replacement === b.replacement;
  }
  const aAddons = (a.replacement.addons ?? []).map((x) => ({
    id: String(x.id ?? ''),
    quantity: x.quantity ?? 1,
  }));
  const bAddons = (b.replacement.addons ?? []).map((x) => ({
    id: String(x.id ?? ''),
    quantity: x.quantity ?? 1,
  }));
  return (
    a.replacement.product_id === b.replacement.product_id &&
    a.replacement.quantity === b.replacement.quantity &&
    (a.replacement.variant_id ?? '') === (b.replacement.variant_id ?? '') &&
    (a.replacement.special_instructions ?? '') === (b.replacement.special_instructions ?? '') &&
    JSON.stringify(aAddons) === JSON.stringify(bAddons)
  );
}

/** Sending callback injected by callers so storage tests never need the HTTP client. */
export type OrderItemEditSender<O = unknown> = (
  path: string,
  body: OrderItemEditAttemptBody,
  idempotencyKey: string,
) => Promise<O>;

/**
 * Stored-request replay of one saved edit.
 *
 * Sends the stored path, body, and idempotency key as-is through the injected
 * sender and classifies the outcome. Whether the record is cleared afterwards
 * is a separate, scope-checked decision by the caller (clearOrderItemEditAttempt).
 */
export async function replayOrderItemEditAttempt<O = unknown>(options: {
  snapshot: OrderItemEditAttemptSnapshot;
  send: OrderItemEditSender<O>;
}): Promise<OrderItemEditReplayResult<O>> {
  try {
    const data = await options.send(
      options.snapshot.path,
      options.snapshot.body,
      options.snapshot.idempotencyKey,
    );
    return { outcome: 'committed', data };
  } catch (error) {
    return { outcome: classifyOrderItemEditFailure(error), error };
  }
}
