import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLoadedOrderPages, matchesOrderSearch } from '../frontend/src/lib/orders-search';

const order = (overrides = {}) => ({
  order_number: 'A-1024',
  customer: { name: 'Anita Sharma', phone: '+919876543210' },
  ...overrides,
});

test('matches order number (existing behavior)', () => {
  assert.equal(matchesOrderSearch(order(), 'a-102'), true);
});

test('matches customer name case-insensitively', () => {
  assert.equal(matchesOrderSearch(order(), 'anita'), true);
  assert.equal(matchesOrderSearch(order(), 'SHARMA'), true);
});

test('matches phone digits ignoring formatting', () => {
  assert.equal(matchesOrderSearch(order(), '+91 98765'), true);
  assert.equal(matchesOrderSearch(order(), '987-654-3210'), true);
});

test('no match returns false', () => {
  assert.equal(matchesOrderSearch(order(), 'zzz'), false);
});

test('order without customer does not crash', () => {
  assert.equal(matchesOrderSearch(order({ customer: null }), 'anita'), false);
  assert.equal(matchesOrderSearch(order({ customer: null }), 'a-102'), true);
});

test('mixed name+digit query does not fall back to phone matching', () => {
  assert.equal(matchesOrderSearch(order(), 'Alice 2'), false);
});

test('empty query matches everything', () => {
  assert.equal(matchesOrderSearch(order(), ''), true);
  assert.equal(matchesOrderSearch(order(), '   '), true);
});

test('refreshes the loaded search pages from current results', async () => {
  const cursors: Array<number | undefined> = [];
  const refreshed = await fetchLoadedOrderPages(async (cursor) => {
    cursors.push(cursor);
    if (cursor === undefined) {
      return { orders: [{ id: 52, status: 'new' }], nextCursor: 50 };
    }
    return { orders: [{ id: 49, status: 'updated' }], nextCursor: null };
  }, 2);

  assert.deepEqual(cursors, [undefined, 50]);
  assert.deepEqual(refreshed.orders, [
    { id: 52, status: 'new' },
    { id: 49, status: 'updated' },
  ]);
  assert.equal(refreshed.nextCursor, null);
});

test('stops refreshing when the current results have no next page', async () => {
  let calls = 0;
  const refreshed = await fetchLoadedOrderPages(async () => {
    calls++;
    return { orders: [{ id: 52, status: 'new' }], nextCursor: null };
  }, 3);

  assert.equal(calls, 1);
  assert.deepEqual(refreshed.orders, [{ id: 52, status: 'new' }]);
});

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

test('OrdersPage renders Load More and fetches the next page when search is empty on non-held tabs only', async () => {
  const root = path.join(__dirname, '..');
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
    if (request.startsWith('@/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'frontend/src', request.slice(2)),
        parent,
        isMain,
        options,
      );
    }
    if (request === '@countries') {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'main/countries.ts'),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@print/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'shared/print', request.slice('@print/'.length)),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@shared/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'shared', request.slice('@shared/'.length)),
        parent,
        isMain,
        options,
      );
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  const reactHooks = {
    Suspense: 'Suspense',
    useState: (_initial: unknown): [unknown, (next: unknown) => void] => [
      undefined,
      () => undefined,
    ],
    useEffect: (_effect: () => unknown, _deps?: unknown[]) => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
    useMemo: <T>(fn: () => T): T => fn(),
  };

  const orderRequests: Array<Record<string, unknown>> = [];
  let pendingOrdersResponse: Promise<{ data: { orders: unknown[]; nextCursor: null } }> | null =
    null;
  const Icon = () => null;
  const setTablesRequired = () => undefined;
  const ButtonStub = (props: Record<string, unknown>) => ({ type: 'button', props });
  const MasterListStub = (props: Record<string, unknown>) => ({ type: 'OrdersMasterList', props });
  const jsxElement = (type: unknown, props: Record<string, unknown>, key?: unknown) => ({
    type,
    props,
    key,
  });

  const mocks: Record<string, unknown> = {
    react: reactHooks,
    'react/jsx-runtime': {
      jsx: jsxElement,
      jsxs: jsxElement,
      Fragment: 'Fragment',
    },
    'use-intl': {
      useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
      useLocale: () => 'en',
    },
    'next/navigation': {
      useRouter: () => ({ push: () => undefined }),
      useSearchParams: () => new URLSearchParams(),
    },
    'react-hot-toast': {
      __esModule: true,
      default: { success: () => undefined, error: () => undefined },
    },
    'lucide-react': {
      Trash2: Icon,
      Printer: Icon,
      Percent: Icon,
      Banknote: Icon,
      Search: Icon,
      Plus: Icon,
      Loader2: Icon,
      Download: Icon,
    },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: async (url: string, config?: { params?: Record<string, unknown> }) => {
          if (url === '/orders') {
            const params = config?.params ?? {};
            orderRequests.push(params);
            if (pendingOrdersResponse) return pendingOrdersResponse;
            if (params.before_id === 55) {
              return {
                data: {
                  orders: [
                    {
                      id: 54,
                      order_number: 'ORD-054',
                      status: 'preparing',
                      type: 'takeaway',
                      subtotal: 15,
                      total: 15,
                      created_at: '2026-01-01 00:00:00',
                      items: [],
                    },
                  ],
                  nextCursor: null,
                },
              };
            }
            return {
              data: {
                orders: [
                  {
                    id: 101,
                    order_number: 'ORD-101',
                    status: 'preparing',
                    type: 'takeaway',
                    subtotal: 25,
                    total: 25,
                    created_at: '2026-01-02 00:00:00',
                    items: [],
                  },
                ],
                nextCursor: 55,
              },
            };
          }
          if (url === '/settings/business') return { data: { tables_required: false } };
          if (url === '/settings/discount')
            return { data: { discount_mode: 'percentage', discount_requires_approval: false } };
          if (url === '/settings/kds_enabled') return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
      },
      captureClientOperationFailure: async () => undefined,
      createOperationReference: () => 'op-ref',
      operationHeaders: () => ({}),
    },
    '@/store/auth': {
      useAuthStore: () => ({
        currentTenant: { id: 't-1', country: 'US', currency: 'USD', role: 'owner' },
        user: { id: 'u-1', name: 'Owner' },
      }),
    },
    '@/store/held-orders': {
      useHeldOrdersStore: () => ({
        orders: {},
        fetchHeldOrders: async () => undefined,
        restoreOrder: async () => null,
        removeHeldOrder: async () => false,
      }),
    },
    '@/store/cart': {
      useCartStore: () => ({
        items: [],
        clearCart: () => undefined,
        setCustomer: () => undefined,
        setOrderType: () => undefined,
        setTableId: () => undefined,
        setDeliveryAddress: () => undefined,
        loadItems: () => undefined,
      }),
    },
    '@/store/pos-settings': {
      usePosSettingsStore: () => ({
        setTablesRequired,
        autoPrintBill: false,
        printerUseUnicode: true,
        printerArabicShaping: false,
      }),
    },
    '@/hooks/usePrinter': {
      usePrinterStore: () => ({
        printBill: async () => ({ success: true }),
        printDeliverySlip: async () => ({ success: true }),
      }),
    },
    '@/hooks/use-confirm': {
      useConfirm: () => ({
        confirm: async () => true,
        ConfirmDialog: () => null,
      }),
    },
    '@/hooks/useCurrencyUnitAdapter': {
      useCurrencyUnitAdapter: () => ({ maxDecimals: 2 }),
    },
    '@/hooks/useFormatCurrency': {
      useFormatCurrency: () => (v: number) => `$${v}`,
    },
    '@/hooks/useFormatDate': {
      useFormatDate: () => ({ formatTime: () => '12:00' }),
    },
    '@/hooks/useWhatsAppReady': {
      useWhatsAppReady: () => false,
    },
    '@/hooks/useOrdersLayout': {
      useOrdersLayoutPreference: () => ({ layout: 'split' }),
    },
    '@/components/ui/button': { Button: ButtonStub },
    '@/components/layout/Ltr': { Ltr: ({ children }: { children: unknown }) => children },
    '@/components/pos/PaymentModal': { __esModule: true, default: () => null },
    '@/components/pos/CreateCustomerModal': { __esModule: true, default: () => null },
    '@/components/pos/AddonModal': { __esModule: true, default: () => null },
    '@/components/orders/RefundModal': { __esModule: true, default: () => null },
    '@/components/orders/PriceOverrideModal': { PriceOverrideModal: () => null },
    '@/lib/countries': {
      getCurrencySymbol: () => '$',
      getCountryByCode: () => ({ locale: 'en-US' }),
    },
    '@/lib/whatsapp-share': {
      sendBillViaFlo: async () => undefined,
    },
    '@/lib/printer/warnings-toast': {
      showPrintWarningsToast: () => undefined,
    },
    '@/lib/printer/warnings': {
      formatReceiptErrorToast: () => '',
      extractPrinterErrorMessage: () => '',
    },
    '@/lib/utils': { cn: (...args: unknown[]) => args.filter(Boolean).join(' ') },
    '@/components/orders/OrderCard': { OrderCard: () => null },
    '@/components/orders/OrdersMasterList': { OrdersMasterList: MasterListStub },
    '@/components/orders/OrderDetailPanel': { OrderDetailPanel: () => null },
  };

  moduleApi._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const states: unknown[] = [];
    const refs: Array<{ current: unknown }> = [];
    const effects: Array<() => unknown> = [];
    let effectsCollected = false;

    const renderPage = (OrdersPage: () => unknown) => {
      let stateIndex = 0;
      let refIndex = 0;
      reactHooks.useState = (initial: unknown) => {
        const idx = stateIndex++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        const setState = (next: unknown) => {
          states[idx] =
            typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
        };
        return [states[idx], setState];
      };
      reactHooks.useRef = (initial: unknown) => {
        const idx = refIndex++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      };
      reactHooks.useEffect = (effect: () => unknown) => {
        if (!effectsCollected) effects.push(effect);
        return undefined;
      };

      const tree = OrdersPage();
      effectsCollected = true;
      return tree;
    };

    const OrdersPage = require('../frontend/src/app/(dashboard)/orders/page').default;
    renderPage(OrdersPage);

    const cleanups = effects.map((effect) => effect());
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));

      const findLoadMore = (tree: unknown) =>
        collectElements(
          tree,
          (el) => el.type === ButtonStub && el.props?.children === 'common.loadMore',
        )[0];

      const page1Tree = renderPage(OrdersPage);
      const searchInput = collectElements(
        page1Tree,
        (el) => el.type === 'input' && el.props?.placeholder === 'orders.search',
      )[0];
      assert.equal(searchInput?.props?.value, '', 'search input starts empty');

      const loadMoreOnActive = findLoadMore(page1Tree);
      assert.ok(
        loadMoreOnActive,
        'Load More button renders when nextOrdersCursor is non-null and search is empty',
      );

      // Switching to the Held tab hides Load More even while nextOrdersCursor is non-null.
      const heldTabButton = collectElements(
        page1Tree,
        (el) =>
          el.type === 'button' &&
          collectElements(el, (c) => c.type === 'span' && c.props?.children === 'orders.held')
            .length > 0,
      )[0];
      assert.ok(heldTabButton, 'Held tab button exists');
      heldTabButton.props.onClick();

      const heldTree = renderPage(OrdersPage);
      assert.equal(
        findLoadMore(heldTree),
        undefined,
        'Load More button stays hidden on the held tab',
      );
      const heldRecovery = collectElements(
        page1Tree,
        (el) => typeof el.props?.onItemEditResolved === 'function',
      )[0];
      assert.equal(
        await heldRecovery.props.onItemEditResolved(101),
        false,
        'a skipped held-tab refresh does not report fresh order data',
      );

      // Switching back to a non-held tab restores Load More and clicking it fetches the next page.
      const allTabButton = collectElements(
        heldTree,
        (el) =>
          el.type === 'button' &&
          collectElements(el, (c) => c.type === 'span' && c.props?.children === 'orders.all')
            .length > 0,
      )[0];
      assert.ok(allTabButton, 'All tab button exists');
      allTabButton.props.onClick();

      const nonHeldTree = renderPage(OrdersPage);
      const loadMoreToClick = findLoadMore(nonHeldTree);
      assert.ok(loadMoreToClick, 'Load More button renders on non-held tab');

      await loadMoreToClick.props.onClick();

      assert.deepEqual(
        orderRequests,
        [
          { per_page: 15, view: 'active' },
          { per_page: 15, view: 'all', before_id: 55 },
        ],
        'clicking Load More fetches the next filtered page using nextOrdersCursor',
      );

      const page2Tree = renderPage(OrdersPage);
      const masterList = collectElements(page2Tree, (el) => el.type === MasterListStub)[0];
      assert.deepEqual(
        masterList?.props?.orders?.map((o: { order_number: string }) => o.order_number),
        ['ORD-101', 'ORD-054'],
        'the second page of orders is appended to the list',
      );
      assert.equal(
        findLoadMore(page2Tree),
        undefined,
        'Load More button is hidden once nextOrdersCursor is null',
      );
      const recovery = collectElements(
        page2Tree,
        (el) => typeof el.props?.onItemEditResolved === 'function',
      )[0];
      let release!: (response: { data: { orders: unknown[]; nextCursor: null } }) => void;
      pendingOrdersResponse = new Promise((resolve) => {
        release = resolve;
      });
      const activeRefresh = recovery.props.onItemEditResolved(101);
      assert.equal(
        await recovery.props.onItemEditResolved(101),
        false,
        'a coalesced refresh cannot report success before the active request finishes',
      );
      pendingOrdersResponse = null;
      release({ data: { orders: [], nextCursor: null } });
      assert.equal(await activeRefresh, true, 'a completed fresh list request reports success');
    } finally {
      for (const cleanup of cleanups) {
        if (typeof cleanup === 'function') cleanup();
      }
    }
  } finally {
    moduleApi._load = originalLoad;
    moduleApi._resolveFilename = originalResolveFilename;
  }
});

test('FloorplanEditor View order navigates to /orders?table=<id> and OrdersPage syncs ?table= into filters.table without overwriting manual dropdown changes', async () => {
  const root = path.join(__dirname, '..');
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
    if (request.startsWith('@/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'frontend/src', request.slice(2)),
        parent,
        isMain,
        options,
      );
    }
    if (request === '@countries') {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'main/countries.ts'),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@print/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'shared/print', request.slice('@print/'.length)),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@shared/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'shared', request.slice('@shared/'.length)),
        parent,
        isMain,
        options,
      );
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  const reactHooks = {
    Suspense: 'Suspense',
    useState: (_initial: unknown): [unknown, (next: unknown) => void] => [
      undefined,
      () => undefined,
    ],
    useEffect: (_effect: () => unknown, _deps?: unknown[]) => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
    useMemo: <T>(fn: () => T): T => fn(),
  };

  const pushedRoutes: string[] = [];
  let currentSearchParams = new URLSearchParams();
  let mockTablesRequired = false;
  const orderRequests: Array<Record<string, unknown>> = [];
  const Icon = () => null;
  const setTablesRequired = () => undefined;
  const ButtonStub = (props: Record<string, unknown>) => ({ type: 'button', props });
  const MasterListStub = (props: Record<string, unknown>) => ({ type: 'OrdersMasterList', props });
  const jsxElement = (type: unknown, props: Record<string, unknown>, key?: unknown) => ({
    type,
    props,
    key,
  });

  const mocks: Record<string, unknown> = {
    react: reactHooks,
    'react/jsx-runtime': {
      jsx: jsxElement,
      jsxs: jsxElement,
      Fragment: 'Fragment',
    },
    'use-intl': {
      useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
      useLocale: () => 'en',
    },
    'next/navigation': {
      useRouter: () => ({
        push: (href: string) => {
          pushedRoutes.push(href);
        },
      }),
      useSearchParams: () => currentSearchParams,
    },
    'react-hot-toast': {
      __esModule: true,
      default: { success: () => undefined, error: () => undefined },
    },
    'lucide-react': {
      ArrowRightLeft: Icon,
      Banknote: Icon,
      ChevronRight: Icon,
      Download: Icon,
      Eye: Icon,
      LayoutGrid: Icon,
      List: Icon,
      Loader2: Icon,
      MapPin: Icon,
      MapPinned: Icon,
      Maximize2: Icon,
      Minimize2: Icon,
      MoreHorizontal: Icon,
      Pencil: Icon,
      Percent: Icon,
      Plus: Icon,
      Printer: Icon,
      RotateCcw: Icon,
      Search: Icon,
      Sparkles: Icon,
      Table2: Icon,
      Trash2: Icon,
      UserPlus: Icon,
      Users: Icon,
      X: Icon,
    },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: async (url: string, config?: { params?: Record<string, unknown> }) => {
          if (url === '/orders') {
            orderRequests.push(config?.params ?? {});
            return { data: { orders: [], nextCursor: null } };
          }
          if (url === '/tables') {
            return {
              data: {
                tables: [
                  {
                    id: 'tbl-42',
                    name: 'T42',
                    capacity: 4,
                    status: 'occupied',
                    kitchen_station_id: null,
                    floor: 'Ground',
                    section: 'Main',
                    position_x: null,
                    position_y: null,
                  },
                  {
                    id: 'tbl-99',
                    name: 'T99',
                    capacity: 2,
                    status: 'available',
                    kitchen_station_id: null,
                    floor: 'Ground',
                    section: 'Main',
                    position_x: null,
                    position_y: null,
                  },
                ],
              },
            };
          }
          if (url === '/settings/business')
            return { data: { tables_required: mockTablesRequired } };
          if (url === '/settings/discount')
            return { data: { discount_mode: 'percentage', discount_requires_approval: false } };
          if (url === '/settings/kds_enabled') return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
      },
      captureClientOperationFailure: async () => undefined,
      createOperationReference: () => 'op-ref',
      operationHeaders: () => ({}),
    },
    '@/store/auth': {
      useAuthStore: () => ({
        currentTenant: { id: 't-1', country: 'US', currency: 'USD', role: 'owner' },
        user: { id: 'u-1', name: 'Owner' },
      }),
    },
    '@/store/held-orders': {
      useHeldOrdersStore: () => ({
        orders: {},
        fetchHeldOrders: async () => undefined,
        restoreOrder: async () => null,
        removeHeldOrder: async () => false,
      }),
    },
    '@/store/cart': {
      useCartStore: () => ({
        items: [],
        clearCart: () => undefined,
        setCustomer: () => undefined,
        setOrderType: () => undefined,
        setTableId: () => undefined,
        setDeliveryAddress: () => undefined,
        loadItems: () => undefined,
      }),
    },
    '@/store/pos-settings': {
      usePosSettingsStore: () => ({
        setTablesRequired,
        autoPrintBill: false,
        printerUseUnicode: true,
        printerArabicShaping: false,
      }),
    },
    '@/hooks/usePrinter': {
      usePrinterStore: () => ({
        printBill: async () => ({ success: true }),
        printDeliverySlip: async () => ({ success: true }),
      }),
    },
    '@/hooks/use-confirm': {
      useConfirm: () => ({
        confirm: async () => true,
        ConfirmDialog: () => null,
      }),
    },
    '@/hooks/useCurrencyUnitAdapter': {
      useCurrencyUnitAdapter: () => ({ maxDecimals: 2 }),
    },
    '@/hooks/useFormatCurrency': {
      useFormatCurrency: () => (v: number) => `$${v}`,
    },
    '@/hooks/useFormatDate': {
      useFormatDate: () => ({ formatTime: () => '12:00' }),
    },
    '@/hooks/useWhatsAppReady': {
      useWhatsAppReady: () => false,
    },
    '@/hooks/useOrdersLayout': {
      useOrdersLayoutPreference: () => ({ layout: 'split' }),
    },
    '@/components/ui/button': { Button: ButtonStub },
    '@/components/layout/Ltr': { Ltr: ({ children }: { children: unknown }) => children },
    '@/components/tables/TableTurnoverBadge': { TableTurnoverBadge: () => null },
    '@/components/tables/MoveTableModal': { __esModule: true, default: () => null },
    '@/components/pos/PaymentModal': { __esModule: true, default: () => null },
    '@/components/pos/CreateCustomerModal': { __esModule: true, default: () => null },
    '@/components/pos/AddonModal': { __esModule: true, default: () => null },
    '@/components/orders/RefundModal': { __esModule: true, default: () => null },
    '@/components/orders/PriceOverrideModal': { PriceOverrideModal: () => null },
    '@/lib/countries': {
      getCurrencySymbol: () => '$',
      getCountryByCode: () => ({ locale: 'en-US' }),
      countryName: () => 'United States',
    },
    '@/lib/whatsapp-share': {
      sendBillViaFlo: async () => undefined,
    },
    '@/lib/printer/warnings-toast': {
      showPrintWarningsToast: () => undefined,
    },
    '@/lib/printer/warnings': {
      formatReceiptErrorToast: () => '',
      extractPrinterErrorMessage: () => '',
    },
    '@/lib/utils': { cn: (...args: unknown[]) => args.filter(Boolean).join(' ') },
    '@/components/orders/OrderCard': { OrderCard: () => null },
    '@/components/orders/OrdersMasterList': { OrdersMasterList: MasterListStub },
    '@/components/orders/OrderDetailPanel': { OrderDetailPanel: () => null },
  };

  moduleApi._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[
      moduleApi._resolveFilename('../frontend/src/components/tables/FloorplanEditor', module, false)
    ];
    delete require.cache[
      moduleApi._resolveFilename('../frontend/src/app/(dashboard)/tables/page', module, false)
    ];
    delete require.cache[
      moduleApi._resolveFilename('../frontend/src/app/(dashboard)/orders/page', module, false)
    ];

    const FloorplanEditor = require('../frontend/src/components/tables/FloorplanEditor').default;
    const TablesPage = require('../frontend/src/app/(dashboard)/tables/page').default;
    const OrdersPage = require('../frontend/src/app/(dashboard)/orders/page').default;

    const createRenderer = () => {
      const states: unknown[] = [];
      const setters: Array<(next: unknown) => void> = [];
      const refs: Array<{ current: unknown }> = [];
      const effectEntries: Array<{
        deps: unknown[] | undefined;
        cleanup?: unknown;
        initialized: boolean;
      }> = [];
      const pendingEffects: Array<() => void> = [];

      const render = <P>(Component: (props: P) => unknown, props: P) => {
        let stateIndex = 0;
        let refIndex = 0;
        let effectIndex = 0;

        reactHooks.useState = (initial: unknown) => {
          const idx = stateIndex++;
          if (idx >= states.length) {
            states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
            setters.push((next: unknown) => {
              states[idx] =
                typeof next === 'function'
                  ? (next as (prev: unknown) => unknown)(states[idx])
                  : next;
            });
          }
          return [states[idx], setters[idx]];
        };
        reactHooks.useRef = (initial: unknown) => {
          const idx = refIndex++;
          if (idx >= refs.length) {
            refs.push({ current: initial });
          }
          return refs[idx];
        };
        reactHooks.useEffect = (effect: () => unknown, deps?: unknown[]) => {
          const idx = effectIndex++;
          const prev = effectEntries[idx];
          const changed =
            !prev ||
            !prev.initialized ||
            deps === undefined ||
            prev.deps === undefined ||
            deps.length !== prev.deps.length ||
            deps.some((d, i) => !Object.is(d, prev.deps![i]));
          if (!prev) {
            effectEntries[idx] = { deps, initialized: false };
          } else {
            prev.deps = deps;
          }
          if (changed) {
            pendingEffects.push(() => {
              const entry = effectEntries[idx];
              if (typeof entry.cleanup === 'function') entry.cleanup();
              entry.cleanup = effect();
              entry.initialized = true;
            });
          }
          return undefined;
        };

        return Component(props);
      };

      const flushEffects = () => {
        while (pendingEffects.length > 0) {
          const run = pendingEffects.shift()!;
          run();
        }
      };

      const cleanupAll = () => {
        for (const entry of effectEntries) {
          if (typeof entry?.cleanup === 'function') entry.cleanup();
        }
      };

      return { render, flushEffects, cleanupAll };
    };

    // 1. Verify TablesPage wires FloorplanEditor onViewOrder to /orders?table=<id>.
    const tablesRenderer = createRenderer();
    const floorplanRenderer = createRenderer();
    try {
      tablesRenderer.render(TablesPage, {});
      tablesRenderer.flushEffects();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const tablesTree = tablesRenderer.render(TablesPage, {});
      const floorplanEl = collectElements(tablesTree, (el) => el.type === FloorplanEditor)[0];
      assert.ok(floorplanEl, 'TablesPage renders FloorplanEditor');
      assert.equal(
        typeof floorplanEl.props.onViewOrder,
        'function',
        'TablesPage passes onViewOrder callback when orders.read is permitted',
      );

      const occupiedTable = {
        id: 'tbl-42',
        name: 'T42',
        capacity: 4,
        status: 'occupied' as const,
        kitchen_station_id: null,
        floor: 'Ground',
        section: 'Main',
        position_x: null,
        position_y: null,
      };

      const fpTree1 = floorplanRenderer.render(FloorplanEditor, {
        mode: 'service',
        canManage: false,
        tables: [occupiedTable],
        onViewOrder: floorplanEl.props.onViewOrder,
      });

      const tableChip = collectElements(
        fpTree1,
        (el) => el.props?.['data-testid'] === 'floorplan-tray-T42',
      )[0];
      assert.ok(tableChip, 'Occupied floorplan table chip renders in tray');
      tableChip.props.onClick();

      const fpTree2 = floorplanRenderer.render(FloorplanEditor, {
        mode: 'service',
        canManage: false,
        tables: [occupiedTable],
        onViewOrder: floorplanEl.props.onViewOrder,
      });

      const viewOrderBtn = collectElements(
        fpTree2,
        (el) =>
          el.type === 'button' &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes('tables.viewOrder'),
      )[0];
      assert.ok(viewOrderBtn, 'Action sheet renders View order button for occupied table');
      viewOrderBtn.props.onClick();

      assert.deepEqual(
        pushedRoutes,
        ['/orders?table=tbl-42'],
        'Clicking View order routes to /orders?table=<tableId>',
      );

      // Verify List View unified floor tab bar, Add Table Floor <select>, and FloorplanEditor Unassigned option.
      const listAddFloorBtn = collectElements(
        tablesTree,
        (el) => el.props?.['data-testid'] === 'list-add-floor',
      )[0];
      assert.ok(listAddFloorBtn, 'TablesPage List View renders + Add Floor button');
      const listFloorMenuBtn = collectElements(
        tablesTree,
        (el) => el.props?.['data-testid'] === 'list-floor-menu-Ground',
      )[0];
      assert.ok(listFloorMenuBtn, 'TablesPage List View renders floor actions menu trigger');

      const addTableBtn = collectElements(
        tablesTree,
        (el) =>
          (el.type === 'button' || el.type === ButtonStub) &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes('tables.addTable'),
      )[0];
      assert.ok(addTableBtn, 'TablesPage renders + Add Table button');
      addTableBtn.props.onClick();

      const modalTree = tablesRenderer.render(TablesPage, {});
      const floorSelect = collectElements(
        modalTree,
        (el) => el.type === 'select' && el.props?.id === 'floorplan-table-floor',
      )[0];
      assert.ok(floorSelect, 'TablesPage Add Table modal renders Floor <select>');
      const floorOptions = collectElements(floorSelect, (opt) => opt.type === 'option').map(
        (opt) => opt.props?.value,
      );
      assert.deepEqual(
        floorOptions,
        ['', 'Ground', '__new__'],
        'TablesPage Floor <select> includes Unassigned, existing floors, and + New Floor',
      );
      const sectionInput = collectElements(
        modalTree,
        (el) => el.type === 'input' && el.props?.id === 'table-form-section',
      );
      assert.equal(sectionInput.length, 0, 'New table modal omits legacy Section input');
    } finally {
      floorplanRenderer.cleanupAll();
      tablesRenderer.cleanupAll();
    }

    // Cover query sync and manual overrides with tables_required both enabled and disabled.
    for (const tablesRequired of [false, true]) {
      mockTablesRequired = tablesRequired;
      orderRequests.length = 0;
      currentSearchParams = new URLSearchParams('table=tbl-42');
      const ordersRenderer = createRenderer();
      try {
        const renderOrdersWithSync = () => {
          const tree = ordersRenderer.render(OrdersPage, {});
          const syncEl = collectElements(
            tree,
            (el) => typeof el.type === 'function' && el.type.name === 'OrdersTableQuerySync',
          )[0];
          assert.ok(syncEl, 'OrdersPage renders OrdersTableQuerySync inside Suspense');
          syncEl.type(syncEl.props);
          return tree;
        };

        renderOrdersWithSync();
        ordersRenderer.flushEffects();
        await new Promise((resolve) => setTimeout(resolve, 20));

        renderOrdersWithSync();
        ordersRenderer.flushEffects();
        await new Promise((resolve) => setTimeout(resolve, 350));

        const syncedTree = renderOrdersWithSync();
        ordersRenderer.flushEffects();

        const findTableSelect = (tree: unknown) =>
          collectElements(
            tree,
            (el) =>
              el.type === 'select' &&
              collectElements(
                el,
                (opt) => opt.type === 'option' && opt.props?.children === 'orders.allTables',
              ).length > 0,
          )[0];

        const tableSelect = findTableSelect(syncedTree);
        assert.ok(tableSelect, 'Table filter select dropdown renders');
        const optionValues = collectElements(tableSelect, (opt) => opt.type === 'option').map(
          (opt) => opt.props?.value,
        );
        assert.deepEqual(
          optionValues,
          ['', 'tbl-42', 'tbl-99'],
          `Table filter select populates table options when tables_required=${tablesRequired}`,
        );
        assert.equal(
          tableSelect.props.value,
          'tbl-42',
          `OrdersTableQuerySync syncs ?table=tbl-42 into filters.table when tables_required=${tablesRequired}`,
        );
        assert.ok(
          orderRequests.some((req) => req.table_id === 'tbl-42'),
          `OrdersPage fetches /orders filtered by table_id=tbl-42 when tables_required=${tablesRequired}`,
        );

        // Manually change the table dropdown to another table while ?table=tbl-42 stays in URL.
        tableSelect.props.onChange({ target: { value: 'tbl-99' } });
        renderOrdersWithSync();
        ordersRenderer.flushEffects();
        const afterManualSelectTree = renderOrdersWithSync();
        ordersRenderer.flushEffects();
        assert.equal(
          findTableSelect(afterManualSelectTree).props.value,
          'tbl-99',
          'Manual table filter change is not overwritten on re-render when ?table= is unchanged',
        );

        // Manually reset the table dropdown to All Tables ('') while ?table=tbl-42 stays in URL.
        findTableSelect(afterManualSelectTree).props.onChange({ target: { value: '' } });
        renderOrdersWithSync();
        ordersRenderer.flushEffects();
        const afterManualClearTree = renderOrdersWithSync();
        ordersRenderer.flushEffects();
        assert.equal(
          findTableSelect(afterManualClearTree).props.value,
          '',
          'Manual reset to All Tables is preserved on re-render when ?table= is unchanged',
        );

        // Select a table again, then navigate back to /orders (clearing ?table=), which resets filters.table to ''.
        findTableSelect(afterManualClearTree).props.onChange({ target: { value: 'tbl-99' } });
        currentSearchParams = new URLSearchParams();
        renderOrdersWithSync();
        ordersRenderer.flushEffects();
        const afterUrlClearTree = renderOrdersWithSync();
        ordersRenderer.flushEffects();
        assert.equal(
          findTableSelect(afterUrlClearTree).props.value,
          '',
          'Removing ?table= from the URL resets filters.table to All Tables',
        );

        // Manually selecting a table while on /orders (no ?table= in URL) is preserved on re-render.
        findTableSelect(afterUrlClearTree).props.onChange({ target: { value: 'tbl-99' } });
        renderOrdersWithSync();
        ordersRenderer.flushEffects();
        const afterManualSelectWithoutParamTree = renderOrdersWithSync();
        ordersRenderer.flushEffects();
        assert.equal(
          findTableSelect(afterManualSelectWithoutParamTree).props.value,
          'tbl-99',
          'Manual table filter selection is preserved on re-render when ?table= is absent',
        );
      } finally {
        ordersRenderer.cleanupAll();
      }
    }
  } finally {
    moduleApi._load = originalLoad;
    moduleApi._resolveFilename = originalResolveFilename;
  }
});

test('OrdersPage unified tabs, conditional table filter, clear filters, cross-tab search fallback, and snapshot print resolution', async () => {
  const root = path.join(__dirname, '..');
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
    if (request.startsWith('@/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'frontend/src', request.slice(2)),
        parent,
        isMain,
        options,
      );
    }
    if (request === '@countries') {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'main/countries.ts'),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@print/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'shared/print', request.slice('@print/'.length)),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@shared/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(root, 'shared', request.slice('@shared/'.length)),
        parent,
        isMain,
        options,
      );
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  const reactHooks = {
    Suspense: 'Suspense',
    useState: (_initial: unknown): [unknown, (next: unknown) => void] => [
      undefined,
      () => undefined,
    ],
    useEffect: (_effect: () => unknown, _deps?: unknown[]) => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
    useMemo: <T>(fn: () => T): T => fn(),
  };

  const orderRequests: Array<Record<string, unknown>> = [];
  const toastErrors: string[] = [];
  const printedBillIds: number[] = [];
  const printedReservedWindows: unknown[] = [];
  const printOrderStatuses: Array<string | undefined> = [];
  let activeTenant = { id: 't-1', country: 'US', currency: 'USD', role: 'owner' };
  let currentSearchParams = new URLSearchParams();
  let deferNextActiveFetch = false;
  let deferredActiveFetch: ((value: unknown) => void) | null = null;
  const order101 = {
    id: 101,
    order_number: 'ORD-101',
    status: 'pending',
    type: 'dine_in',
    table_id: 'tbl-42',
    subtotal: 20,
    total: 20,
    created_at: '2026-01-01 00:00:00',
    items: [],
  };
  const order103 = {
    id: 103,
    order_number: 'ORD-103',
    status: 'pending',
    type: 'dine_in',
    table_id: 'tbl-42',
    subtotal: 30,
    total: 30,
    created_at: '2026-01-01 00:02:00',
    items: [],
    bills: [
      {
        id: 701,
        order_id: 103,
        total: 15,
        balance: 15,
        payment_status: 'unpaid',
        split_group_id: 'sg-1',
      },
      {
        id: 702,
        order_id: 103,
        total: 15,
        balance: 15,
        payment_status: 'unpaid',
        split_group_id: 'sg-1',
      },
    ],
  };
  const order104 = {
    id: 104,
    order_number: 'ORD-104',
    status: 'pending',
    type: 'takeaway',
    scheduled_for: '2026-01-01 05:00:00',
    release_status: 'scheduled',
    subtotal: 25,
    total: 25,
    created_at: '2026-01-01 00:03:00',
    items: [],
    bill: { id: 801, order_id: 104, total: 25, balance: 25, payment_status: 'unpaid' },
  };
  const order105 = {
    id: 105,
    order_number: 'ORD-105',
    status: 'pending',
    type: 'dine_in',
    table_id: 'tbl-99',
    subtotal: 18,
    total: 18,
    created_at: '2026-01-01 00:04:00',
    items: [],
    bill: { id: 901, order_id: 105, total: 18, balance: 18, payment_status: 'unpaid' },
  };
  let activeOrders: Array<Record<string, any>> = [
    order101,
    {
      id: 102,
      order_number: 'ORD-102',
      status: 'pending',
      type: 'takeaway',
      subtotal: 10,
      total: 10,
      created_at: '2026-01-01 00:01:00',
      items: [],
    },
    order103,
    order104,
    order105,
  ];
  const completedOrder = {
    id: 201,
    order_number: 'ORD-201',
    status: 'completed',
    type: 'takeaway',
    subtotal: 30,
    total: 30,
    created_at: '2026-01-01 00:02:00',
    items: [],
    bill: { id: 601, order_id: 201, total: 30, payment_status: 'paid' },
    bills: [{ id: 602, order_id: 201, total: 15, payment_status: 'paid' }],
  };

  const Icon = () => null;
  const setTablesRequired = () => undefined;
  const ButtonStub = (props: Record<string, unknown>) => ({ type: 'button', props });
  const MasterListStub = (props: Record<string, unknown>) => ({ type: 'OrdersMasterList', props });
  const DetailPanelStub = (props: Record<string, unknown>) => ({ type: 'OrderDetailPanel', props });
  const PaymentModalStub = (props: Record<string, unknown>) => ({ type: 'PaymentModal', props });
  const jsxElement = (type: unknown, props: Record<string, unknown>, key?: unknown) => ({
    type,
    props,
    key,
  });

  const mocks: Record<string, unknown> = {
    react: reactHooks,
    'react/jsx-runtime': {
      jsx: jsxElement,
      jsxs: jsxElement,
      Fragment: 'Fragment',
    },
    'use-intl': {
      useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
      useLocale: () => 'en',
    },
    'next/navigation': {
      useRouter: () => ({ push: () => undefined }),
      useSearchParams: () => currentSearchParams,
    },
    'react-hot-toast': {
      __esModule: true,
      default: {
        success: () => undefined,
        error: (msg: string) => {
          toastErrors.push(msg);
        },
      },
    },
    'lucide-react': {
      ArrowRightLeft: Icon,
      Banknote: Icon,
      ChevronRight: Icon,
      Download: Icon,
      Eye: Icon,
      LayoutGrid: Icon,
      List: Icon,
      Loader2: Icon,
      MapPin: Icon,
      MapPinned: Icon,
      Maximize2: Icon,
      Minimize2: Icon,
      MoreHorizontal: Icon,
      Pencil: Icon,
      Percent: Icon,
      Plus: Icon,
      Printer: Icon,
      RotateCcw: Icon,
      Search: Icon,
      Sparkles: Icon,
      Table2: Icon,
      Trash2: Icon,
      UserPlus: Icon,
      Users: Icon,
      X: Icon,
    },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: async (url: string, config?: { params?: Record<string, unknown> }) => {
          if (url === '/orders') {
            const params = config?.params ?? {};
            orderRequests.push(params);
            if (params.view === 'all' && params.search === 'ORD-201') {
              return { data: { orders: [completedOrder], nextCursor: null } };
            }
            if (params.view === 'active' && !params.search) {
              if (deferNextActiveFetch) {
                deferNextActiveFetch = false;
                return new Promise((resolve) => {
                  deferredActiveFetch = resolve;
                });
              }
              return { data: { orders: activeOrders, nextCursor: null } };
            }
            return { data: { orders: [], nextCursor: null } };
          }
          if (url === '/orders/101') {
            return {
              data: {
                order: {
                  ...order101,
                  status: 'completed',
                  bill: { id: 501, order_id: 101, total: 20, payment_status: 'paid' },
                  bills: [{ id: 502, order_id: 101, total: 10, payment_status: 'paid' }],
                },
              },
            };
          }
          if (url === '/orders/103') {
            return {
              data: {
                order: {
                  ...order103,
                  status: 'pending',
                  bills: [
                    {
                      id: 701,
                      order_id: 103,
                      total: 15,
                      balance: 0,
                      payment_status: 'paid',
                      split_group_id: 'sg-1',
                    },
                    {
                      id: 702,
                      order_id: 103,
                      total: 15,
                      balance: 15,
                      payment_status: 'unpaid',
                      split_group_id: 'sg-1',
                    },
                  ],
                },
              },
            };
          }
          if (url === '/orders/104') {
            await new Promise((r) => setTimeout(r, 40));
            return {
              data: {
                order: {
                  ...order104,
                  status: 'pending',
                  bill: { id: 801, order_id: 104, total: 25, balance: 0, payment_status: 'paid' },
                },
              },
            };
          }
          if (url === '/orders/105') {
            return {
              data: {
                order: {
                  ...order105,
                  status: 'completed',
                  bill: { id: 901, order_id: 105, total: 18, balance: 0, payment_status: 'paid' },
                },
              },
            };
          }
          if (
            url === '/bills/501' ||
            url === '/bills/502' ||
            url === '/bills/701' ||
            url === '/bills/801'
          ) {
            const id = url.endsWith('/502')
              ? 502
              : url.endsWith('/701')
                ? 701
                : url.endsWith('/801')
                  ? 801
                  : 501;
            const orderId = id === 701 ? 103 : id === 801 ? 104 : 101;
            const paymentStatus = id === 701 || id === 801 ? 'unpaid' : 'paid';
            return {
              data: {
                bill: {
                  id,
                  order_id: orderId,
                  total: id === 801 ? 25 : 20,
                  balance: id === 701 ? 15 : id === 801 ? 25 : 0,
                  payment_status: paymentStatus,
                },
              },
            };
          }
          if (url === '/bills/998') {
            activeTenant = { id: 't-2', country: 'US', currency: 'USD', role: 'owner' };
            throw new Error('Bill not found on switched tenant');
          }
          if (url === '/bills/997') {
            activeTenant = { id: 't-2', country: 'US', currency: 'USD', role: 'owner' };
            return {
              data: {
                bill: {
                  id: 997,
                  order_id: 999,
                  total: 12,
                  balance: 0,
                  payment_status: 'paid',
                },
              },
            };
          }
          if (url === '/tables') {
            return {
              data: {
                tables: [
                  { id: 'tbl-42', name: 'T42', capacity: 4, status: 'occupied' },
                  { id: 'tbl-99', name: 'T99', capacity: 2, status: 'available' },
                ],
              },
            };
          }
          if (url === '/settings/business') return { data: { tables_required: true } };
          if (url === '/settings/discount')
            return { data: { discount_mode: 'percentage', discount_requires_approval: false } };
          if (url === '/settings/kds_enabled') return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
        post: async (url: string) => {
          if (url === '/bills/generate') {
            return {
              data: { bill: { id: 501, order_id: 101, total: 20, payment_status: 'unpaid' } },
            };
          }
          return { data: {} };
        },
      },
      captureClientOperationFailure: async () => undefined,
      createOperationReference: () => 'op-ref',
      operationHeaders: () => ({}),
    },
    '@/store/auth': {
      useAuthStore: Object.assign(
        () => ({
          currentTenant: activeTenant,
          user: { id: 'u-1', name: 'Owner' },
        }),
        {
          getState: () => ({
            currentTenant: activeTenant,
          }),
        },
      ),
    },
    '@/store/held-orders': {
      useHeldOrdersStore: () => ({
        orders: {},
        fetchHeldOrders: async () => undefined,
        restoreOrder: async () => null,
        removeHeldOrder: async () => false,
      }),
    },
    '@/store/cart': {
      useCartStore: () => ({
        items: [],
        clearCart: () => undefined,
        setCustomer: () => undefined,
        setOrderType: () => undefined,
        setTableId: () => undefined,
        setDeliveryAddress: () => undefined,
        loadItems: () => undefined,
      }),
    },
    '@/store/pos-settings': {
      usePosSettingsStore: () => ({
        setTablesRequired,
        autoPrintBill: false,
        printerUseUnicode: true,
        printerArabicShaping: false,
      }),
    },
    '@/hooks/usePrinter': {
      usePrinterStore: Object.assign(
        () => ({
          printBill: async (
            bill: { id: number },
            _tenant: unknown,
            _opts: unknown,
            reservedWindow?: unknown,
          ) => {
            printedBillIds.push(bill.id);
            printedReservedWindows.push(reservedWindow);
            return [];
          },
          printDeliverySlip: async () => [],
        }),
        {
          getState: () => ({
            printMethod: 'browser',
            hardwarePrinter: null,
            status: 'disconnected',
          }),
        },
      ),
      isPrintCancelledOnTenantChangeError: () => false,
    },
    '@/hooks/use-confirm': {
      useConfirm: () => ({ confirm: async () => true, ConfirmDialog: () => null }),
    },
    '@/hooks/useCurrencyUnitAdapter': { useCurrencyUnitAdapter: () => ({ maxDecimals: 2 }) },
    '@/hooks/useFormatCurrency': { useFormatCurrency: () => (v: number) => `$${v}` },
    '@/hooks/useFormatDate': { useFormatDate: () => ({ formatTime: () => '12:00' }) },
    '@/hooks/useWhatsAppReady': { useWhatsAppReady: () => false },
    '@/hooks/useOrdersLayout': { useOrdersLayoutPreference: () => ({ layout: 'split' }) },
    '@/components/ui/button': { Button: ButtonStub },
    '@/components/layout/Ltr': { Ltr: ({ children }: { children: unknown }) => children },
    '@/components/tables/TableTurnoverBadge': { TableTurnoverBadge: () => null },
    '@/components/tables/MoveTableModal': { __esModule: true, default: () => null },
    '@/components/pos/PaymentModal': { __esModule: true, default: PaymentModalStub },
    '@/components/pos/CreateCustomerModal': { __esModule: true, default: () => null },
    '@/components/pos/AddonModal': { __esModule: true, default: () => null },
    '@/components/orders/RefundModal': { __esModule: true, default: () => null },
    '@/components/orders/CorrectPaymentMethodModal': { __esModule: true, default: () => null },
    '@/components/orders/EditOrderItemModal': { __esModule: true, default: () => null },
    '@/components/orders/PriceOverrideModal': { PriceOverrideModal: () => null },
    '@/lib/countries': {
      getCurrencySymbol: () => '$',
      getCountryByCode: () => ({ locale: 'en-US' }),
      countryName: () => 'United States',
    },
    '@/lib/whatsapp-share': { sendBillViaFlo: async () => undefined },
    '@/lib/printer/warnings-toast': { showPrintWarningsToast: () => undefined },
    '@/lib/printer/warnings': {
      formatReceiptErrorToast: () => '',
      extractPrinterErrorMessage: () => '',
      extractPrintErrorToastOptions: () => ({}),
    },
    '@/lib/printer/tax-components': {
      preferChildScopedBill: (bill: Record<string, unknown>, order?: { status?: string }) => {
        printOrderStatuses.push(order?.status);
        return bill;
      },
    },
    '@/lib/utils': { cn: (...args: unknown[]) => args.filter(Boolean).join(' ') },
    '@/components/orders/OrderCard': { OrderCard: () => null },
    '@/components/orders/OrdersMasterList': { OrdersMasterList: MasterListStub },
    '@/components/orders/OrderDetailPanel': { OrderDetailPanel: DetailPanelStub },
  };

  moduleApi._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[
      moduleApi._resolveFilename('../frontend/src/app/(dashboard)/orders/page', module, false)
    ];
    const OrdersPage = require('../frontend/src/app/(dashboard)/orders/page').default;

    const states: unknown[] = [];
    const setters: Array<(next: unknown) => void> = [];
    const refs: Array<{ current: unknown }> = [];
    const effectEntries: Array<{
      deps: unknown[] | undefined;
      cleanup?: unknown;
      initialized: boolean;
    }> = [];
    const pendingEffects: Array<() => void> = [];

    const originalSetInterval = globalThis.setInterval;
    let backupPollCallback: (() => void) | null = null;
    globalThis.setInterval = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 10000 && typeof fn === 'function') {
        backupPollCallback = fn as () => void;
      }
      return originalSetInterval(fn, delay, ...(args as []));
    }) as typeof setInterval;

    const renderPage = () => {
      let stateIndex = 0;
      let refIndex = 0;
      let effectIndex = 0;

      reactHooks.useState = (initial: unknown) => {
        const idx = stateIndex++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
          setters.push((next: unknown) => {
            states[idx] =
              typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
          });
        }
        return [states[idx], setters[idx]];
      };
      reactHooks.useRef = (initial: unknown) => {
        const idx = refIndex++;
        if (idx >= refs.length) refs.push({ current: initial });
        return refs[idx];
      };
      reactHooks.useEffect = (effect: () => unknown, deps?: unknown[]) => {
        const idx = effectIndex++;
        const prev = effectEntries[idx];
        const changed =
          !prev ||
          !prev.initialized ||
          deps === undefined ||
          prev.deps === undefined ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps![i]));
        if (!prev) effectEntries[idx] = { deps, initialized: false };
        else prev.deps = deps;
        if (changed) {
          pendingEffects.push(() => {
            const entry = effectEntries[idx];
            if (typeof entry.cleanup === 'function') entry.cleanup();
            entry.cleanup = effect();
            entry.initialized = true;
          });
        }
        return undefined;
      };

      const tree = OrdersPage({});
      const querySyncEl = collectElements(
        tree,
        (el) =>
          typeof el.type === 'function' &&
          (el.type as { name?: string }).name === 'OrdersTableQuerySync',
      )[0];
      if (querySyncEl) {
        (querySyncEl.type as (props: unknown) => unknown)(querySyncEl.props);
      }
      while (pendingEffects.length > 0) {
        const run = pendingEffects.shift()!;
        run();
      }
      return tree;
    };

    const flushAll = async (ms = 360) => {
      await new Promise((r) => setTimeout(r, ms));
      return renderPage();
    };

    try {
      // Initial load on Active tab
      renderPage();
      let tree = await flushAll(50);

      // 1. Unified tabs exist and Row-2 Status <select> is gone
      const tabButtons = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-pressed'] !== undefined,
      );
      assert.equal(tabButtons.length, 6, 'Renders all 6 unified status tabs');
      const statusSelect = collectElements(
        tree,
        (el) =>
          el.type === 'select' &&
          collectElements(el, (opt) => opt.type === 'option' && opt.props?.value === 'completed')
            .length > 0,
      );
      assert.equal(statusSelect.length, 0, 'Row-2 Status <select> is removed');

      // 2. Completed and Cancelled tabs send view: 'all', status: 'completed' | 'cancelled'
      orderRequests.length = 0;
      const completedTab = tabButtons.find(
        (b) =>
          collectElements(b, (c) => c.type === 'span' && c.props?.children === 'orders.completed')
            .length > 0,
      );
      const cancelledTab = tabButtons.find(
        (b) =>
          collectElements(b, (c) => c.type === 'span' && c.props?.children === 'orders.cancelled')
            .length > 0,
      );
      const activeTab = tabButtons.find(
        (b) =>
          collectElements(b, (c) => c.type === 'span' && c.props?.children === 'orders.active')
            .length > 0,
      );
      assert.ok(
        completedTab && cancelledTab && activeTab,
        'Completed, Cancelled, and Active tabs present',
      );

      completedTab.props.onClick();
      renderPage();
      await flushAll();
      assert.ok(
        orderRequests.some((r) => r.view === 'all' && r.status === 'completed'),
        'Completed tab queries view=all&status=completed',
      );

      orderRequests.length = 0;
      cancelledTab.props.onClick();
      renderPage();
      await flushAll();
      assert.ok(
        orderRequests.some((r) => r.view === 'all' && r.status === 'cancelled'),
        'Cancelled tab queries view=all&status=cancelled',
      );

      // Switch back to Active
      activeTab.props.onClick();
      renderPage();
      tree = await flushAll();

      // 3. Switching type to takeaway hides and auto-clears table, and Clear filters resets all filters
      const findTableSelect = (t: unknown) =>
        collectElements(
          t,
          (el) =>
            el.type === 'select' &&
            collectElements(el, (opt) => opt.type === 'option' && opt.props?.value === 'tbl-42')
              .length > 0,
        )[0];
      const findTypeSelect = (t: unknown) =>
        collectElements(
          t,
          (el) =>
            el.type === 'select' &&
            collectElements(el, (opt) => opt.type === 'option' && opt.props?.value === 'takeaway')
              .length > 0,
        )[0];

      findTableSelect(tree).props.onChange({ target: { value: 'tbl-42' } });
      tree = renderPage();
      assert.ok(findTableSelect(tree), 'Table select visible for default All Types');
      assert.equal(findTableSelect(tree).props.value, 'tbl-42', 'Table filter selected');

      const clearBtnWithTable = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'orders-clear-filters',
      )[0];
      assert.ok(clearBtnWithTable, 'Clear filters button appears when table filter is active');

      findTypeSelect(tree).props.onChange({ target: { value: 'takeaway' } });
      tree = renderPage();
      assert.equal(
        findTableSelect(tree),
        undefined,
        'Table select hides when Takeaway is selected',
      );

      findTypeSelect(tree).props.onChange({ target: { value: '' } });
      tree = renderPage();
      assert.equal(
        findTableSelect(tree).props.value,
        '',
        'Switching to Takeaway auto-cleared previously selected table',
      );

      // Set search & type, then click Clear filters
      const searchInput = collectElements(tree, (el) => el.type === 'input')[0];
      searchInput.props.onChange({ target: { value: 'ORD-201' } });
      findTypeSelect(tree).props.onChange({ target: { value: 'delivery' } });
      tree = renderPage();
      const clearBtn = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'orders-clear-filters',
      )[0];
      assert.ok(clearBtn, 'Clear filters button renders when search/type filters are active');
      clearBtn.props.onClick();
      tree = renderPage();
      assert.equal(
        collectElements(tree, (el) => el.type === 'input')[0].props.value,
        '',
        'Clear filters resets search',
      );
      assert.equal(findTypeSelect(tree).props.value, '', 'Clear filters resets type');

      // 4. Cross-status search fallback does not fire un-debounced reads on empty-tab keystrokes,
      // and appears once the debounced tab query resolves with 0 matches while All has matches.
      const unpaidTab = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-pressed'] !== undefined &&
          collectElements(
            el,
            (c) => c.type === 'span' && c.props?.children === 'orders.unpaidBadge',
          ).length > 0,
      )[0];
      assert.ok(unpaidTab, 'Unpaid tab present');
      unpaidTab.props.onClick();
      renderPage();
      tree = await flushAll(400);
      orderRequests.length = 0;

      collectElements(tree, (el) => el.type === 'input')[0].props.onChange({
        target: { value: 'O' },
      });
      tree = renderPage();
      collectElements(tree, (el) => el.type === 'input')[0].props.onChange({
        target: { value: 'OR' },
      });
      tree = renderPage();
      collectElements(tree, (el) => el.type === 'input')[0].props.onChange({
        target: { value: 'ORD-201' },
      });
      renderPage();
      assert.equal(
        orderRequests.length,
        0,
        'Empty-tab search keystrokes do not emit un-debounced cross-tab fallback requests before the debounced fetch',
      );
      tree = await flushAll(400);
      tree = await flushAll(50);
      assert.equal(
        orderRequests.filter((r) => r.view === 'all' && r.per_page === 5).length,
        1,
        'Only one cross-tab fallback request fires after the debounced filtered-tab query settles',
      );
      assert.equal(
        orderRequests.find((r) => r.view === 'all' && r.per_page === 5)?.search,
        'ORD-201',
        'Cross-tab fallback request uses the final debounced search query',
      );

      const fallbackBtn = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'orders-search-all-fallback',
      )[0];
      assert.ok(fallbackBtn, 'Cross-tab search fallback button appears when All has matches');
      fallbackBtn.props.onClick();
      renderPage();
      tree = await flushAll(400);
      assert.ok(
        orderRequests.some((r) => r.view === 'all' && r.search === 'ORD-201'),
        'Clicking fallback button switches to All tab with the active search query',
      );

      // Clear search and switch back to Active for post-checkout & snapshot print test
      collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'orders-clear-filters',
      )[0].props.onClick();
      renderPage();
      tree = await flushAll(400);
      const activeBtn2 = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-pressed'] !== undefined &&
          collectElements(el, (c) => c.type === 'span' && c.props?.children === 'orders.active')
            .length > 0,
      )[0];
      activeBtn2.props.onClick();
      renderPage();
      tree = await flushAll(400);

      // 5. Select order 101, complete payment (order 101 leaves Active), verify settledTransition & handlePrint on snapshot
      const masterList = collectElements(tree, (el) => el.type === MasterListStub)[0];
      assert.ok(masterList, 'OrdersMasterList renders on Active tab');
      masterList.props.onSelect(101);
      tree = renderPage();

      // Trigger checkout to populate paymentBill and sync generated bill onto selectedOrderSnapshot
      const detailEl1 = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      assert.ok(detailEl1, 'OrderDetailPanel renders');
      await detailEl1.props.onCheckout(101);
      tree = renderPage();
      const detailAfterCheckout = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      assert.equal(
        detailAfterCheckout.props.order?.bill?.id,
        501,
        'handleCheckout syncs generated bill onto selectedOrderSnapshot',
      );
      const paymentEl = collectElements(tree, (el) => el.type === PaymentModalStub)[0];
      assert.ok(paymentEl, 'PaymentModal opens with bill 501');

      // Keep a stale active order 101 around while verifying snapshot precedence, then drop on refresh
      activeOrders = activeOrders.filter((o) => o.id !== 101);
      await paymentEl.props.onPaid();
      tree = await flushAll(50);

      const detailEl2 = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      assert.equal(
        detailEl2.props.settledTransition,
        'completed',
        'Detail panel receives settledTransition="completed" after payment in split layout',
      );
      assert.equal(
        detailEl2.props.order?.id,
        101,
        'Just-paid order remains displayed via selectedOrderSnapshot',
      );

      // Print primary bill (501) and split bill (502) from snapshot while order 101 is not in `orders`
      detailEl2.props.onPrint(501);
      tree = renderPage();
      const confirmPrintBtn1 = collectElements(
        tree,
        (el) =>
          el.type === ButtonStub &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes('orders.confirmPrint'),
      )[0];
      assert.ok(confirmPrintBtn1, 'Print confirmation modal opens for bill 501');
      await confirmPrintBtn1.props.onClick();
      tree = renderPage();

      const detailEl3 = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      detailEl3.props.onPrint(502);
      tree = renderPage();
      const confirmPrintBtn2 = collectElements(
        tree,
        (el) =>
          el.type === ButtonStub &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes('orders.confirmPrint'),
      )[0];
      assert.ok(confirmPrintBtn2, 'Print confirmation modal opens for split bill 502');
      await confirmPrintBtn2.props.onClick();

      assert.deepEqual(
        toastErrors,
        [],
        'handlePrint does not emit billNotFound when paid order lives in selectedOrderSnapshot',
      );
      assert.deepEqual(
        printedBillIds,
        [501, 502],
        'handlePrint prints both order.bill and split order.bills from selectedOrderSnapshot',
      );
      assert.deepEqual(
        printOrderStatuses,
        ['completed', 'completed'],
        'handlePrint prefers completed selectedOrderSnapshot ahead of any stale list entry',
      );

      // 6. Paying one split bill while sibling split bill 702 remains unpaid must NOT show settledTransition
      const masterListSplit = collectElements(tree, (el) => el.type === MasterListStub)[0];
      masterListSplit.props.onSelect(103);
      tree = renderPage();
      const splitDetail = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      await splitDetail.props.onPayBill(order103.bills[0]);
      tree = renderPage();
      const splitPaymentModal = collectElements(tree, (el) => el.type === PaymentModalStub)[0];
      assert.ok(splitPaymentModal, 'PaymentModal opens for split bill 701');
      await splitPaymentModal.props.onPaid();
      tree = await flushAll(50);
      const splitDetailAfter = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      assert.equal(
        splitDetailAfter.props.settledTransition,
        null,
        'Split-bill partial payment keeps settledTransition null while sibling bill remains unpaid',
      );

      // 7. When fetchOrders resolves before refreshSelectedOrder for an order that stays pending in the list,
      // fetchOrders still reconciles settledTransition to null instead of leaving the completion banner stuck.
      const masterListScheduled = collectElements(tree, (el) => el.type === MasterListStub)[0];
      masterListScheduled.props.onSelect(104);
      tree = renderPage();
      const scheduledDetail = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      await scheduledDetail.props.onPayBill(order104.bill);
      tree = renderPage();
      const scheduledPaymentModal = collectElements(tree, (el) => el.type === PaymentModalStub)[0];
      assert.ok(scheduledPaymentModal, 'PaymentModal opens for scheduled order bill 801');
      order104.bill = { ...order104.bill, balance: 0, payment_status: 'paid' };
      await scheduledPaymentModal.props.onPaid();
      tree = await flushAll(10);
      const scheduledDetailBeforeLookup = collectElements(
        tree,
        (el) => el.type === DetailPanelStub,
      )[0];
      assert.equal(
        scheduledDetailBeforeLookup.props.settledTransition,
        null,
        'fetchOrders reconciles settledTransition to null when an unreleased paid order remains pending in list',
      );
      tree = await flushAll(60);
      const scheduledDetailAfterLookup = collectElements(
        tree,
        (el) => el.type === DetailPanelStub,
      )[0];
      assert.equal(
        scheduledDetailAfterLookup.props.settledTransition,
        null,
        'settledTransition stays null after slower refreshSelectedOrder settles',
      );

      // 8. Pre-settlement in-flight fetchOrders response resolving AFTER payment completes must not clear settledTransition.
      const masterListRace = collectElements(tree, (el) => el.type === MasterListStub)[0];
      masterListRace.props.onSelect(105);
      tree = renderPage();
      const raceDetail = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      await raceDetail.props.onPayBill(order105.bill);
      tree = renderPage();
      const racePaymentModal = collectElements(tree, (el) => el.type === PaymentModalStub)[0];
      assert.ok(racePaymentModal && backupPollCallback, 'PaymentModal and poll callback ready');

      deferNextActiveFetch = true;
      backupPollCallback();
      await flushAll(10);
      assert.ok(deferredActiveFetch, 'Pre-settlement fetchOrders is suspended in-flight');

      const stalePreSettlementOrder105 = { ...order105, status: 'pending' };
      activeOrders = activeOrders.filter((o) => o.id !== 105);
      await racePaymentModal.props.onPaid();
      tree = await flushAll(20);
      const raceDetailSettled = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      assert.equal(
        raceDetailSettled.props.settledTransition,
        'completed',
        'settledTransition becomes completed after payment',
      );

      deferredActiveFetch({
        data: { orders: [stalePreSettlementOrder105], nextCursor: null },
      });
      tree = await flushAll(50);
      const raceDetailAfterStaleFetch = collectElements(
        tree,
        (el) => el.type === DetailPanelStub,
      )[0];
      assert.equal(
        raceDetailAfterStaleFetch.props.settledTransition,
        'completed',
        'Delayed pre-settlement fetchOrders does not clear settledTransition or clobber snapshot',
      );
      assert.equal(
        raceDetailAfterStaleFetch.props.order?.status,
        'completed',
        'Snapshot preserves completed status after stale pre-settlement fetchOrders settles',
      );

      // 9. URL ?table= param sync clears incompatible non-dine-in type filter so Table select stays visible.
      findTypeSelect(tree).props.onChange({ target: { value: 'takeaway' } });
      tree = renderPage();
      assert.equal(
        findTableSelect(tree),
        undefined,
        'Table select hidden when Takeaway type is selected',
      );
      currentSearchParams = new URLSearchParams('table=tbl-42');
      await flushAll(20);
      tree = renderPage();
      assert.equal(
        findTypeSelect(tree).props.value,
        '',
        'OrdersTableQuerySync clears incompatible Takeaway type when URL specifies ?table=',
      );
      assert.equal(
        findTableSelect(tree)?.props.value,
        'tbl-42',
        'OrdersTableQuerySync applies URL table param and keeps Table select visible',
      );

      // 10. PaymentModal on /orders forwards reservePrintWindow and prints a departing split bill not yet in orders
      tree = await flushAll(350);
      const detailForSplit = collectElements(tree, (el) => el.type === DetailPanelStub)[0];
      if (detailForSplit?.props?.onPayBill) {
        await detailForSplit.props.onPayBill(order103.bills[0]);
      } else {
        const masterSplit2 = collectElements(tree, (el) => el.type === MasterListStub)[0];
        masterSplit2.props.onSelect(103);
        tree = renderPage();
        await collectElements(tree, (el) => el.type === DetailPanelStub)[0].props.onPayBill(
          order103.bills[0],
        );
      }
      tree = renderPage();
      const splitSourceModal = collectElements(tree, (el) => el.type === PaymentModalStub)[0];
      assert.ok(splitSourceModal, 'PaymentModal opens before split');
      assert.equal(
        typeof splitSourceModal.props.reservePrintWindow,
        'function',
        'OrdersPage passes reservePrintWindow to PaymentModal',
      );

      const departingBill = {
        id: 999,
        order_id: 999,
        bill_number: 'B-999',
        total: 12,
        balance: 0,
        payment_status: 'paid',
        order: {
          id: 999,
          order_number: 'ORD-999',
          status: 'completed',
          type: 'dine_in',
          items: [],
        },
      };
      splitSourceModal.props.onSplit(departingBill);
      tree = await flushAll(20);
      const departingModal = collectElements(tree, (el) => el.type === PaymentModalStub)[0];
      assert.ok(departingModal, 'PaymentModal reopens for departing split bill 999');

      const fakeReservedWindow = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      await departingModal.props.onPrintBill(departingBill, fakeReservedWindow);
      assert.deepEqual(
        toastErrors,
        [],
        'Completion print for departing split bill does not emit billNotFound',
      );
      assert.equal(
        printedBillIds[printedBillIds.length - 1],
        999,
        'Completion print prints departing split bill directly',
      );
      assert.equal(
        printedReservedWindows[printedReservedWindows.length - 1],
        fakeReservedWindow,
        'Completion print forwards reservedWindow to printBill',
      );

      // 11. Tenant switch during completion print (both rejected /bills/:id with fallbackBill and resolved /bills/:id) aborts printing and closes reservedWindow
      const printsBeforeSwitch = printedBillIds.length;
      const switchedRejectWindow = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      await departingModal.props.onPrintBill({ ...departingBill, id: 998 }, switchedRejectWindow);
      assert.equal(
        printedBillIds.length,
        printsBeforeSwitch,
        'Tenant switch during rejected /bills/:id with fallbackBill skips printBill',
      );
      assert.equal(
        switchedRejectWindow.closed,
        true,
        'Tenant switch during rejected /bills/:id closes reservedWindow',
      );
      assert.deepEqual(
        toastErrors,
        [],
        'Tenant switch during rejected /bills/:id does not emit error toast',
      );

      activeTenant = { id: 't-1', country: 'US', currency: 'USD', role: 'owner' };
      tree = renderPage();
      const departingModalAfterReset = collectElements(
        tree,
        (el) => el.type === PaymentModalStub,
      )[0];
      const switchedResolveWindow = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      await departingModalAfterReset.props.onPrintBill(
        { ...departingBill, id: 997 },
        switchedResolveWindow,
      );
      assert.equal(
        printedBillIds.length,
        printsBeforeSwitch,
        'Tenant switch during resolved /bills/:id skips printBill',
      );
      assert.equal(
        switchedResolveWindow.closed,
        true,
        'Tenant switch during resolved /bills/:id closes reservedWindow',
      );
    } finally {
      globalThis.setInterval = originalSetInterval;
      for (const entry of effectEntries) {
        if (typeof entry?.cleanup === 'function') entry.cleanup();
      }
    }
  } finally {
    moduleApi._load = originalLoad;
    moduleApi._resolveFilename = originalResolveFilename;
  }
});
