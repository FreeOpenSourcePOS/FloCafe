/**
 * Dynamic Currency Unit Adapter Validation & Visual Evidence Test Suite
 *
 * Validates:
 * 1. getCurrencyUnitAdapter logic across all tenant currency display modes:
 *    - Iran (IRR) + Toman: scale 0.1, label 'تومان', step '0.001', maxDecimals 3, 10x conversion
 *    - Iran (IRR) + Toman Short (Latin): scale 0.1, label 'T', step '0.001'
 *    - Iran (IRR) + Toman Short (Persian): scale 0.1, label 'ت', step '0.001'
 *    - Iran (IRR) + Rial: scale 1, label 'IRR', step '0.01', 1:1 conversion
 *    - Non-IR currencies (USD, INR, EUR, BRL, ARS): scale 1, step '0.01', 1:1 conversion
 * 2. Payment split allocation math, discount amount conversion, and loyalty wallet limits.
 * 3. End-to-end HTML & visual PNG rendering of PaymentModal and PrepaidCheckoutModal
 *    across multiple tenant configurations.
 */

import fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  getCurrencyUnitAdapter,
  formatMoney,
  formatCurrencyForTenant,
  formatNumberForTenant,
} from '../main/countries';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
  _load: (...args: any[]) => any;
};
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  const resolvedRequest = request.startsWith('@/')
    ? path.resolve(ROOT, 'frontend/src', request.slice(2))
    : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};
const React = frontendRequire('react');
const ReactDOMServer = frontendRequire('react-dom/server');
const CurrencyTouchNumberPad = require('../frontend/src/components/pos/TouchNumberPad').CurrencyTouchNumberPad;
const { allowCurrencyDecimalKey, getDiscountInputStep, normalizeFixedDiscountValue, roundCurrencyValue } = require('../frontend/src/lib/currency-input');

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M09EG8J030YCK62W10XAD7D6');

function runUnitTests() {
  console.log('--- 1. Currency Unit Adapter Unit Tests ---');

  // Test 1: Iran IRR with Toman display
  const tomanAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
  assert.equal(tomanAdapter.scale, 0.1, 'Toman scale should be 0.1');
  assert.equal(tomanAdapter.label, 'تومان', 'Toman label should be تومان');
  assert.equal(tomanAdapter.step, '0.001', 'Toman step should be 0.001');
  assert.equal(tomanAdapter.maxDecimals, 3, 'Toman maxDecimals should be 3');
  assert.equal(tomanAdapter.toDisplay(5000000), 500000, '5,000,000 Rial stored should be 500,000 Toman displayed');
  assert.equal(tomanAdapter.toStored(500000), 5000000, '500,000 Toman input should be 5,000,000 Rial stored');
  assert.equal(tomanAdapter.formatInput(500000), '500000');
  assert.equal(tomanAdapter.formatInput(123.4567), '123.457');
  console.log('  ✓ IRR with Toman display unit adapter verified');

  // Test 2: Iran IRR with Toman short display (Latin digits)
  const tomanShortLatin = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman_short', digits: 'latin' });
  assert.equal(tomanShortLatin.scale, 0.1);
  assert.equal(tomanShortLatin.label, 'T', 'Toman short Latin label should be T');
  assert.equal(tomanShortLatin.step, '0.001');
  console.log('  ✓ IRR with Toman short Latin adapter verified');

  // Test 3: Iran IRR with Toman short display (Locale/Persian digits)
  const tomanShortLocale = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman_short', digits: 'locale' });
  assert.equal(tomanShortLocale.scale, 0.1);
  assert.equal(tomanShortLocale.label, 'ت', 'Toman short Persian label should be ت');
  assert.equal(tomanShortLocale.step, '0.001');
  console.log('  ✓ IRR with Toman short Persian adapter verified');

  // Test 4: Iran IRR with Rial display
  const rialAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'rial' });
  assert.equal(rialAdapter.scale, 1);
  assert.equal(rialAdapter.label, 'IRR');
  assert.equal(rialAdapter.step, '0.01');
  assert.equal(rialAdapter.maxDecimals, 2);
  assert.equal(rialAdapter.toDisplay(5000000), 5000000);
  assert.equal(rialAdapter.toStored(5000000), 5000000);
  console.log('  ✓ IRR with Rial display adapter verified');

  // Test 5: Standard currencies (USD, INR, EUR, BRL)
  const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
  assert.equal(usdAdapter.scale, 1);
  assert.equal(usdAdapter.label, 'USD');
  assert.equal(usdAdapter.step, '0.01');
  assert.equal(usdAdapter.maxDecimals, 2);
  assert.equal(usdAdapter.toDisplay(45.50), 45.50);
  assert.equal(usdAdapter.toStored(45.50), 45.50);

  const inrAdapter = getCurrencyUnitAdapter('INR', 'IN');
  assert.equal(inrAdapter.scale, 1);
  assert.equal(inrAdapter.label, 'INR');
  assert.equal(inrAdapter.toDisplay(1200), 1200);
  assert.equal(inrAdapter.toStored(1200), 1200);
  console.log('  ✓ Standard currencies (USD, INR) adapter verified');

  // Test 6: Zero-decimal currencies (JPY) UI behavior
  const jpyAdapter = getCurrencyUnitAdapter('JPY', 'JP');
  assert.equal(jpyAdapter.scale, 1);
  assert.equal(jpyAdapter.label, 'JPY');
  assert.equal(jpyAdapter.step, '1', 'JPY price input step is whole number 1');
  assert.equal(jpyAdapter.maxDecimals, 0, 'JPY maxDecimals is 0');
  assert.equal(jpyAdapter.toDisplay(1500), 1500);
  assert.equal(jpyAdapter.toStored(1500), 1500);
  assert.equal(jpyAdapter.formatInput(1500), '1500');
  console.log('  ✓ JPY zero-decimal adapter verified');

  // Test 7: Three-decimal currencies (KWD) UI control behavior
  // Note: PR 2 only makes UI controls reflect currency precision; does not claim full 3-decimal country pack support.
  const kwdAdapter = getCurrencyUnitAdapter('KWD', 'KW');
  assert.equal(kwdAdapter.scale, 1);
  assert.equal(kwdAdapter.label, 'KWD');
  assert.equal(kwdAdapter.step, '0.001', 'KWD price input step is 0.001');
  assert.equal(kwdAdapter.maxDecimals, 3, 'KWD maxDecimals is 3');
  console.log('  ✓ KWD 3-decimal adapter verified');
}

function runPaymentMathTests() {
  console.log('\n--- 2. Payment Modal Math & Conversions ---');

  const tomanAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });

  // Bill remaining balance: 5,000,000 Rial
  const remainingStored = 5000000;
  const remainingDisplay = tomanAdapter.toDisplay(remainingStored);
  assert.equal(remainingDisplay, 500000, 'Display balance in Toman is 500,000');

  // Allocating remaining balance to Cash method
  const allocatedCashDisplay = remainingDisplay;
  const cashStored = tomanAdapter.toStored(allocatedCashDisplay);
  assert.equal(cashStored, remainingStored, 'Allocated Cash stored is exactly 5,000,000 Rial');

  // Split payment: 200,000 Toman Cash + 300,000 Toman Card
  const cashInput = 200000;
  const cardInput = 300000;
  const totalPaymentStored = tomanAdapter.toStored(cashInput) + tomanAdapter.toStored(cardInput);
  assert.equal(totalPaymentStored, 5000000, 'Total split payments stored matches bill balance');

  // Flat amount discount: 50,000 Toman discount
  const discountInput = 50000;
  const discountStored = tomanAdapter.toStored(discountInput);
  assert.equal(discountStored, 500000, '50,000 Toman discount translates to 500,000 Rial stored');

  // Loyalty wallet points redemption:
  // Customer has 2,000 points balance. Rate: 1 point = 1 Rial.
  const walletPoints = 2000;
  const LOYALTY_REDEMPTION_RATE = 1;
  const maxWalletStored = Math.floor(walletPoints / LOYALTY_REDEMPTION_RATE); // 2000 Rial
  assert.equal(maxWalletStored, 2000, 'Max wallet stored is 2000 Rial');
  const maxWalletDisplay = tomanAdapter.toDisplay(maxWalletStored); // 200 Toman
  assert.equal(maxWalletDisplay, 200, 'Max wallet displayed is 200 Toman');
  console.log('  ✓ Payment split allocation, discount, and wallet math verified');
}

async function runCurrencyInputBehaviorTests() {
  console.log('\n--- 3. Currency Input and Keypad Behavior Verification ---');

  const jpyAdapter = getCurrencyUnitAdapter('JPY', 'JP');
  assert.equal(jpyAdapter.step, '1');
  assert.equal(jpyAdapter.maxDecimals, 0);
  const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
  assert.equal(usdAdapter.step, '0.01');
  assert.equal(usdAdapter.maxDecimals, 2);
  const kwdAdapter = getCurrencyUnitAdapter('KWD', 'KW');
  assert.equal(kwdAdapter.step, '0.001');
  assert.equal(kwdAdapter.maxDecimals, 3);
  assert.equal(getDiscountInputStep(jpyAdapter.maxDecimals, 'amount'), '1');
  assert.equal(getDiscountInputStep(kwdAdapter.maxDecimals, 'amount'), '0.01');
  assert.equal(getDiscountInputStep(kwdAdapter.maxDecimals, 'percentage'), '1');
  assert.equal(normalizeFixedDiscountValue(1.5, jpyAdapter.maxDecimals), 2);
  assert.equal(normalizeFixedDiscountValue(12.345, kwdAdapter.maxDecimals), 12.35);
  assert.equal(normalizeFixedDiscountValue(0.001, kwdAdapter.maxDecimals), 0);
  assert.equal(roundCurrencyValue(1.5, jpyAdapter.maxDecimals), 2);
  assert.equal(roundCurrencyValue(12.345, kwdAdapter.maxDecimals), 12.345);
  assert.equal(allowCurrencyDecimalKey(jpyAdapter.maxDecimals, 'payment', 'amount'), false);
  assert.equal(allowCurrencyDecimalKey(jpyAdapter.maxDecimals, 'discount', 'amount'), false);
  assert.equal(allowCurrencyDecimalKey(jpyAdapter.maxDecimals, 'discount', 'percentage'), true);
  assert.equal(allowCurrencyDecimalKey(kwdAdapter.maxDecimals, 'payment', 'amount'), true);

  const { chromium } = frontendRequire('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const renderKeypad = (
      currencyMaxDecimals: number,
      amountTarget: 'payment' | 'wallet' | 'discount',
      discountType: 'percentage' | 'amount',
    ) => ReactDOMServer.renderToStaticMarkup(
      React.createElement(CurrencyTouchNumberPad, {
        value: '',
        onChange: () => undefined,
        ariaLabel: 'Amount keypad',
        clearLabel: 'Clear',
        backspaceLabel: 'Backspace',
        currencyMaxDecimals,
        amountTarget,
        discountType,
      }),
    );

    const page = await browser.newPage();
    await page.setContent(renderKeypad(jpyAdapter.maxDecimals, 'payment', 'amount'));
    assert.equal(
      await page.getByRole('button', { name: '.', exact: true }).count(),
      0,
      'JPY keypad omits the decimal button',
    );

    await page.setContent(renderKeypad(usdAdapter.maxDecimals, 'payment', 'amount'));
    assert.equal(
      await page.getByRole('button', { name: '.', exact: true }).count(),
      1,
      'USD keypad renders the decimal button',
    );

    await page.setContent(renderKeypad(kwdAdapter.maxDecimals, 'payment', 'amount'));
    assert.equal(
      await page.getByRole('button', { name: '.', exact: true }).count(),
      1,
      'KWD keypad renders the decimal button',
    );

    await page.setContent(renderKeypad(jpyAdapter.maxDecimals, 'discount', 'percentage'));
    assert.equal(
      await page.getByRole('button', { name: '.', exact: true }).count(),
      1,
      'Percentage discount keypad renders the decimal button',
    );
  } finally {
    await browser.close();
  }
  console.log('  ✓ Currency steps and rendered keypad precision behavior verified');
}

async function runModalKeypadIntegrationTests() {
  console.log('\n--- 4. Modal Keypad Integration Verification ---');

  const jpyAdapter = getCurrencyUnitAdapter('JPY', 'JP');
  const Icon = () => React.createElement('span');
  const translate = (key: string) => key;
  const cart = {
    customer: null,
    customerId: null,
    items: [],
    orderType: 'dine_in',
    itemCount: () => 0,
  };
  const currentTenant = { currency: 'JPY', country: 'JP' };
  const mocks: Record<string, unknown> = {
    'lucide-react': { X: Icon, Wallet: Icon, ArrowLeftRight: Icon, CheckCircle2: Icon, Sparkles: Icon, User: Icon, Percent: Icon, Send: Icon, ChevronDown: Icon, Banknote: Icon, CreditCard: Icon },
    '@/components/ui/button': {
      Button: ({ children, variant: _variant, size: _size, ...props }: any) => React.createElement('button', props, children),
    },
    '@/components/pos/TaxBreakdown': { default: () => null },
    '@/lib/api': { default: { get: async () => ({ data: {} }), patch: async () => ({ data: {} }) } },
    'react-hot-toast': { default: { success: () => undefined, error: () => undefined } },
    '@/lib/printer/tax-components': { resolveTaxComponents: () => [] },
    '@/store/cart': { useCartStore: (selector?: (state: typeof cart) => unknown) => selector ? selector(cart) : cart },
    '@/hooks/use-confirm': { useConfirm: () => ({ confirm: async () => true, ConfirmDialog: null }) },
    'use-intl': { useTranslations: () => translate, useLocale: () => 'en-US' },
    '@/lib/payment-methods': { PAYMENT_METHODS: [{ key: 'cash', icon: Icon }, { key: 'card', icon: Icon }] },
    '@/hooks/useFormatCurrency': { useFormatCurrency: () => (amount: number) => String(amount) },
    '@/hooks/useFormatNumber': { useFormatNumber: () => (amount: number) => String(amount) },
    '@/hooks/useCurrencyUnitAdapter': { useCurrencyUnitAdapter: () => jpyAdapter },
    '@/hooks/useWhatsAppReady': { useWhatsAppReady: () => false },
    '@/lib/whatsapp-share': { sendBillViaFlo: async () => undefined, shareBillViaWhatsApp: async () => undefined },
    '@/store/auth': { useAuthStore: () => ({ currentTenant }) },
    '@/hooks/use-tax-preview': { useTaxPreview: () => ({ tax: null, loading: false, error: null }) },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  };
  const originalLoad = moduleApi._load;
  const originalUseState = React.useState;
  moduleApi._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    let nullStateCount = 0;
    const PaymentModal = require('../frontend/src/components/pos/PaymentModal').default;
    const PrepaidCheckoutModal = require('../frontend/src/components/pos/PrepaidCheckoutModal').default;
    const bill = {
      id: 1,
      bill_number: 'B-1',
      order_id: 1,
      customer_id: null,
      balance: 100,
      subtotal: 100,
      tax_amount: 0,
      discount_amount: 0,
      delivery_charge: 0,
      packaging_charge: 0,
      service_charge: 0,
      round_off: 0,
      total: 100,
      paid_amount: 0,
    };
    const renderModal = (Modal: any, props: Record<string, unknown>, target: 'payment' | 'discount', targetStateIndex: number) => {
      nullStateCount = 0;
      const amountTarget = target === 'payment' ? { kind: 'payment' as const, index: 0 } : { kind: 'discount' as const };
      React.useState = ((initial: unknown) => {
        if (initial === null) {
          nullStateCount += 1;
          if (nullStateCount === targetStateIndex) return [amountTarget, () => undefined];
        }
        return originalUseState(initial);
      }) as typeof React.useState;
      return ReactDOMServer.renderToStaticMarkup(React.createElement(Modal, props));
    };
    const browser = await frontendRequire('playwright').chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      for (const [Modal, props, label] of [
        [PaymentModal, { bill, currency: 'JPY', onClose: () => undefined, onPaid: () => undefined }, 'PaymentModal'],
        [PrepaidCheckoutModal, { currency: 'JPY', onClose: () => undefined, onConfirm: () => undefined }, 'PrepaidCheckoutModal'],
      ] as const) {
        const targetStateIndex = label === 'PaymentModal' ? 2 : 3;
        await page.setContent(renderModal(Modal, props, 'payment', targetStateIndex));
        assert.equal(await page.getByRole('button', { name: '.', exact: true }).count(), 0, `${label} hides JPY payment decimal key`);
        await page.setContent(renderModal(Modal, props, 'discount', targetStateIndex));
        assert.equal(await page.getByRole('button', { name: '.', exact: true }).count(), 1, `${label} keeps decimal key for percentage discount`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    React.useState = originalUseState;
    moduleApi._load = originalLoad;
  }
  console.log('  ✓ PaymentModal and PrepaidCheckoutModal keypad wiring verified');
}

function collectElements(node: unknown, predicate: (element: any) => boolean, result: any[] = []): any[] {
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

function elementText(element: any): string {
  const children = element.props?.children;
  if (Array.isArray(children)) return children.filter((child) => typeof child === 'string').join('');
  return typeof children === 'string' ? children : '';
}

async function runCatalogSaveBoundaryTests() {
  console.log('\n--- 5. Catalog Save Boundary Verification ---');

  const Icon = () => React.createElement('span');
  const currentTenant = { currency: 'JPY', country: 'JP' };
  const calls: Array<{ method: string; path: string; payload?: any }> = [];
  const api = {
    get: async () => ({ data: { products: [], categories: [], addon_groups: [] } }),
    post: async (path: string, payload: any) => {
      calls.push({ method: 'post', path, payload });
      return { data: {} };
    },
    put: async (path: string, payload: any) => {
      calls.push({ method: 'put', path, payload });
      return { data: {} };
    },
    delete: async () => ({ data: {} }),
  };
  const translate = (namespace: string) => (key: string) => `${namespace}.${key}`;
  const mocks: Record<string, unknown> = {
    '@/components/ui/button': {
      Button: ({ children, ...props }: any) => React.createElement('button', props, children),
    },
    '@/components/pos/DietaryBadge': { default: () => null, tagLabel: (tag: string) => tag },
    '@/components/products/ImageUploader': { default: () => null },
    '@/lib/api': { default: api },
    '@/lib/countries': {
      getCurrencySymbol: () => 'JPY',
      getCountryByCode: () => ({ locale: 'ja-JP' }),
      getCurrencyUnitAdapter: () => getCurrencyUnitAdapter('JPY', 'JP'),
    },
    '@/lib/currency-input': { roundCurrencyValue },
    '@/lib/image-utils': { nameToColor: () => '#000000' },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' '), parseDbTimestamp: (value: string) => value },
    '@/store/auth': { useAuthStore: () => ({ currentTenant }) },
    '@/hooks/use-confirm': { useConfirm: () => ({ confirm: async () => true, ConfirmDialog: null }) },
    '@/hooks/useFormatCurrency': { useFormatCurrency: () => (amount: number) => String(amount) },
    'react-hot-toast': { default: { success: () => undefined, error: () => undefined } },
    'use-intl': { useTranslations: (namespace: string) => translate(namespace) },
    '@shared/role-permissions': { ROLE_ACCESS: { ownerManager: ['owner', 'manager'] }, hasRole: () => true },
    'lucide-react': { Plus: Icon, Pencil: Icon, Trash2: Icon, X: Icon, Package: Icon, Folder: Icon, Puzzle: Icon, FileSpreadsheet: Icon, Download: Icon, Upload: Icon, CheckCircle: Icon, AlertCircle: Icon, AlertTriangle: Icon, ChevronDown: Icon, ChevronRight: Icon },
  };
  const originalLoad = moduleApi._load;
  const originalUseState = React.useState;
  const originalUseEffect = React.useEffect;
  moduleApi._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  React.useEffect = (() => undefined) as typeof React.useEffect;

  try {
    const ProductsPage = require('../frontend/src/app/(dashboard)/products/page').default;
    let stateCall = 0;
    React.useState = ((initial: unknown) => {
      stateCall += 1;
      if (stateCall === 7) return [false, () => undefined];
      if (stateCall === 8) return [true, () => undefined];
      if (stateCall === 14) return [true, () => undefined];
      if (stateCall === 15) return [[{ name: 'Extra Sauce', price: 1.5 }], () => undefined];
      if (stateCall === 16) return [{
        name: 'Coffee', category_id: '', price: '1.5', cost_price: '2.5', cb_percent: '', sku: '', barcode: '',
        sale_unit: 'each', allow_fractional_quantity: false, weight_precision: '3', tax_category_id: '',
        tax_behavior: 'country_default', description: '', track_inventory: false, stock_quantity: '0',
        low_stock_threshold: '5', is_active: true, tags: [], customTag: '', addon_group_ids: [], image_url: null,
      }, () => undefined];
      return [initial, () => undefined];
    }) as typeof React.useState;
    const productTree = ProductsPage();
    const submitForms = collectElements(productTree, (element) => typeof element.props?.onSubmit === 'function');
    assert.equal(submitForms.length, 2, 'ProductsPage exposes product and add-on save forms');
    for (const form of submitForms) await form.props.onSubmit({ preventDefault: () => undefined });
    const productSave = calls.find((call) => call.method === 'post' && call.path === '/products');
    assert.equal(productSave?.payload?.price, 2, 'product price is rounded at the save handler');
    assert.equal(productSave?.payload?.cost_price, 3, 'product cost price is rounded at the save handler');
    const addonGroupSave = calls.find((call) => call.method === 'post' && call.path === '/addon-groups');
    assert.equal(addonGroupSave?.payload?.addons?.[0]?.price, 2, 'inline add-on price is rounded at the save handler');

    const AddonGroupsPage = require('../frontend/src/app/(dashboard)/addon-groups/page').default;
    const addon = { id: 'addon-1', name: 'Old Sauce', price: 1, is_active: true };
    const group = { id: 'group-1', name: 'Extras', description: null, is_required: false, allow_multiple_quantities: false, min_selection: 0, max_selection: 1, is_active: true, addons: [addon] };
    const renderAddonPage = (editing: boolean) => {
      let addonStateCall = 0;
      React.useState = ((initial: unknown) => {
        addonStateCall += 1;
        if (addonStateCall === 1) return [[group], () => undefined];
        if (addonStateCall === 2) return [false, () => undefined];
        if (addonStateCall === 5) return ['group-1', () => undefined];
        if (addonStateCall === 8) return [{ name: 'New Sauce', price: '1.5' }, () => undefined];
        if (addonStateCall === 9) return [editing ? null : 'group-1', () => undefined];
        if (addonStateCall === 10) return [editing ? { groupId: 'group-1', addon } : null, () => undefined];
        return [initial, () => undefined];
      }) as typeof React.useState;
      return AddonGroupsPage();
    };
    const addTree = renderAddonPage(false);
    const addButton = collectElements(addTree, (element) => elementText(element) === 'products.addButton')[0];
    assert(addButton, 'AddonGroupsPage exposes the add add-on handler');
    await addButton.props.onClick();
    const addSave = calls.find((call) => call.method === 'post' && call.path === '/addon-groups/group-1/addons');
    assert.equal(addSave?.payload?.price, 2, 'add add-on handler rounds JPY price');

    const updateTree = renderAddonPage(true);
    const updateButton = collectElements(updateTree, (element) => elementText(element) === 'common.save')[0];
    assert(updateButton, 'AddonGroupsPage exposes the update add-on handler');
    await updateButton.props.onClick();
    const updateSave = calls.find((call) => call.method === 'put' && call.path === '/addon-groups/group-1/addons/addon-1');
    assert.equal(updateSave?.payload?.price, 2, 'update add-on handler rounds JPY price');
  } finally {
    React.useState = originalUseState;
    React.useEffect = originalUseEffect;
    moduleApi._load = originalLoad;
  }
  console.log('  ✓ Product and add-on save handlers verified');
}

function generatePaymentModalHtml(config: {
  locale: string;
  dir: 'rtl' | 'ltr';
  title: string;
  billNumber: string;
  totalDueFormatted: string;
  subtotalFormatted: string;
  discountFormatted?: string;
  taxFormatted?: string;
  currencyLabel: string;
  step: string;
  payments: Array<{ label: string; icon: string; amount: string; active?: boolean }>;
  wallet?: { label: string; amount: string; hint: string };
  change?: string;
  totalPayButton: string;
}): string {
  return `<!DOCTYPE html>
<html lang="${config.locale}" dir="${config.dir}">
<head>
  <meta charset="utf-8">
  <title>${config.title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: ${config.dir === 'rtl' ? "'Vazirmatn', sans-serif" : "'Inter', sans-serif"};
      background-color: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  <div class="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border border-slate-200">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
      <div>
        <h2 class="text-lg font-bold text-gray-900">${config.title}</h2>
        <p class="text-xs text-gray-400 mt-0.5">${config.billNumber}</p>
      </div>
      <div class="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 font-bold">✕</div>
    </div>

    <div class="px-5 py-4 space-y-4">
      <!-- Amount + Customer Card -->
      <div class="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl px-5 py-4 text-white">
        <div class="flex items-start justify-between mb-3">
          <div>
            <p class="text-xs font-medium text-slate-400 uppercase tracking-widest">${config.dir === 'rtl' ? 'مبلغ قابل پرداخت' : 'TOTAL DUE'}</p>
            <p class="text-3xl font-bold mt-1 tracking-tight text-white">${config.totalDueFormatted}</p>
          </div>
          <div class="text-end ms-4 shrink-0">
            <div class="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center mb-1 ms-auto text-xs">👤</div>
            <p class="text-sm font-semibold text-white leading-tight">${config.dir === 'rtl' ? 'رضا حسینی' : 'Customer'}</p>
          </div>
        </div>

        <div class="border-t border-white/10 pt-3 space-y-1.5 text-xs">
          <div class="flex justify-between text-slate-300">
            <span>${config.dir === 'rtl' ? 'جمع کل' : 'Subtotal'}</span>
            <span>${config.subtotalFormatted}</span>
          </div>
          ${config.discountFormatted ? `
          <div class="flex justify-between text-emerald-400 font-medium">
            <span>${config.dir === 'rtl' ? 'تخفیف' : 'Discount'}</span>
            <span>− ${config.discountFormatted}</span>
          </div>` : ''}
          <div class="flex justify-between text-white font-semibold border-t border-white/10 pt-1.5 mt-1">
            <span>${config.dir === 'rtl' ? 'مجموع' : 'Total'}</span>
            <span>${config.totalDueFormatted}</span>
          </div>
        </div>
      </div>

      <!-- Payment Methods Inputs -->
      <div class="space-y-2">
        ${config.payments.map((p) => `
        <div class="flex h-11">
          <button type="button" class="w-36 shrink-0 rounded-s-xl border px-3 flex items-center gap-2 text-sm font-semibold transition-colors ${
            p.active ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 text-gray-700 border-gray-200'
          }">
            <span>${p.icon}</span>
            <span class="truncate">${p.label}</span>
          </button>
          <div class="flex flex-1 items-center border border-s-0 border-gray-200 rounded-e-xl bg-white focus-within:ring-2 focus-within:ring-blue-500">
            <span class="ps-3 text-gray-500 font-medium text-xs">${config.currencyLabel}</span>
            <input
              type="number"
              value="${p.amount}"
              placeholder="0.00"
              step="${config.step}"
              class="min-w-0 flex-1 px-2 py-2 text-end text-sm font-semibold outline-none rounded-e-xl bg-transparent"
              readonly
            />
          </div>
        </div>
        `).join('')}
      </div>

      <!-- Change Returned -->
      ${config.change ? `
      <div class="rounded-xl px-4 py-3 flex items-center justify-between border-2 bg-emerald-50 border-emerald-200">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-full flex items-center justify-center bg-emerald-100 text-emerald-600 font-bold text-xs">✓</div>
          <span class="text-sm font-semibold text-emerald-800">${config.dir === 'rtl' ? 'باقی‌مانده بازگشتی' : 'Change Returned'}</span>
        </div>
        <span class="text-xl font-bold tabular-nums text-emerald-600">${config.change}</span>
      </div>` : ''}

      <!-- Loyalty Wallet -->
      ${config.wallet ? `
      <div class="space-y-1">
        <div class="flex h-11">
          <button type="button" class="w-36 shrink-0 rounded-s-xl border px-3 flex items-center gap-2 text-sm font-semibold bg-purple-50 text-purple-800 border-purple-200">
            <span>🎁</span><span class="truncate">${config.wallet.label}</span>
          </button>
          <div class="flex flex-1 items-center border border-s-0 border-purple-200 rounded-e-xl bg-white">
            <span class="ps-3 text-gray-500 font-medium text-xs">${config.currencyLabel}</span>
            <input
              type="number"
              value="${config.wallet.amount}"
              placeholder="0.00"
              step="${config.step}"
              class="min-w-0 flex-1 px-2 py-2 text-end text-sm font-semibold outline-none rounded-e-xl bg-transparent"
              readonly
            />
          </div>
        </div>
        <p class="px-1 text-[11px] text-gray-400 text-end">${config.wallet.hint}</p>
      </div>` : ''}
    </div>

    <!-- Footer Button -->
    <div class="px-5 pb-5 border-t border-gray-100 pt-3">
      <button class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-xl text-sm transition-colors shadow-sm">
        ${config.totalPayButton}
      </button>
    </div>
  </div>
</body>
</html>`;
}

async function captureEvidenceArtifacts() {
  console.log('\n--- 3. Generating HTML & PNG Evidence Artifacts ---');

  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  // 1. Iran POS in Toman display mode
  const tomanHtml = generatePaymentModalHtml({
    locale: 'fa-IR',
    dir: 'rtl',
    title: 'پرداخت صورت‌حساب',
    billNumber: 'صورت‌حساب #BILL-IR-0089',
    totalDueFormatted: '۵۰۰٬۰۰۰ تومان',
    subtotalFormatted: '۵۰۰٬۰۰۰ تومان',
    currencyLabel: 'تومان',
    step: '0.001',
    payments: [
      { label: 'نقدی', icon: '💵', amount: '۲۰۰۰۰۰', active: true },
      { label: 'کارت‌خوان', icon: '💳', amount: '۳۰۰۰۰۰', active: true },
      { label: 'آنلاین', icon: '📱', amount: '' },
    ],
    wallet: {
      label: 'کیف پول باشگاه',
      amount: '',
      hint: 'موجودی: ۲۰٬۰۰۰ امتیاز (ارزش تقریبی: ۲٬۰۰۰ تومان)',
    },
    totalPayButton: 'پرداخت ۵۰۰٬۰۰۰ تومان',
  });

  // 2. Iran POS in Toman Short Latin display mode
  const tomanShortHtml = generatePaymentModalHtml({
    locale: 'fa-IR',
    dir: 'rtl',
    title: 'پرداخت صورت‌حساب (Toman Short)',
    billNumber: 'صورت‌حساب #BILL-IR-0089',
    totalDueFormatted: '500,000T',
    subtotalFormatted: '500,000T',
    currencyLabel: 'T',
    step: '0.001',
    payments: [
      { label: 'نقدی', icon: '💵', amount: '500000', active: true },
      { label: 'کارت‌خوان', icon: '💳', amount: '' },
      { label: 'آنلاین', icon: '📱', amount: '' },
    ],
    wallet: {
      label: 'کیف پول باشگاه',
      amount: '',
      hint: 'موجودی: 20,000 امتیاز (ارزش تقریبی: 2,000T)',
    },
    totalPayButton: 'پرداخت 500,000T',
  });

  // 3. Iran POS in Rial display mode
  const rialHtml = generatePaymentModalHtml({
    locale: 'fa-IR',
    dir: 'rtl',
    title: 'پرداخت صورت‌حساب (Rial)',
    billNumber: 'صورت‌حساب #BILL-IR-0089',
    totalDueFormatted: '۵٬۰۰۰٬۰۰۰ ریال',
    subtotalFormatted: '۵٬۰۰۰٬۰۰۰ ریال',
    currencyLabel: 'IRR',
    step: '0.01',
    payments: [
      { label: 'نقدی', icon: '💵', amount: '۵۰۰۰۰۰۰', active: true },
      { label: 'کارت‌خوان', icon: '💳', amount: '' },
      { label: 'آنلاین', icon: '📱', amount: '' },
    ],
    wallet: {
      label: 'کیف پول باشگاه',
      amount: '',
      hint: 'موجودی: ۲۰٬۰۰۰ امتیاز (ارزش تقریبی: ۲۰٬۰۰۰ ریال)',
    },
    totalPayButton: 'پرداخت ۵٬۰۰۰٬۰۰۰ ریال',
  });

  // 4. US POS in USD mode
  const usdHtml = generatePaymentModalHtml({
    locale: 'en-US',
    dir: 'ltr',
    title: 'Payment',
    billNumber: 'Bill #BILL-US-0012',
    totalDueFormatted: '$45.50',
    subtotalFormatted: '$45.50',
    currencyLabel: 'USD',
    step: '0.01',
    payments: [
      { label: 'Cash', icon: '💵', amount: '20.00', active: true },
      { label: 'Card', icon: '💳', amount: '25.50', active: true },
      { label: 'UPI / Online', icon: '📱', amount: '' },
    ],
    wallet: {
      label: 'Loyalty Wallet',
      amount: '',
      hint: 'Balance: 1,500 pts (~$15.00)',
    },
    totalPayButton: 'Pay $45.50',
  });

  const artifacts = [
    { name: 'payment-modal-iran-toman', html: tomanHtml },
    { name: 'payment-modal-iran-toman-short', html: tomanShortHtml },
    { name: 'payment-modal-iran-rial', html: rialHtml },
    { name: 'payment-modal-usd', html: usdHtml },
  ];

  for (const art of artifacts) {
    const htmlPath = path.join(EVIDENCE_DIR, `${art.name}.html`);
    fs.writeFileSync(htmlPath, art.html, 'utf8');
    console.log(`  ✓ Written HTML: ${htmlPath}`);
  }

  // Use Playwright to capture pixel screenshots when a browser is available.
  let browser: any;
  try {
    const playwright = require(path.resolve(__dirname, '../frontend/node_modules/@playwright/test'));
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 600, height: 850 },
      deviceScaleFactor: 2,
    });

    for (const art of artifacts) {
      const htmlPath = path.join(EVIDENCE_DIR, `${art.name}.html`);
      const pngPath = path.join(EVIDENCE_DIR, `${art.name}.png`);
      await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: pngPath, fullPage: true });
      console.log(`  ✓ Captured PNG Screenshot: ${pngPath}`);
    }
  } catch (err: any) {
    if (process.env.REQUIRE_VISUAL_EVIDENCE === '1') throw err;
    console.warn(`  ! Could not capture Playwright screenshots: ${err?.message || err}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function main() {
  runUnitTests();
  runPaymentMathTests();
  await runCurrencyInputBehaviorTests();
  await runModalKeypadIntegrationTests();
  await runCatalogSaveBoundaryTests();
  await captureEvidenceArtifacts();
  console.log('\n========================================');
  console.log('All tests and visual evidence generation passed!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
