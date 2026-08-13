export const APPEND_ATTEMPT_STORAGE_KEY = 'flo.pos.append-items.attempt';
export const LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';
export const APPEND_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APPEND_ATTEMPT_USER_SUFFIX = '.user.';
const APPEND_ATTEMPT_COMPLETION_SUFFIX = '.completion.';
const confirmedAppendTombstones = new Map<string, number>();
const APPEND_ATTEMPT_COOKIE_PREFIX = 'flo_append_attempt.';

export function getAppendAttemptStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_USER_SUFFIX}${encodeURIComponent(userId)}`;
}

function getAppendAttemptCompletionStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_COMPLETION_SUFFIX}${encodeURIComponent(userId)}`;
}

function getConfirmedAppendTombstoneKey(userId: string, idempotencyKey: string, fingerprint: string): string {
  return `${userId}\u0000${idempotencyKey}\u0000${fingerprint}`;
}

function hasConfirmedAppendTombstone(
  userId: string,
  idempotencyKey: string,
  fingerprint: string,
  now: number,
  maxAgeMs: number,
): boolean {
  const key = getConfirmedAppendTombstoneKey(userId, idempotencyKey, fingerprint);
  const completedAt = confirmedAppendTombstones.get(key);
  if (completedAt === undefined) return false;
  if (isExpired(completedAt, now, maxAgeMs)) {
    confirmedAppendTombstones.delete(key);
    return false;
  }
  return true;
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

export function createCookieAppendAttemptStorage(): AppendAttemptStorage | null {
  if (typeof document === 'undefined') return null;
  const cookieName = (key: string) => `${APPEND_ATTEMPT_COOKIE_PREFIX}${encodeURIComponent(key)}`;
  const readCookie = (key: string): string | null => {
    const name = `${cookieName(key)}=`;
    const entry = document.cookie.split('; ').find((value) => value.startsWith(name));
    return entry ? decodeURIComponent(entry.slice(name.length)) : null;
  };
  return {
    getItem: readCookie,
    setItem: (key, value) => {
      document.cookie = `${cookieName(key)}=${encodeURIComponent(value)}; Max-Age=172800; Path=/; SameSite=Strict`;
      if (readCookie(key) !== value) throw new Error('Append retry state was not persisted');
    },
    removeItem: (key) => {
      document.cookie = `${cookieName(key)}=; Max-Age=0; Path=/; SameSite=Strict`;
      return readCookie(key) === null;
    },
  };
}

/** Wrap browser storage for append-attempt state. */
export function createSafeAppendAttemptStorage(
  storage: AppendAttemptStorage | null,
  ...fallbackStorages: Array<AppendAttemptStorage | null>
): AppendAttemptStorage {
  const memory = new Map<string, string | null>();
  const stores = [storage, ...fallbackStorages].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index) as AppendAttemptStorage[];
  return {
    getItem: (key) => {
      if (memory.has(key)) return memory.get(key) ?? null;
      for (const candidate of stores) {
        try {
          const persisted = candidate.getItem(key);
          if (persisted !== null && persisted !== undefined) return persisted;
        } catch {
          continue;
        }
      }
      return null;
    },
    setItem: (key, value) => {
      let persisted = false;
      for (const candidate of stores) {
        try {
          candidate.setItem(key, value);
          if (candidate.getItem(key) !== value) throw new Error('Append retry state was not persisted');
          persisted = true;
        } catch {
          continue;
        }
      }
      if (!persisted) {
        throw new Error('Unable to persist append retry state');
      }
      try {
        memory.set(key, value);
      } catch {
        throw new Error('Unable to persist append retry state');
      }
    },
    removeItem: (key) => {
      // A tombstone prevents a stale durable value from returning if cleanup
      // itself is blocked by the browser.
      memory.set(key, null);
      if (stores.length === 0) return false;
      let removed = true;
      for (const candidate of stores) {
        try {
          candidate.removeItem(key);
          if (candidate.getItem(key) !== null) removed = false;
        } catch {
          removed = false;
        }
      }
      return removed;
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

function removeAndVerify(storage: AppendAttemptStorage, key: string): boolean {
  const removed = storage.removeItem(key);
  return removed !== false && storage.getItem(key) === null;
}

function persistCompletionRecord(storage: AppendAttemptStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    if (storage.getItem(key) === value) return true;
  } catch {
  }
  const cookieStorage = createCookieAppendAttemptStorage();
  if (!cookieStorage) return false;
  try {
    cookieStorage.setItem(key, value);
    return cookieStorage.getItem(key) === value;
  } catch {
    return false;
  }
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

export class LegacyAppendAttemptConflictError extends Error {
  constructor() {
    super('A legacy append retry conflicts with the owner-scoped retry');
    this.name = 'LegacyAppendAttemptConflictError';
  }
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
  options: { now?: number; maxAgeMs?: number; userId?: string } = {},
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
    storage.removeItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    storage.removeItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY);
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
    if (!equivalent) {
      if (options.userId === parsed.userId) throw new LegacyAppendAttemptConflictError();
      return attempt;
    }
  }
  if (existingRaw === null) storage.setItem(scopedKey, JSON.stringify(attempt));
  if (!removeAndVerify(storage, LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY)) {
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

function appendAttemptsMatch(first: AppendAttempt, second: AppendAttempt): boolean {
  return first.userId === second.userId
    && first.orderId === second.orderId
    && first.fingerprint === second.fingerprint
    && first.idempotencyKey === second.idempotencyKey
    && JSON.stringify(first.items) === JSON.stringify(second.items)
    && (first.specialInstructions || undefined) === (second.specialInstructions || undefined);
}

function ensureCompletionStorage(storage: AppendAttemptStorage, userId: string): void {
  const markerKey = getAppendAttemptCompletionStorageKey(userId);
  const attemptKey = getAppendAttemptStorageKey(userId);
  const probe = JSON.stringify({ completed: true, userId, idempotencyKey: 'append-storage-probe', fingerprint: '{}', completedAt: Date.now() });
  try {
    storage.setItem(markerKey, probe);
    if (!removeAndVerify(storage, markerKey)) throw new Error('Completion marker cleanup was not persisted');
    return;
  } catch {
    try {
      storage.setItem(attemptKey, probe);
      if (!removeAndVerify(storage, attemptKey)) throw new Error('Completion fallback cleanup was not persisted');
    } catch {
      throw new Error('Unable to persist append retry state');
    }
  }
}

function readUserAttempt(
  storage: AppendAttemptStorage,
  userId: string,
  now: number,
  maxAgeMs: number,
): StoredAttempt | null {
  const scopedKey = getAppendAttemptStorageKey(userId);
  let migrated: AppendAttempt | null = null;
  try {
    migrated = migrateLegacyAppendAttempt(storage, { now, maxAgeMs, userId });
  } catch (error) {
    if (!(error instanceof LegacyAppendAttemptConflictError)) throw error;
  }
  if (hasCompletedAttempt(storage, userId, now, maxAgeMs)) return null;
  const scoped = parseStoredAttempt(storage, scopedKey, now, maxAgeMs);
  if (scoped && hasConfirmedAppendTombstone(userId, scoped.idempotencyKey, scoped.fingerprint, now, maxAgeMs)) return null;
  const legacy = parseStoredAttempt(storage, APPEND_ATTEMPT_STORAGE_KEY, now, maxAgeMs);
  if (legacy?.userId === userId) {
    if (scoped && scoped.userId === userId && !appendAttemptsMatch(scoped, legacy)) return { attempt: scoped, key: scopedKey };
    if (!scoped) storage.setItem(scopedKey, JSON.stringify(legacy));
    if (!removeAndVerify(storage, APPEND_ATTEMPT_STORAGE_KEY)) {
      throw new Error('Unable to complete append retry migration');
    }
    return { attempt: scoped || legacy, key: scopedKey };
  }

  if (scoped?.userId === userId) return { attempt: scoped, key: scopedKey };
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
  ensureCompletionStorage(storage, options.userId);

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
    const serializedCompletion = JSON.stringify(completionRecord);
    markerPersisted = persistCompletionRecord(storage, markerKey, serializedCompletion);
    if (!markerPersisted) {
      markerPersisted = persistCompletionRecord(storage, key, serializedCompletion);
    }
    if (markerPersisted) {
      confirmedAppendTombstones.set(
        getConfirmedAppendTombstoneKey(completedAttempt.userId, completedAttempt.idempotencyKey, completedAttempt.fingerprint),
        Date.now(),
      );
    }
    const removed = storage.removeItem(key);
    if (removed !== false && storage.getItem(key) === null && markerPersisted) storage.removeItem(markerKey);
  } catch {
    return;
  }
}
