/**
 * Expense attempt durable storage contract (Issue #1055).
 *
 * Usage: npx ts-node --transpile-only -P tests/tsconfig.json tests/expense-attempt.test.ts
 */

import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith('/main/db')) {
    return {
      initDatabase() {},
      getDatabase() {},
      closeDatabase() {},
      now: () => '1970-01-01T00:00:00.000Z',
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');

import {
  EXPENSE_ATTEMPT_STORAGE_KEY,
  ExpenseAttemptStorageError,
  clearExpenseAttempt,
  expenseAttemptStorageKey,
  isUnresolvedExpenseFailure,
  newExpenseAttempt,
  persistExpenseAttempt,
  readExpenseAttempt,
  type ExpenseAttemptSnapshot,
} from '../frontend/src/lib/expense-attempt';

class FakeStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function setWindowStorage(localStorage?: Storage | null): void {
  if (localStorage === undefined) {
    delete (globalThis as Record<string, unknown>).window;
    return;
  }
  (globalThis as Record<string, unknown>).window = { localStorage };
}

function throwsStorageError(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof ExpenseAttemptStorageError;
  }
}

function main(): void {
  resetCounters();
  console.log('Expense attempt storage test');
  console.log('='.repeat(50));

  const actorId = 'user-owner-uuid-1055';
  const otherActorId = 'user-manager-uuid-2002';
  const tenantId = 1;
  const otherTenantId = 2;

  // 1. Persisted unresolved string-actor record retains exact idempotency key and body
  const storage = new FakeStorage();
  setWindowStorage(storage);

  const scopedKey = expenseAttemptStorageKey(actorId, tenantId);
  assertEqualOrThrow(
    scopedKey,
    `${EXPENSE_ATTEMPT_STORAGE_KEY}:${tenantId}:${actorId}`,
    'scoped storage key keeps version, tenantId, and string actorId format',
  );

  const existingBody = {
    category_id: 'cat-coffee',
    description: 'Espresso machine gasket replacement',
    amount_minor: 4850,
    incurred_on: '2026-10-13',
    payee: 'Roaster Supply Co',
  };
  const existingSnapshot: ExpenseAttemptSnapshot = {
    kind: 'expense.create',
    path: '/expenses',
    expenseId: null,
    paymentId: null,
    idempotencyKey: 'idem-persisted-string-actor-1',
    body: existingBody,
    actorId,
    tenantId,
    createdAt: '2026-10-13T09:30:00.000Z',
  };
  storage.setItem(scopedKey, JSON.stringify(existingSnapshot));

  const recoveredExisting = readExpenseAttempt(actorId, tenantId);
  assertOrThrow(recoveredExisting !== null, 'already persisted string-actor attempt is readable');
  assertEqualOrThrow(
    recoveredExisting!.idempotencyKey,
    'idem-persisted-string-actor-1',
    'recovered unresolved attempt retains exact idempotency key',
  );
  assert.deepEqual(
    recoveredExisting!.body,
    existingBody,
    'recovered unresolved attempt retains exact request body',
  );
  assertEqualOrThrow(
    recoveredExisting!.actorId,
    actorId,
    'recovered unresolved attempt retains string actorId',
  );
  assertEqualOrThrow(
    recoveredExisting!.tenantId,
    tenantId,
    'recovered unresolved attempt retains numeric tenantId',
  );

  // Occupied slot refuses overwrite and keeps original key/body intact
  assertOrThrow(
    throwsStorageError(() =>
      persistExpenseAttempt({
        ...existingSnapshot,
        idempotencyKey: 'idem-overwrite-attempt',
        body: { ...existingBody, amount_minor: 9999 },
      }),
    ),
    'persisting over an existing unresolved attempt throws ExpenseAttemptStorageError',
  );
  const afterRejectedOverwrite = readExpenseAttempt(actorId, tenantId);
  assertEqualOrThrow(
    afterRejectedOverwrite?.idempotencyKey,
    'idem-persisted-string-actor-1',
    'failed overwrite leaves original idempotency key untouched',
  );
  assert.deepEqual(
    afterRejectedOverwrite?.body,
    existingBody,
    'failed overwrite leaves original request body untouched',
  );

  // 2. Wrong idempotency key does not clear; matching key clears
  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, 'idem-wrong-key'),
    false,
    'clearExpenseAttempt rejects a mismatched idempotency key',
  );
  assertOrThrow(
    storage.getItem(scopedKey) !== null,
    'mismatched clear leaves scoped attempt in localStorage',
  );
  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, 'idem-persisted-string-actor-1'),
    true,
    'clearExpenseAttempt removes the string-actor attempt when idempotency key matches',
  );
  assertEqualOrThrow(
    storage.getItem(scopedKey),
    null,
    'scoped key is removed from storage after clear',
  );
  assertEqualOrThrow(
    readExpenseAttempt(actorId, tenantId),
    null,
    'readExpenseAttempt returns null after clear',
  );

  // 3. Full newExpenseAttempt -> persist -> read -> clear round trip with string actorId
  const created = newExpenseAttempt({
    kind: 'expense.payment',
    path: '/expenses/exp-101/payments',
    expenseId: 'exp-101',
    paymentId: null,
    body: { amount_minor: 2500, method: 'card', currency_code: 'THB' },
    actorId,
    tenantId,
  });
  assertEqualOrThrow(
    typeof created.idempotencyKey,
    'string',
    'newExpenseAttempt assigns idempotency key',
  );
  assertOrThrow(
    created.idempotencyKey.length > 0,
    'newExpenseAttempt idempotency key is non-empty',
  );
  persistExpenseAttempt(created);

  const readBack = readExpenseAttempt(actorId, tenantId);
  assertOrThrow(readBack !== null, 'persisted string-actor attempt reads back');
  assertEqualOrThrow(
    readBack!.idempotencyKey,
    created.idempotencyKey,
    'round-trip preserves idempotencyKey',
  );
  assert.deepEqual(readBack!.body, created.body, 'round-trip preserves body');
  assertEqualOrThrow(readBack!.actorId, actorId, 'round-trip preserves string actorId');
  assertEqualOrThrow(readBack!.tenantId, tenantId, 'round-trip preserves numeric tenantId');

  // 4. Actor and tenant isolation (foreign reads return null without touching owner record)
  assertEqualOrThrow(
    readExpenseAttempt(otherActorId, tenantId),
    null,
    'another actor on the same tenant reads null',
  );
  assertEqualOrThrow(
    readExpenseAttempt(actorId, otherTenantId),
    null,
    'same actor on another tenant reads null',
  );
  assertEqualOrThrow(
    readExpenseAttempt(actorId, tenantId)?.idempotencyKey,
    created.idempotencyKey,
    'foreign reads leave owner attempt untouched',
  );

  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, created.idempotencyKey),
    true,
    'owner clears round-trip attempt',
  );

  // 5. Legacy unscoped fallback supports string actorId and isolates foreign actors
  const legacySnapshot: ExpenseAttemptSnapshot = {
    ...existingSnapshot,
    idempotencyKey: 'idem-legacy-string-actor',
  };
  storage.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, JSON.stringify(legacySnapshot));
  assertEqualOrThrow(
    readExpenseAttempt(otherActorId, tenantId),
    null,
    'legacy unscoped attempt is ignored by a different actor',
  );
  assertEqualOrThrow(
    readExpenseAttempt(actorId, otherTenantId),
    null,
    'legacy unscoped attempt is ignored by a different tenant',
  );
  assertEqualOrThrow(
    readExpenseAttempt(actorId, tenantId)?.idempotencyKey,
    'idem-legacy-string-actor',
    'legacy unscoped attempt is recovered by matching string actor and numeric tenant',
  );
  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, 'idem-legacy-string-actor'),
    true,
    'clearExpenseAttempt cleans up matching legacy unscoped key',
  );
  assertEqualOrThrow(
    storage.getItem(EXPENSE_ATTEMPT_STORAGE_KEY),
    null,
    'legacy unscoped key is removed after clear',
  );

  // 6. Actor/tenant mismatch inside a scoped slot and malformed records fail closed
  storage.setItem(scopedKey, JSON.stringify({ ...existingSnapshot, actorId: otherActorId }));
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'scoped record with mismatched actorId fails closed',
  );

  storage.setItem(scopedKey, JSON.stringify({ ...existingSnapshot, tenantId: otherTenantId }));
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'scoped record with mismatched tenantId fails closed',
  );

  storage.setItem(scopedKey, JSON.stringify({ ...existingSnapshot, actorId: '' }));
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'record with empty string actorId fails closed',
  );
  storage.setItem(
    expenseAttemptStorageKey('', tenantId),
    JSON.stringify({ ...existingSnapshot, actorId: '' }),
  );
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt('', tenantId)),
    'empty-actor scoped key with empty string actorId fails closed',
  );

  storage.setItem(scopedKey, JSON.stringify({ ...existingSnapshot, actorId: 42 }));
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'record with numeric actorId fails closed',
  );

  storage.setItem(scopedKey, '{malformed-json');
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'malformed JSON in scoped key fails closed',
  );
  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, 'any-key'),
    false,
    'clearExpenseAttempt returns false on malformed JSON',
  );

  storage.setItem(scopedKey, JSON.stringify({ ...existingSnapshot, body: ['not-an-object'] }));
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'snapshot with array body fails closed',
  );

  // 7. Unavailable or broken storage fails closed
  setWindowStorage(undefined);
  assertOrThrow(
    throwsStorageError(() => readExpenseAttempt(actorId, tenantId)),
    'readExpenseAttempt throws when window is unavailable',
  );
  assertOrThrow(
    throwsStorageError(() => persistExpenseAttempt(existingSnapshot)),
    'persistExpenseAttempt throws when window is unavailable',
  );
  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, existingSnapshot.idempotencyKey),
    false,
    'clearExpenseAttempt returns false when window is unavailable',
  );

  const nonPersistingStorage = new FakeStorage();
  nonPersistingStorage.setItem = () => {};
  setWindowStorage(nonPersistingStorage);
  assertOrThrow(
    throwsStorageError(() => persistExpenseAttempt(existingSnapshot)),
    'persistExpenseAttempt throws when storage write cannot be verified on read-back',
  );

  const nonRemovingStorage = new FakeStorage();
  nonRemovingStorage.setItem(scopedKey, JSON.stringify(existingSnapshot));
  nonRemovingStorage.removeItem = () => {};
  setWindowStorage(nonRemovingStorage);
  assertEqualOrThrow(
    clearExpenseAttempt(actorId, tenantId, existingSnapshot.idempotencyKey),
    false,
    'clearExpenseAttempt returns false when removeItem leaves the record in storage',
  );

  // 8. Failure classification helper
  assertEqualOrThrow(
    isUnresolvedExpenseFailure({ response: { status: 500 } }),
    true,
    '500 is unresolved',
  );
  assertEqualOrThrow(
    isUnresolvedExpenseFailure({ response: { status: 503 } }),
    true,
    '503 is unresolved',
  );
  assertEqualOrThrow(
    isUnresolvedExpenseFailure(new Error('Network Error')),
    true,
    'network error is unresolved',
  );
  assertEqualOrThrow(
    isUnresolvedExpenseFailure({ response: { status: 400 } }),
    false,
    '400 is resolved rejection',
  );
  assertEqualOrThrow(
    isUnresolvedExpenseFailure({ response: { status: 409 } }),
    false,
    '409 is resolved rejection',
  );

  const results = getResults();
  console.log(`\nExpense attempt storage: ${results.passed}/${results.total} checks passed`);
  if (results.failed > 0) process.exit(1);
}

main();
