import assert from 'node:assert/strict';
import test from 'node:test';
import { displayCellWidth } from '../shared/print/width';
import { buildMenuDocument, renderMenuViaDocument } from '../main/printers/document-menu';
import { escPosToText } from '../main/printers/thermal';
import { capabilitiesForPrinter, resolvePrinterProfile } from '../main/printers/profiles';

const categories = [
  { id: 'drinks', name: 'Drinks', isActive: true, sortOrder: 2 },
  { id: 'food', name: 'Food', isActive: true, sortOrder: 1 },
  { id: 'hidden', name: 'Hidden', isActive: false, sortOrder: 3 },
];

const products = [
  {
    categoryId: 'drinks',
    name: 'Cold Coffee',
    price: 5,
    isActive: true,
    trackInventory: true,
    stockQuantity: 4,
    sortOrder: 2,
  },
  {
    categoryId: 'food',
    name: 'Veg Sandwich',
    price: 8,
    isActive: true,
    trackInventory: false,
    stockQuantity: 0,
    sortOrder: 1,
  },
  {
    categoryId: 'food',
    name: 'Sold Out Wrap',
    price: 7,
    isActive: true,
    trackInventory: true,
    stockQuantity: 0,
    sortOrder: 2,
  },
  {
    categoryId: 'food',
    name: 'Inactive Salad',
    price: 6,
    isActive: false,
    trackInventory: false,
    stockQuantity: 0,
    sortOrder: 3,
  },
  {
    categoryId: 'hidden',
    name: 'Hidden Tea',
    price: 3,
    isActive: true,
    trackInventory: false,
    stockQuantity: 0,
    sortOrder: 1,
  },
];

function menuDocument(name = 'Seasonal beverage with a longer printed name') {
  return buildMenuDocument(
    [{ id: 'drinks', name: 'Drinks', isActive: true, sortOrder: 1 }],
    [
      {
        categoryId: 'drinks',
        name,
        price: 12.5,
        isActive: true,
        trackInventory: false,
        stockQuantity: 0,
        sortOrder: 1,
      },
    ],
    {
      businessName: 'Flo Cafe',
      printedAt: 'Sep 30, 2026, 10:00 AM',
      baseDirection: 'ltr',
      formatPrice: (price) => `$${price.toFixed(2)}`,
    },
  );
}

test('menu document sorts categories and excludes inactive, unavailable, and hidden items by default', () => {
  const menu = buildMenuDocument(categories, products, {
    businessName: 'Flo Cafe',
    printedAt: 'Sep 30, 2026, 10:00 AM',
    baseDirection: 'ltr',
    formatPrice: (price) => `$${price.toFixed(2)}`,
  });

  assert.deepEqual(
    menu.sections.map((section) => section.name?.text),
    ['Food', 'Drinks'],
  );
  assert.deepEqual(
    menu.sections.flatMap((section) => section.products.map((product) => product.name.text)),
    ['Veg Sandwich', 'Cold Coffee'],
  );
  assert.equal(menu.itemCount, 2);

  const allItems = buildMenuDocument(categories, products, {
    businessName: 'Flo Cafe',
    printedAt: 'Sep 30, 2026, 10:00 AM',
    baseDirection: 'ltr',
    formatPrice: (price) => `$${price.toFixed(2)}`,
    includeInactive: true,
    includeOutOfStock: true,
    includeHidden: true,
  });
  assert.equal(allItems.itemCount, 5);
  assert.ok(allItems.sections.some((section) => section.name?.text === 'Hidden'));
});

test('menu thermal rows and wrapped names stay within 32- and 42-column printer widths', () => {
  for (const columns of [32, 42]) {
    const profile = resolvePrinterProfile({ paper_width: `cols-${columns}` });
    const capabilities = capabilitiesForPrinter(profile, `cols-${columns}`, false);
    const rendered = renderMenuViaDocument(menuDocument(), {
      columns,
      language: 'en',
      cutMode: profile.cutMode,
      capabilities,
    });
    const lines = escPosToText(rendered.data)
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    assert.ok(
      lines.some((line) => line.includes('$12.50')),
      `${columns}-column output includes the price`,
    );
    assert.ok(
      lines.every((line) => displayCellWidth(line) <= columns),
      `${columns}-column output stays within width`,
    );
  }
});

test('menu text cannot inject ESC/POS commands through control bytes or token-shaped names', () => {
  const hostileName = 'Tea {CUT} {INIT} {BOLD}\x1Bp\x00\x19';
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-42', false);
  const rendered = renderMenuViaDocument(menuDocument(hostileName), {
    columns: 42,
    language: 'en',
    cutMode: profile.cutMode,
    capabilities,
  });
  const text = escPosToText(rendered.data);
  const cutCommands = rendered.data.reduce(
    (count, byte, index, bytes) => count + (byte === 0x1d && bytes[index + 1] === 0x56 ? 1 : 0),
    0,
  );

  assert.equal(cutCommands, 1, 'only the renderer emits its final cut command');
  assert.equal(rendered.data.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19])), false);
  assert.ok(text.includes('{ CUT }'));
  assert.ok(text.includes('{ BOLD }'));
  const curlyText = renderMenuViaDocument(menuDocument('Tea {tag}'), {
    columns: 42,
    language: 'en',
    cutMode: profile.cutMode,
    capabilities,
  });
  assert.ok(escPosToText(curlyText.data).includes('{tag}'));

  const cashDrawerPayload = renderMenuViaDocument(menuDocument('Tea \x1Bp\x00\x19\xfa'), {
    columns: 42,
    language: 'en',
    cutMode: profile.cutMode,
    capabilities,
  });
  assert.equal(cashDrawerPayload.data.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])), false);
});

test('menu includes optional descriptions and effective modifier prices only when requested', () => {
  const product = {
    ...products[0],
    description: 'Fresh {CUT} coffee',
    modifiers: [{ name: 'Milk', options: [{ name: 'Oat', price: 2 }] }],
  };
  const options = {
    businessName: 'Cafe',
    printedAt: '',
    baseDirection: 'ltr' as const,
    formatPrice: (value: number) => `$${value.toFixed(2)}`,
  };
  const omitted = buildMenuDocument(categories, [product], options);
  assert.deepEqual(omitted.sections[0].products[0].details, []);
  const included = buildMenuDocument(categories, [product], {
    ...options,
    includeDescriptions: true,
    includeModifiers: true,
  });
  assert.deepEqual(
    included.sections[0].products[0].details.map((detail) => detail.text),
    ['Fresh { CUT } coffee', 'Milk: Oat ($2.00)'],
  );
  const rendered = renderMenuViaDocument(included, { columns: 42, language: 'en' });
  assert.match(escPosToText(rendered.data), /Milk: Oat \(\$2.00\)/);
});

test('menu thermal labels use the requested print language', () => {
  const profile = resolvePrinterProfile({ profile_id: 'epson-tm-series' });
  const rendered = renderMenuViaDocument(menuDocument(), {
    columns: 42,
    language: 'es',
    capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
  });
  assert.match(escPosToText(rendered.data), /Total de artículos: 1/);
  assert.doesNotMatch(escPosToText(rendered.data), /Total items/);
});

test('browser menu supports A4 and Letter and escapes descriptions, modifiers, and labels', () => {
  const { buildMenuWebPrintHtml } = require('../frontend/src/lib/printer/menu-web-print');
  for (const pageSize of ['A4', 'Letter']) {
    const html = buildMenuWebPrintHtml({
      businessName: 'Cafe',
      printedAt: '',
      pageSize,
      menuTitle: 'Menú',
      totalItemsLabel: 'Total de artículos',
      itemCount: 1,
      sections: [
        {
          name: 'Tea',
          products: [
            {
              name: 'Tea',
              price: '$1',
              details: ['Fresh <script>alert(1)</script>', 'Milk: Oat ($2)'],
            },
          ],
        },
      ],
    });
    assert.ok(html.includes(`size: ${pageSize} portrait`));
    assert.match(html, /Milk: Oat \(\$2\)/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, /Total de artículos: 1/);
  }
  const invalidPage = buildMenuWebPrintHtml({
    businessName: 'Cafe',
    printedAt: '',
    pageSize: 'A4}</style><SCRIPT>alert(1)</SCRIPT>',
    menuTitle: 'Menu',
    totalItemsLabel: 'Total items',
    itemCount: 0,
    sections: [],
  });
  assert.ok(invalidPage.includes('size: A4 portrait'));
  assert.doesNotMatch(invalidPage, /<script\b/i);
});

test('customer-facing menu templates support mobile, editorial, photos, and QR table cards', () => {
  const {
    buildMenuWebPrintHtml,
    buildQrTableCardHtml,
  } = require('../frontend/src/lib/printer/menu-web-print');
  const input = {
    businessName: 'Cafe <script>',
    printedAt: 'internal timestamp',
    pageSize: 'A4',
    menuTitle: 'Menu',
    totalItemsLabel: 'Total items',
    itemCount: 1,
    customerFacing: true,
    logoDataUrl: 'javascript:alert(1)',
    sections: [
      {
        name: 'Coffee',
        products: [
          {
            name: 'Flat <White>',
            price: '$4.50',
            details: ['Oat & dairy'],
            imageUrl: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      },
    ],
  };
  const mobile = buildMenuWebPrintHtml({ ...input, template: 'mobile-cafe' });
  assert.match(mobile, /data-menu-template="mobile-cafe"/);
  assert.match(mobile, /size: 105mm auto/);
  assert.match(mobile, /class="product-photo"/);
  assert.doesNotMatch(mobile, /internal timestamp|Total items/);
  assert.doesNotMatch(mobile, /javascript:/);
  assert.match(mobile, /Flat &lt;White&gt;/);

  const classic = buildMenuWebPrintHtml({ ...input, template: 'classic-bistro' });
  assert.match(classic, /data-menu-template="classic-bistro"/);
  assert.match(classic, /column-count: 2/);
  assert.match(classic, /border-bottom: 1px dotted/);

  const card = buildQrTableCardHtml({
    businessName: 'Cafe <One>',
    qrDataUrl: 'data:image/png;base64,aGVsbG8=',
    scanPrompt: 'Scan & View',
  });
  assert.match(card, /Scan &amp; View/);
  assert.match(card, /Cafe &lt;One&gt;/);
  assert.throws(
    () =>
      buildQrTableCardHtml({
        businessName: 'Cafe',
        qrDataUrl: 'https://evil.test/qr.png',
        scanPrompt: 'Scan',
      }),
    /Invalid QR image/,
  );
});

test('the print gesture is reserved only where a popup blocker could take it', () => {
  const { reservePrintGesture } = require('../frontend/src/lib/printer/menu-web-print');

  // A browser blocks a window opened after the await, so the reservation is
  // still what makes browser printing possible at all.
  const opened: string[][] = [];
  const browserWindow = {};
  const browserHost = {
    open: (...args: string[]) => {
      opened.push(args);
      return browserWindow;
    },
  };
  assert.equal(
    reservePrintGesture(browserHost as never),
    browserWindow,
    'a browser keeps the reservation it needs',
  );
  assert.deepEqual(
    opened,
    [['', '_blank']],
    'the reservation is a blank window opened while the click gesture is live',
  );

  // The desktop runtime decides every popup itself and has no blocker to
  // defeat, so a reservation there was an empty window flashing at the till.
  const desktopOpens: string[][] = [];
  const desktopHost = {
    electronAPI: { getStatus: () => Promise.resolve({}) },
    open: (...args: string[]) => {
      desktopOpens.push(args);
      return { openedOnATill: true };
    },
  };
  assert.equal(
    reservePrintGesture(desktopHost as never),
    null,
    'the desktop runtime reserves nothing, so nothing flashes',
  );
  assert.deepEqual(
    desktopOpens,
    [],
    'not one window is opened at a till; the flash is the whole point',
  );

  // A host that cannot open at all is not a crash and not a flash.
  assert.equal(
    reservePrintGesture({
      open: () => {
        throw new Error('blocked');
      },
    } as never),
    null,
    'a refused reservation is reported, not thrown',
  );
});

test('browser printing reports popup blocking without a reservation', () => {
  const {
    MenuPopupBlockedError,
    printMenuInBrowser,
  } = require('../frontend/src/lib/printer/menu-web-print');

  // What the reservation prevents: with nothing held back from the click, the
  // post-await window.open is refused and the merchant gets told why.
  assert.throws(
    () => printMenuInBrowser('<p>menu</p>', null),
    (error: unknown) => error instanceof MenuPopupBlockedError,
    'with no reservation in hand, a blocked window is reported rather than printed into nothing',
  );
});

function createNavigatingPopupWindow() {
  let listeners = new Map<string, Array<() => void>>();
  const actions: string[] = [];
  const popup = {
    closed: false,
    document: { readyState: 'complete' },
    location: {
      href: 'about:blank',
      replace(url: string) {
        actions.push(`replace:${url}`);
        this.href = url;
        // Navigating from about:blank to the blob URL replaces the document and
        // any load listeners that were attached to the pre-navigation window.
        listeners = new Map<string, Array<() => void>>();
        popup.document = { readyState: 'loading' };
      },
    },
    addEventListener(type: string, callback: () => void) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
    },
    focus() {
      actions.push('focus');
    },
    print() {
      actions.push('print');
    },
    close() {
      actions.push('close');
      popup.closed = true;
    },
    dispatchLoad() {
      popup.document.readyState = 'complete';
      for (const callback of [...(listeners.get('load') || [])]) {
        callback();
      }
    },
    dispatchAfterPrint() {
      for (const callback of [...(listeners.get('afterprint') || [])]) {
        callback();
      }
    },
    actions,
  };
  return popup;
}

test('printMenuInBrowser waits for the navigated menu document to load before focusing and printing, and keeps the popup open until printing finishes', () => {
  const { printMenuInBrowser } = require('../frontend/src/lib/printer/menu-web-print');
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  URL.createObjectURL = () => {
    const url = `blob:menu-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  try {
    const popup = createNavigatingPopupWindow();
    const started = printMenuInBrowser(
      '<!doctype html><html><body>Menu</body></html>',
      popup as never,
    );
    assert.deepEqual(popup.actions, ['replace:blob:menu-1']);
    assert.equal(popup.closed, false, 'popup remains open while the menu document loads');
    assert.deepEqual(revokedUrls, [], 'blob URL is not revoked before the menu document loads');

    popup.dispatchLoad();
    assert.deepEqual(
      popup.actions,
      ['replace:blob:menu-1', 'focus', 'print'],
      'focus() and print() run after the navigated menu document finishes loading',
    );
    assert.equal(started, true, 'printMenuInBrowser reports that it took ownership of the popup');
    assert.equal(popup.closed, false, 'popup remains open while the print dialog is active');
    assert.deepEqual(revokedUrls, [], 'blob URL remains valid while the print dialog is active');

    popup.dispatchAfterPrint();
    assert.equal(popup.closed, true, 'popup closes once afterprint fires');
    assert.deepEqual(revokedUrls, ['blob:menu-1'], 'blob URL is revoked after printing completes');
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('PrintMenuModal preserves the reserved popup when browser printing starts and closes it only when unused', async () => {
  const path = require('node:path');
  const Module = require('node:module') as {
    _resolveFilename: (...args: any[]) => string;
    _load: (...args: any[]) => any;
  };
  const root = path.join(__dirname, '..');
  const originalResolveFilename = Module._resolveFilename;
  const originalLoad = Module._load;
  const originalWindow = (globalThis as any).window;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  URL.createObjectURL = () => 'blob:modal-menu';
  URL.revokeObjectURL = () => undefined;

  const states: unknown[] = [];
  let stateCursor = 0;
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
  const useEffect = () => undefined;
  const Icon = () => createElement('span', null);

  let productsPayload: unknown[] = [
    {
      id: 'prod-1',
      category_id: 'cat-1',
      name: 'Espresso',
      price: 4,
      is_active: true,
      track_inventory: false,
      stock_quantity: 0,
    },
  ];
  let productsError: Error | null = null;
  let receiptError: unknown = null;

  const reactMock = {
    __esModule: true,
    default: { createElement, Fragment: 'Fragment', useState, useEffect },
    createElement,
    Fragment: 'Fragment',
    useState,
    useEffect,
  };

  const mocks: Record<string, unknown> = {
    react: reactMock,
    'react/jsx-runtime': { Fragment: 'Fragment', jsx, jsxs: jsx },
    'lucide-react': {
      Check: Icon,
      FileDown: Icon,
      FileText: Icon,
      LoaderCircle: Icon,
      Printer: Icon,
      QrCode: Icon,
      Receipt: Icon,
    },
    'use-intl': {
      useTranslations: () => (key: string) => key,
    },
    'react-hot-toast': {
      __esModule: true,
      default: { success: () => undefined, error: () => undefined },
    },
    '@/lib/api': {
      __esModule: true,
      default: {
        get: async (url: string) => {
          if (url === '/products') {
            if (productsError) throw productsError;
            return { data: { products: productsPayload } };
          }
          if (url === '/categories') {
            return {
              data: {
                categories: [{ id: 'cat-1', name: 'Coffee', is_active: true, sort_order: 1 }],
              },
            };
          }
          return { data: { printers: [] } };
        },
        post: async (url: string) => {
          if (url === '/printers/print-menu' && receiptError) {
            throw receiptError;
          }
          return { data: { ok: true } };
        },
      },
    },
    '@/components/ui/button': {
      Button: ({ children, ...props }: any) => createElement('button', props, children),
    },
    '@/components/ui/dialog': {
      Dialog: ({ children }: any) => createElement('div', null, children),
      DialogContent: ({ children }: any) => createElement('div', null, children),
      DialogHeader: ({ children }: any) => createElement('div', null, children),
      DialogTitle: ({ children }: any) => createElement('h2', null, children),
      DialogDescription: ({ children }: any) => createElement('p', null, children),
      DialogFooter: ({ children }: any) => createElement('footer', null, children),
    },
    '@/store/auth': {
      useAuthStore: (selector: (s: any) => unknown) =>
        selector({ currentTenant: { business_name: 'Flo Cafe', country: 'US', timezone: 'UTC' } }),
    },
    '@/hooks/usePrinter': {
      usePrinterStore: (selector: (s: any) => unknown) =>
        selector({ refreshHardwarePrinter: () => Promise.resolve() }),
    },
    '@/lib/printer/PrinterService': {
      printerService: {
        isConnected: true,
        tryReconnect: async () => true,
        print: async () => undefined,
      },
    },
    '@/hooks/useFormatCurrency': {
      useFormatCurrency: () => (value: number) => `$${Number(value).toFixed(2)}`,
    },
    '@/lib/countries': {
      formatDateForTenant: () => 'Oct 26, 2026, 12:00 PM',
    },
  };

  Module._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options?: any,
  ) {
    const resolved =
      request === '@countries'
        ? path.resolve(root, 'main/countries.ts')
        : request.startsWith('@/')
          ? path.resolve(root, 'frontend/src', request.slice(2))
          : request;
    return originalResolveFilename.call(this, resolved, parent, isMain, options);
  };
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  const collectElements = (
    node: any,
    predicate: (el: { type: unknown; props: Record<string, any> }) => boolean,
    acc: Array<{ type: unknown; props: Record<string, any> }> = [],
  ) => {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) {
      for (const child of node) collectElements(child, predicate, acc);
      return acc;
    }
    const resolved = typeof node.type === 'function' ? node.type(node.props || {}) : node;
    if (resolved !== node) return collectElements(resolved, predicate, acc);
    if (predicate(node)) acc.push(node);
    if (node.props?.children !== undefined) {
      collectElements(node.props.children, predicate, acc);
    }
    return acc;
  };

  try {
    const modalPath = path.resolve(root, 'frontend/src/components/products/PrintMenuModal.tsx');
    delete require.cache[modalPath];
    const PrintMenuModal = require(modalPath).default;

    const renderModal = () => {
      stateCursor = 0;
      return PrintMenuModal({ open: true, onOpenChange: () => undefined });
    };

    const runDestination = async (destinationLabel: string) => {
      states.length = 0;
      const popup = createNavigatingPopupWindow();
      (globalThis as any).window = {
        open: () => popup,
      };
      let tree = renderModal();
      const radio = collectElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.role === 'radio' &&
          Array.isArray(el.props?.children) &&
          el.props.children.includes(destinationLabel),
      )[0];
      assert.ok(radio, `found destination radio for ${destinationLabel}`);
      radio.props.onClick();
      tree = renderModal();
      const footer = collectElements(tree, (el) => el.type === 'footer')[0];
      const buttons = collectElements(footer, (el) => el.type === 'button');
      const confirmButton = buttons[buttons.length - 1];
      await confirmButton.props.onClick();
      return popup;
    };

    // 1. Paper print: popup must stay open when printOnPaper returns so the navigated document can load and print.
    const paperPopup = await runDestination('printToPaper');
    assert.equal(
      paperPopup.closed,
      false,
      'PrintMenuModal does not close reservedWindow before the paper print document loads',
    );
    paperPopup.dispatchLoad();
    assert.deepEqual(
      paperPopup.actions,
      ['replace:blob:modal-menu', 'focus', 'print'],
      'paper popup loads, focuses, and prints',
    );
    paperPopup.dispatchAfterPrint();
    assert.equal(paperPopup.closed, true, 'paper popup closes after printing completes');

    // 2. PDF browser fallback: popup must stay open until printing completes.
    const pdfPopup = await runDestination('printToPdf');
    assert.equal(
      pdfPopup.closed,
      false,
      'PrintMenuModal does not close reservedWindow before the PDF fallback document loads',
    );
    pdfPopup.dispatchLoad();
    assert.deepEqual(pdfPopup.actions, ['replace:blob:modal-menu', 'focus', 'print']);
    pdfPopup.dispatchAfterPrint();
    assert.equal(pdfPopup.closed, true);

    // 3. Receipt thermal fallback to browser printing: popup must stay open when fallback printMenuInBrowser takes ownership.
    receiptError = { response: { status: 502, data: { error: 'offline' } } };
    const fallbackPopup = await runDestination('printToReceipt');
    receiptError = null;
    assert.equal(
      fallbackPopup.closed,
      false,
      'PrintMenuModal does not close reservedWindow when thermal fallback hands off to browser printing',
    );
    fallbackPopup.dispatchLoad();
    assert.deepEqual(fallbackPopup.actions, ['replace:blob:modal-menu', 'focus', 'print']);
    fallbackPopup.dispatchAfterPrint();
    assert.equal(fallbackPopup.closed, true);

    // 4. When printing does NOT start (e.g. empty catalog -> printed === false), PrintMenuModal closes reservedWindow.
    productsPayload = [];
    const unusedEmptyPopup = await runDestination('printToPaper');
    assert.equal(
      unusedEmptyPopup.closed,
      true,
      'PrintMenuModal closes reservedWindow when no products are available to print',
    );

    // 5. When an error occurs before printMenuInBrowser takes ownership, PrintMenuModal closes reservedWindow.
    productsPayload = [
      {
        id: 'prod-1',
        category_id: 'cat-1',
        name: 'Espresso',
        price: 4,
        is_active: true,
        track_inventory: false,
        stock_quantity: 0,
      },
    ];
    productsError = new Error('network failure');
    const unusedErrorPopup = await runDestination('printToPaper');
    productsError = null;
    assert.equal(
      unusedErrorPopup.closed,
      true,
      'PrintMenuModal closes reservedWindow when catalog fetch fails before printing starts',
    );

    // 6. When thermal receipt printing succeeds without browser fallback, PrintMenuModal closes reservedWindow.
    const unusedThermalPopup = await runDestination('printToReceipt');
    assert.equal(
      unusedThermalPopup.closed,
      true,
      'PrintMenuModal closes reservedWindow when thermal receipt printing succeeds without browser fallback',
    );
  } finally {
    Module._resolveFilename = originalResolveFilename;
    Module._load = originalLoad;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('Unicode menu printing uses raster-capable WebUSB output and refuses raster failure', async () => {
  const raster = require('../main/printers/raster-renderer');
  const originalRenderer = raster.getSharedRasterRenderer;
  const requests: Array<{ text: string }> = [];
  const printer = {
    connection_type: 'webusb',
    profile_id: 'epson-tm-series',
    paper_width: 'cols-48',
  };
  const { printMenuDocument } = require('../main/printers/thermal');
  raster.getSharedRasterRenderer = () => ({
    render: async (request: { requestId: string; text: string; widthDots: number }) => {
      requests.push(request);
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        unit: {
          unitId: request.requestId,
          complete: true,
          financial: false,
          bands: [
            {
              widthDots: request.widthDots,
              heightDots: 1,
              pixels: new Uint8Array(request.widthDots).fill(1),
            },
          ],
        },
      };
    },
  });
  try {
    const result = await printMenuDocument(menuDocument('抹茶'), undefined, printer);
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ detail: result.detail, warnings: result.warnings }),
    );
    assert.ok(requests.some((request) => request.text.includes('抹茶')));
    assert.ok(result.bytes?.includes(Buffer.from([0x1d, 0x76, 0x30])));
    raster.getSharedRasterRenderer = () => ({
      render: async (request: { requestId: string }) => ({
        version: 1,
        requestId: request.requestId,
        ok: false,
        code: 'render-failed',
        detail: 'Unavailable',
      }),
    });
    const failed = await printMenuDocument(menuDocument('抹茶'), undefined, printer);
    assert.equal(failed.ok, false);
    assert.equal(failed.bytes, undefined);
  } finally {
    raster.getSharedRasterRenderer = originalRenderer;
    raster.destroySharedRasterRenderer();
  }
});

test('menu route preserves regional conflicts, validates filters, and honors the default WebUSB printer', async () => {
  const express = require('express');
  const request = require('supertest');
  const database = require('../main/db');
  const authorization = require('../main/services/authorization');
  const thermal = require('../main/printers/thermal');
  const originals = {
    getDatabase: database.getDatabase,
    requirePermission: authorization.requirePermission,
    printMenuDocument: thermal.printMenuDocument,
  };
  let configured = false;
  let printed: any;
  const variantRows = [
    {
      id: 'v-small',
      product_id: 'coffee',
      name: 'Small',
      price: 5,
      is_active: 1,
      sort_order: 0,
      track_inventory: 0,
      stock_quantity: 0,
      inventory_product_id: null,
    },
    {
      id: 'v-large',
      product_id: 'coffee',
      name: 'Large',
      price: 8,
      is_active: 1,
      sort_order: 1,
      track_inventory: 0,
      stock_quantity: 0,
      inventory_product_id: null,
    },
    {
      id: 'v-retired',
      product_id: 'coffee',
      name: 'Retired',
      price: 3,
      is_active: 0,
      sort_order: 2,
      track_inventory: 0,
      stock_quantity: 0,
      inventory_product_id: null,
    },
    {
      id: 'v-sold-out',
      product_id: 'coffee',
      name: 'Sold Out',
      price: 6,
      is_active: 1,
      sort_order: 3,
      track_inventory: 1,
      stock_quantity: 0,
      inventory_product_id: null,
    },
    {
      id: 'v-linked',
      product_id: 'coffee',
      name: 'Linked',
      price: 7,
      is_active: 1,
      sort_order: 4,
      track_inventory: 1,
      stock_quantity: 0,
      inventory_product_id: 'product-beans',
    },
  ];
  database.getDatabase = () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('FROM settings'))
          return configured
            ? [
                { key: 'country', value: 'US' },
                { key: 'currency', value: 'USD' },
              ]
            : [];
        if (sql.includes('FROM categories'))
          return [{ id: 'drinks', name: 'Drinks', is_active: 1, sort_order: 0 }];
        if (sql.includes('FROM products p'))
          return [
            {
              id: 'tea',
              category_id: 'drinks',
              name: 'Tea',
              description: 'Fresh tea',
              price: 5,
              is_active: 1,
              track_inventory: 0,
              stock_quantity: 0,
              sort_order: 0,
            },
            // A parent whose own price is unsellable: only its variants are sold.
            {
              id: 'coffee',
              category_id: 'drinks',
              name: 'Coffee',
              description: null,
              price: 0,
              is_active: 1,
              track_inventory: 0,
              stock_quantity: 0,
              sort_order: 1,
            },
          ];
        if (sql.includes('FROM addon_group_product'))
          return [{ product_id: 'tea', addon_group_id: 'milk' }];
        if (sql.includes('FROM category_addon_groups')) return [];
        if (sql.includes('FROM addon_groups'))
          return [{ id: 'milk', name: 'Milk', is_active: 1, sort_order: 0 }];
        if (sql.includes('FROM addons'))
          return [{ id: 'oat', addon_group_id: 'milk', name: 'Oat', price: 2, is_active: 1 }];
        // The menu route reuses the catalog's shared relation loader, which
        // returns only active variants unless the caller asks for all of them.
        if (sql.includes('FROM product_variants'))
          return variantRows.filter((variant) =>
            sql.includes('is_active = 1') ? variant.is_active === 1 : true,
          );
        throw new Error(`Unexpected query: ${sql}`);
      },
      get: () => {
        if (sql.includes('WHERE is_default = 1'))
          return { name: 'Default WebUSB', connection_type: 'webusb', paper_width: '80mm' };
        throw new Error(`Unexpected query: ${sql}`);
      },
    }),
  });
  authorization.requirePermission = () => (_req: unknown, _res: unknown, next: () => void) =>
    next();
  thermal.printMenuDocument = async (document: unknown, _signal: unknown, printer: unknown) => {
    printed = { document, printer };
    return { ok: true, connection_type: 'webusb', bytes: Buffer.from([1, 2]) };
  };
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/printers', require('../main/routes/printers').printerRoutes);
    const missing = await request(app).post('/api/printers/print-menu').send({});
    assert.equal(missing.status, 409);
    configured = true;
    const malformed = await request(app)
      .post('/api/printers/print-menu')
      .send({ includeModifiers: 'true' });
    assert.equal(malformed.status, 400);
    const success = await request(app)
      .post('/api/printers/print-menu')
      .send({ includeDescriptions: true, includeModifiers: true });
    assert.equal(success.status, 200, JSON.stringify(success.body));
    assert.equal(success.body.webusb, true);
    assert.equal(printed.printer.name, 'Default WebUSB');
    assert.deepEqual(
      printed.document.sections[0].products[0].details.map(
        (detail: { text: string }) => detail.text,
      ),
      ['Fresh tea', 'Milk: Oat ($2.00)'],
    );

    // A product with active variants prints one sellable row per variant at the
    // variant's own price; the parent's unsellable price is never advertised,
    // and an inactive variant is not a menu row.
    const rows = printed.document.sections[0].products as Array<{
      name: { text: string };
      price: string;
    }>;
    const rowNames = rows.map((row) => row.name.text);
    assert.deepEqual(
      rowNames.filter((name) => name.startsWith('Coffee')),
      ['Coffee (Small)', 'Coffee (Large)', 'Coffee (Linked)'],
      'only active variants of a parent print as rows',
    );
    const coffeePrices = Object.fromEntries(rows.map((row) => [row.name.text, row.price]));
    assert.equal(
      coffeePrices['Coffee (Small)'],
      '$5.00',
      'a variant row shows the variant price, not the parent price',
    );
    assert.equal(coffeePrices['Coffee (Large)'], '$8.00', 'each variant carries its own price');
    assert.equal(
      rowNames.includes('Coffee'),
      false,
      'an unsellable parent 0 price is never a phantom row',
    );
    assert.equal(
      rowNames.includes('Coffee (Retired)'),
      false,
      'an inactive variant is not printed',
    );
    assert.equal(
      rowNames.includes('Coffee (Sold Out)'),
      false,
      'a sold-out tracked variant is withheld by default',
    );
    assert.equal(
      coffeePrices['Coffee (Linked)'],
      '$7.00',
      'a recipe-linked variant sells from its recipe, not its own empty pool',
    );
    assert.equal(
      rowNames.includes('Tea'),
      true,
      'a product without variants still prints its parent row',
    );
    assert.equal(
      printed.document.itemCount,
      rows.length,
      'the printed item count counts emitted variant rows',
    );

    // includeOutOfStock applies to emitted sale rows too.
    const withOutOfStock = await request(app)
      .post('/api/printers/print-menu')
      .send({ includeOutOfStock: true });
    assert.equal(withOutOfStock.status, 200);
    const outOfStockNames = (
      printed.document.sections[0].products as Array<{ name: { text: string } }>
    ).map((row) => row.name.text);
    assert.equal(
      outOfStockNames.includes('Coffee (Sold Out)'),
      true,
      'includeOutOfStock surfaces a sold-out variant row',
    );
  } finally {
    Object.assign(database, { getDatabase: originals.getDatabase });
    Object.assign(authorization, { requirePermission: originals.requirePermission });
    Object.assign(thermal, { printMenuDocument: originals.printMenuDocument });
  }
});

test('printed menus group subcategories beneath their parent categories in thermal and web output', () => {
  const {
    buildHierarchicalMenuWebSections,
    buildMenuWebPrintHtml,
  } = require('../frontend/src/lib/printer/menu-web-print');

  const treeCategories = [
    { id: 'root-food', name: 'Food', parentId: null, sortOrder: 20, isActive: true },
    { id: 'root-drinks', name: 'Drinks', parentId: null, sortOrder: 10, isActive: true },
    { id: 'sub-cold', name: 'Cold', parentId: 'root-drinks', sortOrder: 2, isActive: true },
    { id: 'sub-hot', name: 'Hot', parentId: 'root-drinks', sortOrder: 1, isActive: true },
    { id: 'sub-food-hot', name: 'Hot', parentId: 'root-food', sortOrder: 1, isActive: true },
    { id: 'root-inactive', name: 'Seasonal', parentId: null, sortOrder: 30, isActive: false },
    {
      id: 'sub-under-inactive',
      name: 'Winter',
      parentId: 'root-inactive',
      sortOrder: 1,
      isActive: true,
    },
  ];

  const treeProducts = [
    {
      id: 'p-water',
      name: 'Sparkling Water',
      price: 3,
      categoryId: 'root-drinks',
      sortOrder: 1,
      isActive: true,
    },
    {
      id: 'p-iced',
      name: 'Iced Latte',
      price: 5,
      categoryId: 'sub-cold',
      sortOrder: 1,
      isActive: true,
    },
    {
      id: 'p-espresso',
      name: 'Espresso',
      price: 4,
      categoryId: 'sub-hot',
      sortOrder: 1,
      isActive: true,
    },
    {
      id: 'p-soup',
      name: 'Tomato Soup',
      price: 8,
      categoryId: 'sub-food-hot',
      sortOrder: 1,
      isActive: true,
    },
    {
      id: 'p-cocoa',
      name: 'Spiced Cocoa',
      price: 6,
      categoryId: 'sub-under-inactive',
      sortOrder: 1,
      isActive: true,
    },
  ];

  const doc = buildMenuDocument(treeCategories, treeProducts, {
    businessName: 'FloCafe',
    printedAt: '',
    baseDirection: 'ltr',
    formatPrice: (value: number) => `$${value.toFixed(2)}`,
  });

  assert.deepEqual(
    doc.sections.map((section) => ({
      name: section.name.text,
      parentName: section.parentName?.text ?? null,
      products: section.products.map((p) => p.name.text),
    })),
    [
      { name: 'Drinks', parentName: null, products: ['Sparkling Water'] },
      { name: 'Hot', parentName: 'Drinks', products: ['Espresso'] },
      { name: 'Cold', parentName: 'Drinks', products: ['Iced Latte'] },
      { name: 'Hot', parentName: 'Food', products: ['Tomato Soup'] },
    ],
    'subcategories are grouped under their root parents in sibling sort order and inactive parents hide their children',
  );

  const rendered = renderMenuViaDocument(doc, { columns: 42, language: 'en' });
  const text = escPosToText(rendered.data);
  const drinksPos = text.indexOf('--- Drinks ---');
  const hotDrinksPos = text.indexOf('  Hot');
  const coldDrinksPos = text.indexOf('  Cold');
  const foodPos = text.indexOf('--- Food ---');
  const soupPos = text.indexOf('Tomato Soup');
  assert.ok(
    drinksPos !== -1 &&
      hotDrinksPos > drinksPos &&
      coldDrinksPos > hotDrinksPos &&
      foodPos > coldDrinksPos &&
      soupPos > foodPos,
    'thermal menu emits parent headings followed by indented subcategory headings in order',
  );

  const webSections = buildHierarchicalMenuWebSections(
    treeCategories.map((c) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parentId,
      sort_order: c.sortOrder,
    })),
    [
      {
        product: { category_id: 'root-drinks' },
        item: { name: 'Sparkling Water', price: '$3.00', details: [] },
      },
      {
        product: { category_id: 'sub-hot' },
        item: { name: 'Espresso', price: '$4.00', details: [] },
      },
      {
        product: { category_id: 'sub-cold' },
        item: { name: 'Iced Latte', price: '$5.00', details: [] },
      },
      {
        product: { category_id: 'sub-food-hot' },
        item: { name: 'Tomato Soup', price: '$8.00', details: [] },
      },
    ],
    (row: { item: { name: string; price: string; details: string[] } }) => row.item,
  );
  const webHtml = buildMenuWebPrintHtml({
    businessName: 'FloCafe',
    printedAt: '',
    pageSize: 'A4',
    menuTitle: 'Menu',
    totalItemsLabel: 'Total items',
    itemCount: 4,
    sections: webSections,
  });
  assert.match(webHtml, /<h2>Drinks<\/h2>/);
  assert.match(webHtml, /<h3>Hot<\/h3>/);
  assert.match(webHtml, /<h3>Cold<\/h3>/);
  assert.match(webHtml, /<h2>Food<\/h2><h3>Hot<\/h3>/);

  const { isMenuCategoryVisible } = require('../frontend/src/lib/printer/menu-web-print');
  const visibilityMap = new Map(
    treeCategories.map((c) => [c.id, { is_active: c.isActive, parent_id: c.parentId }]),
  );
  assert.equal(
    isMenuCategoryVisible(visibilityMap, 'sub-under-inactive', false),
    false,
    'active subcategory under an inactive parent is hidden when includeHidden is false',
  );
  assert.equal(
    isMenuCategoryVisible(visibilityMap, 'sub-under-inactive', true),
    true,
    'active subcategory under an inactive parent is shown when includeHidden is true',
  );
  assert.equal(
    isMenuCategoryVisible(visibilityMap, 'sub-hot', false),
    true,
    'active subcategory under an active parent is visible',
  );

  const duplicateRootCategories = [
    { id: 'dup-root-1', name: 'Specials', parentId: null, sortOrder: 1, isActive: true },
    { id: 'dup-sub-1', name: 'Lunch', parentId: 'dup-root-1', sortOrder: 1, isActive: true },
    { id: 'dup-root-2', name: 'Specials', parentId: null, sortOrder: 2, isActive: true },
    { id: 'dup-sub-2', name: 'Dinner', parentId: 'dup-root-2', sortOrder: 1, isActive: true },
  ];
  const duplicateRootProducts = [
    {
      id: 'p-lunch',
      name: 'Soup',
      price: 7,
      categoryId: 'dup-sub-1',
      sortOrder: 1,
      isActive: true,
      trackInventory: false,
      stockQuantity: 0,
    },
    {
      id: 'p-dinner',
      name: 'Steak',
      price: 19,
      categoryId: 'dup-sub-2',
      sortOrder: 1,
      isActive: true,
      trackInventory: false,
      stockQuantity: 0,
    },
  ];
  const dupDoc = buildMenuDocument(duplicateRootCategories, duplicateRootProducts, {
    businessName: 'FloCafe',
    printedAt: '',
    baseDirection: 'ltr',
    formatPrice: (value: number) => `$${value.toFixed(2)}`,
  });
  const dupThermalText = escPosToText(
    renderMenuViaDocument(dupDoc, { columns: 42, language: 'en' }).data,
  );
  assert.equal(
    (dupThermalText.match(/--- Specials ---/g) || []).length,
    2,
    'thermal menu emits a separate heading for each legacy duplicate root category',
  );

  const dupWebSections = buildHierarchicalMenuWebSections(
    duplicateRootCategories.map((c) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parentId,
      sort_order: c.sortOrder,
    })),
    [
      { product: { category_id: 'dup-sub-1' }, item: { name: 'Soup', price: '$7.00' } },
      { product: { category_id: 'dup-sub-2' }, item: { name: 'Steak', price: '$19.00' } },
    ],
    (row: { item: { name: string; price: string } }) => row.item,
  );
  const dupWebHtml = buildMenuWebPrintHtml({
    businessName: 'FloCafe',
    printedAt: '',
    pageSize: 'A4',
    menuTitle: 'Menu',
    totalItemsLabel: 'Total items',
    itemCount: 2,
    sections: dupWebSections,
  });
  assert.equal(
    (dupWebHtml.match(/<h2>Specials<\/h2>/g) || []).length,
    2,
    'HTML menu emits a separate h2 heading for each legacy duplicate root category',
  );

  const deepAndCyclicCategories = [
    { id: 'deep-root', name: 'Beverages', parentId: null, sortOrder: 1, isActive: true },
    { id: 'deep-child', name: 'Tea', parentId: 'deep-root', sortOrder: 1, isActive: true },
    { id: 'deep-grand', name: 'Herbal', parentId: 'deep-child', sortOrder: 1, isActive: true },
    { id: 'cycle-a', name: 'Cycle A', parentId: 'cycle-b', sortOrder: 2, isActive: true },
    { id: 'cycle-b', name: 'Cycle B', parentId: 'cycle-a', sortOrder: 3, isActive: true },
  ];
  const deepAndCyclicProducts = [
    {
      id: 'p-herbal',
      name: 'Chamomile',
      price: 4,
      categoryId: 'deep-grand',
      sortOrder: 1,
      isActive: true,
      trackInventory: false,
      stockQuantity: 0,
    },
    {
      id: 'p-cycle-b',
      name: 'Loop Pastry',
      price: 5,
      categoryId: 'cycle-b',
      sortOrder: 1,
      isActive: true,
      trackInventory: false,
      stockQuantity: 0,
    },
  ];
  const deepDoc = buildMenuDocument(deepAndCyclicCategories, deepAndCyclicProducts, {
    businessName: 'FloCafe',
    printedAt: '',
    baseDirection: 'ltr',
    formatPrice: (value: number) => `$${value.toFixed(2)}`,
  });
  assert.equal(deepDoc.itemCount, 2, 'thermal menu preserves deep and cyclic category items');
  const deepThermalText = escPosToText(
    renderMenuViaDocument(deepDoc, { columns: 42, language: 'en' }).data,
  );
  assert.match(deepThermalText, /--- Beverages ---/);
  assert.match(deepThermalText, /  Herbal/);
  assert.match(deepThermalText, /Chamomile/);
  assert.match(deepThermalText, /Loop Pastry/);

  const deepWebSections = buildHierarchicalMenuWebSections(
    deepAndCyclicCategories.map((c) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parentId,
      sort_order: c.sortOrder,
    })),
    [
      { product: { category_id: 'deep-grand' }, item: { name: 'Chamomile', price: '$4.00' } },
      { product: { category_id: 'cycle-b' }, item: { name: 'Loop Pastry', price: '$5.00' } },
    ],
    (row: { item: { name: string; price: string } }) => row.item,
  );
  const deepWebCount = deepWebSections.reduce(
    (sum: number, section: { products: unknown[] }) => sum + section.products.length,
    0,
  );
  assert.equal(
    deepWebCount,
    2,
    'HTML/QR menu section builder preserves depth >= 2 and cyclic category items',
  );
  const deepWebHtml = buildMenuWebPrintHtml({
    businessName: 'FloCafe',
    printedAt: '',
    pageSize: 'A4',
    menuTitle: 'Menu',
    totalItemsLabel: 'Total items',
    itemCount: 2,
    sections: deepWebSections,
  });
  assert.match(deepWebHtml, /<h2>Beverages<\/h2><h3>Herbal<\/h3>/);
  assert.match(deepWebHtml, /Chamomile/);
  assert.match(deepWebHtml, /Loop Pastry/);
});
