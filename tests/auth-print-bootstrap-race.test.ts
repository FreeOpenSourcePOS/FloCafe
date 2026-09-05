/** Regression coverage for stale session restore overwriting a newer tenant selection. */
import assert from 'node:assert/strict';
import path from 'node:path';

const Module = require('module') as { _load: (...args: any[]) => unknown };
const frontendRequire = Module.createRequire(path.join(process.cwd(), 'frontend/package.json'));
const originalLoad = Module._load;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

const restore = deferred<{ data: { user: any; tenants: any[] } }>();
const selection = deferred<{ data: { access_token: string; tenant: any } }>();
const settings = {
  state: {
    language: 'en',
    billTemplateSource: 'core' as 'core' | null,
    billLanguagePolicy: null as unknown,
    kotLanguagePolicy: null as unknown,
    setLanguage(language: string) { this.language = language; },
    setBillTemplateSource(source: 'core' | null) { this.billTemplateSource = source; },
    setBillLanguagePolicy(policy: unknown) { this.billLanguagePolicy = policy; },
    setKotLanguagePolicy(policy: unknown) { this.kotLanguagePolicy = policy; },
  },
  getState() { return this.state; },
};
const api = {
  get: async (url: string) => {
    assert.equal(url, '/auth/me');
    return restore.promise;
  },
  post: async (url: string) => {
    assert.equal(url, '/auth/tenants/select');
    return selection.promise;
  },
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === '@/lib/api') return api;
  if (request === '@/store/pos-settings') return { usePosSettingsStore: settings };
  if (request === 'zustand') return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
  return originalLoad.apply(this, arguments as any);
};

(globalThis as any).window = {};
(globalThis as any).localStorage = {
  values: new Map<string, string>([['token', 'restore-token'], ['tenant', JSON.stringify({ id: 1 })]]),
  getItem(key: string) { return this.values.get(key) ?? null; },
  setItem(key: string, value: string) { this.values.set(key, value); },
  removeItem(key: string) { this.values.delete(key); },
};

const { useAuthStore } = require('../frontend/src/store/auth') as typeof import('../frontend/src/store/auth');

const tenantA = {
  id: 1, business_name: 'Tenant A', business_type: 'restaurant', country: 'IN', currency: 'INR', timezone: 'UTC',
  plan: 'desktop', status: 'active', language: 'en',
  bill_language_policy: JSON.stringify({ primary: { mode: 'fixed', language: 'es' }, additional: [] }),
  kot_language_policy: JSON.stringify({ primary: { mode: 'fixed', language: 'es' }, additional: [] }),
};
const tenantB = {
  id: 2, business_name: 'Tenant B', business_type: 'restaurant', country: 'IN', currency: 'INR', timezone: 'UTC',
  plan: 'desktop', status: 'active', language: 'en',
  bill_language_policy: JSON.stringify({ primary: { mode: 'fixed', language: 'de' }, additional: [] }),
  kot_language_policy: JSON.stringify({ primary: { mode: 'fixed', language: 'de' }, additional: [] }),
};

async function run(): Promise<void> {
  const restoreRun = useAuthStore.getState().loadFromStorage();
  // A newer tenant-selection operation supersedes the in-flight restore.
  const selectRun = useAuthStore.getState().selectTenant(2);
  selection.resolve({ data: { access_token: 'tenant-b-token', tenant: tenantB } });
  await selectRun;
  restore.resolve({ data: { user: { id: 1, name: 'Owner', email: 'owner@example.test' }, tenants: [tenantA] } });
  await restoreRun;

  assert.equal(useAuthStore.getState().currentTenant?.id, 2, 'stale session restore cannot replace the selected tenant');
  assert.equal(settings.state.billTemplateSource, null, 'tenant selection clears stale bill template provenance');
  assert.equal(settings.state.billLanguagePolicy.primary.language, 'de', 'stale restore cannot replace the receipt policy');
  assert.equal(settings.state.kotLanguagePolicy.primary.language, 'de', 'stale restore cannot replace the KOT policy');
  console.log('✅ stale auth bootstrap result is ignored after tenant selection');
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
