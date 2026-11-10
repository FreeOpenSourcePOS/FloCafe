/**
 * Unified Split Check UX & Touch-Friendly Stepper Regression Suite
 *
 * Verifies:
 * 1. Pure allocation helpers (`rebalanceRowAllocation`, `buildEvenAllocations`):
 *    - 1-tap `+` transfer across guests without over-allocating `item.quantity`
 *    - Multi-unit donor selection (largest donor first, later guest tie-break)
 *    - Bounds clamping and round-robin even distribution reset
 * 2. `SplitCheckModal` (`mode === 'table'` and `mode === 'guest'`):
 *    - Touch-friendly `size-9 min-h-9 min-w-9` `−` / `+` steppers on check count,
 *      every table-grid guest cell, and every leaving-guest row
 *    - Per-row unassigned status badge when decremented below `item.quantity`
 *    - 1-tap `Distribute evenly` in table mode and `Clear` + row highlight in guest mode
 * 3. `PaymentModal` unified Split section:
 *    - Consolidates Equal Share and Split by Items into `unified-split-card` at the
 *      top of the right column and removes duplicate split controls from sticky footer
 *    - Equal Share `−` / `+` steppers (`2..20` bounds) and `2` / `3` / `4` 1-tap presets
 *    - 2-tab mode switcher (`split-mode-items-tab` / `split-mode-equal-tab`) with
 *      `split-check-section` mounted immediately when `split_checks_enabled` is true
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrencyUnitAdapter } from '../main/countries';

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

Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
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
                : request.startsWith('@print/')
                  ? path.resolve(ROOT, 'shared/print', request.slice('@print/'.length))
                  : request.startsWith('@shared/')
                    ? path.resolve(ROOT, 'shared', request.slice('@shared/'.length))
                    : request.startsWith('@/')
                      ? path.resolve(ROOT, 'frontend/src', request.slice(2))
                      : request;
  return originalResolveFilename.call(this, resolved, parent, isMain, options);
};

const React = frontendRequire('react');
const ReactDOMServer = frontendRequire('react-dom/server');

function collectElements(
  node: unknown,
  predicate: (element: any) => boolean,
  out: any[] = [],
): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const props = (node as { props?: { children?: unknown } }).props;
  if (props) collectElements(props.children, predicate, out);
  return out;
}

function findByTestId(node: unknown, testId: string): any | undefined {
  return collectElements(node, (el) => el.props?.['data-testid'] === testId)[0];
}

function findById(node: unknown, id: string): any | undefined {
  return collectElements(node, (el) => el.props?.id === id)[0];
}

function createHarness() {
  const origUseState = React.useState;
  const origUseEffect = React.useEffect;
  const origUseRef = React.useRef;
  const origUseCallback = React.useCallback;
  const origUseMemo = React.useMemo;

  return function mount(Component: any, initialProps: any, options?: { runEffectsOnce?: boolean }) {
    const states: unknown[] = [];
    const refs: Array<{ current: unknown }> = [];
    let props = initialProps;
    let effectsRan = false;

    const render = () => {
      let stateIdx = 0;
      let refIdx = 0;
      const pendingEffects: Array<() => unknown> = [];

      React.useState = ((initial: unknown) => {
        const idx = stateIdx++;
        if (!(idx in states)) {
          states[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        }
        const setState = (next: unknown) => {
          states[idx] =
            typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
        };
        return [states[idx], setState];
      }) as typeof React.useState;

      React.useRef = ((initial: unknown) => {
        const idx = refIdx++;
        if (!refs[idx]) refs[idx] = { current: initial };
        return refs[idx];
      }) as typeof React.useRef;

      React.useEffect = ((effect: () => unknown) => {
        if (options?.runEffectsOnce && !effectsRan) {
          pendingEffects.push(effect);
        }
      }) as typeof React.useEffect;

      React.useCallback = ((fn: any) => fn) as typeof React.useCallback;
      React.useMemo = ((fn: () => unknown) => fn()) as typeof React.useMemo;

      let tree: any;
      let html = '';
      try {
        // Allow render-phase state reconciliation (PaymentModal balance/discount sync)
        for (let pass = 0; pass < 4; pass++) {
          const snapshot = states.slice();
          stateIdx = 0;
          refIdx = 0;
          pendingEffects.length = 0;
          tree = Component(props);
          const changed = states.some((val, i) => val !== snapshot[i]);
          if (!changed) break;
        }
        html = ReactDOMServer.renderToStaticMarkup(tree);
      } finally {
        React.useState = origUseState;
        React.useEffect = origUseEffect;
        React.useRef = origUseRef;
        React.useCallback = origUseCallback;
        React.useMemo = origUseMemo;
      }

      if (pendingEffects.length > 0) {
        effectsRan = true;
        for (const eff of pendingEffects) eff();
      }

      return { tree, html };
    };

    return {
      render,
      setProps(nextProps: any) {
        props = nextProps;
      },
      states,
    };
  };
}

async function run() {
  const Icon = () => React.createElement('span');
  const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
  let splitChecksSettingValue = 'false';
  let splitSettingShouldFail = false;
  const postedPayloads: Array<{ url: string; body: any }> = [];
  const toastErrors: string[] = [];

  const cart = {
    customer: null,
    customerId: null,
    items: [],
    orderType: 'dine_in',
    waivedChargeIds: new Set<string>(),
    optedInChargeIds: new Set<string>(),
    itemCount: () => 0,
  };
  const currentTenant = { currency: 'USD', country: 'US', role: 'manager' };

  const mocks: Record<string, unknown> = {
    'lucide-react': {
      X: Icon,
      Wallet: Icon,
      ArrowLeftRight: Icon,
      CheckCircle2: Icon,
      Sparkles: Icon,
      User: Icon,
      Users: Icon,
      Minus: Icon,
      Plus: Icon,
      RotateCcw: Icon,
      Percent: Icon,
      Send: Icon,
      ChevronDown: Icon,
      Banknote: Icon,
      CreditCard: Icon,
    },
    '@/components/ui/button': {
      Button: ({ children, variant: _variant, size: _size, ...props }: any) =>
        React.createElement('button', props, children),
    },
    '@/components/pos/TaxBreakdown': { __esModule: true, default: () => null },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: async (url: string) => {
          if (url === '/settings/split_checks_enabled') {
            if (splitSettingShouldFail) {
              const err: any = new Error('boom');
              err.response = { status: 500 };
              throw err;
            }
            return { data: { setting: { value: splitChecksSettingValue } } };
          }
          if (url === '/payment-methods') return { data: { payment_methods: [] } };
          if (url === '/settings/discount')
            return { data: { discount_mode: 'percentage', discount_requires_approval: false } };
          if (url === '/settings/loyalty') return { data: { loyalty_enabled: false } };
          if (url === '/settings/card_transaction_id_required')
            return { data: { setting: { value: 'false' } } };
          return { data: {} };
        },
        post: async (url: string, body: any) => {
          postedPayloads.push({ url, body });
          return { data: { bills: [{ id: 1 }, { id: 2 }] } };
        },
        patch: async () => ({ data: {} }),
      },
      captureClientOperationFailure: async () => undefined,
      createOperationReference: () => 'op-ref-1',
      operationHeaders: () => ({}),
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
    '@/lib/printer/tax-components': { resolveTaxComponents: () => [] },
    '@/store/cart': {
      useCartStore: (selector?: (state: typeof cart) => unknown) =>
        selector ? selector(cart) : cart,
    },
    '@/store/charges': {
      useChargesStore: (selector: (s: any) => unknown) =>
        selector({ charges: [], load: async () => undefined }),
      chargesForOrderType: () => [],
    },
    '@/hooks/use-confirm': {
      useConfirm: () => ({ confirm: async () => true, ConfirmDialog: null }),
    },
    '@/hooks/useManagerApprovers': {
      useManagerApprovers: () => ({
        approvers: [],
        selectedApproverId: null,
        loading: false,
        loadFailed: false,
      }),
    },
    '@/components/ApproverSelect': { ApproverSelect: () => null },
    'use-intl': {
      useTranslations: () => (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
      useLocale: () => 'en-US',
    },
    '@/lib/payment-methods': {
      PAYMENT_METHODS: [
        { key: 'cash', icon: Icon },
        { key: 'card', icon: Icon },
      ],
    },
    '@/hooks/useFormatCurrency': {
      useFormatCurrency: () => (amount: number) => `$${Number(amount).toFixed(2)}`,
    },
    '@/hooks/useFormatNumber': { useFormatNumber: () => (amount: number) => String(amount) },
    '@/hooks/useCurrencyUnitAdapter': { useCurrencyUnitAdapter: () => usdAdapter },
    '@/hooks/useWhatsAppReady': { useWhatsAppReady: () => false },
    '@/lib/whatsapp-share': {
      sendBillViaFlo: async () => undefined,
      shareBillViaWhatsApp: async () => undefined,
    },
    '@/store/auth': { useAuthStore: () => ({ currentTenant }) },
    '@/lib/permissions': { tenantCan: () => true },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  };

  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const {
      SplitCheckModal,
      buildEvenAllocations,
      rebalanceRowAllocation,
    } = require('../frontend/src/components/pos/SplitCheckModal');
    const PaymentModal = require('../frontend/src/components/pos/PaymentModal').default;
    const mount = createHarness();

    // -------------------------------------------------------------------------
    // 1. Pure rebalancing & even-distribution helpers
    // -------------------------------------------------------------------------
    assert.deepEqual(
      rebalanceRowAllocation([1, 0], 1, 1, 1),
      [0, 1],
      '1-unit item transfers from Guest 1 to Guest 2 in a single tap without over-allocating',
    );
    assert.deepEqual(
      rebalanceRowAllocation([0, 1], 0, 1, 1),
      [1, 0],
      '1-unit item transfers back from Guest 2 to Guest 1 in a single tap',
    );
    assert.deepEqual(
      rebalanceRowAllocation([2, 1, 0], 2, 1, 3),
      [1, 1, 1],
      'multi-unit rebalance pulls from the guest with the largest allocation first',
    );
    assert.deepEqual(
      rebalanceRowAllocation([1, 1, 0], 2, 1, 2),
      [1, 0, 1],
      'tied donors rebalance from the later guest column cleanly',
    );
    assert.deepEqual(
      rebalanceRowAllocation([1, 1], 0, 0, 2),
      [0, 1],
      'decrementing below item quantity leaves remaining units unassigned without mutating siblings',
    );
    assert.deepEqual(
      rebalanceRowAllocation([1, 1], 1, 99, 2),
      [0, 2],
      'over-max input clamps to item.quantity and pulls excess from siblings',
    );
    assert.deepEqual(
      rebalanceRowAllocation([1, 0], 0, -5, 1),
      [0, 0],
      'negative input clamps to 0',
    );

    const sampleItems = [
      { id: 101, product_name: 'Burger', quantity: 1, total: 12, status: 'pending' },
      { id: 102, product_name: 'Fries', quantity: 3, total: 9, status: 'pending' },
    ];
    assert.deepEqual(
      buildEvenAllocations(sampleItems as any, 2),
      { 101: [1, 0], 102: [1, 2] },
      'buildEvenAllocations spreads units round-robin across checks',
    );
    console.log('  ✓ Pure split rebalancing and even-distribution helpers verified');

    // -------------------------------------------------------------------------
    // 2. SplitCheckModal interactive steppers (table & guest modes)
    // -------------------------------------------------------------------------
    const splitBill = {
      id: 10,
      bill_number: 'B-10',
      order_id: 50,
      subtotal: 21,
      tax_amount: 0,
      discount_amount: 0,
      total: 21,
      paid_amount: 0,
      balance: 21,
      payment_status: 'unpaid',
      split_group_id: null,
      split_label: null,
    };
    const splitOrder = {
      id: 50,
      order_number: '50',
      type: 'dine_in',
      guest_count: 2,
      items: sampleItems,
    };

    let splitCompleted = false;
    const modal = mount(SplitCheckModal, {
      bill: splitBill,
      order: splitOrder,
      onClose: () => undefined,
      onSplit: () => {
        splitCompleted = true;
      },
    });

    // Initial render in table mode (`All items`)
    let rendered = modal.render();
    const countDec = findByTestId(rendered.tree, 'split-check-count-decrement');
    const countInc = findByTestId(rendered.tree, 'split-check-count-increment');
    assert(countDec && countInc, 'Number of checks renders touch-friendly - / + buttons');
    assert.match(countDec.props.className, /\bsize-9\b/, 'check count - button uses size-9');
    assert.match(countInc.props.className, /\bsize-9\b/, 'check count + button uses size-9');
    assert.equal(countDec.props.disabled, true, 'check count - disabled at MIN_CHECKS (2)');
    assert.equal(countInc.props.disabled, false, 'check count + enabled below maxTableChecks');

    // Burger (id 101, qty 1) starts [1, 0]: Guest 1 has 1 (+ disabled), Guest 2 has 0 (- disabled)
    const burgerG0Inc = findByTestId(rendered.tree, 'split-cell-inc-101-0');
    const burgerG1Dec = findByTestId(rendered.tree, 'split-cell-dec-101-1');
    const burgerG1Inc = findByTestId(rendered.tree, 'split-cell-inc-101-1');
    assert(burgerG0Inc && burgerG1Dec && burgerG1Inc, 'table cells render - / + steppers');
    assert.match(burgerG1Inc.props.className, /\bsize-9\b/, 'table cell + button uses size-9');
    assert.equal(burgerG0Inc.props.disabled, true, 'Guest 1 + disabled when holding all 1 unit');
    assert.equal(burgerG1Dec.props.disabled, true, 'Guest 2 - disabled at 0');
    assert.equal(
      findByTestId(rendered.tree, 'split-row-unassigned-101'),
      undefined,
      'fully allocated row shows no unassigned warning badge',
    );

    // 1-tap transfer: clicking + on Guest 2 moves Burger from [1, 0] -> [0, 1]
    burgerG1Inc.props.onClick();
    rendered = modal.render();
    assert.equal(
      findByTestId(rendered.tree, 'split-row-unassigned-101'),
      undefined,
      '1-tap + transfer keeps row fully allocated with zero unassigned units',
    );
    assert.equal(
      findByTestId(rendered.tree, 'split-cell-dec-101-0').props.disabled,
      true,
      'Guest 1 was automatically decremented to 0',
    );
    assert.equal(
      findByTestId(rendered.tree, 'split-cell-inc-101-1').props.disabled,
      true,
      'Guest 2 now holds 1/1 unit',
    );

    // Decrementing Guest 2 leaves 1 unassigned unit and surfaces the amber status pill
    findByTestId(rendered.tree, 'split-cell-dec-101-1').props.onClick();
    rendered = modal.render();
    const unassignedPill = findByTestId(rendered.tree, 'split-row-unassigned-101');
    assert(unassignedPill, 'unassigned row renders status pill');
    assert.match(
      ReactDOMServer.renderToStaticMarkup(unassignedPill),
      /remainingCount:\{&quot;count&quot;:1\}/,
      'status pill reports exact unassigned count',
    );

    // 1-tap Distribute evenly restores round-robin allocation and clears unassigned badge
    const distributeBtn = findByTestId(rendered.tree, 'split-distribute-evenly');
    assert(distributeBtn, 'table toolbar exposes Distribute evenly button');
    distributeBtn.props.onClick();
    rendered = modal.render();
    assert.equal(
      findByTestId(rendered.tree, 'split-row-unassigned-101'),
      undefined,
      'Distribute evenly restores full allocation',
    );

    // Submitting valid allocation succeeds without allocateAllItems toast error
    toastErrors.length = 0;
    postedPayloads.length = 0;
    const createChecksBtn = collectElements(
      rendered.tree,
      (el) => typeof el.props?.onClick === 'function' && el.props?.children === 'createChecks',
    )[0];
    assert(createChecksBtn, 'Create checks submit button rendered');
    await createChecksBtn.props.onClick();
    assert.equal(toastErrors.length, 0, 'no validation error on balanced table split');
    assert.equal(postedPayloads.length, 1, 'split-check POST sent once');
    assert.equal(splitCompleted, true, 'onSplit callback invoked');

    // Switch to guest mode (`Selected items`) and verify size-9 steppers, bounds, highlight & Clear
    const guestModeBtn = collectElements(
      rendered.tree,
      (el) => typeof el.props?.onClick === 'function' && el.props?.children === 'splitModeSelected',
    )[0];
    assert(guestModeBtn, 'Selected items mode button exists');
    guestModeBtn.props.onClick();
    rendered = modal.render();

    const guestDec101 = findByTestId(rendered.tree, 'guest-item-dec-101');
    const guestInc101 = findByTestId(rendered.tree, 'guest-item-inc-101');
    assert(guestDec101 && guestInc101, 'guest mode renders - / + buttons');
    assert.match(guestDec101.props.className, /\bsize-9\b/, 'guest - button uses size-9');
    assert.match(guestInc101.props.className, /\bsize-9\b/, 'guest + button uses size-9');
    assert.equal(guestDec101.props.disabled, true, 'guest - button disabled at 0');
    assert.equal(guestInc101.props.disabled, false, 'guest + button enabled below item.quantity');
    assert.equal(
      findByTestId(rendered.tree, 'guest-split-clear'),
      undefined,
      'Clear button hidden when 0 items selected',
    );

    guestInc101.props.onClick();
    rendered = modal.render();
    assert.equal(
      findByTestId(rendered.tree, 'guest-item-inc-101').props.disabled,
      true,
      'guest + button disabled once selected reaches item.quantity (1)',
    );
    assert.match(rendered.html, /bg-brand\/5/, 'selected row receives visual highlight');
    const clearGuestBtn = findByTestId(rendered.tree, 'guest-split-clear');
    assert(clearGuestBtn, 'Clear button appears when selectedUnits > 0');
    clearGuestBtn.props.onClick();
    rendered = modal.render();
    assert.equal(
      findByTestId(rendered.tree, 'guest-item-dec-101').props.disabled,
      true,
      'Clear resets guest item selection back to 0',
    );
    console.log('  ✓ SplitCheckModal table & guest steppers, smart transfer, and reset verified');

    // -------------------------------------------------------------------------
    // 3. PaymentModal unified Split card (Equal Share steppers/presets + By Items tab)
    // -------------------------------------------------------------------------
    const paymentSource = fs.readFileSync(
      path.join(ROOT, 'frontend/src/components/pos/PaymentModal.tsx'),
      'utf8',
    );
    const unifiedSplitIdx = paymentSource.indexOf('data-testid="unified-split-card"');
    const handlePayIdx = paymentSource.indexOf('onClick={handlePay}');
    const splitSectionMatches = paymentSource.match(/data-testid="split-check-section"/g) ?? [];
    assert.ok(
      unifiedSplitIdx > 0 && unifiedSplitIdx < handlePayIdx,
      'unified-split-card is placed in the main right column before the sticky footer',
    );
    assert.equal(
      paymentSource.slice(handlePayIdx - 400).includes('data-testid="split-check-section"'),
      false,
      'sticky footer no longer duplicates split-check-section above Pay CTA',
    );
    assert.equal(
      splitSectionMatches.length,
      2,
      'split-check-section exists only for error and ready branches inside unified-split-card',
    );

    const paymentBill = {
      id: 99,
      bill_number: 'B-99',
      order_id: 500,
      customer_id: null,
      subtotal: 100,
      tax_amount: 0,
      discount_amount: 0,
      delivery_charge: 0,
      packaging_charge: 0,
      service_charge: 0,
      round_off: 0,
      total: 100,
      paid_amount: 0,
      balance: 100,
      payment_status: 'unpaid',
      order: {
        id: 500,
        type: 'dine_in',
        guest_count: 2,
        items: [{ id: 1, product_name: 'Platter', quantity: 2, total: 100, status: 'delivered' }],
      },
    };

    // 3a. splitChecksEnabled = false: shows Equal Share directly without 2-tab clutter
    splitChecksSettingValue = 'false';
    splitSettingShouldFail = false;
    const pmEqualOnly = mount(PaymentModal, {
      bill: paymentBill,
      currency: 'USD',
      onClose: () => undefined,
      onPaid: () => undefined,
    });
    let pmRender = pmEqualOnly.render();
    assert(findByTestId(pmRender.tree, 'unified-split-card'), 'unified-split-card rendered');
    assert.equal(
      findByTestId(pmRender.tree, 'split-mode-items-tab'),
      undefined,
      '2-tab switcher omitted when splitChecksEnabled is false',
    );

    const equalHeaderBtn = collectElements(
      pmRender.tree,
      (el) => el.type === 'button' && el.props?.['aria-expanded'] === false,
    ).find((el) => ReactDOMServer.renderToStaticMarkup(el).includes('splitPaymentEqually'));
    assert(
      equalHeaderBtn,
      'Split payment equally accordion button rendered with aria-expanded=false',
    );
    equalHeaderBtn.props.onClick();
    pmRender = pmEqualOnly.render();

    const eqInput = findById(pmRender.tree, 'equal-share-payers');
    const eqDec = findByTestId(pmRender.tree, 'equal-share-decrement');
    const eqInc = findByTestId(pmRender.tree, 'equal-share-increment');
    const preset2 = findByTestId(pmRender.tree, 'equal-share-preset-2');
    const preset3 = findByTestId(pmRender.tree, 'equal-share-preset-3');
    const preset4 = findByTestId(pmRender.tree, 'equal-share-preset-4');
    assert(eqInput && eqDec && eqInc, 'Equal Share renders #equal-share-payers flanked by - / +');
    assert(preset2 && preset3 && preset4, 'Equal Share renders 2, 3, 4 quick-tap preset pills');
    assert.match(
      eqDec.props.className,
      /\bmin-h-9\b.*\bmin-w-9\b/,
      'Equal Share - is min-h-9 min-w-9',
    );
    assert.match(
      eqInc.props.className,
      /\bmin-h-9\b.*\bmin-w-9\b/,
      'Equal Share + is min-h-9 min-w-9',
    );
    assert.equal(eqInput.props.value, '2', 'initial payer count matches guest_count=2');
    assert.equal(eqDec.props.disabled, true, 'Equal Share - disabled at MIN_EQUAL_SHARE_PAYERS=2');
    assert.equal(eqInc.props.disabled, false, 'Equal Share + enabled at 2');

    // Step + from 2 -> 3
    eqInc.props.onClick();
    pmRender = pmEqualOnly.render();
    assert.equal(
      findById(pmRender.tree, 'equal-share-payers').props.value,
      '3',
      '+ increments to 3',
    );
    assert.equal(
      collectElements(pmRender.tree, (el) =>
        String(el.props?.['data-testid'] || '').startsWith('equal-share-share-'),
      ).length,
      3,
      '3 share rows previewed',
    );

    // 1-tap preset 4 sets payers to 4 ($25.00 each)
    findByTestId(pmRender.tree, 'equal-share-preset-4').props.onClick();
    pmRender = pmEqualOnly.render();
    assert.equal(
      findById(pmRender.tree, 'equal-share-payers').props.value,
      '4',
      'preset 4 sets payers to 4 in 1 tap',
    );
    assert.equal(
      findByTestId(pmRender.tree, 'equal-share-preset-4').props['aria-pressed'],
      true,
      'preset 4 marked active',
    );
    assert.match(
      ReactDOMServer.renderToStaticMarkup(findByTestId(pmRender.tree, 'equal-share-share-0')),
      /\$25\.00/,
      '4-way split of $100 previews $25.00 shares',
    );

    // Ceiling check at MAX_EQUAL_SHARE_PAYERS (20)
    findById(pmRender.tree, 'equal-share-payers').props.onChange({ target: { value: '20' } });
    pmRender = pmEqualOnly.render();
    assert.equal(
      findByTestId(pmRender.tree, 'equal-share-increment').props.disabled,
      true,
      'Equal Share + disabled at MAX_EQUAL_SHARE_PAYERS=20',
    );
    findByTestId(pmRender.tree, 'equal-share-decrement').props.onClick();
    pmRender = pmEqualOnly.render();
    assert.equal(
      findById(pmRender.tree, 'equal-share-payers').props.value,
      '19',
      'Equal Share - steps down from 20 to 19',
    );

    // 3b. splitChecksEnabled = true: mounts 2-tab mode switcher + split-check-section immediately
    splitChecksSettingValue = 'true';
    const pmUnified = mount(
      PaymentModal,
      {
        bill: paymentBill,
        currency: 'USD',
        onClose: () => undefined,
        onPaid: () => undefined,
      },
      { runEffectsOnce: true },
    );
    pmUnified.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    pmRender = pmUnified.render();

    const itemsTab = findByTestId(pmRender.tree, 'split-mode-items-tab');
    const equalTab = findByTestId(pmRender.tree, 'split-mode-equal-tab');
    const splitSection = findByTestId(pmRender.tree, 'split-check-section');
    assert(itemsTab && equalTab, '2-tab mode switcher rendered when splitChecksEnabled is true');
    assert(splitSection, 'split-check-section mounted immediately on open without extra clicks');
    assert.equal(
      equalTab.props['aria-expanded'],
      false,
      'equal share tab starts aria-expanded=false',
    );
    assert.match(
      ReactDOMServer.renderToStaticMarkup(splitSection),
      /splitCheck/,
      'Split check trigger button rendered inside split-check-section',
    );

    // Switching to Equal Share tab inside unified card
    equalTab.props.onClick();
    pmRender = pmUnified.render();
    assert.equal(
      findByTestId(pmRender.tree, 'split-mode-equal-tab').props['aria-expanded'],
      true,
      'clicking Equal Share tab sets aria-expanded=true',
    );
    assert(
      findById(pmRender.tree, 'equal-share-payers'),
      'Equal Share stepper controls appear inside unified Split card',
    );

    // Switching back to By Items tab restores split-check-section
    findByTestId(pmRender.tree, 'split-mode-items-tab').props.onClick();
    pmRender = pmUnified.render();
    assert(
      findByTestId(pmRender.tree, 'split-check-section'),
      'clicking Split items tab restores split-check-section',
    );
    console.log(
      '  ✓ PaymentModal unified Split card, 2-tab switcher, steppers, and presets verified',
    );
  } finally {
    Module._load = originalLoad;
    Module._resolveFilename = originalResolveFilename;
  }

  console.log('\n✅ All unified split-check UX tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
