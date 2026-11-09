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
    const { KdsHeader } = require('../frontend/src/components/kds/KdsHeader');
    const {
      STATUS_CONFIG,
      ORDER_TYPE_BADGE_STYLES,
    } = require('../frontend/src/hooks/useKdsConnection');
    const { useThemeMode } = require('../frontend/src/store/theme');
    const { fetchServerInfo } = require('../frontend/src/lib/i18n/server-language');

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
      /bg-blue-50 text-blue-800 border border-blue-300 dark:bg-blue-950\/90 dark:text-blue-200 dark:border-blue-700/,
      'KDS Kanban add-on badges use WCAG AA light and dark classes',
    );
    assert.match(
      kanbanMarkup,
      /bg-red-50 text-red-800 border-red-300 dark:bg-red-950\/90 dark:text-red-200 dark:border-red-700/,
      'KDS Kanban item special instructions use high-contrast callout pill classes in light and dark mode',
    );
    assert.match(
      kanbanMarkup,
      /bg-amber-50 border border-amber-300 text-amber-900 dark:bg-amber-950\/80 dark:border-amber-700 dark:text-amber-200/,
      'KDS Kanban order special instructions include WCAG AA dark mode classes',
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
    assert.match(
      tabsMarkup,
      /bg-blue-50 text-blue-800 border border-blue-300 dark:bg-blue-950\/90 dark:text-blue-200 dark:border-blue-700/,
      'KDS Tabs view add-on badges use WCAG AA light and dark classes',
    );
    assert.match(
      tabsMarkup,
      /bg-red-50 text-red-800 border-red-300 dark:bg-red-950\/90 dark:text-red-200 dark:border-red-700/,
      'KDS Tabs view item special instructions use high-contrast callout pill classes in light and dark mode',
    );
    assert.match(
      tabsMarkup,
      /bg-amber-50 border border-amber-300 text-amber-900 dark:bg-amber-950\/80 dark:border-amber-700 dark:text-amber-200/,
      'KDS Tabs view order special instructions include WCAG AA dark mode classes',
    );

    const modalMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        React.createElement(KdsItemModal, {
          item: sampleOrders[0].items[0],
          orderNumber: 'KDS-1513',
          updating: false,
          onClose: () => {},
          onUpdateStatus: () => {},
        }),
      ),
    );
    assert.match(
      modalMarkup,
      /bg-blue-50 dark:bg-blue-950\/60 border border-blue-200 dark:border-blue-800/,
      'KdsItemModal add-ons box includes dark mode classes',
    );
    assert.match(
      modalMarkup,
      /bg-red-50 dark:bg-red-950\/60 border border-red-200 dark:border-red-800/,
      'KdsItemModal special instructions box includes dark mode classes',
    );

    for (const key of ['dine_in', 'takeaway', 'delivery', 'online']) {
      assert.match(
        ORDER_TYPE_BADGE_STYLES[key],
        /dark:bg-\w+-950\/80 dark:text-\w+-200 dark:border-\w+-700/,
        `ORDER_TYPE_BADGE_STYLES[${key}] includes WCAG AA dark mode classes`,
      );
    }
    for (const status of ['pending', 'preparing', 'ready', 'served', 'voided'] as const) {
      assert.match(
        STATUS_CONFIG[status].text,
        /text-\w+-800 dark:text-\w+-200/,
        `STATUS_CONFIG.${status}.text uses 800/200 contrast classes`,
      );
      assert.match(
        STATUS_CONFIG[status].color,
        /bg-\w+-600/,
        `STATUS_CONFIG.${status}.color uses 600 shade for WCAG AA white text contrast`,
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

    // Verify fetchServerInfo parses theme_mode into themeMode
    const origWindow = (globalThis as any).window;
    const origFetch = globalThis.fetch;
    try {
      (globalThis as any).window = {};
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
    } finally {
      globalThis.fetch = origFetch;
      if (origWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = origWindow;
      }
    }
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }

  console.log('✅ KDS frontend conflict refresh & Kanban inline add-ons regression test passed');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
