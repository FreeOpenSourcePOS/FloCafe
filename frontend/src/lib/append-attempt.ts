export const APPEND_ATTEMPT_STORAGE_KEY = 'flo.pos.append-items.attempt';
export const APPEND_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getAppendAttemptStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}.${encodeURIComponent(userId)}`;
}

export interface AppendAttempt {
  userId: string;
  orderId: string;
  fingerprint: string;
  idempotencyKey: string;
  items: unknown[];
  specialInstructions?: string;
  orderNumber?: string;
  createdAt: number;
}

export interface AppendAttemptStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * Keep the append path compatible with renderers where localStorage is blocked
 * or full. The memory layer preserves same-renderer retries; durable storage
 * is best effort and is used whenever the browser permits it.
 */
export function createSafeAppendAttemptStorage(storage: AppendAttemptStorage | null): AppendAttemptStorage {
  const memory = new Map<string, string | null>();
  return {
    getItem: (key) => {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        const persisted = storage?.getItem(key);
        if (persisted !== null && persisted !== undefined) return persisted;
      } catch {
        // Fall back to the in-memory copy.
      }
      return null;
    },
    setItem: (key, value) => {
      memory.set(key, value);
      try {
        storage?.setItem(key, value);
      } catch {
        // The request can still proceed with the in-memory retry key.
      }
    },
    removeItem: (key) => {
      // A tombstone prevents a stale durable value from returning if cleanup
      // itself is blocked by the browser.
      memory.set(key, null);
      try {
        storage?.removeItem(key);
      } catch {
        // Best-effort cleanup; the tombstone keeps same-renderer reads safe.
      }
    },
  };
}

interface AppendAttemptOptions {
  userId: string;
  orderId: number | string;
  fingerprint: string;
  createKey: () => string;
  items: unknown[];
  specialInstructions?: string;
  orderNumber?: string;
  now?: number;
  maxAgeMs?: number;
}

/**
 * Match the request shape used by POST /orders/:id/items. The fingerprint is
 * local state only; the server still validates the actual request body against
 * its Idempotency-Key record.
 */
export function buildAppendItemsFingerprint(
  orderId: number | string,
  items: unknown[],
  specialInstructions?: string,
): string {
  return JSON.stringify({
    order_id: String(orderId),
    items,
    special_instructions: specialInstructions || undefined,
  });
}

function isValidIdempotencyKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && /^[\x21-\x7e]+$/.test(key);
}

function isExpired(createdAt: number, now: number, maxAgeMs: number): boolean {
  return !Number.isFinite(createdAt) || now - createdAt >= maxAgeMs;
}

function parseStoredAttempt(storage: AppendAttemptStorage, key: string, now: number, maxAgeMs: number): AppendAttempt | null {
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AppendAttempt>;
    if (
      !parsed
      || typeof parsed.userId !== 'string'
      || typeof parsed.orderId !== 'string'
      || typeof parsed.fingerprint !== 'string'
      || typeof parsed.idempotencyKey !== 'string'
      || !isValidIdempotencyKey(parsed.idempotencyKey)
      || !Array.isArray(parsed.items)
      || (parsed.specialInstructions !== undefined && typeof parsed.specialInstructions !== 'string')
      || (parsed.orderNumber !== undefined && typeof parsed.orderNumber !== 'string')
      || typeof parsed.createdAt !== 'number'
      || isExpired(parsed.createdAt, now, maxAgeMs)
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed as AppendAttempt;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

interface StoredAttempt {
  attempt: AppendAttempt;
  key: string;
}

function readUserAttempt(
  storage: AppendAttemptStorage,
  userId: string,
  now: number,
  maxAgeMs: number,
): StoredAttempt | null {
  const scopedKey = getAppendAttemptStorageKey(userId);
  const scoped = parseStoredAttempt(storage, scopedKey, now, maxAgeMs);
  if (scoped?.userId === userId) return { attempt: scoped, key: scopedKey };

  // Migrate the pre-user-scoped key only when it belongs to this user. A
  // different cashier's pending retry is deliberately left intact.
  const legacy = parseStoredAttempt(storage, APPEND_ATTEMPT_STORAGE_KEY, now, maxAgeMs);
  if (legacy?.userId !== userId) return null;
  storage.setItem(scopedKey, JSON.stringify(legacy));
  storage.removeItem(APPEND_ATTEMPT_STORAGE_KEY);
  return { attempt: legacy, key: scopedKey };
}

/** Read a pending attempt for automatic recovery after a renderer reload. */
export function readAppendAttempt(
  storage: AppendAttemptStorage,
  options: { userId: string; now?: number; maxAgeMs?: number },
): AppendAttempt | null {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? APPEND_ATTEMPT_MAX_AGE_MS;
  return readUserAttempt(storage, options.userId, now, maxAgeMs)?.attempt || null;
}

/**
 * Recover the durable attempt for the same logical append. A conflicting
 * pending attempt is retained until it is completed or expires.
 */
export function getOrCreateAppendAttempt(
  storage: AppendAttemptStorage,
  options: AppendAttemptOptions,
): AppendAttempt {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? APPEND_ATTEMPT_MAX_AGE_MS;
  const orderId = String(options.orderId);
  const prior = readUserAttempt(storage, options.userId, now, maxAgeMs);

  if (
    prior
    && prior.attempt.orderId === orderId
    && prior.attempt.fingerprint === options.fingerprint
  ) {
    return prior.attempt;
  }

  if (prior) {
    throw new Error('A previous append attempt is still pending');
  }

  const idempotencyKey = options.createKey();
  if (!isValidIdempotencyKey(idempotencyKey)) {
    throw new Error('Unable to create a valid append idempotency key');
  }

  const attempt: AppendAttempt = {
    userId: options.userId,
    orderId,
    fingerprint: options.fingerprint,
    idempotencyKey,
    items: options.items,
    specialInstructions: options.specialInstructions,
    orderNumber: options.orderNumber,
    createdAt: now,
  };
  storage.setItem(getAppendAttemptStorageKey(options.userId), JSON.stringify(attempt));
  return attempt;
}

/** Clear only after the mutating request has returned a confirmed response. */
export function clearAppendAttempt(
  storage: AppendAttemptStorage,
  completedAttempt: Pick<AppendAttempt, 'userId' | 'idempotencyKey' | 'fingerprint'>,
): void {
  const key = getAppendAttemptStorageKey(completedAttempt.userId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return;
    const current = JSON.parse(raw) as Partial<AppendAttempt>;
    if (
      current.idempotencyKey !== completedAttempt.idempotencyKey
      || current.fingerprint !== completedAttempt.fingerprint
    ) return;
    storage.removeItem(key);
  } catch {
    // Storage cleanup is best effort; leaving the key is safe because a future
    // matching request replays it and a changed/expired request replaces it.
  }
}
