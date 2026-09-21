/**
 * Issue #788 regression coverage for new-order attempt persistence.
 *
 * The POS used to write postpaid and prepaid attempts straight into
 * `window.localStorage` and abort the order when that write failed, collapsing
 * a local storage problem and a backend rejection into one generic toast.
 * These cases pin the durable-storage contract the POS now relies on: a
 * verified write through the safe storage fallback, no request when nothing
 * accepted the attempt, and retry under the original idempotency key.
 *
 * Run: npm run test:issue-788-order-attempt-storage
 */

const assert = require('node:assert/strict');
const {
  getPostpaidOrderAttemptStorageKey,
  createSafeAppendAttemptStorage,
} = require('../frontend/src/lib/append-attempt');
const {
  PREPAID_ATTEMPT_STORAGE_KEY,
  OrderAttemptStorageError,
  classifyOrderRequestFailure,
  clearOrderAttempt,
  getPrepaidOrderAttemptStorageKey,
  readOrderAttempt,
  persistOrderAttempt,
} = require('../frontend/src/lib/order-attempt');

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

/** A backend that rejects writes for the given key prefixes, like a
 * quota-exceeded or storage-denied renderer. */
class BlockedStorage extends MemoryStorage {
  constructor(blockedPrefixes) {
    super();
    this.blockedPrefixes = blockedPrefixes;
  }

  setItem(key, value) {
    if (this.blockedPrefixes.some((prefix) => key.startsWith(prefix))) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    super.setItem(key, value);
  }
}

/** A backend whose deletes silently do nothing, like a storage the browser
 * refuses to let the renderer clear. */
class RemovalBlockedStorage extends MemoryStorage {
  removeItem() {}
}

/** A backend that rejects writes and ignores deletes for the given prefixes. */
class FrozenStorage extends RemovalBlockedStorage {
  constructor(blockedPrefixes) {
    super();
    this.blockedPrefixes = blockedPrefixes;
  }

  setItem(key, value) {
    if (this.blockedPrefixes.some((prefix) => key.startsWith(prefix))) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    super.setItem(key, value);
  }
}

const USER_ID = 'cashier-1';
const OTHER_USER_ID = 'cashier-2';
const postpaidKey = getPostpaidOrderAttemptStorageKey(USER_ID);
const prepaidKey = getPrepaidOrderAttemptStorageKey(USER_ID);
const isUsablePostpaidAttempt = (attempt) => typeof attempt.fingerprint === 'string' && !!attempt.idempotencyKey;
const isUsablePrepaidAttempt = (attempt) => typeof attempt.cartFingerprint === 'string'
  && typeof attempt.paymentFingerprint === 'string'
  && !!attempt.orderIdempotencyKey
  && !!attempt.paymentIdempotencyKey;

function buildPrepaidAttempt(overrides = {}) {
  return {
    userId: USER_ID,
    cartFingerprint: JSON.stringify({ items: [{ product_id: 'p1', quantity: 1 }] }),
    paymentFingerprint: JSON.stringify({ payments: [{ method: 'cash', amount: 10 }] }),
    discount: null,
    orderIdempotencyKey: 'order-key-1',
    paymentIdempotencyKey: 'payment-key-1',
    ...overrides,
  };
}

function buildPostpaidAttempt(overrides = {}) {
  return {
    userId: USER_ID,
    fingerprint: JSON.stringify({ table_id: null, items: [{ product_id: 'p1', quantity: 1 }] }),
    idempotencyKey: 'attempt-key-1',
    ...overrides,
  };
}

/** Mirrors the POS gate: an attempt is only usable once it is durably stored. */
function loadOrCreateAttempt(storage, attemptFactory) {
  const stored = readOrderAttempt(storage, postpaidKey, USER_ID, { isValid: isUsablePostpaidAttempt });
  const attempt = stored && stored.fingerprint === attemptFactory().fingerprint
    ? stored
    : attemptFactory();
  persistOrderAttempt(storage, postpaidKey, attempt);
  return attempt;
}

function main() {
  // 1. Primary storage blocked: the sessionStorage fallback still accepts the
  //    attempt, and it survives a renderer reload (a fresh wrapper instance
  //    over the same backends) instead of silently dropping the retry key.
  const blockedLocal = new BlockedStorage(['flo.postpaid.order.attempt', 'flo.prepaid.checkout.attempt']);
  const fallbackSession = new MemoryStorage();
  const fallbackStorage = createSafeAppendAttemptStorage(blockedLocal, fallbackSession);
  const fallbackAttempt = loadOrCreateAttempt(fallbackStorage, () => buildPostpaidAttempt());
  assert.equal(fallbackAttempt.idempotencyKey, 'attempt-key-1', 'the fallback write stores the attempt');
  assert.equal(blockedLocal.getItem(postpaidKey), null, 'the blocked primary stays untouched');
  assert.notEqual(fallbackSession.getItem(postpaidKey), null, 'the fallback backend holds the attempt');
  const reloadedFallback = createSafeAppendAttemptStorage(blockedLocal, fallbackSession);
  assert.equal(
    readOrderAttempt(reloadedFallback, postpaidKey, USER_ID).idempotencyKey,
    'attempt-key-1',
    'the fallback-persisted attempt is recovered after a reload',
  );

  // 2. Every usable backend blocked: persistence fails closed so the caller
  //    never reaches POST /api/orders with an unretryable attempt.
  const unavailableStorage = createSafeAppendAttemptStorage(
    new BlockedStorage(['flo.postpaid.order.attempt']),
    new BlockedStorage(['flo.postpaid.order.attempt']),
  );
  assert.throws(
    () => loadOrCreateAttempt(unavailableStorage, () => buildPostpaidAttempt()),
    OrderAttemptStorageError,
    'a total persistence failure aborts the order instead of sending it',
  );

  // 3. Normal primary-storage success keeps a single attempt for a retried
  //    payload and starts a new key only for a different order.
  const healthyLocal = new MemoryStorage();
  const healthyStorage = createSafeAppendAttemptStorage(healthyLocal, new MemoryStorage());
  const firstAttempt = loadOrCreateAttempt(healthyStorage, () => buildPostpaidAttempt());
  const retriedAttempt = loadOrCreateAttempt(healthyStorage, () => buildPostpaidAttempt());
  assert.equal(retriedAttempt.idempotencyKey, firstAttempt.idempotencyKey, 'a retried payload reuses its idempotency key');
  const changedAttempt = loadOrCreateAttempt(healthyStorage, () => buildPostpaidAttempt({
    fingerprint: JSON.stringify({ table_id: null, items: [{ product_id: 'p1', quantity: 2 }] }),
    idempotencyKey: 'attempt-key-2',
  }));
  assert.equal(changedAttempt.idempotencyKey, 'attempt-key-2', 'a different payload starts a new attempt');

  // 4. Prepaid checkout keys are stored and recovered through the same
  //    contract, under the cashier's own key.
  const prepaidStorage = createSafeAppendAttemptStorage(new MemoryStorage(), new MemoryStorage());
  persistOrderAttempt(prepaidStorage, prepaidKey, buildPrepaidAttempt());
  assert.equal(
    readOrderAttempt(prepaidStorage, prepaidKey, USER_ID, { isValid: isUsablePrepaidAttempt }).paymentIdempotencyKey,
    'payment-key-1',
    'the prepaid attempt is readable before the payment request',
  );

  // 4a. A second cashier reading checkout state must not touch the first
  //     cashier's pending attempt: dropping it would hand a possibly committed
  //     request a fresh idempotency key.
  assert.equal(
    readOrderAttempt(prepaidStorage, getPrepaidOrderAttemptStorageKey(OTHER_USER_ID), OTHER_USER_ID, { isValid: isUsablePrepaidAttempt }),
    null,
    'another cashier never recovers a foreign prepaid attempt',
  );
  assert.notEqual(
    prepaidStorage.getItem(prepaidKey),
    null,
    'the first cashier keeps a pending prepaid attempt after a second cashier reads',
  );
  assert.equal(
    readOrderAttempt(prepaidStorage, prepaidKey, USER_ID, { isValid: isUsablePrepaidAttempt }).orderIdempotencyKey,
    'order-key-1',
    'the first cashier still recovers the same order key afterwards',
  );

  // 4b. A prepaid attempt recorded before user-scoped keys existed is adopted
  //     only for its owner, and a foreign record is left untouched.
  const legacyStorage = createSafeAppendAttemptStorage(new MemoryStorage(), new MemoryStorage());
  persistOrderAttempt(legacyStorage, PREPAID_ATTEMPT_STORAGE_KEY, buildPrepaidAttempt({
    orderIdempotencyKey: 'legacy-order-key',
    paymentIdempotencyKey: 'legacy-payment-key',
  }));
  const readLegacy = (userId) => readOrderAttempt(
    legacyStorage,
    PREPAID_ATTEMPT_STORAGE_KEY,
    userId,
    { sharedKey: true, isValid: isUsablePrepaidAttempt },
  );
  assert.equal(readLegacy(OTHER_USER_ID), null, 'a foreign legacy prepaid attempt is not recovered');
  assert.notEqual(
    legacyStorage.getItem(PREPAID_ATTEMPT_STORAGE_KEY),
    null,
    'a foreign legacy prepaid attempt is left untouched',
  );
  assert.equal(
    readLegacy(USER_ID).paymentIdempotencyKey,
    'legacy-payment-key',
    'the owning cashier still recovers the legacy prepaid attempt',
  );

  // 5. Unreadable retry state fails closed rather than looking like "no attempt",
  //    which would create a second order under a fresh key.
  const readBlocked = createSafeAppendAttemptStorage({
    getItem: () => { throw new Error('storage read denied'); },
    setItem: () => {},
    removeItem: () => {},
  });
  assert.throws(
    () => readOrderAttempt(readBlocked, postpaidKey, USER_ID),
    OrderAttemptStorageError,
    'a blocked read aborts the order instead of starting a fresh attempt',
  );

  // 5a. Damaged records fail closed too. Malformed JSON, a missing idempotency
  //     key, or another user's id under a user-scoped key all mean "cannot
  //     trust this", never "there is no attempt".
  const damagedStorage = createSafeAppendAttemptStorage(new MemoryStorage(), new MemoryStorage());
  damagedStorage.setItem(postpaidKey, 'not json');
  assert.throws(
    () => readOrderAttempt(damagedStorage, postpaidKey, USER_ID, { isValid: isUsablePostpaidAttempt }),
    OrderAttemptStorageError,
    'malformed attempt state aborts the order',
  );
  damagedStorage.setItem(postpaidKey, JSON.stringify({ userId: USER_ID, fingerprint: '{}' }));
  assert.throws(
    () => readOrderAttempt(damagedStorage, postpaidKey, USER_ID, { isValid: isUsablePostpaidAttempt }),
    OrderAttemptStorageError,
    'an attempt without an idempotency key aborts the order',
  );
  damagedStorage.setItem(postpaidKey, JSON.stringify(buildPostpaidAttempt({ userId: OTHER_USER_ID })));
  assert.throws(
    () => readOrderAttempt(damagedStorage, postpaidKey, USER_ID, { isValid: isUsablePostpaidAttempt }),
    OrderAttemptStorageError,
    'a record owned by another user under a scoped key aborts the order',
  );
  assert.throws(
    () => readOrderAttempt(
      createDamagedPrepaidStorage(),
      prepaidKey,
      USER_ID,
      { isValid: isUsablePrepaidAttempt },
    ),
    OrderAttemptStorageError,
    'a structurally incomplete prepaid attempt aborts the checkout',
  );

  // 6. Local persistence failures stay distinguishable from backend rejections,
  //    and neither classification carries order or customer payloads.
  const rejected = classifyOrderRequestFailure({ response: { status: 400, data: { error: 'customer secret' } } });
  assert.equal(rejected.code, 'order.place.rejected', 'a backend rejection is classified as a rejection');
  assert.equal(rejected.status, 400, 'the rejection status is preserved for support');
  assert.ok(!rejected.detail.includes('secret'), 'the rejection detail never echoes the response payload');
  const unreachable = classifyOrderRequestFailure({ isAxiosError: true, message: 'Network Error' });
  assert.equal(unreachable.code, 'order.place.unreachable', 'a transport failure is classified separately');
  assert.equal(unreachable.status, null, 'an unreachable request has no HTTP status');
  const localFailure = classifyOrderRequestFailure(new Error('Unable to clear append retry state'));
  assert.equal(
    localFailure.code,
    'order.place.failed',
    'a local (non-request) failure is not misreported as a server rejection',
  );

  // 7. A completed attempt whose deletion the browser blocks is closed durably:
  //    a later sale over a fresh wrapper never reuses the confirmed key.
  const removalBlockedLocal = new RemovalBlockedStorage();
  const completedStorage = createSafeAppendAttemptStorage(removalBlockedLocal, new MemoryStorage());
  const completedAttempt = loadOrCreateAttempt(completedStorage, () => buildPostpaidAttempt());
  assert.equal(clearOrderAttempt(completedStorage, postpaidKey, completedAttempt), true, 'a closed attempt reports its durable evidence');
  assert.notEqual(removalBlockedLocal.getItem(postpaidKey), null, 'the blocked backend still holds the record');
  assert.equal(
    JSON.parse(removalBlockedLocal.getItem(postpaidKey)).completed,
    true,
    'the surviving record says the attempt is closed',
  );
  assert.ok(
    !removalBlockedLocal.getItem(postpaidKey).includes(completedAttempt.idempotencyKey),
    'the closed marker carries no retry key for a later sale to reuse',
  );
  const afterReload = createSafeAppendAttemptStorage(removalBlockedLocal, new MemoryStorage());
  assert.equal(
    readOrderAttempt(afterReload, postpaidKey, USER_ID, { isValid: isUsablePostpaidAttempt }),
    null,
    'a reloaded renderer never reads a confirmed attempt back as reusable',
  );
  const nextSaleAttempt = loadOrCreateAttempt(afterReload, () => buildPostpaidAttempt({ idempotencyKey: 'attempt-key-next' }));
  assert.notEqual(
    nextSaleAttempt.idempotencyKey,
    completedAttempt.idempotencyKey,
    'the next identical sale does not reuse the confirmed idempotency key',
  );

  // 8. When not even the marker can be stored the caller is told cleanup failed,
  //    instead of assuming the retry state is gone.
  const frozenLocal = new FrozenStorage(['flo.postpaid.order.attempt']);
  const frozenFallback = new FrozenStorage(['flo.postpaid.order.attempt']);
  frozenLocal.values.set(postpaidKey, JSON.stringify(buildPostpaidAttempt()));
  frozenFallback.values.set(postpaidKey, JSON.stringify(buildPostpaidAttempt()));
  const frozenStorage = createSafeAppendAttemptStorage(frozenLocal, frozenFallback);
  assert.equal(
    clearOrderAttempt(frozenStorage, postpaidKey, buildPostpaidAttempt()),
    false,
    'cleanup without any durable evidence reports failure',
  );
  assert.notEqual(
    frozenLocal.getItem(postpaidKey),
    null,
    'the record a browser refuses to write or clear is still the only evidence left',
  );

  // 9. The prepaid payment key persisted before the request is the key the
  //    request carries, so a later write failure cannot leave a divergent key
  //    in storage.
  const prepaidIntermediate = createSafeAppendAttemptStorage(new MemoryStorage(), new MemoryStorage());
  const persistedAttempt = buildPrepaidAttempt();
  persistOrderAttempt(prepaidIntermediate, prepaidKey, persistedAttempt);
  const failingStorage = createSafeAppendAttemptStorage(
    new BlockedStorage(['flo.prepaid.checkout.attempt']),
    new BlockedStorage(['flo.prepaid.checkout.attempt']),
  );
  assert.throws(
    () => persistOrderAttempt(failingStorage, prepaidKey, { ...persistedAttempt, paymentIdempotencyKey: 'payment-key-2' }),
    OrderAttemptStorageError,
    'an intermediate prepaid update that cannot be persisted aborts the checkout',
  );
  assert.equal(
    readOrderAttempt(prepaidIntermediate, prepaidKey, USER_ID, { isValid: isUsablePrepaidAttempt }).paymentIdempotencyKey,
    'payment-key-1',
    'the stored payment key is unchanged by the failed update',
  );

  console.log('Issue #788 order-attempt storage tests passed');
}

function createDamagedPrepaidStorage() {
  const storage = createSafeAppendAttemptStorage(new MemoryStorage(), new MemoryStorage());
  const { paymentIdempotencyKey, ...damaged } = buildPrepaidAttempt();
  void paymentIdempotencyKey;
  storage.setItem(prepaidKey, JSON.stringify(damaged));
  return storage;
}

main();
