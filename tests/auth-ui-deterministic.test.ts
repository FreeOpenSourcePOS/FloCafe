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
  assert.equal(
    statusOf({ response: { status: '401' } }),
    undefined,
    'string status is not trusted',
  );
  assert.equal(
    statusOf({ response: { status: 401, data: null } }),
    401,
    'null data still parses status',
  );

  const r401 = parseLoginFailure({
    response: { status: 401, data: { error: 'Invalid credentials', attempts_remaining: 3 } },
  });
  assert.equal(r401.status, 401, '401 status parsed');
  assert.equal(r401.attemptsRemaining, 3, 'attempts_remaining parsed');
  assert.equal(r401.message, 'Invalid credentials', '401 message parsed');

  const rLocked = parseLoginFailure({
    response: { status: 401, data: { attempts_remaining: 0, lockout_minutes: 15 } },
  });
  assert.equal(rLocked.attemptsRemaining, 0, 'lockout attempts_remaining=0 parsed');
  assert.equal(rLocked.lockoutMinutes, 15, 'lockout_minutes parsed');

  assert.equal(
    parseLoginFailure({ response: { status: 429, data: { error: 'Too many attempts' } } }).status,
    429,
    '429 status parsed',
  );
  assert.equal(
    parseLoginFailure({ response: { status: 500, data: { error: 'Internal server error' } } })
      .status,
    500,
    '500 status parsed',
  );

  // ── 2. Restricted staff land on an authorized page ──
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'next/navigation') return { usePathname: () => '/', useRouter: () => ({}) };
    if (request === 'use-intl') return { useTranslations: () => () => '' };
    if (request === '@/store/auth') return { useAuthStore: () => ({}) };
    if (request === '@/lib/api') return {};
    if (request === '@/lib/printer/warnings-toast')
      return { showPrintLanguageLoadErrorsToast: () => {} };
    if (request === '@/lib/permissions') {
      return {
        tenantCan: (tenant: { permission_ids?: string[] } | null | undefined, permission: string) =>
          tenant?.permission_ids?.includes(permission) === true,
      };
    }
    if (request === '@/lib/utils')
      return require(path.join(process.cwd(), 'frontend/src/lib/utils'));
    return originalLoad.apply(this, arguments as any);
  };

  const {
    getLandingPage,
    LANDING_PAGE_CANDIDATES,
    PAGE_PERMISSIONS,
  } = require('../frontend/src/components/layout/AuthGuard');
  const tenantWith = (permission: string) => ({ permission_ids: [permission] });
  assert.equal(
    getLandingPage(tenantWith('tables.view')),
    '/tables',
    'tables-only staff land on Tables',
  );
  assert.equal(
    getLandingPage(tenantWith('whatsapp.use')),
    '/whatsapp',
    'WhatsApp-only staff land on WhatsApp',
  );
  assert.equal(
    getLandingPage(tenantWith('unknown.permission')),
    '/auth/login',
    'staff without a page permission fall back to login',
  );

  const pagePermissionsByRoute = new Map<string, string>(PAGE_PERMISSIONS);
  assert.equal(
    pagePermissionsByRoute.get('/addon-groups'),
    'catalog.manage',
    '/addon-groups requires catalog.manage in PAGE_PERMISSIONS',
  );
  assert.equal(
    pagePermissionsByRoute.get('/print-test'),
    'printers.manage',
    '/print-test requires printers.manage in PAGE_PERMISSIONS',
  );
  assert.equal(
    pagePermissionsByRoute.get('/order-history-demo'),
    'dashboard.view',
    '/order-history-demo requires dashboard.view in PAGE_PERMISSIONS',
  );

  const landingRouteByPermission = new Map<string, string>(LANDING_PAGE_CANDIDATES);
  for (const [route, permission] of PAGE_PERMISSIONS) {
    const landingRoute = landingRouteByPermission.get(permission);
    assert.ok(landingRoute, `${route} (${permission}) has a landing-page candidate`);
    assert.equal(
      pagePermissionsByRoute.get(landingRoute),
      permission,
      `${route} has a landing-page candidate (${landingRoute}) with matching permission`,
    );
  }

  // ── 3. Storage-write failure surfaces StorageUnavailableError and leaves state logged out ──
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
  };
  const posSettingsMock = { getState: () => ({ setLanguage: () => {} }) };

  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/api') return serverApi;
    if (request === '@/store/pos-settings') return { usePosSettingsStore: posSettingsMock };
    if (request === 'zustand')
      return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
    return originalLoad.apply(this, arguments as any);
  };

  const throwingStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
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
  assert.ok(
    storageError instanceof StorageUnavailableError,
    'login rejects with StorageUnavailableError when storage fails',
  );
  assert.equal(useAuthStore.getState().user, null, 'user stays null after storage failure');
  assert.equal(useAuthStore.getState().token, null, 'token stays null after storage failure');
  assert.equal(
    useAuthStore.getState().tenants.length,
    0,
    'tenants stay empty after storage failure',
  );
  assert.equal(
    useAuthStore.getState().currentTenant,
    null,
    'currentTenant stays null after storage failure',
  );

  // ── 4. Successful login persists the session when storage is available ──
  const workingStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (globalThis as any).localStorage = workingStorage;
  await useAuthStore.getState().login('owner@cafe.local', 'Pass123!');
  assert.equal(useAuthStore.getState().token, 'tok-123', 'successful login sets the token');
  assert.equal(
    useAuthStore.getState().user?.email,
    'owner@cafe.local',
    'successful login sets the user',
  );
  assert.equal(useAuthStore.getState().tenants.length, 1, 'successful login sets tenants');
  assert.equal(
    useAuthStore.getState().currentTenant?.id,
    1,
    'single-tenant login auto-selects the tenant',
  );

  const originalResolveFilename = Module._resolveFilename;
  const originalWindow = (globalThis as any).window;
  const rootDir = path.resolve(__dirname, '..');

  Module._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
  ) {
    if (request.startsWith('@/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(rootDir, 'frontend/src', request.slice(2)),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@shared/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(rootDir, 'shared', request.slice('@shared/'.length)),
        parent,
        isMain,
        options,
      );
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  try {
    const keydownListeners = new Set<(e: { key: string }) => void>();
    (globalThis as any).window = {
      addEventListener: (type: string, fn: (e: { key: string }) => void) => {
        if (type === 'keydown') keydownListeners.add(fn);
      },
      removeEventListener: (type: string, fn: (e: { key: string }) => void) => {
        if (type === 'keydown') keydownListeners.delete(fn);
      },
    };

    const dispatchKeydown = (key: string) => {
      for (const listener of [...keydownListeners]) {
        listener({ key });
      }
    };

    const states: unknown[] = [];
    const refs: Array<{ current: unknown }> = [];
    const effectSlots: Array<{ deps?: unknown[]; cleanup?: unknown }> = [];
    const pendingEffects: Array<() => void> = [];

    const reactHooks = {
      useState: (initial: unknown) => {
        const idx = currentStateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        const setState = (next: unknown) => {
          states[idx] =
            typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
        };
        return [states[idx], setState];
      },
      useRef: (initial: unknown) => {
        const idx = currentRefIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: (effect: () => unknown, deps?: unknown[]) => {
        const idx = currentEffectIdx++;
        const prev = effectSlots[idx];
        const depsChanged =
          !prev ||
          !deps ||
          !prev.deps ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps![i]));
        if (depsChanged) {
          pendingEffects.push(() => {
            if (prev && typeof prev.cleanup === 'function') {
              prev.cleanup();
            }
            const cleanup = effect();
            effectSlots[idx] = { deps, cleanup };
          });
        }
      },
    };

    let currentStateIdx = 0;
    let currentRefIdx = 0;
    let currentEffectIdx = 0;
    let focusedElement: unknown = null;

    const IconStub = () => null;
    const ButtonStub = (props: Record<string, unknown>) => ({ type: 'Button', props });
    const jsxElement = (type: unknown, props: Record<string, unknown>, key?: unknown) => {
      const el = {
        type,
        props,
        key,
        focus: () => {
          focusedElement = el;
        },
      };
      const ref = props?.ref;
      if (typeof ref === 'function') {
        ref(el);
      } else if (ref && typeof ref === 'object' && 'current' in ref) {
        (ref as { current: unknown }).current = el;
      }
      return el;
    };

    Module._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === 'react') return reactHooks;
      if (request === 'react/jsx-runtime') {
        return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
      }
      if (request === 'use-intl') {
        return { useTranslations: (ns: string) => (key: string) => `${ns}.${key}` };
      }
      if (request === 'react-hot-toast') {
        return { __esModule: true, default: { success: () => {}, error: () => {} } };
      }
      if (request === 'lucide-react') {
        return {
          Plus: IconStub,
          X: IconStub,
          Edit: IconStub,
          RotateCcw: IconStub,
          Eye: IconStub,
          EyeOff: IconStub,
        };
      }
      if (request === '@/components/ui/button') return { Button: ButtonStub };
      if (request === '@/components/settings/PermissionMatrix') {
        return { PermissionMatrix: () => null };
      }
      if (request === '@/components/settings/PermissionAuditLog') {
        return { PermissionAuditLog: () => null };
      }
      if (request === '@/store/auth') {
        return {
          useAuthStore: () => ({
            currentTenant: {
              id: 1,
              role: 'owner',
              permission_ids: [
                'authorization.manage',
                'staff.operational.manage',
                'staff.privileged.manage',
              ],
            },
          }),
        };
      }
      if (request === '@/lib/api') {
        return {
          __esModule: true,
          default: {
            get: async (url: string) => {
              if (url === '/authorization/users' || url === '/staff') {
                return {
                  data: {
                    users: [
                      {
                        id: 'staff-1',
                        name: 'Sam Server',
                        email: 'sam@flo.local',
                        role: 'server',
                        is_active: 1,
                        has_pin: false,
                      },
                    ],
                  },
                };
              }
              if (url === '/kitchen-stations') return { data: { kitchenStations: [] } };
              if (url === '/settings/kds_enabled') return { data: { setting: { value: 'true' } } };
              return { data: {} };
            },
          },
        };
      }
      return originalLoad.apply(this, arguments as any);
    };

    const collectElements = (
      node: unknown,
      predicate: (el: any) => boolean,
      acc: any[] = [],
    ): any[] => {
      if (Array.isArray(node)) {
        for (const child of node) collectElements(child, predicate, acc);
        return acc;
      }
      if (!node || typeof node !== 'object') return acc;
      if (predicate(node)) acc.push(node);
      const children = (node as { props?: { children?: unknown } }).props?.children;
      if (children !== undefined) collectElements(children, predicate, acc);
      return acc;
    };

    const StaffPage = require('../frontend/src/app/(dashboard)/staff/page').default;
    const renderStaffPage = () => {
      currentStateIdx = 0;
      currentRefIdx = 0;
      currentEffectIdx = 0;
      pendingEffects.length = 0;
      const tree = StaffPage();
      while (pendingEffects.length > 0) {
        const runEffect = pendingEffects.shift()!;
        runEffect();
      }
      return tree;
    };

    const findDialog = (tree: unknown) =>
      collectElements(tree, (el) => el.props?.role === 'dialog')[0];

    let tree = renderStaffPage();
    await new Promise((resolve) => setTimeout(resolve, 10));
    tree = renderStaffPage();
    assert.equal(findDialog(tree), undefined, 'staff modal starts closed');

    const findButtonByLabel = (node: unknown, label: string) =>
      collectElements(
        node,
        (el) =>
          el.type === ButtonStub &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes(label),
      )[0];

    for (let attempt = 0; attempt < 2; attempt++) {
      const addButton = findButtonByLabel(tree, 'staff.addButton');
      assert.ok(addButton, 'Add Staff button renders');
      focusedElement = null;
      addButton.props.onClick({ currentTarget: addButton });

      tree = renderStaffPage();
      assert.ok(findDialog(tree), 'Add Staff dialog opens when Add Staff is clicked');
      assert.equal(keydownListeners.size, 1, 'exactly one keydown listener is active while open');

      dispatchKeydown('Enter');
      tree = renderStaffPage();
      assert.ok(findDialog(tree), 'non-Escape key leaves the Add Staff dialog open');

      dispatchKeydown('Escape');
      tree = renderStaffPage();
      assert.equal(findDialog(tree), undefined, 'pressing Escape closes the Add Staff dialog');
      assert.equal(focusedElement, addButton, 'closing Add Staff restores focus to Add Staff');
      assert.equal(
        keydownListeners.size,
        0,
        'window keydown listener is cleaned up when the dialog closes',
      );
    }

    const editButton = findButtonByLabel(tree, 'common.edit');
    assert.ok(editButton, 'Edit Staff button renders for loaded staff row');
    focusedElement = null;
    editButton.props.onClick({ currentTarget: editButton });

    tree = renderStaffPage();
    assert.ok(findDialog(tree), 'Edit Staff dialog opens when Edit is clicked');
    assert.equal(keydownListeners.size, 1, 'exactly one keydown listener is active in Edit Staff');

    dispatchKeydown('Enter');
    tree = renderStaffPage();
    assert.ok(findDialog(tree), 'non-Escape key leaves the Edit Staff dialog open');

    dispatchKeydown('Escape');
    tree = renderStaffPage();
    assert.equal(findDialog(tree), undefined, 'pressing Escape closes the Edit Staff dialog');
    assert.equal(focusedElement, editButton, 'closing Edit Staff restores focus to Edit Staff');
    assert.equal(keydownListeners.size, 0, 'window keydown listener is cleaned up after Edit');

    const resetPwButton = findButtonByLabel(tree, 'staff.resetPwButton');
    assert.ok(resetPwButton, 'Reset Password button renders for loaded staff row');
    focusedElement = null;
    resetPwButton.props.onClick({ currentTarget: resetPwButton });

    tree = renderStaffPage();
    assert.ok(findDialog(tree), 'Reset Password dialog opens when Reset Password is clicked');
    assert.equal(
      keydownListeners.size,
      1,
      'exactly one keydown listener is active in Reset Password',
    );

    dispatchKeydown('Enter');
    tree = renderStaffPage();
    assert.ok(findDialog(tree), 'non-Escape key leaves the Reset Password dialog open');

    dispatchKeydown('Escape');
    tree = renderStaffPage();
    assert.equal(findDialog(tree), undefined, 'pressing Escape closes the Reset Password dialog');
    assert.equal(
      focusedElement,
      resetPwButton,
      'closing Reset Password restores focus to Reset Password',
    );
    assert.equal(
      keydownListeners.size,
      0,
      'window keydown listener is cleaned up after Reset Password',
    );

    for (const slot of effectSlots) {
      if (slot && typeof slot.cleanup === 'function') slot.cleanup();
    }

    // ── 5. Startup expired token 401 & setup-status failure recovery (#1430) ──
    delete require.cache[path.resolve(rootDir, 'frontend/src/lib/api.ts')];
    delete require.cache[path.resolve(rootDir, 'frontend/src/store/auth.ts')];
    delete require.cache[path.resolve(rootDir, 'frontend/src/components/layout/AuthGuard.tsx')];

    const assignedUrls: string[] = [];
    const replacedUrls: string[] = [];
    const memStorage = new Map<string, string>([
      ['token', 'expired-jwt-token'],
      ['tenant', JSON.stringify({ id: 1, business_name: 'Cafe', language: 'en' })],
    ]);
    (globalThis as any).localStorage = {
      getItem: (k: string) => memStorage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memStorage.set(k, String(v));
      },
      removeItem: (k: string) => {
        memStorage.delete(k);
      },
    };
    const windowListeners = new Map<string, Set<(e: any) => void>>();
    (globalThis as any).window = {
      location: {
        origin: 'http://127.0.0.1:3001',
        pathname: '/',
        search: '',
        assign: (url: string) => {
          assignedUrls.push(url);
        },
        replace: (url: string) => {
          replacedUrls.push(url);
        },
      },
      dispatchEvent: (event: { type?: string }) => {
        const type = event?.type;
        if (type && windowListeners.has(type)) {
          for (const fn of [...windowListeners.get(type)!]) fn(event);
        }
        return true;
      },
      addEventListener: (type: string, fn: (e: any) => void) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: any) => void) => {
        windowListeners.get(type)?.delete(fn);
      },
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      cancelAnimationFrame: () => {},
    };

    const axiosPkg = frontendRequire('axios');
    Module._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === 'axios') return axiosPkg;
      if (request === 'zustand') {
        return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
      }
      if (request === '@/store/pos-settings') return { usePosSettingsStore: posSettingsMock };
      return originalLoad.apply(this, arguments as any);
    };

    const realApi = require('../frontend/src/lib/api').default;
    realApi.defaults.adapter = async (config: any) => {
      throw new axiosPkg.AxiosError(
        'Request failed with status code 401',
        'ERR_BAD_REQUEST',
        config,
        null,
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          config,
          data: { error: 'Token expired' },
        },
      );
    };

    const { useAuthStore: realAuthStore } = require('../frontend/src/store/auth');
    realAuthStore.setState({
      user: { id: 'u1', name: 'Owner', email: 'owner@cafe.local', role: 'owner' },
      token: 'expired-jwt-token',
      tenants: [{ id: 1, business_name: 'Cafe', language: 'en' }],
      currentTenant: { id: 1, business_name: 'Cafe', language: 'en' },
      loading: true,
    });

    await realAuthStore.getState().loadFromStorage();

    assert.equal(
      assignedUrls.length,
      0,
      'expired token during bootstrap loadFromStorage() must not trigger competing window.location.assign',
    );
    assert.equal(memStorage.get('token'), undefined, 'expired token is removed from localStorage');
    assert.equal(memStorage.get('tenant'), undefined, 'stored tenant is removed from localStorage');
    assert.equal(realAuthStore.getState().user, null, 'user is cleared after 401 bootstrap');
    assert.equal(realAuthStore.getState().token, null, 'token is cleared after 401 bootstrap');
    assert.equal(
      realAuthStore.getState().currentTenant,
      null,
      'currentTenant is cleared after 401 bootstrap',
    );
    assert.equal(realAuthStore.getState().loading, false, 'loading is false after 401 bootstrap');

    // Non-bootstrap 401 requests still redirect via window.location.assign('/auth/login')
    memStorage.set('token', 'active-expired-token');
    memStorage.set('tenant', JSON.stringify({ id: 1 }));
    await realApi.get('/orders').catch(() => {});
    assert.deepEqual(
      assignedUrls,
      ['/auth/login'],
      'non-bootstrap 401 still redirects to /auth/login via window.location.assign',
    );

    // 5b. AuthGuard setup-status check retries on transient error and falls back to /auth/login (never /setup)
    const pushedRoutes: string[] = [];
    const scheduledTimers: Array<{ fn: () => void; delay: number; cleared: boolean }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;

    (globalThis as any).setTimeout = (fn: () => void, delay?: number) => {
      const entry = { fn, delay: Number(delay ?? 0), cleared: false };
      scheduledTimers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    };
    (globalThis as any).clearTimeout = (handle: unknown) => {
      if (handle && typeof handle === 'object' && 'cleared' in (handle as any)) {
        (handle as { cleared: boolean }).cleared = true;
      }
    };
    console.error = () => {};
    console.warn = () => {};

    try {
      let setupStatusCalls = 0;
      let setupStatusHandler: () => Promise<{
        data: { needsSetup: boolean; masterPinAvailable?: boolean };
      }> = async () => ({ data: { needsSetup: false } });

      const guardApiMock = {
        get: (url: string) => {
          if (url === '/auth/setup/status') {
            setupStatusCalls++;
            return setupStatusHandler();
          }
          throw new Error(`Unexpected GET ${url}`);
        },
      };

      const guardAuthState = {
        user: null,
        currentTenant: null,
        loading: false,
        printLanguageLoadErrors: [],
        loadFromStorage: () => {},
        refreshAuthContext: async () => {},
      };

      const useAuthStoreGuardStub = (selector?: (s: typeof guardAuthState) => unknown) =>
        selector ? selector(guardAuthState) : guardAuthState;

      Module._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === 'react') {
          return {
            ...reactHooks,
            useCallback: (fn: unknown) => fn,
          };
        }
        if (request === 'react/jsx-runtime') {
          return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
        }
        if (request === 'next/navigation') {
          return {
            usePathname: () => '/',
            useRouter: () => ({
              push: (url: string) => pushedRoutes.push(url),
              replace: (url: string) => pushedRoutes.push(url),
            }),
          };
        }
        if (request === 'use-intl') {
          return {
            useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
            useLocale: () => 'en',
          };
        }
        if (request === '@/store/auth') {
          return { useAuthStore: useAuthStoreGuardStub };
        }
        if (request === '@/lib/api') {
          return { __esModule: true, default: guardApiMock };
        }
        if (request === '@/lib/printer/warnings-toast') {
          return { showPrintLanguageLoadErrorsToast: () => {} };
        }
        return originalLoad.apply(this, arguments as any);
      };

      const AuthGuardComponent = require('../frontend/src/components/layout/AuthGuard').default;
      const flushMicrotasks = async () => {
        for (let i = 0; i < 6; i++) {
          await Promise.resolve();
        }
      };

      const renderAuthGuard = () => {
        currentStateIdx = 0;
        currentRefIdx = 0;
        currentEffectIdx = 0;
        pendingEffects.length = 0;
        const tree = AuthGuardComponent({ children: 'protected-child' });
        while (pendingEffects.length > 0) {
          const runEffect = pendingEffects.shift()!;
          runEffect();
        }
        return tree;
      };

      // Subcase 1: first /auth/setup/status attempt fails, retry succeeds with needsSetup: false
      states.length = 0;
      refs.length = 0;
      effectSlots.length = 0;
      pushedRoutes.length = 0;
      scheduledTimers.length = 0;
      setupStatusCalls = 0;
      setupStatusHandler = async () => {
        if (setupStatusCalls === 1) {
          throw new Error('Network Error');
        }
        return { data: { needsSetup: false } };
      };

      renderAuthGuard();
      await flushMicrotasks();

      assert.equal(setupStatusCalls, 1, 'AuthGuard makes initial /auth/setup/status request');
      assert.equal(
        pushedRoutes.includes('/setup'),
        false,
        'AuthGuard does not redirect to /setup after a single /auth/setup/status error',
      );
      const activeRetryTimers = scheduledTimers.filter((t) => !t.cleared);
      assert.equal(
        activeRetryTimers.length,
        1,
        'AuthGuard schedules a retry timer on transient failure',
      );

      activeRetryTimers[0].fn();
      await flushMicrotasks();
      renderAuthGuard();

      assert.equal(setupStatusCalls, 2, 'AuthGuard retries /auth/setup/status');
      assert.deepEqual(
        pushedRoutes,
        ['/auth/login'],
        'AuthGuard redirects unauthenticated user to /auth/login once retry resolves needsSetup: false',
      );

      // Subcase 2: all /auth/setup/status retries fail -> falls back to needsSetup: false (/auth/login), never /setup
      for (const slot of effectSlots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      }
      states.length = 0;
      refs.length = 0;
      effectSlots.length = 0;
      pushedRoutes.length = 0;
      scheduledTimers.length = 0;
      setupStatusCalls = 0;
      setupStatusHandler = async () => {
        throw new Error('Network Error');
      };

      renderAuthGuard();
      await flushMicrotasks();

      while (scheduledTimers.some((t) => !t.cleared)) {
        const nextTimer = scheduledTimers.find((t) => !t.cleared)!;
        nextTimer.cleared = true;
        nextTimer.fn();
        await flushMicrotasks();
      }
      renderAuthGuard();

      assert.ok(
        setupStatusCalls >= 3,
        'AuthGuard attempts initial call plus bounded retries before fallback',
      );
      assert.equal(
        pushedRoutes.includes('/setup'),
        false,
        'AuthGuard never routes to /setup when /auth/setup/status fails across all retries',
      );
      assert.deepEqual(
        pushedRoutes,
        ['/auth/login'],
        'AuthGuard falls back to /auth/login when /auth/setup/status fails across all retries',
      );

      // Subcase 2b: when /auth/setup/status explicitly returns needsSetup: true, AuthGuard routes to /setup
      for (const slot of effectSlots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      }
      states.length = 0;
      refs.length = 0;
      effectSlots.length = 0;
      pushedRoutes.length = 0;
      scheduledTimers.length = 0;
      setupStatusCalls = 0;
      setupStatusHandler = async () => ({ data: { needsSetup: true } });

      renderAuthGuard();
      await flushMicrotasks();
      renderAuthGuard();

      assert.equal(
        setupStatusCalls,
        1,
        'AuthGuard queries /auth/setup/status once when it succeeds',
      );
      assert.deepEqual(
        pushedRoutes,
        ['/setup'],
        'AuthGuard still routes to /setup when server explicitly reports needsSetup: true',
      );

      // Subcase 3: SetupPage mount check retries transient /auth/setup/status failure and redirects when needsSetup: false
      for (const slot of effectSlots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      }
      states.length = 0;
      refs.length = 0;
      effectSlots.length = 0;
      scheduledTimers.length = 0;
      replacedUrls.length = 0;
      setupStatusCalls = 0;
      setupStatusHandler = async () => {
        if (setupStatusCalls === 1) {
          throw new Error('Network Error');
        }
        return { data: { needsSetup: false, masterPinAvailable: true } };
      };

      Module._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === 'react') {
          return {
            ...reactHooks,
            useCallback: (fn: unknown) => fn,
          };
        }
        if (request === 'react/jsx-runtime') {
          return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
        }
        if (request === 'axios') return axiosPkg;
        if (request === '@/lib/api') return { __esModule: true, default: guardApiMock };
        if (request === '@/store/auth') return { useAuthStore: () => ({ logout: () => {} }) };
        if (request === '@/store/pos-settings') {
          return {
            usePosSettingsStore: Object.assign(
              (selector: (s: { language: string; setLanguage: () => void }) => unknown) =>
                selector({ language: 'en', setLanguage: () => {} }),
              { getState: () => ({ setLanguage: () => {} }) },
            ),
          };
        }
        if (request === '@/components/ui/button') return { Button: ButtonStub };
        if (request === '@/components/ui/input') return { Input: IconStub };
        if (request === '@/components/ui/label') return { Label: IconStub };
        if (request === '@/components/ui/card') return { Card: IconStub, CardContent: IconStub };
        if (request === 'lucide-react') {
          return new Proxy({}, { get: () => IconStub });
        }
        if (request === 'react-hot-toast') {
          return { __esModule: true, default: { success: () => {}, error: () => {} } };
        }
        if (request === '@/components/TimeZoneSelect') return { TimeZoneSelect: IconStub };
        if (request === '@/components/CurrencySelect') return { CurrencySelect: IconStub };
        if (request === '@/lib/countries') {
          return {
            COUNTRIES: [],
            getCountryByCode: () => undefined,
            getLocalizedCountryName: () => '',
            countryMatchesQuery: () => true,
            sortCountriesByLocalizedName: (c: unknown[]) => c,
          };
        }
        if (request === '@/lib/i18n') {
          return {
            LANGUAGES: { en: { selectable: true } },
            getBrowserLanguage: () => 'en',
          };
        }
        if (request === 'use-intl') {
          return {
            useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
            useLocale: () => 'en',
          };
        }
        if (request === '@/hooks/use-confirm') {
          return { useConfirm: () => ({ confirm: async () => false, ConfirmDialog: IconStub }) };
        }
        if (request === '@/components/layout/MenuActionHandler') {
          return { RESTORE_FROM_FILE_EVENT: 'flo:restore-from-file' };
        }
        return originalLoad.apply(this, arguments as any);
      };

      delete require.cache[path.resolve(rootDir, 'frontend/src/app/setup/page.tsx')];
      const SetupPageComponent = require('../frontend/src/app/setup/page').default;
      currentStateIdx = 0;
      currentRefIdx = 0;
      currentEffectIdx = 0;
      pendingEffects.length = 0;
      const setupStep1Tree = SetupPageComponent();
      while (pendingEffects.length > 0) {
        const runEffect = pendingEffects.shift()!;
        runEffect();
      }
      await flushMicrotasks();

      const findNodes = (
        node: unknown,
        predicate: (el: { type: unknown; props?: Record<string, unknown> }) => boolean,
        out: Array<{ type: unknown; props?: Record<string, unknown> }> = [],
      ): Array<{ type: unknown; props?: Record<string, unknown> }> => {
        if (!node) return out;
        if (Array.isArray(node)) {
          for (const child of node) findNodes(child, predicate, out);
          return out;
        }
        if (typeof node === 'object') {
          const el = node as { type: unknown; props?: Record<string, unknown> };
          if (predicate(el)) out.push(el);
          if (el.props && 'children' in el.props) {
            findNodes(el.props.children, predicate, out);
          }
        }
        return out;
      };

      const step1Callouts = findNodes(
        setupStep1Tree,
        (el) => el.props?.['data-testid'] === 'setup-restore-backup-callout',
      );
      const step1Buttons = findNodes(
        setupStep1Tree,
        (el) => el.props?.['data-testid'] === 'setup-restore-backup-button',
      );
      assert.equal(
        step1Callouts.length,
        1,
        'SetupPage renders top-level restore backup callout on Step 1',
      );
      assert.equal(
        step1Buttons.length,
        1,
        'SetupPage renders setup-restore-backup-button on Step 1',
      );

      // Verify the callout appears before the main wizard Card inside the setup container
      const containerNodes = findNodes(
        setupStep1Tree,
        (el) =>
          Array.isArray(el.props?.children) &&
          (el.props!.children as unknown[]).some(
            (child: any) => child?.props?.['data-testid'] === 'setup-restore-backup-callout',
          ),
      );
      assert.equal(containerNodes.length, 1, 'Found setup wizard container holding callout');
      const containerChildren = containerNodes[0].props!.children as Array<any>;
      const calloutIndex = containerChildren.findIndex(
        (c) => c?.props?.['data-testid'] === 'setup-restore-backup-callout',
      );
      const cardIndex = containerChildren.findIndex((c) => c?.type === IconStub);
      assert.equal(
        calloutIndex >= 0 && cardIndex > calloutIndex,
        true,
        'Restore backup callout is rendered above the main wizard Card',
      );

      // Advance to Step 2 and verify the callout and button remain visible
      states[0] = 2;
      currentStateIdx = 0;
      currentRefIdx = 0;
      currentEffectIdx = 0;
      const setupStep2Tree = SetupPageComponent();
      const step2Buttons = findNodes(
        setupStep2Tree,
        (el) => el.props?.['data-testid'] === 'setup-restore-backup-button',
      );
      assert.equal(
        step2Buttons.length,
        1,
        'setup-restore-backup-button remains rendered on Step 2',
      );
      assert.equal(
        step2Buttons[0].props?.disabled,
        false,
        'setup-restore-backup-button is enabled when loading is false',
      );

      // Verify clicking setup-restore-backup-button and dispatching RESTORE_FROM_FILE_EVENT invoke pickRestoreFile
      let pickRestoreCalls = 0;
      (globalThis as any).window.electronAPI = {
        platform: 'win32',
        pickRestoreFile: async () => {
          pickRestoreCalls++;
          return { canceled: true };
        },
      };
      await (step2Buttons[0].props?.onClick as () => Promise<void>)();
      assert.equal(
        pickRestoreCalls,
        1,
        'Clicking setup-restore-backup-button invokes window.electronAPI.pickRestoreFile',
      );
      (globalThis as any).window.dispatchEvent({ type: 'flo:restore-from-file' });
      await flushMicrotasks();
      assert.equal(
        pickRestoreCalls,
        2,
        'Dispatching RESTORE_FROM_FILE_EVENT on /setup invokes window.electronAPI.pickRestoreFile',
      );
      delete (globalThis as any).window.electronAPI;

      assert.equal(
        setupStatusCalls,
        1,
        'SetupPage makes initial /auth/setup/status request on mount',
      );
      const setupRetryTimers = scheduledTimers.filter((t) => !t.cleared);
      assert.equal(
        setupRetryTimers.length,
        1,
        'SetupPage schedules retry on transient setup status error',
      );
      setupRetryTimers[0].cleared = true;
      setupRetryTimers[0].fn();
      await flushMicrotasks();

      assert.equal(
        setupStatusCalls,
        2,
        'SetupPage retries /auth/setup/status after transient error',
      );
      assert.deepEqual(
        replacedUrls,
        ['/auth/login'],
        'SetupPage redirects to /auth/login when retry confirms setup is already completed',
      );

      // Subcase 4: LoginPage mount check retries transient /api/auth/setup/status failure and redirects to /setup when needsSetup: true
      for (const slot of effectSlots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      }
      states.length = 0;
      refs.length = 0;
      effectSlots.length = 0;
      scheduledTimers.length = 0;
      pushedRoutes.length = 0;
      setupStatusCalls = 0;

      const originalFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = async (url: string) => {
        if (url === '/api/auth/setup/status') {
          setupStatusCalls++;
          if (setupStatusCalls === 1) {
            return { ok: false, status: 503, json: async () => ({}) };
          }
          return { ok: true, status: 200, json: async () => ({ needsSetup: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'ok', users: [] }) };
      };

      try {
        Module._load = function (request: string, parent: unknown, isMain: boolean) {
          if (request === 'react') {
            return {
              ...reactHooks,
              Suspense: 'Suspense',
              useCallback: (fn: unknown) => fn,
            };
          }
          if (request === 'react/jsx-runtime') {
            return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
          }
          if (request === 'next/navigation') {
            return {
              useRouter: () => ({
                push: (url: string) => pushedRoutes.push(url),
                replace: (url: string) => pushedRoutes.push(url),
              }),
              useSearchParams: () => new URLSearchParams(),
            };
          }
          if (request === 'use-intl') {
            return {
              useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
            };
          }
          if (request === '@/store/auth') {
            return {
              StorageUnavailableError,
              useAuthStore: () => ({
                login: async () => {},
                pinLogin: async () => {},
                selectTenant: async () => {},
                user: null,
                tenants: [],
                currentTenant: null,
                loadFromStorage: () => {},
              }),
            };
          }
          if (request === '@/components/ui/button') return { Button: ButtonStub };
          if (request === '@/components/ui/input') return { Input: IconStub };
          if (request === '@/components/ui/label') return { Label: IconStub };
          if (request === '@/components/ui/card') return { Card: IconStub, CardContent: IconStub };
          if (request === '@/components/ui/dialog') {
            return {
              Dialog: IconStub,
              DialogContent: IconStub,
              DialogHeader: IconStub,
              DialogTitle: IconStub,
            };
          }
          if (request === '@/components/ui/dropdown-menu') {
            return {
              DropdownMenu: IconStub,
              DropdownMenuContent: IconStub,
              DropdownMenuItem: IconStub,
              DropdownMenuTrigger: IconStub,
            };
          }
          if (request === '@/components/support/SupportTicketForm') {
            return { SupportTicketForm: IconStub, PRE_LOGIN_SUPPORT_ENDPOINTS: {} };
          }
          if (request === 'lucide-react') return new Proxy({}, { get: () => IconStub });
          if (request === 'react-hot-toast') {
            return { __esModule: true, default: { success: () => {}, error: () => {} } };
          }
          return originalLoad.apply(this, arguments as any);
        };

        delete require.cache[path.resolve(rootDir, 'frontend/src/app/auth/login/page.tsx')];
        const LoginPageComponent = require('../frontend/src/app/auth/login/page').default;
        currentStateIdx = 0;
        currentRefIdx = 0;
        currentEffectIdx = 0;
        pendingEffects.length = 0;
        const suspenseWrapper = LoginPageComponent();
        suspenseWrapper.props.children.type(suspenseWrapper.props.children.props);
        while (pendingEffects.length > 0) {
          const runEffect = pendingEffects.shift()!;
          runEffect();
        }
        await flushMicrotasks();

        assert.equal(
          setupStatusCalls,
          1,
          'LoginPage makes initial /api/auth/setup/status request on mount',
        );
        const loginRetryTimers = scheduledTimers.filter((t) => !t.cleared);
        assert.equal(
          loginRetryTimers.length,
          1,
          'LoginPage schedules a retry when /api/auth/setup/status fails transiently',
        );
        loginRetryTimers[0].cleared = true;
        loginRetryTimers[0].fn();
        await flushMicrotasks();

        assert.equal(
          setupStatusCalls,
          2,
          'LoginPage retries /api/auth/setup/status after transient failure',
        );
        assert.deepEqual(
          pushedRoutes,
          ['/setup'],
          'LoginPage redirects to /setup when retry confirms needsSetup: true',
        );

        // Subcase 5: DesktopDragSurface exposes ApplicationMenuRow on standalone routes (/setup, /auth/*) and omits it on dashboard routes
        let mockPathname = '/setup';
        const AppMenuRowStub = () => ({ type: 'ApplicationMenuRow' });
        const WindowControlsStub = () => ({ type: 'WindowControls' });
        Module._load = function (request: string, parent: unknown, isMain: boolean) {
          if (request === 'react') {
            return {
              ...reactHooks,
              useSyncExternalStore: (_sub: unknown, getSnap: () => boolean) => getSnap(),
            };
          }
          if (request === 'react/jsx-runtime') {
            return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
          }
          if (request === 'next/navigation') {
            return { usePathname: () => mockPathname };
          }
          if (request === './ApplicationMenuRow') {
            return { __esModule: true, default: AppMenuRowStub };
          }
          if (request === './WindowControls') {
            return { __esModule: true, default: WindowControlsStub };
          }
          if (request === './titlebar-sync') {
            return { useDesktopTitleBarSync: () => {} };
          }
          return originalLoad.apply(this, arguments as any);
        };

        delete require.cache[
          path.resolve(rootDir, 'frontend/src/components/layout/DesktopDragSurface.tsx')
        ];
        const {
          default: DesktopDragSurface,
          isStandaloneMenuRoute,
        } = require('../frontend/src/components/layout/DesktopDragSurface');

        assert.equal(isStandaloneMenuRoute('/setup'), true, '/setup is a standalone menu route');
        assert.equal(isStandaloneMenuRoute('/setup/'), true, '/setup/ is a standalone menu route');
        assert.equal(
          isStandaloneMenuRoute('/auth/login'),
          true,
          '/auth/login is a standalone menu route',
        );
        assert.equal(
          isStandaloneMenuRoute('/auth/recover'),
          true,
          '/auth/recover is a standalone menu route',
        );
        assert.equal(isStandaloneMenuRoute('/pos'), false, '/pos is not a standalone menu route');
        assert.equal(
          isStandaloneMenuRoute('/dashboard'),
          false,
          '/dashboard is not a standalone menu route',
        );

        (globalThis as any).window.electronAPI = { getStatus: async () => ({}) };
        mockPathname = '/setup';
        const setupSurfaceTree = DesktopDragSurface();
        const setupMenuNodes = findNodes(setupSurfaceTree, (el) => el.type === AppMenuRowStub);
        const setupSafeAreas = findNodes(
          setupSurfaceTree,
          (el) =>
            typeof el.props?.className === 'string' &&
            el.props.className.includes('flo-title-bar__safe-area'),
        );
        assert.equal(
          setupMenuNodes.length,
          1,
          'DesktopDragSurface renders ApplicationMenuRow on /setup',
        );
        assert.equal(
          setupSafeAreas.length,
          1,
          'DesktopDragSurface wraps ApplicationMenuRow in .flo-title-bar__safe-area on /setup',
        );

        mockPathname = '/pos';
        const posSurfaceTree = DesktopDragSurface();
        const posMenuNodes = findNodes(posSurfaceTree, (el) => el.type === AppMenuRowStub);
        assert.equal(
          posMenuNodes.length,
          0,
          'DesktopDragSurface does not duplicate ApplicationMenuRow on /pos',
        );
        delete (globalThis as any).window.electronAPI;

        // Subcase 6: MenuActionHandler routes Cmd/Ctrl+Shift+R and menu-restore-from-file on /setup and /auth/login
        for (const slot of effectSlots) {
          if (slot && typeof slot.cleanup === 'function') slot.cleanup();
        }
        states.length = 0;
        refs.length = 0;
        effectSlots.length = 0;
        pushedRoutes.length = 0;

        let menuActionCallback: ((action: string) => void) | null = null;
        let dispatchedRestoreEvents = 0;
        const onRestoreEvent = () => {
          dispatchedRestoreEvents++;
        };
        (globalThis as any).window.addEventListener('flo-restore-from-file', onRestoreEvent);
        (globalThis as any).CustomEvent = class CustomEvent {
          type: string;
          constructor(type: string) {
            this.type = type;
          }
        };
        (globalThis as any).window.electronAPI = {
          onMenuAction: (cb: (action: string) => void) => {
            menuActionCallback = cb;
            return () => {
              menuActionCallback = null;
            };
          },
        };

        Module._load = function (request: string, parent: unknown, isMain: boolean) {
          if (request === 'react') {
            return {
              ...reactHooks,
            };
          }
          if (request === 'react/jsx-runtime') {
            return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
          }
          if (request === 'next/navigation') {
            return {
              useRouter: () => ({
                push: (url: string) => pushedRoutes.push(url),
              }),
            };
          }
          if (request === 'use-intl') {
            return {
              useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
            };
          }
          if (request === 'react-hot-toast') {
            return {
              __esModule: true,
              default: { loading: () => {}, success: () => {}, error: () => {}, remove: () => {} },
            };
          }
          if (request === '@/components/settings/MasterPinPrompt') {
            return { MasterPinPrompt: IconStub };
          }
          if (request === '@/lib/quick-search') {
            return { dispatchQuickSearchRequest: () => {} };
          }
          if (request === '@/store/auth') {
            return {
              useAuthStore: {
                getState: () => ({ user: null, loading: false, lock: async () => {} }),
                subscribe: () => () => {},
              },
            };
          }
          if (request === '@/lib/api') {
            return {
              __esModule: true,
              default: {
                get: async (url: string) => {
                  if (url === '/auth/setup/status') {
                    return { data: { needsSetup: true } };
                  }
                  throw new Error(`Unexpected GET ${url}`);
                },
              },
            };
          }
          return originalLoad.apply(this, arguments as any);
        };

        delete require.cache[
          path.resolve(rootDir, 'frontend/src/components/layout/MenuActionHandler.tsx')
        ];
        const MenuActionHandlerComponent =
          require('../frontend/src/components/layout/MenuActionHandler').default;
        currentStateIdx = 0;
        currentRefIdx = 0;
        currentEffectIdx = 0;
        pendingEffects.length = 0;
        MenuActionHandlerComponent();
        while (pendingEffects.length > 0) {
          const runEffect = pendingEffects.shift()!;
          runEffect();
        }

        (globalThis as any).window.location.pathname = '/setup';
        let prevented = false;
        (globalThis as any).window.dispatchEvent({
          type: 'keydown',
          key: 'R',
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          defaultPrevented: false,
          preventDefault: () => {
            prevented = true;
          },
        });
        await flushMicrotasks();
        assert.equal(prevented, true, 'MenuActionHandler prevents default on Ctrl+Shift+R');
        assert.equal(
          dispatchedRestoreEvents,
          1,
          'MenuActionHandler dispatches RESTORE_FROM_FILE_EVENT when Ctrl+Shift+R is pressed on /setup',
        );

        // Repeated keydown events (repeat: true) are ignored
        (globalThis as any).window.dispatchEvent({
          type: 'keydown',
          key: 'R',
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          repeat: true,
          defaultPrevented: false,
          preventDefault: () => {},
        });
        await flushMicrotasks();
        assert.equal(
          dispatchedRestoreEvents,
          1,
          'MenuActionHandler ignores repeated keydown events for Ctrl+Shift+R',
        );

        (globalThis as any).window.location.pathname = '/auth/login';
        assert.ok(menuActionCallback, 'MenuActionHandler registers onMenuAction listener');
        (menuActionCallback as (action: string) => void)('menu-restore-from-file');
        await flushMicrotasks();
        assert.deepEqual(
          pushedRoutes,
          ['/setup?action=restore-from-file'],
          'MenuActionHandler routes menu-restore-from-file to /setup?action=restore-from-file when needsSetup is true off /setup',
        );

        (globalThis as any).window.removeEventListener('flo-restore-from-file', onRestoreEvent);
        delete (globalThis as any).window.electronAPI;
      } finally {
        (globalThis as any).fetch = originalFetch;
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }
  } finally {
    Module._resolveFilename = originalResolveFilename;
    (globalThis as any).window = originalWindow;
  }

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
