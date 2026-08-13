export const APPEND_ATTEMPT_STORAGE_KEY = 'flo.pos.append-items.attempt';
export const LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';
export const APPEND_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APPEND_ATTEMPT_COMPLETION_SUFFIX = '.completed';

export function getAppendAttemptStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}.${encodeURIComponent(userId)}`;
}

function getAppendAttemptCompletionStorageKey(userId: string): string {
  return `${getAppendAttemptStorageKey(userId)}${APPEND_ATTEMPT_COMPLETION_SUFFIX}`;
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
  removeItem: (key: string) => void | boolean;
}

/** Wrap browser storage for append-attempt state. */
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
      if (!storage) throw new Error('Unable to persist append retry state');
      try {
        storage.setItem(key, value);
        if (storage.getItem(key) !== value) throw new Error('Append retry state was not persisted');
        memory.set(key, value);
      } catch {
        throw new Error('Unable to persist append retry state');
      }
    },
    removeItem: (key) => {
      // A tombstone prevents a stale durable value from returning if cleanup
      // itself is blocked by the browser.
      memory.set(key, null);
      if (!storage) return false;
      try {
        storage.removeItem(key);
        return storage.getItem(key) === null;
      } catch {
        return false;
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

function normalizeAppendFingerprint(fingerprint: string): string | null {
  try {
    const payload = JSON.parse(fingerprint) as {
      order_id?: unknown;
      items?: unknown;
      special_instructions?: unknown;
    };
    if (
      (typeof payload.order_id !== 'string' && typeof payload.order_id !== 'number')
      || !Array.isArray(payload.items)
    ) return null;
    return buildAppendItemsFingerprint(
      String(payload.order_id),
      payload.items,
      typeof payload.special_instructions === 'string' ? payload.special_instructions || undefined : undefined,
    );
  } catch {
    return null;
  }
}

interface AppendAttemptCompletion {
  userId: string;
  idempotencyKey: string;
  fingerprint: string;
  completedAt: number;
}

function isCompletionRecord(value: Partial<AppendAttemptCompletion> & { completed?: unknown }): boolean {
  return value.completed === true
    && typeof value.userId === 'string'
    && typeof value.idempotencyKey === 'string'
    && typeof value.fingerprint === 'string'
    && typeof value.completedAt === 'number';
}

function completedAttemptMatches(
  storage: AppendAttemptStorage,
  attemptKey: string,
  completion: AppendAttemptCompletion,
): boolean {
  const raw = storage.getItem(attemptKey);
  if (!raw) {
    storage.removeItem(getAppendAttemptCompletionStorageKey(completion.userId));
    return true;
  }
  try {
    const current = JSON.parse(raw) as Partial<AppendAttempt>;
    if (current.idempotencyKey !== completion.idempotencyKey || current.fingerprint !== completion.fingerprint) return false;
    const removed = storage.removeItem(attemptKey);
    if (removed !== false && storage.getItem(attemptKey) === null) {
      storage.removeItem(getAppendAttemptCompletionStorageKey(completion.userId));
    }
    return true;
  } catch {
    return true;
  }
}

function hasCompletedAttempt(
  storage: AppendAttemptStorage,
  userId: string,
  now: number,
  maxAgeMs: number,
): boolean {
  const markerKey = getAppendAttemptCompletionStorageKey(userId);
  const raw = storage.getItem(markerKey);
  if (!raw) return false;
  try {
    const completion = JSON.parse(raw) as Partial<AppendAttemptCompletion>;
    if (
      completion.userId !== userId
      || typeof completion.idempotencyKey !== 'string'
      || !isValidIdempotencyKey(completion.idempotencyKey)
      || typeof completion.fingerprint !== 'string'
      || typeof completion.completedAt !== 'number'
      || isExpired(completion.completedAt, now, maxAgeMs)
    ) {
      storage.removeItem(markerKey);
      return false;
    }
    return completedAttemptMatches(storage, getAppendAttemptStorageKey(userId), completion as AppendAttemptCompletion);
  } catch {
    storage.removeItem(markerKey);
    return false;
  }
}

export function migrateLegacyAppendAttempt(
  storage: AppendAttemptStorage,
  options: { now?: number; maxAgeMs?: number } = {},
): AppendAttempt | null {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? APPEND_ATTEMPT_MAX_AGE_MS;
  const raw = storage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY);
  if (!raw) return null;

  let parsed: {
    userId?: unknown;
    fingerprint?: unknown;
    idempotencyKey?: unknown;
    createdAt?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.userId !== 'string' || typeof parsed.fingerprint !== 'string') return null;
  const normalizedFingerprint = normalizeAppendFingerprint(parsed.fingerprint);
  if (!normalizedFingerprint) return null;
  if (typeof parsed.idempotencyKey !== 'string' || !isValidIdempotencyKey(parsed.idempotencyKey)) {
    storage.removeItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY);
    return null;
  }
  const payload = JSON.parse(parsed.fingerprint) as {
    order_id: string | number;
    items: unknown[];
    special_instructions?: unknown;
  };
  const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : now;
  if (isExpired(createdAt, now, maxAgeMs)) {
    storage.removeItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY);
    return null;
  }
  const scopedKey = getAppendAttemptStorageKey(parsed.userId);
  const existingRaw = storage.getItem(scopedKey);
  const attempt: AppendAttempt = {
    userId: parsed.userId,
    orderId: String(payload.order_id),
    fingerprint: normalizedFingerprint,
    idempotencyKey: parsed.idempotencyKey,
    items: payload.items,
    specialInstructions: typeof payload.special_instructions === 'string' ? payload.special_instructions || undefined : undefined,
    createdAt,
  };
  if (existingRaw !== null) {
    let existing: Partial<AppendAttempt> | null = null;
    try { existing = JSON.parse(existingRaw) as Partial<AppendAttempt>; } catch { existing = null; }
    const equivalent = !!existing
      && existing.userId === attempt.userId
      && String(existing.orderId) === attempt.orderId
      && existing.idempotencyKey === attempt.idempotencyKey
      && typeof existing.fingerprint === 'string'
      && normalizeAppendFingerprint(existing.fingerprint) === attempt.fingerprint
      && Array.isArray(existing.items)
      && JSON.stringify(existing.items) === JSON.stringify(attempt.items)
      && (existing.specialInstructions || undefined) === (attempt.specialInstructions || undefined)
      && typeof existing.createdAt === 'number';
    if (!equivalent) throw new Error('Unable to migrate legacy append retry state safely');
  }
  if (existingRaw === null) storage.setItem(scopedKey, JSON.stringify(attempt));
  if (storage.removeItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY) === false) {
    throw new Error('Unable to complete legacy append retry migration');
  }
  return attempt;
}

function parseStoredAttempt(storage: AppendAttemptStorage, key: string, now: number, maxAgeMs: number): AppendAttempt | null {
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AppendAttempt>;
    if (isCompletionRecord(parsed as Partial<AppendAttemptCompletion> & { completed?: unknown })) return null;
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
  const migrated = migrateLegacyAppendAttempt(storage, { now, maxAgeMs });
  if (hasCompletedAttempt(storage, userId, now, maxAgeMs)) return null;
  const scoped = parseStoredAttempt(storage, scopedKey, now, maxAgeMs);
  if (scoped?.userId === userId) return { attempt: scoped, key: scopedKey };

  // Migrate the pre-user-scoped key only when it belongs to this user. A
  // different cashier's pending retry is deliberately left intact.
  const legacy = parseStoredAttempt(storage, APPEND_ATTEMPT_STORAGE_KEY, now, maxAgeMs);
  if (legacy?.userId === userId) {
    storage.setItem(scopedKey, JSON.stringify(legacy));
    storage.removeItem(APPEND_ATTEMPT_STORAGE_KEY);
    return { attempt: legacy, key: scopedKey };
  }

  if (migrated?.userId === userId) return { attempt: migrated, key: scopedKey };
  return null;
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
    const markerKey = getAppendAttemptCompletionStorageKey(completedAttempt.userId);
    const completionRecord = {
      completed: true,
      userId: completedAttempt.userId,
      idempotencyKey: completedAttempt.idempotencyKey,
      fingerprint: completedAttempt.fingerprint,
      completedAt: Date.now(),
    };
    let markerPersisted = false;
    try {
      storage.setItem(markerKey, JSON.stringify(completionRecord));
      markerPersisted = true;
    } catch {
      markerPersisted = false;
    }
    if (!markerPersisted) {
      try {
        storage.setItem(key, JSON.stringify(completionRecord));
        markerPersisted = true;
      } catch {
        markerPersisted = false;
      }
    }
    const removed = storage.removeItem(key);
    if (removed !== false && storage.getItem(key) === null && markerPersisted) storage.removeItem(markerKey);
  } catch {
    return;
  }
}
