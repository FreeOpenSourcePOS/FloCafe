/** Issue #255 regression coverage for collision-safe cart identity and durable append attempts. */
const assert = require('node:assert/strict');
const {
  generateCartItemId,
  normalizeCartItems,
} = require('../frontend/src/lib/cart-identity');
const {
  APPEND_ATTEMPT_MAX_AGE_MS,
  APPEND_ATTEMPT_STORAGE_KEY,
  LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY,
  getAppendAttemptStorageKey,
  buildAppendItemsFingerprint,
  createSafeAppendAttemptStorage,
  getOrCreateAppendAttempt,
  migrateLegacyAppendAttempt,
  readAppendAttempt,
  clearAppendAttempt,
} = require('../frontend/src/lib/append-attempt');

class MemoryStorage {
  values = new Map();

  getItem(key: string) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function addon(id: number | string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    addon_group_id: 'group-1',
    name: 'Extra',
    price: 10,
    quantity: 1,
    is_active: 1,
    sort_order: 1,
    ...overrides,
  };
}

function main() {
  // The old delimiter-joined identity made these two different configurations
  // produce the same string: "burger-a-b-c".
  const delimiterFirst = generateCartItemId('burger-a', [], 'b-c');
  const delimiterSecond = generateCartItemId('burger', [], 'a-b-c');
  assert.notEqual(delimiterFirst, delimiterSecond, 'delimiter-bearing product/note values keep distinct cart lines');

  const addonDelimiterFirst = generateCartItemId('burger', [addon('extra-a')], 'b-c');
  const addonDelimiterSecond = generateCartItemId('burger', [addon('extra')], 'a-b-c');
  assert.notEqual(addonDelimiterFirst, addonDelimiterSecond, 'delimiter-bearing add-on/note values keep distinct cart lines');

  assert.notEqual(
    generateCartItemId('001', [], ''),
    generateCartItemId(1, [], ''),
    'leading-zero product IDs are not coerced into numeric IDs',
  );
  assert.notEqual(
    generateCartItemId('burger', [addon('001')], ''),
    generateCartItemId('burger', [addon(1)], ''),
    'leading-zero add-on IDs are not coerced into numeric IDs',
  );
  assert.notEqual(
    generateCartItemId('burger', [addon('extra', { name: 'No onions' })], ''),
    generateCartItemId('burger', [addon('extra', { name: 'Extra onions' })], ''),
    'add-on option fields participate in cart identity',
  );
  assert.equal(
    generateCartItemId('burger', [addon('extra', { quantity: undefined })], ''),
    generateCartItemId('burger', [addon('extra', { quantity: 1 })], ''),
    'missing add-on quantity matches the default quantity of one',
  );
  assert.equal(
    generateCartItemId('burger', [addon('extra', { quantity: 0 })], ''),
    generateCartItemId('burger', [addon('extra', { quantity: 1 })], ''),
    'falsy add-on quantity matches the existing default quantity of one',
  );

  const normal = generateCartItemId('burger', [addon('cheese'), addon('sauce')], 'no onions');
  assert.equal(
    normal,
    generateCartItemId('burger', [addon('sauce'), addon('cheese')], 'no onions'),
    'normal cart identity is stable when selected add-ons arrive in a different order',
  );
  assert.notEqual(
    normal,
    generateCartItemId('burger', [addon('cheese'), addon('sauce')], 'extra hot'),
    'normal carts with different notes remain distinct',
  );

  const loadedProduct = { id: 'burger', name: 'Burger', price: 100 };
  const normalizedLoaded = normalizeCartItems([
    { id: 'legacy-burger-no-onions', product: loadedProduct, quantity: 1, addons: [], special_instructions: 'no onions' },
    { id: 'legacy-burger-extra-hot', product: loadedProduct, quantity: 2, addons: [], special_instructions: 'extra hot' },
    { id: 'legacy-burger-no-onions-2', product: loadedProduct, quantity: 3, addons: [], special_instructions: 'no onions' },
  ]);
  assert.equal(normalizedLoaded.length, 2, 'loaded carts preserve distinct configurations while merging equivalent lines');
  assert.equal(normalizedLoaded.find((item: any) => item.special_instructions === 'no onions')?.quantity, 4, 'loaded equivalent lines use canonical identity and combine quantities');
  assert.equal(normalizedLoaded.find((item: any) => item.special_instructions === 'no onions')?.id, generateCartItemId('burger', [], 'no onions'), 'loaded lines receive canonical IDs');

  const storage = new MemoryStorage();
  const attemptStorageKey = getAppendAttemptStorageKey('cashier-1');
  const items = [{ product_id: '001', quantity: 1, special_instructions: 'no-onions' }];
  const fingerprint = buildAppendItemsFingerprint('42', items, 'table-note');
  const first = getOrCreateAppendAttempt(storage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-1',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 1_000,
  });
  assert.equal(first.idempotencyKey, 'append-key-1', 'first append attempt creates and persists a key');
  assert.ok(storage.getItem(attemptStorageKey), 'append attempt is durable before the request is sent');

  // Simulate a committed request whose response was lost, then a renderer
  // reload. The same logical payload must recover the original key.
  const recovered = getOrCreateAppendAttempt(storage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-2',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 2_000,
  });
  assert.equal(recovered.idempotencyKey, first.idempotencyKey, 'response-loss/reload recovery reuses the original append key');
  const reloaded = readAppendAttempt(storage, { userId: 'cashier-1', now: 2_000 });
  assert.deepEqual(reloaded?.items, items, 'reload recovery retains the exact append payload');
  assert.equal(reloaded?.orderNumber, 'K-42', 'reload recovery retains the order display identity');

  assert.throws(() => getOrCreateAppendAttempt(storage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint: buildAppendItemsFingerprint('42', [{ product_id: '001', quantity: 2 }], 'table-note'),
    createKey: () => 'append-key-3',
    items: [{ product_id: '001', quantity: 2 }],
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 3_000,
  }), /previous append attempt is still pending/, 'a mismatched payload is rejected without replacing the pending attempt');
  assert.equal(readAppendAttempt(storage, { userId: 'cashier-1', now: 3_000 })?.idempotencyKey, first.idempotencyKey, 'a mismatched append preserves the original retry key');

  const legacyStorage = new MemoryStorage();
  legacyStorage.setItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'legacy-cashier',
    fingerprint: JSON.stringify({ order_id: 42, items, special_instructions: 'table-note' }),
    idempotencyKey: 'legacy-append-key',
  }));
  const migrated = readAppendAttempt(legacyStorage, { userId: 'legacy-cashier', now: 4_000 });
  assert.equal(migrated?.idempotencyKey, 'legacy-append-key', 'legacy append records migrate before new attempts are created');
  assert.equal(migrated?.orderId, '42', 'legacy migration preserves the appended order');
  assert.deepEqual(migrated?.items, items, 'legacy migration preserves the append payload');
  assert.equal(legacyStorage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY), null, 'legacy append storage is removed after migration');
  const migratedRetry = getOrCreateAppendAttempt(legacyStorage, {
    userId: 'legacy-cashier',
    orderId: '42',
    fingerprint: buildAppendItemsFingerprint('42', items, 'table-note'),
    createKey: () => 'new-key-after-migration',
    items,
    specialInstructions: 'table-note',
    now: 4_001,
  });
  assert.equal(migratedRetry.idempotencyKey, 'legacy-append-key', 'migrated append reuses its key for the normalized logical payload');

  const foreignLegacyStorage = new MemoryStorage();
  foreignLegacyStorage.setItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'legacy-owner',
    fingerprint: JSON.stringify({ order_id: 42, items }),
    idempotencyKey: 'foreign-legacy-key',
  }));
  assert.equal(readAppendAttempt(foreignLegacyStorage, { userId: 'different-cashier', now: 4_000 }), null, 'foreign cashier cannot read a migrated append');
  assert.equal(foreignLegacyStorage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY), null, 'recognized foreign append is removed from the shared legacy slot');
  assert.equal(readAppendAttempt(foreignLegacyStorage, { userId: 'legacy-owner', now: 4_001 })?.idempotencyKey, 'foreign-legacy-key', 'recognized foreign append remains recoverable in its owner-scoped slot');

  const directMigrationStorage = new MemoryStorage();
  directMigrationStorage.setItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'direct-owner',
    fingerprint: JSON.stringify({ order_id: 42, items }),
    idempotencyKey: 'direct-legacy-key',
  }));
  assert.equal(migrateLegacyAppendAttempt(directMigrationStorage, { now: 4_000 })?.userId, 'direct-owner', 'legacy append migration identifies the recorded owner');

  const conflictingMigrationStorage = new MemoryStorage();
  conflictingMigrationStorage.setItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'conflict-owner',
    fingerprint: JSON.stringify({ order_id: 42, items }),
    idempotencyKey: 'legacy-conflict-key',
  }));
  conflictingMigrationStorage.setItem(getAppendAttemptStorageKey('conflict-owner'), JSON.stringify({
    userId: 'conflict-owner',
    orderId: '42',
    fingerprint: buildAppendItemsFingerprint('42', [{ product_id: '002', quantity: 1 }]),
    idempotencyKey: 'scoped-conflict-key',
    items: [{ product_id: '002', quantity: 1 }],
    createdAt: 4_000,
  }));
  assert.throws(
    () => migrateLegacyAppendAttempt(conflictingMigrationStorage, { now: 4_000 }),
    /Unable to migrate legacy append retry state safely/,
    'a conflicting scoped attempt does not consume the legacy retry record',
  );
  assert.ok(conflictingMigrationStorage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY), 'conflicting legacy retry remains available');
  assert.equal(
    JSON.parse(conflictingMigrationStorage.getItem(getAppendAttemptStorageKey('conflict-owner'))).idempotencyKey,
    'scoped-conflict-key',
    'conflicting scoped retry is not overwritten during migration',
  );

  const blockedMigrationBacking = new MemoryStorage();
  blockedMigrationBacking.setItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'blocked-owner',
    fingerprint: JSON.stringify({ order_id: 42, items }),
    idempotencyKey: 'blocked-legacy-key',
  }));
  const blockedMigrationStorage = createSafeAppendAttemptStorage({
    getItem: blockedMigrationBacking.getItem.bind(blockedMigrationBacking),
    setItem: (key, value) => {
      if (key === getAppendAttemptStorageKey('blocked-owner')) throw new Error('scoped storage blocked');
      blockedMigrationBacking.setItem(key, value);
    },
    removeItem: blockedMigrationBacking.removeItem.bind(blockedMigrationBacking),
  });
  assert.throws(
    () => readAppendAttempt(blockedMigrationStorage, { userId: 'blocked-owner', now: 4_000 }),
    /Unable to persist append retry state/,
    'a failed scoped migration blocks recovery instead of using the shared record',
  );
  assert.ok(blockedMigrationBacking.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY), 'failed migration preserves the shared retry record');

  const unscopedMigrationBacking = new MemoryStorage();
  unscopedMigrationBacking.setItem(APPEND_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'unscoped-owner',
    orderId: '42',
    fingerprint,
    idempotencyKey: 'unscoped-append-key',
    items,
    createdAt: 4_000,
  }));
  const unscopedMigrationStorage = createSafeAppendAttemptStorage({
    getItem: unscopedMigrationBacking.getItem.bind(unscopedMigrationBacking),
    setItem: unscopedMigrationBacking.setItem.bind(unscopedMigrationBacking),
    removeItem: (key) => {
      if (key === APPEND_ATTEMPT_STORAGE_KEY) return;
      unscopedMigrationBacking.removeItem(key);
    },
  });
  assert.throws(
    () => readAppendAttempt(unscopedMigrationStorage, { userId: 'unscoped-owner', now: 4_000 }),
    /Unable to complete append retry migration/,
    'a failed unscoped-key removal blocks migration instead of leaving a duplicate recovery source',
  );
  assert.ok(unscopedMigrationBacking.getItem(APPEND_ATTEMPT_STORAGE_KEY), 'failed unscoped migration preserves the original retry record');

  const conflictingUnscopedStorage = new MemoryStorage();
  conflictingUnscopedStorage.setItem(getAppendAttemptStorageKey('unscoped-owner'), JSON.stringify({
    userId: 'unscoped-owner',
    orderId: '42',
    fingerprint,
    idempotencyKey: 'scoped-append-key',
    items,
    createdAt: 4_000,
  }));
  conflictingUnscopedStorage.setItem(APPEND_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'unscoped-owner',
    orderId: '43',
    fingerprint: buildAppendItemsFingerprint('43', items),
    idempotencyKey: 'unscoped-append-key',
    items,
    createdAt: 4_000,
  }));
  assert.throws(
    () => readAppendAttempt(conflictingUnscopedStorage, { userId: 'unscoped-owner', now: 4_000 }),
    /Unable to migrate conflicting append retry state/,
    'a conflicting unscoped retry is not discarded beside a scoped attempt',
  );
  assert.ok(conflictingUnscopedStorage.getItem(APPEND_ATTEMPT_STORAGE_KEY), 'conflicting unscoped retry remains available');

  const legacyOrderStorage = new MemoryStorage();
  legacyOrderStorage.setItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify({
    userId: 'legacy-cashier',
    fingerprint: JSON.stringify({ table_id: 'table-1', items }),
    idempotencyKey: 'legacy-order-key',
  }));
  assert.equal(readAppendAttempt(legacyOrderStorage, { userId: 'legacy-cashier', now: 4_000 }), null, 'legacy new-order records are not mistaken for append records');
  assert.ok(legacyOrderStorage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY), 'legacy new-order records remain available to the order flow');

  // Cleanup is explicit after the caller receives a confirmed response; a
  // failed/lost response leaves the attempt available for retry.
  clearAppendAttempt(storage, first);
  assert.equal(storage.getItem(attemptStorageKey), null, 'confirmed completion cleanup removes the durable attempt');

  const stale = getOrCreateAppendAttempt(storage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-stale',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 10_000,
  });
  const expired = getOrCreateAppendAttempt(storage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-fresh',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 10_000 + APPEND_ATTEMPT_MAX_AGE_MS + 1,
  });
  assert.equal(stale.idempotencyKey, 'append-key-stale', 'expiry fixture starts with a stale key');
  assert.equal(expired.idempotencyKey, 'append-key-fresh', 'expired attempts are replaced with a fresh key');
  assert.equal(JSON.parse(storage.getItem(attemptStorageKey)).idempotencyKey, 'append-key-fresh', 'expiry cleanup persists only the fresh attempt');
  clearAppendAttempt(storage, stale);
  assert.equal(JSON.parse(storage.getItem(attemptStorageKey)).idempotencyKey, 'append-key-fresh', 'late cleanup cannot remove a newer append attempt');
  clearAppendAttempt(storage, expired);
  assert.equal(storage.getItem(attemptStorageKey), null, 'matching confirmed completion cleanup removes the current attempt');

  const blockedStorage = createSafeAppendAttemptStorage({
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => { throw new Error('storage blocked'); },
    removeItem: () => { throw new Error('storage blocked'); },
  });
  assert.throws(() => getOrCreateAppendAttempt(blockedStorage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-memory',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 20_000,
  }), /Unable to persist append retry state/, 'blocked storage prevents the append from starting');
  assert.equal(readAppendAttempt(blockedStorage, { userId: 'cashier-1', now: 20_001 }), null, 'blocked storage does not leave an in-memory-only retry attempt');

  const unavailableStorage = createSafeAppendAttemptStorage(null);
  assert.throws(() => getOrCreateAppendAttempt(unavailableStorage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-unavailable',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 20_000,
  }), /Unable to persist append retry state/, 'unavailable storage prevents the append from starting');

  const cleanupBacking = new MemoryStorage();
  const cleanupFailureStorage = createSafeAppendAttemptStorage({
    getItem: cleanupBacking.getItem.bind(cleanupBacking),
    setItem: cleanupBacking.setItem.bind(cleanupBacking),
    removeItem: () => { throw new Error('cleanup blocked'); },
  });
  const completed = getOrCreateAppendAttempt(cleanupFailureStorage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-cleanup-failure',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 21_000,
  });
  clearAppendAttempt(cleanupFailureStorage, completed);
  const reloadedCleanupStorage = createSafeAppendAttemptStorage(cleanupBacking);
  assert.equal(readAppendAttempt(reloadedCleanupStorage, { userId: 'cashier-1', now: 21_001 }), null, 'a durable completion marker suppresses a stale attempt after cleanup failure');
  const afterCleanupFailure = getOrCreateAppendAttempt(reloadedCleanupStorage, {
    userId: 'cashier-1',
    orderId: '43',
    fingerprint: buildAppendItemsFingerprint('43', items, 'table-note'),
    createKey: () => 'append-key-after-cleanup-failure',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-43',
    now: 21_002,
  });
  assert.equal(afterCleanupFailure.idempotencyKey, 'append-key-after-cleanup-failure', 'cleanup failure does not block a later append');

  const fallbackBacking = new MemoryStorage();
  const fallbackStorage = createSafeAppendAttemptStorage({
    getItem: fallbackBacking.getItem.bind(fallbackBacking),
    setItem: (key, value) => {
      if (key.endsWith('.completed')) throw new Error('marker storage blocked');
      fallbackBacking.setItem(key, value);
    },
    removeItem: (key) => {
      if (key === getAppendAttemptStorageKey('cashier-1')) throw new Error('cleanup blocked');
      fallbackBacking.removeItem(key);
    },
  });
  const fallbackCompleted = getOrCreateAppendAttempt(fallbackStorage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-fallback-completion',
    items,
    specialInstructions: 'table-note',
    now: 22_000,
  });
  clearAppendAttempt(fallbackStorage, fallbackCompleted);
  const fallbackReload = createSafeAppendAttemptStorage(fallbackBacking);
  assert.equal(readAppendAttempt(fallbackReload, { userId: 'cashier-1', now: 22_001 }), null, 'fallback completion state suppresses a stale attempt after marker failure');
  assert.equal(
    getOrCreateAppendAttempt(fallbackReload, {
      userId: 'cashier-1',
      orderId: '43',
      fingerprint: buildAppendItemsFingerprint('43', items, 'table-note'),
      createKey: () => 'append-key-after-fallback-completion',
      items,
      specialInstructions: 'table-note',
      now: 22_002,
    }).idempotencyKey,
    'append-key-after-fallback-completion',
    'fallback completion state does not block a later append',
  );

  const invalidStorage = new MemoryStorage();
  invalidStorage.setItem(attemptStorageKey, JSON.stringify({ ...first, idempotencyKey: ' ' }));
  assert.equal(readAppendAttempt(invalidStorage, { userId: 'cashier-1', now: 2_000 }), null, 'invalid persisted keys are discarded before recovery');
  assert.equal(invalidStorage.getItem(attemptStorageKey), null, 'invalid persisted key cleanup is safe');

  const foreignStorage = new MemoryStorage();
  const foreignAttempt = getOrCreateAppendAttempt(foreignStorage, {
    userId: 'cashier-1',
    orderId: '42',
    fingerprint,
    createKey: () => 'append-key-foreign',
    items,
    specialInstructions: 'table-note',
    orderNumber: 'K-42',
    now: 30_000,
  });
  assert.equal(readAppendAttempt(foreignStorage, { userId: 'cashier-2', now: 30_001 }), null, 'another cashier does not recover a foreign append attempt');
  assert.equal(readAppendAttempt(foreignStorage, { userId: 'cashier-1', now: 30_001 })?.idempotencyKey, foreignAttempt.idempotencyKey, 'the original cashier retains its pending append retry');

  console.log('Issue #255 cart identity and append-attempt tests passed');
}

main();
