/**
 * Unit + React-harness tests for 3-column POS checkout quick-tender helpers,
 * TouchNumberPad fillHeight, CheckoutPaymentStation 4-zone structure,
 * and PaymentModal / PrepaidCheckoutModal concurrency & state guards.
 *
 * Run: npm run test:checkout-quick-tender-and-guards
 */

import assert from 'node:assert/strict';
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
const RealReact = frontendRequire('react');
const RealJsxRuntime = frontendRequire('react/jsx-runtime');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');
const useIntlPath = frontendRequire.resolve('use-intl');

function collectElements(node: unknown, predicate: (el: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, any> };
  if (predicate(el)) out.push(el);
  if (typeof el.type === 'function') {
    try {
      const rendered = (el.type as (p: any) => unknown)(el.props || {});
      collectElements(rendered, predicate, out);
    } catch {
      // Fall through to children traversal if component relies on unmocked context
    }
  }
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

  const hooksReact = {
    ...RealReact,
    createElement: RealReact.createElement,
    Fragment: RealReact.Fragment,
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
    jsxRuntime: RealJsxRuntime,
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

    const pressPadKey = (currentValue: string, label: string, max?: number) => {
      let nextValue = currentValue;
      const tree = TouchNumberPad({
        value: currentValue,
        onChange: (val: string) => {
          nextValue = val;
        },
        ariaLabel: 'Keypad',
        clearLabel: 'Clear amount',
        backspaceLabel: 'Backspace',
        max,
      });
      const buttons = collectElements(tree, (el) => el.type === 'button');
      const button = buttons.find((el) => el.props?.children === label);
      assert.ok(button, `TouchNumberPad should render "${label}" button`);
      button.props.onClick();
      return nextValue;
    };

    const afterDoubleZeroFromEmpty = pressPadKey('', '00');
    assert.equal(afterDoubleZeroFromEmpty, '0', '00 from empty yields single 0');
    assert.equal(pressPadKey(afterDoubleZeroFromEmpty, '5'), '5', '5 after 00 yields 5, not 005');
    assert.equal(pressPadKey('0', '00'), '0', '00 from 0 stays 0');
    assert.equal(pressPadKey('5', '00'), '500', '00 after non-zero appends 00');
    assert.equal(pressPadKey('5.', '00'), '5.00', '00 after decimal point appends 00');
    assert.equal(pressPadKey('5', '00', 250), '250', '00 clamps against max');

    const stationMarkup = renderToStaticMarkup(
      React.createElement(
        CheckoutPaymentStation,
        {
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
            closeLabel: 'Close',
          },
        },
        React.createElement('button', { type: 'button', onClick: () => {} }, 'Pay $14.20'),
      ),
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
      stationMarkup.indexOf('data-checkout-zone="keypad"') <
        stationMarkup.indexOf('data-testid="checkout-change-slot"'),
      'Change returned slot renders below keypad zone',
    );
    assert.ok(
      stationMarkup.includes('min-h-[52px]'),
      'Zone 3D reserves fixed status/recovery strip height',
    );
    assert.ok(
      stationMarkup.includes('Technical details') && stationMarkup.includes('Pay $14.20'),
      'Station renders technical details disclosure and child primary CTA',
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
    apiPatch?: (url: string, body: any) => Promise<any>;
    charges?: any[];
    chargesBreakdown?: any[];
    optedInChargeIds?: Set<string>;
    onToggleWaiveCharge?: (id: string) => void;
    onToggleOptedInCharge?: (id: string) => void;
  } = {},
) {
  const Icon = () => null;
  const authState = {
    user: { id: 'u-1', name: 'Cashier', role: 'cashier' },
    token: 'token-1',
    currentTenant: { id: 1, name: 'Test Cafe', country: 'US', currency: 'USD', role: 'cashier' },
    activeServerId: null,
  };
  const chargesState = { charges: overrides.charges || [], load: async () => {} };

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
    optedInChargeIds: overrides.optedInChargeIds || new Set<string>(),
    waivedChargeIds: new Set<string>(),
    specialInstructions: '',
    waiveCharge: () => {},
    unwaiveCharge: () => {},
    optInCharge: () => {},
    optOutCharge: () => {},
    toggleWaiveCharge: overrides.onToggleWaiveCharge || (() => {}),
    toggleOptedInCharge: overrides.onToggleOptedInCharge || (() => {}),
    getSubtotal: () => 20,
    getItemCount: () => 1,
    itemCount: () => 1,
  };

  for (const rel of [
    'frontend/src/components/pos/CheckoutPaymentStation.tsx',
    'frontend/src/components/pos/TouchNumberPad.tsx',
    'frontend/src/components/pos/TaxBreakdown.tsx',
  ]) {
    delete require.cache[path.resolve(ROOT, rel)];
  }

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
        chargesForOrderType: () => overrides.charges || [],
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
              charges_breakdown: overrides.chargesBreakdown || [],
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
    if (request === '@/lib/api') {
      const apiObj = {
        get: async (url: string) => {
          if (overrides.apiGet) return overrides.apiGet(url);
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('printers')) return { data: { printers: [] } };
          if (String(url).includes('settings/discount'))
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          if (String(url).includes('settings')) return { data: { setting: { value: 'true' } } };
          if (String(url).includes('/bills/')) return { data: { bill: makeBill('bill-1', 20) } };
          return { data: {} };
        },
        post: async (url: string, body: any) =>
          overrides.apiPost ? overrides.apiPost(url, body) : { data: {} },
        patch: async (url: string, body: any) =>
          overrides.apiPatch ? overrides.apiPatch(url, body) : { data: {} },
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

      await new Promise((resolve) => setTimeout(resolve, 10));
      tree = harness.renderAndSettle(PaymentModal, baseProps);

      const splitBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'split-mode-items-tab',
      )[0];
      assert.ok(splitBtn, 'split-mode-items-tab renders when split_checks_enabled setting is true');
      splitBtn.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, baseProps);
      const openSplitBtn = collectElements(
        tree,
        (el) =>
          typeof el.props?.onClick === 'function' &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes('splitCheck') &&
          !el.props?.disabled,
      )[0];
      assert.ok(openSplitBtn, 'Split Check action button renders and is enabled');
      await openSplitBtn.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, baseProps);
      assert.ok(
        collectElements(tree, (el) => el.props?.['data-testid'] === 'split-check-modal-stub')
          .length === 1,
        'SplitCheckModal opened inside PaymentModal',
      );
      const handledInner = registeredDismiss!();
      assert.equal(handledInner, true, 'Dismiss handler claims Escape while SplitCheckModal open');
      assert.equal(closeCount, 0, 'Dismissing inner SplitCheckModal does NOT close PaymentModal');
      tree = harness.renderAndSettle(PaymentModal, baseProps);
      assert.equal(
        collectElements(tree, (el) => el.props?.['data-testid'] === 'split-check-modal-stub')
          .length,
        0,
        'SplitCheckModal closed after inner dismiss',
      );

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
      const storageKey = orderAttempt.getPostpaidPaymentAttemptStorageKey(
        'u-1',
        1,
        'bill-restored',
      );
      orderAttempt.savePostpaidPaymentAttempt(
        (globalThis as any).window.sessionStorage,
        storageKey,
        {
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
        },
      );

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
      const receiptCard = collectElements(tree, (el) => el.props?.role === 'status')[0];
      assert.ok(receiptCard, 'Settled receipt status card rendered');
      const receiptText = renderToStaticMarkup(receiptCard);
      assert.ok(
        receiptText.includes('$25.00') && !receiptText.includes('$0.00'),
        `Replayed restored attempt displays settled $25.00 (got ${receiptText})`,
      );

      // Column 1 and Column 2 mutation controls must all be disabled once justPaid === true
      const settledDiscountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      assert.equal(
        settledDiscountTab?.props?.disabled,
        true,
        'col1-tab-discount is disabled once justPaid is true',
      );
      const settledCashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      const settledCashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      const settledCardInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      assert.equal(
        settledCashBtn?.props?.disabled,
        true,
        'Built-in tender buttons are disabled once justPaid is true',
      );
      assert.equal(
        settledCashInput?.props?.disabled && settledCardInput?.props?.disabled,
        true,
        'Built-in tender inputs are disabled once justPaid is true',
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

      // Non-cash (Card) row offers only the Exact pill; Cash row keeps cash denomination pills
      cashInput.props.onFocus();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      const cashQuickZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'quick-tender',
      )[0];
      const cashQuickButtons = collectElements(cashQuickZone, (el) => el.type === 'button');
      assert.ok(
        cashQuickButtons.length > 1,
        'Cash row quick-tender strip offers rounded denomination pills in addition to exact',
      );

      cardInput.props.onFocus();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      const cardQuickZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'quick-tender',
      )[0];
      const cardQuickButtons = collectElements(cardQuickZone, (el) => el.type === 'button');
      assert.equal(
        cardQuickButtons.length,
        1,
        'Non-cash card row offers only the Exact quick-tender pill',
      );
      assert.ok(
        renderToStaticMarkup(cardQuickButtons[0]).includes('exactAmount'),
        'Single card quick-tender pill is labeled Exact',
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

      const openDiscountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      openDiscountTab.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      assert.ok(
        !renderToStaticMarkup(tree).includes('5%'),
        'Closing discount panel resets amountTarget away from discount',
      );

      const detailsToggle = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.['aria-expanded'] === 'boolean' &&
          String(el.props?.className || '').includes('lg:hidden'),
      )[0];
      assert.ok(detailsToggle, 'PaymentModal mobile details toggle rendered');
      detailsToggle.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      const reopenDiscountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      reopenDiscountTab.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      const reopenDiscountInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      reopenDiscountInput.props.onFocus();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      assert.ok(renderToStaticMarkup(tree).includes('5%'));
      const openDetailsToggle = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] === true &&
          String(el.props?.className || '').includes('lg:hidden'),
      )[0];
      assert.ok(openDetailsToggle, 'PaymentModal details toggle stays expanded when opened');
      openDetailsToggle.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, floatProps);
      assert.ok(
        !renderToStaticMarkup(tree).includes('5%'),
        'Closing details drawer resets amountTarget away from discount',
      );

      // Opening Tax sub-panel shows the total header and each component row once (no duplicate rows)
      const taxBillProps = {
        ...floatProps,
        bill: {
          ...makeBill('bill-tax', 57.78),
          tax_amount: 2.75,
          tax_breakdown: [{ title: 'VAT', rate: 5, amount: 2.75 }],
        },
      };
      tree = harness.renderAndSettle(PaymentModal, taxBillProps);
      const pmTaxToggle = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.['aria-expanded'] === 'boolean' &&
          !String(el.props?.className || '').includes('lg:hidden') &&
          renderToStaticMarkup(el).includes('tax'),
      )[0];
      assert.ok(pmTaxToggle, 'PaymentModal Tax panel toggle rendered');
      pmTaxToggle.props.onClick();
      tree = harness.renderAndSettle(PaymentModal, taxBillProps);
      const pmTaxMarkup = renderToStaticMarkup(tree);
      assert.equal(
        pmTaxMarkup.split('VAT (5%)').length - 1,
        1,
        'PaymentModal Tax sub-panel renders each tax component row once',
      );

      // Same-bill update on an undiscounted bill preserves open 'tax' panel instead of resetting to 'items'
      const refreshedSameBillProps = {
        ...taxBillProps,
        bill: { ...taxBillProps.bill, total: 55.78 },
      };
      tree = harness.renderAndSettle(PaymentModal, refreshedSameBillProps);
      assert.equal(
        renderToStaticMarkup(tree).split('VAT (5%)').length - 1,
        1,
        'Same-bill update preserves open Tax sub-panel when bill has no discount',
      );

      // PrepaidCheckoutModal: non-cash quick tenders, rendered layout, and Done/details discount reset
      harness.cleanupAll();
      const prepaidHarness = createStatefulHarness();
      installCheckoutComponentMocks(prepaidHarness, {
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
      let prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      await new Promise((resolve) => setTimeout(resolve, 0));
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      const initialPrepaidMarkup = renderToStaticMarkup(prepaidTree);
      assert.ok(
        !initialPrepaidMarkup.includes('bg-gradient-to-br from-slate-800 to-slate-900'),
        'Rendered PrepaidCheckoutModal does not restore the oversized total card',
      );
      assert.ok(
        initialPrepaidMarkup.includes('discounts') &&
          initialPrepaidMarkup.indexOf('data-checkout-zone="keypad"') <
            initialPrepaidMarkup.indexOf('data-testid="checkout-change-slot"'),
        'Rendered PrepaidCheckoutModal retains discounts control and renders change slot below keypad',
      );

      const prepaidCashInput = collectElements(
        prepaidTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.ok(prepaidCashInput, 'PrepaidCheckoutModal cash amount input rendered');
      prepaidCashInput.props.onChange({ target: { value: '5.00' } });
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      const prepaidCashQuickZone = collectElements(
        prepaidTree,
        (el) => el.props?.['data-checkout-zone'] === 'quick-tender',
      )[0];
      assert.ok(
        collectElements(prepaidCashQuickZone, (el) => el.type === 'button').length > 1,
        'PrepaidCheckoutModal cash row keeps rounded cash denomination pills',
      );

      const prepaidCardInput = collectElements(
        prepaidTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      assert.ok(prepaidCardInput, 'PrepaidCheckoutModal card amount input rendered');
      prepaidCardInput.props.onFocus();
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      const prepaidCardQuickZone = collectElements(
        prepaidTree,
        (el) => el.props?.['data-checkout-zone'] === 'quick-tender',
      )[0];
      const prepaidCardQuickButtons = collectElements(
        prepaidCardQuickZone,
        (el) => el.type === 'button',
      );
      assert.equal(
        prepaidCardQuickButtons.length,
        1,
        'PrepaidCheckoutModal non-cash card row offers only the Exact quick-tender pill',
      );
      assert.ok(
        renderToStaticMarkup(prepaidCardQuickButtons[0]).includes('exactAmount'),
        'PrepaidCheckoutModal single card quick-tender pill is labeled Exact',
      );
      const prepaidDiscountToggle = collectElements(
        prepaidTree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.['aria-expanded'] === 'boolean' &&
          renderToStaticMarkup(el).includes('discounts'),
      )[0];
      assert.ok(prepaidDiscountToggle, 'PrepaidCheckoutModal discount toggle rendered');
      prepaidDiscountToggle.props.onClick();
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);

      const prepaidDiscountInput = collectElements(
        prepaidTree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      assert.ok(prepaidDiscountInput, 'PrepaidCheckoutModal discount input rendered');
      prepaidDiscountInput.props.onFocus();
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
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
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      assert.ok(
        !renderToStaticMarkup(prepaidTree).includes('5%'),
        'Done button in prepaid discount panel resets amountTarget away from discount',
      );
      prepaidHarness.cleanupAll();

      // Order-committed lock prevents mutating cart charge toggles while modal remains open
      const chargeHarness = createStatefulHarness();
      const chargeMutations: string[] = [];
      installCheckoutComponentMocks(chargeHarness, {
        charges: [
          {
            id: 'service_charge',
            name: 'Service Charge',
            is_optional: true,
            is_default_active: true,
          },
          {
            id: 'opted_addon',
            name: 'Opted Addon',
            is_optional: false,
            is_default_active: false,
          },
          {
            id: 'available_addon',
            name: 'Available Addon',
            is_optional: false,
            is_default_active: false,
          },
        ],
        chargesBreakdown: [
          { id: 'service_charge', name: 'Service Charge', amount: 2, waived: false },
          { id: 'opted_addon', name: 'Opted Addon', amount: 1, waived: false },
        ],
        optedInChargeIds: new Set(['opted_addon']),
        onToggleWaiveCharge: (id) => chargeMutations.push(`waive:${id}`),
        onToggleOptedInCharge: (id) => chargeMutations.push(`opt:${id}`),
      });
      delete require.cache[prepaidPath];
      const ChargePrepaidModal = require(prepaidPath).default;
      const findChargeButtons = (tree: any) => {
        const rows = collectElements(tree, (el) =>
          String(el.props?.['data-testid'] || '').startsWith('prepaid-charge-'),
        );
        return collectElements(rows, (el) => el.type === 'button');
      };

      const uncommittedTree = chargeHarness.renderAndSettle(ChargePrepaidModal, {
        ...prepaidProps,
        orderCommitted: false,
      });
      const uncommittedButtons = findChargeButtons(uncommittedTree);
      assert.equal(uncommittedButtons.length, 3, 'All three charge toggle buttons render');
      for (const btn of uncommittedButtons) {
        assert.equal(
          Boolean(btn.props.disabled),
          false,
          'Charge toggle enabled before order commit',
        );
        btn.props.onClick();
      }
      assert.deepEqual(chargeMutations, [
        'waive:service_charge',
        'opt:opted_addon',
        'opt:available_addon',
      ]);

      chargeMutations.length = 0;
      const committedTree = chargeHarness.renderAndSettle(ChargePrepaidModal, {
        ...prepaidProps,
        orderCommitted: true,
      });
      const committedButtons = findChargeButtons(committedTree);
      assert.equal(committedButtons.length, 3, 'All three charge toggle buttons remain rendered');
      for (const btn of committedButtons) {
        assert.equal(btn.props.disabled, true, 'Charge toggle disabled after order commit');
        btn.props.onClick();
      }
      assert.deepEqual(
        chargeMutations,
        [],
        'Order-committed lock blocks all cart charge mutations',
      );
      chargeHarness.cleanupAll();

      // Committed-discount lock prevents editing/clearing discount via panel, quick-tenders, or keypad
      const discountLockHarness = createStatefulHarness();
      installCheckoutComponentMocks(discountLockHarness, {
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
      delete require.cache[prepaidPath];
      const DiscountLockPrepaidModal = require(prepaidPath).default;
      const baseDiscountProps = {
        ...prepaidProps,
        discountCommitted: false,
      };
      let discountTree = discountLockHarness.renderAndSettle(
        DiscountLockPrepaidModal,
        baseDiscountProps,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      discountTree = discountLockHarness.renderAndSettle(
        DiscountLockPrepaidModal,
        baseDiscountProps,
      );

      const openDiscountBtn = collectElements(
        discountTree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.['aria-expanded'] === 'boolean' &&
          renderToStaticMarkup(el).includes('discounts'),
      )[0];
      openDiscountBtn.props.onClick();
      discountTree = discountLockHarness.renderAndSettle(
        DiscountLockPrepaidModal,
        baseDiscountProps,
      );

      const discValInput = collectElements(
        discountTree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      const discReasonInput = collectElements(
        discountTree,
        (el) =>
          el.type === 'input' &&
          el.props?.type === 'text' &&
          el.props?.placeholder === 'discountReasonPlaceholder',
      )[0];
      discValInput.props.onFocus();
      discValInput.props.onChange({ target: { value: '10' } });
      discReasonInput.props.onChange({ target: { value: 'VIP' } });
      discountTree = discountLockHarness.renderAndSettle(
        DiscountLockPrepaidModal,
        baseDiscountProps,
      );
      assert.ok(
        renderToStaticMarkup(discountTree).includes('5%'),
        'Uncommitted discount focus activates percentage quick-tenders',
      );

      const committedDiscountProps = {
        ...prepaidProps,
        discountCommitted: true,
        initialDiscount: { type: 'percentage' as const, value: 10, reason: 'VIP' },
      };
      discountTree = discountLockHarness.renderAndSettle(
        DiscountLockPrepaidModal,
        committedDiscountProps,
      );
      assert.ok(
        !renderToStaticMarkup(discountTree).includes('5%'),
        'Committing discount clears discount keypad target away from percentage quick-tenders',
      );

      const committedDiscValInput = collectElements(
        discountTree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      const committedDiscReasonInput = collectElements(
        discountTree,
        (el) =>
          el.type === 'input' &&
          el.props?.type === 'text' &&
          el.props?.placeholder === 'discountReasonPlaceholder',
      )[0];
      const committedFlatBtn = collectElements(
        discountTree,
        (el) => el.type === 'button' && renderToStaticMarkup(el).includes('flatAmount'),
      )[0];
      const committedRemoveBtn = collectElements(
        discountTree,
        (el) => el.type === 'button' && renderToStaticMarkup(el).includes('remove'),
      )[0];
      assert.equal(
        committedDiscValInput.props.disabled,
        true,
        'Discount value disabled after commit',
      );
      assert.equal(
        committedDiscReasonInput.props.disabled,
        true,
        'Discount reason disabled after commit',
      );
      assert.equal(
        committedFlatBtn.props.disabled,
        true,
        'Discount type toggle disabled after commit',
      );
      assert.equal(
        committedRemoveBtn.props.disabled,
        true,
        'Discount remove disabled after commit',
      );

      committedFlatBtn.props.onClick();
      committedDiscValInput.props.onFocus();
      committedDiscValInput.props.onChange({ target: { value: '25' } });
      committedDiscReasonInput.props.onChange({ target: { value: 'Changed' } });
      committedRemoveBtn.props.onClick();
      discountTree = discountLockHarness.renderAndSettle(
        DiscountLockPrepaidModal,
        committedDiscountProps,
      );

      const afterValInput = collectElements(
        discountTree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      const afterReasonInput = collectElements(
        discountTree,
        (el) =>
          el.type === 'input' &&
          el.props?.type === 'text' &&
          el.props?.placeholder === 'discountReasonPlaceholder',
      )[0];
      assert.equal(afterValInput.props.value, '10', 'Committed discount value cannot be mutated');
      assert.equal(
        afterReasonInput.props.value,
        'VIP',
        'Committed discount reason cannot be mutated',
      );
      assert.ok(
        !renderToStaticMarkup(discountTree).includes('5%'),
        'Focusing committed discount input does not restore discount quick-tenders',
      );
      discountLockHarness.cleanupAll();
    } finally {
      harness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }

    // Opening PaymentModal with initialOverridePin opens mobile details drawer so kitchen-override is visible <lg
    const overrideHarness = createStatefulHarness();
    const prevWindowOverride = (globalThis as any).window;
    if (!hadWindow) {
      (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
    }
    try {
      installCheckoutComponentMocks(overrideHarness);
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const OverridePaymentModal = require(pmPath).default;
      const overrideTree = overrideHarness.renderAndSettle(OverridePaymentModal, {
        bill: makeBill('bill-override', 25.0),
        currency: 'USD',
        initialOverridePin: '1234',
        onClose: () => {},
        onPaid: () => {},
      });
      const overrideDetailsToggle = collectElements(
        overrideTree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.['aria-expanded'] === 'boolean' &&
          String(el.props?.className || '').includes('lg:hidden'),
      )[0];
      assert.equal(
        overrideDetailsToggle?.props?.['aria-expanded'],
        true,
        'PaymentModal with initialOverridePin starts with mobile details expanded',
      );
      assert.ok(
        renderToStaticMarkup(overrideTree).includes('kitchenDeliveryOverridePrompt'),
        'PaymentModal with initialOverridePin renders kitchen-override alert panel',
      );
    } finally {
      overrideHarness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindowOverride;
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

    // Behavioral check for PaymentModal Escape dismissal registration & cleanup
    const harness = createStatefulHarness();
    const hadWindow = 'window' in globalThis;
    const prevWindow = (globalThis as any).window;
    if (!hadWindow) {
      (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
    }
    try {
      installCheckoutComponentMocks(harness);
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      let registeredDismiss: (() => boolean) | undefined;
      let closedCount = 0;
      harness.renderAndSettle(PaymentModal, {
        bill: makeBill('bill-dismiss-reg', 18.0),
        currency: 'USD',
        onClose: () => {
          closedCount++;
        },
        onPaid: () => {},
        onRegisterDismissHandler: (handler?: () => boolean) => {
          registeredDismiss = handler;
        },
      });
      assert.equal(
        typeof registeredDismiss,
        'function',
        'PaymentModal registers an Escape dismiss handler on mount',
      );
      assert.equal(
        registeredDismiss?.(),
        true,
        'Registered dismiss handler returns true when idle',
      );
      assert.equal(closedCount, 1, 'Registered dismiss handler invokes onClose when idle');
      harness.cleanupAll();
      assert.equal(
        registeredDismiss,
        undefined,
        'PaymentModal unregisters Escape dismiss handler on unmount',
      );
    } finally {
      harness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });
  console.log('  ✓ Postpaid attempt storage and Escape dismiss registration verified');
}

async function testReviewFixRegressions() {
  console.log(
    '\n--- 6. CodeRabbit Review Regressions (Equal Share + Header Guard + Terminal Recovery) ---',
  );
  await withAliases(async () => {
    // 6a. Applying an equal share clears autoFilledSingleIndex so recording share 1 does NOT refill Cash with remaining balance.
    const eqHarness = createStatefulHarness();
    try {
      let currentBill: any = makeBill('bill-eq-1', 90);
      installCheckoutComponentMocks(eqHarness, {
        confirmFn: async () => true,
        apiGet: async (url: string) => {
          if (String(url).includes('/bills/')) return { data: { bill: currentBill } };
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('settings/discount'))
            return { data: { discount_mode: 'none', discount_requires_approval: false } };
          if (String(url).includes('settings')) return { data: { setting: { value: 'true' } } };
          return { data: {} };
        },
        apiPost: async () => {
          currentBill = {
            ...currentBill,
            paid_amount: 30,
            balance: 60,
            payment_status: 'partial',
          };
          return { data: { bill: currentBill, loyaltyPointsEarned: 0 } };
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      const makeEqProps = () => ({
        bill: currentBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
        onBillUpdate: (updated: any) => {
          currentBill = updated;
        },
      });

      let tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());
      await new Promise((resolve) => setTimeout(resolve, 10));
      tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());

      // Auto-fill Cash with 90
      const cashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      assert.ok(cashBtn, 'Cash tender button rendered');
      cashBtn.props.onClick();
      tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());
      const cashInputBefore = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        cashInputBefore?.props?.value,
        '90',
        'Cash auto-filled to 90 before Equal Share',
      );

      // Switch to Equal Share -> 3 payers -> Apply to Cash (share = 30)
      const equalTabBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'split-mode-equal-tab',
      )[0];
      assert.ok(equalTabBtn, 'Equal Share tab rendered');
      equalTabBtn.props.onClick();
      tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());

      const preset3 = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'equal-share-preset-3',
      )[0];
      assert.ok(preset3, 'Equal Share 3-payer preset rendered');
      preset3.props.onClick();
      tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());

      const applyEqualCashBtn = collectElements(
        tree,
        (el) =>
          typeof el.props?.onClick === 'function' &&
          String(el.props?.children) === 'equalShareApplyTo',
      )[0];
      assert.ok(applyEqualCashBtn, 'Equal Share apply button rendered for Cash');
      await applyEqualCashBtn.props.onClick();
      tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());

      const cashAfterApply = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(cashAfterApply?.props?.value, '30', 'Cash equals first share of 30');

      // Submit first equal share -> bill balance updates to 60 -> Cash must NOT be refilled to 60!
      const payCta = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      assert.ok(payCta, 'Pay CTA found');
      await payCta.props.onClick();
      tree = eqHarness.renderAndSettle(PaymentModal, makeEqProps());

      const cashAfterFirstShare = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        cashAfterFirstShare?.props?.value,
        '',
        'Recording equal share clears Cash without balance reconciliation refilling remaining 60',
      );
    } finally {
      eqHarness.cleanupAll();
    }

    // 6b. PaymentModal header Close button is guarded while applyingDiscount is active.
    const closeGuardHarness = createStatefulHarness();
    try {
      let resolveDiscountPatch!: (v: any) => void;
      const bill = makeBill('bill-guard', 40);
      let closeCount = 0;
      installCheckoutComponentMocks(closeGuardHarness, {
        apiPatch: (url: string) => {
          if (String(url).includes('/discount')) {
            return new Promise((resolve) => {
              resolveDiscountPatch = resolve;
            });
          }
          return Promise.resolve({ data: {} });
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      const guardProps = {
        bill,
        currency: 'USD',
        onClose: () => {
          closeCount++;
        },
        onPaid: () => {},
      };
      let tree = closeGuardHarness.renderAndSettle(PaymentModal, guardProps);
      await new Promise((resolve) => setTimeout(resolve, 10));
      tree = closeGuardHarness.renderAndSettle(PaymentModal, guardProps);

      const discountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      assert.ok(discountTab, 'Discount panel toggle rendered');
      discountTab.props.onClick();
      tree = closeGuardHarness.renderAndSettle(PaymentModal, guardProps);

      const discountInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'number' && !el.props?.['aria-label'],
      )[0];
      assert.ok(discountInput, 'Discount input rendered');
      discountInput.props.onChange({ target: { value: '10' } });
      tree = closeGuardHarness.renderAndSettle(PaymentModal, guardProps);

      const applyDiscountBtn = collectElements(
        tree,
        (el) =>
          typeof el.props?.onClick === 'function' && String(el.props?.children) === 'applyDiscount',
      )[0];
      assert.ok(applyDiscountBtn, 'Apply discount button rendered');
      const discountPromise = applyDiscountBtn.props.onClick();
      tree = closeGuardHarness.renderAndSettle(PaymentModal, guardProps);

      const closeBtnDuringPatch = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'close',
      )[0];
      assert.ok(closeBtnDuringPatch, 'Header Close button rendered');
      assert.equal(
        Boolean(closeBtnDuringPatch.props.disabled),
        true,
        'Header Close button is disabled while discount patch is in flight',
      );
      closeBtnDuringPatch.props.onClick();
      assert.equal(
        closeCount,
        0,
        'Header Close click does NOT dismiss during active discount update',
      );

      resolveDiscountPatch({ data: { bill: { ...bill, total: 36, balance: 36 } } });
      await discountPromise;
      tree = closeGuardHarness.renderAndSettle(PaymentModal, guardProps);
      const closeBtnAfterPatch = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'close',
      )[0];
      assert.equal(
        Boolean(closeBtnAfterPatch.props.disabled),
        false,
        'Header Close button re-enables once discount update finishes',
      );
      closeBtnAfterPatch.props.onClick();
      assert.equal(closeCount, 1, 'Header Close dismisses cleanly once idle');
    } finally {
      closeGuardHarness.cleanupAll();
    }

    // 6c. PrepaidCheckoutModal terminal failure allows dismissal while blocking payment retries.
    const termHarness = createStatefulHarness();
    const hadWindow = 'window' in globalThis;
    const prevWindow = (globalThis as any).window;
    const keyListeners = new Set<(e: any) => void>();
    (globalThis as any).window = {
      ...(prevWindow || {}),
      addEventListener: (ev: string, fn: (e: any) => void) => {
        if (ev === 'keydown') keyListeners.add(fn);
      },
      removeEventListener: (ev: string, fn: (e: any) => void) => {
        if (ev === 'keydown') keyListeners.delete(fn);
      },
    };
    try {
      installCheckoutComponentMocks(termHarness);
      const prepaidPath = path.resolve(
        ROOT,
        'frontend/src/components/pos/PrepaidCheckoutModal.tsx',
      );
      delete require.cache[prepaidPath];
      const PrepaidCheckoutModal = require(prepaidPath).default;

      let closed = 0;
      let confirmCalled = 0;
      const tree = termHarness.renderAndSettle(PrepaidCheckoutModal, {
        currency: 'USD',
        recovery: null,
        failure: {
          message: 'paymentBillRefunded',
          terminal: true,
          details: {
            operation: 'payment.create',
            stage: 'recovery',
            outcome: 'not_applied',
            reasonCode: 'bill_refunded',
            correlationId: 'op-term-1',
            httpStatus: null,
          },
        },
        onClose: () => {
          closed++;
        },
        onConfirm: () => {
          confirmCalled++;
        },
      });
      const closeBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'close',
      )[0];
      assert.ok(closeBtn, 'PrepaidCheckoutModal Close button rendered');
      assert.equal(
        Boolean(closeBtn.props.disabled),
        false,
        'Terminal failure unlocks Close button in PrepaidCheckoutModal',
      );
      const primaryBtn = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      assert.ok(primaryBtn, 'PrepaidCheckoutModal primary CTA rendered');
      assert.equal(
        Boolean(primaryBtn.props.disabled),
        true,
        'Terminal failure disables payment retry CTA',
      );
      primaryBtn.props.onClick();
      assert.equal(confirmCalled, 0, 'Primary handler refuses submission on terminal failure');
      for (const listener of keyListeners) {
        listener({ key: 'Escape', preventDefault: () => {}, target: null });
      }
      assert.equal(closed, 1, 'Escape dismisses terminal PrepaidCheckoutModal');
      closeBtn.props.onClick();
      assert.equal(closed, 2, 'Close button dismisses terminal PrepaidCheckoutModal');
    } finally {
      termHarness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });

  // 6d: Restoring pendingAttempt populates tender inputs, Zone 3A readout, and Zone 3D change
  await withAliases(async () => {
    const restoreHarness = createStatefulHarness();
    const hadWindow = 'window' in globalThis;
    const prevWindow = (globalThis as any).window;
    const hadSessionStorage = 'sessionStorage' in globalThis;
    const prevSessionStorage = (globalThis as any).sessionStorage;
    const store = new Map<string, string>();
    const storageMock = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, val: string) => {
        store.set(key, String(val));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
    };
    (globalThis as any).sessionStorage = storageMock;
    (globalThis as any).window = { ...(prevWindow || {}), sessionStorage: storageMock };
    try {
      installCheckoutComponentMocks(restoreHarness);
      const orderAttempt = require(path.resolve(ROOT, 'frontend/src/lib/order-attempt.ts'));
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      const unpaidBill = {
        ...makeBill('88', 25),
        total: 25,
        paid_amount: 0,
        payment_status: 'unpaid',
      };
      const storageKey = orderAttempt.getPostpaidPaymentAttemptStorageKey('u-1', '1', '88');
      orderAttempt.savePostpaidPaymentAttempt(storageMock, storageKey, {
        billId: '88',
        key: 'idem-restore-88',
        operationId: 'op-restore-88',
        zeroBalance: false,
        lines: [{ method: 'cash', amount: 30 }],
        customerId: null,
        userId: 'u-1',
        storeId: '1',
        idempotencyKey: 'idem-restore-88',
        paymentFingerprint: JSON.stringify([{ method: 'cash', amount: 30 }]),
      });

      let tree = restoreHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      tree = restoreHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });

      const cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(
        cashInput?.props?.value,
        '30',
        'Restored pendingAttempt populates Cash tender input with 30',
      );
      const readoutEl = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-readout-amount',
      )[0];
      assert.ok(
        JSON.stringify(readoutEl).includes('30.00'),
        'Restored pendingAttempt Zone 3A readout displays $30.00 instead of $0.00',
      );
      const changeSlotEl = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-change-slot',
      )[0];
      assert.ok(
        JSON.stringify(changeSlotEl).includes('5.00'),
        'Restored pendingAttempt Zone 3D change slot displays $5.00 change',
      );

      // Switching bill.id clears restored cash readout and change
      const freshBill = {
        ...makeBill('89', 25),
        total: 25,
        paid_amount: 0,
        payment_status: 'unpaid',
      };
      const freshTree = restoreHarness.renderAndSettle(PaymentModal, {
        bill: freshBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      const freshCashInput = collectElements(
        freshTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(freshCashInput?.props?.value, '', 'Switching bill clears restored Cash amount');
    } finally {
      restoreHarness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (!hadSessionStorage) delete (globalThis as any).sessionStorage;
      else (globalThis as any).sessionStorage = prevSessionStorage;
    }
  });
  console.log(
    '  ✓ Equal Share auto-fill clear, header dismiss guard, and terminal recovery verified',
  );
}

async function run() {
  await testQuickTenderAndMinorMath();
  await testTouchNumberPadAndStationStructure();
  await testPaymentModalLockDismissAndBillReset();
  await testPaymentModalSettledDismissAndRestoredAttempt();
  await testPrepaidAutoFillTracksDiscountUpdates();
  await testExactQuickValuesAndDiscountTargetReset();
  await testPosPageEscapeAndSessionGuards();
  await testReviewFixRegressions();
  console.log('\n✅ All checkout quick-tender and guard tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
