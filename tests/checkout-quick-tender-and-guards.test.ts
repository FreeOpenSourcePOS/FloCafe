/**
 * Unit + React-harness tests for 3-column POS checkout quick-tender helpers,
 * TouchNumberPad fillHeight, CheckoutPaymentStation 4-zone structure,
 * and PaymentModal / PrepaidCheckoutModal concurrency & state guards.
 *
 * Run: npm run test:checkout-quick-tender-and-guards
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrencyMinorUnitFactor, getCurrencyUnitAdapter } from '../main/countries';

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

function collectElements(node: unknown, predicate: (el: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const el = node as { props?: Record<string, any> };
  if (predicate(el)) out.push(el);
  if (el.props && el.props.children !== undefined) {
    collectElements(el.props.children, predicate, out);
  }
  return out;
}

function createStatefulHarness() {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const effects: Array<{ fn: () => void | (() => void); deps: unknown[] | undefined }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | void> = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;

  const createEl = (
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

  const jsx = (type: unknown, props: Record<string, unknown> | null) => createEl(type, props);

  const hooksReact = {
    createElement: createEl,
    Fragment: Symbol.for('react.fragment'),
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
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = effectCursor++;
      effects[idx] = { fn, deps };
    },
    useMemo: <T>(factory: () => T) => factory(),
    useCallback: <T>(cb: T) => cb,
  };

  function flushEffects() {
    for (let i = 0; i < effects.length; i++) {
      const entry = effects[i];
      if (!entry) continue;
      const old = prevDeps[i];
      const changed =
        !old ||
        !entry.deps ||
        entry.deps.length !== old.length ||
        entry.deps.some((d, j) => !Object.is(d, old[j]));
      if (changed) {
        if (typeof cleanups[i] === 'function') cleanups[i]!();
        cleanups[i] = entry.fn();
        prevDeps[i] = entry.deps;
      }
    }
  }

  function resetCursors() {
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    effects.length = 0;
  }

  return {
    hooksReact,
    jsxRuntime: { jsx, jsxs: jsx, Fragment: hooksReact.Fragment },
    render<P>(Component: (props: P) => any, props: P) {
      resetCursors();
      const tree = Component(props);
      flushEffects();
      return tree;
    },
    renderAndSettle<P>(Component: (props: P) => any, props: P, passes = 3) {
      let tree: any = null;
      for (let i = 0; i < passes; i++) {
        tree = this.render(Component, props);
      }
      return tree;
    },
    cleanupAll() {
      for (const fn of cleanups) {
        if (typeof fn === 'function') fn();
      }
    },
  };
}

function withAliases(fn: () => void | Promise<void>) {
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
                  : request.startsWith('@shared/')
                    ? path.resolve(ROOT, 'shared', request.slice(8))
                    : request.startsWith('@/')
                      ? path.resolve(ROOT, 'frontend/src', request.slice(2))
                      : request;
    return originalResolveFilename.call(this, resolved, parent, isMain, options);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Module._load = originalLoad;
      Module._resolveFilename = originalResolveFilename;
    });
}

async function testQuickTenderAndMinorMath() {
  console.log('\n--- 1. Quick-Cash Denominations & Minor-Unit Math ---');
  await withAliases(async () => {
    const {
      computeQuickCashDisplayAmounts,
      rescalePaymentAmountsMinor,
      allocateRemainingMinor,
    } = require('../frontend/src/lib/checkout-quick-tender.ts');

    const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
    const usdPills = computeQuickCashDisplayAmounts({
      remainingMinor: 1420,
      minorFactor: getCurrencyMinorUnitFactor('USD'),
      unitAdapter: usdAdapter,
    });
    assert.equal(usdPills.length, 4, 'USD 14.20 returns 4 quick-cash pills');
    assert.equal(usdPills[0], 14.2, 'First pill is exact due');
    assert.deepEqual([...new Set(usdPills)], usdPills, 'USD pills are strictly unique');
    assert.ok(
      usdPills.every((val: number, i: number) => i === 0 || val > usdPills[i - 1]),
      'USD pills are strictly ascending',
    );
    assert.deepEqual(usdPills, [14.2, 15, 20, 50]);

    assert.deepEqual(
      computeQuickCashDisplayAmounts({
        remainingMinor: 0,
        minorFactor: 100,
        unitAdapter: usdAdapter,
      }),
      [],
      'Zero remaining balance yields empty quick-cash list',
    );

    const jpyAdapter = getCurrencyUnitAdapter('JPY', 'JP');
    const jpyPills = computeQuickCashDisplayAmounts({
      remainingMinor: 1500,
      minorFactor: getCurrencyMinorUnitFactor('JPY'),
      unitAdapter: jpyAdapter,
    });
    assert.equal(jpyPills.length, 4, 'JPY 1500 returns 4 pills');
    assert.equal(jpyPills[0], 1500, 'JPY first pill is exact due');
    assert.ok(
      jpyPills.every((val: number) => Number.isInteger(val)),
      'JPY quick-cash pills stay integer values',
    );
    assert.deepEqual(jpyPills, [1500, 2000, 5000, 10000]);

    const irrAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
    const irrPills = computeQuickCashDisplayAmounts({
      remainingMinor: 1250000, // 12,500.00 IRR (minorFactor=100) = 1,250 Toman display
      minorFactor: getCurrencyMinorUnitFactor('IRR'),
      unitAdapter: irrAdapter,
    });
    assert.equal(irrPills.length, 4, 'IRR Toman returns 4 pills');
    assert.equal(irrPills[0], 1250, 'IRR Toman first pill converts minor Rial to Toman');
    assert.ok(
      irrPills.every(
        (val: number, i: number) => Number.isInteger(val) && (i === 0 || val > irrPills[i - 1]),
      ),
      'IRR Toman pills are ascending integers',
    );

    const kwdAdapter = getCurrencyUnitAdapter('KWD', 'KW');
    const kwdPills = computeQuickCashDisplayAmounts({
      remainingMinor: 4250, // 4.250 KWD
      minorFactor: getCurrencyMinorUnitFactor('KWD'),
      unitAdapter: kwdAdapter,
    });
    assert.equal(kwdPills.length, 4, 'KWD 4.250 returns 4 pills');
    assert.equal(kwdPills[0], 4.25, 'KWD first pill matches exact due');
    assert.deepEqual(kwdPills, [4.25, 5, 10, 20]);

    // Zero-cent-drift proportional rescaling on 3-way split & discount reductions
    const rescaledUp = rescalePaymentAmountsMinor([334, 333, 333], 2500);
    assert.equal(
      rescaledUp.reduce((s: number, v: number) => s + v, 0),
      2500,
      '3-way rescale up preserves exact minor sum 2500',
    );
    assert.deepEqual(rescaledUp, [835, 833, 832]);

    const rescaledDiscount = rescalePaymentAmountsMinor([1000, 1000, 1000], 1000);
    assert.equal(
      rescaledDiscount.reduce((s: number, v: number) => s + v, 0),
      1000,
      'Discount rescale preserves exact minor sum 1000',
    );
    assert.deepEqual(rescaledDiscount, [334, 333, 333]);

    assert.deepEqual(
      rescalePaymentAmountsMinor([500, 500], 0),
      [0, 0],
      'Zero target scales rows cleanly to zeros',
    );

    // Minor-unit remaining allocation eliminates IEEE-754 float noise (57.78 - 10.10 = 47.68)
    assert.equal(
      allocateRemainingMinor(5778, [1010, 0], 1),
      4768,
      'allocateRemainingMinor avoids 57.78 - 10.10 binary float drift',
    );
  });
  console.log('  ✓ Quick-cash pills, rescaling, and minor-unit remaining math verified');
}

async function testTouchNumberPadAndStationStructure() {
  console.log('\n--- 2. TouchNumberPad fillHeight & CheckoutPaymentStation 4-Zone Structure ---');
  await withAliases(async () => {
    const React = frontendRequire('react');
    const { renderToStaticMarkup } = frontendRequire('react-dom/server');
    const TouchNumberPad = require('../frontend/src/components/pos/TouchNumberPad.tsx').default;
    const {
      CheckoutPaymentStation,
    } = require('../frontend/src/components/pos/CheckoutPaymentStation.tsx');

    const padMarkup = renderToStaticMarkup(
      React.createElement(TouchNumberPad, {
        value: '14.20',
        onChange: () => {},
        ariaLabel: 'Keypad',
        clearLabel: 'Clear amount',
        backspaceLabel: 'Backspace',
        fillHeight: true,
      }),
    );
    assert.ok(padMarkup.includes('grid-rows-4'), 'fillHeight adds grid-rows-4 to TouchNumberPad');
    assert.ok(padMarkup.includes('h-full'), 'fillHeight adds h-full to TouchNumberPad');
    assert.ok(padMarkup.includes('min-h-11'), 'fillHeight preserves >=44px button floor');

    const compactPadMarkup = renderToStaticMarkup(
      React.createElement(TouchNumberPad, {
        value: '14.20',
        onChange: () => {},
        ariaLabel: 'Keypad',
        clearLabel: 'Clear amount',
        backspaceLabel: 'Backspace',
      }),
    );
    assert.ok(
      !compactPadMarkup.includes('grid-rows-4'),
      'Default TouchNumberPad omits grid-rows-4',
    );

    const stationMarkup = renderToStaticMarkup(
      React.createElement(CheckoutPaymentStation, {
        readout: {
          activeLabel: 'Cash',
          amountText: '$14.20',
          paidSummaryText: 'Paid: $14.20',
          dueSummaryText: 'Total Due: $14.20',
          statusPillText: 'Exact',
          statusTone: 'settled',
        },
        quickTenders: [
          { label: '$14.20', subLabel: 'Exact due', active: true, onClick: () => {} },
          { label: '$15.00', active: false, onClick: () => {} },
          { label: '$20.00', active: false, onClick: () => {} },
          { label: '$50.00', active: false, onClick: () => {} },
        ],
        keypad: React.createElement(TouchNumberPad, {
          value: '14.20',
          onChange: () => {},
          ariaLabel: 'Keypad',
          clearLabel: 'Clear amount',
          backspaceLabel: 'Backspace',
          fillHeight: true,
        }),
        changeDisplay: {
          label: 'Change Returned',
          formattedAmount: '$0.00',
          visible: false,
        },
        statusBanner: {
          tone: 'error',
          message: 'Payment attempt unclear',
          nextStep: 'Check payment status before retrying.',
          technicalDetails: '{"operation":"payment.create"}',
          technicalDetailsLabel: 'Technical details',
          retryLabel: 'Check payment status',
          onRetry: () => {},
        },
        primaryAction: {
          label: 'Pay $14.20',
          disabled: false,
          onClick: () => {},
        },
      }),
    );

    assert.ok(
      stationMarkup.includes('data-testid="checkout-payment-station"'),
      'Station exposes root testid',
    );
    assert.ok(
      stationMarkup.includes('data-checkout-zone="readout"'),
      'Station includes Zone 3A live tender readout',
    );
    assert.ok(
      stationMarkup.includes('data-checkout-zone="quick-tender"'),
      'Station includes Zone 3B quick-tender strip',
    );
    assert.ok(
      stationMarkup.includes('data-checkout-zone="keypad"'),
      'Station includes Zone 3C fillHeight keypad slot',
    );
    assert.ok(
      stationMarkup.includes('data-checkout-zone="footer"'),
      'Station includes Zone 3D docked footer',
    );
    assert.ok(
      stationMarkup.includes('min-h-[52px]'),
      'Zone 3D reserves fixed status/recovery strip height',
    );
    assert.ok(
      stationMarkup.includes('Technical details') && stationMarkup.includes('Pay $14.20'),
      'Station renders technical details disclosure and primary CTA label',
    );
  });
  console.log('  ✓ TouchNumberPad fillHeight and CheckoutPaymentStation 4 zones verified');
}

function installCheckoutComponentMocks(
  harness: ReturnType<typeof createStatefulHarness>,
  overrides: {
    confirmFn?: () => Promise<boolean>;
    splitSavingRef?: { current: boolean };
    discount?: { type: 'amount' | 'percentage'; value: number; reason?: string } | null;
    apiGet?: (url: string) => Promise<any>;
    apiPost?: (url: string, body: any) => Promise<any>;
  } = {},
) {
  const Icon = () => null;
  const authState = {
    user: { id: 'u-1', name: 'Cashier', role: 'cashier' },
    token: 'token-1',
    currentTenant: { id: 1, name: 'Test Cafe', country: 'US', currency: 'USD', role: 'cashier' },
    activeServerId: null,
  };
  const chargesState = { charges: [], load: async () => {} };

  const cartState = {
    items: [
      {
        key: 'k-1',
        product: { id: 'p-1', name: 'Coffee', price: 20, category_id: 'c-1' },
        quantity: 1,
        unitPrice: 20,
        modifiers: [],
        addons: [],
      },
    ],
    orderType: 'takeaway',
    onlinePlatform: null,
    customerId: null,
    customer: null,
    optedInChargeIds: new Set<string>(),
    waivedChargeIds: new Set<string>(),
    specialInstructions: '',
    waiveCharge: () => {},
    unwaiveCharge: () => {},
    optInCharge: () => {},
    optOutCharge: () => {},
    getSubtotal: () => 20,
    getItemCount: () => 1,
    itemCount: () => 1,
  };

  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'react') return harness.hooksReact;
    if (request === 'react/jsx-runtime') return harness.jsxRuntime;
    if (request === 'next-intl' || request === 'use-intl') {
      return {
        useTranslations: () => (key: string) => key,
        useLocale: () => 'en-US',
      };
    }
    if (request === 'lucide-react') {
      return new Proxy(
        {},
        {
          get: () => Icon,
        },
      );
    }
    if (request === 'react-hot-toast') {
      const toastFn = Object.assign(() => {}, { success: () => {}, error: () => {} });
      return { __esModule: true, default: toastFn, toast: toastFn };
    }
    if (request === '@/store/auth') {
      return {
        useAuthStore: Object.assign(
          (sel?: (s: any) => any) => (typeof sel === 'function' ? sel(authState) : authState),
          { getState: () => authState },
        ),
      };
    }
    if (request === '@/store/cart') {
      return {
        useCartStore: Object.assign(
          (sel?: (s: any) => any) => (typeof sel === 'function' ? sel(cartState) : cartState),
          { getState: () => cartState },
        ),
      };
    }
    if (request === '@/store/charges') {
      return {
        useChargesStore: Object.assign(
          (sel?: (s: any) => any) => (typeof sel === 'function' ? sel(chargesState) : chargesState),
          { getState: () => chargesState },
        ),
        chargesForOrderType: () => [],
      };
    }
    if (request === '@/hooks/use-tax-preview') {
      return {
        useTaxPreview: (args: any) => {
          const disc = overrides.discount ?? args?.discount;
          const discountAmt =
            disc && disc.value > 0
              ? disc.type === 'percentage'
                ? (20 * disc.value) / 100
                : disc.value
              : 0;
          const total = Math.max(0, 20 - discountAmt);
          return {
            tax: {
              subtotal: 20,
              discount_amount: discountAmt,
              discounted_subtotal: total,
              tax_amount: 0,
              total,
              tax_breakdown: [],
              packaging_charge: 0,
              charges_breakdown: [],
              round_off: 0,
            },
            loading: false,
          };
        },
      };
    }
    if (request === '@/hooks/useFormatCurrency') {
      return {
        useFormatCurrency: () => (val: number) => `$${Number(val || 0).toFixed(2)}`,
      };
    }
    if (request === '@/hooks/useFormatNumber') {
      return {
        useFormatNumber: () => (val: number) => String(val),
      };
    }
    if (request === '@/hooks/useCurrencyUnitAdapter') {
      return {
        useCurrencyUnitAdapter: () => getCurrencyUnitAdapter('USD', 'US'),
      };
    }
    if (request === '@/hooks/useWhatsAppReady') {
      return {
        useWhatsAppReady: () => false,
      };
    }
    if (request === '@/hooks/useManagerApprovers') {
      return {
        useManagerApprovers: () => ({
          approvers: [],
          selectedApproverId: null,
          loading: false,
          loadFailed: false,
        }),
      };
    }
    if (request === '@/hooks/use-confirm') {
      return {
        useConfirm: () => ({
          confirm: overrides.confirmFn ?? (async () => true),
          ConfirmDialog: null,
        }),
      };
    }
    if (request === '@/components/ApproverSelect') {
      return { ApproverSelect: () => null };
    }
    if (request === '@/components/ui/dialog') {
      return {
        Dialog: ({ open, children }: any) =>
          open
            ? harness.hooksReact.createElement('div', { 'data-mock-dialog': true }, children)
            : null,
        DialogContent: ({ children, ...rest }: any) =>
          harness.hooksReact.createElement('div', rest, children),
        DialogHeader: ({ children }: any) =>
          harness.hooksReact.createElement('div', null, children),
        DialogTitle: ({ children }: any) => harness.hooksReact.createElement('h2', null, children),
      };
    }
    if (request === '@/components/ui/button') {
      return {
        Button: ({ children, ...rest }: any) =>
          harness.hooksReact.createElement('button', rest, children),
      };
    }
    if (request === '@/components/pos/SplitCheckModal') {
      return {
        SplitCheckModal: ({ onClose }: any) =>
          harness.hooksReact.createElement(
            'div',
            { 'data-testid': 'split-check-modal-stub', onClose },
            null,
          ),
        MIN_CHECKS: 2,
        MAX_CHECKS: 20,
      };
    }
    if (request === '@/components/pos/TaxBreakdown') {
      return { __esModule: true, default: () => null };
    }
    if (request === '@/lib/api') {
      const apiObj = {
        get: async (url: string) => {
          if (overrides.apiGet) return overrides.apiGet(url);
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('printers')) return { data: { printers: [] } };
          if (String(url).includes('settings')) return { data: { split_checks_enabled: true } };
          if (String(url).includes('/bills/')) return { data: { bill: makeBill('bill-1', 20) } };
          return { data: {} };
        },
        post: async (url: string, body: any) =>
          overrides.apiPost ? overrides.apiPost(url, body) : { data: {} },
        defaults: { headers: { common: {} } },
      };
      return {
        __esModule: true,
        default: apiObj,
        captureClientOperationFailure: async () => {},
        createOperationReference: () => 'op-ref-1',
        operationHeaders: (id: string) => ({ 'X-Operation-Id': id }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function makeBill(id: string, total = 20) {
  return {
    id,
    bill_number: `B-${id}`,
    order_id: `ord-${id}`,
    subtotal: total,
    discount_amount: 0,
    tax_amount: 0,
    total,
    balance: total,
    payment_status: 'unpaid',
    status: 'pending',
    created_at: new Date().toISOString(),
    order: {
      id: `ord-${id}`,
      order_number: 101,
      type: 'dine_in',
      items: [
        {
          id: 'item-1',
          name: 'Latte',
          product_name: 'Latte',
          quantity: 2,
          unit_price: total / 2,
          total_price: total,
        },
      ],
    },
  };
}

async function testPaymentModalLockDismissAndBillReset() {
  console.log('\n--- 3. PaymentModal Double-Submit Lock, Dismiss Handler & bill.id Reset ---');
  await withAliases(async () => {
    let resolveConfirm!: (v: boolean) => void;
    let confirmCount = 0;
    const confirmFn = () => {
      confirmCount++;
      return new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      });
    };

    const harness = createStatefulHarness();
    try {
      installCheckoutComponentMocks(harness, { confirmFn });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      let registeredDismiss: (() => boolean) | undefined;
      let closeCount = 0;
      const baseProps = {
        bill: makeBill('bill-1', 20),
        currency: 'USD',
        onClose: () => {
          closeCount++;
        },
        onPaid: () => {},
        onRegisterDismissHandler: (fn: (() => boolean) | undefined) => {
          registeredDismiss = fn;
        },
      };

      let tree = harness.renderAndSettle(PaymentModal, baseProps);

      const cashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      assert.ok(cashBtn, 'Cash tender button rendered');
      cashBtn.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, baseProps);

      const cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.ok(cashInput, 'Cash amount input rendered');
      cashInput.props.onChange({ target: { value: '10' } });
      tree = harness.renderAndSettle(PaymentModal, baseProps);

      const payButtonEl = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      const payCta = payButtonEl ? { onClick: payButtonEl.props.onClick } : null;
      assert.ok(payCta, 'Pay CTA callback found');

      // Double-submit BEFORE confirmFn resolves: second call MUST be blocked synchronously by inFlightRef!
      const p1 = payCta.onClick();
      const p2 = payCta.onClick();
      assert.equal(
        confirmCount,
        1,
        'inFlightRef acquires synchronously before await confirm(...), blocking second click',
      );
      resolveConfirm(false);
      await Promise.all([p1, p2]);

      const p3 = payCta.onClick();
      assert.equal(confirmCount, 2, 'Lock releases cleanly after declined confirm');
      resolveConfirm(false);
      await p3;

      assert.equal(
        typeof registeredDismiss,
        'function',
        'PaymentModal registers its dismiss handler for pos/page.tsx Escape coordination',
      );

      const splitBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'split-mode-items-tab',
      )[0];
      if (splitBtn) {
        splitBtn.props.onClick();
        tree = harness.renderAndSettle(PaymentModal, baseProps);
        assert.ok(
          collectElements(tree, (el) => el.props?.['data-testid'] === 'split-check-modal-stub')
            .length === 1,
          'SplitCheckModal opened inside PaymentModal',
        );
        const handledInner = registeredDismiss!();
        assert.equal(
          handledInner,
          true,
          'Dismiss handler claims Escape while SplitCheckModal open',
        );
        assert.equal(closeCount, 0, 'Dismissing inner SplitCheckModal does NOT close PaymentModal');
        tree = harness.renderAndSettle(PaymentModal, baseProps);
      }

      const handledOuter = registeredDismiss!();
      assert.equal(handledOuter, true, 'Dismiss handler returns true on outer close');
      assert.equal(closeCount, 1, 'Idle dismiss handler invokes onClose once');

      const cardBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCard',
      )[0];
      if (cardBtn) {
        cardBtn.props.onClick();
        tree = harness.renderAndSettle(PaymentModal, baseProps);
      }

      const bill2Props = {
        ...baseProps,
        bill: makeBill('bill-2', 35),
      };
      const bill2Tree = harness.renderAndSettle(PaymentModal, bill2Props);
      const bill2CashInput = collectElements(
        bill2Tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        bill2CashInput ? bill2CashInput.props.value : '',
        '',
        'Switching bill.id resets stale tender inputs from previous bill',
      );
      const bill2CardRefInputs = collectElements(
        bill2Tree,
        (el) =>
          el.type === 'input' &&
          el.props?.id === 'payment-card-transaction-id' &&
          !el.props?.disabled,
      );
      assert.equal(
        bill2CardRefInputs.length,
        0,
        'Switching bill.id resets active Card selection / card terminal reference state',
      );

      // Auto-filling Cash on bill-2 then switching bill.id to bill-3 with a different balance
      // must NOT overwrite the empty reset with bill-2's rescaled auto-fill amount.
      const bill2CashBtn = collectElements(
        bill2Tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      assert.ok(bill2CashBtn, 'bill-2 Cash tender button rendered');
      bill2CashBtn.props.onClick();
      const bill2FilledTree = harness.renderAndSettle(PaymentModal, bill2Props);
      const bill2FilledInput = collectElements(
        bill2FilledTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(bill2FilledInput?.props?.value, '35', 'Auto-filled Cash matches bill-2 balance');

      const bill3Props = { ...baseProps, bill: makeBill('bill-3', 50) };
      const bill3Tree = harness.renderAndSettle(PaymentModal, bill3Props);
      const bill3CashInput = collectElements(
        bill3Tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        bill3CashInput ? bill3CashInput.props.value : '',
        '',
        'Switching bill.id with a new balance does not rescale auto-filled tender from prior bill',
      );
    } finally {
      harness.cleanupAll();
    }
  });
  console.log('  ✓ PaymentModal pre-confirm lock, dismiss handler, and bill.id reset verified');
}

async function testPaymentModalSettledDismissAndRestoredAttempt() {
  console.log('\n--- 3b. PaymentModal justPaid Dismiss & Restored Attempt Settled Amount ---');
  await withAliases(async () => {
    const orderAttempt = require('../frontend/src/lib/order-attempt.ts');
    const storageMap = new Map<string, string>();
    const prevWindow = (globalThis as any).window;
    const hadWindow = 'window' in globalThis;
    (globalThis as any).window = {
      ...(prevWindow || {}),
      sessionStorage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => {
          storageMap.set(k, v);
        },
        removeItem: (k: string) => {
          storageMap.delete(k);
        },
      },
    };

    const harness = createStatefulHarness();
    try {
      const storageKey = orderAttempt.getPostpaidPaymentAttemptStorageKey('u-1', 1, 'bill-restored');
      orderAttempt.savePostpaidPaymentAttempt((globalThis as any).window.sessionStorage, storageKey, {
        userId: 'u-1',
        storeId: 1,
        billId: 'bill-restored',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        key: '33333333-3333-4333-8333-333333333333',
        operationId: '44444444-4444-4444-8444-444444444444',
        zeroBalance: false,
        lines: [{ method: 'cash', amount: 30 }],
        customerId: null,
        paymentFingerprint: '[{"method":"cash","amount":30}]',
      });

      const restoredBill = makeBill('bill-restored', 25);
      installCheckoutComponentMocks(harness, {
        apiGet: async (url: string) => {
          if (String(url).includes('/bills/bill-restored')) {
            return {
              data: {
                bill: { ...restoredBill, payment_status: 'paid', balance: 0, paid_amount: 25 },
              },
            };
          }
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { payment_methods: [] } };
          if (String(url).includes('settings')) return { data: { split_checks_enabled: true } };
          return { data: {} };
        },
        apiPost: async () => ({
          data: {
            bill: { ...restoredBill, payment_status: 'paid', balance: 0, paid_amount: 25 },
            loyaltyPointsEarned: 0,
          },
        }),
      });

      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      let registeredDismiss: (() => boolean) | undefined;
      let closeCount = 0;
      let paidCount = 0;
      let activeBill: any = restoredBill;
      const makeProps = () => ({
        bill: activeBill,
        currency: 'USD',
        onClose: () => {
          closeCount++;
        },
        onPaid: () => {
          paidCount++;
        },
        onBillUpdate: (updated: any) => {
          activeBill = updated;
        },
        onRegisterDismissHandler: (fn: (() => boolean) | undefined) => {
          registeredDismiss = fn;
        },
      });

      let tree = harness.renderAndSettle(PaymentModal, makeProps());

      // 1. Check payment status (updates bill.balance to 0) then replay the restored attempt
      const ctaCheck = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      assert.ok(ctaCheck, 'Check payment status CTA rendered');
      await ctaCheck.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, makeProps());

      const ctaRetry = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      assert.ok(ctaRetry, 'Retry same payment CTA rendered');
      await ctaRetry.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, makeProps());

      // Settled receipt view must show $25.00, NOT $0.00
      const receiptText = renderToStaticMarkup(tree);
      assert.ok(
        receiptText.includes('$25.00') && !receiptText.includes('$0.00'),
        `Replayed restored attempt displays settled $25.00 (got ${receiptText})`,
      );

      // Escape dismiss handler and header close button must both invoke onPaid() when justPaid === true
      assert.equal(typeof registeredDismiss, 'function');
      registeredDismiss!();
      assert.equal(paidCount, 1, 'Escape dismiss after justPaid invokes onPaid');
      assert.equal(closeCount, 0, 'Escape dismiss after justPaid does not call onClose');

      const headerCloseBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'close',
      )[0];
      assert.ok(headerCloseBtn, 'Header close button rendered');
      headerCloseBtn.props.onClick();
      assert.equal(paidCount, 2, 'Header close after justPaid invokes onPaid');
      assert.equal(closeCount, 0, 'Header close after justPaid does not call onClose');
    } finally {
      harness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });
  console.log('  ✓ PaymentModal settled dismiss and restored attempt amount verified');
}

async function testPrepaidAutoFillTracksDiscountUpdates() {
  console.log('\n--- 4. PrepaidCheckoutModal Auto-Filled Tender Tracks Discounts ---');
  await withAliases(async () => {
    const harness = createStatefulHarness();
    const hadWindow = 'window' in globalThis;
    const prevWindow = (globalThis as any).window;
    if (!hadWindow) {
      (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
    }
    try {
      const overrideState: {
        discount: { type: 'amount' | 'percentage'; value: number; reason?: string } | null;
      } = {
        discount: null,
      };
      installCheckoutComponentMocks(harness, {
        get discount() {
          return overrideState.discount;
        },
      });
      const prepaidPath = path.resolve(
        ROOT,
        'frontend/src/components/pos/PrepaidCheckoutModal.tsx',
      );
      delete require.cache[prepaidPath];
      const PrepaidCheckoutModal = require(prepaidPath).default;

      const props = {
        currency: 'USD',
        onClose: () => {},
        onConfirm: async () => {},
        initialDiscount: null as {
          type: 'amount' | 'percentage';
          value: number;
          reason?: string;
        } | null,
      };

      // Click Cash button to auto-fill remaining due (20) -> tracks single auto-filled tender
      let tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      const cashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      assert.ok(cashBtn, 'Prepaid Cash button present');
      cashBtn.props.onClick();
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      let cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.ok(cashInput, 'Prepaid Cash input present');
      assert.equal(cashInput.props.value, '20', 'Initial auto-filled Cash equals 20');

      // Apply $5 discount via Col 1 Discount panel: auto-filled Cash updates to 15
      overrideState.discount = { type: 'amount', value: 5, reason: 'promo' };
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        cashInput.props.value,
        '15',
        'Single auto-filled tender updates automatically when discount lowers due amount',
      );

      // User manually edits Cash to 25 -> applying another discount preserves manual entry
      cashInput.props.onChange({ target: { value: '25' } });
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      overrideState.discount = { type: 'amount', value: 8, reason: 'promo' };
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        cashInput.props.value,
        '25',
        'Manually edited Cash amount stays preserved across subsequent discount edits',
      );
    } finally {
      harness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });
  console.log('  ✓ PrepaidCheckoutModal auto-fill discount tracking verified');
}

async function testExactQuickValuesAndDiscountTargetReset() {
  console.log('\n--- 4b. Exact Quick Value Precision & Discount AmountTarget Reset ---');
  await withAliases(async () => {
    const harness = createStatefulHarness();
    const hadWindow = 'window' in globalThis;
    const prevWindow = (globalThis as any).window;
    if (!hadWindow) {
      (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
    }
    try {
      installCheckoutComponentMocks(harness, {
        apiGet: async (url: string) => {
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('discount')) {
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          }
          if (String(url).includes('payment-methods')) return { data: { payment_methods: [] } };
          if (String(url).includes('settings')) return { data: { split_checks_enabled: true } };
          return { data: {} };
        },
      });

      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      const floatProps = {
        bill: makeBill('bill-float', 57.78),
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      };
      let tree = harness.renderAndSettle(PaymentModal, floatProps);

      // Enter 10.10 in Card -> 57.78 - 10.10 in IEEE-754 float is 47.68000000000001
      const cardInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      assert.ok(cardInput, 'Card amount input rendered');
      cardInput.props.onChange({ target: { value: '10.10' } });
      tree = harness.renderAndSettle(PaymentModal, floatProps);

      const exactQuickBtn = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.onClick === 'function' &&
          renderToStaticMarkup(el).includes('exactAmount'),
      )[0];
      assert.ok(exactQuickBtn, 'Keypad Exact quick-value button rendered');
      exactQuickBtn.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);

      const cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        cashInput?.props?.value,
        '47.68',
        'Exact quick value uses minor-unit math without IEEE-754 float drift',
      );

      // Focus discount input in Col 1, then leave Discount panel -> amountTarget returns to payment
      const discountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      assert.ok(discountTab, 'PaymentModal discount tab button rendered');
      discountTab.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);

      const discountInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      assert.ok(discountInput, 'PaymentModal discount input rendered');
      discountInput.props.onFocus();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      assert.ok(
        renderToStaticMarkup(tree).includes('5%'),
        'Focusing discount input switches quick tenders to discount percentages',
      );

      discountTab.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      assert.ok(
        !renderToStaticMarkup(tree).includes('5%'),
        'Closing discount panel resets amountTarget away from discount',
      );

      // PrepaidCheckoutModal: focus discount input then click Done -> amountTarget resets to payment
      const prepaidPath = path.resolve(
        ROOT,
        'frontend/src/components/pos/PrepaidCheckoutModal.tsx',
      );
      delete require.cache[prepaidPath];
      const PrepaidCheckoutModal = require(prepaidPath).default;
      const prepaidProps = {
        currency: 'USD',
        onClose: () => {},
        onConfirm: async () => {},
      };
      let prepaidTree = harness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      const prepaidDiscountToggle = collectElements(
        prepaidTree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.['aria-expanded'] === 'boolean' &&
          renderToStaticMarkup(el).includes('discounts'),
      )[0];
      assert.ok(prepaidDiscountToggle, 'PrepaidCheckoutModal discount toggle rendered');
      prepaidDiscountToggle.props.onClick();
      prepaidTree = harness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);

      const prepaidDiscountInput = collectElements(
        prepaidTree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      assert.ok(prepaidDiscountInput, 'PrepaidCheckoutModal discount input rendered');
      prepaidDiscountInput.props.onFocus();
      prepaidTree = harness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      assert.ok(
        renderToStaticMarkup(prepaidTree).includes('5%'),
        'Focusing prepaid discount input switches quick tenders to discount percentages',
      );

      const prepaidDoneBtn = collectElements(
        prepaidTree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.onClick === 'function' &&
          renderToStaticMarkup(el).includes('done'),
      )[0];
      assert.ok(prepaidDoneBtn, 'PrepaidCheckoutModal discount Done button rendered');
      prepaidDoneBtn.props.onClick();
      prepaidTree = harness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      assert.ok(
        !renderToStaticMarkup(prepaidTree).includes('5%'),
        'Done button in prepaid discount panel resets amountTarget away from discount',
      );
    } finally {
      harness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });
  console.log('  ✓ Exact quick-value precision and discount amountTarget reset verified');
}

async function testPosPageEscapeAndSessionGuards() {
  console.log(
    '\n--- 5. pos/page.tsx Escape Delegation & Token-Rotation Continuity + Postpaid Attempt Storage ---',
  );
  await withAliases(async () => {
    const orderAttempt = require('../frontend/src/lib/order-attempt.ts');
    assert.equal(
      typeof orderAttempt.getPostpaidPaymentAttemptStorageKey,
      'function',
      'order-attempt exports session-scoped postpaid key helper',
    );
    assert.equal(
      typeof orderAttempt.savePostpaidPaymentAttempt,
      'function',
      'order-attempt exports savePostpaidPaymentAttempt',
    );
    assert.equal(
      typeof orderAttempt.loadPostpaidPaymentAttempt,
      'function',
      'order-attempt exports loadPostpaidPaymentAttempt',
    );
    assert.equal(
      typeof orderAttempt.clearPostpaidPaymentAttempt,
      'function',
      'order-attempt exports clearPostpaidPaymentAttempt',
    );

    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    const keyUser1 = orderAttempt.getPostpaidPaymentAttemptStorageKey(
      'user-1',
      'store-1',
      'bill-9',
    );
    const keyUser2 = orderAttempt.getPostpaidPaymentAttemptStorageKey(
      'user-2',
      'store-1',
      'bill-9',
    );
    assert.notEqual(keyUser1, keyUser2, 'Postpaid payment attempt keys are user-scoped');

    orderAttempt.savePostpaidPaymentAttempt(storage, keyUser1, {
      userId: 'user-1',
      storeId: 'store-1',
      billId: 'bill-9',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      paymentFingerprint: '{"payments":[]}',
    });
    assert.equal(
      orderAttempt.loadPostpaidPaymentAttempt(storage, keyUser1)?.idempotencyKey,
      '22222222-2222-4222-8222-222222222222',
    );
    assert.equal(
      orderAttempt.loadPostpaidPaymentAttempt(storage, keyUser2),
      null,
      'Cashier 2 does not read Cashier 1 postpaid attempt',
    );
    orderAttempt.clearPostpaidPaymentAttempt(storage, keyUser1);
    assert.equal(orderAttempt.loadPostpaidPaymentAttempt(storage, keyUser1), null);
  });

  const posPageSource = fs.readFileSync(
    path.resolve(ROOT, 'frontend/src/app/(dashboard)/pos/page.tsx'),
    'utf8',
  );
  assert.ok(
    posPageSource.includes('paymentModalDismissRef'),
    'pos/page.tsx delegates Escape dismissal through paymentModalDismissRef',
  );
  assert.ok(
    posPageSource.includes('setPrepaidModalAttempt(safeAttempt)'),
    'pos/page.tsx keeps prepaidModalAttempt synchronized across retries',
  );
  assert.ok(
    posPageSource.includes('liveAuthHeadersFor'),
    'pos/page.tsx reads rotated live auth token on in-flight checkout retries',
  );
  console.log('  ✓ Postpaid attempt storage and pos/page.tsx Escape/retry sync verified');
}

async function run() {
  await testQuickTenderAndMinorMath();
  await testTouchNumberPadAndStationStructure();
  await testPaymentModalLockDismissAndBillReset();
  await testPaymentModalSettledDismissAndRestoredAttempt();
  await testPrepaidAutoFillTracksDiscountUpdates();
  await testExactQuickValuesAndDiscountTargetReset();
  await testPosPageEscapeAndSessionGuards();
  console.log('\n✅ All checkout quick-tender and guard tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
