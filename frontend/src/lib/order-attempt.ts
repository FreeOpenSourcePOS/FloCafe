import type { AppendAttemptStorage } from './append-attempt';

export const PREPAID_ATTEMPT_STORAGE_KEY = 'flo.prepaid.checkout.attempt';

/** Raised when new-order attempt state cannot be durably read or written.
 * Callers must not send the order request when this is thrown. */
export class OrderAttemptStorageError extends Error {
  constructor() {
    super('Order attempt storage is unavailable');
    this.name = 'OrderAttemptStorageError';
  }
}

interface StoredOrderAttempt {
  userId: string;
}

/** Read an attempt back from the durable store. Fails closed rather than
 * reporting "no attempt" when the stored value cannot be trusted, so a caller
 * never starts a second order under a fresh idempotency key. */
export function readOrderAttempt<T extends StoredOrderAttempt>(
  storage: AppendAttemptStorage,
  key: string,
  userId: string,
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
    clearOrderAttempt(storage, key);
    return null;
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as StoredOrderAttempt).userId !== userId
  ) {
    clearOrderAttempt(storage, key);
    return null;
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

/** Cleanup is best-effort: a stale retry record must never fail a placed order. */
export function clearOrderAttempt(storage: AppendAttemptStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
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
