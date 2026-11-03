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

// Issue #1453: POS drawers and side sheets must offset below the 40px desktop
// titlebar drag region (--flo-sidebar-block-start) and declare no-drag so the
// top-right close X button's full 44x44 touch target stays clickable in Electron.
const scheduledDrawer = source('frontend/src/components/pos/ScheduledOrdersDrawer.tsx');
assert.match(
  scheduledDrawer,
  /data-testid="scheduled-orders-drawer"\s+className="fixed inset-x-0 bottom-0 top-\[var\(--flo-sidebar-block-start,0px\)\] z-50 flex justify-end bg-black\/50"/,
  'ScheduledOrdersDrawer offsets below the desktop titlebar',
);
assert.match(
  scheduledDrawer,
  /data-testid="close-scheduled-drawer-btn"[\s\S]*?className="touch-target shrink-0 cursor-pointer rounded-full/,
  'ScheduledOrdersDrawer close button exposes close-scheduled-drawer-btn with a non-shrinking touch target',
);

const paymentQueueDrawer = source('frontend/src/components/pos/PaymentQueueDrawer.tsx');
assert.match(
  paymentQueueDrawer,
  /data-testid="payment-queue-drawer"\s+className="fixed inset-x-0 bottom-0 top-\[var\(--flo-sidebar-block-start,0px\)\] z-50 flex justify-end bg-black\/50"/,
  'PaymentQueueDrawer offsets below the desktop titlebar',
);
assert.match(
  paymentQueueDrawer,
  /data-testid="close-queue-drawer-btn"[\s\S]*?className="touch-target shrink-0 cursor-pointer rounded-full/,
  'PaymentQueueDrawer close button retains close-queue-drawer-btn with a non-shrinking touch target',
);

const sheetUi = source('frontend/src/components/ui/sheet.tsx');
assert.match(
  sheetUi,
  /side === ['"]right['"][\s\S]*?top-\[var\(--flo-sidebar-block-start,0px\)\] bottom-0 end-0 h-\[calc\(100%-var\(--flo-sidebar-block-start,0px\)\)\]/,
  'SheetContent right side offsets below the desktop titlebar',
);
assert.match(
  sheetUi,
  /side === ['"]left['"][\s\S]*?top-\[var\(--flo-sidebar-block-start,0px\)\] bottom-0 start-0 h-\[calc\(100%-var\(--flo-sidebar-block-start,0px\)\)\]/,
  'SheetContent left side offsets below the desktop titlebar',
);
assert.match(
  sheetUi,
  /side === ['"]top['"][\s\S]*?top-\[var\(--flo-sidebar-block-start,0px\)\]/,
  'SheetContent top side offsets below the desktop titlebar',
);

const drawerUi = source('frontend/src/components/ui/drawer.tsx');
assert.match(
  drawerUi,
  /data-\[vaul-drawer-direction=right\]:top-\[var\(--flo-sidebar-block-start,0px\)\] data-\[vaul-drawer-direction=right\]:bottom-0/,
  'DrawerContent right direction offsets below the desktop titlebar',
);
assert.match(
  drawerUi,
  /data-\[vaul-drawer-direction=left\]:top-\[var\(--flo-sidebar-block-start,0px\)\] data-\[vaul-drawer-direction=left\]:bottom-0/,
  'DrawerContent left direction offsets below the desktop titlebar',
);
assert.match(
  drawerUi,
  /data-\[vaul-drawer-direction=top\]:top-\[var\(--flo-sidebar-block-start,0px\)\]/,
  'DrawerContent top direction offsets below the desktop titlebar',
);

const globalsCss = source('frontend/src/app/globals.css');
assert.match(
  globalsCss,
  /\[data-testid='scheduled-orders-drawer'\],[\s\S]*?\[data-testid='payment-queue-drawer'\],[\s\S]*?\[data-slot='sheet-overlay'\],[\s\S]*?\[data-slot='sheet-content'\],[\s\S]*?\[data-slot='drawer-overlay'\],[\s\S]*?\[data-slot='drawer-content'\],[\s\S]*?\[role='dialog'\]\s*\{\s*-webkit-app-region:\s*no-drag;\s*app-region:\s*no-drag;\s*\}/,
  'globals.css marks modal and drawer overlays as no-drag in Electron',
);

const cartPanel = source('frontend/src/components/pos/CartPanel.tsx');
assert.match(
  cartPanel,
  /<div className="flex items-center justify-between gap-2">\s*<button\s+type="button"\s+data-testid="cart-item-remove-btn"[\s\S]*?className="relative touch-target h-6 w-6 min-h-6 min-w-6 shrink-0 rounded-md text-red-500 dark:text-red-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950\/40 dark:hover:text-red-300 active:bg-red-100 dark:active:bg-red-950\/60"[\s\S]*?<Trash2 size=\{13\} \/>\s*<\/button>\s*<p className="min-w-0 flex-1 break-words text-sm font-medium leading-snug text-foreground">/,
  'CartPanel places the red Trash2 delete button at the inline-start of the item name on row 1',
);
assert.doesNotMatch(
  cartPanel,
  /order-last[^"]*touch-target/,
  'CartPanel does not leave the delete button next to the quantity stepper on row 2',
);
assert.match(
  cartPanel,
  /<div className="flex flex-wrap gap-2">[\s\S]*?className="flex-1 min-w-0 px-3"[\s\S]*?<span className="truncate">/,
  'CartPanel footer buttons wrap and truncate to prevent horizontal overflow',
);

const posTopbar = source('frontend/src/components/pos/PosTopbar.tsx');
assert.match(
  posTopbar,
  /className="flex flex-col gap-1\.5 border-b bg-card shrink-0 px-3 py-2 sm:px-4 sm:py-2\.5"/,
  'PosTopbar adds a 6px gap between the linked customer bar and CustomerTopItems bubbles',
);

const customerSearch = source('frontend/src/components/pos/CustomerSearch.tsx');
assert.match(
  customerSearch,
  /isTopbar \? 'w-full min-w-0 sm:max-w-72 md:max-w-80' : 'w-full'/,
  'CustomerSearch widens the POS topbar search field so the placeholder is visible',
);

const inventoryPage = source('frontend/src/app/(dashboard)/inventory/page.tsx');
assert.match(
  inventoryPage,
  /<div className="mb-6 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-3">/,
  'Inventory header preserves min-h-9 across tabs so Movements does not shift vertically',
);
assert.equal(
  (
    inventoryPage.match(
      /className="w-full rounded-lg border border-border bg-card py-2 ps-9 pe-9 text-sm outline-none focus:ring-2 focus:ring-brand"/g,
    ) ?? []
  ).length,
  3,
  'All three Inventory tab search inputs match the sleek Products search input styling',
);

assert.match(
  customers,
  /<div className="relative mb-4 w-full shrink-0 sm:max-w-xs">\s*<Search\s+size=\{16\}\s+className="pointer-events-none absolute start-3 top-1\/2 -translate-y-1\/2 text-muted-foreground"\s*\/>\s*<input[\s\S]*?className="w-full rounded-lg border border-border bg-card py-2 ps-9 pe-9 text-sm outline-none focus:ring-2 focus:ring-brand"/,
  'Customers search input matches the sleek Products search input styling',
);

const ordersPage = source('frontend/src/app/(dashboard)/orders/page.tsx');
assert.match(
  ordersPage,
  /<div className="relative w-full sm:max-w-xs">\s*<Search\s+size=\{16\}\s+className="pointer-events-none absolute start-3 top-1\/2 -translate-y-1\/2 text-muted-foreground"\s*\/>\s*<input[\s\S]*?className="w-full rounded-lg border border-border bg-card py-2 ps-9 pe-9 text-sm outline-none focus:ring-2 focus:ring-brand"/,
  'Orders filter bar search input matches the sleek Products search input styling',
);

const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
};
const frontendRequire = Module.createRequire(resolve(process.cwd(), 'frontend/package.json'));
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === '@countries') {
    resolvedRequest = resolve(process.cwd(), 'main/countries.ts');
  } else if (request.startsWith('@/')) {
    resolvedRequest = resolve(process.cwd(), 'frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = resolve(process.cwd(), 'shared/print', request.slice('@print/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

try {
  const React = frontendRequire('react');
  const ReactDOMServer = frontendRequire('react-dom/server');
  const { IntlProvider } = frontendRequire('use-intl');
  const enMessages = require('../frontend/src/lib/i18n/messages/en.json');
  const ScheduledOrdersDrawer =
    require('../frontend/src/components/pos/ScheduledOrdersDrawer').default;
  const { PaymentQueueDrawer } = require('../frontend/src/components/pos/PaymentQueueDrawer');

  const scheduledMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      IntlProvider,
      { locale: 'en', messages: enMessages, timeZone: 'UTC' },
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
    ),
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

  const paymentQueueMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      IntlProvider,
      { locale: 'en', messages: enMessages, timeZone: 'UTC' },
      React.createElement(PaymentQueueDrawer, {
        open: true,
        onClose: () => {},
        onSelectOrderForPayment: () => {},
      }),
    ),
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
} finally {
  Module._resolveFilename = originalResolveFilename;
}

console.log('✓ UI regression guards for issues #621, #623, #625, #626, and #1453 passed');
