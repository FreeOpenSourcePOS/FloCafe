/**
 * Regression tests for QrMenuSettingsTab automatic status refresh on Google Drive
 * reconnect, disconnect, and window focus / visibility return.
 *
 * Run: npm run test:qr-menu-settings-tab-refresh
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
  _load: (request: string, parent: any, isMain: boolean) => any;
};
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

const reactPath = frontendRequire.resolve('react');
const reactJsxRuntimePath = frontendRequire.resolve('react/jsx-runtime');
const reactDomPath = frontendRequire.resolve('react-dom');
const reactDomServerPath = frontendRequire.resolve('react-dom/server');
const useIntlPath = frontendRequire.resolve('use-intl');
const RealReact = frontendRequire('react');
const RealJsxRuntime = frontendRequire('react/jsx-runtime');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');

type MenuPrefs = {
  template: 'mobile-cafe' | 'classic-bistro' | 'standard';
  pageSize: 'A4' | 'Letter';
  includeDescriptions: boolean;
  includeModifiers: boolean;
  includePhotos: boolean;
  includeOutOfStock: boolean;
  includeInactive: boolean;
  includeHidden: boolean;
};

type QrMenuStatusPayload = {
  configured: boolean;
  connected: boolean;
  published: boolean;
  file_name: string | null;
  web_view_link: string | null;
  sharing_enabled: boolean;
  source: 'generated' | 'uploaded' | null;
  updated_at: string | null;
  qr_data_url: string | null;
  qr_download_data_url: string | null;
  generator_prefs: MenuPrefs;
};

function makePrefs(overrides: Partial<MenuPrefs> = {}): MenuPrefs {
  return {
    template: 'mobile-cafe',
    pageSize: 'A4',
    includeDescriptions: true,
    includeModifiers: true,
    includePhotos: false,
    includeOutOfStock: false,
    includeInactive: false,
    includeHidden: false,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<QrMenuStatusPayload> = {}): QrMenuStatusPayload {
  return {
    configured: true,
    connected: false,
    published: false,
    file_name: null,
    web_view_link: null,
    sharing_enabled: false,
    source: null,
    updated_at: null,
    qr_data_url: null,
    qr_download_data_url: null,
    generator_prefs: makePrefs(),
    ...overrides,
  };
}

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  return next.some((dep, i) => !Object.is(dep, prev[i]));
}

function createStatefulHarness() {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const callbacks: Array<{ fn: any; deps: unknown[] | undefined }> = [];
  const memos: Array<{ value: any; deps: unknown[] | undefined }> = [];
  const effects: Array<{ fn: () => void | (() => void); deps: unknown[] | undefined }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | void> = [];
  let stateCursor = 0;
  let refCursor = 0;
  let callbackCursor = 0;
  let memoCursor = 0;
  let effectCursor = 0;
  let idCursor = 0;

  const hooksReact = {
    ...RealReact,
    createElement: RealReact.createElement,
    Fragment: RealReact.Fragment,
    useId: () => `:r${idCursor++}:`,
    useDebugValue: () => {},
    useSyncExternalStore: <T>(
      _subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => T,
    ) => getSnapshot(),
    useState: <T>(initial: T | (() => T)) => {
      const idx = stateCursor++;
      if (!(idx in states)) {
        states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setter = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === 'function' ? (next as (prev: T) => T)(states[idx]) : next;
      };
      return [states[idx], setter] as const;
    },
    useRef: <T>(initial: T) => {
      const idx = refCursor++;
      if (!(idx in refs)) refs[idx] = { current: initial };
      return refs[idx];
    },
    useCallback: <T>(fn: T, deps?: unknown[]) => {
      const idx = callbackCursor++;
      const existing = callbacks[idx];
      if (!existing || depsChanged(existing.deps, deps)) {
        callbacks[idx] = { fn, deps };
      }
      return callbacks[idx].fn as T;
    },
    useMemo: <T>(factory: () => T, deps?: unknown[]) => {
      const idx = memoCursor++;
      const existing = memos[idx];
      if (!existing || depsChanged(existing.deps, deps)) {
        memos[idx] = { value: factory(), deps };
      }
      return memos[idx].value as T;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = effectCursor++;
      effects[idx] = { fn, deps };
    },
    useLayoutEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = effectCursor++;
      effects[idx] = { fn, deps };
    },
  };

  function flushEffects() {
    for (let i = 0; i < effects.length; i++) {
      const entry = effects[i];
      if (!entry) continue;
      if (depsChanged(prevDeps[i], entry.deps)) {
        if (typeof cleanups[i] === 'function') cleanups[i]!();
        cleanups[i] = entry.fn();
        prevDeps[i] = entry.deps;
      }
    }
  }

  function resetCursors() {
    stateCursor = 0;
    refCursor = 0;
    callbackCursor = 0;
    memoCursor = 0;
    effectCursor = 0;
    idCursor = 0;
    effects.length = 0;
  }

  return {
    hooksReact,
    jsxRuntime: RealJsxRuntime,
    render<P>(Component: (props: P) => any, props: P) {
      resetCursors();
      const tree = Component(props);
      flushEffects();
      return tree;
    },
    cleanupAll() {
      for (let i = 0; i < cleanups.length; i++) {
        if (typeof cleanups[i] === 'function') cleanups[i]!();
        cleanups[i] = undefined;
      }
    },
  };
}

function collectElements(node: unknown, predicate: (el: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, any> };
  if (predicate(el)) out.push(el);
  if (typeof el.type === 'function') {
    try {
      const rendered = (el.type as (p: any) => unknown)(el.props || {});
      collectElements(rendered, predicate, out);
    } catch {
      // Ignore child components requiring full DOM context
    }
  }
  if (el.props && el.props.children !== undefined) {
    collectElements(el.props.children, predicate, out);
  }
  return out;
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createDomEventEnv() {
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();

  const fakeWindow = {
    addEventListener(type: string, handler: () => void) {
      let set = windowListeners.get(type);
      if (!set) {
        set = new Set();
        windowListeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      windowListeners.get(type)?.delete(handler);
    },
    dispatch(type: string) {
      for (const handler of [...(windowListeners.get(type) || [])]) handler();
    },
    open() {},
    setTimeout,
    clearTimeout,
    dispatchEvent() {
      return true;
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { search: '', pathname: '/settings', hash: '' },
  };

  const fakeDocument = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener(type: string, handler: () => void) {
      let set = documentListeners.get(type);
      if (!set) {
        set = new Set();
        documentListeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      documentListeners.get(type)?.delete(handler);
    },
    dispatch(type: string) {
      for (const handler of [...(documentListeners.get(type) || [])]) handler();
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  return { fakeWindow, fakeDocument, windowListeners, documentListeners };
}

function loadQrMenuTabWithMocks(
  harness: ReturnType<typeof createStatefulHarness>,
  apiGet: (url: string) => Promise<{ data: any }>,
) {
  const Icon = () => null;
  const toastErrors: string[] = [];
  const toastFn = Object.assign(() => {}, {
    success: () => {},
    error: (msg: string) => {
      toastErrors.push(msg);
    },
  });
  const authState = {
    currentTenant: { id: 1, business_name: 'Test Cafe', country: 'US', currency: 'USD' },
  };

  const tabPath = path.resolve(ROOT, 'frontend/src/components/settings/QrMenuSettingsTab.tsx');
  delete require.cache[tabPath];

  Module._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options?: any,
  ) {
    const resolved =
      request === 'react'
        ? reactPath
        : request === 'react/jsx-runtime'
          ? reactJsxRuntimePath
          : request === 'react-dom'
            ? reactDomPath
            : request === 'react-dom/server'
              ? reactDomServerPath
              : request === 'use-intl'
                ? useIntlPath
                : request.startsWith('@/')
                  ? path.resolve(ROOT, 'frontend/src', request.slice(2))
                  : request;
    return originalResolveFilename.call(this, resolved, parent, isMain, options);
  };

  const stableT = (key: string) => key;
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'react') return harness.hooksReact;
    if (request === 'react/jsx-runtime') return harness.jsxRuntime;
    if (request === 'use-intl') {
      return { useTranslations: () => stableT };
    }
    if (request === 'lucide-react') {
      return new Proxy({}, { get: () => Icon });
    }
    if (request === 'react-hot-toast') {
      return { __esModule: true, default: toastFn, toast: toastFn };
    }
    if (request === '@/store/auth') {
      return {
        useAuthStore: (sel?: (s: any) => any) =>
          typeof sel === 'function' ? sel(authState) : authState,
      };
    }
    if (request === '@/hooks/useFormatCurrency') {
      return { useFormatCurrency: () => (val: number) => `$${Number(val || 0).toFixed(2)}` };
    }
    if (request === '@/hooks/useFormatDate') {
      return { useFormatDate: () => ({ formatDateTime: (val: string) => val }) };
    }
    if (request === '@/components/ui/button') {
      return {
        Button: ({ children, ...rest }: any) =>
          harness.hooksReact.createElement('button', rest, children),
      };
    }
    if (request === '@/lib/product-variants') {
      return { activeVariants: () => [], isVariantSoldOut: () => false };
    }
    if (request === '@/lib/printer/menu-web-print') {
      return {
        buildHierarchicalMenuWebSections: () => [],
        buildMenuWebPrintHtml: () => '',
        buildQrTableCardHtml: () => '',
        isMenuCategoryVisible: () => true,
        printMenuInBrowser: () => {},
      };
    }
    if (request === '@/lib/api') {
      return {
        __esModule: true,
        default: {
          get: apiGet,
          post: async () => ({ data: {} }),
          put: async () => ({ data: {} }),
        },
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  const mod = require(tabPath);
  return { QrMenuSettingsTab: mod.QrMenuSettingsTab, toastErrors };
}

async function withMockEnv(fn: () => Promise<void>) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  try {
    await fn();
  } finally {
    Module._load = originalLoad;
    Module._resolveFilename = originalResolveFilename;
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
    if (prevDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDocument;
  }
}

async function testReconnectViaConnectCallback() {
  console.log('\n--- 1. Reconnect via onConnectDrive callback ---');
  await withMockEnv(async () => {
    const dom = createDomEventEnv();
    (globalThis as any).window = dom.fakeWindow;
    (globalThis as any).document = dom.fakeDocument;

    let qrMenuCalls = 0;
    let backendStatus = makeStatus({ connected: false, published: false });
    const harness = createStatefulHarness();
    const { QrMenuSettingsTab } = loadQrMenuTabWithMocks(harness, async (url) => {
      if (url === '/settings/google-drive/qr-menu') {
        qrMenuCalls++;
        return { data: backendStatus };
      }
      return { data: {} };
    });

    const props = {
      canConnectDrive: true,
      connectingDrive: false,
      onConnectDrive: async () => {
        backendStatus = makeStatus({
          connected: true,
          published: true,
          file_name: 'Test Cafe - Menu (abc123).pdf',
          web_view_link: 'https://drive.google.com/file/d/menu-1/view',
          sharing_enabled: true,
          source: 'generated',
          updated_at: '2026-11-14T10:00:00Z',
          generator_prefs: makePrefs({ template: 'classic-bistro' }),
        });
      },
    };

    harness.render(QrMenuSettingsTab, props);
    await flushMicrotasks();
    const disconnectedTree = harness.render(QrMenuSettingsTab, props);
    const disconnectedMarkup = renderToStaticMarkup(disconnectedTree);
    assert.ok(disconnectedMarkup.includes('connectHint'), 'Initial mount shows connectHint');
    assert.ok(
      disconnectedMarkup.includes('connectDrive'),
      'Initial mount renders connectDrive CTA',
    );
    assert.equal(qrMenuCalls, 1, 'Initial mount fetches qr-menu status once');

    const connectBtn = collectElements(
      disconnectedTree,
      (el) => el.type === 'button' && renderToStaticMarkup(el).includes('connectDrive'),
    )[0];
    assert.ok(connectBtn, 'connectDrive button rendered');

    await connectBtn.props.onClick();
    await flushMicrotasks();
    const connectedTree = harness.render(QrMenuSettingsTab, props);
    const connectedMarkup = renderToStaticMarkup(connectedTree);
    assert.ok(
      connectedMarkup.includes('liveMenu') &&
        connectedMarkup.includes('Test Cafe - Menu (abc123).pdf'),
      'Awaiting onConnectDrive refreshes QrMenuSettingsTab to connected state without unmounting',
    );
    assert.equal(qrMenuCalls, 2, 'onConnectDrive completion triggers fresh qr-menu fetch');

    harness.cleanupAll();
  });

  // Reconnect when focus fires while onConnectDrive is awaiting confirmation before OAuth completes
  await withMockEnv(async () => {
    const dom = createDomEventEnv();
    (globalThis as any).window = dom.fakeWindow;
    (globalThis as any).document = dom.fakeDocument;

    let backendStatus = makeStatus({ connected: false });
    let resolveConnect!: () => void;
    const harness = createStatefulHarness();
    const { QrMenuSettingsTab } = loadQrMenuTabWithMocks(harness, async (url) => {
      if (url === '/settings/google-drive/qr-menu') return { data: backendStatus };
      return { data: {} };
    });

    const props = {
      canConnectDrive: true,
      connectingDrive: false,
      onConnectDrive: () =>
        new Promise<void>((resolve) => {
          resolveConnect = () => {
            backendStatus = makeStatus({ connected: true, published: false });
            resolve();
          };
        }),
    };

    harness.render(QrMenuSettingsTab, props);
    await flushMicrotasks();
    const tree = harness.render(QrMenuSettingsTab, props);
    const connectBtn = collectElements(
      tree,
      (el) => el.type === 'button' && renderToStaticMarkup(el).includes('connectDrive'),
    )[0];
    assert.ok(connectBtn, 'connectDrive button rendered');

    const connectPromise = connectBtn.props.onClick();
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();

    resolveConnect();
    await connectPromise;
    await flushMicrotasks();

    const afterTree = harness.render(QrMenuSettingsTab, props);
    assert.ok(
      renderToStaticMarkup(afterTree).includes('publishMenu'),
      'Focus during connect confirmation does not cause handleConnectDrive to skip post-OAuth refresh',
    );

    harness.cleanupAll();
  });
  console.log('  ✓ Reconnect via async onConnectDrive verified');
}

async function testFocusAndVisibilityRefresh() {
  console.log('\n--- 2. Window focus and document visibilitychange refresh ---');
  await withMockEnv(async () => {
    const dom = createDomEventEnv();
    (globalThis as any).window = dom.fakeWindow;
    (globalThis as any).document = dom.fakeDocument;

    let qrMenuCalls = 0;
    let backendStatus = makeStatus({ connected: false });
    const harness = createStatefulHarness();
    const { QrMenuSettingsTab } = loadQrMenuTabWithMocks(harness, async (url) => {
      if (url === '/settings/google-drive/qr-menu') {
        qrMenuCalls++;
        return { data: backendStatus };
      }
      return { data: {} };
    });

    const baseProps = {
      canConnectDrive: true,
      connectingDrive: false,
      onConnectDrive: () => {},
    };

    harness.render(QrMenuSettingsTab, baseProps);
    await flushMicrotasks();
    harness.render(QrMenuSettingsTab, baseProps);
    assert.equal(qrMenuCalls, 1);

    // While connectingDrive is true, focus should not trigger redundant refresh
    backendStatus = makeStatus({ connected: true });
    harness.render(QrMenuSettingsTab, { ...baseProps, connectingDrive: true });
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();
    assert.equal(
      qrMenuCalls,
      1,
      'Focus while connectingDrive is true does not refresh prematurely',
    );

    // Once !connectingDrive, returning focus refreshes automatically
    harness.render(QrMenuSettingsTab, baseProps);
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();
    assert.equal(qrMenuCalls, 2, 'Window focus while !connectingDrive refreshes qr-menu status');
    const focusedTree = harness.render(QrMenuSettingsTab, baseProps);
    assert.ok(
      renderToStaticMarkup(focusedTree).includes('publishMenu'),
      'Window focus transitions UI to connected state',
    );

    // Reset back to disconnected via focus, then verify visibilitychange only refreshes when visible
    backendStatus = makeStatus({ connected: false });
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();
    const resetTree = harness.render(QrMenuSettingsTab, baseProps);
    assert.ok(
      renderToStaticMarkup(resetTree).includes('connectDrive'),
      'Focus refresh resets UI back to disconnected state',
    );
    const callsBeforeHidden = qrMenuCalls;

    backendStatus = makeStatus({ connected: true });
    dom.fakeDocument.visibilityState = 'hidden';
    dom.fakeDocument.dispatch('visibilitychange');
    await flushMicrotasks();
    assert.equal(qrMenuCalls, callsBeforeHidden, 'visibilitychange when hidden does not refresh');

    dom.fakeDocument.visibilityState = 'visible';
    dom.fakeDocument.dispatch('visibilitychange');
    await flushMicrotasks();
    assert.equal(
      qrMenuCalls,
      callsBeforeHidden + 1,
      'visibilitychange when visible refreshes qr-menu status',
    );
    const visibleTree = harness.render(QrMenuSettingsTab, baseProps);
    assert.ok(
      renderToStaticMarkup(visibleTree).includes('publishMenu'),
      'Visibility return transitions UI to connected state',
    );

    harness.cleanupAll();
    assert.equal(dom.windowListeners.get('focus')?.size ?? 0, 0, 'focus listener cleaned up');
    assert.equal(
      dom.documentListeners.get('visibilitychange')?.size ?? 0,
      0,
      'visibilitychange listener cleaned up',
    );
  });
  console.log('  ✓ Window focus and visibilitychange refresh verified');
}

async function testDisconnectAndPrefsPreservationAndRaceSafety() {
  console.log('\n--- 3. Disconnect, prefs preservation on focus, and race safety ---');
  await withMockEnv(async () => {
    const dom = createDomEventEnv();
    (globalThis as any).window = dom.fakeWindow;
    (globalThis as any).document = dom.fakeDocument;

    let backendStatus = makeStatus({
      connected: true,
      published: true,
      file_name: 'Menu-v1.pdf',
      generator_prefs: makePrefs({ template: 'mobile-cafe', includePhotos: false }),
    });
    const harness = createStatefulHarness();
    const { QrMenuSettingsTab } = loadQrMenuTabWithMocks(harness, async (url) => {
      if (url === '/settings/google-drive/qr-menu') return { data: backendStatus };
      return { data: {} };
    });

    const connectedProps = {
      canConnectDrive: true,
      connectingDrive: false,
      onConnectDrive: () => {},
    };

    harness.render(QrMenuSettingsTab, connectedProps);
    await flushMicrotasks();
    const tree1 = harness.render(QrMenuSettingsTab, connectedProps);

    // User toggles local unsaved prefs in memory
    const checkboxes = collectElements(
      tree1,
      (el) => el.type === 'input' && el.props?.type === 'checkbox',
    );
    const includePhotosCheckbox = checkboxes[2];
    assert.equal(includePhotosCheckbox.props.checked, false, 'includePhotos starts false');
    includePhotosCheckbox.props.onChange({ target: { checked: true } });

    const selects = collectElements(tree1, (el) => el.type === 'select');
    assert.equal(selects[0].props.value, 'mobile-cafe', 'template starts mobile-cafe');
    selects[0].props.onChange({ target: { value: 'classic-bistro' } });

    const editedTree = harness.render(QrMenuSettingsTab, connectedProps);
    const editedCheckboxes = collectElements(
      editedTree,
      (el) => el.type === 'input' && el.props?.type === 'checkbox',
    );
    assert.equal(editedCheckboxes[2].props.checked, true, 'local includePhotos edit persisted');

    // Background focus refresh while still connected must NOT clobber unsaved prefs
    backendStatus = makeStatus({
      connected: true,
      published: true,
      file_name: 'Menu-v2.pdf',
      generator_prefs: makePrefs({ template: 'standard', includePhotos: false }),
    });
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();
    const afterFocusTree = harness.render(QrMenuSettingsTab, connectedProps);
    assert.ok(
      renderToStaticMarkup(afterFocusTree).includes('Menu-v2.pdf'),
      'Background focus updates status fields',
    );
    const afterFocusCheckboxes = collectElements(
      afterFocusTree,
      (el) => el.type === 'input' && el.props?.type === 'checkbox',
    );
    const afterFocusSelects = collectElements(afterFocusTree, (el) => el.type === 'select');
    assert.equal(
      afterFocusCheckboxes[2].props.checked,
      true,
      'Background focus while connected preserves unsaved checkbox edit',
    );
    assert.equal(
      afterFocusSelects[0].props.value,
      'classic-bistro',
      'Background focus while connected preserves unsaved template edit',
    );

    // Disconnecting Google Drive while mounted refreshes cleanly to disconnected UI
    backendStatus = makeStatus({ connected: false });
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();
    const disconnectedTree = harness.render(QrMenuSettingsTab, connectedProps);
    assert.ok(
      renderToStaticMarkup(disconnectedTree).includes('connectDrive'),
      'Focus refresh while disconnected transitions cleanly to disconnected state',
    );

    // Reconnecting after disconnect reloads generator_prefs from server
    backendStatus = makeStatus({
      connected: true,
      published: false,
      generator_prefs: makePrefs({ template: 'standard', includePhotos: false }),
    });
    dom.fakeWindow.dispatch('focus');
    await flushMicrotasks();
    const reconnectedTree = harness.render(QrMenuSettingsTab, connectedProps);
    const reconnectedSelects = collectElements(reconnectedTree, (el) => el.type === 'select');
    const reconnectedCheckboxes = collectElements(
      reconnectedTree,
      (el) => el.type === 'input' && el.props?.type === 'checkbox',
    );
    assert.equal(
      reconnectedSelects[0].props.value,
      'standard',
      'Reconnect reloads generator_prefs template',
    );
    assert.equal(
      reconnectedCheckboxes[2].props.checked,
      false,
      'Reconnect reloads generator_prefs toggles',
    );

    harness.cleanupAll();
  });

  // Race-safety: out-of-order stale response must not overwrite newer response
  await withMockEnv(async () => {
    const dom = createDomEventEnv();
    (globalThis as any).window = dom.fakeWindow;
    (globalThis as any).document = dom.fakeDocument;

    const pendingQrResponses: Array<{
      resolve: (value: { data: QrMenuStatusPayload }) => void;
    }> = [];
    const harness = createStatefulHarness();
    const { QrMenuSettingsTab } = loadQrMenuTabWithMocks(harness, (url) => {
      if (url === '/settings/google-drive/qr-menu') {
        return new Promise((resolve) => {
          pendingQrResponses.push({ resolve });
        });
      }
      return Promise.resolve({ data: {} });
    });

    const props = {
      canConnectDrive: true,
      connectingDrive: false,
      onConnectDrive: () => {},
    };

    // Request 1 on mount
    harness.render(QrMenuSettingsTab, props);
    assert.equal(pendingQrResponses.length, 1);
    pendingQrResponses[0].resolve({ data: makeStatus({ connected: false }) });
    await flushMicrotasks();
    harness.render(QrMenuSettingsTab, props);

    // Request 2 via focus (slow, stale)
    dom.fakeWindow.dispatch('focus');
    assert.equal(pendingQrResponses.length, 2);

    // Request 3 via visibilitychange (fast, newer)
    dom.fakeDocument.visibilityState = 'visible';
    dom.fakeDocument.dispatch('visibilitychange');
    assert.equal(pendingQrResponses.length, 3);

    // Resolve newer Request 3 first as connected
    pendingQrResponses[2].resolve({
      data: makeStatus({ connected: true, published: true, file_name: 'Fresh.pdf' }),
    });
    await flushMicrotasks();

    // Now resolve stale Request 2 as disconnected
    pendingQrResponses[1].resolve({ data: makeStatus({ connected: false }) });
    await flushMicrotasks();

    const finalTree = harness.render(QrMenuSettingsTab, props);
    const finalMarkup = renderToStaticMarkup(finalTree);
    assert.ok(
      finalMarkup.includes('Fresh.pdf'),
      'Stale out-of-order response must not overwrite newer connected response',
    );

    harness.cleanupAll();
  });

  console.log('  ✓ Disconnect, prefs preservation, and race safety verified');
}

async function testConnectGoogleDriveDoesNotBlockOnRemoteBackups() {
  console.log('\n--- 4. SettingsPage connectGoogleDrive does not block on backups fetch ---');
  await withMockEnv(async () => {
    const dom = createDomEventEnv();
    (globalThis as any).window = dom.fakeWindow;
    (globalThis as any).document = dom.fakeDocument;

    let backendConnected = false;
    let backupsRequests = 0;
    let qrMenuCalls = 0;

    const qrHarness = createStatefulHarness();
    const { QrMenuSettingsTab } = loadQrMenuTabWithMocks(qrHarness, async (url) => {
      if (url === '/settings/google-drive/qr-menu') {
        qrMenuCalls++;
        return {
          data: makeStatus({
            connected: backendConnected,
            published: backendConnected,
            file_name: backendConnected ? 'Test Cafe - Menu (abc123).pdf' : null,
          }),
        };
      }
      return { data: {} };
    });

    const settingsHarness = createStatefulHarness();
    const settingsPagePath = path.resolve(ROOT, 'frontend/src/app/(dashboard)/settings/page.tsx');
    delete require.cache[settingsPagePath];

    const StubComponent = ({ children }: any) =>
      settingsHarness.hooksReact.createElement('div', null, children);
    const noopProxy: any = new Proxy(() => null, {
      get(_target, prop) {
        if (prop === '__esModule') return true;
        if (prop === 'default') return StubComponent;
        return StubComponent;
      },
    });

    const authState = {
      currentTenant: {
        id: 1,
        business_name: 'Test Cafe',
        country: 'US',
        currency: 'USD',
        role: 'owner',
        permission_ids: ['google-drive.manage', 'settings.manage'],
      },
      user: { id: 'u-1', role: 'owner', name: 'Owner' },
      updateCurrentTenant: () => {},
    };
    const posSettingsState = {
      whatsappEnabled: false,
      billTemplate: 'classic',
      printerEnabled: false,
      printerPaperSize: '80mm',
      autoPrintKot: false,
      autoPrintBill: false,
      whatsappShareEnabled: false,
      printerUseUnicode: false,
      printerArabicShaping: false,
      printerTrimDecimals: false,
      billShowLogo: false,
      billShowName: true,
      billShowAddress: false,
      billShowPhone: false,
      billShowTaxId: false,
      billShowTaxBreakdown: false,
      billShowCustomerName: false,
      billShowCustomerPhone: false,
      billDeliveryShowCustomerPhoneAlways: false,
      billShowTableNumber: false,
      billShowLargeOrderNumber: false,
      billLanguagePolicy: { primary: { mode: 'inherit' }, additional: [] },
      kotLanguagePolicy: { primary: { mode: 'inherit' } },
      setBillTemplate: () => {},
      load: async () => {},
    };
    const printerState = { printMethod: 'system', setPrintMethod: () => {} };
    const stableT = (key: string) => key;
    const toastFn = Object.assign(() => {}, { success: () => {}, error: () => {} });

    let capturedQrProps: {
      canConnectDrive: boolean;
      connectingDrive: boolean;
      onConnectDrive: () => void | Promise<unknown>;
    } | null = null;

    Module._resolveFilename = function (
      request: string,
      parent: any,
      isMain: boolean,
      options?: any,
    ) {
      const resolved =
        request === 'react'
          ? reactPath
          : request === 'react/jsx-runtime'
            ? reactJsxRuntimePath
            : request === 'react-dom'
              ? reactDomPath
              : request === 'react-dom/server'
                ? reactDomServerPath
                : request === 'use-intl'
                  ? useIntlPath
                  : request === '@countries'
                    ? path.resolve(ROOT, 'main/countries.ts')
                    : request.startsWith('@print/')
                      ? path.resolve(ROOT, 'shared/print', request.slice(7))
                      : request.startsWith('@shared/')
                        ? path.resolve(ROOT, 'shared', request.slice(8))
                        : request.startsWith('@/')
                          ? path.resolve(ROOT, 'frontend/src', request.slice(2))
                          : request;
      return originalResolveFilename.call(this, resolved, parent, isMain, options);
    };

    Module._load = function (request: string, parent: any, isMain: boolean) {
      if (request === 'react') return settingsHarness.hooksReact;
      if (request === 'react/jsx-runtime') return settingsHarness.jsxRuntime;
      if (request === 'use-intl') return { useTranslations: () => stableT };
      if (request === 'next/link') return StubComponent;
      if (request === 'next/navigation') {
        return {
          useRouter: () => ({ push: () => {}, replace: () => {} }),
          useSearchParams: () => new URLSearchParams('tab=qr-menu'),
        };
      }
      if (request === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (request === 'react-hot-toast') {
        return { __esModule: true, default: toastFn, toast: toastFn };
      }
      if (request === 'axios') {
        return {
          __esModule: true,
          default: { isCancel: () => false, isAxiosError: () => false },
          isCancel: () => false,
          isAxiosError: () => false,
        };
      }
      if (request === '@/store/auth') {
        return {
          useAuthStore: (sel?: (s: any) => any) =>
            typeof sel === 'function' ? sel(authState) : authState,
        };
      }
      if (request === '@/store/pos-settings') {
        return {
          usePosSettingsStore: (sel?: (s: any) => any) =>
            typeof sel === 'function' ? sel(posSettingsState) : posSettingsState,
          normalizeAutoLockMinutesValue: (v: unknown) => Number(v) || 0,
        };
      }
      if (request === '@/store/theme') {
        return { useThemeMode: () => ({ themeMode: 'light', setThemeMode: () => {} }) };
      }
      if (request === '@/hooks/usePrinter') {
        return { usePrinterStore: () => printerState };
      }
      if (request === '@/hooks/useOrdersLayout') {
        return { useOrdersLayoutPreference: () => ({ layout: 'cards', setLayout: () => {} }) };
      }
      if (request === '@/hooks/usePosSort') {
        return {
          usePosSortPreference: () => ({
            categorySort: 'default',
            itemSort: 'default',
            setCategorySort: () => {},
            setItemSort: () => {},
          }),
        };
      }
      if (request === '@/hooks/use-confirm') {
        return { useConfirm: () => ({ confirm: async () => true, ConfirmDialog: null }) };
      }
      if (request === '@/hooks/useFormatDate') {
        return {
          useFormatDate: () => ({
            formatDate: (v: string) => v,
            formatTime: (v: string) => v,
            formatDateTime: (v: string) => v,
          }),
        };
      }
      if (request === '@/hooks/useUpdateStatus') {
        return { useUpdateStatus: () => ({ status: 'idle' }) };
      }
      if (request === '@/components/settings/QrMenuSettingsTab') {
        return {
          QrMenuSettingsTab: (props: any) => {
            capturedQrProps = props;
            return null;
          },
        };
      }
      if (
        request === '@/components/ui/tabs' ||
        request === '@/components/ui/tooltip' ||
        request === '@/components/ui/dialog' ||
        request === '@/components/ui/button' ||
        request === '@/components/layout/Ltr' ||
        request.startsWith('@/components/settings/') ||
        request.startsWith('@/components/analytics/')
      ) {
        return noopProxy;
      }
      if (request === '@/lib/api') {
        return {
          __esModule: true,
          default: {
            get: async (url: string) => {
              if (url.startsWith('/settings/google-drive/backups')) {
                backupsRequests++;
                return new Promise(() => {});
              }
              return { data: {} };
            },
            post: async (url: string) => {
              if (url === '/settings/google-drive/connect') {
                backendConnected = true;
                return { data: { connected: true, account_email: 'owner@cafe.com' } };
              }
              return { data: {} };
            },
            put: async () => ({ data: {} }),
            delete: async () => ({ data: {} }),
          },
        };
      }
      return originalLoad.apply(this, [request, parent, isMain]);
    };

    const SettingsPage = require(settingsPagePath).default;
    const settingsTree = settingsHarness.render(SettingsPage, {});
    collectElements(settingsTree, () => false);
    assert.ok(capturedQrProps, 'SettingsPage rendered QrMenuSettingsTab with props');

    // Mount real QrMenuSettingsTab with the real onConnectDrive handler from SettingsPage
    qrHarness.render(QrMenuSettingsTab, capturedQrProps!);
    await flushMicrotasks();
    const disconnectedTree = qrHarness.render(QrMenuSettingsTab, capturedQrProps!);
    const connectBtn = collectElements(
      disconnectedTree,
      (el) => el.type === 'button' && renderToStaticMarkup(el).includes('connectDrive'),
    )[0];
    assert.ok(connectBtn, 'connectDrive button rendered');
    assert.equal(qrMenuCalls, 1);

    // Clicking Connect must resolve and refresh QrMenuSettingsTab even while backups fetch hangs
    const clickPromise = Promise.resolve(connectBtn.props.onClick());
    const outcome = await Promise.race([
      clickPromise.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed_out'), 200)),
    ]);
    assert.equal(
      outcome,
      'resolved',
      'connectGoogleDrive / handleConnectDrive must not block on pending /settings/google-drive/backups',
    );
    assert.equal(backupsRequests, 1, 'Remote backups fetch was still kicked off in the background');
    await flushMicrotasks();
    assert.equal(qrMenuCalls, 2, 'QrMenuSettingsTab refreshed immediately after connect');

    const connectedTree = qrHarness.render(QrMenuSettingsTab, capturedQrProps!);
    assert.ok(
      renderToStaticMarkup(connectedTree).includes('liveMenu'),
      'QrMenuSettingsTab renders connected liveMenu while backups fetch is still pending',
    );

    qrHarness.cleanupAll();
    settingsHarness.cleanupAll();
  });
  console.log('  ✓ SettingsPage connectGoogleDrive non-blocking refresh verified');
}

async function main() {
  console.log('🧪 QR Menu Settings Tab Refresh Tests');
  await testReconnectViaConnectCallback();
  await testFocusAndVisibilityRefresh();
  await testDisconnectAndPrefsPreservationAndRaceSafety();
  await testConnectGoogleDriveDoesNotBlockOnRemoteBackups();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
