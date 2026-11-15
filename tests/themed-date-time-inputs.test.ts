/**
 * Verification suite for dark/light themed temporal inputs across the POS and
 * management UI (#1576).
 *
 * Covers:
 *  1. Shared DatePickerInput component rendering, color-scheme / indicator hiding
 *     classes, forwarded attributes, CalendarDays vs Clock icon selection, and
 *     openTemporalPicker showPicker() + focus() fallback behavior.
 *  2. Parsed CSS AST check on globals.css @layer base ensuring color-scheme
 *     applies to date, datetime-local, month, week, and time inputs in both light
 *     and .dark modes.
 *  3. Repo-wide frontend/src audit verifying all temporal inputs use DatePickerInput
 *     and no raw un-themed date/datetime-local/month/week/time inputs remain.
 *  4. Rendered component markup checks for OrderDetailsDrawer, ScheduledOrdersDrawer,
 *     CashDrawerMovementModal, CashCloseModal, and ExpenseWorkflow preserving exact
 *     ids, data-testids, and error/class hooks.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const FRONTEND_SRC = resolve(ROOT, 'frontend/src');
const read = (relPath: string) => readFileSync(resolve(ROOT, relPath), 'utf8');

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walkSourceFiles(fullPath));
    } else if (/\.(tsx|ts|jsx|js)$/.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

// 1. globals.css parsed CSS AST check
const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
  _load: (request: string, parent: any, isMain: boolean) => any;
};
const frontendRequire = Module.createRequire(resolve(ROOT, 'frontend/package.json'));
const postcss = frontendRequire('postcss');
const cssAst = postcss.parse(read('frontend/src/app/globals.css'));

const expectedTemporalTypes = ['date', 'datetime-local', 'month', 'week', 'time'] as const;
const lightColorSchemeMatched = new Set<string>();
const darkColorSchemeMatched = new Set<string>();

cssAst.walkRules((rule: any) => {
  const selectors: string[] = rule.selectors ?? [];
  let colorSchemeValue: string | null = null;
  rule.walkDecls((decl: any) => {
    if (decl.prop === 'color-scheme') {
      colorSchemeValue = String(decl.value).trim();
    }
  });
  if (!colorSchemeValue) return;

  for (const type of expectedTemporalTypes) {
    const lightPattern = new RegExp(`^input\\[type=["']?${type}["']?\\]$`);
    const darkPattern = new RegExp(`^\\.dark\\s+input\\[type=["']?${type}["']?\\]$`);
    for (const selector of selectors) {
      const normalized = selector.trim();
      if (colorSchemeValue === 'light' && lightPattern.test(normalized)) {
        lightColorSchemeMatched.add(type);
      }
      if (colorSchemeValue === 'dark' && darkPattern.test(normalized)) {
        darkColorSchemeMatched.add(type);
      }
    }
  }
});

for (const type of expectedTemporalTypes) {
  assert.ok(
    lightColorSchemeMatched.has(type),
    `globals.css sets color-scheme: light on input[type="${type}"]`,
  );
  assert.ok(
    darkColorSchemeMatched.has(type),
    `globals.css sets color-scheme: dark on .dark input[type="${type}"]`,
  );
}

// 2. Exhaustive frontend/src audit for un-themed raw temporal inputs
const datePickerPath = resolve(FRONTEND_SRC, 'components/ui/date-picker-input.tsx');
assert.ok(existsSync(datePickerPath), 'frontend/src/components/ui/date-picker-input.tsx exists');

const rawTemporalTagPattern =
  /<(input|Input)\b[^>]*\btype=["'](?:date|datetime-local|month|week|time)["'][^>]*>/gs;
const offendingFiles: string[] = [];
for (const filePath of walkSourceFiles(FRONTEND_SRC)) {
  if (resolve(filePath) === datePickerPath) continue;
  const content = readFileSync(filePath, 'utf8');
  if (rawTemporalTagPattern.test(content)) {
    offendingFiles.push(relative(ROOT, filePath));
  }
}
assert.deepEqual(
  offendingFiles,
  [],
  `No raw <input>/<Input> temporal fields should remain outside DatePickerInput; found: ${offendingFiles.join(', ')}`,
);

// Verify every expected call site imports and uses DatePickerInput
const expectedCallSites = [
  'frontend/src/app/(dashboard)/expenses/page.tsx',
  'frontend/src/components/expenses/ExpenseWorkflow.tsx',
  'frontend/src/components/pos/OrderDetailsDrawer.tsx',
  'frontend/src/components/pos/ScheduledOrdersDrawer.tsx',
  'frontend/src/components/dashboard/CashDrawerMovementModal.tsx',
  'frontend/src/components/dashboard/CashCloseModal.tsx',
  'frontend/src/app/(dashboard)/whatsapp/page.tsx',
  'frontend/src/app/(dashboard)/dashboard/page.tsx',
];
for (const site of expectedCallSites) {
  const src = read(site);
  assert.match(src, /<DatePickerInput\b/, `${site} uses <DatePickerInput>`);
}

// 3. Runtime component and helper verification
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const reactPath = frontendRequire.resolve('react');
const reactJsxRuntimePath = frontendRequire.resolve('react/jsx-runtime');
const reactDomPath = frontendRequire.resolve('react-dom');
const reactDomServerPath = frontendRequire.resolve('react-dom/server');
const useIntlPath = frontendRequire.resolve('use-intl');
const zustandPath = frontendRequire.resolve('zustand');
const zustandMiddlewarePath = frontendRequire.resolve('zustand/middleware');
const lucideReactPath = frontendRequire.resolve('lucide-react');
const clsxPath = frontendRequire.resolve('clsx');
const tailwindMergePath = frontendRequire.resolve('tailwind-merge');

Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === 'react') resolvedRequest = reactPath;
  else if (request === 'react/jsx-runtime') resolvedRequest = reactJsxRuntimePath;
  else if (request === 'react-dom') resolvedRequest = reactDomPath;
  else if (request === 'react-dom/server') resolvedRequest = reactDomServerPath;
  else if (request === 'use-intl') resolvedRequest = useIntlPath;
  else if (request === 'zustand') resolvedRequest = zustandPath;
  else if (request === 'zustand/middleware') resolvedRequest = zustandMiddlewarePath;
  else if (request === 'lucide-react') resolvedRequest = lucideReactPath;
  else if (request === 'clsx') resolvedRequest = clsxPath;
  else if (request === 'tailwind-merge') resolvedRequest = tailwindMergePath;
  else if (request === '@countries') resolvedRequest = resolve(ROOT, 'main/countries.ts');
  else if (request.startsWith('@/')) resolvedRequest = resolve(FRONTEND_SRC, request.slice(2));
  else if (request.startsWith('@print/'))
    resolvedRequest = resolve(ROOT, 'shared/print', request.slice('@print/'.length));
  else if (request.startsWith('@shared/'))
    resolvedRequest = resolve(ROOT, 'shared', request.slice('@shared/'.length));
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
  const enMessages = require('../frontend/src/lib/i18n/messages/en.json');

  const renderWithIntl = (element: any) =>
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages, timeZone: 'UTC' },
        element,
      ),
    );

  const {
    DatePickerInput,
    openTemporalPicker,
  } = require('../frontend/src/components/ui/date-picker-input');

  // 3a. Render DatePickerInput across temporal types
  for (const type of ['date', 'datetime-local', 'month', 'week'] as const) {
    const html = renderWithIntl(
      React.createElement(DatePickerInput, {
        id: `test-${type}`,
        'data-testid': `test-${type}`,
        type,
        value: '',
        min: '2026-01-01',
        max: '2026-12-31',
        'aria-label': `Label ${type}`,
        pickerAriaLabel: `Open ${type}`,
        onChange: () => {},
      }),
    );
    assert.match(html, new RegExp(`id="test-${type}"`), `${type} preserves id`);
    assert.match(html, new RegExp(`data-testid="test-${type}"`), `${type} preserves data-testid`);
    assert.match(html, new RegExp(`type="${type}"`), `${type} preserves input type`);
    assert.match(html, /min="2026-01-01"/, `${type} preserves min`);
    assert.match(html, /max="2026-12-31"/, `${type} preserves max`);
    assert.match(html, new RegExp(`aria-label="Label ${type}"`), `${type} preserves aria-label`);
    assert.match(html, /\[color-scheme:light\]/, `${type} sets light color-scheme`);
    assert.match(html, /dark:\[color-scheme:dark\]/, `${type} sets dark color-scheme`);
    assert.match(
      html,
      /\[&amp;::-webkit-calendar-picker-indicator\]:opacity-0/,
      `${type} hides native calendar indicator`,
    );
    assert.match(
      html,
      /\[&amp;::-webkit-calendar-picker-indicator\]:pointer-events-none/,
      `${type} disables native calendar indicator pointer events`,
    );
    assert.match(
      html,
      new RegExp(
        `<button[^>]*type="button"[^>]*aria-label="Open ${type}"[^>]*>.*lucide-calendar-days`,
      ),
      `${type} renders CalendarDays trigger button`,
    );
  }

  const timeHtml = renderWithIntl(
    React.createElement(DatePickerInput, {
      id: 'test-time',
      'data-testid': 'test-time',
      type: 'time',
      value: '22:00',
      disabled: true,
      pickerAriaLabel: 'Open time',
      onChange: () => {},
    }),
  );
  assert.match(timeHtml, /type="time"/, 'time preserves input type');
  assert.match(timeHtml, /value="22:00"/, 'time preserves value');
  assert.match(timeHtml, /disabled=""/, 'time forwards disabled to input');
  assert.match(
    timeHtml,
    /<button[^>]*type="button"[^>]*disabled=""[^>]*aria-label="Open time"[^>]*>.*lucide-clock/,
    'time renders Clock trigger button and disables it when input is disabled',
  );

  // 3b. openTemporalPicker showPicker() and focus() fallback tests
  let pickerCalls = 0;
  let focusCalls = 0;
  openTemporalPicker({
    disabled: false,
    readOnly: false,
    showPicker: () => {
      pickerCalls += 1;
    },
    focus: () => {
      focusCalls += 1;
    },
  } as any);
  assert.equal(pickerCalls, 1, 'openTemporalPicker calls showPicker() when available');
  assert.equal(focusCalls, 0, 'openTemporalPicker does not need focus() when showPicker succeeds');

  let throwingFocusCalls = 0;
  openTemporalPicker({
    disabled: false,
    readOnly: false,
    showPicker: () => {
      throw new Error('Not supported');
    },
    focus: () => {
      throwingFocusCalls += 1;
    },
  } as any);
  assert.equal(
    throwingFocusCalls,
    1,
    'openTemporalPicker falls back to focus() when showPicker throws',
  );

  let missingShowPickerFocusCalls = 0;
  openTemporalPicker({
    disabled: false,
    readOnly: false,
    focus: () => {
      missingShowPickerFocusCalls += 1;
    },
  } as any);
  assert.equal(
    missingShowPickerFocusCalls,
    1,
    'openTemporalPicker falls back to focus() when showPicker is absent',
  );

  let disabledCalls = 0;
  openTemporalPicker({
    disabled: true,
    readOnly: false,
    showPicker: () => {
      disabledCalls += 1;
    },
    focus: () => {
      disabledCalls += 1;
    },
  } as any);
  assert.equal(disabledCalls, 0, 'openTemporalPicker no-ops when input is disabled');
  openTemporalPicker(null);

  // 3c. Verify OrderDetailsDrawer renders themed datetime-local input with exact id/testid and error border
  const { useCartStore } = require('@/store/cart');
  useCartStore.getState().setOrderType('delivery');
  Object.assign(useCartStore.getInitialState(), useCartStore.getState());
  const { OrderDetailsDrawer } = require('../frontend/src/components/pos/OrderDetailsDrawer');
  const orderDetailsHtml = renderWithIntl(
    React.createElement(OrderDetailsDrawer, {
      open: true,
      onOpenChange: () => {},
      effectiveTimezone: 'UTC',
      scheduleErrorMessage: 'Invalid time',
      customPaymentMethods: [],
      scheduledOrdersEnabled: true,
    }),
  );
  assert.match(
    orderDetailsHtml,
    /<input[^>]*type="datetime-local"[^>]*id="pos-send-to-kitchen-drawer-input"[^>]*data-testid="pos-send-to-kitchen-input"/,
    'OrderDetailsDrawer preserves exact id, data-testid, and type on underlying <input>',
  );
  assert.match(
    orderDetailsHtml,
    /<input[^>]*class="[^"]*border-red-500[^"]*dark:\[color-scheme:dark\][^"]*"[^>]*id="pos-send-to-kitchen-drawer-input"/,
    'OrderDetailsDrawer preserves error border and applies dark color-scheme',
  );
  assert.match(
    orderDetailsHtml,
    /id="pos-send-to-kitchen-drawer-input"[^>]*\/>[\s]*<button[^>]*><svg[^>]*lucide-calendar-days/,
    'OrderDetailsDrawer renders themed CalendarDays button beside the input',
  );
  useCartStore.getState().clearCart();
  Object.assign(useCartStore.getInitialState(), useCartStore.getState());

  // 3d. Verify CashDrawerMovementModal & CashCloseModal render themed date inputs
  (globalThis as any).document = { body: { style: {} }, querySelector: () => null };
  const {
    CashDrawerMovementModal,
  } = require('../frontend/src/components/dashboard/CashDrawerMovementModal');
  const movementHtml = renderWithIntl(
    React.createElement(CashDrawerMovementModal, {
      model: {
        open: true,
        setOpen: () => {},
        businessDate: '2026-11-14',
        setBusinessDate: () => {},
        loadMovements: async () => {},
        todayLocal: '2026-11-14',
        movementType: 'pay_in',
        setMovementType: () => {},
        amount: '',
        setAmount: () => {},
        reason: '',
        setReason: () => {},
        submitting: false,
        loading: false,
        movements: [],
        voidingId: null,
        setVoidingId: () => {},
        voidReason: '',
        setVoidReason: () => {},
        voiding: false,
        recordMovement: async () => {},
        voidMovement: async () => {},
        fmt: (v: number) => String(v),
        minorFactor: 100,
        unitAdapter: {
          toDisplay: (v: number) => String(v),
          toMinor: (v: string) => Number(v),
          step: '0.01',
          min: '0',
          placeholder: '0.00',
        },
        t: (k: string) => k,
        tCommon: (k: string) => k,
      },
    }),
  );
  assert.match(
    movementHtml,
    /<input[^>]*type="date"[^>]*dark:\[color-scheme:dark\][^"]*"[^>]*id="movement-business-date"/,
    'CashDrawerMovementModal applies dark color-scheme to #movement-business-date',
  );
  assert.match(
    movementHtml,
    /id="movement-business-date"[^>]*\/>[\s]*<button[^>]*><svg[^>]*lucide-calendar-days/,
    'CashDrawerMovementModal renders CalendarDays trigger button',
  );

  const { CashCloseModal } = require('../frontend/src/components/dashboard/CashCloseModal');
  const cashCloseHtml = renderWithIntl(
    React.createElement(CashCloseModal, {
      model: {
        closeOpen: true,
        setCloseOpen: () => {},
        closeAnotherDay: false,
        businessDate: '2026-11-14',
        setBusinessDate: () => {},
        selectedSessionId: null,
        setSelectedSessionId: () => {},
        xReport: null,
        xLoading: false,
        xError: null,
        closeStep: 1,
        setCloseStep: () => {},
        openingFloatInput: '',
        setOpeningFloatInput: () => {},
        countedInput: '',
        setCountedInput: () => {},
        submittingClose: false,
        submitError: null,
        alreadyClosedOverride: false,
        setAlreadyClosedOverride: () => {},
        amountsValid: true,
        expectedCashTotalCents: 0,
        varianceCents: 0,
        closedZ: null,
        printingZ: false,
        exportingReport: false,
        exportReport: async () => {},
        hasPrintedFresh: false,
        setHasPrintedFresh: () => {},
        hydratedZ: null,
        minorFactor: 100,
        fmt: (v: number) => String(v),
        unitAdapter: {
          toDisplay: (v: number) => String(v),
          toMinor: (v: string) => Number(v),
          step: '0.01',
          min: '0',
          placeholder: '0.00',
        },
        t: (k: string) => k,
        tCommon: (k: string) => k,
        shiftDate: (d: string) => d,
        todayLocal: '2026-11-14',
        submitClose: async () => {},
        printZ: async () => {},
        canSendWhatsApp: false,
        canViewSettings: false,
        openWhatsAppReport: () => {},
        whatsAppOpen: false,
        setWhatsAppOpen: () => {},
        sendWhatsAppReport: async () => {},
        whatsappCountry: 'US',
      },
    }),
  );
  assert.match(
    cashCloseHtml,
    /<input[^>]*type="date"[^>]*dark:\[color-scheme:dark\][^"]*"[^>]*id="business-date"/,
    'CashCloseModal applies dark color-scheme to #business-date',
  );
  assert.match(
    cashCloseHtml,
    /id="business-date"[^>]*\/>[\s]*<button[^>]*><svg[^>]*lucide-calendar-days/,
    'CashCloseModal renders CalendarDays trigger button',
  );

  // 3e. Verify ExpenseWorkflow renders themed #expense-incurred-on with bg-card text-foreground
  const ExpenseWorkflow = require('../frontend/src/components/expenses/ExpenseWorkflow').default;
  const expenseFormHtml = renderWithIntl(
    React.createElement(ExpenseWorkflow, {
      mode: 'create',
      expense: null,
      categories: [{ id: 'cat-1', name: 'Supplies', is_active: 1 }],
      context: { business_date: '2026-11-14', currency: 'USD', open_cash_session: null },
      onClose: () => {},
      onChanged: () => {},
      onCategoryCreated: () => {},
      onSaved: () => {},
    }),
  );
  assert.match(
    expenseFormHtml,
    /<input[^>]*type="date"[^>]*bg-card[^"]*text-foreground[^"]*dark:\[color-scheme:dark\][^"]*"[^>]*id="expense-incurred-on"[^>]*data-testid="expense-form-incurred-on"/,
    'ExpenseWorkflow applies bg-card text-foreground and dark color-scheme to #expense-incurred-on',
  );
  assert.match(
    expenseFormHtml,
    /data-testid="expense-form-incurred-on"[^>]*\/>[\s]*<button[^>]*><svg[^>]*lucide-calendar-days/,
    'ExpenseWorkflow renders CalendarDays trigger button',
  );

  console.log('✓ Themed date/time input checks passed');
} finally {
  if (origDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = origDocument;
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
}
