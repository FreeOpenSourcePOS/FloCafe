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

const USER_ID = 'cashier-1';
const postpaidKey = getPostpaidOrderAttemptStorageKey(USER_ID);

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
  const stored = readOrderAttempt(storage, postpaidKey, USER_ID);
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

  // 4. Prepaid checkout keys are stored and recovered through the same contract.
  const prepaidStorage = createSafeAppendAttemptStorage(new MemoryStorage(), new MemoryStorage());
  persistOrderAttempt(prepaidStorage, PREPAID_ATTEMPT_STORAGE_KEY, {
    userId: USER_ID,
    cartFingerprint: '{}',
    orderIdempotencyKey: 'order-key',
    paymentIdempotencyKey: 'payment-key',
  });
  assert.equal(
    readOrderAttempt(prepaidStorage, PREPAID_ATTEMPT_STORAGE_KEY, USER_ID).paymentIdempotencyKey,
    'payment-key',
    'the prepaid attempt is readable before the payment request',
  );
  assert.equal(
    readOrderAttempt(prepaidStorage, PREPAID_ATTEMPT_STORAGE_KEY, 'another-cashier'),
    null,
    'another cashier never recovers a foreign prepaid attempt',
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

  console.log('Issue #788 order-attempt storage tests passed');
}

main();
