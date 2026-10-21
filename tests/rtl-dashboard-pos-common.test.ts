/**
 * RTL/LTR Dashboard, POS, and common flow regression test (Batch E, Refs #241).
 *
 * Builds on the shared direction foundation guarded by `rtl-foundation.test.ts`
 * (Batch C) and the Setup/Auth/Settings guard `rtl-setup-auth-settings.test.ts`
 * (Batch D), and extends the same guarantees to the core merchant/cashier
 * operational screens:
 *
 *   - dashboard
 *   - POS ordering, cart, product grid, customer search, held orders
 *   - products/categories (and the product image uploader)
 *   - customers, tables
 *   - orders / bills / order detail (incl. split check)
 *   - checkout / payment flows (payment + prepaid checkout modals)
 *   - shared operational components
 *
 *   1. These screens must not use physical left/right utilities for
 *      content-flow layout (margin, padding, alignment, borders, rounding,
 *      positioning). The shared logical equivalents (`ms/me/ps/pe/start/end/
 *      text-start/text-end/border-s/border-e/rounded-s/rounded-e`) render
 *      identically in LTR and mirror under `dir="rtl"`, so any remaining
 *      physical utility is a regression.
 *
 *   2. Directional icons (`ArrowLeft`/`ArrowRight`/`ChevronLeft`/
 *      `ChevronRight`) must carry the shared `.rtl-flip` class so they
 *      mirror under `[dir="rtl"]` (e.g. the dashboard "view all" arrows and
 *      the expandable tax / print-history chevrons).
 *
 *   3. An icon rendered BEFORE its label/text (e.g. `<Plus size={16} ... />
 *      Add product`) needs the gap on its inline-end side, so it must use the
 *      logical `me-*` margin — never `ms-*`, which would put the gap on the
 *      wrong side and change the LTR layout. (This is the `mr-*` → `me-*`
 *      mapping; `ml-*` → `ms-*` remains correct for icons rendered AFTER
 *      their label, like sort/chevron icons.)
 *
 *   4. DirectionalToaster dynamically adapts toast placement across RTL/LTR
 *      languages (`top-left` for Persian, `top-right` for LTR languages).
 *
 *   5. The Ltr component isolates POS operational values (order numbers,
 *      phone numbers, printer IP/VID, table identifiers, JSON payloads) with
 *      `dir="ltr"` and bidi isolation.
 *
 * Run: npm run test:rtl-dashboard-pos-common
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));

/** Batch E screen files that must use logical direction utilities. */
const SCREEN_FILES = [
  'frontend/src/app/(dashboard)/pos/page.tsx',
  'frontend/src/app/(dashboard)/dashboard/page.tsx',
  'frontend/src/app/(dashboard)/orders/page.tsx',
  'frontend/src/app/(dashboard)/products/page.tsx',
  'frontend/src/app/(dashboard)/customers/page.tsx',
  'frontend/src/app/(dashboard)/tables/page.tsx',
  'frontend/src/components/pos/CartPanel.tsx',
  'frontend/src/components/pos/ProductGrid.tsx',
  'frontend/src/components/pos/PosTopbar.tsx',
  'frontend/src/components/pos/TaxBreakdown.tsx',
  'frontend/src/components/pos/PaymentModal.tsx',
  'frontend/src/components/pos/PrepaidCheckoutModal.tsx',
  'frontend/src/components/pos/TablePickerModal.tsx',
  'frontend/src/components/pos/TableCheckoutModal.tsx',
  'frontend/src/components/pos/AddonModal.tsx',
  'frontend/src/components/pos/CustomerSearch.tsx',
  'frontend/src/components/pos/CustomerTopItems.tsx',
  'frontend/src/components/pos/EditCustomerModal.tsx',
  'frontend/src/components/pos/PrinterStatus.tsx',
  'frontend/src/components/pos/SplitCheckModal.tsx',
  'frontend/src/components/orders/OrderHistoryGrid.tsx',
  'frontend/src/components/products/ImageUploader.tsx',
];

/**
 * Physical directional utilities that must be converted to logical ones in the
 * batch screens. Same rule set as the shared foundation and Batch D tests.
 */
const PHYSICAL_UTIL_RE =
  /\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-[0-9a-zA-Z.]+|\btext-(left|right)\b/g;

/**
 * Per-file allowlist of physical utilities that are genuinely intentional.
 * Currently empty: every physical utility found in the batch was converted to
 * its logical equivalent. If a future change introduces a genuinely physical
 * case (e.g. a fixed-position overlay pinned to a physical corner), it must be
 * listed here with a comment explaining why it stays physical.
 */
const ALLOWLIST: Record<string, string[]> = {};

function collectElements(
  node: unknown,
  predicate: (element: any) => boolean,
  result: any[] = [],
): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, result);
    return result;
  }
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  const props = (node as { props?: { children?: unknown } }).props;
  if (props) collectElements(props.children, predicate, result);
  return result;
}

function loadComponents(): {
  AddonGroupsPage: () => any;
  api: { get: (...args: any[]) => any };
  ChevronRight: any;
  ChevronDown: any;
  faMessages: Record<string, any>;
  DirectionalToaster: any;
  usePosSettingsStore: any;
  Ltr: any;
  IntlProvider: any;
  getLanguageLocale: (lang: string) => string;
  React: typeof import('react');
  ReactDOMServer: typeof import('react-dom/server');
  getRouterReplacedRoute: () => string;
  resetRouterReplacedRoute: () => void;
} {
  let routerReplacedRoute = '';
  const routerMock = {
    replace: (target: string) => {
      routerReplacedRoute = target;
    },
    push: (target: string) => {
      routerReplacedRoute = target;
    },
  };

  const moduleApi = require('module') as {
    _resolveFilename: (...args: any[]) => string;
    _load: (...args: any[]) => any;
  };
  const originalResolveFilename = moduleApi._resolveFilename;
  const originalLoad = moduleApi._load;

  moduleApi._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options?: any,
  ) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(ROOT, 'main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(ROOT, 'frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = path.resolve(ROOT, 'shared/print', request.slice('@print/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };

  moduleApi._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'next/navigation') {
      return {
        useRouter: () => routerMock,
        useSearchParams: () => new URLSearchParams(),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const React = frontendRequire('react');
    const ReactDOMServer = frontendRequire('react-dom/server');
    const { ChevronRight, ChevronDown } = frontendRequire('lucide-react');
    const api = require('../frontend/src/lib/api').default;
    const AddonGroupsPage = require('../frontend/src/app/(dashboard)/addon-groups/page').default;
    const faMessages = require('../frontend/src/lib/i18n/messages/fa.json');
    const { DirectionalToaster } = require('../frontend/src/components/layout/DirectionalToaster');
    const { usePosSettingsStore } = require('../frontend/src/store/pos-settings');
    const { Ltr } = require('../frontend/src/components/layout/Ltr');
    const { IntlProvider } = frontendRequire('use-intl');
    const { getLanguageLocale } = require('../frontend/src/lib/i18n');
    return {
      AddonGroupsPage,
      api,
      ChevronRight,
      ChevronDown,
      faMessages,
      DirectionalToaster,
      usePosSettingsStore,
      Ltr,
      IntlProvider,
      getLanguageLocale,
      React,
      ReactDOMServer,
      getRouterReplacedRoute: () => routerReplacedRoute,
      resetRouterReplacedRoute: () => {
        routerReplacedRoute = '';
      },
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
    moduleApi._load = originalLoad;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function run(): void {
  console.log('RTL/LTR Dashboard, POS, and common flow checks:');

  // 1. Batch screens use logical direction utilities (or are allowlisted).
  let totalPhysical = 0;
  for (const file of SCREEN_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const matches = src.match(PHYSICAL_UTIL_RE) ?? [];
    const allowed = ALLOWLIST[path.basename(file)] ?? [];
    const violations = matches.filter((m) => !allowed.includes(m));
    if (violations.length) {
      console.error(`\nPhysical direction utilities in ${file}:`);
      for (const v of violations) console.error(`  - ${v}`);
      assert(false, `physical direction utilities remain in ${file}`);
    }
    totalPhysical += matches.length;
  }
  console.log(
    `  ✓ batch screens use logical direction utilities (${totalPhysical} allowlisted physical cases)`,
  );

  // 2. Directional icons carry `.rtl-flip`.
  const iconFiles = SCREEN_FILES.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /\b(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/.test(src);
  });
  for (const file of iconFiles) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Only flag JSX usage (`<Arrow…`, `<Chevron…`), not the lucide import statement.
      if (
        /<(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/.test(line) &&
        !line.includes('rtl-flip')
      ) {
        assert(false, `${file}:${i + 1} uses a directional icon without rtl-flip: ${line.trim()}`);
      }
    });
  }
  console.log(
    `  ✓ directional icons carry rtl-flip (${iconFiles.length} file(s) with directional icons)`,
  );

  // 3. Icons rendered before their label must use `me-*` (inline-end), never
  //    `ms-*` (inline-start). Match a lucide icon component with an `ms-*`
  //    class that is immediately followed by text/expression on the same line.
  const iconBeforeTextRe =
    /<[A-Z][A-Za-z]*\s+size=\{[0-9]+\}\s+className="[^"]*\bms-[0-9][^"]*"\s*\/>\s*(?:\{|[A-Za-z]|["'])/g;
  for (const file of SCREEN_FILES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (iconBeforeTextRe.test(line)) {
        assert(
          false,
          `${file}:${i + 1} icon-before-text uses ms-* (inline-start) instead of me-*: ${line.trim()}`,
        );
      }
    });
  }
  console.log('  ✓ icon-before-text gaps use me-* (inline-end), not ms-*');

  // 4. Executable DirectionalToaster position assertions across languages.
  //    #376: DirectionalToaster reads the active locale from the i18n context
  //    (useLocale), so each render is wrapped in an IntlProvider whose locale
  //    matches the language under test.
  const {
    AddonGroupsPage,
    api,
    ChevronRight,
    ChevronDown,
    faMessages,
    DirectionalToaster,
    usePosSettingsStore,
    Ltr,
    IntlProvider,
    getLanguageLocale,
    React,
    ReactDOMServer,
    getRouterReplacedRoute,
    resetRouterReplacedRoute,
  } = loadComponents();

  React.useSyncExternalStore = (_subscribe: any, getSnapshot: () => any) => getSnapshot();

  function renderDirectionalToaster(locale: string): {
    position?: string;
    containerStyle?: any;
    markup: string;
    key?: string | null;
  } {
    let capturedProps: any;
    let capturedKey: string | null | undefined;
    function Probe() {
      const elem = DirectionalToaster();
      capturedProps = elem?.props;
      capturedKey = elem?.key;
      return elem;
    }
    const markup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(IntlProvider, { locale }, React.createElement(Probe)),
    );
    return {
      position: capturedProps?.position,
      containerStyle: capturedProps?.containerStyle,
      markup,
      key: capturedKey,
    };
  }

  usePosSettingsStore.getState().setLanguage('fa');
  const renderedFa = renderDirectionalToaster(getLanguageLocale('fa'));
  assert(
    renderedFa.position === 'top-left',
    `DirectionalToaster must set position="top-left" (inline-end) for Persian (fa), got: ${renderedFa.position}`,
  );
  assert(
    renderedFa.containerStyle?.top === 'calc(var(--flo-sidebar-block-start, 0px) + 16px)',
    `DirectionalToaster must set containerStyle.top with titlebar offset, got: ${renderedFa.containerStyle?.top}`,
  );
  assert(
    typeof renderedFa.markup === 'string' && renderedFa.markup.length > 0,
    'DirectionalToaster must render static markup for Persian',
  );
  assert(
    renderedFa.key === 'rtl',
    `DirectionalToaster must key its Toaster "rtl" for Persian so a direction flip fully remounts it (regression guard for the insertBefore/NotFoundError crash when react-hot-toast's position prop changes on a live instance), got: ${renderedFa.key}`,
  );

  usePosSettingsStore.getState().setLanguage('ur');
  const renderedUr = renderDirectionalToaster(getLanguageLocale('ur'));
  assert(
    renderedUr.position === 'top-left',
    `DirectionalToaster must set position="top-left" for Urdu (ur), got: ${renderedUr.position}`,
  );
  assert(
    renderedUr.key === 'rtl',
    `DirectionalToaster must key its Toaster "rtl" for Urdu (ur), got: ${renderedUr.key}`,
  );

  for (const ltrLang of [
    'en',
    'es',
    'fr',
    'pt',
    'ru',
    'it',
    'ja',
    'zh',
    'zh-tw',
    'ko',
    'id',
    'nl',
    'hi',
    'bn',
    'sq',
    'vi',
    'th',
    'ne',
  ] as const) {
    usePosSettingsStore.getState().setLanguage(ltrLang);
    const renderedLtr = renderDirectionalToaster(getLanguageLocale(ltrLang));
    assert(
      renderedLtr.position === 'top-right',
      `DirectionalToaster must set position="top-right" for ${ltrLang}, got: ${renderedLtr.position}`,
    );
    assert(
      renderedLtr.containerStyle?.top === 'calc(var(--flo-sidebar-block-start, 0px) + 16px)',
      `DirectionalToaster must set containerStyle.top with titlebar offset, got: ${renderedLtr.containerStyle?.top}`,
    );
    assert(
      typeof renderedLtr.markup === 'string' && renderedLtr.markup.length > 0,
      `DirectionalToaster must render static markup for ${ltrLang}`,
    );
    assert(
      renderedLtr.key === 'ltr',
      `DirectionalToaster must key its Toaster "ltr" for ${ltrLang} so a direction flip fully remounts it (regression guard for the insertBefore/NotFoundError crash when react-hot-toast's position prop changes on a live instance), got: ${renderedLtr.key}`,
    );
  }
  console.log(
    '  ✓ DirectionalToaster dynamically adapts toast placement across RTL/LTR languages with titlebar offset',
  );
  console.log(
    '  ✓ DirectionalToaster keys its Toaster by direction to force remount instead of a live position swap (insertBefore/NotFoundError regression guard)',
  );

  // 5. Executable Ltr component rendering for POS/operational values.
  const orderRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { className: 'font-mono text-sm' }, '#ORD-2026-0042'),
  );
  assert(
    orderRender === '<span dir="ltr" class="ltr-island font-mono text-sm">#ORD-2026-0042</span>',
    `Ltr must isolate order numbers with dir="ltr", got: ${orderRender}`,
  );

  const phoneRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, '+98 21 1234 5678'),
  );
  assert(
    phoneRender === '<span dir="ltr" class="ltr-island">+98 21 1234 5678</span>',
    `Ltr must isolate customer phone numbers with dir="ltr", got: ${phoneRender}`,
  );

  const printerRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { as: 'code', className: 'text-xs' }, '192.168.1.100:9100'),
  );
  assert(
    printerRender === '<code dir="ltr" class="ltr-island text-xs">192.168.1.100:9100</code>',
    `Ltr must isolate printer IP/port endpoints, got: ${printerRender}`,
  );

  const vidRender = ReactDOMServer.renderToStaticMarkup(React.createElement(Ltr, null, 'VID:04B8'));
  assert(
    vidRender === '<span dir="ltr" class="ltr-island">VID:04B8</span>',
    `Ltr must isolate device VID values, got: ${vidRender}`,
  );

  const tableRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { as: 'span', className: 'px-1' }, 'TBL-4'),
  );
  assert(
    tableRender === '<span dir="ltr" class="ltr-island px-1">TBL-4</span>',
    `Ltr must isolate table identifiers, got: ${tableRender}`,
  );

  const jsonRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      Ltr,
      { as: 'pre', className: 'text-xs font-mono' },
      '{"table": 4, "guests": 2}',
    ),
  );
  assert(
    jsonRender ===
      '<pre dir="ltr" class="ltr-island text-xs font-mono">{&quot;table&quot;: 4, &quot;guests&quot;: 2}</pre>',
    `Ltr must isolate technical JSON payloads, got: ${jsonRender}`,
  );
  console.log(
    '  ✓ Ltr component isolates POS operational values (order #, phone, IP, VID, table, JSON)',
  );

  // 6. Shared language-direction metadata (single source of truth).
  const { getLanguageDirection } = require('../frontend/src/lib/i18n');
  for (const rtlLang of ['fa', 'ur'] as const) {
    assert(getLanguageDirection(rtlLang) === 'rtl', `${rtlLang} must resolve to rtl`);
  }
  for (const ltrLang of [
    'en',
    'es',
    'fr',
    'pt',
    'ru',
    'it',
    'ja',
    'zh',
    'zh-tw',
    'ko',
    'id',
    'nl',
    'hi',
    'bn',
    'sq',
    'vi',
    'th',
    'ne',
  ] as const) {
    assert(getLanguageDirection(ltrLang) === 'ltr', `${ltrLang} must resolve to ltr`);
  }
  console.log('  ✓ getLanguageDirection resolves direction from shared language metadata');

  const originalUseState = React.useState;
  const originalUseEffect = React.useEffect;
  const originalApiGet = api.get;
  try {
    resetRouterReplacedRoute();

    let apiCallsCount = 0;
    api.get = (url: string) => {
      apiCallsCount += 1;
      throw new Error(`Unexpected API call to ${url}`);
    };

    const renderAddonGroupsPage = () => {
      let capturedTree: any;
      function AddonGroupsProbe() {
        capturedTree = AddonGroupsPage();
        return capturedTree;
      }
      const markup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: getLanguageLocale('fa'), messages: faMessages, timeZone: 'UTC' },
          React.createElement(AddonGroupsProbe),
        ),
      );
      return { tree: capturedTree, markup };
    };

    const { markup } = renderAddonGroupsPage();
    assert(apiCallsCount === 0, 'AddonGroupsPage compatibility redirect performs zero API reads');
    assert(
      markup.includes(faMessages.common.loading),
      `AddonGroupsPage compatibility redirect renders translated loading state in RTL, got: ${markup}`,
    );

    // Run effect to verify redirect
    let effectRan = false;
    React.useEffect = ((effect: () => void) => {
      effect();
      effectRan = true;
    }) as typeof React.useEffect;
    renderAddonGroupsPage();
    assert(effectRan, 'AddonGroupsPage executes redirect effect');
    assert(
      getRouterReplacedRoute() === '/products?tab=addons',
      `AddonGroupsPage redirects to canonical /products?tab=addons, got: ${getRouterReplacedRoute()}`,
    );
  } finally {
    React.useState = originalUseState;
    React.useEffect = originalUseEffect;
    api.get = originalApiGet;
  }
  console.log(
    '  ✓ AddonGroupsPage compatibility redirect performs zero API calls, renders translated loading state in RTL, and redirects to /products?tab=addons',
  );

  console.log('\n✅ All RTL/LTR Dashboard, POS, and common flow checks passed.');
}

run();
