/**
 * Card terminal transaction number requirement (`card_transaction_id_required`).
 * Run: node tests/run-electron-node-test.cjs tests/card-transaction-id.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-card-transaction-id-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const jwt = require('jsonwebtoken');
const { getJWTSecret } = require('../main/routes/auth');
const { getCurrencyUnitAdapter } = require('../main/countries');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { registerRoutes } = require('../main/routes/index');
const {
  OPERATION_FAILURE_REGISTRY,
  serializeOperationFailure,
} = require('../main/lib/operation-failure');

const ROOT = path.join(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
) {
  const resolvedRequest =
    request === '@countries'
      ? path.resolve(ROOT, 'main/countries.ts')
      : request.startsWith('@print/')
        ? path.resolve(ROOT, 'shared/print', request.slice('@print/'.length))
        : request.startsWith('@shared/')
          ? path.resolve(ROOT, 'shared', request.slice('@shared/'.length))
          : request.startsWith('@/')
            ? path.resolve(ROOT, 'frontend/src', request.slice(2))
            : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

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

function verifyPrepaidCheckoutModalDiscountPreservation(): void {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let stateCursor = 0;
  let refCursor = 0;

  const createElement = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ({
    type,
    props: {
      ...(props || {}),
      children:
        children.length === 0 ? props?.children : children.length === 1 ? children[0] : children,
    },
  });
  const jsx = (type: unknown, props: Record<string, unknown> | null) => ({
    type,
    props: props || {},
  });
  const useState = (initial: unknown) => {
    const idx = stateCursor++;
    if (!(idx in states)) {
      states[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const setState = (next: unknown) => {
      states[idx] =
        typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
    };
    return [states[idx], setState];
  };
  const effects: Array<() => void> = [];
  let effectsRan = false;
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    if (!effectsRan && Array.isArray(deps) && deps.length === 0) effects.push(fn);
  };
  const useMemo = (factory: () => unknown) => factory();
  const useRef = (initial: unknown) => {
    const idx = refCursor++;
    if (!refs[idx]) refs[idx] = { current: initial };
    return refs[idx];
  };
  const reactMock = {
    __esModule: true,
    default: { createElement, Fragment: 'Fragment', useState, useEffect, useMemo, useRef },
    createElement,
    Fragment: 'Fragment',
    useState,
    useEffect,
    useMemo,
    useRef,
  };

  const syncPromise = (data: unknown) => {
    const chain = {
      then: (cb: (res: { data: unknown }) => void) => {
        cb({ data });
        return chain;
      },
      catch: () => chain,
      finally: (cb?: () => void) => {
        cb?.();
        return chain;
      },
    };
    return chain;
  };

  const Icon = () => createElement('span', null);
  const thbAdapter = getCurrencyUnitAdapter('THB', 'TH');
  const cart = {
    items: [{ id: 'item-1', productId: 'prod-ctid', name: 'Coffee', price: 60, quantity: 1 }],
    customer: null,
    customerId: null,
    orderType: 'takeaway' as const,
    onlinePlatform: null,
    waivedChargeIds: new Set<string>(),
    optedInChargeIds: new Set<string>(),
    itemCount: () => 1,
    toggleWaiveCharge: () => undefined,
    toggleOptedInCharge: () => undefined,
  };
  const chargesState = { charges: [], load: async () => undefined };
  let lastPreviewDiscount: { type: string; value: number } | null = null;
  const toasts: string[] = [];

  const mocks: Record<string, unknown> = {
    react: reactMock,
    'react/jsx-runtime': {
      Fragment: 'Fragment',
      jsx,
      jsxs: jsx,
    },
    'lucide-react': {
      X: Icon,
      Sparkles: Icon,
      ArrowLeftRight: Icon,
      CheckCircle2: Icon,
      Percent: Icon,
      Wallet: Icon,
      ChevronDown: Icon,
      Banknote: Icon,
      CreditCard: Icon,
    },
    '@/components/ui/button': {
      Button: ({ children, variant: _variant, size: _size, ...props }: any) =>
        createElement('button', props, children),
    },
    '@/components/pos/TaxBreakdown': { __esModule: true, default: () => null },
    '@/components/pos/TouchNumberPad': { CurrencyTouchNumberPad: () => null },
    '@/components/ApproverSelect': { ApproverSelect: () => null },
    '@/hooks/useManagerApprovers': {
      useManagerApprovers: () => ({
        approvers: [],
        selectedApproverId: null,
        loading: false,
        loadFailed: false,
      }),
    },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: (url: string) => {
          if (url === '/settings/discount') {
            return syncPromise({ discount_mode: 'both', discount_requires_approval: true });
          }
          if (url === '/settings/card_transaction_id_required') {
            return syncPromise({ setting: { value: 'true' } });
          }
          if (url === '/payment-methods') {
            return syncPromise({ payment_methods: [] });
          }
          return syncPromise({});
        },
      },
    },
    'react-hot-toast': {
      __esModule: true,
      default: {
        success: () => undefined,
        error: (msg: string) => {
          toasts.push(msg);
        },
      },
    },
    '@/store/cart': {
      useCartStore: (selector?: (state: typeof cart) => unknown) =>
        selector ? selector(cart) : cart,
    },
    '@/store/charges': {
      chargesForOrderType: () => [],
      useChargesStore: (selector: (state: typeof chargesState) => unknown) =>
        selector(chargesState),
    },
    '@/store/auth': {
      useAuthStore: () => ({ currentTenant: { currency: 'THB', country: 'TH' } }),
    },
    'use-intl': {
      useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values?.amount !== undefined ? `${key}:${values.amount}` : key,
    },
    '@/lib/payment-methods': {
      PAYMENT_METHODS: [
        { key: 'cash', icon: Icon },
        { key: 'card', icon: Icon },
      ],
    },
    '@/hooks/useFormatCurrency': {
      useFormatCurrency: () => (amount: number) => `฿${amount.toFixed(2)}`,
    },
    '@/hooks/useFormatNumber': { useFormatNumber: () => (amount: number) => String(amount) },
    '@/hooks/useCurrencyUnitAdapter': { useCurrencyUnitAdapter: () => thbAdapter },
    '@/hooks/use-tax-preview': {
      useTaxPreview: (
        _items: unknown,
        _customerId: unknown,
        _orderType: unknown,
        discount: { type: string; value: number } | null,
      ) => {
        lastPreviewDiscount = discount;
        const discounted = discount && discount.type === 'percentage' && discount.value === 10;
        return {
          loading: false,
          error: null,
          tax: {
            subtotal: 60,
            discount_amount: discounted ? 6 : 0,
            discounted_subtotal: discounted ? 54 : 60,
            tax_amount: discounted ? 3.78 : 4.2,
            tax_breakdown: [],
            packaging_charge: 0,
            charges_breakdown: [],
            round_off: 0,
            total: discounted ? 57.78 : 64.2,
          },
        };
      },
    },
  };

  const prevLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return prevLoad.call(this, request, parent, isMain);
  };

  try {
    const PrepaidCheckoutModal =
      require('../frontend/src/components/pos/PrepaidCheckoutModal').default;

    let confirmedPayments: unknown[] | null = null;
    let confirmedWallet: number | null = null;
    let confirmedDiscount: Record<string, unknown> | null = null;

    const render = () => {
      stateCursor = 0;
      refCursor = 0;
      return PrepaidCheckoutModal({
        currency: 'THB',
        initialCardTransactionIdRequired: true,
        initialDiscount: { type: 'percentage', value: 10, reason: 'Happy Hour' },
        discountCommitted: true,
        onClose: () => undefined,
        onConfirm: (
          payments: unknown[],
          walletAmount: number,
          discount: Record<string, unknown> | null,
        ) => {
          confirmedPayments = payments;
          confirmedWallet = walletAmount;
          confirmedDiscount = discount;
        },
      });
    };

    // Simulate discount_requires_approval enabled on the store while retrying a
    // checkout whose discounted bill is already committed.
    let tree = render();
    effectsRan = true;
    for (const effect of effects) effect();
    tree = render();

    assertEqualOrThrow(
      JSON.stringify(lastPreviewDiscount),
      JSON.stringify({ type: 'percentage', value: 10 }),
      'reopened PrepaidCheckoutModal preserves the saved 10% discount in tax preview',
    );

    const cardButton = collectElements(
      tree,
      (el) => el.type === 'button' && el.props?.title === 'methodCard',
    )[0];
    cardButton.props.onClick();
    tree = render();

    const txInput = collectElements(
      tree,
      (el) => el.type === 'input' && el.props?.['aria-label'] === 'cardTransactionIdLabel',
    )[0];
    assertEqualOrThrow(
      Boolean(txInput),
      true,
      'selecting Card shows the card transaction number input when required',
    );
    txInput.props.onChange({ target: { value: 'TXN-5778' } });
    tree = render();

    const confirmButton = collectElements(
      tree,
      (el) =>
        typeof el.props?.children === 'string' &&
        el.props.children.startsWith('confirmPaymentAmount:'),
    )[0];
    assertEqualOrThrow(
      confirmButton.props.children,
      'confirmPaymentAmount:฿57.78',
      'reopened PrepaidCheckoutModal keeps the discounted ฿57.78 payable amount',
    );
    assertEqualOrThrow(
      confirmButton.props.disabled,
      false,
      'committed unchanged discount does not re-block confirmation on manager PIN',
    );

    confirmButton.props.onClick();
    assertEqualOrThrow(toasts.length, 0, 'retry confirmation emits no validation error toast');
    assertEqualOrThrow(
      JSON.stringify(confirmedPayments),
      JSON.stringify([{ method: 'card', amount: 57.78, transaction_id: 'TXN-5778' }]),
      'retry confirmation submits the discounted ฿57.78 card payment with transaction_id',
    );
    assertEqualOrThrow(confirmedWallet, 0, 'retry confirmation preserves zero wallet amount');
    assertEqualOrThrow(
      JSON.stringify(confirmedDiscount),
      JSON.stringify({
        type: 'percentage',
        value: 10,
        reason: 'Happy Hour',
        override_pin: undefined,
        approver_id: undefined,
      }),
      'retry confirmation preserves the saved discount so the bill is not regenerated',
    );
  } finally {
    Module._load = prevLoad;
  }
}

async function verifyPaymentMethodsSettingsSaveHandling(): Promise<void> {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let stateCursor = 0;
  let refCursor = 0;
  const effects: Array<() => void> = [];
  let effectsRan = false;

  const createElement = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ({
    type,
    props: {
      ...(props || {}),
      children:
        children.length === 0 ? props?.children : children.length === 1 ? children[0] : children,
    },
  });
  const jsx = (type: unknown, props: Record<string, unknown> | null) => ({
    type,
    props: props || {},
  });
  const useState = (initial: unknown) => {
    const idx = stateCursor++;
    if (!(idx in states)) {
      states[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const setState = (next: unknown) => {
      states[idx] =
        typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
    };
    return [states[idx], setState];
  };
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    if (!effectsRan && Array.isArray(deps) && deps.length === 0) effects.push(fn);
  };
  const useRef = (initial: unknown) => {
    const idx = refCursor++;
    if (!refs[idx]) refs[idx] = { current: initial };
    return refs[idx];
  };
  const reactMock = {
    __esModule: true,
    default: { createElement, Fragment: 'Fragment', useState, useEffect, useRef },
    createElement,
    Fragment: 'Fragment',
    useState,
    useEffect,
    useRef,
  };
  const Icon = () => createElement('span', null);
  const toasts: string[] = [];
  let resolveSave: ((res: { data: unknown }) => void) | null = null;
  let rejectSave: ((err: Error) => void) | null = null;

  const mocks: Record<string, unknown> = {
    react: reactMock,
    'react/jsx-runtime': {
      Fragment: 'Fragment',
      jsx,
      jsxs: jsx,
    },
    'lucide-react': {
      CreditCard: Icon,
      Plus: Icon,
      Save: Icon,
      Trash2: Icon,
      Merge: Icon,
    },
    '@/components/ui/button': {
      Button: ({ children, variant: _variant, size: _size, ...props }: any) =>
        createElement('button', props, children),
    },
    '@/components/settings/SettingsTabShell': {
      SettingsTabShell: ({ children }: any) => createElement('div', null, children),
    },
    'use-intl': {
      useTranslations: () => (key: string) => key,
    },
    '@/hooks/useFormatDate': {
      useFormatDate: () => ({ formatDate: (value: string) => value }),
    },
    'react-hot-toast': {
      __esModule: true,
      default: {
        success: () => undefined,
        error: (msg: string) => {
          toasts.push(msg);
        },
      },
    },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: async (url: string) => {
          if (url === '/settings/card_transaction_id_required') {
            return { data: { setting: { value: 'true' } } };
          }
          if (url === '/settings/split_checks_enabled') {
            return { data: { setting: { value: 'false' } } };
          }
          if (url === '/payment-methods/merge-history') {
            return { data: { merges: [] } };
          }
          return { data: { payment_methods: [] } };
        },
        post: async () => ({ data: {} }),
        put: (url: string) => {
          if (url === '/settings/card_transaction_id_required') {
            return new Promise((resolve, reject) => {
              resolveSave = resolve;
              rejectSave = reject;
            });
          }
          return Promise.resolve({ data: {} });
        },
      },
    },
  };

  const prevLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return prevLoad.call(this, request, parent, isMain);
  };

  try {
    const {
      PaymentMethodsSettings,
    } = require('../frontend/src/components/settings/PaymentMethodsSettings');
    const render = () => {
      stateCursor = 0;
      refCursor = 0;
      return PaymentMethodsSettings({ isAdmin: true });
    };

    let tree = render();
    effectsRan = true;
    for (const effect of effects) effect();
    await new Promise((resolve) => setImmediate(resolve));
    tree = render();

    const findCheckbox = (root: unknown) =>
      collectElements(
        root,
        (el) => el.type === 'input' && el.props?.id === 'card-transaction-id-required',
      )[0];

    let checkbox = findCheckbox(tree);
    assertEqualOrThrow(checkbox.props.checked, true, 'checkbox reflects loaded true setting');
    assertEqualOrThrow(checkbox.props.disabled, false, 'checkbox is enabled once ready');

    const savePromise = checkbox.props.onChange({ target: { checked: false } });
    tree = render();
    checkbox = findCheckbox(tree);
    assertEqualOrThrow(
      checkbox.props.disabled,
      true,
      'checkbox is disabled while card_transaction_id_required save is in flight',
    );
    assertEqualOrThrow(
      checkbox.props.checked,
      false,
      'checkbox shows optimistic false value while save is in flight',
    );

    rejectSave?.(new Error('network error'));
    await savePromise;
    tree = render();
    checkbox = findCheckbox(tree);
    assertEqualOrThrow(
      checkbox.props.checked,
      true,
      'failed save restores the previous confirmed setting value',
    );
    assertEqualOrThrow(
      checkbox.props.disabled,
      false,
      'checkbox is re-enabled after failed save settles',
    );
    assertEqualOrThrow(toasts.includes('saveFailed'), true, 'failed save reports saveFailed toast');

    // Verify a concurrent load() triggered by adding/editing a payment method while a save is
    // in-flight cannot overwrite the pending or confirmed setting value with a stale read.
    const secondSavePromise = checkbox.props.onChange({ target: { checked: false } });
    tree = render();
    const newNameInput = collectElements(
      tree,
      (el) => el.type === 'input' && el.props?.placeholder === 'paymentMethodName',
    )[0];
    newNameInput.props.onChange({ target: { value: 'PromptPay' } });
    tree = render();
    const reloadInput = collectElements(
      tree,
      (el) => el.type === 'input' && el.props?.placeholder === 'paymentMethodName',
    )[0];
    reloadInput.props.onKeyDown({ key: 'Enter' });
    await new Promise((resolve) => setImmediate(resolve));
    tree = render();
    checkbox = findCheckbox(tree);
    assertEqualOrThrow(
      checkbox.props.checked,
      false,
      'concurrent load() during an in-flight save does not overwrite the pending toggle value',
    );
    resolveSave?.({ data: { setting: { value: 'false' } } });
    await secondSavePromise;
    tree = render();
    checkbox = findCheckbox(tree);
    assertEqualOrThrow(
      checkbox.props.checked,
      false,
      'confirmed save value remains false after concurrent load() and save settle',
    );
  } finally {
    Module._load = prevLoad;
  }

  const prevOrderDetailLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request in mocks) return mocks[request];
    if (request.startsWith('@/')) return {};
    return prevOrderDetailLoad.call(this, request, parent, isMain);
  };
  try {
    const {
      normalizeBillPaymentDetails,
    } = require('../frontend/src/components/orders/OrderDetailPanel');
    assertEqualOrThrow(
      JSON.stringify(
        normalizeBillPaymentDetails({
          method: 'card',
          amount: 100,
          timestamp: '2026-10-22T00:00:00Z',
          transaction_id: 'LEGACY-001',
        }).filter((line: { transaction_id?: string }) => Boolean(line.transaction_id)),
      ),
      JSON.stringify([
        {
          method: 'card',
          amount: 100,
          timestamp: '2026-10-22T00:00:00Z',
          transaction_id: 'LEGACY-001',
        },
      ]),
      'normalizeBillPaymentDetails preserves transaction_id from legacy single-object payment_details',
    );
    assertEqualOrThrow(
      JSON.stringify(
        normalizeBillPaymentDetails([
          { method: 'cash', amount: 40, timestamp: '2026-10-22T00:00:00Z' },
          {
            method: 'card',
            amount: 60,
            timestamp: '2026-10-22T00:00:00Z',
            transaction_id: 'ARR-002',
          },
        ]).filter((line: { transaction_id?: string }) => Boolean(line.transaction_id)),
      ),
      JSON.stringify([
        {
          method: 'card',
          amount: 60,
          timestamp: '2026-10-22T00:00:00Z',
          transaction_id: 'ARR-002',
        },
      ]),
      'normalizeBillPaymentDetails preserves transaction_id lines from array payment_details',
    );
    assertEqualOrThrow(
      normalizeBillPaymentDetails(null).length,
      0,
      'normalizeBillPaymentDetails returns an empty array for null payment_details',
    );
  } finally {
    Module._load = prevOrderDetailLoad;
  }
}

async function main(): Promise<void> {
  console.log('Card transaction number requirement');
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-ctid', 'Card menu');
  seedProduct(db, 'prod-ctid', 'cat-ctid', 'Espresso', 100);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/settings': settingsRoutes,
    '/api/payment-methods': paymentMethodRoutes,
  });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function newBill(): Promise<string> {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-ctid', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqualOrThrow(order.status, 201, 'takeaway order created');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.data.order.id },
      headers: authHeader,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    return bill.data.bill.id;
  }
  function pay(billId: string, payments: unknown[]) {
    return api(baseUrl, `/api/bills/${billId}/payments`, {
      method: 'POST',
      body: { payments },
      headers: authHeader,
    });
  }

  try {
    const fallback = await api(baseUrl, '/api/settings/card_transaction_id_required', {
      headers: authHeader,
    });
    assertEqualOrThrow(fallback.status, 200, 'unset requirement reads as a default');
    assertEqualOrThrow(fallback.data.setting.value, 'false', 'requirement is off by default');

    const offBill = await newBill();
    const offPayment = await pay(offBill, [{ method: 'card' }]);
    assertEqualOrThrow(
      offPayment.status,
      200,
      'card payment without a number is accepted while off',
    );

    const invalid = await api(baseUrl, '/api/settings/card_transaction_id_required', {
      method: 'PUT',
      body: { value: 'maybe' },
      headers: authHeader,
    });
    assertEqualOrThrow(invalid.status, 400, 'non-boolean requirement value is rejected');
    const enable = await api(baseUrl, '/api/settings/card_transaction_id_required', {
      method: 'PUT',
      body: { value: true },
      headers: authHeader,
    });
    assertEqualOrThrow(enable.status, 200, 'requirement can be enabled');
    assertEqualOrThrow(
      enable.data.setting.value,
      'true',
      'requirement is stored as a canonical flag',
    );

    const cashierId = 'cashier-ctid-001';
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(cashierId, 'Cashier', 'cashier@test.local', 'hash', 'cashier', 1, now(), now());
    db.prepare(
      `INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by, updated_at)
       VALUES ('cashier', 'settings.view', 'deny', 'owner-test-001', ?)`,
    ).run(now());
    const cashierToken = jwt.sign(
      { userId: cashierId, email: 'cashier@test.local', role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    try {
      const deniedGenericSetting = await api(baseUrl, '/api/settings/split_checks_enabled', {
        headers: { Authorization: `Bearer ${cashierToken}` },
      });
      assertEqualOrThrow(
        deniedGenericSetting.status,
        403,
        'cashier with settings.view denied cannot read generic settings',
      );
      const cashierRead = await api(baseUrl, '/api/settings/card_transaction_id_required', {
        headers: { Authorization: `Bearer ${cashierToken}` },
      });
      assertEqualOrThrow(
        cashierRead.status,
        200,
        'cashier with settings.view denied can still read card_transaction_id_required via payments.take',
      );
      assertEqualOrThrow(
        cashierRead.data.setting.value,
        'true',
        'cashier sees the enabled card_transaction_id_required flag',
      );
    } finally {
      db.prepare(
        `DELETE FROM role_permission_overrides WHERE role = 'cashier' AND permission_id = 'settings.view'`,
      ).run();
    }

    const billId = await newBill();
    const missing = await pay(billId, [{ method: 'card' }]);
    assertEqualOrThrow(missing.status, 400, 'card payment without a number is rejected while on');
    assertEqualOrThrow(
      missing.data.display_code,
      'card_transaction_id_required',
      'rejection names the missing number',
    );
    const paymentValidationDef = OPERATION_FAILURE_REGISTRY.find(
      (entry: { capture_point: string }) =>
        entry.capture_point === 'fc.backend.payment.create.validation',
    );
    assertEqualOrThrow(
      paymentValidationDef.facts.display_code.values.includes('card_transaction_id_required'),
      false,
      'PAYMENT_DISPLAY_CODES excludes card_transaction_id_required to match FloAdmin diagnostic schema',
    );
    const serializedDiagnostic = serializeOperationFailure({
      capture_point: 'fc.backend.payment.create.validation',
      outcome: 'not_applied',
      facts: { display_code: 'card_transaction_id_required' },
    });
    assertEqualOrThrow(
      serializedDiagnostic?.facts?.display_code,
      'payment_input_invalid',
      'diagnostic serialization maps card_transaction_id_required to payment_input_invalid',
    );
    const bypassAttempt = await pay(billId, [{ method: 'card', payment_method_id: 0 }]);
    assertEqualOrThrow(
      bypassAttempt.status,
      400,
      'built-in card payment with payment_method_id: 0 cannot bypass the requirement',
    );
    assertEqualOrThrow(
      bypassAttempt.data.display_code,
      'card_transaction_id_required',
      'payment_method_id: 0 on card still reports card_transaction_id_required',
    );
    const emptyString = await pay(billId, [{ method: 'card', transaction_id: '' }]);
    assertEqualOrThrow(
      emptyString.status,
      400,
      'card payment with empty transaction_id is rejected',
    );
    assertEqualOrThrow(
      emptyString.data.display_code,
      'card_transaction_id_required',
      'empty transaction_id reports card_transaction_id_required',
    );
    const whitespace = await pay(billId, [{ method: 'card', transaction_id: '   ' }]);
    assertEqualOrThrow(
      whitespace.status,
      400,
      'card payment with whitespace transaction_id is rejected',
    );
    assertEqualOrThrow(
      whitespace.data.display_code,
      'card_transaction_id_required',
      'whitespace transaction_id reports card_transaction_id_required',
    );
    const tooLong = await pay(billId, [{ method: 'card', transaction_id: '0'.repeat(257) }]);
    assertEqualOrThrow(
      tooLong.status,
      400,
      'card payment with >256-char transaction_id is rejected',
    );
    assertEqualOrThrow(
      tooLong.data.display_code,
      'payment_input_invalid',
      '>256-char transaction_id reports payment_input_invalid',
    );
    const unpaid = db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(billId) as {
      payment_status: string;
    };
    assertEqualOrThrow(unpaid.payment_status, 'unpaid', 'rejected payment writes nothing');

    const custom = await api(baseUrl, '/api/payment-methods', {
      method: 'POST',
      body: { name: 'Bank QR' },
      headers: authHeader,
    });
    assertEqualOrThrow(custom.status, 201, 'custom method created');
    const customBill = await newBill();
    const customPayment = await pay(customBill, [
      { method: 'custom', payment_method_id: custom.data.payment_method.id },
    ]);
    assertEqualOrThrow(
      customPayment.status,
      200,
      'custom methods are not affected by the requirement',
    );

    const paid = await pay(billId, [{ method: 'card', transaction_id: '000123' }]);
    assertEqualOrThrow(paid.status, 200, 'card payment with a terminal number is accepted');
    assertEqualOrThrow(paid.data.bill.payment_status, 'paid', 'bill is settled');
    const ledger = JSON.parse(
      (
        db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(billId) as {
          payment_details: string;
        }
      ).payment_details,
    );
    assertEqualOrThrow(
      ledger[0].transaction_id,
      '000123',
      'ledger keeps the terminal number verbatim',
    );

    const reused = await pay(await newBill(), [{ method: 'card', transaction_id: '000123' }]);
    assertEqualOrThrow(reused.status, 409, 'a terminal number cannot settle a second bill');
    assertEqualOrThrow(
      reused.data.display_code,
      'transaction_reference_used',
      'reuse keeps its existing code',
    );

    verifyPrepaidCheckoutModalDiscountPreservation();
    await verifyPaymentMethodsSettingsSaveHandling();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
