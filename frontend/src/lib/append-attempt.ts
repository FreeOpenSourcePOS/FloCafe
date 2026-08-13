export const APPEND_ATTEMPT_STORAGE_KEY = 'flo.pos.append-items.attempt';
export const LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';
export const APPEND_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APPEND_ATTEMPT_USER_SUFFIX = '.user.';
const APPEND_ATTEMPT_COMPLETION_SUFFIX = '.completion.';
const APPEND_ATTEMPT_COMPLETION_RETRY_SUFFIX = '.completion-retry.';
const APPEND_ATTEMPT_COMPLETION_COOKIE_SUFFIX = '.completion-cookie.';
const CONFIRMED_APPEND_TOMBSTONE_LIMIT = 256;
const confirmedAppendTombstones = new Map<string, { completedAt: number; fingerprintHash: string }>();
const APPEND_ATTEMPT_COOKIE_PREFIX = 'flo_append_attempt.';

export function getAppendAttemptStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_USER_SUFFIX}${encodeURIComponent(userId)}`;
}

export function getPostpaidOrderAttemptStorageKey(userId: string): string {
  return `${LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_USER_SUFFIX}${encodeURIComponent(userId)}`;
}

function getAppendAttemptCompletionStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_COMPLETION_SUFFIX}${encodeURIComponent(userId)}`;
}

function getAppendAttemptCompletionRetryStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_COMPLETION_RETRY_SUFFIX}${encodeURIComponent(userId)}`;
}

function getAppendAttemptCompletionCookieStorageKey(userId: string): string {
  return `${APPEND_ATTEMPT_STORAGE_KEY}${APPEND_ATTEMPT_COMPLETION_COOKIE_SUFFIX}${encodeURIComponent(userId)}`;
}

function getConfirmedAppendTombstoneKey(userId: string, idempotencyKey: string): string {
  return `${userId}\u0000${idempotencyKey}`;
}

function getFingerprintHash(fingerprint: string): string {
  let hash = 2166136261;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function pruneConfirmedAppendTombstones(now: number, maxAgeMs: number): void {
  for (const [key, tombstone] of confirmedAppendTombstones) {
    if (isExpired(tombstone.completedAt, now, maxAgeMs)) confirmedAppendTombstones.delete(key);
  }
  while (confirmedAppendTombstones.size > CONFIRMED_APPEND_TOMBSTONE_LIMIT) {
    const oldest = confirmedAppendTombstones.keys().next().value;
    if (oldest === undefined) break;
    confirmedAppendTombstones.delete(oldest);
  }
}

function hasConfirmedAppendTombstone(
  userId: string,
  idempotencyKey: string,
  fingerprint: string,
  now: number,
  maxAgeMs: number,
): boolean {
  pruneConfirmedAppendTombstones(now, maxAgeMs);
  const tombstone = confirmedAppendTombstones.get(getConfirmedAppendTombstoneKey(userId, idempotencyKey));
  return tombstone?.fingerprintHash === getFingerprintHash(fingerprint);
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
  hasUnverifiedRead?: (key: string) => boolean;
  hasUnverifiedRemoval?: (key: string) => boolean;
}

function createCookieCompletionStorage(): AppendAttemptStorage | null {
  if (typeof document === 'undefined') return null;
  const cookieName = (key: string) => `${APPEND_ATTEMPT_COOKIE_PREFIX}${encodeURIComponent(key)}`;
  const isCompletionKey = (key: string) => key.includes(APPEND_ATTEMPT_COMPLETION_COOKIE_SUFFIX);
  const readCookie = (key: string): string | null => {
    if (!isCompletionKey(key)) return null;
    const name = `${cookieName(key)}=`;
    const entry = document.cookie.split('; ').find((value) => value.startsWith(name));
    return entry ? decodeURIComponent(entry.slice(name.length)) : null;
  };
  return {
    getItem: readCookie,
    setItem: (key, value) => {
      if (!isCompletionKey(key)) throw new Error('Invalid append completion cookie key');
      document.cookie = `${cookieName(key)}=${encodeURIComponent(value)}; Max-Age=172800; Path=/; SameSite=Strict`;
      if (readCookie(key) !== value) throw new Error('Append retry state was not persisted');
    },
    removeItem: (key) => {
      if (!isCompletionKey(key)) return false;
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
  const unverifiedReads = new Set<string>();
  const unverifiedRemovals = new Set<string>();
  const stores = [storage, ...fallbackStorages].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index) as AppendAttemptStorage[];
  const readPersisted = (key: string): string | null => {
    let value: string | undefined;
    let unavailable = false;
    for (const candidate of stores) {
      try {
        const persisted = candidate.getItem(key);
        if (persisted === null || persisted === undefined) continue;
        if (value !== undefined && value !== persisted) throw new Error('Conflicting append retry state');
        value = persisted;
      } catch (error) {
        if (error instanceof Error && error.message === 'Conflicting append retry state') throw error;
        unavailable = true;
      }
    }
    if (unavailable) unverifiedReads.add(key);
    else unverifiedReads.delete(key);
    return value ?? null;
  };
  return {
    getItem: (key) => {
      if (memory.has(key)) return memory.get(key) ?? null;
      return readPersisted(key);
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
      if (readPersisted(key) !== value) throw new Error('Conflicting append retry state');
      unverifiedRemovals.delete(key);
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
      let removed = false;
      let remaining = false;
      let unavailable = false;
      for (const candidate of stores) {
        try {
          candidate.removeItem(key);
          if (candidate.getItem(key) === null) removed = true;
          else remaining = true;
        } catch {
          unavailable = true;
        }
      }
      if (unavailable) unverifiedRemovals.add(key);
      else unverifiedRemovals.delete(key);
      return removed && !remaining;
    },
    hasUnverifiedRead: (key) => unverifiedReads.has(key),
    hasUnverifiedRemoval: (key) => unverifiedRemovals.has(key),
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

function persistCompletionRecord(
  storage: AppendAttemptStorage,
  key: string,
  value: string,
  cookieKey: string,
): boolean {
  try {
    storage.setItem(key, value);
    if (storage.getItem(key) === value) return true;
  } catch (error) {
    void error;
  }
  const cookieStorage = createCookieCompletionStorage();
  if (!cookieStorage) return false;
  try {
    const completion = JSON.parse(value) as Partial<AppendAttemptCompletion> & { completed?: boolean };
    const cookieValue = JSON.stringify({
      completed: completion.completed,
      userId: completion.userId,
      idempotencyKey: completion.idempotencyKey,
      fingerprintHash: getFingerprintHash(completion.fingerprint || ''),
      completedAt: completion.completedAt,
    });
    cookieStorage.setItem(cookieKey, cookieValue);
    return cookieStorage.getItem(cookieKey) === cookieValue;
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
  fingerprint?: string;
  fingerprintHash?: string;
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
    && (typeof value.fingerprint === 'string' || typeof value.fingerprintHash === 'string')
    && typeof value.completedAt === 'number';
}

function readCompletionRecord(storage: AppendAttemptStorage, key: string): string | null {
  if (key.includes(APPEND_ATTEMPT_COMPLETION_COOKIE_SUFFIX)) return createCookieCompletionStorage()?.getItem(key) ?? null;
  return storage.getItem(key);
}

function removeCompletionRecord(storage: AppendAttemptStorage, key: string): void {
  if (key.includes(APPEND_ATTEMPT_COMPLETION_COOKIE_SUFFIX)) {
    createCookieCompletionStorage()?.removeItem(key);
    return;
  }
  storage.removeItem(key);
}

function completedAttemptMatches(
  storage: AppendAttemptStorage,
  attemptKey: string,
  completionKey: string,
  completion: AppendAttemptCompletion,
): boolean {
  const raw = storage.getItem(attemptKey);
  if (!raw) {
    if (storage.hasUnverifiedRead?.(attemptKey)) return true;
    removeCompletionRecord(storage, completionKey);
    return true;
  }
  try {
    const current = JSON.parse(raw) as Partial<AppendAttempt>;
    if (
      current.idempotencyKey !== completion.idempotencyKey
      || (typeof completion.fingerprint === 'string'
        ? current.fingerprint !== completion.fingerprint
        : getFingerprintHash(current.fingerprint || '') !== completion.fingerprintHash)
    ) return false;
    const removed = storage.removeItem(attemptKey);
    if (
      removed !== false
      && storage.getItem(attemptKey) === null
      && !storage.hasUnverifiedRemoval?.(attemptKey)
    ) {
      removeCompletionRecord(storage, completionKey);
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
  const attemptKey = getAppendAttemptStorageKey(userId);
  const completionKeys = [
    getAppendAttemptCompletionStorageKey(userId),
    getAppendAttemptCompletionRetryStorageKey(userId),
    getAppendAttemptCompletionCookieStorageKey(userId),
  ];
  for (const completionKey of completionKeys) {
    const raw = readCompletionRecord(storage, completionKey);
    if (!raw) continue;
    try {
      const completion = JSON.parse(raw) as Partial<AppendAttemptCompletion>;
      if (
        completion.userId !== userId
        || typeof completion.idempotencyKey !== 'string'
        || !isValidIdempotencyKey(completion.idempotencyKey)
        || (typeof completion.fingerprint !== 'string' && typeof completion.fingerprintHash !== 'string')
        || typeof completion.completedAt !== 'number'
        || isExpired(completion.completedAt, now, maxAgeMs)
      ) {
        removeCompletionRecord(storage, completionKey);
        continue;
      }
      if (completedAttemptMatches(storage, attemptKey, completionKey, completion as AppendAttemptCompletion)) return true;
    } catch {
      removeCompletionRecord(storage, completionKey);
    }
  }
  return false;
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
    const existingCreatedAt = existing?.createdAt as number;
    const selectedAttempt: AppendAttempt = {
      ...attempt,
      createdAt: !isExpired(existingCreatedAt, now, maxAgeMs) && existingCreatedAt > attempt.createdAt
        ? existingCreatedAt
        : attempt.createdAt,
      orderNumber: typeof existing?.orderNumber === 'string' ? existing.orderNumber : attempt.orderNumber,
    };
    const serializedSelectedAttempt = JSON.stringify(selectedAttempt);
    storage.setItem(scopedKey, serializedSelectedAttempt);
    if (storage.getItem(scopedKey) !== serializedSelectedAttempt) throw new Error('Unable to complete legacy append retry migration');
    if (!removeAndVerify(storage, LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY)) {
      throw new Error('Unable to complete legacy append retry migration');
    }
    return selectedAttempt;
  }
  const serializedAttempt = JSON.stringify(attempt);
  storage.setItem(scopedKey, serializedAttempt);
  if (storage.getItem(scopedKey) !== serializedAttempt) throw new Error('Unable to complete legacy append retry migration');
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
  const retryKey = getAppendAttemptCompletionRetryStorageKey(userId);
  const attemptKey = getAppendAttemptStorageKey(userId);
  const probe = JSON.stringify({ completed: true, userId, idempotencyKey: 'append-storage-probe', fingerprint: '{}', completedAt: Date.now() });
  try {
    storage.setItem(markerKey, probe);
    if (!removeAndVerify(storage, markerKey)) throw new Error('Completion marker cleanup was not persisted');
    return;
  } catch {
    try {
      storage.setItem(retryKey, probe);
      if (!removeAndVerify(storage, retryKey)) throw new Error('Completion retry cleanup was not persisted');
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
): boolean {
  const key = getAppendAttemptStorageKey(completedAttempt.userId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return true;
    const current = JSON.parse(raw) as Partial<AppendAttempt>;
    if (
      current.idempotencyKey !== completedAttempt.idempotencyKey
      || current.fingerprint !== completedAttempt.fingerprint
    ) return true;
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
    const retryKey = getAppendAttemptCompletionRetryStorageKey(completedAttempt.userId);
    const cookieKey = getAppendAttemptCompletionCookieStorageKey(completedAttempt.userId);
    markerPersisted = persistCompletionRecord(storage, markerKey, serializedCompletion, cookieKey);
    if (!markerPersisted) markerPersisted = persistCompletionRecord(storage, retryKey, serializedCompletion, cookieKey);
    if (!markerPersisted) {
      markerPersisted = persistCompletionRecord(storage, key, serializedCompletion, cookieKey);
    }
    if (markerPersisted) {
      confirmedAppendTombstones.set(
        getConfirmedAppendTombstoneKey(completedAttempt.userId, completedAttempt.idempotencyKey),
        { completedAt: Date.now(), fingerprintHash: getFingerprintHash(completedAttempt.fingerprint) },
      );
      pruneConfirmedAppendTombstones(Date.now(), APPEND_ATTEMPT_MAX_AGE_MS);
    }
    const removed = storage.removeItem(key);
    if (
      removed !== false
      && storage.getItem(key) === null
      && markerPersisted
      && !storage.hasUnverifiedRemoval?.(key)
    ) {
      storage.removeItem(markerKey);
      storage.removeItem(retryKey);
      removeCompletionRecord(storage, cookieKey);
    }
    return markerPersisted || (removed !== false && storage.getItem(key) === null);
  } catch {
    return false;
  }
}
