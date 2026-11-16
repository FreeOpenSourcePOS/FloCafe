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
    isConfirmOpen?: () => boolean;
    splitSavingRef?: { current: boolean };
    discount?: { type: 'amount' | 'percentage'; value: number; reason?: string } | null;
    taxPreview?: (args: any) => any;
    apiGet?: (url: string) => Promise<any>;
    apiPost?: (url: string, body: any) => Promise<any>;
    apiPatch?: (url: string, body: any, config?: any) => Promise<any>;
    operationReference?: string;
    charges?: any[];
    chargesBreakdown?: any[];
    optedInChargeIds?: Set<string>;
    onToggleWaiveCharge?: (id: string) => void;
    onToggleOptedInCharge?: (id: string) => void;
    managerApprovers?: {
      approvers: Array<{ id: string | number; name: string; role: string; has_pin?: boolean }>;
      selectedApproverId: string | null;
      loading?: boolean;
      loadFailed?: boolean;
    };
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
    'frontend/src/components/pos/checkout-ui.tsx',
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
          if (overrides.taxPreview) {
            return overrides.taxPreview(args);
          }
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
          approvers: overrides.managerApprovers?.approvers ?? [],
          selectedApproverId: overrides.managerApprovers?.selectedApproverId ?? null,
          loading: overrides.managerApprovers?.loading ?? false,
          loadFailed: overrides.managerApprovers?.loadFailed ?? false,
        }),
      };
    }
    if (request === '@/hooks/use-confirm') {
      return {
        useConfirm: () => ({
          confirm: overrides.confirmFn ?? (async () => true),
          ConfirmDialog: null,
          isConfirmOpen: overrides.isConfirmOpen ? overrides.isConfirmOpen() : false,
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
        patch: async (url: string, body: any, config?: any) =>
          overrides.apiPatch ? overrides.apiPatch(url, body, config) : { data: {} },
        defaults: { headers: { common: {} } },
      };
      return {
        __esModule: true,
        default: apiObj,
        captureClientOperationFailure: async () => {},
        createOperationReference: () => overrides.operationReference ?? 'op-ref-1',
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

async function testVisualHierarchyAndPrematurePaidGuards() {
  console.log('\n--- 7. Premature Paid Fix, 3-State Tender Focus & Hallmark Craft ---');

  await withAliases(async () => {
    const unpaidBill = {
      id: 'bill-life-1',
      bill_number: 'BILL-0099',
      order_id: 'ord-99',
      subtotal: 14.2,
      discount_amount: 0,
      discounted_subtotal: 14.2,
      tax_amount: 0,
      total: 14.2,
      paid_amount: 0,
      balance: 14.2,
      payment_status: 'unpaid',
      order: {
        id: 'ord-99',
        order_number: '99',
        order_type: 'dine_in',
        table_name: 'T4',
        customer: { id: 'cust-1', name: 'Ava Chen', phone: '5550199', loyalty_points: 0 },
        items: [{ id: 'it-1', product_name: 'Flat White', quantity: 2, subtotal: 14.2 }],
      },
    };

    // A. PaymentModal unpaid check invariants
    const pmHarness = createStatefulHarness();
    try {
      installCheckoutComponentMocks(pmHarness, {});
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      let tree = pmHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });

      // Header uses structured metadata chips without dot-joined subtitle strings
      const headerChips = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-header-chips',
      )[0];
      assert.ok(headerChips, 'PaymentModal renders structured checkout-header-chips');
      assert.ok(
        !JSON.stringify(headerChips).includes(' · '),
        'PaymentModal header chips do not join metadata with middle dots',
      );

      // Idle ($0.00 entered): status strip is idle-due with balanceDue, CTA disabled & neutral
      let statusStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      assert.equal(
        statusStrip?.props?.['data-status-tone'],
        'idle-due',
        'Unpaid PaymentModal at $0.00 uses idle-due status tone',
      );
      let readoutZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.ok(
        !JSON.stringify(readoutZone).includes('"paid"'),
        'Unpaid PaymentModal readout does not render premature paid label at $0.00',
      );

      // Default focus is Cash (index 0) at $0.00 -> Cash row has focused brand state, Card is idle
      const cashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      let cardBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCard',
      )[0];
      assert.ok(
        String(cashBtn?.props?.className || '').includes('bg-brand'),
        'Focused Cash tender button at $0.00 shows brand focus state',
      );
      assert.ok(
        !String(cardBtn?.props?.className || '').includes('bg-brand '),
        'Unfocused Card tender button at $0.00 stays in idle surface state',
      );

      // Focus Card input at $0.00 -> Card immediately shows focused brand highlight even at $0.00
      let cardInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      cardInput.props.onFocus();
      tree = pmHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      cardBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCard',
      )[0];
      assert.ok(
        String(cardBtn?.props?.className || '').includes('bg-brand'),
        'Focusing Card at $0.00 highlights Card tender button immediately',
      );

      // Enter partial Cash ($5.00) while Card is $0.00 -> status stays idle-due ($9.20 remaining)
      let cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      cashInput.props.onChange({ target: { value: '5' } });
      tree = pmHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      statusStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      assert.equal(
        statusStrip?.props?.['data-status-tone'],
        'idle-due',
        'Partial tender ($5.00 of $14.20) keeps idle-due tone',
      );
      assert.ok(
        JSON.stringify(statusStrip).includes('9.20'),
        'Partial tender status strip displays remaining $9.20 balanceDue',
      );

      // Clicking Card when Cash has $5.00 auto-fills remaining $9.20 onto Card (total $14.20 === remaining $14.20)
      // BEFORE submitting: MUST use idle-ready + exactAmount, NEVER idle-settled or paid!
      cardBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCard',
      )[0];
      cardBtn.props.onClick();
      tree = pmHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      statusStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      readoutZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.equal(
        statusStrip?.props?.['data-status-tone'],
        'idle-ready',
        'Exact tender before submit uses idle-ready tone instead of premature idle-settled',
      );
      assert.ok(
        !JSON.stringify(statusStrip).includes('"paid"'),
        'Exact tender status strip never displays premature paid text before submit',
      );
      assert.ok(
        JSON.stringify(readoutZone).includes('exactAmount') &&
          !JSON.stringify(readoutZone).includes('"paid"'),
        'Exact tender Zone 3A readout shows exactAmount pill and never premature paid',
      );

      // Active Primary Pay CTA uses bg-brand
      const footerZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'footer',
      )[0];
      const payButtons = collectElements(footerZone, (el) => el.type === 'button');
      const primaryPayBtn = payButtons[payButtons.length - 1];
      assert.ok(
        String(primaryPayBtn?.props?.className || '').includes('bg-brand'),
        'Enabled Primary Pay CTA uses FloCafe bg-brand styling',
      );

      // Overpayment ($20.00 Cash, $0.00 Card -> $5.80 change) BEFORE submitting:
      cardInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      cardInput.props.onChange({ target: { value: '' } });
      const cashInputEl = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      cashInputEl.props.onChange({ target: { value: '20' } });
      tree = pmHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      statusStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      readoutZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.equal(
        statusStrip?.props?.['data-status-tone'],
        'idle-ready',
        'Cash overpayment before submit uses idle-ready tone instead of premature idle-settled',
      );
      assert.ok(
        !JSON.stringify(statusStrip).includes('"paid"') &&
          !JSON.stringify(readoutZone).includes('"paid"'),
        'Cash overpayment never shows premature paid text in readout or status strip',
      );
      assert.equal(
        readoutZone?.props?.['data-readout-tone'],
        'change',
        'Cash overpayment sets readout statusTone to change',
      );

      // Over-allocated non-cash tender ($0.00 Cash, $20.00 Card on $14.20 balance):
      // MUST warn with paymentAboveBalance, set readout tone to due, hide exactAmount pill, and disable Pay CTA!
      const cashClearEl = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      cashClearEl.props.onChange({ target: { value: '' } });
      cardInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      cardInput.props.onChange({ target: { value: '20' } });
      tree = pmHarness.renderAndSettle(PaymentModal, {
        bill: unpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      statusStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      readoutZone = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      const overCardFooter = collectElements(
        tree,
        (el) => el.props?.['data-checkout-zone'] === 'footer',
      )[0];
      const overCardPayBtns = collectElements(overCardFooter, (el) => el.type === 'button');
      const overCardPrimaryBtn = overCardPayBtns[overCardPayBtns.length - 1];
      assert.equal(
        statusStrip?.props?.['data-status-tone'],
        'warning',
        'Card over-allocation renders warning status strip instead of idle-ready',
      );
      assert.ok(
        JSON.stringify(statusStrip).includes('paymentAboveBalance'),
        'Card over-allocation status strip displays paymentAboveBalance',
      );
      assert.equal(
        readoutZone?.props?.['data-readout-tone'],
        'due',
        'Card over-allocation sets readout statusTone to due (never ready)',
      );
      assert.ok(
        !JSON.stringify(readoutZone).includes('exactAmount') &&
          !JSON.stringify(readoutZone).includes('"paid"'),
        'Card over-allocation hides exactAmount and paid pills in readout',
      );
      assert.equal(
        Boolean(overCardPrimaryBtn?.props?.disabled),
        true,
        'Card over-allocation disables Primary Pay CTA',
      );
    } finally {
      pmHarness.cleanupAll();
    }

    // B. Already-settled zero-balance check DOES show idle-settled / paid and recorded paid_amount
    const settledHarness = createStatefulHarness();
    try {
      installCheckoutComponentMocks(settledHarness, {});
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      const zeroSettledBill = {
        ...unpaidBill,
        id: 'bill-life-settled',
        total: 14.2,
        paid_amount: 14.2,
        balance: 0,
        payment_status: 'paid',
      };
      const settledTree = settledHarness.renderAndSettle(PaymentModal, {
        bill: zeroSettledBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      const settledStrip = collectElements(
        settledTree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      const settledReadout = collectElements(
        settledTree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.equal(
        settledStrip?.props?.['data-status-tone'],
        'idle-settled',
        'Already-settled zero-balance check renders idle-settled status strip',
      );
      assert.ok(
        JSON.stringify(settledReadout).includes('paid: $14.20'),
        'Already-settled bill readout summary displays recorded bill.paid_amount ($14.20) instead of $0.00',
      );
    } finally {
      settledHarness.cleanupAll();
    }

    // C. PrepaidCheckoutModal: auto-filled exact tender uses idle-ready + exactAmount, never paid!
    const prepaidHarness = createStatefulHarness();
    const hadWindow = 'window' in globalThis;
    const prevWindow = (globalThis as any).window;
    if (!hadWindow) {
      (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
    }
    try {
      installCheckoutComponentMocks(prepaidHarness, {});
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
        initialDiscount: null,
      };
      let prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      let prepaidStrip = collectElements(
        prepaidTree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      assert.equal(
        prepaidStrip?.props?.['data-status-tone'],
        'idle-due',
        'PrepaidCheckoutModal starts at idle-due before tender is entered',
      );
      const prepaidCashBtn = collectElements(
        prepaidTree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      prepaidCashBtn.props.onClick();
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      prepaidStrip = collectElements(
        prepaidTree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      const prepaidReadout = collectElements(
        prepaidTree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.equal(
        prepaidStrip?.props?.['data-status-tone'],
        'idle-ready',
        'PrepaidCheckoutModal with exact auto-filled tender uses idle-ready instead of idle-settled',
      );
      assert.ok(
        !JSON.stringify(prepaidStrip).includes('"paid"') &&
          !JSON.stringify(prepaidReadout).includes('"paid"'),
        'PrepaidCheckoutModal never displays premature paid text before payment submission',
      );
      const prepaidChips = collectElements(
        prepaidTree,
        (el) => el.props?.['data-testid'] === 'checkout-header-chips',
      )[0];
      assert.ok(prepaidChips, 'PrepaidCheckoutModal renders structured checkout-header-chips');

      // PrepaidCheckoutModal Card over-allocation ($0.00 Cash, $99.00 Card) warns, sets readout due, and disables Confirm CTA
      const prepaidCashInput = collectElements(
        prepaidTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      prepaidCashInput.props.onChange({ target: { value: '' } });
      const prepaidCardInput = collectElements(
        prepaidTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCard amount',
      )[0];
      prepaidCardInput.props.onChange({ target: { value: '99' } });
      prepaidTree = prepaidHarness.renderAndSettle(PrepaidCheckoutModal, prepaidProps);
      prepaidStrip = collectElements(
        prepaidTree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      const prepaidOverReadout = collectElements(
        prepaidTree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      const prepaidFooter = collectElements(
        prepaidTree,
        (el) => el.props?.['data-checkout-zone'] === 'footer',
      )[0];
      const prepaidFooterBtns = collectElements(prepaidFooter, (el) => el.type === 'button');
      const prepaidConfirmBtn = prepaidFooterBtns[prepaidFooterBtns.length - 1];
      assert.equal(
        prepaidStrip?.props?.['data-status-tone'],
        'warning',
        'PrepaidCheckoutModal Card over-allocation renders warning status strip',
      );
      assert.ok(
        JSON.stringify(prepaidStrip).includes('paymentAboveBalance'),
        'PrepaidCheckoutModal Card over-allocation displays paymentAboveBalance',
      );
      assert.equal(
        prepaidOverReadout?.props?.['data-readout-tone'],
        'due',
        'PrepaidCheckoutModal Card over-allocation sets readout statusTone to due',
      );
      assert.ok(
        !JSON.stringify(prepaidOverReadout).includes('exactAmount') &&
          !JSON.stringify(prepaidOverReadout).includes('"paid"'),
        'PrepaidCheckoutModal Card over-allocation hides exactAmount and paid pills in readout',
      );
      assert.equal(
        Boolean(prepaidConfirmBtn?.props?.disabled),
        true,
        'PrepaidCheckoutModal Card over-allocation disables Confirm Payment CTA',
      );
    } finally {
      prepaidHarness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
    // D. Zero-balance unpaid and refunded/terminal checks do NOT display premature settled/paid
    const zeroUnpaidHarness = createStatefulHarness();
    try {
      installCheckoutComponentMocks(zeroUnpaidHarness, {});
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      const zeroUnpaidBill = {
        ...unpaidBill,
        id: 'bill-life-zero-unpaid',
        total: 0,
        discount_amount: 14.2,
        paid_amount: 0,
        balance: 0,
        payment_status: 'unpaid',
      };
      const zeroUnpaidTree = zeroUnpaidHarness.renderAndSettle(PaymentModal, {
        bill: zeroUnpaidBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      const zeroUnpaidStrip = collectElements(
        zeroUnpaidTree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      const zeroUnpaidReadout = collectElements(
        zeroUnpaidTree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.equal(
        zeroUnpaidStrip?.props?.['data-status-tone'],
        'idle-ready',
        'Zero-balance unpaid check renders idle-ready instead of idle-settled',
      );
      assert.equal(
        zeroUnpaidReadout?.props?.['data-readout-tone'],
        'ready',
        'Zero-balance unpaid check sets readout tone to ready instead of settled',
      );
      assert.ok(
        JSON.stringify(zeroUnpaidReadout).includes('exactAmount') &&
          !JSON.stringify(zeroUnpaidReadout).includes('"paid"') &&
          !JSON.stringify(zeroUnpaidStrip).includes('"paid"'),
        'Zero-balance unpaid check renders exactAmount and never premature paid text',
      );

      const refundedZeroBill = {
        ...unpaidBill,
        id: 'bill-life-refunded-zero',
        total: 14.2,
        paid_amount: 0,
        balance: 0,
        payment_status: 'refunded',
      };
      const refundedTree = zeroUnpaidHarness.renderAndSettle(PaymentModal, {
        bill: refundedZeroBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      });
      const refundedStrip = collectElements(
        refundedTree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      const refundedReadout = collectElements(
        refundedTree,
        (el) => el.props?.['data-checkout-zone'] === 'readout',
      )[0];
      assert.equal(
        refundedStrip?.props?.['data-status-tone'],
        'warning',
        'Refunded zero-balance check renders warning status strip instead of idle-settled',
      );
      assert.equal(
        refundedReadout?.props?.['data-readout-tone'],
        'due',
        'Refunded zero-balance check does not use settled or ready readout tone',
      );
      assert.ok(
        !JSON.stringify(refundedReadout).includes('"paid"') &&
          !JSON.stringify(refundedReadout).includes('exactAmount') &&
          !JSON.stringify(refundedStrip).includes('"paid"'),
        'Refunded zero-balance check never displays paid or exactAmount labels',
      );
    } finally {
      zeroUnpaidHarness.cleanupAll();
    }
  });

  console.log('  ✓ Premature Paid fix, 3-state tender focus, and Hallmark craft verified');
}

async function testPrincipalUxErgonomicsAndCompletionParity() {
  console.log(
    '\n--- 8. Principal UX Ergonomics: 1-Tap Switch, Keyboard Flow, Discount Sync, & Completion Change ---',
  );

  await withAliases(async () => {
    const checkoutUiPath = path.resolve(ROOT, 'frontend/src/components/pos/checkout-ui.tsx');
    delete require.cache[checkoutUiPath];
    const checkoutUi = require(checkoutUiPath);
    assert.equal(
      typeof checkoutUi.applyPhysicalCheckoutKey,
      'function',
      'checkout-ui exports applyPhysicalCheckoutKey for shared physical keyboard entry',
    );
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('', '2', true), '2');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('2', '0', true), '20');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('20', '.', true), '20.');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('20.', '5', true), '20.5');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('20.5', 'Backspace', true), '20.');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('20.', 'Delete', true), '');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('95', '9', true, 100), '100');
    assert.equal(checkoutUi.applyPhysicalCheckoutKey('10', 'a', true), null);

    // 8a: PaymentModal - 1-tap Card<->Cash switch, Discount auto-target + restore, keyboard digits/Enter/Escape, completion Change Returned + Print Receipt
    const pmHarness = createStatefulHarness();
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
      const apiCalls: Array<{ method: string; url: string; body?: any }> = [];
      installCheckoutComponentMocks(pmHarness, {
        apiGet: async (url: string) => {
          apiCalls.push({ method: 'GET', url });
          if (url === '/settings/discount') {
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          }
          if (url.startsWith('/bills/order/')) {
            return {
              data: {
                bill: {
                  ...makeBill('bill-ux-1', 27.0),
                  subtotal: 30,
                  discount_amount: 3,
                  discount_type: 'percentage',
                  discount_value: 10,
                  total: 27,
                  balance: 27,
                },
              },
            };
          }
          return { data: {} };
        },
        apiPatch: async (url: string, body: any) => {
          apiCalls.push({ method: 'PATCH', url, body });
          return { data: { ok: true } };
        },
        apiPost: async (url: string, body: any) => {
          apiCalls.push({ method: 'POST', url, body });
          return {
            data: {
              bill: {
                ...makeBill('bill-ux-1', 0),
                total: 27,
                paid_amount: 27,
                balance: 0,
                payment_status: 'paid',
              },
            },
          };
        },
      });

      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      let closeCount = 0;
      let paidCount = 0;
      let printedBills = 0;
      let currentBill: any = {
        ...makeBill('bill-ux-1', 30.0),
        subtotal: 30,
        total: 30,
        balance: 30,
      };
      const renderPm = () =>
        pmHarness.renderAndSettle(PaymentModal, {
          bill: currentBill,
          currency: 'USD',
          onClose: () => {
            closeCount++;
          },
          onPaid: () => {
            paidCount++;
          },
          onBillUpdate: (updated: any) => {
            currentBill = updated;
          },
          onPrintBill: async () => {
            printedBills++;
          },
        });

      let tree = renderPm();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderPm();

      // 1-tap Card auto-fills 30; switching to Cash moves full 30 to Cash and clears Card in 1 tap!
      const findTenderBtn = (t: any, title: string) =>
        collectElements(t, (el) => el.type === 'button' && el.props?.title === title)[0];
      const findTenderInput = (t: any, label: string) =>
        collectElements(
          t,
          (el) => el.type === 'input' && el.props?.['aria-label'] === `${label} amount`,
        )[0];

      findTenderBtn(tree, 'methodCard').props.onClick();
      tree = renderPm();
      assert.equal(
        findTenderInput(tree, 'methodCard').props.value,
        '30',
        'Card 1-tap auto-fills 30',
      );
      assert.equal(findTenderInput(tree, 'methodCash').props.value, '', 'Cash starts empty');

      findTenderBtn(tree, 'methodCash').props.onClick();
      tree = renderPm();
      assert.equal(
        findTenderInput(tree, 'methodCash').props.value,
        '30',
        '1-tap switch from auto-filled Card to Cash moves full balance to Cash',
      );
      assert.equal(
        findTenderInput(tree, 'methodCard').props.value,
        '',
        '1-tap switch from auto-filled Card to Cash clears Card automatically',
      );

      // Select Card again, then open Discount: immediately targets discount ('5%' visible) and restores Card after applying!
      findTenderBtn(tree, 'methodCard').props.onClick();
      tree = renderPm();
      assert.equal(findTenderInput(tree, 'methodCard').props.value, '30');

      const discountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      discountTab.props.onClick();
      tree = renderPm();
      assert.ok(
        renderToStaticMarkup(tree).includes('5%'),
        'Opening Discount panel immediately activates discount quick-tender % pills without extra focus click',
      );

      // Physical keyboard digits '1', '0' populate discount while Discount target is active
      const dispatchKey = (init: Record<string, any>) => {
        for (const fn of keyListeners) {
          fn({
            key: '',
            code: '',
            repeat: false,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            defaultPrevented: false,
            target: null,
            preventDefault() {
              this.defaultPrevented = true;
            },
            ...init,
          });
        }
      };
      dispatchKey({ key: '1', code: 'Digit1' });
      tree = renderPm();
      dispatchKey({ key: '0', code: 'Digit0' });
      tree = renderPm();

      dispatchKey({ key: 'Enter', code: 'Enter' });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        apiCalls.filter((c) => c.method === 'POST').length,
        0,
        'Enter while editing unapplied discount must not submit payment',
      );

      const applyDiscBtn = collectElements(
        tree,
        (el) =>
          typeof el.props?.onClick === 'function' && String(el.props?.children) === 'applyDiscount',
      )[0];
      await applyDiscBtn.props.onClick();
      tree = renderPm();
      assert.ok(
        !renderToStaticMarkup(tree).includes('5%'),
        'Applying discount restores keypad target away from discount back to payment tender',
      );
      assert.equal(
        findTenderInput(tree, 'methodCard').props.value,
        '27',
        'Auto-filled Card updates to 27 after 10% discount',
      );

      // Escape while Discount sub-panel is open backs out to Items first without closing modal
      dispatchKey({ key: 'Escape', code: 'Escape' });
      tree = renderPm();
      assert.equal(
        closeCount,
        0,
        'First Escape closes Discount sub-panel instead of closing modal',
      );

      // Switch to Cash and type 40 via physical keyboard (Delete -> '4' -> '0') -> Change Returned = 13
      findTenderBtn(tree, 'methodCash').props.onClick();
      tree = renderPm();
      dispatchKey({ key: 'Delete', code: 'Delete' });
      tree = renderPm();
      assert.equal(findTenderInput(tree, 'methodCash').props.value, '');

      // Uncovered Enter does NOT submit payment
      dispatchKey({ key: 'Enter', code: 'Enter' });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        apiCalls.filter((c) => c.method === 'POST').length,
        0,
        'Enter while check is uncovered must not submit payment',
      );

      dispatchKey({ key: '4', code: 'Digit4' });
      tree = renderPm();
      dispatchKey({ key: '0', code: 'Digit0' });
      tree = renderPm();
      assert.equal(
        findTenderInput(tree, 'methodCash').props.value,
        '40',
        'Physical keyboard digits populate active Cash tender without input focus',
      );

      // Space never submits even when covered
      dispatchKey({ key: ' ', code: 'Space' });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        apiCalls.filter((c) => c.method === 'POST').length,
        0,
        'Space must never submit payment',
      );

      // Deliberate non-repeat Enter when covered submits payment!
      dispatchKey({ key: 'Enter', code: 'Enter' });
      await new Promise((r) => setTimeout(r, 15));
      tree = renderPm();
      assert.equal(
        apiCalls.filter((c) => c.method === 'POST').length,
        1,
        'Deliberate Enter when covered submits payment',
      );

      // Post-payment completion screen shows settled Change Returned ($13.00) and Print Receipt CTA!
      const changeBanner = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'settled-change-banner',
      )[0];
      assert.ok(
        changeBanner,
        'Completion screen renders settled-change-banner when cash change > 0',
      );
      assert.ok(
        renderToStaticMarkup(changeBanner).includes('13.00'),
        'Completion screen displays exact $13.00 change returned',
      );

      const printReceiptBtn = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'completion-print-receipt-btn',
      )[0];
      assert.ok(printReceiptBtn, 'Completion screen renders on-demand Print Receipt button');
      await printReceiptBtn.props.onClick();
      assert.equal(printedBills, 1, 'Clicking Print Receipt invokes onPrintBill');

      // 1-keystroke Enter on completion screen dismisses via onPaid()
      dispatchKey({ key: 'Enter', code: 'Enter' });
      assert.equal(paidCount, 1, 'Single Enter keystroke on completion screen invokes onPaid');
    } finally {
      pmHarness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }

    // 8b: PrepaidCheckoutModal parity - 1-tap switch, keyboard digits + Enter confirm, completion Change Returned + Print + 1-keystroke Enter close
    const ppHarness = createStatefulHarness();
    const hadWin2 = 'window' in globalThis;
    const prevWin2 = (globalThis as any).window;
    const ppKeyListeners = new Set<(e: any) => void>();
    (globalThis as any).window = {
      ...(prevWin2 || {}),
      addEventListener: (ev: string, fn: (e: any) => void) => {
        if (ev === 'keydown') ppKeyListeners.add(fn);
      },
      removeEventListener: (ev: string, fn: (e: any) => void) => {
        if (ev === 'keydown') ppKeyListeners.delete(fn);
      },
    };
    try {
      installCheckoutComponentMocks(ppHarness, {
        apiGet: async (url: string) => {
          if (url === '/settings/discount') {
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          }
          return { data: {} };
        },
        taxPreview: () => ({
          tax: {
            subtotal: 16.5,
            discount_amount: 0,
            discounted_subtotal: 16.5,
            tax_amount: 0,
            tax_breakdown: [],
            packaging_charge: 0,
            charges_breakdown: [],
            round_off: 0,
            total: 16.5,
          },
          loading: false,
        }),
      });
      const ppPath = path.resolve(ROOT, 'frontend/src/components/pos/PrepaidCheckoutModal.tsx');
      delete require.cache[ppPath];
      const PrepaidCheckoutModal = require(ppPath).default;

      let ppClosed = 0;
      let ppPrinted = 0;
      let ppConfirmed = 0;
      const renderPp = () =>
        ppHarness.renderAndSettle(PrepaidCheckoutModal, {
          currency: 'USD',
          onClose: () => {
            ppClosed++;
          },
          onPrintBill: async () => {
            ppPrinted++;
          },
          onConfirm: async () => {
            ppConfirmed++;
            return {
              bill: { id: 501, bill_number: 'B-501', total: 16.5, payment_status: 'paid' },
              customer: null,
              pointsEarned: 0,
            };
          },
        });

      let ppTree = renderPp();
      await new Promise((r) => setTimeout(r, 10));
      ppTree = renderPp();

      const dispatchPpKey = (init: Record<string, any>) => {
        for (const fn of ppKeyListeners) {
          fn({
            key: '',
            code: '',
            repeat: false,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            defaultPrevented: false,
            target: null,
            preventDefault() {
              this.defaultPrevented = true;
            },
            ...init,
          });
        }
      };

      // Physical keyboard typing '2', '0' after clicking Cash button blurs focused button so subsequent Enter confirms!
      let focusedBtnBlurred = 0;
      const focusedButtonTarget = {
        tagName: 'BUTTON',
        blur() {
          focusedBtnBlurred++;
        },
      };
      dispatchPpKey({ key: '2', code: 'Digit2', target: focusedButtonTarget });
      assert.equal(
        focusedBtnBlurred,
        1,
        'Physical digit entry blurs a focused modal button so subsequent Enter submits cleanly',
      );
      ppTree = renderPp();
      dispatchPpKey({ key: '0', code: 'Digit0' });
      ppTree = renderPp();

      const ppCashInput = collectElements(
        ppTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.equal(ppCashInput.props.value, '20', 'Prepaid keyboard digits populate Cash input');

      const ppDiscountToggle = collectElements(
        ppTree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] !== undefined &&
          renderToStaticMarkup(el).includes('discounts'),
      )[0];
      assert.ok(ppDiscountToggle, 'Prepaid Discounts toggle renders');
      ppDiscountToggle.props.onClick();
      ppTree = renderPp();
      dispatchPpKey({ key: 'Enter', code: 'Enter' });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        ppConfirmed,
        0,
        'Prepaid Enter while Discount target is active must not submit checkout early',
      );
      const ppDiscountToggleAfter = collectElements(
        ppTree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] !== undefined &&
          renderToStaticMarkup(el).includes('discount'),
      )[0];
      assert.ok(ppDiscountToggleAfter, 'Prepaid Discounts toggle still renders after opening');
      ppDiscountToggleAfter.props.onClick();
      ppTree = renderPp();

      dispatchPpKey({ key: 'Enter', code: 'Enter' });
      await new Promise((r) => setTimeout(r, 15));
      ppTree = renderPp();
      assert.equal(ppConfirmed, 1, 'Prepaid Enter when covered confirms payment');

      const ppChangeBanner = collectElements(
        ppTree,
        (el) => el.props?.['data-testid'] === 'settled-change-banner',
      )[0];
      assert.ok(ppChangeBanner, 'Prepaid completion screen renders settled-change-banner');
      assert.ok(
        renderToStaticMarkup(ppChangeBanner).includes('3.50'),
        'Prepaid completion screen displays exact $3.50 change returned',
      );

      const ppPrintBtn = collectElements(
        ppTree,
        (el) => el.props?.['data-testid'] === 'completion-print-receipt-btn',
      )[0];
      assert.ok(ppPrintBtn, 'Prepaid completion screen renders Print Receipt button');
      await ppPrintBtn.props.onClick();
      assert.equal(ppPrinted, 1, 'Prepaid completion Print Receipt invokes onPrintBill');

      dispatchPpKey({ key: 'Enter', code: 'Enter' });
      assert.equal(ppClosed, 1, 'Single Enter keystroke on Prepaid completion screen closes modal');
    } finally {
      ppHarness.cleanupAll();
      if (!hadWin2) delete (globalThis as any).window;
      else (globalThis as any).window = prevWin2;
    }
  });

  console.log('  ✓ Principal UX ergonomics & completion parity verified');
}

async function testConfirmDialogAndCardReferenceSwitchGuards() {
  console.log('\n--- 9. ConfirmDialog Keyboard/Escape Guards & 1-Tap Card Reference Clearing ---');

  await withAliases(async () => {
    const harness = createStatefulHarness();
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
      let confirmOpen = false;
      let resolveConfirm: ((accepted: boolean) => void) | null = null;
      let payCalls = 0;

      installCheckoutComponentMocks(harness, {
        isConfirmOpen: () => confirmOpen,
        confirmFn: () =>
          new Promise<boolean>((resolve) => {
            confirmOpen = true;
            resolveConfirm = (accepted) => {
              confirmOpen = false;
              resolve(accepted);
            };
          }),
        apiGet: async (url: string) => {
          if (url === '/settings/card_transaction_id_required') {
            return { data: { setting: { value: 'true' } } };
          }
          if (url === '/settings/discount') {
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          }
          return { data: {} };
        },
        apiPost: async () => {
          payCalls++;
          return {
            data: {
              bill: {
                ...makeBill('bill-guard-1', 0),
                total: 30,
                paid_amount: 30,
                balance: 0,
                payment_status: 'paid',
              },
            },
          };
        },
      });

      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      let closeCount = 0;
      let registeredDismiss: (() => boolean) | undefined;
      const renderModal = (withDismissHandler: boolean) =>
        harness.renderAndSettle(PaymentModal, {
          bill: { ...makeBill('bill-guard-1', 30), subtotal: 30, total: 30, balance: 30 },
          currency: 'USD',
          onClose: () => {
            closeCount++;
          },
          onPaid: () => {},
          ...(withDismissHandler
            ? {
                onRegisterDismissHandler: (fn?: () => boolean) => {
                  registeredDismiss = fn;
                },
              }
            : {}),
        });

      let tree = renderModal(true);
      await new Promise((r) => setTimeout(r, 15));
      tree = renderModal(true);

      const findTenderBtn = (t: any, title: string) =>
        collectElements(t, (el) => el.type === 'button' && el.props?.title === title)[0];
      const findTenderInput = (t: any, label: string) =>
        collectElements(
          t,
          (el) => el.type === 'input' && el.props?.['aria-label'] === `${label} amount`,
        )[0];

      // 1-tap Card -> type card ref -> 1-tap Cash clears stale card ref
      findTenderBtn(tree, 'methodCard').props.onClick();
      tree = renderModal(true);
      const cardRefBefore = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'payment-card-transaction-id',
      )[0];
      assert.ok(cardRefBefore, 'Card transaction_id input renders when Card is auto-filled');
      cardRefBefore.props.onChange({ target: { value: 'TXN-999' } });
      tree = renderModal(true);
      assert.equal(
        collectElements(
          tree,
          (el) => el.type === 'input' && el.props?.id === 'payment-card-transaction-id',
        )[0].props.value,
        'TXN-999',
      );

      findTenderBtn(tree, 'methodCash').props.onClick();
      tree = renderModal(true);
      assert.equal(findTenderInput(tree, 'methodCash').props.value, '30');

      findTenderBtn(tree, 'methodCard').props.onClick();
      tree = renderModal(true);
      const cardRefAfter = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'payment-card-transaction-id',
      )[0];
      assert.equal(
        cardRefAfter.props.value,
        '',
        '1-tap switch away from Card clears stale transaction_id',
      );

      // Open partial-payment ConfirmDialog via Cash = 10 -> click Pay
      findTenderBtn(tree, 'methodCash').props.onClick();
      tree = renderModal(true);
      findTenderInput(tree, 'methodCash').props.onChange({ target: { value: '10' } });
      tree = renderModal(true);

      const payBtn = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      assert.ok(payBtn, 'Pay CTA button rendered');
      const payPromise = payBtn.props.onClick();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderModal(true);
      assert.equal(confirmOpen, true, 'Partial payment opens ConfirmDialog');

      const dispatchKey = (init: Record<string, any>) => {
        const event = {
          key: '',
          code: '',
          repeat: false,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          defaultPrevented: false,
          target: { tagName: 'BUTTON', getAttribute: () => null, closest: () => null },
          preventDefault() {
            this.defaultPrevented = true;
          },
          ...init,
        };
        for (const fn of keyListeners) fn(event);
        return event;
      };

      // Registered dismiss handler (POS Escape path) must return true without closing PaymentModal
      assert.equal(
        registeredDismiss?.(),
        true,
        'Registered dismiss handler swallows Escape while ConfirmDialog is open',
      );
      assert.equal(closeCount, 0, 'PaymentModal stays open while ConfirmDialog is open');

      // Enter / Space / digit keys must not be intercepted or mutate state behind ConfirmDialog
      const enterEvent = dispatchKey({ key: 'Enter', code: 'Enter' });
      const spaceEvent = dispatchKey({ key: ' ', code: 'Space' });
      const digitEvent = dispatchKey({ key: '5', code: 'Digit5' });
      tree = renderModal(true);
      assert.equal(
        enterEvent.defaultPrevented,
        false,
        'Enter is not prevented behind ConfirmDialog',
      );
      assert.equal(
        spaceEvent.defaultPrevented,
        false,
        'Space is not prevented behind ConfirmDialog',
      );
      assert.equal(
        digitEvent.defaultPrevented,
        false,
        'Digit is not intercepted behind ConfirmDialog',
      );
      assert.equal(payCalls, 0, 'Payment is not submitted behind ConfirmDialog');
      assert.equal(
        findTenderInput(tree, 'methodCash').props.value,
        '10',
        'Cash amount is not mutated while ConfirmDialog is open',
      );

      // Standalone Escape (without onRegisterDismissHandler) also stays open while ConfirmDialog is open
      tree = renderModal(false);
      dispatchKey({ key: 'Escape', code: 'Escape' });
      assert.equal(
        closeCount,
        0,
        'Standalone Escape does not close PaymentModal behind ConfirmDialog',
      );

      // Cancel ConfirmDialog, then Escape closes PaymentModal normally
      resolveConfirm?.(false);
      await payPromise;
      tree = renderModal(false);
      dispatchKey({ key: 'Escape', code: 'Escape' });
      assert.equal(closeCount, 1, 'Escape closes PaymentModal once ConfirmDialog closes');
    } finally {
      harness.cleanupAll();
      if (!hadWindow) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });

  console.log('  ✓ ConfirmDialog keyboard/Escape guards & 1-tap card ref clearing verified');
}

async function testGreptileReviewRegressions() {
  console.log('\n--- 10. Input Enter Discount Guard & Partial-Bill Recovered Cash Change ---');

  // 10a: PaymentModal & PrepaidCheckoutModal input Enter on card ref / tender inputs does NOT bypass open Discount panel
  await withAliases(async () => {
    const harness = createStatefulHarness();
    let payCalls = 0;
    try {
      installCheckoutComponentMocks(harness, {
        apiPost: async (url: string) => {
          if (String(url).endsWith('/payments')) {
            payCalls++;
            return {
              data: {
                bill: { ...makeBill('bill-disc-enter', 20), balance: 0, payment_status: 'paid' },
              },
            };
          }
          return { data: {} };
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      const bill = makeBill('bill-disc-enter', 20);
      const renderPm = () =>
        harness.renderAndSettle(PaymentModal, {
          bill,
          currency: 'USD',
          onClose: () => {},
          onPaid: () => {},
        });

      let tree = renderPm();
      await new Promise((r) => setTimeout(r, 15));
      tree = renderPm();
      const cardBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCard',
      )[0];
      assert.ok(cardBtn, 'PaymentModal Card tender button renders');
      cardBtn.props.onClick();
      tree = renderPm();

      const cardRefSetup = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'payment-card-transaction-id',
      )[0];
      assert.ok(cardRefSetup, 'PaymentModal card reference input renders');
      cardRefSetup.props.onChange({ target: { value: 'TXN-123' } });
      tree = renderPm();

      const discountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      assert.ok(discountTab, 'PaymentModal Discount tab renders');
      discountTab.props.onClick();
      tree = renderPm();

      const cardRefInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'payment-card-transaction-id',
      )[0];
      assert.ok(cardRefInput, 'PaymentModal card reference input still renders');
      let preventedWhileDiscountOpen = false;
      cardRefInput.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {
          preventedWhileDiscountOpen = true;
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        payCalls,
        0,
        'Enter in #payment-card-transaction-id does not submit while Discount panel is open',
      );
      assert.equal(
        preventedWhileDiscountOpen,
        false,
        'Enter in #payment-card-transaction-id is not intercepted while Discount panel is open',
      );

      // Close Discount panel, then Enter in #payment-card-transaction-id submits normally
      const discountTabClose = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      discountTabClose.props.onClick();
      tree = renderPm();
      const cardRefAfterClose = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'payment-card-transaction-id',
      )[0];
      cardRefAfterClose.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {},
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(
        payCalls,
        1,
        'Enter in #payment-card-transaction-id submits once Discount panel is closed',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  await withAliases(async () => {
    const ppHarness = createStatefulHarness();
    let confirmCalls = 0;
    try {
      installCheckoutComponentMocks(ppHarness, {
        cartState: {
          items: [
            {
              key: 'item-1',
              product: { id: 1, name: 'Latte', price: 15 },
              quantity: 1,
              variant: null,
              addons: [],
              notes: '',
            },
          ],
          orderType: 'takeaway',
          tableId: null,
          customer: null,
          deliveryAddress: '',
          notes: '',
          getSubtotal: () => 15,
        },
      });
      const ppPath = path.resolve(ROOT, 'frontend/src/components/pos/PrepaidCheckoutModal.tsx');
      delete require.cache[ppPath];
      const PrepaidCheckoutModal = require(ppPath).default;
      const renderPp = () =>
        ppHarness.renderAndSettle(PrepaidCheckoutModal, {
          currency: 'USD',
          onClose: () => {},
          onConfirm: async () => {
            confirmCalls++;
            return {
              bill: { id: 601, bill_number: 'B-601', total: 15, payment_status: 'paid' },
              customer: null,
              pointsEarned: 0,
            };
          },
        });

      let tree = renderPp();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderPp();

      const cardBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCard',
      )[0];
      cardBtn.props.onClick();
      tree = renderPp();

      const ppCardRefSetup = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'prepaid-card-transaction-id',
      )[0];
      assert.ok(ppCardRefSetup, 'Prepaid card reference input renders');
      ppCardRefSetup.props.onChange({ target: { value: 'TXN-456' } });
      tree = renderPp();

      const discountToggle = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] !== undefined &&
          renderToStaticMarkup(el).includes('discounts'),
      )[0];
      assert.ok(discountToggle, 'Prepaid Discounts toggle renders');
      discountToggle.props.onClick();
      tree = renderPp();

      const ppCardRef = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'prepaid-card-transaction-id',
      )[0];
      assert.ok(ppCardRef, 'Prepaid card reference input still renders');
      ppCardRef.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {},
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        confirmCalls,
        0,
        'Enter in #prepaid-card-transaction-id does not submit while Discount panel is open',
      );

      // Close Discount panel, then Enter in #prepaid-card-transaction-id submits normally
      const discountToggleClose = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] !== undefined &&
          renderToStaticMarkup(el).includes('discount'),
      )[0];
      discountToggleClose.props.onClick();
      tree = renderPp();
      const ppCardRefAfterClose = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.id === 'prepaid-card-transaction-id',
      )[0];
      ppCardRefAfterClose.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {},
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(
        confirmCalls,
        1,
        'Enter in #prepaid-card-transaction-id submits once Discount panel is closed',
      );
    } finally {
      ppHarness.cleanupAll();
    }
  });

  // 10b: Partially paid $100 bill ($40 prior payment, balance $60) + $100 cash tender -> lost response -> checkPaymentStatus updates balance to 0 -> idempotent replay preserves $40.00 change and $60.00 settled amount
  for (const includeServerPaymentDetails of [true, false]) {
    await withAliases(async () => {
      const storageMap = new Map<string, string>();
      const hadWindow = 'window' in globalThis;
      const prevWindow = (globalThis as any).window;
      (globalThis as any).window = {
        addEventListener: () => {},
        removeEventListener: () => {},
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
        const partialBill = {
          ...makeBill('bill-partial-change', 100),
          total: 100,
          paid_amount: 40,
          balance: 60,
          payment_status: 'partial',
        };
        const settledServerBill = {
          ...partialBill,
          paid_amount: 100,
          balance: 0,
          payment_status: 'paid',
          ...(includeServerPaymentDetails
            ? {
                payment_details: [
                  { method: 'card', amount: 40, requested_amount: 40 },
                  {
                    method: 'cash',
                    amount: 60,
                    requested_amount: 100,
                    tendered_amount: 100,
                    change_amount: 40,
                  },
                ],
              }
            : {}),
        };

        let payAttempts = 0;
        installCheckoutComponentMocks(harness, {
          apiGet: async (url: string) => {
            if (String(url).includes('/bills/bill-partial-change')) {
              return { data: { bill: settledServerBill } };
            }
            if (String(url).includes('loyalty/settings'))
              return { data: { loyalty_enabled: false } };
            if (String(url).includes('payment-methods')) return { data: { methods: [] } };
            if (String(url).includes('settings/discount'))
              return { data: { discount_mode: 'both', discount_requires_approval: false } };
            if (String(url).includes('settings')) return { data: { setting: { value: 'true' } } };
            return { data: {} };
          },
          apiPost: async (url: string) => {
            if (String(url).endsWith('/payments')) {
              payAttempts++;
              if (payAttempts === 1) {
                throw new Error('Network timeout after server committed payment');
              }
              return { data: { bill: settledServerBill, loyaltyPointsEarned: 0 } };
            }
            return { data: {} };
          },
        });

        const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
        delete require.cache[pmPath];
        const PaymentModal = require(pmPath).default;

        let activeBill: any = partialBill;
        const renderPm = () =>
          harness.renderAndSettle(PaymentModal, {
            bill: activeBill,
            currency: 'USD',
            onClose: () => {},
            onPaid: () => {},
            onBillUpdate: (updated: any) => {
              activeBill = updated;
            },
          });

        let tree = renderPm();
        const cashBtn = collectElements(
          tree,
          (el) => el.type === 'button' && el.props?.title === 'methodCash',
        )[0];
        cashBtn.props.onClick();
        tree = renderPm();

        const cashInput = collectElements(
          tree,
          (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
        )[0];
        cashInput.props.onChange({ target: { value: '100' } });
        tree = renderPm();

        // 1. Submit $100 cash tender -> network timeout locks pendingAttempt
        const payCta = collectElements(
          tree,
          (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
        ).pop();
        assert.ok(payCta, 'Initial Pay CTA rendered');
        await payCta.props.onClick();
        tree = renderPm();

        // 2. Check payment status -> updates activeBill.balance to 0, activeBill.paid_amount to 100
        const checkCta = collectElements(
          tree,
          (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
        ).pop();
        assert.ok(checkCta, 'Check Payment Status CTA rendered');
        await checkCta.props.onClick();
        tree = renderPm();
        assert.equal(activeBill.balance, 0, 'checkPaymentStatus updates bill.balance to 0');

        // 3. Replay idempotent payment -> completion screen must show $60.00 settled now and $40.00 cash change
        const retryCta = collectElements(
          tree,
          (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
        ).pop();
        assert.ok(retryCta, 'Retry Same Payment CTA rendered');
        await retryCta.props.onClick();
        tree = renderPm();

        const changeBanner = collectElements(
          tree,
          (el) => el.props?.['data-testid'] === 'settled-change-banner',
        )[0];
        assert.ok(
          changeBanner,
          `Recovered partial-bill cash payment renders settled-change-banner (payment_details=${includeServerPaymentDetails})`,
        );
        const changeMarkup = renderToStaticMarkup(changeBanner);
        assert.ok(
          changeMarkup.includes('$40.00'),
          `Recovered partial-bill cash payment displays $40.00 change (got ${changeMarkup})`,
        );

        const receiptCard = collectElements(tree, (el) => el.props?.role === 'status')[0];
        const receiptMarkup = renderToStaticMarkup(receiptCard);
        assert.ok(
          receiptMarkup.includes('$60.00'),
          `Recovered partial-bill cash payment displays $60.00 settled now instead of $100.00 cumulative (got ${receiptMarkup})`,
        );
      } finally {
        harness.cleanupAll();
        if (!hadWindow) delete (globalThis as any).window;
        else (globalThis as any).window = prevWindow;
      }
    });
  }

  console.log('  ✓ Input Enter discount guard & recovered partial-bill cash change verified');
}

async function testPaidBillCtaDisabledAndTableCheckoutHeaderStatus() {
  console.log('\n--- 11. Paid/Terminal Bill Pay CTA & TableCheckout Header Status Label ---');

  // 11a: Already-paid and terminal bills disable Pay CTA, block handlePay POST, and disable inputs
  for (const scenario of [
    {
      name: 'already-paid zero-balance bill',
      billOverrides: { payment_status: 'paid', balance: 0, paid_amount: 20 },
      expectedLabel: 'paid',
    },
    {
      name: 'refunded terminal bill',
      billOverrides: { payment_status: 'refunded', balance: 20, paid_amount: 0 },
      expectedLabel: 'refunded',
    },
    {
      name: 'partially refunded terminal bill',
      billOverrides: { payment_status: 'partially_refunded', balance: 10, paid_amount: 10 },
      expectedLabel: 'partiallyrefunded',
    },
    {
      name: 'cancelled order terminal bill',
      billOverrides: {
        payment_status: 'unpaid',
        balance: 20,
        paid_amount: 0,
        order: { ...makeBill('bill-cancelled', 20).order, status: 'cancelled' },
      },
      expectedLabel: 'cancelled',
      expectCancelledSplitNotice: true,
    },
  ]) {
    for (const splitSettingFails of [false, true]) {
      await withAliases(async () => {
        const harness = createStatefulHarness();
        try {
          let postCalls = 0;
          installCheckoutComponentMocks(harness, {
            apiGet: async (url: string) => {
              if (String(url).includes('loyalty/settings'))
                return { data: { loyalty_enabled: false } };
              if (String(url).includes('payment-methods')) return { data: { methods: [] } };
              if (String(url).includes('settings/split_checks_enabled')) {
                if (splitSettingFails) throw new Error('network error');
                return { data: { setting: { value: 'true' } } };
              }
              if (String(url).includes('settings/discount'))
                return { data: { discount_mode: 'both', discount_requires_approval: false } };
              return { data: {} };
            },
            apiPost: async () => {
              postCalls++;
              return { data: {} };
            },
          });
          const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
          delete require.cache[pmPath];
          const PaymentModal = require(pmPath).default;

          const bill = {
            ...makeBill(`bill-${scenario.name.replace(/\s+/g, '-')}`, 20),
            ...scenario.billOverrides,
          };
          const props = {
            bill,
            currency: 'USD',
            onClose: () => {},
            onPaid: () => {},
          };
          harness.renderAndSettle(PaymentModal, props);
          await new Promise((r) => setTimeout(r, 15));
          const tree = harness.renderAndSettle(PaymentModal, props);

          const payCta = collectElements(
            tree,
            (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
          ).pop();
          assert.ok(payCta, `${scenario.name}: primary Pay CTA rendered`);
          assert.equal(
            Boolean(payCta.props.disabled),
            true,
            `${scenario.name}: primary Pay CTA must be disabled`,
          );
          const ctaText = renderToStaticMarkup(payCta).toLowerCase();
          assert.ok(
            ctaText.includes(scenario.expectedLabel),
            `${scenario.name}: CTA label includes "${scenario.expectedLabel}" (got "${ctaText}")`,
          );

          await payCta.props.onClick();
          assert.equal(
            postCalls,
            0,
            `${scenario.name}: invoking Pay CTA handler must not POST a payment`,
          );

          const keypadFieldset = collectElements(tree, (el) => el.type === 'fieldset')[0];
          assert.equal(
            Boolean(keypadFieldset?.props?.disabled),
            true,
            `${scenario.name}: keypad fieldset is disabled`,
          );

          const cashInput = collectElements(
            tree,
            (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
          )[0];
          assert.equal(
            Boolean(cashInput?.props?.disabled),
            true,
            `${scenario.name}: tender input is disabled`,
          );

          const discountTab = collectElements(
            tree,
            (el) => el.props?.['data-testid'] === 'col1-tab-discount',
          )[0];
          assert.equal(
            Boolean(discountTab?.props?.disabled),
            true,
            `${scenario.name}: discount tab is disabled`,
          );

          const splitSection = collectElements(
            tree,
            (el) => el.props?.['data-testid'] === 'split-check-section',
          )[0];
          assert.ok(
            splitSection,
            `${scenario.name} (splitSettingFails=${splitSettingFails}): split-check-section rendered`,
          );
          const splitButtons = collectElements(
            splitSection,
            (el) => el.type === 'button' || typeof el.props?.onClick === 'function',
          );
          assert.ok(splitButtons.length > 0, `${scenario.name}: split section renders button`);
          for (const btn of splitButtons) {
            assert.equal(
              Boolean(btn.props?.disabled),
              true,
              `${scenario.name} (splitSettingFails=${splitSettingFails}): split-check button must be disabled`,
            );
          }
          if (scenario.expectCancelledSplitNotice && !splitSettingFails) {
            const splitMarkup = renderToStaticMarkup(splitSection);
            assert.ok(
              splitMarkup.includes('noFurtherActions'),
              `${scenario.name}: split section shows cancelled notice (got "${splitMarkup}")`,
            );
          }
        } finally {
          harness.cleanupAll();
        }
      });
    }
  }

  // 11b: TableCheckoutModal header badge formats partial / refunded / paid / unpaid consistently
  for (const statusCase of [
    { payment_status: 'partial', expectedText: 'partiallyPaid' },
    { payment_status: 'partially_paid', expectedText: 'partiallyPaid' },
    { payment_status: 'partially_refunded', expectedText: 'partiallyRefunded' },
    { payment_status: 'refunded', expectedText: 'refunded' },
    { payment_status: 'paid', expectedText: 'paid' },
    { payment_status: 'unpaid', expectedText: 'unpaid' },
  ]) {
    await withAliases(async () => {
      const harness = createStatefulHarness();
      try {
        installCheckoutComponentMocks(harness, {
          apiGet: async (url: string) => {
            if (String(url).includes('/tables/')) {
              return { data: { table: { id: 7, name: 'T7', activeOrder: { id: 77 } } } };
            }
            if (String(url).includes('/orders/')) {
              return {
                data: {
                  order: {
                    id: 77,
                    order_number: 707,
                    type: 'dine_in',
                    subtotal: 25,
                    tax_amount: 0,
                    total: 25,
                    items: [],
                    bill: {
                      id: 701,
                      bill_number: 'B-701',
                      total: 25,
                      balance: statusCase.payment_status === 'paid' ? 0 : 10,
                      payment_status: statusCase.payment_status,
                    },
                    bills: [],
                  },
                },
              };
            }
            if (String(url).includes('settings/split_checks_enabled')) {
              return { data: { setting: { value: 'false' } } };
            }
            return { data: {} };
          },
        });
        const baseLoad = Module._load;
        Module._load = function (request: string, parent: any, isMain: boolean) {
          if (
            request === '@/components/tables/MoveTableModal' ||
            request === '@/components/orders/EditOrderItemModal'
          ) {
            return { __esModule: true, default: () => null };
          }
          return baseLoad.call(this, request, parent, isMain);
        };

        const tcmPath = path.resolve(ROOT, 'frontend/src/components/pos/TableCheckoutModal.tsx');
        delete require.cache[tcmPath];
        const TableCheckoutModal = require(tcmPath).default;

        const props = {
          table: { id: 7, name: 'T7', status: 'occupied' },
          currency: 'USD',
          cartItemCount: 0,
          onClose: () => {},
          onAddItems: () => {},
          canGenerateBill: true,
          onPayment: () => {},
        };

        harness.renderAndSettle(TableCheckoutModal, props);
        await new Promise((r) => setTimeout(r, 15));
        const tree = harness.renderAndSettle(TableCheckoutModal, props);

        const headerBadge = collectElements(
          tree,
          (el) =>
            el.type === 'span' &&
            typeof el.props?.className === 'string' &&
            el.props.className.includes('rounded-full') &&
            el.props.className.includes('px-2.5'),
        )[0];
        assert.ok(
          headerBadge,
          `TableCheckoutModal header badge rendered for ${statusCase.payment_status}`,
        );
        const badgeText = renderToStaticMarkup(headerBadge);
        assert.ok(
          badgeText.includes(statusCase.expectedText),
          `TableCheckoutModal header badge for ${statusCase.payment_status} renders "${statusCase.expectedText}" (got "${badgeText}")`,
        );
      } finally {
        harness.cleanupAll();
      }
    });
  }

  // 11c: Unhydrated bill prop (no .order) picks up cancelled status from GET /bills/:id detailOrder
  await withAliases(async () => {
    const harness = createStatefulHarness();
    try {
      const unhydratedBill = {
        ...makeBill('bill-detail-cancelled', 20),
        order: undefined,
      };
      installCheckoutComponentMocks(harness, {
        apiGet: async (url: string) => {
          if (String(url).includes('/bills/bill-detail-cancelled')) {
            return {
              data: {
                bill: {
                  ...unhydratedBill,
                  order: { ...makeBill('bill-detail-cancelled', 20).order, status: 'cancelled' },
                },
              },
            };
          }
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('settings/split_checks_enabled'))
            return { data: { setting: { value: 'true' } } };
          if (String(url).includes('settings/discount'))
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          return { data: {} };
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;

      const props = {
        bill: unhydratedBill,
        currency: 'USD',
        onClose: () => {},
        onPaid: () => {},
      };
      harness.renderAndSettle(PaymentModal, props);
      await new Promise((r) => setTimeout(r, 15));
      const tree = harness.renderAndSettle(PaymentModal, props);

      const payCta = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      assert.equal(
        Boolean(payCta?.props?.disabled),
        true,
        'Unhydrated bill with cancelled detailOrder disables Pay CTA',
      );
      assert.ok(
        renderToStaticMarkup(payCta).toLowerCase().includes('cancelled'),
        'Unhydrated bill with cancelled detailOrder labels Pay CTA Cancelled',
      );

      const strip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      assert.ok(
        renderToStaticMarkup(strip).includes('noFurtherActions'),
        'Unhydrated bill with cancelled detailOrder shows noFurtherActions banner',
      );

      const splitSection = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'split-check-section',
      )[0];
      assert.ok(splitSection, 'Split section rendered for cancelled detailOrder');
      for (const btn of collectElements(splitSection, (el) => el.type === 'button')) {
        assert.equal(
          Boolean(btn.props?.disabled),
          true,
          'Cancelled detailOrder disables Split Check button',
        );
      }
      assert.ok(
        renderToStaticMarkup(splitSection).includes('noFurtherActions'),
        'Cancelled detailOrder split section explains noFurtherActions',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  // 11d: Completion WhatsApp actions pass settledBill (with post-settlement fields and hydrated order)
  for (const waReady of [false, true]) {
    await withAliases(async () => {
      const harness = createStatefulHarness();
      try {
        const sentBills: any[] = [];
        const sharedBills: any[] = [];
        const splitPropBill = {
          ...makeBill('bill-wa-settled', 20),
          order: undefined,
        };
        const hydratedOrder = {
          ...makeBill('bill-wa-settled', 20).order,
          customer: { id: 9, name: 'Ada', phone: '5551234', country_code: '+1' },
        };
        const settledServerBill = {
          ...splitPropBill,
          payment_status: 'paid',
          paid_amount: 20,
          balance: 0,
        };

        installCheckoutComponentMocks(harness, {
          apiGet: async (url: string) => {
            if (String(url).includes('/bills/bill-wa-settled')) {
              return { data: { bill: { ...splitPropBill, order: hydratedOrder } } };
            }
            if (String(url).includes('loyalty/settings'))
              return { data: { loyalty_enabled: false } };
            if (String(url).includes('payment-methods')) return { data: { methods: [] } };
            if (String(url).includes('settings/split_checks_enabled'))
              return { data: { setting: { value: 'false' } } };
            if (String(url).includes('settings/discount'))
              return { data: { discount_mode: 'both', discount_requires_approval: false } };
            return { data: {} };
          },
          apiPost: async (url: string) => {
            if (String(url).endsWith('/payments')) {
              return { data: { bill: settledServerBill, loyaltyPointsEarned: 0 } };
            }
            return { data: {} };
          },
        });
        const baseLoad = Module._load;
        Module._load = function (request: string, parent: any, isMain: boolean) {
          if (request === '@/hooks/useWhatsAppReady') {
            return { useWhatsAppReady: () => waReady };
          }
          if (request === '@/lib/whatsapp-share') {
            return {
              sendBillViaFlo: async (passedBill: any) => {
                sentBills.push(passedBill);
              },
              shareBillViaWhatsApp: async (passedBill: any) => {
                sharedBills.push(passedBill);
                return true;
              },
            };
          }
          return baseLoad.call(this, request, parent, isMain);
        };

        const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
        delete require.cache[pmPath];
        const PaymentModal = require(pmPath).default;

        const props = {
          bill: splitPropBill,
          currency: 'USD',
          onClose: () => {},
          onPaid: () => {},
        };
        harness.renderAndSettle(PaymentModal, props);
        await new Promise((r) => setTimeout(r, 15));
        let tree = harness.renderAndSettle(PaymentModal, props);

        const cashBtn = collectElements(
          tree,
          (el) => el.type === 'button' && el.props?.title === 'methodCash',
        )[0];
        cashBtn.props.onClick();
        tree = harness.renderAndSettle(PaymentModal, props);

        const payCta = collectElements(
          tree,
          (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
        ).pop();
        await payCta.props.onClick();
        tree = harness.renderAndSettle(PaymentModal, props);

        const waBtn = collectElements(
          tree,
          (el) =>
            typeof el.props?.onClick === 'function' &&
            renderToStaticMarkup(el).includes(waReady ? 'sendViaWhatsApp' : 'shareViaWhatsApp'),
        )[0];
        assert.ok(waBtn, `WhatsApp completion button rendered (waReady=${waReady})`);
        await waBtn.props.onClick();

        const passed = waReady ? sentBills[0] : sharedBills[0];
        assert.ok(passed, `WhatsApp handler invoked with bill (waReady=${waReady})`);
        assert.equal(
          passed.payment_status,
          'paid',
          `WhatsApp handler receives settled payment_status='paid' (waReady=${waReady})`,
        );
        assert.ok(
          Array.isArray(passed.order?.items) && passed.order.items.length > 0,
          `WhatsApp handler receives hydrated order items (waReady=${waReady})`,
        );
      } finally {
        harness.cleanupAll();
      }
    });
  }

  console.log('  ✓ Paid/terminal bill CTA guard & TableCheckout header status label verified');
}

async function testTenderInputAndZeroBalanceEnterGuards() {
  console.log('\n--- 12. Tender Input Enter With Discount Panel & Zero-Balance Unpaid Bill ---');

  // 12a: PaymentModal & PrepaidCheckoutModal tender input Enter submits once amountTarget leaves discount even while Discount tab remains open
  await withAliases(async () => {
    const harness = createStatefulHarness();
    let payCalls = 0;
    try {
      installCheckoutComponentMocks(harness, {
        apiPost: async (url: string) => {
          if (String(url).endsWith('/payments')) {
            payCalls++;
            return {
              data: {
                bill: {
                  ...makeBill('bill-tender-focus-enter', 20),
                  balance: 0,
                  payment_status: 'paid',
                },
              },
            };
          }
          return { data: {} };
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      const bill = makeBill('bill-tender-focus-enter', 20);
      const renderPm = () =>
        harness.renderAndSettle(PaymentModal, {
          bill,
          currency: 'USD',
          onClose: () => {},
          onPaid: () => {},
        });

      let tree = renderPm();
      await new Promise((r) => setTimeout(r, 15));
      tree = renderPm();

      const cashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      cashBtn.props.onClick();
      tree = renderPm();

      const discountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      discountTab.props.onClick();
      tree = renderPm();

      const cashInputWhileDiscountTarget = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.ok(cashInputWhileDiscountTarget, 'PaymentModal cash amount input renders');
      let preventedWhileTargetDiscount = false;
      cashInputWhileDiscountTarget.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {
          preventedWhileTargetDiscount = true;
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        payCalls,
        0,
        'Enter in tender input stays blocked while amountTarget is discount',
      );
      assert.equal(
        preventedWhileTargetDiscount,
        false,
        'Enter in tender input is not intercepted while amountTarget is discount',
      );

      cashInputWhileDiscountTarget.props.onFocus();
      tree = renderPm();

      const discountTabStillOpen = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['data-testid'] === 'col1-tab-discount' &&
          el.props?.['aria-expanded'] === true,
      )[0];
      assert.ok(
        discountTabStillOpen,
        'Discount panel remains open in Col 1 after focusing tender input',
      );

      const cashInputFocused = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      let preventedOnFocusedTender = false;
      cashInputFocused.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {
          preventedOnFocusedTender = true;
        },
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(
        preventedOnFocusedTender,
        true,
        'Enter in focused tender input calls preventDefault even while Discount panel is open',
      );
      assert.equal(
        payCalls,
        1,
        'Enter in focused tender input submits payment while Discount panel is open',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  await withAliases(async () => {
    const ppHarness = createStatefulHarness();
    let confirmCalls = 0;
    try {
      installCheckoutComponentMocks(ppHarness);
      const ppPath = path.resolve(ROOT, 'frontend/src/components/pos/PrepaidCheckoutModal.tsx');
      delete require.cache[ppPath];
      const PrepaidCheckoutModal = require(ppPath).default;
      const renderPp = () =>
        ppHarness.renderAndSettle(PrepaidCheckoutModal, {
          currency: 'USD',
          onClose: () => {},
          onConfirm: async () => {
            confirmCalls++;
            return {
              bill: { id: 602, bill_number: 'B-602', total: 20, payment_status: 'paid' },
              customer: null,
              pointsEarned: 0,
            };
          },
        });

      let tree = renderPp();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderPp();

      const ppCashBtn = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'methodCash',
      )[0];
      assert.ok(ppCashBtn, 'Prepaid Cash tender button renders');
      ppCashBtn.props.onClick();
      tree = renderPp();

      const discountToggle = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] !== undefined &&
          renderToStaticMarkup(el).includes('discounts'),
      )[0];
      discountToggle.props.onClick();
      tree = renderPp();

      const ppCashInputDiscountTarget = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      assert.ok(ppCashInputDiscountTarget, 'Prepaid cash amount input renders');
      ppCashInputDiscountTarget.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {},
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        confirmCalls,
        0,
        'Prepaid tender Enter stays blocked while amountTarget is discount',
      );

      ppCashInputDiscountTarget.props.onFocus();
      tree = renderPp();

      const ppCashInputFocused = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      let ppPreventedOnFocusedTender = false;
      ppCashInputFocused.props.onKeyDown({
        key: 'Enter',
        repeat: false,
        nativeEvent: { isComposing: false },
        keyCode: 13,
        preventDefault() {
          ppPreventedOnFocusedTender = true;
        },
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(
        ppPreventedOnFocusedTender,
        true,
        'Prepaid Enter in focused tender input calls preventDefault while Discount panel is open',
      );
      assert.equal(
        confirmCalls,
        1,
        'Prepaid Enter in focused tender input submits while Discount panel is open',
      );
    } finally {
      ppHarness.cleanupAll();
    }
  });

  // 12b: Zero-balance unpaid bills settle on both window Enter and tender input Enter, while paid/cancelled bills stay blocked
  for (const mode of ['window-enter', 'tender-input-enter'] as const) {
    await withAliases(async () => {
      const harness = createStatefulHarness();
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

      let zeroPayCalls = 0;
      let lastPayUrl = '';
      const zeroUnpaidBill = {
        ...makeBill('bill-zero-enter', 0),
        subtotal: 20,
        discount_amount: 20,
        discount_type: 'percentage',
        discount_value: 100,
        total: 0,
        balance: 0,
        paid_amount: 0,
        payment_status: 'unpaid',
      };
      try {
        installCheckoutComponentMocks(harness, {
          apiGet: async (url: string) => {
            if (String(url).includes('/bills/')) return { data: { bill: zeroUnpaidBill } };
            if (String(url).includes('loyalty/settings'))
              return { data: { loyalty_enabled: false } };
            if (String(url).includes('payment-methods')) return { data: { methods: [] } };
            if (String(url).includes('printers')) return { data: { printers: [] } };
            if (String(url).includes('settings/discount'))
              return { data: { discount_mode: 'both', discount_requires_approval: false } };
            if (String(url).includes('settings')) return { data: { setting: { value: 'true' } } };
            return { data: {} };
          },
          apiPost: async (url: string) => {
            lastPayUrl = String(url);
            if (lastPayUrl.endsWith('/payment') || lastPayUrl.endsWith('/payments')) {
              zeroPayCalls++;
              return {
                data: {
                  bill: {
                    ...makeBill('bill-zero-enter', 0),
                    total: 0,
                    balance: 0,
                    paid_amount: 0,
                    payment_status: 'paid',
                  },
                },
              };
            }
            return { data: {} };
          },
        });
        const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
        delete require.cache[pmPath];
        const PaymentModal = require(pmPath).default;
        const renderPm = () =>
          harness.renderAndSettle(PaymentModal, {
            bill: zeroUnpaidBill,
            currency: 'USD',
            onClose: () => {},
            onPaid: () => {},
          });

        let tree = renderPm();
        await new Promise((r) => setTimeout(r, 15));
        tree = renderPm();

        if (mode === 'window-enter') {
          for (const listener of keyListeners) {
            listener({
              key: 'Enter',
              code: 'Enter',
              repeat: false,
              isComposing: false,
              keyCode: 13,
              ctrlKey: false,
              metaKey: false,
              altKey: false,
              target: { tagName: 'DIV', getAttribute: () => null, closest: () => null },
              preventDefault() {},
            });
          }
        } else {
          const cashInput = collectElements(
            tree,
            (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
          )[0];
          assert.ok(cashInput, 'PaymentModal cash input renders for zero-balance unpaid bill');
          cashInput.props.onKeyDown({
            key: 'Enter',
            repeat: false,
            nativeEvent: { isComposing: false },
            keyCode: 13,
            preventDefault() {},
          });
        }

        await new Promise((r) => setTimeout(r, 15));
        assert.equal(zeroPayCalls, 1, `Zero-balance unpaid bill submits on ${mode}`);
        assert.ok(
          lastPayUrl.endsWith('/payment'),
          `Zero-balance unpaid bill settles through /payment on ${mode}`,
        );
      } finally {
        harness.cleanupAll();
        if (hadWindow) {
          (globalThis as any).window = prevWindow;
        } else {
          delete (globalThis as any).window;
        }
      }
    });
  }

  for (const blockedScenario of [
    {
      name: 'already-paid zero-balance bill',
      bill: {
        ...makeBill('bill-paid-zero-enter', 0),
        total: 20,
        balance: 0,
        paid_amount: 20,
        payment_status: 'paid',
      },
    },
    {
      name: 'cancelled zero-balance bill',
      bill: {
        ...makeBill('bill-cancelled-zero-enter', 0),
        total: 0,
        balance: 0,
        paid_amount: 0,
        payment_status: 'unpaid',
        order: { id: 101, order_number: 'ORD-CANC', status: 'cancelled', items: [] },
      },
    },
  ]) {
    await withAliases(async () => {
      const harness = createStatefulHarness();
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
      let payCalls = 0;
      try {
        installCheckoutComponentMocks(harness, {
          apiGet: async (url: string) => {
            if (String(url).includes('/bills/')) return { data: { bill: blockedScenario.bill } };
            if (String(url).includes('loyalty/settings'))
              return { data: { loyalty_enabled: false } };
            if (String(url).includes('payment-methods')) return { data: { methods: [] } };
            if (String(url).includes('printers')) return { data: { printers: [] } };
            if (String(url).includes('settings/discount'))
              return { data: { discount_mode: 'both', discount_requires_approval: false } };
            if (String(url).includes('settings')) return { data: { setting: { value: 'true' } } };
            return { data: {} };
          },
          apiPost: async (url: string) => {
            if (String(url).endsWith('/payment') || String(url).endsWith('/payments')) {
              payCalls++;
            }
            return { data: {} };
          },
        });
        const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
        delete require.cache[pmPath];
        const PaymentModal = require(pmPath).default;
        const renderPm = () =>
          harness.renderAndSettle(PaymentModal, {
            bill: blockedScenario.bill,
            currency: 'USD',
            onClose: () => {},
            onPaid: () => {},
          });
        let tree = renderPm();
        await new Promise((r) => setTimeout(r, 15));
        tree = renderPm();

        for (const listener of keyListeners) {
          listener({
            key: 'Enter',
            code: 'Enter',
            repeat: false,
            isComposing: false,
            keyCode: 13,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: { tagName: 'DIV', getAttribute: () => null, closest: () => null },
            preventDefault() {},
          });
        }
        const cashInput = collectElements(
          tree,
          (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
        )[0];
        cashInput?.props?.onKeyDown({
          key: 'Enter',
          repeat: false,
          nativeEvent: { isComposing: false },
          keyCode: 13,
          preventDefault() {},
        });
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(payCalls, 0, `Enter stays blocked on ${blockedScenario.name}`);
      } finally {
        harness.cleanupAll();
        if (hadWindow) {
          (globalThis as any).window = prevWindow;
        } else {
          delete (globalThis as any).window;
        }
      }
    });
  }

  console.log(
    '  ✓ Tender input Enter with discount panel & zero-balance unpaid Enter guards verified',
  );
}

async function testCol1PanelHeaderBodyConsistency() {
  // 1. PrepaidCheckoutModal: initialDiscount while discountModeLoaded=false, then discount_mode='none' vs 'both'
  for (const mode of ['none', 'both'] as const) {
    await withAliases(async () => {
      const harness = createStatefulHarness();
      let closeCount = 0;
      let registeredDismiss: (() => boolean) | undefined;
      try {
        installCheckoutComponentMocks(harness, {
          apiGet: async (url: string) => {
            if (String(url).includes('settings/discount')) {
              return { data: { discount_mode: mode, discount_requires_approval: false } };
            }
            if (String(url).includes('loyalty/settings'))
              return { data: { loyalty_enabled: false } };
            if (String(url).includes('payment-methods')) return { data: { payment_methods: [] } };
            if (String(url).includes('settings')) return { data: { setting: { value: 'false' } } };
            return { data: {} };
          },
        });
        const ppPath = path.resolve(ROOT, 'frontend/src/components/pos/PrepaidCheckoutModal.tsx');
        delete require.cache[ppPath];
        const PrepaidCheckoutModal = require(ppPath).default;
        const props = {
          currency: 'USD',
          initialDiscount: { type: 'percentage' as const, value: 10, reason: 'VIP' },
          onClose: () => {
            closeCount++;
          },
          onConfirm: async () => undefined,
          onRegisterDismissHandler: (fn?: () => boolean) => {
            registeredDismiss = fn;
          },
        };

        // Initial render before /settings/discount resolves (discountModeLoaded === false)
        let tree = harness.render(PrepaidCheckoutModal, props);
        const initialMarkup = renderToStaticMarkup(tree);
        assert.ok(
          !initialMarkup.includes('discountReasonPlaceholder'),
          'Prepaid items body renders before discountModeLoaded',
        );
        assert.ok(
          !initialMarkup.includes('>back<'),
          'Prepaid header does not show Back badge before discountModeLoaded',
        );
        assert.equal(
          registeredDismiss?.(),
          true,
          'Dismiss handler exists on initial PrepaidCheckoutModal render',
        );
        assert.equal(
          closeCount,
          1,
          'Escape closes modal on initial render when discount panel is not yet eligible',
        );
        closeCount = 0;

        // Settle /settings/discount
        await new Promise((r) => setTimeout(r, 10));
        tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
        const settledMarkup = renderToStaticMarkup(tree);
        if (mode === 'none') {
          assert.ok(
            !settledMarkup.includes('discountReasonPlaceholder'),
            'Prepaid discount body stays hidden when discount_mode=none',
          );
          assert.ok(
            !settledMarkup.includes('>back<'),
            'Prepaid header shows Items (not Back [Discount]) when discount_mode=none',
          );
          registeredDismiss?.();
          assert.equal(closeCount, 1, 'Escape closes modal directly when discount_mode=none');
        } else {
          assert.ok(
            settledMarkup.includes('discountReasonPlaceholder'),
            'Prepaid discount body renders once discountModeLoaded and discount_mode=both',
          );
          assert.ok(
            settledMarkup.includes('>back<'),
            'Prepaid header shows Back badge matching Discount panel when discount_mode=both',
          );
          registeredDismiss?.();
          assert.equal(
            closeCount,
            0,
            'First Escape backs out of visible Discount panel instead of closing modal',
          );
        }
      } finally {
        harness.cleanupAll();
      }
    });
  }

  // 2. PrepaidCheckoutModal: Tax panel falls back cleanly when tax preview becomes null
  await withAliases(async () => {
    const harness = createStatefulHarness();
    let closeCount = 0;
    let registeredDismiss: (() => boolean) | undefined;
    let returnNullTax = false;
    try {
      installCheckoutComponentMocks(harness, {
        taxPreview: () =>
          returnNullTax
            ? { tax: null, loading: false }
            : {
                tax: {
                  subtotal: 20,
                  discount_amount: 0,
                  discounted_subtotal: 20,
                  tax_amount: 2,
                  total: 22,
                  tax_breakdown: [{ title: 'VAT', rate: 10, amount: 2 }],
                  packaging_charge: 0,
                  charges_breakdown: [],
                  round_off: 0,
                },
                loading: false,
              },
      });
      const ppPath = path.resolve(ROOT, 'frontend/src/components/pos/PrepaidCheckoutModal.tsx');
      delete require.cache[ppPath];
      const PrepaidCheckoutModal = require(ppPath).default;
      const props = {
        currency: 'USD',
        onClose: () => {
          closeCount++;
        },
        onConfirm: async () => undefined,
        onRegisterDismissHandler: (fn?: () => boolean) => {
          registeredDismiss = fn;
        },
      };

      let tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      await new Promise((r) => setTimeout(r, 10));
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);

      const taxBtn = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['aria-expanded'] !== undefined &&
          renderToStaticMarkup(el).includes('tax'),
      )[0];
      assert.ok(taxBtn, 'Tax toggle button renders in PrepaidCheckoutModal summary');
      taxBtn.props.onClick();
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      assert.ok(
        renderToStaticMarkup(tree).includes('>back<'),
        'Prepaid header shows Back badge while Tax panel is active',
      );

      returnNullTax = true;
      tree = harness.renderAndSettle(PrepaidCheckoutModal, props);
      assert.ok(
        !renderToStaticMarkup(tree).includes('>back<'),
        'Prepaid header agrees with Items fallback when preview becomes null',
      );
      registeredDismiss?.();
      assert.equal(closeCount, 1, 'Escape closes modal when Tax panel falls back to Items');
    } finally {
      harness.cleanupAll();
    }
  });

  // 3a. PaymentModal: discount panel resets when split_group_id makes it ineligible
  await withAliases(async () => {
    const harness = createStatefulHarness();
    let closeCount = 0;
    let registeredDismiss: (() => boolean) | undefined;
    try {
      let currentBill: any = makeBill('bill-col1-pm', 20);
      installCheckoutComponentMocks(harness, {
        apiGet: async (url: string) => {
          if (String(url).includes('/bills/')) return { data: { bill: currentBill } };
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('printers')) return { data: { printers: [] } };
          if (String(url).includes('settings/discount'))
            return { data: { discount_mode: 'both', discount_requires_approval: false } };
          if (String(url).includes('settings')) return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      const renderPm = () =>
        harness.renderAndSettle(PaymentModal, {
          bill: currentBill,
          currency: 'USD',
          onClose: () => {
            closeCount++;
          },
          onPaid: () => {},
          onRegisterDismissHandler: (fn?: () => boolean) => {
            registeredDismiss = fn;
          },
        });

      let tree = renderPm();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderPm();

      const discountTab = collectElements(
        tree,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      assert.ok(discountTab, 'PaymentModal discount tab renders');
      discountTab.props.onClick();
      tree = renderPm();
      assert.ok(
        renderToStaticMarkup(tree).includes('>back<') &&
          renderToStaticMarkup(tree).includes('discountReasonPlaceholder'),
        'PaymentModal shows Back + Discount panel while eligible',
      );

      // Bill updates to a split check -> discount panel becomes ineligible
      currentBill = { ...currentBill, split_group_id: 'split-1' };
      tree = renderPm();
      const splitMarkup = renderToStaticMarkup(tree);
      assert.ok(
        !splitMarkup.includes('discountReasonPlaceholder'),
        'PaymentModal hides Discount body on split check',
      );
      assert.ok(
        !splitMarkup.includes('>back<'),
        'PaymentModal header resets to Items when Discount becomes ineligible on split check',
      );
      registeredDismiss?.();
      assert.equal(
        closeCount,
        1,
        'Escape closes PaymentModal instead of being trapped on hidden Discount',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  // 3b. PaymentModal: partial payment clearing kitchenOverrideRequired resets header/body to Items
  await withAliases(async () => {
    const harness = createStatefulHarness();
    let closeCount = 0;
    let registeredDismiss: (() => boolean) | undefined;
    try {
      const currentBill: any = makeBill('bill-col1-ko', 20);
      installCheckoutComponentMocks(harness, {
        managerApprovers: {
          approvers: [{ id: 'mgr-1', name: 'Manager', role: 'manager', has_pin: true }],
          selectedApproverId: 'mgr-1',
        },
        apiGet: async (url: string) => {
          if (String(url).includes('/bills/')) return { data: { bill: currentBill } };
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('printers')) return { data: { printers: [] } };
          if (String(url).includes('settings/discount'))
            return { data: { discount_mode: 'none', discount_requires_approval: false } };
          if (String(url).includes('settings')) return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
        apiPost: async (url: string) => {
          if (String(url).endsWith('/payment') || String(url).endsWith('/payments')) {
            return {
              data: {
                bill: {
                  ...currentBill,
                  paid_amount: 10,
                  balance: 10,
                  payment_status: 'partial',
                },
              },
            };
          }
          return { data: {} };
        },
      });
      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      const renderPm = () =>
        harness.renderAndSettle(PaymentModal, {
          bill: currentBill,
          currency: 'USD',
          initialOverridePin: '1234',
          onClose: () => {
            closeCount++;
          },
          onPaid: () => {},
          onRegisterDismissHandler: (fn?: () => boolean) => {
            registeredDismiss = fn;
          },
        });
      let tree = renderPm();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderPm();
      assert.ok(
        renderToStaticMarkup(tree).includes('kitchenDeliveryOverridePrompt'),
        'PaymentModal opens kitchen-override panel with initialOverridePin',
      );

      const cashInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'methodCash amount',
      )[0];
      cashInput.props.onChange({ target: { value: '10' } });
      tree = renderPm();
      const payBtn = collectElements(
        tree,
        (el) => typeof el.props?.onClick === 'function' && el.props?.size === 'lg',
      ).pop();
      await payBtn.props.onClick();
      tree = renderPm();
      const afterPartialMarkup = renderToStaticMarkup(tree);
      assert.ok(
        !afterPartialMarkup.includes('kitchenDeliveryOverridePrompt'),
        'Kitchen override body clears after partial payment',
      );
      assert.ok(
        !afterPartialMarkup.includes('>back<'),
        'PaymentModal header resets to Items when partial payment clears kitchenOverrideRequired',
      );
      registeredDismiss?.();
      assert.equal(
        closeCount,
        1,
        'Escape closes PaymentModal after partial payment clears kitchen override',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  console.log('  ✓ Column 1 panel header/body/dismiss consistency verified');
}

async function testDiscountPinErrorAndStatusStripRecovery() {
  console.log(
    '\n--- 13. Discount PIN Structured Error, Stale Banner Clear & Status Strip Alignment ---',
  );

  // 13a. CheckoutPaymentStation must align overflowing status strip alerts from the top (no items-center clipping)
  await withAliases(async () => {
    const stationPath = path.resolve(
      ROOT,
      'frontend/src/components/pos/CheckoutPaymentStation.tsx',
    );
    delete require.cache[stationPath];
    const harness = createStatefulHarness();
    try {
      installCheckoutComponentMocks(harness);
      const { CheckoutPaymentStation } = require(stationPath);
      const alertMarkup = renderToStaticMarkup(
        harness.hooksReact.createElement(
          CheckoutPaymentStation,
          {
            readout: {
              activeLabel: 'Card',
              amountText: '$64.20',
              paidSummaryText: 'Payment: $64.20',
              dueSummaryText: 'Total: $64.20',
              statusPillText: 'Exact due',
              statusTone: 'ready',
            },
            quickTenders: [],
            keypad: harness.hooksReact.createElement('div', null, 'keypad'),
            changeDisplay: {
              label: 'Change Returned',
              formattedAmount: '$0.00',
              visible: false,
            },
            statusBanner: {
              tone: 'error',
              message: 'This transaction reference is already recorded on another bill.',
              nextStep: 'Correct the payment details or choose another method, then try again.',
              technicalDetails: '{"operation":"payment.create"}',
              technicalDetailsLabel: 'Technical details',
              closeLabel: 'Close',
            },
          },
          harness.hooksReact.createElement('button', { type: 'button' }, 'Pay $64.20'),
        ),
      );
      const stripSlice = alertMarkup.slice(
        alertMarkup.indexOf('data-testid="checkout-status-strip"'),
      );
      const scrollBoxMatch = stripSlice.match(/<div class="([^"]*overflow-y-auto[^"]*)"/);
      assert.ok(scrollBoxMatch, 'checkout-status-strip renders scrollable message container');
      assert.ok(
        !scrollBoxMatch![1].split(/\s+/).includes('items-center'),
        'checkout-status-strip scroll container must not use items-center (which clips top of overflowing headlines)',
      );
      assert.ok(
        scrollBoxMatch![1].split(/\s+/).includes('items-start'),
        'checkout-status-strip scroll container aligns overflowing alerts at items-start',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  // 13b. PaymentModal discount wrong-PIN error shows kitchenDeliveryOverrideInvalid (not unknown) and clears on valid retry
  await withAliases(async () => {
    const harness = createStatefulHarness();
    const opRef = '22222222-3333-4444-8555-666666666666';
    let currentBill: any = makeBill('bill-disc-pin', 100);
    try {
      installCheckoutComponentMocks(harness, {
        operationReference: opRef,
        managerApprovers: {
          approvers: [{ id: 'mgr-1', name: 'Manager', role: 'manager', has_pin: true }],
          selectedApproverId: 'mgr-1',
        },
        apiGet: async (url: string) => {
          if (String(url).includes('/bills/')) return { data: { bill: currentBill } };
          if (String(url).includes('loyalty/settings')) return { data: { loyalty_enabled: false } };
          if (String(url).includes('payment-methods')) return { data: { methods: [] } };
          if (String(url).includes('printers')) return { data: { printers: [] } };
          if (String(url).includes('settings/discount')) {
            return { data: { discount_mode: 'both', discount_requires_approval: true } };
          }
          if (String(url).includes('settings')) return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
        apiPatch: async (url: string, body: any) => {
          if (!String(url).includes('/discount')) return { data: {} };
          if (body.override_pin !== '1234') {
            throw {
              response: {
                status: 403,
                data: {
                  error: 'Invalid manager PIN',
                  reason_code: 'discount.rejected',
                  operation: 'order.discount',
                  stage: 'validation',
                  classification: 'expected_rejection',
                  outcome: 'not_applied',
                  correlation_id: opRef,
                },
              },
            };
          }
          currentBill = {
            ...currentBill,
            discount_type: body.discount_type,
            discount_value: body.discount_value,
            discount_amount: 10,
            total: 90,
            balance: 90,
          };
          return { data: { order: currentBill.order } };
        },
      });

      const pmPath = path.resolve(ROOT, 'frontend/src/components/pos/PaymentModal.tsx');
      delete require.cache[pmPath];
      const PaymentModal = require(pmPath).default;
      const renderPm = () =>
        harness.renderAndSettle(PaymentModal, {
          bill: currentBill,
          currency: 'USD',
          onClose: () => {},
          onPaid: () => {},
          onBillUpdate: (updated: any) => {
            currentBill = updated;
          },
        });

      let tree = renderPm();
      await new Promise((r) => setTimeout(r, 10));
      tree = renderPm();

      // Open discount panel
      const discountTabBtn = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'col1-tab-discount',
      )[0];
      discountTabBtn.props.onClick();
      tree = renderPm();

      // Enter 10% discount and wrong manager PIN
      const discInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'number' && el.props?.max === 100,
      )[0];
      discInput.props.onChange({ target: { value: '10' } });
      tree = renderPm();

      const pinInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'password',
      )[0];
      pinInput.props.onChange({ target: { value: '0000' } });
      tree = renderPm();

      const applyBtn = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['data-testid'] !== 'col1-tab-discount' &&
          typeof el.props?.onClick === 'function' &&
          JSON.stringify(el.props?.children).includes('applyDiscount'),
      )[0];
      assert.ok(applyBtn, 'Apply Discount submit button found');
      await applyBtn.props.onClick();
      tree = renderPm();

      const errorStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      assert.equal(
        errorStrip?.props?.['data-status-tone'],
        'error',
        'Invalid discount PIN displays error status strip',
      );
      const errorStripText = JSON.stringify(errorStrip);
      assert.ok(
        errorStripText.includes('kitchenDeliveryOverrideInvalid') &&
          !errorStripText.includes('discountOutcomeUnknown'),
        'Invalid discount PIN reports invalid PIN instead of discountOutcomeUnknown',
      );

      // Retry with valid manager PIN
      const retryPinInput = collectElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'password',
      )[0];
      retryPinInput.props.onChange({ target: { value: '1234' } });
      tree = renderPm();

      const retryApplyBtn = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.['data-testid'] !== 'col1-tab-discount' &&
          typeof el.props?.onClick === 'function' &&
          (JSON.stringify(el.props?.children).includes('applyDiscount') ||
            JSON.stringify(el.props?.children).includes('updateDiscount')),
      )[0];
      assert.ok(retryApplyBtn, 'Retry Apply Discount submit button found');
      await retryApplyBtn.props.onClick();
      tree = renderPm();

      const clearedStrip = collectElements(
        tree,
        (el) => el.props?.['data-testid'] === 'checkout-status-strip',
      )[0];
      assert.notEqual(
        clearedStrip?.props?.['data-status-tone'],
        'error',
        'Successful discount retry clears stale error banner from status strip',
      );
    } finally {
      harness.cleanupAll();
    }
  });

  console.log('  ✓ Discount PIN error, stale banner clear & status strip alignment verified');
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
  await testVisualHierarchyAndPrematurePaidGuards();
  await testPrincipalUxErgonomicsAndCompletionParity();
  await testConfirmDialogAndCardReferenceSwitchGuards();
  await testGreptileReviewRegressions();
  await testPaidBillCtaDisabledAndTableCheckoutHeaderStatus();
  await testTenderInputAndZeroBalanceEnterGuards();
  await testCol1PanelHeaderBodyConsistency();
  await testDiscountPinErrorAndStatusStripRecovery();
  console.log('\n✅ All checkout quick-tender and guard tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
