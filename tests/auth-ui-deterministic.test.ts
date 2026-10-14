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
