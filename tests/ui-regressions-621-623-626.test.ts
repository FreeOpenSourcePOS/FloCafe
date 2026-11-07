/**
 * Source-level guards for the UI regressions fixed by issues #621, #623, and #626.
 * Behavioral table update coverage lives in tables-string-ids.test.ts; these checks
 * keep the responsive layout and dark-mode utilities from being accidentally removed.
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

const kds = source('frontend/src/hooks/useKdsConnection.ts');
assert.match(
  kds,
  /bg-yellow-50 dark:bg-yellow-950\/60/,
  'waiting KDS cards use a dark-mode background',
);
assert.match(kds, /text-yellow-700 dark:text-yellow-300/, 'waiting KDS labels use dark-mode text');

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

const payment = source('frontend/src/components/pos/PaymentModal.tsx');
assert.match(payment, /sm:max-w-4xl/, 'desktop payment modal stays wide');
assert.match(payment, /lg:grid lg:grid-cols-2/, 'desktop payment content stays side by side');
assert.match(
  payment,
  /max-h-\[75vh\] overflow-y-auto.*lg:grid lg:grid-cols-2/,
  'desktop payment stays two-column with bounded overflow fallback',
);
assert.doesNotMatch(
  payment,
  /lg:overflow-visible/,
  'desktop payment does not clip controls outside its bounded container',
);

const dashboard = source('frontend/src/app/(dashboard)/dashboard/page.tsx');
assert.match(
  dashboard,
  /dayInputRef.*monthInputRef/s,
  'dashboard retains explicit date and month picker controls',
);
assert.match(
  dashboard,
  /input\.showPicker\(\)/,
  'dashboard calendar buttons invoke the native Chromium picker',
);
assert.match(
  dashboard,
  /aria-label=\{t\('openDatePicker'\)\}/,
  'dashboard date picker trigger stays accessible',
);

const prepaidCheckout = source('frontend/src/components/pos/PrepaidCheckoutModal.tsx');
assert.doesNotMatch(
  prepaidCheckout,
  /bg-gradient-to-br from-slate-800 to-slate-900/,
  'prepaid checkout does not restore the oversized total card',
);
assert.match(
  prepaidCheckout,
  /preview\.discountedSubtotal/,
  'prepaid checkout shows the post-discount subtotal',
);
assert.match(
  prepaidCheckout,
  /t\('discounts'\)/,
  'prepaid checkout retains the compact cart-level discounts control',
);
const numberPadIndex = prepaidCheckout.indexOf('<CurrencyTouchNumberPad');
const changeReturnedIndex = prepaidCheckout.indexOf("t('changeReturned')");
assert.ok(
  numberPadIndex >= 0 && changeReturnedIndex > numberPadIndex,
  'change returned stays below the payment controls',
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

  // 3. Parsed CSS AST check on globals.css for Electron no-drag rules
  const cssAst = postcss.parse(source('frontend/src/app/globals.css'));
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
    /<div class="flex flex-wrap gap-2"><button[^>]*class="[^"]*shrink-0 px-3"[^>]*>[\s\S]*?<span class="truncate">Hold<\/span>[\s\S]*?<button[^>]*class="[^"]*flex-1 min-w-0 px-3"[^>]*><span class="truncate">Place Order<\/span>/,
    'rendered CartPanel footer keeps Hold compact (shrink-0 px-3) and gives Place Order the remaining width (flex-1 min-w-0 px-3)',
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

  useCartStore.getState().clearCart();
} finally {
  if (origDocument === undefined) {
    delete (globalThis as any).document;
  } else {
    (globalThis as any).document = origDocument;
  }
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
}

console.log('✓ UI regression guards for issues #621, #623, #625, #626, and #1453 passed');
