/**
 * Regression coverage for deterministic auth login error handling (#229).
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/auth-ui-deterministic.test.ts
 */

const assert = require('node:assert/strict');
const Module = require('module');
const path = require('node:path');
const frontendRequire = Module.createRequire(path.join(process.cwd(), 'frontend/package.json'));
const originalLoad = Module._load;

const { parseLoginFailure } = require('../frontend/src/lib/login-errors');

async function run() {
  console.log('Deterministic auth login error handling (#229)');
  console.log('='.repeat(60));

  // ── 1. parseLoginFailure normalizes unknown rejection values safely ──
  const statusOf = (err: unknown) => parseLoginFailure(err).status;
  assert.equal(statusOf(null), undefined, 'null rejection has no status');
  assert.equal(statusOf(undefined), undefined, 'undefined rejection has no status');
  assert.equal(statusOf('boom'), undefined, 'string rejection has no status');
  assert.equal(statusOf(new Error('network down')), undefined, 'plain Error has no status');
  assert.equal(statusOf({ response: 'nope' }), undefined, 'non-object response has no status');
  assert.equal(statusOf({ response: { status: '401' } }), undefined, 'string status is not trusted');
  assert.equal(statusOf({ response: { status: 401, data: null } }), 401, 'null data still parses status');

  const r401 = parseLoginFailure({ response: { status: 401, data: { error: 'Invalid credentials', attempts_remaining: 3 } } });
  assert.equal(r401.status, 401, '401 status parsed');
  assert.equal(r401.attemptsRemaining, 3, 'attempts_remaining parsed');
  assert.equal(r401.message, 'Invalid credentials', '401 message parsed');

  const rLocked = parseLoginFailure({ response: { status: 401, data: { attempts_remaining: 0, lockout_minutes: 15 } } });
  assert.equal(rLocked.attemptsRemaining, 0, 'lockout attempts_remaining=0 parsed');
  assert.equal(rLocked.lockoutMinutes, 15, 'lockout_minutes parsed');

  assert.equal(parseLoginFailure({ response: { status: 429, data: { error: 'Too many attempts' } } }).status, 429, '429 status parsed');
  assert.equal(parseLoginFailure({ response: { status: 500, data: { error: 'Internal server error' } } }).status, 500, '500 status parsed');

  // ── 2. Storage-write failure surfaces StorageUnavailableError and leaves state logged out ──
  const serverApi = {
    post: async (url: string) => {
      if (url === '/auth/login') {
        return {
          data: {
            access_token: 'tok-123',
            tenants: [{ id: 1, business_name: 'Cafe', language: 'en' }],
            user: { id: 'u1', name: 'Owner', email: 'owner@cafe.local', role: 'owner' },
          },
        };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    get: async (url: string) => {
      assert.ok(
        url === '/settings/bill_language_policy' || url === '/settings/kot_language_policy',
        `unexpected GET ${url}`,
      );
      return { data: { setting: { value: '{"primary":{"mode":"inherit"},"additional":[]}' } } };
    },
  };
  const posSettingsMock = {
    getState: () => ({
      setLanguage: () => {},
      setBillLanguagePolicy: () => {},
      setKotLanguagePolicy: () => {},
    }),
  };

  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/api') return serverApi;
    if (request === '@/store/pos-settings') return { usePosSettingsStore: posSettingsMock };
    if (request === '@print/policy') return originalLoad.call(this, path.join(process.cwd(), 'shared/print/policy.ts'), parent, isMain);
    if (request === 'zustand') return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
    return originalLoad.apply(this, arguments as any);
  };

  const throwingStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  (globalThis as any).localStorage = throwingStorage;

  const { useAuthStore, StorageUnavailableError } = require('../frontend/src/store/auth');

  let storageError: unknown = null;
  try {
    await useAuthStore.getState().login('owner@cafe.local', 'Pass123!');
  } catch (err) {
    storageError = err;
  }
  assert.ok(storageError instanceof StorageUnavailableError, 'login rejects with StorageUnavailableError when storage fails');
  assert.equal(useAuthStore.getState().user, null, 'user stays null after storage failure');
  assert.equal(useAuthStore.getState().token, null, 'token stays null after storage failure');
  assert.equal(useAuthStore.getState().tenants.length, 0, 'tenants stay empty after storage failure');
  assert.equal(useAuthStore.getState().currentTenant, null, 'currentTenant stays null after storage failure');

  // ── 3. Successful login persists the session when storage is available ──
  const workingStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (globalThis as any).localStorage = workingStorage;
  await useAuthStore.getState().login('owner@cafe.local', 'Pass123!');
  assert.equal(useAuthStore.getState().token, 'tok-123', 'successful login sets the token');
  assert.equal(useAuthStore.getState().user?.email, 'owner@cafe.local', 'successful login sets the user');
  assert.equal(useAuthStore.getState().tenants.length, 1, 'successful login sets tenants');
  assert.equal(useAuthStore.getState().currentTenant?.id, 1, 'single-tenant login auto-selects the tenant');

  console.log('\n✅ Deterministic auth login error handling tests passed');
}

run()
  .catch((error: unknown) => {
    console.error('\n❌ Test failed:');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
