export const APPEND_ATTEMPT_STORAGE_KEY = 'flo.pos.append-items.attempt';
export const LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';
export const APPEND_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APPEND_ATTEMPT_USER_SUFFIX = '.user.';
const APPEND_ATTEMPT_COMPLETION_SUFFIX = '.completion.';
const APPEND_ATTEMPT_COMPLETION_RETRY_SUFFIX = '.completion-retry.';
const APPEND_ATTEMPT_COMPLETION_COOKIE_SUFFIX = '.completion-cookie.';
const CONFIRMED_APPEND_TOMBSTONE_LIMIT = 256;
const confirmedAppendTombstones = new Map<string, { completedAt: number; fingerprint: string }>();
const APPEND_ATTEMPT_COOKIE_PREFIX = 'flo_append_attempt.';
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

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

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function getFingerprintDigest(fingerprint: string): string {
  const bytes = new TextEncoder().encode(fingerprint);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15];
      const second = words[index - 2];
      words[index] = (words[index - 16]
        + (rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3))
        + words[index - 7]
        + (rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const first = (h
        + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25))
        + ((e & f) ^ (~e & g))
        + SHA256_CONSTANTS[index]
        + words[index]) >>> 0;
      const second = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22))
        + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash = hash.map((value, index) => (value + [a, b, c, d, e, f, g, h][index]) >>> 0);
  }
  return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
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
  return tombstone?.fingerprint === fingerprint;
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

/** Matches request shape for POST /orders/:id/items;
 * server validates request body against Idempotency-Key. */
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
  return removed !== false
    && storage.getItem(key) === null
    && !storage.hasUnverifiedRead?.(key)
    && !storage.hasUnverifiedRemoval?.(key);
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
      fingerprintDigest: getFingerprintDigest(completion.fingerprint || ''),
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
  fingerprintDigest?: string;
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
    && (typeof value.fingerprint === 'string' || typeof value.fingerprintDigest === 'string')
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
        : getFingerprintDigest(current.fingerprint || '') !== completion.fingerprintDigest)
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
        || (typeof completion.fingerprint !== 'string' && typeof completion.fingerprintDigest !== 'string')
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
  if (storage.hasUnverifiedRead?.(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY)) {
    throw new Error('Unable to verify append retry state');
  }
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
  if (storage.hasUnverifiedRead?.(scopedKey)) {
    throw new Error('Unable to verify append retry state');
  }
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
  if (storage.hasUnverifiedRead?.(key)) throw new Error('Unable to verify append retry state');
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
  const cookieKey = getAppendAttemptCompletionCookieStorageKey(userId);
  const attemptKey = getAppendAttemptStorageKey(userId);
  const probe = JSON.stringify({ completed: true, userId, idempotencyKey: 'append-storage-probe', fingerprint: '{}', completedAt: Date.now() });
  const cookieStorage = createCookieCompletionStorage();
  if (cookieStorage) {
    try {
      const cookieProbe = JSON.stringify({
        completed: true,
        userId,
        idempotencyKey: 'append-storage-probe',
        fingerprintDigest: getFingerprintDigest('{}'),
        completedAt: Date.now(),
      });
      cookieStorage.setItem(cookieKey, cookieProbe);
      if (cookieStorage.removeItem(cookieKey) === false || cookieStorage.getItem(cookieKey) !== null) {
        throw new Error('Completion cookie cleanup was not persisted');
      }
    } catch {
    }
  }
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

function assertVerifiedCompletionReads(storage: AppendAttemptStorage, userId: string): void {
  const keys = [
    getAppendAttemptCompletionStorageKey(userId),
    getAppendAttemptCompletionRetryStorageKey(userId),
  ];
  if (keys.some((key) => storage.hasUnverifiedRead?.(key))) {
    throw new Error('Unable to verify append retry state');
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
  const completed = hasCompletedAttempt(storage, userId, now, maxAgeMs);
  assertVerifiedCompletionReads(storage, userId);
  if (completed) return null;
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

/** Recovers durable attempt for the same logical append;
 * retains conflicting attempts until expiry. */
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
        { completedAt: Date.now(), fingerprint: completedAttempt.fingerprint },
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
