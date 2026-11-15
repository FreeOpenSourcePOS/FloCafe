/**
 * Verification suite for dark/light themed temporal inputs across the POS and
 * management UI (#1576).
 *
 * Covers:
 *  1. Parsed CSS AST check on globals.css @layer base ensuring color-scheme
 *     applies to date, datetime-local, month, week, and time inputs in both light
 *     and .dark modes.
 *  2. Shared DatePickerInput component rendering, color-scheme / indicator hiding
 *     classes, forwarded attributes, CalendarDays vs Clock icon selection, and
 *     openTemporalPicker showPicker() + focus() fallback behavior.
 *  3. Rendered component markup checks across all 8 temporal input call sites:
 *     OrderDetailsDrawer, ScheduledOrdersDrawer (reschedule mode),
 *     CashDrawerMovementModal, CashCloseModal, ExpenseWorkflow, ExpensesPage,
 *     DashboardPage (day, month, and range modes), and WhatsAppPage (automation tab).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const FRONTEND_SRC = resolve(ROOT, 'frontend/src');
const read = (relPath: string) => readFileSync(resolve(ROOT, relPath), 'utf8');

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

// 2. Runtime component and helper verification
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const reactPath = frontendRequire.resolve('react');
const reactJsxRuntimePath = frontendRequire.resolve('react/jsx-runtime');
const reactDomPath = frontendRequire.resolve('react-dom');
const reactDomClientPath = frontendRequire.resolve('react-dom/client');
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
  else if (request === 'react-dom/client') resolvedRequest = reactDomClientPath;
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

  // 3b-mounted. Verify React 19 callback-ref cleanup runs on ref prop change and unmount
  const { createRoot } = frontendRequire('react-dom/client');
  const createMinimalDom = () => {
    const noop = () => {};
    const makeNode = (
      nodeType: number,
      tagName = '',
      namespaceURI = 'http://www.w3.org/1999/xhtml',
    ) => {
      const node: any = {
        nodeType,
        tagName: tagName.toUpperCase(),
        nodeName: tagName.toUpperCase(),
        namespaceURI,
        parentNode: null,
        childNodes: [] as any[],
        attributes: new Map<string, string>(),
        style: {},
        disabled: false,
        readOnly: false,
        value: '',
        defaultValue: '',
        type: '',
        className: '',
        get firstChild() {
          return this.childNodes[0] ?? null;
        },
        get lastChild() {
          return this.childNodes[this.childNodes.length - 1] ?? null;
        },
        get nextSibling() {
          if (!this.parentNode) return null;
          const idx = this.parentNode.childNodes.indexOf(this);
          return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
        },
        get previousSibling() {
          if (!this.parentNode) return null;
          const idx = this.parentNode.childNodes.indexOf(this);
          return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null;
        },
        setAttribute(k: string, v: string) {
          this.attributes.set(k, String(v));
          if (k === 'disabled') this.disabled = true;
          if (k === 'readonly') this.readOnly = true;
          if (k === 'type') this.type = String(v);
        },
        removeAttribute(k: string) {
          this.attributes.delete(k);
          if (k === 'disabled') this.disabled = false;
          if (k === 'readonly') this.readOnly = false;
        },
        getAttribute(k: string) {
          return this.attributes.get(k) ?? null;
        },
        appendChild(child: any) {
          return this.insertBefore(child, null);
        },
        insertBefore(child: any, before: any) {
          if (child.parentNode) child.parentNode.removeChild(child);
          child.parentNode = this;
          const idx = before ? this.childNodes.indexOf(before) : -1;
          if (idx >= 0) this.childNodes.splice(idx, 0, child);
          else this.childNodes.push(child);
          return child;
        },
        removeChild(child: any) {
          const idx = this.childNodes.indexOf(child);
          if (idx >= 0) this.childNodes.splice(idx, 1);
          child.parentNode = null;
          return child;
        },
        addEventListener: noop,
        removeEventListener: noop,
        dispatchEvent: () => true,
        focus: noop,
      };
      return node;
    };

    const doc: any = {
      nodeType: 9,
      activeElement: null,
      HTMLIFrameElement: function HTMLIFrameElement() {},
      addEventListener: noop,
      removeEventListener: noop,
      createElement(tag: string) {
        const el = makeNode(1, tag);
        el.ownerDocument = doc;
        return el;
      },
      createElementNS(ns: string, tag: string) {
        const el = makeNode(1, tag, ns);
        el.ownerDocument = doc;
        return el;
      },
      createTextNode(text: string) {
        const tn = makeNode(3);
        tn.nodeValue = String(text);
        tn.data = String(text);
        tn.ownerDocument = doc;
        return tn;
      },
    };
    doc.defaultView = doc;
    doc.documentElement = doc.createElement('html');
    doc.body = doc.createElement('body');
    doc.documentElement.appendChild(doc.body);
    return { doc, container: doc.createElement('div') };
  };

  const { doc: mountedDoc, container } = createMinimalDom();
  const prevWindow = (globalThis as any).window;
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).document = mountedDoc;
  (globalThis as any).window = mountedDoc;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  try {
    const root = createRoot(container);
    const cb1Calls: Array<unknown> = [];
    const cb2Calls: Array<unknown> = [];
    let cb1CleanupCount = 0;
    let cb2CleanupCount = 0;

    const cb1 = (node: HTMLInputElement | null) => {
      cb1Calls.push(node);
      return () => {
        cb1CleanupCount += 1;
      };
    };
    const cb2 = (node: HTMLInputElement | null) => {
      cb2Calls.push(node);
      return () => {
        cb2CleanupCount += 1;
      };
    };

    React.act(() => {
      root.render(React.createElement(DatePickerInput, { ref: cb1, type: 'date' }));
    });
    assert.equal(cb1Calls.length, 1, 'initial mount attaches first callback ref');
    assert.ok(cb1Calls[0], 'initial callback ref receives mounted input element');
    assert.equal(cb1CleanupCount, 0, 'callback-ref cleanup does not run while still mounted');

    React.act(() => {
      root.render(React.createElement(DatePickerInput, { ref: cb2, type: 'date' }));
    });
    assert.equal(cb1CleanupCount, 1, 'changing ref prop invokes prior callback-ref cleanup once');
    assert.deepEqual(
      cb1Calls.length,
      1,
      'prior callback ref is not called with null when it returned a cleanup function',
    );
    assert.equal(cb2Calls.length, 1, 'new callback ref attaches to input element');
    assert.equal(cb2Calls[0], cb1Calls[0], 'new callback ref receives the same input element');
    assert.equal(cb2CleanupCount, 0, 'new callback-ref cleanup waits until next change or unmount');

    React.act(() => {
      root.unmount();
    });
    assert.equal(cb2CleanupCount, 1, 'unmount invokes active callback-ref cleanup once');
    assert.equal(
      cb2Calls.length,
      1,
      'callback ref returning cleanup is not called with null on unmount',
    );

    // Also verify object ref and void callback ref still attach and clear to null on unmount
    const objContainer = mountedDoc.createElement('div');
    const objRoot = createRoot(objContainer);
    const objRef = React.createRef() as React.RefObject<HTMLInputElement | null>;
    const voidCalls: Array<HTMLInputElement | null> = [];
    const voidCb = (node: HTMLInputElement | null) => {
      voidCalls.push(node);
    };
    React.act(() => {
      objRoot.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(DatePickerInput, { ref: objRef, type: 'date' }),
          React.createElement(DatePickerInput, { ref: voidCb, type: 'time' }),
        ),
      );
    });
    assert.ok(objRef.current, 'object ref attaches to mounted input element');
    assert.equal(voidCalls.length, 1, 'void callback ref attaches once on mount');
    assert.ok(voidCalls[0], 'void callback ref receives mounted input element');

    React.act(() => {
      objRoot.unmount();
    });
    assert.equal(objRef.current, null, 'object ref clears to null on unmount');
    assert.deepEqual(voidCalls.length, 2, 'void callback ref clears on unmount');
    assert.equal(voidCalls[1], null, 'void callback ref receives null on unmount');
  } finally {
    if (prevActEnv === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
    if (origDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = origDocument;
  }

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

  // Lightweight state harness for rendering stateful components across mode/tab transitions
  const findElement = (node: any, predicate: (el: any) => boolean): any => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findElement(child, predicate);
        if (hit) return hit;
      }
      return null;
    }
    if (predicate(node)) return node;
    return node.props?.children ? findElement(node.props.children, predicate) : null;
  };

  const createHarness = (Component: any, props: any = {}) => {
    const states: unknown[] = [];
    const refs: Array<{ current: unknown }> = [];
    const origUseState = React.useState;
    const origUseEffect = React.useEffect;
    const origUseRef = React.useRef;
    const origUseCallback = React.useCallback;
    const origUseMemo = React.useMemo;

    const render = () => {
      let tree: any;
      function Runner() {
        let stateIdx = 0;
        let refIdx = 0;
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
        React.useEffect = (() => {}) as typeof React.useEffect;
        React.useCallback = ((fn: any) => fn) as typeof React.useCallback;
        React.useMemo = ((fn: () => unknown) => fn()) as typeof React.useMemo;

        try {
          for (let pass = 0; pass < 4; pass++) {
            const snapshot = states.slice();
            stateIdx = 0;
            refIdx = 0;
            tree = Component(props);
            if (!states.some((val, i) => val !== snapshot[i])) break;
          }
        } finally {
          React.useState = origUseState;
          React.useEffect = origUseEffect;
          React.useRef = origUseRef;
          React.useCallback = origUseCallback;
          React.useMemo = origUseMemo;
        }
        return tree;
      }

      const html = renderWithIntl(React.createElement(Runner));
      return { tree, html };
    };

    return { render };
  };

  const { useAuthStore } = require('@/store/auth');
  const prevAuth = useAuthStore.getState();
  const prevAuthInitial = { ...useAuthStore.getInitialState() };
  const origWindow = (globalThis as any).window;
  try {
    useAuthStore.setState({
      user: { id: 'owner-1', name: 'Owner', email: 'owner@test.com', role: 'owner' } as any,
      currentTenant: {
        id: 't1',
        business_name: 'FloCafe',
        role: 'owner',
        currency: 'USD',
        country: 'US',
        timezone: 'UTC',
        business_day_start_time: '00:00',
        permission_ids: [
          'dashboard.view',
          'reports.financial.view',
          'orders.create',
          'orders.status.update',
          'whatsapp.manage',
        ],
      } as any,
    });
    Object.assign(useAuthStore.getInitialState(), useAuthStore.getState());

    // 3f. Verify ScheduledOrdersDrawer renders themed datetime-local input in reschedule mode
    const ScheduledOrdersDrawer =
      require('../frontend/src/components/pos/ScheduledOrdersDrawer').default;
    const scheduledHarness = createHarness(ScheduledOrdersDrawer, {
      open: true,
      orders: [
        {
          id: 101,
          order_number: 'ORD-101',
          type: 'takeaway',
          status: 'pending',
          release_status: 'scheduled',
          total: 12,
          scheduled_for: '2030-01-15T10:30:00.000Z',
          items: [
            {
              id: 1,
              order_id: 101,
              product_id: 'prod-1',
              product_name: 'Latte',
              quantity: 1,
              unit_price: 12,
              total: 12,
              status: 'pending',
            },
          ],
        },
      ],
      storeTimezone: 'UTC',
      onClose: () => {},
      onRefresh: () => {},
      onOrderReleased: () => {},
      onAddItemsToOrder: () => {},
      onPayOrder: () => {},
      onRefundOrder: () => {},
    });
    const scheduledInitial = scheduledHarness.render();
    const rescheduleBtn = findElement(
      scheduledInitial.tree,
      (el) => el?.props?.['data-testid'] === 'scheduled-reschedule-btn-101',
    );
    assert.ok(rescheduleBtn, 'ScheduledOrdersDrawer renders reschedule trigger button');
    rescheduleBtn.props.onClick();
    const scheduledReschedule = scheduledHarness.render();
    assert.match(
      scheduledReschedule.html,
      /<input[^>]*type="datetime-local"[^>]*dark:\[color-scheme:dark\][^"]*"[^>]*id="scheduled-reschedule-input-101"[^>]*data-testid="scheduled-reschedule-input-101"/,
      'ScheduledOrdersDrawer applies dark color-scheme to reschedule datetime-local input',
    );
    assert.match(
      scheduledReschedule.html,
      /data-testid="scheduled-reschedule-input-101"[^>]*\/>[\s]*<button[^>]*><svg[^>]*lucide-calendar-days/,
      'ScheduledOrdersDrawer renders CalendarDays trigger button in reschedule mode',
    );

    // 3g. Verify ExpensesPage renders themed #expense-filter-from and #expense-filter-to date inputs
    const ExpensesPage = require('../frontend/src/app/(dashboard)/expenses/page').default;
    const expensesHtml = renderWithIntl(React.createElement(ExpensesPage));
    for (const filterId of ['expense-filter-from', 'expense-filter-to']) {
      assert.match(
        expensesHtml,
        new RegExp(
          `<input[^>]*type="date"[^>]*dark:\\[color-scheme:dark\\][^"]*"[^>]*id="${filterId}"[^>]*data-testid="${filterId}"`,
        ),
        `ExpensesPage applies dark color-scheme to #${filterId}`,
      );
      assert.match(
        expensesHtml,
        new RegExp(
          `data-testid="${filterId}"[^>]*\\/>[\\s]*<button[^>]*><svg[^>]*lucide-calendar-days`,
        ),
        `ExpensesPage renders CalendarDays trigger button for #${filterId}`,
      );
    }

    // 3h. Verify DashboardPage renders themed date/month inputs across day, month, and range modes
    const DashboardPage = require('../frontend/src/app/(dashboard)/dashboard/page').default;
    const dashboardHarness = createHarness(DashboardPage);
    const dashboardDay = dashboardHarness.render();
    assert.match(
      dashboardDay.html,
      /<input[^>]*type="date"[^>]*dark:\[color-scheme:dark\][^"]*"[^>]*aria-label="Select date"/,
      'DashboardPage day mode renders themed date input',
    );
    assert.match(
      dashboardDay.html,
      /aria-label="Select date"[^>]*\/>[\s]*<button[^>]*aria-label="Open date picker"[^>]*><svg[^>]*lucide-calendar-days/,
      'DashboardPage day mode renders accessible CalendarDays trigger button',
    );

    const monthModeBtn = findElement(
      dashboardDay.tree,
      (el) => el?.type === 'button' && el?.props?.children === 'Month',
    );
    assert.ok(monthModeBtn, 'DashboardPage renders Month period button');
    monthModeBtn.props.onClick();
    const dashboardMonth = dashboardHarness.render();
    assert.match(
      dashboardMonth.html,
      /<input[^>]*type="month"[^>]*dark:\[color-scheme:dark\][^"]*"[^>]*aria-label="Select month"/,
      'DashboardPage month mode renders themed month input',
    );
    assert.match(
      dashboardMonth.html,
      /aria-label="Select month"[^>]*\/>[\s]*<button[^>]*aria-label="Open month picker"[^>]*><svg[^>]*lucide-calendar-days/,
      'DashboardPage month mode renders accessible CalendarDays trigger button',
    );

    const rangeModeBtn = findElement(
      dashboardMonth.tree,
      (el) => el?.type === 'button' && el?.props?.children === 'Range',
    );
    assert.ok(rangeModeBtn, 'DashboardPage renders Range period button');
    rangeModeBtn.props.onClick();
    const dashboardRange = dashboardHarness.render();
    for (const label of ['Period start', 'Period end']) {
      assert.match(
        dashboardRange.html,
        new RegExp(
          `<input[^>]*type="date"[^>]*dark:\\[color-scheme:dark\\][^"]*"[^>]*aria-label="${label}"`,
        ),
        `DashboardPage range mode renders themed ${label} date input`,
      );
    }

    // 3i. Verify WhatsAppPage renders themed quiet-hours time inputs on automation tab
    (globalThis as any).window = {
      localStorage: {
        getItem: (key: string) => (key === 'whatsapp.activeTab' ? 'automation' : null),
        setItem: () => {},
      },
    };
    const WhatsAppPage = require('../frontend/src/app/(dashboard)/whatsapp/page').default;
    const whatsappHtml = renderWithIntl(React.createElement(WhatsAppPage));
    for (const timeId of ['wa-quiet-hours-start', 'wa-quiet-hours-end']) {
      assert.match(
        whatsappHtml,
        new RegExp(
          `<input[^>]*type="time"[^>]*dark:\\[color-scheme:dark\\][^"]*"[^>]*id="${timeId}"`,
        ),
        `WhatsAppPage applies dark color-scheme to #${timeId}`,
      );
      assert.match(
        whatsappHtml,
        new RegExp(`id="${timeId}"[^>]*\\/>[\\s]*<button[^>]*><svg[^>]*lucide-clock`),
        `WhatsAppPage renders Clock trigger button for #${timeId}`,
      );
    }
  } finally {
    useAuthStore.setState(prevAuth);
    Object.assign(useAuthStore.getInitialState(), prevAuthInitial);
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
  }

  console.log('✓ Themed date/time input checks passed');
} finally {
  if (origDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = origDocument;
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
}
