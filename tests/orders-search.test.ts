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
    useState: (_initial: unknown): [unknown, (next: unknown) => void] => [
      undefined,
      () => undefined,
    ],
    useEffect: (_effect: () => unknown) => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
  };

  const orderRequests: Array<Record<string, unknown>> = [];
  let pendingOrdersResponse: Promise<{ data: { orders: unknown[]; nextCursor: null } }> | null =
    null;
  const Icon = () => null;
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
        setTablesRequired: () => undefined,
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
        (el) => el.type === 'button' && el.props?.children === 'orders.held',
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
        (el) => el.type === 'button' && el.props?.children === 'orders.all',
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
