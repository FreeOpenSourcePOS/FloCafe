/**
 * Source-level guards for the UI regressions fixed by issues #621, #623, and #626,
 * plus executable component rendering and parsed CSS checks for CheckoutPaymentStation,
 * POS drawers, side sheets, CartPanel, PosTopbar, CustomerSearch, and KDS (#1453).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const tables = source('frontend/src/app/(dashboard)/tables/page.tsx');
assert.match(
  tables,
  /tenantCan\(currentTenant, 'tables\.manage'\)/,
  'table management controls stay permission-gated',
);
assert.match(
  tables,
  /api\.put\(`\/tables\/\$\{editingTable\.id\}`/,
  'table editor persists through PUT',
);
assert.match(
  tables,
  /TABLE_NAME_DUPLICATE: tTables\('tableNameDuplicate'\)/,
  'backend table errors map to localized UI messages',
);
assert.match(
  tables,
  /TABLE_LOCATION_INVALID: tTables\('tableLocationInvalid'\)/,
  'backend location errors map to localized UI messages',
);
assert.match(
  tables,
  /Number\.isInteger\(capacity\).*capacity < 1/s,
  'table capacity is validated before submission',
);
assert.match(tables, /tTables\('allFloors'\)/, 'floor filter retains its all-floors option');
assert.match(
  tables,
  /\[table\.floor, table\.section\]/,
  'floor and section remain visible together',
);

const whatsapp = source('frontend/src/components/settings/WhatsAppEnableCard.tsx');
assert.match(
  whatsapp,
  /font-semibold text-foreground/,
  'WhatsApp enable heading uses theme foreground',
);

const settings = source('frontend/src/app/(dashboard)/settings/page.tsx');
assert.match(
  settings,
  /dark:bg-yellow-950\/50 dark:border-yellow-800/,
  'update warning has a dark-mode surface',
);
assert.match(
  settings,
  /text-yellow-700 dark:text-yellow-300/,
  'update warning copy has dark-mode contrast',
);
assert.match(
  settings,
  /text-red-600 dark:text-red-300/,
  'update failure copy has dark-mode contrast',
);

const customers = source('frontend/src/app/(dashboard)/customers/page.tsx');
assert.match(
  customers,
  /text-muted-foreground whitespace-nowrap.*formatDate/s,
  'ledger dates use semantic text color',
);
assert.match(
  customers,
  /text-end text-foreground whitespace-nowrap.*fmt\(b\.total\)/s,
  'ledger totals use semantic text color',
);

// Issue #1453: Executable component rendering and parsed CSS checks for POS drawers,
// side sheets, CartPanel, PosTopbar, CustomerSearch, and dashboard search fields.
const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
  _load: (request: string, parent: any, isMain: boolean) => any;
};
const frontendRequire = Module.createRequire(resolve(process.cwd(), 'frontend/package.json'));
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const reactPath = frontendRequire.resolve('react');
const reactJsxRuntimePath = frontendRequire.resolve('react/jsx-runtime');
const reactDomPath = frontendRequire.resolve('react-dom');
const reactDomServerPath = frontendRequire.resolve('react-dom/server');
const useIntlPath = frontendRequire.resolve('use-intl');
const zustandPath = frontendRequire.resolve('zustand');
const zustandMiddlewarePath = frontendRequire.resolve('zustand/middleware');

Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === 'react') {
    resolvedRequest = reactPath;
  } else if (request === 'react/jsx-runtime') {
    resolvedRequest = reactJsxRuntimePath;
  } else if (request === 'react-dom') {
    resolvedRequest = reactDomPath;
  } else if (request === 'react-dom/server') {
    resolvedRequest = reactDomServerPath;
  } else if (request === 'use-intl') {
    resolvedRequest = useIntlPath;
  } else if (request === 'zustand') {
    resolvedRequest = zustandPath;
  } else if (request === 'zustand/middleware') {
    resolvedRequest = zustandMiddlewarePath;
  } else if (request === '@countries') {
    resolvedRequest = resolve(process.cwd(), 'main/countries.ts');
  } else if (request.startsWith('@/')) {
    resolvedRequest = resolve(process.cwd(), 'frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = resolve(process.cwd(), 'shared/print', request.slice('@print/'.length));
  } else if (request.startsWith('@shared/')) {
    resolvedRequest = resolve(process.cwd(), 'shared', request.slice('@shared/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'next/navigation') {
    return {
      useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => '/',
    };
  }
  if (request === 'radix-ui') {
    const mod = originalLoad.call(this, frontendRequire.resolve('radix-ui'), parent, isMain);
    const React = frontendRequire('react');
    return {
      ...mod,
      Dialog: {
        ...mod.Dialog,
        Portal: ({ children }: any) => React.createElement(React.Fragment, null, children),
      },
    };
  }
  if (request === 'vaul') {
    const mod = originalLoad.call(this, frontendRequire.resolve('vaul'), parent, isMain);
    const React = frontendRequire('react');
    return {
      ...mod,
      Drawer: {
        ...mod.Drawer,
        Portal: ({ children }: any) => React.createElement(React.Fragment, null, children),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const origDocument = (globalThis as any).document;
async function run() {
  try {
    const React = frontendRequire('react');
    const ReactDOMServer = frontendRequire('react-dom/server');
    const { IntlProvider } = frontendRequire('use-intl');
    const postcss = frontendRequire('postcss');
    const enMessages = require('../frontend/src/lib/i18n/messages/en.json');
    const { useAuthStore } = require('@/store/auth');
    const { useCartStore } = require('@/store/cart');

    const renderWithIntl = (element: any) =>
      ReactDOMServer.renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: 'en', messages: enMessages, timeZone: 'UTC' },
          element,
        ),
      );

    // 1. ScheduledOrdersDrawer and PaymentQueueDrawer rendered output
    const ScheduledOrdersDrawer =
      require('../frontend/src/components/pos/ScheduledOrdersDrawer').default;
    const { PaymentQueueDrawer } = require('../frontend/src/components/pos/PaymentQueueDrawer');

    const scheduledMarkup = renderWithIntl(
      React.createElement(ScheduledOrdersDrawer, {
        open: true,
        orders: [],
        storeTimezone: 'UTC',
        onClose: () => {},
        onRefresh: () => {},
        onOrderReleased: () => {},
        onAddItemsToOrder: () => {},
        onPayOrder: () => {},
        onRefundOrder: () => {},
      }),
    );
    assert.match(
      scheduledMarkup,
      /data-testid="scheduled-orders-drawer"[^>]*top-\[var\(--flo-sidebar-block-start,0px\)\]/,
      'rendered ScheduledOrdersDrawer root applies top-[var(--flo-sidebar-block-start,0px)]',
    );
    assert.match(
      scheduledMarkup,
      /data-testid="close-scheduled-drawer-btn"[^>]*class="[^"]*touch-target shrink-0 cursor-pointer/,
      'rendered ScheduledOrdersDrawer close button exposes close-scheduled-drawer-btn with touch-target shrink-0 cursor-pointer',
    );

    const paymentQueueMarkup = renderWithIntl(
      React.createElement(PaymentQueueDrawer, {
        open: true,
        onClose: () => {},
        onSelectOrderForPayment: () => {},
      }),
    );
    assert.match(
      paymentQueueMarkup,
      /data-testid="payment-queue-drawer"[^>]*top-\[var\(--flo-sidebar-block-start,0px\)\]/,
      'rendered PaymentQueueDrawer root applies top-[var(--flo-sidebar-block-start,0px)]',
    );
    assert.match(
      paymentQueueMarkup,
      /data-testid="close-queue-drawer-btn"[^>]*class="[^"]*touch-target shrink-0 cursor-pointer/,
      'rendered PaymentQueueDrawer close button exposes close-queue-drawer-btn with touch-target shrink-0 cursor-pointer',
    );

    // 2. Sheet and Drawer UI primitives rendered output
    const { Sheet, SheetContent, SheetTitle } = require('../frontend/src/components/ui/sheet');
    const { Drawer, DrawerContent, DrawerTitle } = require('../frontend/src/components/ui/drawer');
    (globalThis as any).document = { body: { style: {} }, querySelector: () => null };

    for (const side of ['right', 'left', 'top'] as const) {
      const sheetMarkup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(
          Sheet,
          { open: true },
          React.createElement(
            SheetContent,
            { side, 'aria-describedby': undefined },
            React.createElement(SheetTitle, null, 'Sheet Title'),
          ),
        ),
      );
      assert.match(
        sheetMarkup,
        /data-slot="sheet-content"[^>]*top-\[var\(--flo-sidebar-block-start,0px\)\]/,
        `rendered SheetContent (${side}) offsets below the desktop titlebar`,
      );
      if (side === 'right' || side === 'left') {
        assert.match(
          sheetMarkup,
          /data-slot="sheet-content"[^>]*h-\[calc\(100%-var\(--flo-sidebar-block-start,0px\)\)\]/,
          `rendered SheetContent (${side}) adjusts height for the desktop titlebar`,
        );
      }
    }

    const drawerMarkup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        Drawer,
        { open: true, direction: 'right' },
        React.createElement(
          DrawerContent,
          { 'aria-describedby': undefined },
          React.createElement(DrawerTitle, null, 'Drawer Title'),
        ),
      ),
    );
    assert.match(
      drawerMarkup,
      /data-slot="drawer-content"[^>]*data-\[vaul-drawer-direction=right\]:top-\[var\(--flo-sidebar-block-start,0px\)\]/,
      'rendered DrawerContent right direction offsets below the desktop titlebar',
    );
    assert.match(
      drawerMarkup,
      /data-slot="drawer-content"[^>]*data-\[vaul-drawer-direction=left\]:top-\[var\(--flo-sidebar-block-start,0px\)\]/,
      'rendered DrawerContent left direction offsets below the desktop titlebar',
    );
    assert.match(
      drawerMarkup,
      /data-slot="drawer-content"[^>]*data-\[vaul-drawer-direction=top\]:top-\[var\(--flo-sidebar-block-start,0px\)\]/,
      'rendered DrawerContent top direction offsets below the desktop titlebar',
    );

    const {
      CheckoutPaymentStation,
    } = require('../frontend/src/components/pos/CheckoutPaymentStation');
    const stationMarkup = renderWithIntl(
      React.createElement(
        CheckoutPaymentStation,
        {
          readout: {
            activeLabel: 'Cash',
            amountText: '$10.00',
            paidSummaryText: 'Paid $10.00',
            dueSummaryText: 'Due $0.00',
          },
          quickTenders: [{ label: '$10.00', subLabel: 'Exact', active: true, onClick: () => {} }],
          keypad: React.createElement('div', { 'data-testid': 'station-keypad-child' }, 'keypad'),
          changeDisplay: {
            label: 'Change Returned',
            formattedAmount: '$0.00',
            visible: false,
          },
        },
        React.createElement('button', { type: 'button' }, 'Pay $10.00'),
      ),
    );
    assert.ok(
      stationMarkup.includes('data-checkout-zone="keypad"') &&
        stationMarkup.includes('data-testid="checkout-change-slot"') &&
        stationMarkup.indexOf('data-checkout-zone="keypad"') <
          stationMarkup.indexOf('data-testid="checkout-change-slot"'),
      'rendered CheckoutPaymentStation places Change Returned below the keypad controls',
    );

    // 3. Parsed CSS AST check on globals.css for Electron no-drag rules
    const cssAst = postcss.parse(
      readFileSync(resolve(process.cwd(), 'frontend/src/app/globals.css'), 'utf8'),
    );
    const requiredNoDragSelectors = [
      "[data-testid='scheduled-orders-drawer']",
      "[data-testid='payment-queue-drawer']",
      "[data-slot='sheet-overlay']",
      "[data-slot='sheet-content']",
      "[data-slot='drawer-overlay']",
      "[data-slot='drawer-content']",
      "[role='dialog']",
    ];
    for (const targetSelector of requiredNoDragSelectors) {
      let hasWebkitNoDrag = false;
      let hasAppRegionNoDrag = false;
      cssAst.walkRules((rule: any) => {
        if (!rule.selectors?.includes(targetSelector)) return;
        rule.walkDecls((decl: any) => {
          if (decl.prop === '-webkit-app-region' && decl.value === 'no-drag') {
            hasWebkitNoDrag = true;
          }
          if (decl.prop === 'app-region' && decl.value === 'no-drag') {
            hasAppRegionNoDrag = true;
          }
        });
      });
      assert.ok(
        hasWebkitNoDrag && hasAppRegionNoDrag,
        `parsed globals.css declares -webkit-app-region: no-drag and app-region: no-drag for ${targetSelector}`,
      );
    }

    let themeBrandColor: string | undefined;
    let themeBrandLight: string | undefined;
    let themeDefinesBrandForeground = false;
    let themeDefinesBrandMuted = false;
    cssAst.walkAtRules('theme', (atRule: any) => {
      atRule.walkDecls((decl: any) => {
        if (decl.prop === '--color-brand') themeBrandColor = decl.value;
        if (decl.prop === '--color-brand-light') themeBrandLight = decl.value;
        if (decl.prop === '--color-brand-foreground') themeDefinesBrandForeground = true;
        if (decl.prop === '--color-brand-muted') themeDefinesBrandMuted = true;
      });
    });
    let darkBrandLight: string | undefined;
    cssAst.walkRules((rule: any) => {
      if (!rule.selectors?.includes('.dark')) return;
      rule.walkDecls('--color-brand-light', (decl: any) => {
        darkBrandLight = decl.value;
      });
    });
    assert.equal(themeBrandColor, '#3248FF', 'parsed globals.css @theme defines --color-brand');
    assert.equal(
      themeBrandLight,
      '#e8ebff',
      'parsed globals.css @theme defines --color-brand-light',
    );
    assert.equal(
      darkBrandLight,
      'oklch(0.20 0.03 270)',
      'parsed globals.css .dark overrides --color-brand-light for dark:bg-[var(--color-brand-light)]',
    );
    assert.equal(
      themeDefinesBrandForeground,
      false,
      'parsed globals.css @theme does not define --color-brand-foreground',
    );
    assert.equal(
      themeDefinesBrandMuted,
      false,
      'parsed globals.css @theme does not define --color-brand-muted',
    );

    // 4. CartPanel rendered output: inline-start red trash button and wrapping footer buttons
    useAuthStore.setState({
      user: { id: 'u1', name: 'Owner', email: 'owner@test.com', role: 'owner' } as any,
      currentTenant: {
        id: 't1',
        name: 'Cafe',
        currency: 'USD',
        country: 'US',
        business_type: 'restaurant',
        permission_ids: ['orders.item.price_override', 'inventory.manage'],
      } as any,
    });
    useCartStore.getState().clearCart();
    useCartStore.getState().setOrderType('dine_in');
    useCartStore.getState().setTableId('table-1');
    useCartStore.getState().addItem(
      {
        id: 'prod-1',
        name: 'Espresso',
        price: 4.5,
        category_id: 'cat-1',
        is_available: 1,
      } as any,
      2,
    );
    useCartStore.getState().addItem(
      {
        id: 'prod-2',
        name: 'House Beans',
        price: 18,
        category_id: 'cat-1',
        is_available: 1,
        allow_fractional_quantity: true,
        sale_unit: 'kg',
        weight_precision: 2,
      } as any,
      0.5,
    );

    const { usePosSettingsStore } = require('@/store/pos-settings');
    usePosSettingsStore.setState({ billingType: 'postpaid' } as any);
    Object.assign(usePosSettingsStore.getInitialState(), usePosSettingsStore.getState());
    Object.assign(useAuthStore.getInitialState(), useAuthStore.getState());
    Object.assign(useCartStore.getInitialState(), useCartStore.getState());

    const CartPanel = require('../frontend/src/components/pos/CartPanel').default;
    const cartMarkup = renderWithIntl(
      React.createElement(CartPanel, {
        tables: [{ id: 'table-1', name: 'T1', capacity: 4, status: 'available' }],
        currency: 'USD',
        submitting: false,
        onPlaceOrder: () => {},
        onEditItem: () => {},
      }),
    );
    const removeBtnIndex = cartMarkup.indexOf('data-testid="cart-item-remove-btn"');
    const itemNameIndex = cartMarkup.indexOf('>Espresso</p>');
    const qtyIndex = cartMarkup.indexOf('data-testid="cart-item-qty"');
    assert.ok(
      removeBtnIndex > 0 && itemNameIndex > removeBtnIndex && qtyIndex > itemNameIndex,
      'rendered CartPanel places the delete button before the item name on row 1, ahead of the row 2 quantity stepper',
    );
    assert.match(
      cartMarkup,
      /data-testid="cart-item-remove-btn"[^>]*class="[^"]*touch-target h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-md text-red-500 dark:text-red-400/,
      'rendered CartPanel delete button uses red styling and a real 28px touch target box',
    );
    assert.doesNotMatch(
      cartMarkup,
      /after:-inset/,
      'rendered CartPanel does not expand control hit areas with overlapping after:-inset pseudo-elements',
    );
    assert.match(
      cartMarkup,
      /<div class="ms-auto flex items-center gap-1\.5 shrink-0"><button type="button" class="touch-target h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-md[^"]*" aria-label="Override price"[^>]*>[\s\S]*?<button type="button" class="touch-target h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-md[^"]*" aria-label="Edit"[^>]*>[\s\S]*?<div class="inline-flex items-center rounded-full border border-border bg-muted\/50 p-0\.5"><button type="button" class="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full[^"]*" aria-label="Remove">[\s\S]*?<button type="button" class="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full[^"]*" aria-label="Add Items">/,
      'rendered CartPanel gives Override Price, Edit, and quantity stepper buttons non-overlapping 28px touch target boxes with gap-1.5 separation',
    );
    assert.match(
      cartMarkup,
      /<button type="button" class="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full[^"]*" aria-label="Remove">[\s\S]*?<input type="number" inputMode="decimal"[^>]*aria-label="Quantity"[^>]*\/><button type="button" class="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full[^"]*" aria-label="Add Items">/,
      'rendered CartPanel fractional quantity stepper buttons use real 28px touch target boxes without overlapping the quantity input',
    );
    assert.match(
      cartMarkup,
      /<button type="button" aria-label="Decrease pax" class="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full[^"]*">[\s\S]*?<input aria-label="Pax"[^>]*\/><button type="button" aria-label="Increase pax" class="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full[^"]*">/,
      'rendered CartPanel PAX stepper buttons use real 28px touch target boxes without overlapping the PAX input',
    );
    assert.doesNotMatch(
      cartMarkup,
      /order-last[^"]*touch-target/,
      'rendered CartPanel does not place a touch-target delete button with order-last',
    );
    assert.match(
      cartMarkup,
      /<div class="flex flex-wrap gap-2"><button[^>]*class="[^"]*shrink-0 px-3"[^>]*>[\s\S]*?<span class="truncate">Hold<\/span>[\s\S]*?<button[^>]*class="[^"]*flex-1 min-w-0 px-3[^"]*bg-brand text-white[^"]*"[^>]*><span class="truncate">Place Order<\/span>/,
      'rendered CartPanel footer keeps Hold compact (shrink-0 px-3) and gives Place Order the remaining width (flex-1 min-w-0 px-3) with brand CTA styling',
    );

    // Rendered brand token & dark-mode surface checks for CashCloseModal and KdsLoginForm
    const { CashCloseModal } = require('../frontend/src/components/dashboard/CashCloseModal');
    const cashCloseBrandMarkup = renderWithIntl(
      React.createElement(CashCloseModal, {
        model: {
          closeOpen: true,
          setCloseOpen: () => {},
          closeAnotherDay: false,
          businessDate: '2026-11-14',
          setBusinessDate: () => {},
          selectedSessionId: null,
          setSelectedSessionId: () => {},
          xReport: null,
          xLoading: false,
          xError: null,
          closeStep: 1,
          setCloseStep: () => {},
          openingFloatInput: '',
          setOpeningFloatInput: () => {},
          countedInput: '',
          setCountedInput: () => {},
          submittingClose: false,
          submitError: null,
          alreadyClosedOverride: false,
          setAlreadyClosedOverride: () => {},
          amountsValid: true,
          expectedCashTotalCents: 0,
          varianceCents: 0,
          closedZ: null,
          printingZ: false,
          exportingReport: false,
          exportReport: async () => {},
          hasPrintedFresh: false,
          setHasPrintedFresh: () => {},
          hydratedZ: null,
          minorFactor: 100,
          fmt: (v: number) => String(v),
          unitAdapter: {
            toDisplay: (v: number) => String(v),
            toMinor: (v: string) => Number(v),
            step: '0.01',
            min: '0',
            placeholder: '0.00',
          },
          t: (k: string) => k,
          tCommon: (k: string) => k,
          shiftDate: (d: string) => d,
          todayLocal: '2026-11-14',
          submitClose: async () => {},
          printZ: async () => {},
          canSendWhatsApp: false,
          canViewSettings: false,
          openWhatsAppReport: () => {},
          whatsAppOpen: false,
          setWhatsAppOpen: () => {},
          sendWhatsAppReport: async () => {},
          whatsappCountry: 'US',
        },
      }),
    );
    assert.match(
      cashCloseBrandMarkup,
      /<span class="[^"]*bg-brand text-white border-brand[^"]*" aria-current="step">1<\/span>/,
      'rendered CashCloseModal active step badge uses bg-brand text-white border-brand',
    );
    assert.doesNotMatch(
      cashCloseBrandMarkup,
      /text-brand-foreground/,
      'rendered CashCloseModal never emits undefined text-brand-foreground',
    );

    const { KdsLoginForm } = require('../frontend/src/components/kds/KdsLoginForm');
    const kdsStates: unknown[] = [];
    const origKdsUseState = React.useState;
    const renderKdsLoginForm = () => {
      let tree: any;
      function Runner() {
        let stateIdx = 0;
        React.useState = ((initial: unknown) => {
          const idx = stateIdx++;
          if (!(idx in kdsStates)) {
            kdsStates[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
          }
          const setState = (next: unknown) => {
            kdsStates[idx] =
              typeof next === 'function'
                ? (next as (prev: unknown) => unknown)(kdsStates[idx])
                : next;
          };
          return [kdsStates[idx], setState];
        }) as typeof React.useState;
        try {
          tree = KdsLoginForm({
            conn: {
              loginEmail: '',
              loginPassword: '',
              loginError: '',
              loginLoading: false,
              rememberMe: false,
              pinUsers: [{ id: 'u1', name: 'Chef Alex', role: 'chef' }],
              setLoginEmail: () => {},
              setLoginPassword: () => {},
              setLoginError: () => {},
              setRememberMe: () => {},
              handleLogin: async () => {},
              handlePinLogin: async () => {},
            },
          });
        } finally {
          React.useState = origKdsUseState;
        }
        return tree;
      }
      const html = renderWithIntl(React.createElement(Runner));
      return { tree, html };
    };
    const findTreeElement = (node: any, predicate: (el: any) => boolean): any => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = findTreeElement(child, predicate);
          if (hit) return hit;
        }
        return null;
      }
      if (predicate(node)) return node;
      return node.props?.children ? findTreeElement(node.props.children, predicate) : null;
    };
    const kdsInitial = renderKdsLoginForm();
    const kdsTile = findTreeElement(
      kdsInitial.tree,
      (el) => el?.props?.['data-testid'] === 'pin-user-tile-u1',
    );
    assert.ok(kdsTile, 'rendered KdsLoginForm exposes PIN user tile u1');
    kdsTile.props.onClick();
    const kdsSelected = renderKdsLoginForm();
    assert.match(
      kdsSelected.html,
      /data-testid="pin-user-tile-u1"[^>]*class="[^"]*border-brand bg-brand-light dark:bg-\[var\(--color-brand-light\)\][^"]*"/,
      'rendered KdsLoginForm selected PIN user tile pairs bg-brand-light with dark:bg-[var(--color-brand-light)]',
    );
    assert.doesNotMatch(
      kdsSelected.html,
      /bg-brand-muted/,
      'rendered KdsLoginForm never emits undefined bg-brand-muted',
    );
    assert.match(
      cartMarkup,
      /data-testid="pos-order-details-summary"/,
      'rendered CartPanel renders the compact order-details summary strip in the header',
    );
    assert.match(
      cartMarkup,
      /data-testid="pos-order-note-toggle-btn"/,
      'rendered CartPanel collapses empty order notes to an inline pill button in the footer',
    );
    assert.doesNotMatch(
      cartMarkup,
      /data-testid="pos-order-notes-input"/,
      'rendered CartPanel omits the full-width order-notes input when orderNotes is empty',
    );
    assert.match(
      cartMarkup,
      /role="group"[^>]*aria-label="Type"[^>]*data-testid="pos-order-type-tabs"/,
      'rendered CartPanel exposes a labeled group container for the order-type segmented control',
    );
    for (const [label, pressed] of [
      ['Dine in', 'true'],
      ['Takeaway', 'false'],
      ['Delivery', 'false'],
      ['Online', 'false'],
    ] as const) {
      assert.match(
        cartMarkup,
        new RegExp(
          `<button[^>]*type="button"[^>]*aria-pressed="${pressed}"[^>]*class="[^"]*min-w-0[^"]*whitespace-nowrap[^"]*"[^>]*><svg[^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg><span[^>]*class="[^"]*min-w-0 truncate[^"]*">${label}</span></button>`,
        ),
        `rendered CartPanel order-type button "${label}" renders an aria-hidden icon, aria-pressed=${pressed}, single-line whitespace-nowrap containment, and a truncatable label span`,
      );
    }
    const {
      resolveFullModeOrderTypeChromePx,
    } = require('../frontend/src/components/pos/CartPanel');
    assert.equal(
      resolveFullModeOrderTypeChromePx(
        { paddingLeft: '2px', paddingRight: '2px', columnGap: '2px' },
        { columnGap: '2px' },
        16,
      ),
      20,
      'resolveFullModeOrderTypeChromePx computes 20px chrome at 16px root font (4px px-0.5 + 2px gap-0.5 + 13px icon + 1px guard)',
    );
    assert.equal(
      resolveFullModeOrderTypeChromePx(
        { paddingLeft: '4px', paddingRight: '4px', columnGap: '4px' },
        { columnGap: '4px' },
        32,
      ),
      26,
      'resolveFullModeOrderTypeChromePx scales full-mode spacing to 26px at 32px root font while keeping the 13px icon fixed in px',
    );
    assert.equal(
      resolveFullModeOrderTypeChromePx(null, { columnGap: '4px' }, 32),
      26,
      'resolveFullModeOrderTypeChromePx derives matching 26px full-mode spacing from track computed gap when currently rendered in compact mode',
    );
    assert.equal(
      resolveFullModeOrderTypeChromePx(null, null, 24),
      23,
      'resolveFullModeOrderTypeChromePx falls back to root font-size scaling (6px + 3px + 13px + 1px = 23px at 24px root font)',
    );

    // Delivery CartPanel summary strip and OrderDetailsDrawer rendered output
    useCartStore.getState().setOrderType('delivery');
    useCartStore.getState().setDeliveryAddress('42 Sukhumvit Rd');
    useCartStore.getState().setExpectedPaymentMethod('cash', null);
    useCartStore.getState().setOrderNotes('Ring doorbell');
    Object.assign(useCartStore.getInitialState(), useCartStore.getState());

    const deliveryCartDisabledMarkup = renderWithIntl(
      React.createElement(CartPanel, {
        tables: [],
        currency: 'USD',
        submitting: false,
        onPlaceOrder: () => {},
        scheduledOrdersEnabled: false,
      }),
    );
    assert.doesNotMatch(
      deliveryCartDisabledMarkup,
      /data-testid="pos-schedule-section"/,
      'rendered Delivery CartPanel omits pos-schedule-section when scheduledOrdersEnabled is false',
    );
    assert.match(
      deliveryCartDisabledMarkup,
      /data-testid="pos-order-details-summary"[\s\S]*?42 Sukhumvit Rd[\s\S]*?Cash/,
      'rendered Delivery CartPanel summary strip still displays address and expected payment when scheduledOrdersEnabled is false',
    );

    const deliveryCartMarkup = renderWithIntl(
      React.createElement(CartPanel, {
        tables: [],
        currency: 'USD',
        submitting: false,
        onPlaceOrder: () => {},
        scheduledOrdersEnabled: true,
      }),
    );
    assert.match(
      deliveryCartMarkup,
      /data-testid="pos-schedule-section"[\s\S]*?data-testid="pos-order-details-summary"[\s\S]*?42 Sukhumvit Rd[\s\S]*?Cash/,
      'rendered Delivery CartPanel summary strip displays truncated address, expected payment badge, and schedule section when scheduledOrdersEnabled is true',
    );
    assert.match(
      deliveryCartMarkup,
      /data-testid="pos-order-notes-input"[^>]*value="Ring doorbell"/,
      'rendered CartPanel expands the compact order-notes input when orderNotes is non-empty',
    );

    const { OrderDetailsDrawer } = require('../frontend/src/components/pos/OrderDetailsDrawer');
    const detailsDrawerDisabledMarkup = renderWithIntl(
      React.createElement(OrderDetailsDrawer, {
        open: true,
        onOpenChange: () => {},
        effectiveTimezone: 'UTC',
        scheduleErrorMessage: null,
        customPaymentMethods: [],
        scheduledOrdersEnabled: false,
      }),
    );
    assert.doesNotMatch(
      detailsDrawerDisabledMarkup,
      /data-testid="pos-send-to-kitchen-input"/,
      'rendered OrderDetailsDrawer omits kitchen scheduling inputs when scheduledOrdersEnabled is false',
    );

    const detailsDrawerMarkup = renderWithIntl(
      React.createElement(OrderDetailsDrawer, {
        open: true,
        onOpenChange: () => {},
        effectiveTimezone: 'UTC',
        scheduleErrorMessage: null,
        customPaymentMethods: [],
        scheduledOrdersEnabled: true,
      }),
    );
    assert.match(
      detailsDrawerMarkup,
      /data-slot="sheet-content"[^>]*top-\[var\(--flo-sidebar-block-start,0px\)\][^>]*data-testid="pos-order-details-drawer"/,
      'rendered OrderDetailsDrawer offsets below the desktop titlebar',
    );
    assert.match(
      detailsDrawerMarkup,
      /data-testid="pos-delivery-address-input"[\s\S]*?data-testid="pos-delivery-note-input"[\s\S]*?data-testid="pos-send-to-kitchen-input"[\s\S]*?data-testid="pos-order-details-done-btn"/,
      'rendered OrderDetailsDrawer exposes delivery address, delivery note, schedule input, and Done button when scheduledOrdersEnabled is true',
    );

    // 5. PosTopbar and CustomerSearch rendered output
    const PosTopbar = require('../frontend/src/components/pos/PosTopbar').default;
    const topbarSearchMarkup = renderWithIntl(
      React.createElement(PosTopbar, {
        products: [],
        onTopItemSelect: () => {},
        showTableButton: true,
        tableName: 'T1',
        onShowTablePicker: () => {},
        onActionsMenuOpenChange: () => {},
        onShowCashMovement: () => {},
        onShowShift: () => {},
        shiftHasOpenSession: true,
        shiftLoading: false,
        shiftError: null,
        canUseShift: true,
        onShowPrintMenu: () => {},
        fullscreen: false,
        onToggleFullscreen: () => {},
      }),
    );
    assert.match(
      topbarSearchMarkup,
      /^<div class="flex flex-col gap-1\.5 border-b bg-card shrink-0 px-3 py-2 sm:px-4 sm:py-2\.5">/,
      'rendered PosTopbar root container applies gap-1.5 between the topbar row and CustomerTopItems',
    );
    assert.match(
      topbarSearchMarkup,
      /<div class="relative w-full min-w-0 sm:max-w-72 md:max-w-80"><div class="relative flex items-center">[\s\S]*?data-testid="pos-customer-search-input"/,
      'rendered CustomerSearch in PosTopbar widens the search wrapper to sm:max-w-72 md:max-w-80',
    );

    // 6. InventoryPage, CustomersPage, and OrdersPage rendered output
    const InventoryPage = require('../frontend/src/app/(dashboard)/inventory/page').default;
    const CustomersPage = require('../frontend/src/app/(dashboard)/customers/page').default;
    const OrdersPage = require('../frontend/src/app/(dashboard)/orders/page').default;

    const inventoryMarkup = renderWithIntl(React.createElement(InventoryPage));
    assert.match(
      inventoryMarkup,
      /<div class="mb-6 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-3"><h1 class="text-2xl font-bold text-foreground">Inventory<\/h1>/,
      'rendered InventoryPage header row preserves min-h-9',
    );
    assert.match(
      inventoryMarkup,
      /<div class="relative w-full sm:max-w-xs"><svg[^>]*width="16" height="16"[^>]*class="lucide lucide-search pointer-events-none absolute start-3 top-1\/2 -translate-y-1\/2 text-muted-foreground"[\s\S]*?<input type="text"[^>]*class="w-full rounded-lg border border-border bg-card py-2 ps-9 pe-3 text-sm outline-none focus:ring-2 focus:ring-brand"/,
      'rendered InventoryPage search bar matches the sleek Products search bar styling with pe-3 when empty',
    );

    const customersMarkup = renderWithIntl(React.createElement(CustomersPage));
    assert.match(
      customersMarkup,
      /<div class="relative mb-4 w-full shrink-0 sm:max-w-xs"><svg[^>]*width="16" height="16"[^>]*class="lucide lucide-search pointer-events-none absolute start-3 top-1\/2 -translate-y-1\/2 text-muted-foreground"[\s\S]*?<input type="text"[^>]*class="w-full rounded-lg border border-border bg-card py-2 ps-9 pe-3 text-sm outline-none focus:ring-2 focus:ring-brand"/,
      'rendered CustomersPage search bar matches the sleek Products search bar styling with pe-3 when empty',
    );

    const ordersMarkup = renderWithIntl(React.createElement(OrdersPage));
    assert.match(
      ordersMarkup,
      /<div class="relative w-full sm:max-w-xs"><svg[^>]*width="16" height="16"[^>]*class="lucide lucide-search pointer-events-none absolute start-3 top-1\/2 -translate-y-1\/2 text-muted-foreground"[\s\S]*?<input type="text"[^>]*class="w-full rounded-lg border border-border bg-card py-2 ps-9 pe-3 text-sm outline-none focus:ring-2 focus:ring-brand"/,
      'rendered OrdersPage search bar matches the sleek Products search bar styling with pe-3 when empty',
    );

    // Dashboard date/month pickers and openTemporalPicker executable checks
    const { openTemporalPicker } = require('../frontend/src/components/ui/date-picker-input');
    let pickerCalls = 0;
    openTemporalPicker({
      disabled: false,
      readOnly: false,
      showPicker: () => {
        pickerCalls += 1;
      },
      focus: () => {},
    } as any);
    assert.equal(pickerCalls, 1, 'dashboard calendar buttons invoke the native Chromium picker');

    const DashboardPage = require('../frontend/src/app/(dashboard)/dashboard/page').default;
    const dashboardStates: unknown[] = [];
    const dashboardRefs: Array<{ current: unknown }> = [];
    const origUseState = React.useState;
    const origUseEffect = React.useEffect;
    const origUseRef = React.useRef;
    const origUseCallback = React.useCallback;
    const origUseMemo = React.useMemo;
    const renderDashboard = () => {
      let tree: any;
      function Runner() {
        let stateIdx = 0;
        let refIdx = 0;
        React.useState = ((initial: unknown) => {
          const idx = stateIdx++;
          if (!(idx in dashboardStates)) {
            dashboardStates[idx] =
              typeof initial === 'function' ? (initial as () => unknown)() : initial;
          }
          const setState = (next: unknown) => {
            dashboardStates[idx] =
              typeof next === 'function'
                ? (next as (prev: unknown) => unknown)(dashboardStates[idx])
                : next;
          };
          return [dashboardStates[idx], setState];
        }) as typeof React.useState;
        React.useRef = ((initial: unknown) => {
          const idx = refIdx++;
          if (!dashboardRefs[idx]) dashboardRefs[idx] = { current: initial };
          return dashboardRefs[idx];
        }) as typeof React.useRef;
        React.useEffect = (() => {}) as typeof React.useEffect;
        React.useCallback = ((fn: any) => fn) as typeof React.useCallback;
        React.useMemo = ((fn: () => unknown) => fn()) as typeof React.useMemo;
        try {
          for (let pass = 0; pass < 4; pass++) {
            const snapshot = dashboardStates.slice();
            stateIdx = 0;
            refIdx = 0;
            tree = DashboardPage({});
            if (!dashboardStates.some((val, i) => val !== snapshot[i])) break;
          }
        } finally {
          React.useState = origUseState;
          React.useEffect = origUseEffect;
          React.useRef = origUseRef;
          React.useCallback = origUseCallback;
          React.useMemo = origUseMemo;
        }
        return tree;
      }
      const html = renderWithIntl(React.createElement(Runner));
      return { tree, html };
    };
    const prevAuthForDashboard = useAuthStore.getState();
    const prevAuthInitialForDashboard = { ...useAuthStore.getInitialState() };
    try {
      useAuthStore.setState({
        currentTenant: {
          ...(prevAuthForDashboard.currentTenant as any),
          timezone: 'UTC',
          business_day_start_time: '00:00',
          permission_ids: [
            ...((prevAuthForDashboard.currentTenant as any)?.permission_ids ?? []),
            'dashboard.view',
          ],
        } as any,
      });
      Object.assign(useAuthStore.getInitialState(), useAuthStore.getState());
      const dashboardDay = renderDashboard();
      assert.match(
        dashboardDay.html,
        /<input[^>]*type="date"[^>]*aria-label="Select date"[^>]*\/>[\s]*<button[^>]*type="button"[^>]*aria-label="Open date picker"/,
        'rendered DashboardPage exposes explicit date picker and accessible trigger',
      );
      const monthModeBtn = findTreeElement(
        dashboardDay.tree,
        (el) => el?.type === 'button' && el?.props?.children === 'Month',
      );
      assert.ok(monthModeBtn, 'rendered DashboardPage includes Month mode toggle');
      monthModeBtn.props.onClick();
      const dashboardMonth = renderDashboard();
      assert.match(
        dashboardMonth.html,
        /<input[^>]*type="month"[^>]*aria-label="Select month"[^>]*\/>[\s]*<button[^>]*type="button"[^>]*aria-label="Open month picker"/,
        'rendered DashboardPage switches to explicit month picker control',
      );
    } finally {
      useAuthStore.setState(prevAuthForDashboard);
      Object.assign(useAuthStore.getInitialState(), prevAuthInitialForDashboard);
    }

    // 7. Issue #1515: KDS default view kanban, persisted view selection, and body pointer-events recovery
    const kdsHeaderModule = require('../frontend/src/components/kds/KdsHeader');
    const OriginalKdsHeader = kdsHeaderModule.KdsHeader;
    let capturedOnChangeView: ((mode: 'tabs' | 'kanban') => void) | undefined;
    kdsHeaderModule.KdsHeader = function SpiedKdsHeader(props: any) {
      capturedOnChangeView = props.onChangeView;
      return OriginalKdsHeader(props);
    };
    const { KdsWorkspace } = require('../frontend/src/components/kds/KdsWorkspace');
    const persistedViews: Array<'tabs' | 'kanban'> = [];
    const baseKdsConn = {
      user: { id: 'chef-1', name: 'Chef Alex', role: 'chef' },
      orders: [],
      loading: false,
      connected: true,
      connectionMode: 'websocket' as const,
      email: '',
      setEmail: () => {},
      password: '',
      setPassword: () => {},
      loginError: '',
      loginLoading: false,
      updating: null,
      handleLogin: async () => {},
      handleLogout: async () => {},
      updateItemStatus: async () => true,
      persistViewMode: (view: 'tabs' | 'kanban') => {
        persistedViews.push(view);
      },
      ConfirmDialog: null,
    };
    try {
      const defaultKdsMarkup = renderWithIntl(
        React.createElement(KdsWorkspace, { conn: baseKdsConn, serverDefault: null }),
      );
      assert.match(
        defaultKdsMarkup,
        /<button[^>]*aria-pressed="false"[^>]*>Tabs<\/button><button[^>]*aria-pressed="true"[^>]*>Kanban<\/button>/,
        'rendered KdsWorkspace defaults to Kanban when serverDefault is null',
      );
      assert.match(
        defaultKdsMarkup,
        />Waiting<\/span>[\s\S]*?>Preparing<\/span>[\s\S]*?>Ready<\/span>[\s\S]*?>Delivered<\/span>/,
        'rendered KdsWorkspace mounts KdsKanbanBoard columns by default',
      );

      const waitingKdsMarkup = renderWithIntl(
        React.createElement(KdsWorkspace, {
          conn: {
            ...baseKdsConn,
            orders: [
              {
                id: 77,
                order_number: 'ORD-077',
                type: 'dine_in',
                created_at: '2026-11-08 15:00:00',
                items: [
                  {
                    id: 701,
                    order_id: 77,
                    product_id: 'prod-1',
                    product_name: 'Espresso',
                    quantity: 1,
                    status: 'pending',
                  },
                ],
              },
            ],
          },
          serverDefault: null,
        }),
      );
      assert.match(
        waitingKdsMarkup,
        /<div[^>]*class="[^"]*bg-yellow-50 dark:bg-yellow-950\/60[^"]*"[^>]*>[\s\S]*?ORD-077/,
        'waiting KDS cards use a dark-mode background in rendered KdsWorkspace output',
      );
      assert.match(
        waitingKdsMarkup,
        /<span class="text-base font-semibold text-yellow-800 dark:text-yellow-200">Waiting<\/span>/,
        'waiting KDS labels use dark-mode text in rendered KdsWorkspace output',
      );

      const tabsKdsMarkup = renderWithIntl(
        React.createElement(KdsWorkspace, { conn: baseKdsConn, serverDefault: 'tabs' }),
      );
      assert.match(
        tabsKdsMarkup,
        /<button[^>]*aria-pressed="true"[^>]*>Tabs<\/button><button[^>]*aria-pressed="false"[^>]*>Kanban<\/button>/,
        'rendered KdsWorkspace renders Tabs view when serverDefault is tabs',
      );

      const origWindow = (globalThis as any).window;
      const storage = new Map<string, string>();
      const dispatchedEvents: string[] = [];
      try {
        (globalThis as any).window = {
          localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => {
              storage.set(key, value);
            },
          },
          dispatchEvent: (event: Event) => {
            dispatchedEvents.push(event.type);
            return true;
          },
        };
        assert.equal(typeof capturedOnChangeView, 'function', 'KdsWorkspace wires onChangeView');
        capturedOnChangeView!('tabs');
        assert.equal(
          storage.get('kds_view_override'),
          'tabs',
          'changing KDS view writes kds_view_override to localStorage',
        );
        assert.deepEqual(
          dispatchedEvents,
          ['kds_view_override_changed'],
          'changing KDS view dispatches kds_view_override_changed',
        );
        assert.deepEqual(
          persistedViews,
          ['tabs'],
          'changing KDS view persists the selected view to backend via conn.persistViewMode',
        );
      } finally {
        if (origWindow === undefined) {
          delete (globalThis as any).window;
        } else {
          (globalThis as any).window = origWindow;
        }
      }
    } finally {
      kdsHeaderModule.KdsHeader = OriginalKdsHeader;
    }

    const { clearStaleBodyPointerEvents } = require('../frontend/src/hooks/use-confirm');
    (globalThis as any).document = {
      body: { style: { pointerEvents: 'none' } },
      querySelector: () => null,
    };
    clearStaleBodyPointerEvents();
    assert.equal(
      (globalThis as any).document.body.style.pointerEvents,
      '',
      'clearStaleBodyPointerEvents clears stuck body pointer-events: none when no modal is open',
    );
    for (const openSlot of [
      'dialog-content',
      'dropdown-menu-content',
      'sheet-content',
      'drawer-content',
    ]) {
      (globalThis as any).document = {
        body: { style: { pointerEvents: 'none' } },
        querySelector: (selector: string) =>
          selector.includes(`[data-slot="${openSlot}"][data-state="open"]`)
            ? { nodeName: 'DIV' }
            : null,
      };
      clearStaleBodyPointerEvents();
      assert.equal(
        (globalThis as any).document.body.style.pointerEvents,
        'none',
        `clearStaleBodyPointerEvents preserves body pointer-events: none while ${openSlot} is open`,
      );
    }

    useCartStore.getState().clearCart();

    const ServerStandalonePage = require('../frontend/src/app/server-standalone/page').default;
    const axiosMod = require(frontendRequire.resolve('axios'));
    const axiosInstance = axiosMod?.default ?? axiosMod;
    const verifyServerStandaloneBrandSurface = async () => {
      const serverStates: unknown[] = [];
      const serverRefs: Array<{ current: unknown }> = [];
      const serverEffectEntries: Array<{
        deps: unknown[] | undefined;
        initialized: boolean;
        cleanup?: (() => void) | void;
      }> = [];
      const serverPendingEffects: Array<() => void> = [];
      const origUseState = React.useState;
      const origUseRef = React.useRef;
      const origUseEffect = React.useEffect;
      const origUseCallback = React.useCallback;
      const origUseMemo = React.useMemo;
      const origAxiosCreate = axiosInstance.create;
      const prevWindow = (globalThis as any).window;
      const prevLocalStorage = (globalThis as any).localStorage;
      const prevFetch = (globalThis as any).fetch;
      const prevDoc = (globalThis as any).document;
      const storageStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      try {
        (globalThis as any).localStorage = storageStub;
        (globalThis as any).window = {
          location: { origin: 'http://localhost:3003' },
          localStorage: storageStub,
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        (globalThis as any).document = {
          body: { style: {} },
          documentElement: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } },
          querySelector: () => null,
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        (globalThis as any).fetch = async () => ({
          ok: false,
          status: 404,
          json: async () => ({}),
        });
        axiosInstance.create = () => ({
          interceptors: { request: { use: () => {} }, response: { use: () => {} } },
          get: async (url: string) => {
            if (url === '/api/server-app/info') {
              return { data: { country: 'US', currency: 'USD' } };
            }
            if (url === '/api/auth/pin-users') {
              return { data: { users: [{ id: 'u1', name: 'Alex', role: 'server' }] } };
            }
            const err: any = new Error('Unauthorized');
            err.response = { status: 401 };
            throw err;
          },
          post: async () => ({ data: {} }),
        });

        const renderServerStandalone = () => {
          let tree: any;
          function Runner() {
            let stateIdx = 0;
            let refIdx = 0;
            let effectIdx = 0;
            React.useState = ((initial: unknown) => {
              const idx = stateIdx++;
              if (!(idx in serverStates)) {
                serverStates[idx] =
                  typeof initial === 'function' ? (initial as () => unknown)() : initial;
              }
              const setState = (next: unknown) => {
                serverStates[idx] =
                  typeof next === 'function'
                    ? (next as (prev: unknown) => unknown)(serverStates[idx])
                    : next;
              };
              return [serverStates[idx], setState];
            }) as typeof React.useState;
            React.useRef = ((initial: unknown) => {
              const idx = refIdx++;
              if (!serverRefs[idx]) serverRefs[idx] = { current: initial };
              return serverRefs[idx];
            }) as typeof React.useRef;
            React.useEffect = ((effect: () => void | (() => void), deps?: unknown[]) => {
              const idx = effectIdx++;
              const prev = serverEffectEntries[idx];
              const changed =
                !prev ||
                !prev.initialized ||
                deps === undefined ||
                prev.deps === undefined ||
                deps.length !== prev.deps.length ||
                deps.some((d, i) => !Object.is(d, prev.deps![i]));
              if (!prev) serverEffectEntries[idx] = { deps, initialized: false };
              else prev.deps = deps;
              if (changed) {
                serverPendingEffects.push(() => {
                  if (typeof serverEffectEntries[idx].cleanup === 'function') {
                    serverEffectEntries[idx].cleanup!();
                  }
                  serverEffectEntries[idx].cleanup = effect();
                  serverEffectEntries[idx].initialized = true;
                });
              }
            }) as typeof React.useEffect;
            React.useCallback = ((fn: any) => fn) as typeof React.useCallback;
            React.useMemo = ((fn: () => unknown) => fn()) as typeof React.useMemo;
            try {
              tree = ServerStandalonePage({});
            } finally {
              React.useState = origUseState;
              React.useRef = origUseRef;
              React.useEffect = origUseEffect;
              React.useCallback = origUseCallback;
              React.useMemo = origUseMemo;
            }
            return tree;
          }
          const html = renderWithIntl(React.createElement(Runner));
          while (serverPendingEffects.length > 0) {
            serverPendingEffects.shift()!();
          }
          return { tree, html };
        };

        renderServerStandalone();
        await new Promise((r) => setTimeout(r, 0));
        renderServerStandalone();
        await new Promise((r) => setTimeout(r, 0));
        const serverLogin = renderServerStandalone();
        const serverTile = findTreeElement(
          serverLogin.tree,
          (el) => el?.props?.['data-testid'] === 'pin-user-tile-u1',
        );
        assert.ok(serverTile, 'rendered ServerStandalonePage exposes PIN user tile u1');
        serverTile.props.onClick();
        const serverSelected = renderServerStandalone();
        assert.match(
          serverSelected.html,
          /data-testid="pin-user-tile-u1"[^>]*class="[^"]*border-brand bg-brand-light dark:bg-\[var\(--color-brand-light\)\][^"]*"/,
          'rendered ServerStandalonePage selected PIN user tile pairs bg-brand-light with dark:bg-[var(--color-brand-light)]',
        );
        assert.doesNotMatch(
          serverSelected.html,
          /bg-brand-muted/,
          'rendered ServerStandalonePage never emits undefined bg-brand-muted',
        );
      } finally {
        for (const entry of serverEffectEntries) {
          if (typeof entry.cleanup === 'function') entry.cleanup();
        }
        React.useState = origUseState;
        React.useRef = origUseRef;
        React.useEffect = origUseEffect;
        React.useCallback = origUseCallback;
        React.useMemo = origUseMemo;
        axiosInstance.create = origAxiosCreate;
        if (prevWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = prevWindow;
        if (prevLocalStorage === undefined) delete (globalThis as any).localStorage;
        else (globalThis as any).localStorage = prevLocalStorage;
        if (prevFetch === undefined) delete (globalThis as any).fetch;
        else (globalThis as any).fetch = prevFetch;
        if (prevDoc === undefined) delete (globalThis as any).document;
        else (globalThis as any).document = prevDoc;
      }
    };
    await verifyServerStandaloneBrandSurface();
    console.log('✓ UI regression guards for issues #621, #623, #625, #626, and #1453 passed');
  } finally {
    if (origDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = origDocument;
    }
    Module._resolveFilename = originalResolveFilename;
    Module._load = originalLoad;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
