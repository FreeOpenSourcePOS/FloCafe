import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'frontend/src/hooks/useKdsConnection.ts'),
  'utf8',
);
const conflictBranch = source.match(/if \(statusCode === 409\) \{[\s\S]*?\n\s*return;/)?.[0] || '';

assert.match(
  conflictBranch,
  /await fetchOrdersRest\(\);/,
  'KDS conflicts refresh REST state even with an active WebSocket',
);
assert.doesNotMatch(
  conflictBranch,
  /wsRef\.current === null/,
  'KDS conflict refresh is not gated on WebSocket absence',
);

const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
};
const frontendRequire = Module.createRequire(path.resolve(process.cwd(), 'frontend/package.json'));
const originalResolveFilename = Module._resolveFilename;
const frontendResolved = new Map<string, string>(
  [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/server',
    'use-intl',
    '@dnd-kit/dom',
    '@dnd-kit/react',
    'lucide-react',
    'react-hot-toast',
    'radix-ui',
    'clsx',
    'tailwind-merge',
    'class-variance-authority',
    'zustand',
    'zustand/middleware',
    'axios',
  ].map((pkg) => [pkg, frontendRequire.resolve(pkg)]),
);

Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = frontendResolved.get(request) ?? request;
  if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(process.cwd(), 'frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(process.cwd(), 'shared/print', request.slice('@print/'.length));
  } else if (request.startsWith('@shared/')) {
    resolvedRequest = path.resolve(process.cwd(), 'shared', request.slice('@shared/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

async function runTests() {
  try {
    const React = frontendRequire('react');
    const ReactDOMServer = frontendRequire('react-dom/server');
    const { IntlProvider } = frontendRequire('use-intl');
    const enMessages = require('../frontend/src/lib/i18n/messages/en.json');
    const { KdsKanbanBoard } = require('../frontend/src/components/kds/KdsKanbanBoard');
    const { KdsTabsView } = require('../frontend/src/components/kds/KdsTabsView');
    const { KdsItemModal } = require('../frontend/src/components/kds/KdsItemModal');
    const { KdsLoginForm } = require('../frontend/src/components/kds/KdsLoginForm');
    const {
      KdsHeader,
      resolveEffectiveKdsDark,
      subscribeSystemColorScheme,
    } = require('../frontend/src/components/kds/KdsHeader');
    const {
      STATUS_CONFIG,
      ORDER_TYPE_BADGE_STYLES,
    } = require('../frontend/src/hooks/useKdsConnection');
    const { useThemeMode } = require('../frontend/src/store/theme');
    const api = require('../frontend/src/lib/api').default;
    const { ThemeSync } = require('../frontend/src/components/layout/ThemeSync');
    const { useThemeModeToggle } = require('../frontend/src/hooks/useThemeModeToggle');
    const {
      KDS_THEME_OVERRIDE_KEY,
      clearKdsThemeOverride,
      fetchServerInfo,
      hydrateKdsThemeOverride,
      applyServerThemeInfo,
      isDashboardPosContext,
      useSyncServerLanguage,
    } = require('../frontend/src/lib/i18n/server-language');

    const sampleOrders = [
      {
        id: 101,
        order_number: 'KDS-1513',
        type: 'dine_in',
        created_at: '2026-11-08 15:00:00',
        special_instructions: 'Allergy table',
        table: { name: 'T4' },
        items: [
          {
            id: 1,
            order_id: 101,
            product_id: 'prod-burger',
            product_name: 'Smash Burger',
            quantity: 2,
            status: 'pending',
            addons: [
              { id: 'addon-cheese', name: 'Extra Cheese', quantity: 2 },
              { id: 'addon-bacon', name: 'Bacon', quantity: 1 },
            ],
            special_instructions: 'No onions',
          },
          {
            id: 2,
            order_id: 101,
            product_id: 'prod-latte',
            product_name: 'Latte',
            quantity: 1,
            status: 'voided',
            addons: [
              { id: 'addon-oat', name: 'Oat Milk', quantity: 2 },
              { id: 'addon-cinnamon', name: 'Cinnamon', quantity: 1 },
            ],
            special_instructions: 'Extra hot',
          },
        ],
      },
    ];

    const kanbanMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsKanbanBoard, {
          updating: null,
          updateItemStatus: async () => true,
          orders: sampleOrders,
        }),
      ),
    );

    assert.match(
      kanbanMarkup,
      /\+ Extra Cheese ×2/,
      'KDS Kanban card renders multi-quantity add-on name and quantity inline',
    );
    assert.match(
      kanbanMarkup,
      /\+ Bacon(?! ×)/,
      'KDS Kanban card renders single-quantity add-on name inline without ×1 suffix',
    );
    assert.match(
      kanbanMarkup,
      /&quot;No onions&quot;/,
      'KDS Kanban card renders item special instructions alongside add-on pills',
    );
    assert.doesNotMatch(
      kanbanMarkup,
      />\+2<\/span>/,
      'KDS Kanban card does not render redundant +count badge once add-on pills are inline',
    );
    assert.match(
      kanbanMarkup,
      /\+ Oat Milk ×2/,
      'KDS Kanban voided column renders multi-quantity add-on pill inline',
    );
    assert.match(
      kanbanMarkup,
      /\+ Cinnamon(?! ×)/,
      'KDS Kanban voided column renders single-quantity add-on pill inline',
    );
    assert.match(
      kanbanMarkup,
      /&quot;Extra hot&quot;/,
      'KDS Kanban voided column renders item special instructions inline',
    );
    assert.match(
      kanbanMarkup,
      /bg-blue-100\/90 text-blue-900 dark:bg-blue-950\/90 dark:text-blue-200/,
      'KDS Kanban add-on badges use borderless WCAG AA light and dark classes',
    );
    assert.match(
      kanbanMarkup,
      /border-s-3 border-red-500 bg-red-50 text-red-900 dark:bg-red-950\/90 dark:text-red-200/,
      'KDS Kanban item special instructions use high-contrast callout strip classes in light and dark mode',
    );
    assert.match(
      kanbanMarkup,
      /border-s-4 border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950\/80 dark:text-amber-200/,
      'KDS Kanban order special instructions include WCAG AA dark mode classes',
    );
    assert.match(
      kanbanMarkup,
      /rounded-2xl bg-muted\/40 dark:bg-muted\/25/,
      'KDS Kanban columns use borderless tonal surface lanes',
    );
    assert.match(
      kanbanMarkup,
      /rounded-xl bg-card shadow-sm ring-1 ring-border\/50 border-t-4/,
      'KDS Kanban order cards use elevated ticket surface with border-t-4 status accent',
    );
    assert.match(
      kanbanMarkup,
      /divide-y divide-border\/40 -mx-1/,
      'KDS Kanban order items use hairline dividers instead of nested bordered boxes',
    );
    assert.match(
      kanbanMarkup,
      /border-transparent dark:border-transparent/,
      'KDS Kanban order cards use borderless order type badges in light and dark mode',
    );
    assert.doesNotMatch(
      kanbanMarkup,
      /rounded-xl border-2/,
      'KDS Kanban order cards do not have 4-sided border-2 outlines',
    );
    assert.doesNotMatch(
      kanbanMarkup,
      /rounded-t-lg border-2/,
      'KDS Kanban columns do not have border-2 outlines',
    );

    assert.doesNotMatch(
      kanbanMarkup,
      /opacity-80/,
      'KDS Kanban VoidedColumn does not dim voided cards with opacity-80',
    );
    assert.match(
      kanbanMarkup,
      /text-slate-700 dark:text-slate-200 line-through[\s\S]*?Latte/,
      'KDS Kanban VoidedColumn renders voided item heading with high-contrast struck-through text',
    );
    assert.match(
      kanbanMarkup,
      /class="[^"]*font-extrabold text-lg tracking-tight[^"]*"[^>]*>#KDS-1513<\//,
      'KDS Kanban card header renders #order_number in large extrabold typography',
    );

    const tabsMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsTabsView, {
          updating: null,
          updateItemStatus: async () => true,
          orders: sampleOrders,
        }),
      ),
    );
    assert.doesNotMatch(
      tabsMarkup,
      /opacity-50/,
      'KDS Tabs view unselected tab buttons do not blend with opacity-50',
    );
    assert.match(
      tabsMarkup,
      /text-slate-700 dark:text-slate-200 hover:text-foreground hover:bg-card\/60/,
      'KDS Tabs view unselected tab buttons use clean borderless high-contrast classes',
    );
    assert.match(
      tabsMarkup,
      /bg-blue-100\/90 text-blue-900 dark:bg-blue-950\/90 dark:text-blue-200/,
      'KDS Tabs view add-on badges use borderless WCAG AA light and dark classes',
    );
    assert.match(
      tabsMarkup,
      /border-s-3 border-red-500 bg-red-50 text-red-900 dark:bg-red-950\/90 dark:text-red-200/,
      'KDS Tabs view item special instructions use high-contrast callout strip classes in light and dark mode',
    );
    assert.match(
      tabsMarkup,
      /border-s-4 border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950\/80 dark:text-amber-200/,
      'KDS Tabs view order special instructions include WCAG AA dark mode classes',
    );
    assert.match(
      tabsMarkup,
      /bg-muted\/50 p-1 rounded-xl inline-flex flex-wrap items-center/,
      'KDS Tabs view uses modern segmented tab bar',
    );
    assert.match(
      tabsMarkup,
      /bg-card shadow-xs ring-1 ring-border\/60/,
      'KDS Tabs view active tab uses elevated card surface with subtle ring',
    );
    assert.match(
      tabsMarkup,
      /rounded-xl bg-card shadow-sm ring-1 ring-border\/50 border-t-4/,
      'KDS Tabs view order cards use elevated ticket surface with border-t-4 status accent',
    );
    assert.match(
      tabsMarkup,
      /divide-y divide-border\/40 -mx-1/,
      'KDS Tabs view order items use hairline dividers instead of nested bordered boxes',
    );
    assert.match(
      tabsMarkup,
      /border-transparent dark:border-transparent/,
      'KDS Tabs view order cards use borderless order type badges in light and dark mode',
    );
    assert.doesNotMatch(
      tabsMarkup,
      /rounded-xl border-2/,
      'KDS Tabs view order cards do not have 4-sided border-2 outlines',
    );
    assert.match(
      tabsMarkup,
      /class="[^"]*font-extrabold text-lg tracking-tight[^"]*"[^>]*>#KDS-1513<\//,
      'KDS Tabs card header renders #order_number in large extrabold typography',
    );

    const modalMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsItemModal, {
          item: { ...sampleOrders[0].items[0], status: 'preparing' },
          orderNumber: 'KDS-1513',
          updating: false,
          onClose: () => {},
          onUpdateStatus: () => {},
        }),
      ),
    );
    assert.match(
      modalMarkup,
      /bg-blue-50 dark:bg-blue-950\/60 border-s-4 border-blue-500/,
      'KdsItemModal add-ons box includes dark mode classes and clean callout strip',
    );
    assert.match(
      modalMarkup,
      /bg-red-50 dark:bg-red-950\/60 border-s-4 border-red-500/,
      'KdsItemModal special instructions box includes dark mode classes and clean callout strip',
    );
    assert.match(
      modalMarkup,
      /bg-green-700 hover:brightness-90/,
      'KdsItemModal Mark as Ready action button uses bg-green-700 for WCAG AA white text contrast',
    );
    assert.match(
      modalMarkup,
      /bg-muted text-slate-700 dark:text-slate-300 line-through/,
      'KdsItemModal past step pill uses high-contrast slate text on bg-muted',
    );
    assert.match(
      modalMarkup,
      /text-slate-700 dark:text-slate-200 text-base font-semibold border-2 border-border bg-muted/,
      'KdsItemModal Back button uses high-contrast slate text on bg-muted',
    );

    const loginMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsLoginForm, {
          conn: {
            loginEmail: '',
            loginPassword: '',
            loginError: 'Invalid credentials',
            loginLoading: false,
            rememberMe: false,
            pinUsers: [],
            setLoginEmail: () => {},
            setLoginPassword: () => {},
            setLoginError: () => {},
            setRememberMe: () => {},
            handleLogin: async () => {},
            handlePinLogin: async () => {},
          },
        }),
      ),
    );
    assert.match(
      loginMarkup,
      /bg-red-50 border border-red-300 text-red-800 dark:bg-red-950\/90 dark:border-red-700 dark:text-red-200/,
      'KdsLoginForm error alert uses WCAG AA light and dark classes',
    );
    assert.match(
      loginMarkup,
      /text-xs text-slate-700 dark:text-slate-300 text-center mt-6/,
      'KdsLoginForm login hint uses WCAG AA slate text classes',
    );

    for (const key of ['dine_in', 'takeaway', 'delivery', 'online']) {
      assert.match(
        ORDER_TYPE_BADGE_STYLES[key],
        /dark:bg-\w+-950\/80 dark:text-\w+-200 dark:border-\w+-700/,
        `ORDER_TYPE_BADGE_STYLES[${key}] includes WCAG AA dark mode classes`,
      );
    }
    assert.equal(
      STATUS_CONFIG.ready.color,
      'bg-green-700',
      'STATUS_CONFIG.ready.color uses bg-green-700 for WCAG AA white text contrast',
    );
    for (const status of ['pending', 'preparing', 'ready', 'served', 'voided'] as const) {
      assert.match(
        STATUS_CONFIG[status].text,
        /text-\w+-800 dark:text-\w+-200/,
        `STATUS_CONFIG.${status}.text uses 800/200 contrast classes`,
      );
      assert.match(
        STATUS_CONFIG[status].color,
        /bg-\w+-(?:600|700)/,
        `STATUS_CONFIG.${status}.color uses 600/700 shade for WCAG AA white text contrast`,
      );
    }

    // Verify KdsHeader renders kds-theme-toggle and toggles light/dark via useThemeMode.selectMode
    useThemeMode.setState({ mode: 'light', userSelected: false });
    Object.assign(useThemeMode.getInitialState(), useThemeMode.getState());
    const headerLightMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsHeader, {
          userName: 'Chef Alex',
          userRole: 'chef',
          connected: true,
          connectionMode: 'websocket',
          viewMode: 'kanban',
          onChangeView: () => {},
          onLogout: () => {},
        }),
      ),
    );
    assert.match(
      headerLightMarkup,
      /data-testid="kds-theme-toggle"/,
      'KdsHeader renders the kds-theme-toggle button',
    );
    assert.match(
      headerLightMarkup,
      /lucide-moon/,
      'KdsHeader shows Moon icon when effective theme is light',
    );

    useThemeMode.getState().selectMode('dark');
    assert.equal(useThemeMode.getState().mode, 'dark', 'selectMode updates theme mode to dark');
    assert.equal(
      useThemeMode.getState().userSelected,
      true,
      'selectMode marks userSelected = true',
    );
    Object.assign(useThemeMode.getInitialState(), useThemeMode.getState());
    const headerDarkMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsHeader, {
          userName: 'Chef Alex',
          userRole: 'chef',
          connected: true,
          connectionMode: 'websocket',
          viewMode: 'kanban',
          onChangeView: () => {},
          onLogout: () => {},
        }),
      ),
    );
    assert.match(
      headerDarkMarkup,
      /lucide-sun/,
      'KdsHeader shows Sun icon when effective theme is dark',
    );

    // Verify fetchServerInfo parses theme_mode into themeMode, KdsHeader subscribes to
    // matchMedia in system mode & resolves live darkness on click, and KDS theme override
    // survives reload without being overwritten by server info.themeMode.
    const origWindow = (globalThis as any).window;
    const origDocument = (globalThis as any).document;
    const origFetch = globalThis.fetch;
    const jsxRuntime = frontendRequire('react/jsx-runtime');
    const origJsx = jsxRuntime.jsx;
    try {
      const storage = new Map<string, string>();
      const darkClasses = new Set<string>();
      let mediaMatches = false;
      const mediaListeners = new Set<() => void>();
      const mockMediaQueryList = {
        get matches() {
          return mediaMatches;
        },
        addEventListener: (event: string, cb: () => void) => {
          if (event === 'change') mediaListeners.add(cb);
        },
        removeEventListener: (event: string, cb: () => void) => {
          if (event === 'change') mediaListeners.delete(cb);
        },
      };

      (globalThis as any).window = {
        localStorage: {
          getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
          removeItem: (key: string) => {
            storage.delete(key);
          },
        },
        matchMedia: (_query: string) => mockMediaQueryList,
      };
      (globalThis as any).document = {
        documentElement: {
          classList: {
            contains: (cls: string) => darkClasses.has(cls),
            toggle: (cls: string, force?: boolean) => {
              const shouldAdd = force === undefined ? !darkClasses.has(cls) : Boolean(force);
              if (shouldAdd) darkClasses.add(cls);
              else darkClasses.delete(cls);
              return shouldAdd;
            },
          },
        },
      };

      for (const [raw, expected] of [
        ['light', 'light'],
        ['dark', 'dark'],
        ['system', 'system'],
        ['invalid', null],
        [null, null],
      ] as const) {
        globalThis.fetch = (async () => ({
          ok: true,
          json: async () => ({
            language: 'en',
            country: 'US',
            kds_default_view: 'kanban',
            theme_mode: raw,
          }),
        })) as any;
        const info = await fetchServerInfo('http://127.0.0.1:3002');
        assert.equal(
          info.themeMode,
          expected,
          `fetchServerInfo parses theme_mode=${String(raw)} as ${String(expected)}`,
        );
      }

      // 1. System mode matchMedia subscription + live click-time resolution in KdsHeader
      useThemeMode.setState({ mode: 'system', userSelected: false });
      Object.assign(useThemeMode.getInitialState(), useThemeMode.getState());
      mediaMatches = false;

      let changeNotifications = 0;
      const unsubscribe = subscribeSystemColorScheme('system', () => {
        changeNotifications += 1;
      });
      assert.equal(
        mediaListeners.size,
        1,
        'subscribeSystemColorScheme attaches a change listener when mode is system',
      );

      let capturedToggleOnClick: (() => void) | null = null;
      jsxRuntime.jsx = function (type: any, props: any, key: any) {
        if (type === 'button' && props?.['data-testid'] === 'kds-theme-toggle') {
          capturedToggleOnClick = props.onClick;
        }
        return origJsx.call(this, type, props, key);
      };
      const systemLightMarkup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: 'en', messages: enMessages, timeZone: 'UTC' },
          React.createElement(KdsHeader, {
            userName: 'Chef Alex',
            userRole: 'chef',
            connected: true,
            connectionMode: 'websocket',
            viewMode: 'kanban',
            onChangeView: () => {},
            onLogout: () => {},
          }),
        ),
      );
      jsxRuntime.jsx = origJsx;

      assert.match(
        systemLightMarkup,
        /lucide-moon/,
        'KdsHeader renders Moon icon in system mode when OS prefers light',
      );
      assert.equal(
        typeof capturedToggleOnClick,
        'function',
        'KdsHeader wires an onClick handler to kds-theme-toggle',
      );

      // Flip OS color scheme to dark while mode remains 'system'
      mediaMatches = true;
      for (const listener of [...mediaListeners]) listener();
      assert.equal(
        changeNotifications,
        1,
        'matchMedia change notifies system-mode subscriber immediately',
      );
      assert.equal(
        resolveEffectiveKdsDark('system'),
        true,
        'resolveEffectiveKdsDark reflects updated OS dark preference',
      );

      const systemDarkMarkup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: 'en', messages: enMessages, timeZone: 'UTC' },
          React.createElement(KdsHeader, {
            userName: 'Chef Alex',
            userRole: 'chef',
            connected: true,
            connectionMode: 'websocket',
            viewMode: 'kanban',
            onChangeView: () => {},
            onLogout: () => {},
          }),
        ),
      );
      assert.match(
        systemDarkMarkup,
        /lucide-sun/,
        'KdsHeader updates to Sun icon in system mode when OS switches to dark',
      );

      unsubscribe();
      assert.equal(
        mediaListeners.size,
        0,
        'subscribeSystemColorScheme removes the matchMedia change listener on cleanup',
      );

      // Invoke the pre-flip onClick closure: it must resolve live darkness (true -> 'light'),
      // not use the stale render-time false value, and must persist flo-kds-theme-override.
      capturedToggleOnClick!();
      assert.equal(
        useThemeMode.getState().mode,
        'light',
        'clicking kds-theme-toggle resolves live OS darkness at click time and switches to light',
      );
      assert.equal(
        storage.get(KDS_THEME_OVERRIDE_KEY),
        'light',
        'clicking kds-theme-toggle persists flo-kds-theme-override in localStorage',
      );
      assert.equal(
        storage.get('flo-theme-resolved'),
        'light',
        'clicking kds-theme-toggle updates flo-theme-resolved mirror to light',
      );
      assert.equal(
        darkClasses.has('dark'),
        false,
        'clicking kds-theme-toggle removes dark class from documentElement',
      );

      // 2. Simulate page reload: in-memory store resets to { mode: 'system', userSelected: false }
      // while server /api/kds/info returns theme_mode = 'dark'. Explicit KDS override must win.
      useThemeMode.setState({ mode: 'system', userSelected: false });
      darkClasses.add('dark');
      const restored = hydrateKdsThemeOverride('/api/kds/info');
      applyServerThemeInfo('dark', '/api/kds/info');
      assert.equal(restored, 'light', 'hydrateKdsThemeOverride restores persisted light override');
      assert.equal(
        useThemeMode.getState().mode,
        'light',
        'persisted KDS override is not overwritten by server info.themeMode on reload',
      );
      assert.equal(
        useThemeMode.getState().userSelected,
        true,
        'hydrated KDS override marks userSelected = true',
      );
      assert.equal(
        storage.get('flo-theme-resolved'),
        'light',
        'server info.themeMode does not clobber flo-theme-resolved when KDS override exists',
      );
      assert.equal(
        darkClasses.has('dark'),
        false,
        'hydrated KDS light override clears dark class on reload',
      );

      // Non-KDS infoPath (/api/server-app/info) does not consume KDS override
      useThemeMode.setState({ mode: 'system', userSelected: false });
      assert.equal(
        hydrateKdsThemeOverride('/api/server-app/info'),
        null,
        'non-KDS infoPath ignores flo-kds-theme-override',
      );

      // 3. Without an explicit KDS override, store theme_mode from /api/kds/info applies on reload
      storage.delete(KDS_THEME_OVERRIDE_KEY);
      useThemeMode.setState({ mode: 'system', userSelected: false, serverSynced: false });
      applyServerThemeInfo('dark', '/api/kds/info');
      assert.equal(
        useThemeMode.getState().mode,
        'dark',
        'store theme_mode applies on KDS when no explicit KDS override exists',
      );
      assert.equal(
        storage.get('flo-theme-resolved'),
        'dark',
        'applyServerThemeInfo writes store dark theme to flo-theme-resolved when unoverridden',
      );
      assert.equal(
        darkClasses.has('dark'),
        true,
        'applyServerThemeInfo applies dark class when store theme_mode is dark',
      );

      mediaMatches = false;
      useThemeMode.setState({ mode: 'dark', userSelected: false, serverSynced: false });
      applyServerThemeInfo(null, '/api/kds/info', false);
      assert.equal(
        useThemeMode.getState().mode,
        'dark',
        'unreachable /api/kds/info does not overwrite fallback theme mode',
      );
      applyServerThemeInfo(null, '/api/server-app/info', true);
      assert.equal(
        useThemeMode.getState().mode,
        'dark',
        'non-KDS infoPath with null themeMode does not overwrite fallback theme mode',
      );
      applyServerThemeInfo(null, '/api/kds/info', true);
      assert.equal(
        useThemeMode.getState().mode,
        'system',
        'reachable /api/kds/info with theme_mode = null applies store system default',
      );
      assert.equal(
        useThemeMode.getState().serverSynced,
        true,
        'applyServerThemeInfo marks serverSynced = true when /api/kds/info succeeds',
      );
      assert.equal(
        darkClasses.has('dark'),
        false,
        'reachable /api/kds/info with theme_mode = null resolves system mode against OS preference',
      );

      storage.set(KDS_THEME_OVERRIDE_KEY, 'dark');
      storage.set('flo-theme-resolved', 'light');
      darkClasses.delete('dark');
      useThemeMode.setState({ mode: 'light', userSelected: true, serverSynced: true });
      assert.equal(
        hydrateKdsThemeOverride('/api/kds/info'),
        null,
        'hydrateKdsThemeOverride returns null when userSelected is already true',
      );
      assert.equal(
        useThemeMode.getState().mode,
        'light',
        'hydrateKdsThemeOverride preserves userSelected light mode',
      );
      assert.equal(
        darkClasses.has('dark'),
        false,
        'hydrateKdsThemeOverride does not force html.dark when userSelected is already true',
      );
      assert.equal(
        storage.get('flo-theme-resolved'),
        'light',
        'hydrateKdsThemeOverride does not overwrite flo-theme-resolved when userSelected is true',
      );

      const origApiPut = api.put;
      const origApiGet = api.get;
      const origUseEffect = React.useEffect;
      const origLocation = (globalThis as any).location;
      const origLocalStorage = (globalThis as any).localStorage;
      try {
        const putCalls: Array<{ url: string; body: unknown }> = [];
        api.put = async (url: string, body: unknown) => {
          putCalls.push({ url, body });
          return { data: { success: true } };
        };

        useThemeMode.setState({ mode: 'dark', userSelected: false, serverSynced: true });
        Object.assign(useThemeMode.getInitialState(), useThemeMode.getState());
        let capturedSave: ((next: 'light' | 'dark' | 'system') => Promise<void>) | null = null;
        function ToggleHarness() {
          const toggle = useThemeModeToggle();
          capturedSave = toggle.save;
          return null;
        }
        ReactDOMServer.renderToStaticMarkup(
          React.createElement(
            IntlProvider,
            { locale: 'en', messages: enMessages, timeZone: 'UTC' },
            React.createElement(ToggleHarness),
          ),
        );
        await capturedSave!('light');
        assert.equal(putCalls.length, 1, 'useThemeModeToggle persists theme_mode via PUT');
        assert.equal(
          storage.has(KDS_THEME_OVERRIDE_KEY),
          false,
          'saving theme_mode via useThemeModeToggle clears flo-kds-theme-override',
        );

        storage.set('token', 'pos-jwt');
        storage.set('tenant', JSON.stringify({ id: 1 }));
        assert.equal(
          isDashboardPosContext('/api/kds/info'),
          true,
          'isDashboardPosContext detects authenticated POS tenant session on /kds',
        );
        let kdsInfoFetchCount = 0;
        globalThis.fetch = (async () => {
          kdsInfoFetchCount += 1;
          return { ok: false, status: 401 };
        }) as any;
        storage.set(KDS_THEME_OVERRIDE_KEY, 'dark');
        useThemeMode.setState({ mode: 'light', userSelected: false, serverSynced: true });
        const effects: Array<() => void | (() => void)> = [];
        React.useEffect = ((fn: () => void | (() => void)) => {
          effects.push(fn);
        }) as typeof React.useEffect;
        function SyncLanguageHarness() {
          useSyncServerLanguage('/api/kds/info');
          return null;
        }
        ReactDOMServer.renderToStaticMarkup(React.createElement(SyncLanguageHarness));
        React.useEffect = origUseEffect;
        for (const eff of effects) eff();
        assert.equal(
          kdsInfoFetchCount,
          0,
          'useSyncServerLanguage skips unauthenticated /api/kds/info fetch in POS dashboard context',
        );
        assert.equal(
          useThemeMode.getState().mode,
          'light',
          'visiting /kds after reload preserves saved POS theme without stale KDS override',
        );

        storage.set(KDS_THEME_OVERRIDE_KEY, 'dark');
        clearKdsThemeOverride();
        assert.equal(
          storage.has(KDS_THEME_OVERRIDE_KEY),
          false,
          'clearKdsThemeOverride removes flo-kds-theme-override from localStorage',
        );

        storage.clear();
        storage.set('token', 'chef-kds-jwt');
        (globalThis as any).localStorage = (globalThis as any).window.localStorage;
        (globalThis as any).window.addEventListener = () => {};
        (globalThis as any).window.removeEventListener = () => {};

        let settingsThemeGetCalls = 0;
        api.get = async (url: string) => {
          if (url === '/settings/theme_mode') settingsThemeGetCalls += 1;
          return { data: '<!doctype html>' };
        };

        mediaMatches = true;
        (globalThis as any).location = { pathname: '/kds-standalone', search: '' };
        useThemeMode.setState({ mode: 'system', userSelected: false, serverSynced: false });
        Object.assign(useThemeMode.getInitialState(), useThemeMode.getState());
        applyServerThemeInfo('system', '/api/kds/info', true);
        assert.equal(storage.get('flo-theme-resolved'), 'dark');

        const standaloneEffects: Array<() => void | (() => void)> = [];
        React.useEffect = ((fn: () => void | (() => void)) => {
          standaloneEffects.push(fn);
        }) as typeof React.useEffect;
        ReactDOMServer.renderToStaticMarkup(React.createElement(ThemeSync));
        React.useEffect = origUseEffect;
        const cleanups = standaloneEffects
          .map((fn) => fn())
          .filter((c): c is () => void => typeof c === 'function');
        await new Promise<void>((r) => setImmediate(r));
        for (const cleanup of cleanups) cleanup();

        assert.equal(
          settingsThemeGetCalls,
          0,
          'ThemeSync skips /settings/theme_mode fetch on /kds-standalone',
        );
        assert.equal(
          useThemeMode.getState().mode,
          'system',
          'ThemeSync does not clobber system mode with flo-theme-resolved mirror on /kds-standalone',
        );

        (globalThis as any).location = { pathname: '/kds', search: '?theme=light' };
        useThemeMode.setState({ mode: 'system', userSelected: false, serverSynced: false });
        Object.assign(useThemeMode.getInitialState(), useThemeMode.getState());
        applyServerThemeInfo('dark', '/api/kds/info', true);

        const origSetTimeout = globalThis.setTimeout;
        let popupThemeAttempts = 0;
        api.get = async () => {
          popupThemeAttempts += 1;
          return { data: '<!doctype html>' };
        };
        globalThis.setTimeout = ((cb: (...args: any[]) => void, ms?: number, ...args: any[]) => {
          if (ms === 1000) {
            return origSetTimeout(cb, 0, ...args);
          }
          return origSetTimeout(cb, ms, ...args);
        }) as typeof globalThis.setTimeout;

        try {
          const popupEffects: Array<() => void | (() => void)> = [];
          React.useEffect = ((fn: () => void | (() => void)) => {
            popupEffects.push(fn);
          }) as typeof React.useEffect;
          ReactDOMServer.renderToStaticMarkup(React.createElement(ThemeSync));
          React.useEffect = origUseEffect;
          const popupCleanups = popupEffects
            .map((fn) => fn())
            .filter((c): c is () => void => typeof c === 'function');
          await new Promise<void>((r) => origSetTimeout(r, 20));
          for (const cleanup of popupCleanups) cleanup();
          assert.equal(popupThemeAttempts, 2, 'ThemeSync completes bounded 2-attempt fetch');
          assert.equal(
            useThemeMode.getState().mode,
            'dark',
            'ThemeSync ?theme=light fallback does not clobber newer store dark theme from /api/kds/info',
          );
        } finally {
          globalThis.setTimeout = origSetTimeout;
        }
      } finally {
        api.put = origApiPut;
        api.get = origApiGet;
        React.useEffect = origUseEffect;
        if (origLocation === undefined) {
          delete (globalThis as any).location;
        } else {
          (globalThis as any).location = origLocation;
        }
        if (origLocalStorage === undefined) {
          delete (globalThis as any).localStorage;
        } else {
          (globalThis as any).localStorage = origLocalStorage;
        }
      }
    } finally {
      jsxRuntime.jsx = origJsx;
      globalThis.fetch = origFetch;
      if (origWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = origWindow;
      }
      if (origDocument === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = origDocument;
      }
    }
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }

  // 4. Dashboard /kds logout clears shared useAuthStore + localStorage without touching standalone mode (#1525)
  const prevLoad = Module._load;
  const origWindow = (globalThis as any).window;
  const origLocalStorage = (globalThis as any).localStorage;
  const origWebSocket = (globalThis as any).WebSocket;
  const storage = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const callbacks: Array<{ fn: any; deps?: any[] }> = [];
  const effects: Array<{ effect: () => any; cleanup?: () => any; deps?: any[] }> = [];
  let stateIdx = 0;
  let refIdx = 0;
  let callbackIdx = 0;
  let effectIdx = 0;

  const hookReact = {
    useState(init: any) {
      const i = stateIdx++;
      if (i >= states.length) states[i] = typeof init === 'function' ? init() : init;
      return [
        states[i],
        (action: any) => {
          states[i] = typeof action === 'function' ? action(states[i]) : action;
        },
      ];
    },
    useRef(init: any) {
      const i = refIdx++;
      if (i >= refs.length) refs[i] = { current: init };
      return refs[i];
    },
    useCallback(fn: any, deps?: any[]) {
      const i = callbackIdx++;
      const prev = callbacks[i];
      if (!prev || !deps || !prev.deps || deps.some((d, idx) => d !== prev.deps![idx])) {
        callbacks[i] = { fn, deps };
      }
      return callbacks[i].fn;
    },
    useEffect(effect: () => any, deps?: any[]) {
      const i = effectIdx++;
      const prev = effects[i];
      if (!prev || !deps || !prev.deps || deps.some((d, idx) => d !== prev.deps![idx])) {
        if (prev?.cleanup) prev.cleanup();
        const cleanup = effect();
        effects[i] = {
          effect,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
          deps,
        };
      }
    },
  };

  function resetHooks() {
    states.length = 0;
    refs.length = 0;
    callbacks.length = 0;
    for (const e of effects) {
      if (typeof e.cleanup === 'function') e.cleanup();
    }
    effects.length = 0;
  }

  class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((evt: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send() {}
    close() {}
  }

  try {
    (globalThis as any).localStorage = mockLocalStorage;
    (globalThis as any).window = {
      localStorage: mockLocalStorage,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      dispatchEvent: () => true,
      location: { protocol: 'http:', host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    };
    (globalThis as any).WebSocket = MockWebSocket;

    Module._resolveFilename = function (
      request: string,
      parent: any,
      isMain: boolean,
      options?: any,
    ) {
      let resolvedRequest = frontendResolved.get(request) ?? request;
      if (request.startsWith('@/')) {
        resolvedRequest = path.resolve(process.cwd(), 'frontend/src', request.slice(2));
      } else if (request.startsWith('@print/')) {
        resolvedRequest = path.resolve(
          process.cwd(),
          'shared/print',
          request.slice('@print/'.length),
        );
      } else if (request.startsWith('@shared/')) {
        resolvedRequest = path.resolve(process.cwd(), 'shared', request.slice('@shared/'.length));
      }
      return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
    };

    const kdsHookPath = require.resolve('../frontend/src/hooks/useKdsConnection');
    const authStorePath = require.resolve('../frontend/src/store/auth');
    delete require.cache[kdsHookPath];
    delete require.cache[authStorePath];

    Module._load = function (requestName: string) {
      if (requestName === 'react') return hookReact;
      if (requestName === '@/hooks/use-confirm') {
        return { useConfirm: () => ({ confirm: async () => true, ConfirmDialog: null }) };
      }
      if (requestName === 'react-hot-toast') {
        const toast = { success: () => {}, error: () => {}, default: null as any };
        toast.default = toast;
        return toast;
      }
      if (requestName === 'use-intl') return { useTranslations: () => (k: string) => k };
      return prevLoad.apply(this, arguments as any);
    };

    const { useKdsConnection } = require('../frontend/src/hooks/useKdsConnection');
    const { useAuthStore } = require('../frontend/src/store/auth');
    const api = require('../frontend/src/lib/api').default;

    const origSharedApiPost = api.post;
    const sharedPostCalls: string[] = [];
    api.post = async (url: string) => {
      sharedPostCalls.push(url);
      return { data: {} };
    };

    try {
      const tenant = { id: 1, name: 'Test Cafe', role: 'chef' };
      const chefUser = { id: 'chef-1', name: 'Chef', email: 'chef@test.local', role: 'chef' };

      // 4a: Dashboard KDS logout clears shared POS auth store + storage without duplicate /auth/logout POST
      let kdsLogoutCalls = 0;
      const apiDefaults = { baseURL: 'http://127.0.0.1:3001/api' };
      const kdsApi: any = {
        defaults: apiDefaults,
        get: async (url: string) =>
          url === '/auth/me' ? { data: { user: { ...chefUser, has_pin: true } } } : { data: {} },
        post: async (url: string) => {
          if (url === '/auth/logout') kdsLogoutCalls += 1;
          return { data: {} };
        },
        patch: async () => ({ data: {} }),
      };

      storage.set('token', 'tok-kds-1');
      storage.set('user', JSON.stringify(chefUser));
      storage.set('tenant', JSON.stringify(tenant));
      useAuthStore.setState({
        user: chefUser,
        token: 'tok-kds-1',
        tenants: [tenant],
        currentTenant: tenant,
        loading: false,
      });

      const renderDashboardKds = () => {
        stateIdx = 0;
        refIdx = 0;
        callbackIdx = 0;
        effectIdx = 0;
        return useKdsConnection({
          api: kdsApi,
          enabled: true,
          onSessionCleared: (clearedToken: string | null) =>
            useAuthStore.getState().clearLocalSession(clearedToken),
          onSessionTokenReplaced: (nextToken: string, hasPin?: boolean) =>
            useAuthStore
              .getState()
              .replaceSessionToken(
                nextToken,
                hasPin !== undefined ? { has_pin: hasPin } : undefined,
              ),
        });
      };

      let hook = renderDashboardKds();
      await new Promise<void>((r) => setImmediate(r));
      hook = renderDashboardKds();
      assert.equal(hook.user?.id, 'chef-1', 'dashboard KDS restores chef session');

      await hook.handleLogout();
      assert.equal(kdsLogoutCalls, 1, 'dashboard KDS posts /auth/logout once');
      assert.equal(
        sharedPostCalls.length,
        0,
        'dashboard KDS logout clears shared auth store locally without a second /auth/logout POST',
      );
      assert.equal(storage.get('token'), undefined, 'dashboard KDS logout clears token storage');
      assert.equal(storage.get('user'), undefined, 'dashboard KDS logout clears user storage');
      assert.equal(storage.get('tenant'), undefined, 'dashboard KDS logout clears tenant storage');
      assert.equal(
        useAuthStore.getState().user,
        null,
        'dashboard KDS logout clears shared POS user',
      );
      assert.equal(
        useAuthStore.getState().token,
        null,
        'dashboard KDS logout clears shared POS token',
      );
      assert.equal(
        useAuthStore.getState().currentTenant,
        null,
        'dashboard KDS logout clears shared POS currentTenant',
      );

      // 4b: Delayed logout does not clobber a newer rotated session or re-login
      resetHooks();
      let resolveDelayedLogout!: () => void;
      const delayedKdsApi: any = {
        defaults: apiDefaults,
        get: async () => ({ data: { user: { ...chefUser, has_pin: false } } }),
        post: (url: string) =>
          url === '/auth/logout'
            ? new Promise((resolve) => {
                resolveDelayedLogout = () => resolve({ data: {} });
              })
            : Promise.resolve({ data: {} }),
        patch: async () => ({ data: {} }),
      };

      storage.set('token', 'tok-kds-old');
      storage.set('user', JSON.stringify(chefUser));
      storage.set('tenant', JSON.stringify(tenant));
      useAuthStore.setState({
        user: chefUser,
        token: 'tok-kds-old',
        tenants: [tenant],
        currentTenant: tenant,
        loading: false,
      });

      const renderDelayedKds = () => {
        stateIdx = 0;
        refIdx = 0;
        callbackIdx = 0;
        effectIdx = 0;
        return useKdsConnection({
          api: delayedKdsApi,
          enabled: true,
          onSessionCleared: (clearedToken: string | null) =>
            useAuthStore.getState().clearLocalSession(clearedToken),
          onSessionTokenReplaced: (nextToken: string, hasPin?: boolean) =>
            useAuthStore
              .getState()
              .replaceSessionToken(
                nextToken,
                hasPin !== undefined ? { has_pin: hasPin } : undefined,
              ),
        });
      };

      hook = renderDelayedKds();
      await new Promise<void>((r) => setImmediate(r));
      hook = renderDelayedKds();
      const pendingLogout = hook.handleLogout();
      await new Promise<void>((r) => setImmediate(r));

      hook.replaceSessionToken?.('tok-kds-new', true);
      assert.equal(
        useAuthStore.getState().token,
        'tok-kds-new',
        'replaceSessionToken propagates new token to shared POS auth store',
      );

      resolveDelayedLogout();
      await pendingLogout;
      useAuthStore.getState().clearLocalSession('tok-kds-old');
      assert.equal(
        storage.get('token'),
        'tok-kds-new',
        'delayed logout preserves newer token in localStorage',
      );
      assert.equal(
        Boolean(storage.get('tenant')),
        true,
        'delayed logout preserves newer tenant in localStorage',
      );
      assert.equal(
        useAuthStore.getState().token,
        'tok-kds-new',
        'delayed logout preserves newer token in shared POS auth store',
      );
      assert.equal(
        useAuthStore.getState().user?.id,
        'chef-1',
        'delayed logout preserves signed-in user in shared POS auth store',
      );

      // 4c: Standalone KDS (no onSessionCleared) leaves shared useAuthStore untouched
      resetHooks();
      storage.set('token', 'tok-standalone');
      storage.set('tenant', JSON.stringify(tenant));
      useAuthStore.setState({
        user: chefUser,
        token: 'tok-pos-unrelated',
        tenants: [tenant],
        currentTenant: tenant,
        loading: false,
      });

      const renderStandaloneKds = () => {
        stateIdx = 0;
        refIdx = 0;
        callbackIdx = 0;
        effectIdx = 0;
        return useKdsConnection({ api: kdsApi, enabled: true });
      };
      hook = renderStandaloneKds();
      await new Promise<void>((r) => setImmediate(r));
      hook = renderStandaloneKds();
      await hook.handleLogout();
      assert.equal(storage.get('token'), undefined, 'standalone KDS logout removes its token');
      assert.equal(
        useAuthStore.getState().token,
        'tok-pos-unrelated',
        'standalone KDS logout does not clear shared POS auth store',
      );
    } finally {
      api.post = origSharedApiPost;
      resetHooks();
      delete require.cache[kdsHookPath];
      delete require.cache[authStorePath];
    }
  } finally {
    Module._load = prevLoad;
    Module._resolveFilename = originalResolveFilename;
    if (origWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = origWebSocket;
    if (origLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = origLocalStorage;
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
  }

  console.log('✅ KDS frontend conflict refresh & Kanban inline add-ons regression test passed');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
