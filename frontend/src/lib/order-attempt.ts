import type { AppendAttemptStorage } from './append-attempt';

/** Global key used by builds before prepaid attempts became user scoped. */
export const PREPAID_ATTEMPT_STORAGE_KEY = 'flo.prepaid.checkout.attempt';
const ORDER_ATTEMPT_USER_SUFFIX = '.user.';

/** Raised when new-order attempt state cannot be durably read or written.
 * Callers must not send the order request when this is thrown. */
export class OrderAttemptStorageError extends Error {
  constructor() {
    super('Order attempt storage is unavailable');
    this.name = 'OrderAttemptStorageError';
  }
}

export interface StoredOrderAttempt {
  userId: string;
}

interface CompletedOrderAttempt {
  completed: true;
  userId: string;
  completedAt: number;
}

/** Prepaid attempts are user scoped. A single shared key let one cashier's read
 * drop another cashier's pending retry, which hands a possibly committed
 * request a fresh idempotency key. */
export function getPrepaidOrderAttemptStorageKey(userId: string): string {
  return `${PREPAID_ATTEMPT_STORAGE_KEY}${ORDER_ATTEMPT_USER_SUFFIX}${encodeURIComponent(userId)}`;
}

function isCompletedAttempt(value: unknown): value is CompletedOrderAttempt {
  return !!value
    && typeof value === 'object'
    && (value as { completed?: unknown }).completed === true;
}

interface ReadOrderAttemptOptions<T extends StoredOrderAttempt> {
  /** Set for global keys written before attempts were user scoped. Those keys
   * are shared, so a foreign or unreadable value means "not mine" instead of
   * "damaged", and mutating it would drop another cashier's pending retry. */
  sharedKey?: boolean;
  /** Structural check for the fields the caller needs. A record that fails it
   * is damaged, not absent. */
  isValid?: (attempt: T) => boolean;
}

/** Read an attempt back from the durable store. Fails closed rather than
 * reporting "no attempt" when the stored value cannot be trusted, so a caller
 * never starts a second order under a fresh idempotency key. */
export function readOrderAttempt<T extends StoredOrderAttempt>(
  storage: AppendAttemptStorage,
  key: string,
  userId: string,
  options: ReadOrderAttemptOptions<T> = {},
): T | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new OrderAttemptStorageError();
  }
  if (storage.hasUnverifiedRead?.(key)) throw new OrderAttemptStorageError();
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (options.sharedKey) return null;
    throw new OrderAttemptStorageError();
  }
  if (isCompletedAttempt(parsed)) {
    // The order was confirmed; this record only survived because cleanup could
    // not delete it. Its keys must never be reused for a later sale.
    if (parsed.userId === userId) clearOrderAttempt(storage, key, parsed);
    return null;
  }
  const usable = !!parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as StoredOrderAttempt).userId === userId
    && (options.isValid?.(parsed as T) ?? true);
  if (!usable) {
    if (options.sharedKey) return null;
    throw new OrderAttemptStorageError();
  }
  return parsed as T;
}

/** Persist an attempt before its request is sent, through the safe storage
 * wrapper's verified write. Throws when no backend accepted the value. */
export function persistOrderAttempt(
  storage: AppendAttemptStorage,
  key: string,
  attempt: StoredOrderAttempt,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(attempt);
  } catch {
    throw new OrderAttemptStorageError();
  }
  try {
    storage.setItem(key, serialized);
  } catch {
    throw new OrderAttemptStorageError();
  }
}

/** Close an attempt whose response was confirmed. The completion marker is
 * stored before removal so a record the browser refuses to delete is still
 * never read back as a reusable attempt. Returns false when not even the marker
 * could be stored, which the caller reports as a storage problem. */
export function clearOrderAttempt(
  storage: AppendAttemptStorage,
  key: string,
  attempt: StoredOrderAttempt,
): boolean {
  const marker: CompletedOrderAttempt = {
    completed: true,
    userId: attempt.userId,
    completedAt: Date.now(),
  };
  const serializedMarker = JSON.stringify(marker);
  let markerPersisted = false;
  try {
    storage.setItem(key, serializedMarker);
    markerPersisted = storage.getItem(key) === serializedMarker;
  } catch {
    markerPersisted = false;
  }
  let removed = false;
  try {
    removed = storage.removeItem(key) !== false;
  } catch {
    removed = false;
  }
  const removalVerified = removed && !storage.hasUnverifiedRemoval?.(key);
  return removalVerified || markerPersisted;
}

/** Bounded, payload-free classification of a failed order request. */
export function classifyOrderRequestFailure(error: unknown): { code: string; detail: string; status: number | null } {
  const status = Number((error as { response?: { status?: unknown } })?.response?.status);
  if (Number.isInteger(status) && status > 0) {
    return { code: 'order.place.rejected', detail: `Order rejected by the local server (HTTP ${status})`, status };
  }
  if ((error as { isAxiosError?: unknown })?.isAxiosError === true) {
    return { code: 'order.place.unreachable', detail: 'The order request did not reach the local server', status: null };
  }
  return { code: 'order.place.failed', detail: 'The order could not be completed on this device', status: null };
}
