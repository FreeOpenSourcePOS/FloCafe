/**
 * Unit Test: POS Keyboard Shortcuts & Quantity Multiplier Parser
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/pos-keyboard-shortcuts.test.ts
 */

import assert from 'assert';
import Module from 'module';
import { parseQuantitySearch } from '../frontend/src/lib/quantity-search';
import {
  isTypingTarget,
  usePosKeyboardShortcuts,
  type PosKeyboardShortcutHandlers,
  type UsePosKeyboardShortcutsOptions,
} from '../frontend/src/hooks/usePosKeyboardShortcuts';

console.log('Testing parseQuantitySearch...');

// 1. Basic asterisk and x multiplier parsing
const r1 = parseQuantitySearch('3*latte');
assert.deepStrictEqual(r1, { quantity: 3, query: 'latte' }, 'parses 3*latte correctly');

const r2 = parseQuantitySearch('5xcroissant');
assert.deepStrictEqual(r2, { quantity: 5, query: 'croissant' }, 'parses 5xcroissant correctly');

const r3 = parseQuantitySearch('2Xsandwich');
assert.deepStrictEqual(
  r3,
  { quantity: 2, query: 'sandwich' },
  'parses uppercase 2Xsandwich correctly',
);

// 2. Multipliers with whitespace
const r4 = parseQuantitySearch('4 * espresso');
assert.deepStrictEqual(r4, { quantity: 4, query: 'espresso' }, 'parses 4 * espresso with spaces');

const r5 = parseQuantitySearch('  10 x cold brew  ');
assert.deepStrictEqual(
  r5,
  { quantity: 10, query: 'cold brew' },
  'parses 10 x cold brew with trimmed query',
);

// 3. Fractional / decimal quantities
const r6 = parseQuantitySearch('2.5*flour');
assert.deepStrictEqual(r6, { quantity: 2.5, query: 'flour' }, 'parses decimal quantity 2.5*flour');

const r7 = parseQuantitySearch('0.75xcheese');
assert.deepStrictEqual(
  r7,
  { quantity: 0.75, query: 'cheese' },
  'parses decimal quantity 0.75xcheese',
);

// 4. Barcode target queries
const r8 = parseQuantitySearch('12*890103001');
assert.deepStrictEqual(
  r8,
  { quantity: 12, query: '890103001' },
  'parses barcode target 12*890103001',
);

// 5. Trailing asterisk with empty product query keeps grid unfiltered mid-keystroke
assert.deepStrictEqual(
  parseQuantitySearch('3*'),
  { quantity: 3, query: '' },
  'trailing asterisk 3* returns quantity 3 with empty query',
);
assert.deepStrictEqual(
  parseQuantitySearch('3*   '),
  { quantity: 3, query: '' },
  'trailing asterisk with whitespace returns quantity 3 with empty query',
);

// 6. Negative and invalid inputs should return null
assert.strictEqual(parseQuantitySearch('latte'), null, 'normal search query returns null');
assert.strictEqual(parseQuantitySearch('latte*3'), null, 'inverted syntax returns null');
assert.strictEqual(parseQuantitySearch('0*item'), null, 'zero quantity returns null');
assert.strictEqual(parseQuantitySearch('0*'), null, 'zero quantity trailing asterisk returns null');
assert.strictEqual(parseQuantitySearch('-5*item'), null, 'negative quantity returns null');
assert.strictEqual(parseQuantitySearch('3x'), null, 'empty target query with x returns null');
assert.strictEqual(parseQuantitySearch('   '), null, 'blank input returns null');
assert.strictEqual(parseQuantitySearch('abc*def'), null, 'non-numeric prefix returns null');

console.log('✓ All parseQuantitySearch tests passed.');

console.log('Testing isTypingTarget guard...');

// Simulate HTMLElement-like objects to test isTypingTarget
const fakeInput = {
  tagName: 'INPUT',
  isContentEditable: false,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(isTypingTarget(fakeInput), true, 'INPUT element is typing target');

const fakeTextarea = {
  tagName: 'TEXTAREA',
  isContentEditable: false,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(isTypingTarget(fakeTextarea), true, 'TEXTAREA element is typing target');

const fakeSelect = {
  tagName: 'SELECT',
  isContentEditable: false,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(isTypingTarget(fakeSelect), true, 'SELECT element is typing target');

const fakeContentEditable = {
  tagName: 'DIV',
  isContentEditable: true,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(
  isTypingTarget(fakeContentEditable),
  true,
  'contentEditable element is typing target',
);

const fakeTextboxRole = {
  tagName: 'DIV',
  isContentEditable: false,
  getAttribute: (attr: string) => (attr === 'role' ? 'textbox' : null),
} as unknown as HTMLElement;
assert.strictEqual(
  isTypingTarget(fakeTextboxRole),
  true,
  'role="textbox" element is typing target',
);

const fakeButton = {
  tagName: 'BUTTON',
  isContentEditable: false,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(isTypingTarget(fakeButton), false, 'BUTTON element is NOT typing target');

const fakeDiv = {
  tagName: 'DIV',
  isContentEditable: false,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(isTypingTarget(fakeDiv), false, 'DIV element is NOT typing target');

const fakeBody = {
  tagName: 'BODY',
  isContentEditable: false,
  getAttribute: () => null,
} as unknown as HTMLElement;
assert.strictEqual(isTypingTarget(fakeBody), false, 'BODY element is NOT typing target');

assert.strictEqual(isTypingTarget(null), false, 'null target returns false');

console.log('✓ All isTypingTarget tests passed.');

console.log('Testing usePosKeyboardShortcuts keydown behavior...');

{
  class FakeHTMLElement {
    tagName: string;
    isContentEditable: boolean;
    role: string | null;
    constructor(tagName = 'DIV', role: string | null = null, isContentEditable = false) {
      this.tagName = tagName;
      this.role = role;
      this.isContentEditable = isContentEditable;
    }
    getAttribute(attr: string) {
      return attr === 'role' ? this.role : null;
    }
    matches(selector: string) {
      const upper = this.tagName.toUpperCase();
      if (selector.includes('button') && upper === 'BUTTON') return true;
      if (selector.includes('[role="button"]') && this.role === 'button') return true;
      return false;
    }
  }

  let keydownListener: ((e: KeyboardEvent) => void) | null = null;
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;
  const moduleApi = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleApi._load;

  (globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') keydownListener = fn;
    },
    removeEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === 'keydown' && keydownListener === fn) keydownListener = null;
    },
  };

  const cleanups: Array<() => void> = [];
  moduleApi._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'react') {
      return {
        useRef: <T>(initial: T) => ({ current: initial }),
        useEffect: (fn: () => void | (() => void)) => {
          const cleanup = fn();
          if (typeof cleanup === 'function') cleanups.push(cleanup);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // Re-require hook module so it binds to our mocked react hooks
    delete require.cache[require.resolve('../frontend/src/hooks/usePosKeyboardShortcuts')];
    const { usePosKeyboardShortcuts: runHook } =
      require('../frontend/src/hooks/usePosKeyboardShortcuts') as {
        usePosKeyboardShortcuts: typeof usePosKeyboardShortcuts;
      };

    let tenderCalls = 0;
    let incrementCalls = 0;
    let decrementCalls = 0;
    let focusSearchCalls = 0;

    const handlers: PosKeyboardShortcutHandlers = {
      onFocusSearch: () => {
        focusSearchCalls += 1;
      },
      onTender: () => {
        tenderCalls += 1;
      },
      onDismissModalOrBlur: () => false,
      onIncrementLastItem: () => {
        incrementCalls += 1;
      },
      onDecrementLastItem: () => {
        decrementCalls += 1;
      },
    };

    const options: UsePosKeyboardShortcutsOptions = {
      enabled: true,
      anyModalOpen: false,
      tablePickerOpen: false,
      cartItemCount: 2,
    };

    runHook(handlers, options);
    assert.ok(keydownListener, 'keydown listener should be registered on window');

    const dispatchKey = (overrides: Partial<KeyboardEvent> & { target?: unknown }) => {
      let defaultPrevented = false;
      const event = {
        key: '',
        code: '',
        repeat: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: new FakeHTMLElement('DIV'),
        preventDefault: () => {
          defaultPrevented = true;
        },
        ...overrides,
      } as unknown as KeyboardEvent;
      keydownListener!(event);
      return { defaultPrevented };
    };

    // 1. Repeat Space on canvas does NOT call onTender, but still prevents default
    const repeatSpace = dispatchKey({ key: ' ', code: 'Space', repeat: true });
    assert.strictEqual(
      repeatSpace.defaultPrevented,
      true,
      'repeat Space on canvas prevents default',
    );
    assert.strictEqual(tenderCalls, 0, 'repeat Space on canvas must NOT call onTender');

    // 2. Deliberate non-repeat Space calls onTender
    const deliberateSpace = dispatchKey({ key: ' ', code: 'Space', repeat: false });
    assert.strictEqual(
      deliberateSpace.defaultPrevented,
      true,
      'deliberate Space on canvas prevents default',
    );
    assert.strictEqual(tenderCalls, 1, 'deliberate non-repeat Space calls onTender once');

    // 3. Space on a button or [role="button"] does not call onTender or prevent default
    const buttonSpace = dispatchKey({
      key: ' ',
      code: 'Space',
      repeat: false,
      target: new FakeHTMLElement('BUTTON'),
    });
    assert.strictEqual(
      buttonSpace.defaultPrevented,
      false,
      'Space on button does not preventDefault',
    );
    assert.strictEqual(tenderCalls, 1, 'Space on button does not call onTender');

    // 4. Typing immunity: Space, +, - inside an INPUT do not trigger canvas shortcuts
    const inputTarget = new FakeHTMLElement('INPUT');
    const inputSpace = dispatchKey({ key: ' ', code: 'Space', repeat: false, target: inputTarget });
    assert.strictEqual(
      inputSpace.defaultPrevented,
      false,
      'Space in INPUT does not preventDefault',
    );
    assert.strictEqual(tenderCalls, 1, 'Space in INPUT does not call onTender');

    dispatchKey({ key: '+', code: 'Equal', repeat: false, target: inputTarget });
    dispatchKey({ key: '-', code: 'Minus', repeat: false, target: inputTarget });
    assert.strictEqual(incrementCalls, 0, '+ in INPUT does not increment');
    assert.strictEqual(decrementCalls, 0, '- in INPUT does not decrement');

    // 5. +/- quantity adjustments continue to work on both initial and repeat keydown
    dispatchKey({ key: '+', code: 'Equal', repeat: false });
    dispatchKey({ key: '+', code: 'Equal', repeat: true });
    assert.strictEqual(incrementCalls, 2, '+ works on both initial and repeat keydown');

    dispatchKey({ key: '-', code: 'Minus', repeat: false });
    dispatchKey({ key: '-', code: 'Minus', repeat: true });
    assert.strictEqual(decrementCalls, 2, '- works on both initial and repeat keydown');

    void focusSearchCalls;
  } finally {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    moduleApi._load = originalLoad;
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).HTMLElement = originalHTMLElement;
  }
}

console.log('✓ All usePosKeyboardShortcuts keydown tests passed.');

console.log('Testing ProductGrid search Enter IME composition guard...');

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const moduleApi = require('node:module') as {
  _resolveFilename: (...args: unknown[]) => string;
  _load: (...args: unknown[]) => unknown;
};
const originalResolveFilename = moduleApi._resolveFilename;
const originalLoad = moduleApi._load;

try {
  moduleApi._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
  ) {
    const resolvedRequest =
      request === '@countries'
        ? path.resolve(ROOT, 'main/countries.ts')
        : request.startsWith('@/')
          ? path.resolve(ROOT, 'frontend/src', request.slice(2))
          : request;
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };

  const React = require(path.join(ROOT, 'frontend/node_modules/react'));
  const mocks: Record<string, unknown> = {
    react: {
      ...React,
      useRef: (initial: unknown) => ({ current: initial }),
      useEffect: () => undefined,
      useMemo: (fn: () => unknown) => fn(),
    },
    'lucide-react': {
      Search: () => null,
      SlidersHorizontal: () => null,
    },
    'react-hot-toast': {
      __esModule: true,
      default: { error: () => undefined },
    },
    'use-intl': {
      useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
    },
    '@/store/cart': {
      useCartStore: () => ({ items: [] }),
    },
    '@/store/pos-settings': {
      usePosSettingsStore: () => ({ showProductImages: false }),
    },
    '@/hooks/useFormatCurrency': {
      useFormatCurrency: () => (amount: number) => String(amount),
    },
    '@/lib/api': {
      __esModule: true,
      default: { defaults: { baseURL: 'http://localhost:3001/api' } },
    },
  };

  moduleApi._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  const ProductGrid = require('../frontend/src/components/pos/ProductGrid').default;

  function findByTestId(node: unknown, testId: string): { props: Record<string, unknown> } | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findByTestId(child, testId);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    const el = node as { props?: Record<string, unknown> };
    if (el.props?.['data-testid'] === testId) return el as { props: Record<string, unknown> };
    if (el.props?.children) return findByTestId(el.props.children, testId);
    return null;
  }

  const coffeeProduct = {
    id: 'prod-coffee',
    name: 'Coffee',
    price: 3.5,
    category_id: 'cat-drinks',
    is_active: true,
    variants: [],
    addon_groups: [],
  };

  const addedProducts: Array<{ product: unknown; quantity: number }> = [];
  const searchUpdates: string[] = [];

  const tree = ProductGrid({
    categories: [],
    products: [coffeeProduct],
    selectedCategory: null,
    setSelectedCategory: () => undefined,
    search: 'Coffee',
    setSearch: (s: string) => searchUpdates.push(s),
    currency: 'USD',
    onProductClick: (product: unknown, quantity: number) =>
      addedProducts.push({ product, quantity }),
    onScannedVariant: () => undefined,
    onScaledProduct: () => undefined,
  });

  const searchInput = findByTestId(tree, 'pos-product-search');
  assert.ok(searchInput, 'renders pos-product-search input');
  const onKeyDown = searchInput.props.onKeyDown as (e: Record<string, unknown>) => void;
  assert.strictEqual(typeof onKeyDown, 'function', 'search input has onKeyDown handler');

  // 1. IME composition confirmation via nativeEvent.isComposing + keyCode 229
  onKeyDown({
    key: 'Enter',
    keyCode: 229,
    nativeEvent: { isComposing: true },
  });
  assert.strictEqual(
    addedProducts.length,
    0,
    'Enter with nativeEvent.isComposing=true and keyCode=229 must not add product to cart',
  );
  assert.strictEqual(searchUpdates.length, 0, 'IME Enter must not clear search input');

  // 2. IME composition confirmation via e.isComposing
  onKeyDown({
    key: 'Enter',
    keyCode: 13,
    isComposing: true,
    nativeEvent: { isComposing: false },
  });
  assert.strictEqual(
    addedProducts.length,
    0,
    'Enter with e.isComposing=true must not add product to cart',
  );

  // 3. IME composition confirmation via keyCode 229 fallback
  onKeyDown({
    key: 'Enter',
    keyCode: 229,
    nativeEvent: { isComposing: false },
  });
  assert.strictEqual(
    addedProducts.length,
    0,
    'Enter with keyCode=229 must not add product to cart',
  );

  // 4. Non-composing Enter still adds matched product to cart
  onKeyDown({
    key: 'Enter',
    keyCode: 13,
    nativeEvent: { isComposing: false },
  });
  assert.deepStrictEqual(
    addedProducts,
    [{ product: coffeeProduct, quantity: 1 }],
    'non-composing Enter adds matched product to cart',
  );
  assert.deepStrictEqual(searchUpdates, [''], 'non-composing Enter clears search input');
  // 5. Trailing asterisk "3*" keeps product card visible and does not add on premature Enter
  addedProducts.length = 0;
  searchUpdates.length = 0;
  const starTree = ProductGrid({
    categories: [],
    products: [coffeeProduct],
    selectedCategory: null,
    setSelectedCategory: () => undefined,
    search: '3*',
    setSearch: (s: string) => searchUpdates.push(s),
    currency: 'USD',
    onProductClick: (product: unknown, quantity: number) =>
      addedProducts.push({ product, quantity }),
    onScannedVariant: () => undefined,
    onScaledProduct: () => undefined,
  });
  const starCard = findByTestId(starTree, 'pos-product-card');
  assert.ok(starCard, 'product grid remains visible when search is "3*"');
  const starInput = findByTestId(starTree, 'pos-product-search');
  assert.ok(starInput, 'renders search input for "3*"');
  (starInput.props.onKeyDown as (e: Record<string, unknown>) => void)({
    key: 'Enter',
    keyCode: 13,
    nativeEvent: { isComposing: false },
  });
  assert.strictEqual(
    addedProducts.length,
    0,
    'Enter on incomplete "3*" does not prematurely add a product',
  );
  (starCard.props.onClick as () => void)();
  assert.deepStrictEqual(
    addedProducts,
    [{ product: coffeeProduct, quantity: 3 }],
    'clicking a product card while search is "3*" adds quantity 3',
  );
} finally {
  moduleApi._load = originalLoad;
  moduleApi._resolveFilename = originalResolveFilename;
}

console.log('✓ All ProductGrid search Enter IME composition tests passed.');

console.log('Testing usePosKeyboardShortcuts modifier and physical key guards...');

// Minimal React hook + window harness to exercise usePosKeyboardShortcuts directly in Node
// eslint-disable-next-line @typescript-eslint/no-require-imports
const reactModule = require('../frontend/node_modules/react') as {
  useRef: typeof import('react').useRef;
  useEffect: typeof import('react').useEffect;
};
const origUseRef = reactModule.useRef;
const origUseEffect = reactModule.useEffect;
const origWindow = (globalThis as Record<string, unknown>).window;
const origHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;

class StubHTMLElement {
  tagName = 'DIV';
  isContentEditable = false;
  getAttribute(): string | null {
    return null;
  }
  matches(): boolean {
    return false;
  }
}

function createShortcutHarness(optionsOverrides: Partial<UsePosKeyboardShortcutsOptions> = {}) {
  let keydownListener: ((e: KeyboardEvent) => void) | null = null;
  const calls: Record<string, number> = {
    focusSearch: 0,
    tender: 0,
    toggleTables: 0,
    openCheckout: 0,
    openCashMovement: 0,
    focusCustomer: 0,
    holdOrder: 0,
    toggleFullscreen: 0,
    dismissModalOrBlur: 0,
    incrementLastItem: 0,
    decrementLastItem: 0,
    clearCart: 0,
    showHelp: 0,
  };

  const handlers: PosKeyboardShortcutHandlers = {
    onFocusSearch: () => {
      calls.focusSearch += 1;
    },
    onTender: () => {
      calls.tender += 1;
    },
    onToggleTables: () => {
      calls.toggleTables += 1;
    },
    onOpenCheckout: () => {
      calls.openCheckout += 1;
    },
    onOpenCashMovement: () => {
      calls.openCashMovement += 1;
    },
    onFocusCustomer: () => {
      calls.focusCustomer += 1;
    },
    onHoldOrder: () => {
      calls.holdOrder += 1;
    },
    onToggleFullscreen: () => {
      calls.toggleFullscreen += 1;
    },
    onDismissModalOrBlur: () => {
      calls.dismissModalOrBlur += 1;
      return true;
    },
    onIncrementLastItem: () => {
      calls.incrementLastItem += 1;
    },
    onDecrementLastItem: () => {
      calls.decrementLastItem += 1;
    },
    onClearCart: () => {
      calls.clearCart += 1;
    },
    onShowHelp: () => {
      calls.showHelp += 1;
    },
  };

  (globalThis as Record<string, unknown>).HTMLElement = StubHTMLElement;
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') keydownListener = fn;
    },
    removeEventListener: () => {
      keydownListener = null;
    },
  };
  reactModule.useRef = ((init: unknown) => ({ current: init })) as typeof reactModule.useRef;
  reactModule.useEffect = ((effect: () => void | (() => void)) => {
    effect();
  }) as typeof reactModule.useEffect;

  usePosKeyboardShortcuts(handlers, {
    enabled: true,
    anyModalOpen: false,
    tablePickerOpen: false,
    cartItemCount: 2,
    ...optionsOverrides,
  });

  const dispatch = (init: Partial<KeyboardEvent>) => {
    assert.ok(keydownListener, 'keydown listener should be registered');
    let defaultPrevented = false;
    const event = {
      key: '',
      code: '',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: new StubHTMLElement(),
      preventDefault: () => {
        defaultPrevented = true;
      },
      ...init,
    } as unknown as KeyboardEvent;
    keydownListener(event);
    return { defaultPrevented };
  };

  return { calls, dispatch };
}

try {
  // (a) Ctrl+- / Meta+- / Alt+- (and +/= equivalents) must not decrement/increment cart items
  {
    const { calls, dispatch } = createShortcutHarness();

    const plainMinus = dispatch({ key: '-', code: 'Minus' });
    assert.strictEqual(calls.decrementLastItem, 1, 'plain Minus decrements last cart item');
    assert.strictEqual(plainMinus.defaultPrevented, true, 'plain Minus prevents default');

    const ctrlMinus = dispatch({ key: '-', code: 'Minus', ctrlKey: true });
    assert.strictEqual(calls.decrementLastItem, 1, 'Ctrl+Minus must not decrement cart item');
    assert.strictEqual(
      ctrlMinus.defaultPrevented,
      false,
      'Ctrl+Minus must not prevent browser zoom',
    );

    const metaMinus = dispatch({ key: '-', code: 'Minus', metaKey: true });
    assert.strictEqual(calls.decrementLastItem, 1, 'Meta+Minus must not decrement cart item');
    assert.strictEqual(
      metaMinus.defaultPrevented,
      false,
      'Meta+Minus must not prevent browser zoom',
    );

    const altMinus = dispatch({ key: '–', code: 'Minus', altKey: true });
    assert.strictEqual(
      calls.decrementLastItem,
      1,
      'Alt+Minus (Option+-) must not decrement cart item',
    );
    assert.strictEqual(altMinus.defaultPrevented, false, 'Alt+Minus must not prevent default');

    const ctrlPlus = dispatch({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true });
    const metaEqual = dispatch({ key: '=', code: 'Equal', metaKey: true });
    const altEqual = dispatch({ key: '≠', code: 'Equal', altKey: true });
    assert.strictEqual(
      calls.incrementLastItem,
      0,
      'Ctrl/Meta/Alt + Equal/Plus must not increment cart item',
    );
    assert.strictEqual(ctrlPlus.defaultPrevented, false);
    assert.strictEqual(metaEqual.defaultPrevented, false);
    assert.strictEqual(altEqual.defaultPrevented, false);
  }

  // (b) Alt/Option combinations use physical Digit codes and modifier guards without misfiring
  {
    const { calls, dispatch } = createShortcutHarness();

    // Standard Alt+2 / Alt+4 and macOS Option+2 (key='™') / Option+4 (key='¢') with physical Digit2/Digit4
    const alt2 = dispatch({ key: '2', code: 'Digit2', altKey: true });
    assert.strictEqual(calls.toggleTables, 1, 'Alt+Digit2 (key="2") triggers onToggleTables');
    assert.strictEqual(alt2.defaultPrevented, true);

    const option2 = dispatch({ key: '™', code: 'Digit2', altKey: true });
    assert.strictEqual(calls.toggleTables, 2, 'Option+Digit2 (key="™") triggers onToggleTables');
    assert.strictEqual(option2.defaultPrevented, true);

    const alt4 = dispatch({ key: '4', code: 'Digit4', altKey: true });
    assert.strictEqual(calls.openCheckout, 1, 'Alt+Digit4 (key="4") triggers onOpenCheckout');
    assert.strictEqual(alt4.defaultPrevented, true);

    const option4 = dispatch({ key: '¢', code: 'Digit4', altKey: true });
    assert.strictEqual(calls.openCheckout, 2, 'Option+Digit4 (key="¢") triggers onOpenCheckout');
    assert.strictEqual(option4.defaultPrevented, true);

    // Option+Digit combinations on other keys or with extra modifiers must not misfire or prevent default
    for (const ignoredCombo of [
      { key: '€', code: 'Digit2', altKey: true, shiftKey: true },
      { key: '2', code: 'Digit2', altKey: true, ctrlKey: true },
      { key: '2', code: 'Digit2', altKey: true, metaKey: true },
      { key: '4', code: 'Digit4', altKey: true, shiftKey: true },
      { key: '4', code: 'Digit4', altKey: true, ctrlKey: true },
      { key: '4', code: 'Digit4', altKey: true, metaKey: true },
      { key: '2', code: 'KeyQ', altKey: true },
      { key: '4', code: 'KeyE', altKey: true },
      { key: '-', code: 'Digit6', altKey: true },
      { key: '+', code: 'Digit1', altKey: true },
      { key: '/', code: 'Digit7', altKey: true, shiftKey: true },
      { key: '?', code: 'Slash', altKey: true, shiftKey: true },
      { key: 'F4', code: 'F4', altKey: true },
      { key: ' ', code: 'Space', ctrlKey: true },
      { key: ' ', code: 'Space', metaKey: true },
      { key: ' ', code: 'Space', altKey: true },
    ]) {
      const res = dispatch(ignoredCombo);
      assert.strictEqual(
        res.defaultPrevented,
        false,
        `rejected combo ${JSON.stringify(ignoredCombo)} must not prevent default`,
      );
    }

    assert.strictEqual(
      calls.toggleTables,
      2,
      'modified/non-Digit2 Alt combos do not misfire toggleTables',
    );
    assert.strictEqual(
      calls.openCheckout,
      2,
      'Alt+F4 or non-Digit4 combos do not misfire openCheckout',
    );
    assert.strictEqual(
      calls.decrementLastItem,
      0,
      'Option+Digit emitting "-" does not decrement cart',
    );
    assert.strictEqual(
      calls.incrementLastItem,
      0,
      'Option+Digit emitting "+" does not increment cart',
    );
    assert.strictEqual(calls.focusSearch, 0, 'Option+Digit emitting "/" does not focus search');
    assert.strictEqual(calls.showHelp, 0, 'Option+Slash emitting "?" does not open help');
    assert.strictEqual(calls.tender, 0, 'Ctrl/Meta/Alt+Space does not tender order');
  }

  // Verify tablePickerOpen closes on macOS Option+Digit2 and F2, while modified F2 does not
  {
    const { calls, dispatch } = createShortcutHarness({
      anyModalOpen: true,
      tablePickerOpen: true,
    });
    const option2Close = dispatch({ key: '™', code: 'Digit2', altKey: true });
    assert.strictEqual(calls.toggleTables, 1, 'Option+Digit2 closes open table picker');
    assert.strictEqual(option2Close.defaultPrevented, true);

    const f2Close = dispatch({ key: 'F2', code: 'F2' });
    assert.strictEqual(calls.toggleTables, 2, 'plain F2 closes open table picker');
    assert.strictEqual(f2Close.defaultPrevented, true);

    for (const mod of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      const res = dispatch({ key: 'F2', code: 'F2', ...mod });
      assert.strictEqual(
        calls.toggleTables,
        2,
        `modified F2 (${JSON.stringify(mod)}) must not toggle open table picker`,
      );
      assert.strictEqual(
        res.defaultPrevented,
        false,
        `modified F2 (${JSON.stringify(mod)}) must not prevent default when table picker is open`,
      );
    }
  }

  // Table-driven tests for Escape, F1, F11, F2, F3, F4, F6, F8, Space, ?, /, and Alt+Backspace:
  // (1) plain shortcut invokes expected handler and sets defaultPrevented = true
  // (2) unsupported Ctrl, Meta, Alt, and Shift combinations do not trigger POS actions and leave defaultPrevented = false
  {
    type CallKey =
      | 'dismissModalOrBlur'
      | 'showHelp'
      | 'toggleFullscreen'
      | 'toggleTables'
      | 'openCashMovement'
      | 'openCheckout'
      | 'focusCustomer'
      | 'holdOrder'
      | 'tender'
      | 'focusSearch'
      | 'clearCart';

    interface ShortcutCase {
      label: string;
      plainInit: Partial<KeyboardEvent>;
      expectedCall: CallKey;
      rejectedModifiers: Array<{ name: string; init: Partial<KeyboardEvent> }>;
    }

    const allFourModifiers: Array<{ name: string; init: Partial<KeyboardEvent> }> = [
      { name: 'Ctrl', init: { ctrlKey: true } },
      { name: 'Meta', init: { metaKey: true } },
      { name: 'Alt', init: { altKey: true } },
      { name: 'Shift', init: { shiftKey: true } },
      { name: 'Ctrl+Shift', init: { ctrlKey: true, shiftKey: true } },
      { name: 'Meta+Alt', init: { metaKey: true, altKey: true } },
    ];

    const shortcutTable: ShortcutCase[] = [
      {
        label: 'Escape',
        plainInit: { key: 'Escape', code: 'Escape' },
        expectedCall: 'dismissModalOrBlur',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F1',
        plainInit: { key: 'F1', code: 'F1' },
        expectedCall: 'showHelp',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F11',
        plainInit: { key: 'F11', code: 'F11' },
        expectedCall: 'toggleFullscreen',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F2',
        plainInit: { key: 'F2', code: 'F2' },
        expectedCall: 'toggleTables',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F3',
        plainInit: { key: 'F3', code: 'F3' },
        expectedCall: 'openCashMovement',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F4',
        plainInit: { key: 'F4', code: 'F4' },
        expectedCall: 'openCheckout',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F6',
        plainInit: { key: 'F6', code: 'F6' },
        expectedCall: 'focusCustomer',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'F8',
        plainInit: { key: 'F8', code: 'F8' },
        expectedCall: 'holdOrder',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: 'Space',
        plainInit: { key: ' ', code: 'Space' },
        expectedCall: 'tender',
        rejectedModifiers: allFourModifiers,
      },
      {
        label: '? (Shift+Slash)',
        plainInit: { key: '?', code: 'Slash', shiftKey: true },
        expectedCall: 'showHelp',
        rejectedModifiers: [
          { name: 'Ctrl', init: { ctrlKey: true, shiftKey: true } },
          { name: 'Meta', init: { metaKey: true, shiftKey: true } },
          { name: 'Alt', init: { altKey: true, shiftKey: true } },
        ],
      },
      {
        label: '/',
        plainInit: { key: '/', code: 'Slash' },
        expectedCall: 'focusSearch',
        rejectedModifiers: [
          { name: 'Ctrl', init: { ctrlKey: true } },
          { name: 'Meta', init: { metaKey: true } },
          { name: 'Alt', init: { altKey: true } },
        ],
      },
      {
        label: 'Alt+Backspace',
        plainInit: { key: 'Backspace', code: 'Backspace', altKey: true },
        expectedCall: 'clearCart',
        rejectedModifiers: [
          { name: 'Plain (no Alt)', init: { altKey: false } },
          { name: 'Alt+Ctrl', init: { altKey: true, ctrlKey: true } },
          { name: 'Alt+Meta', init: { altKey: true, metaKey: true } },
          { name: 'Alt+Shift', init: { altKey: true, shiftKey: true } },
        ],
      },
    ];

    for (const testCase of shortcutTable) {
      const { calls, dispatch } = createShortcutHarness();

      // 1. Plain (or expected chord) shortcut works and prevents default
      const plainRes = dispatch(testCase.plainInit);
      assert.strictEqual(
        calls[testCase.expectedCall],
        1,
        `${testCase.label}: expected ${testCase.expectedCall} to be called once`,
      );
      assert.strictEqual(
        plainRes.defaultPrevented,
        true,
        `${testCase.label}: expected defaultPrevented to be true`,
      );
      const totalCallsAfterPlain = Object.values(calls).reduce((sum, n) => sum + n, 0);
      assert.strictEqual(
        totalCallsAfterPlain,
        1,
        `${testCase.label}: expected no other handlers to be called`,
      );

      // 2. Unsupported modifier combinations do not fire any handler and do not prevent default
      for (const mod of testCase.rejectedModifiers) {
        const modRes = dispatch({ ...testCase.plainInit, ...mod.init });
        const totalCallsAfterMod = Object.values(calls).reduce((sum, n) => sum + n, 0);
        assert.strictEqual(
          totalCallsAfterMod,
          1,
          `${testCase.label} with ${mod.name}: must not trigger any POS handler`,
        );
        assert.strictEqual(
          modRes.defaultPrevented,
          false,
          `${testCase.label} with ${mod.name}: must not prevent default browser/OS shortcut`,
        );
      }
    }
  }
} finally {
  reactModule.useRef = origUseRef;
  reactModule.useEffect = origUseEffect;
  if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = origWindow;
  if (origHTMLElement === undefined) delete (globalThis as Record<string, unknown>).HTMLElement;
  else (globalThis as Record<string, unknown>).HTMLElement = origHTMLElement;
}

console.log('✓ All modifier and physical key guard tests passed.');

console.log(
  'Testing CreateCustomerModal, EditCustomerModal, CustomerSearch, AddonModal, and PrepaidCheckoutModal...',
);

{
  // Runtime behavioral checks for CreateCustomerModal, EditCustomerModal, CustomerSearch, AddonModal, and PrepaidCheckoutModal
  const modalListeners = new Set<(e: Record<string, unknown>) => void>();
  const prevWin = (globalThis as Record<string, unknown>).window;
  const prevDoc = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).window = {
    location: { href: 'http://localhost:3000', origin: 'http://localhost:3000' },
    addEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      if (type === 'keydown') modalListeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      if (type === 'keydown') modalListeners.delete(fn);
    },
  };
  (globalThis as Record<string, unknown>).document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  const toastErrors: string[] = [];
  const ReactRuntime = require(path.join(ROOT, 'frontend/node_modules/react'));
  let stateSlots: unknown[] = [];
  let stateOverrides: Record<number, unknown> = {};
  let stateCallIdx = 0;
  const resetState = (overrides: Record<number, unknown> = {}) => {
    stateSlots = [];
    stateOverrides = overrides;
    stateCallIdx = 0;
  };

  const cartState: {
    customer: Record<string, unknown> | null;
    customerId: string | null;
    items: Array<Record<string, unknown>>;
    orderType: string;
    onlinePlatform: string | null;
    waivedChargeIds: Set<number>;
    optedInChargeIds: Set<number>;
    itemCount: () => number;
    setCustomer: (c: Record<string, unknown> | null) => void;
  } = {
    customer: null,
    customerId: null,
    items: [{ id: 'item-1', price: 100, quantity: 1 }],
    orderType: 'dine_in',
    onlinePlatform: null,
    waivedChargeIds: new Set(),
    optedInChargeIds: new Set(),
    itemCount: () => cartState.items.length,
    setCustomer: (c) => {
      cartState.customer = c;
      cartState.customerId = (c?.id as string | undefined) ?? null;
    },
  };

  try {
    moduleApi._resolveFilename = function (
      request: string,
      parent: unknown,
      isMain: boolean,
      options?: unknown,
    ) {
      const resolvedRequest =
        request === '@countries'
          ? path.resolve(ROOT, 'main/countries.ts')
          : request.startsWith('@/')
            ? path.resolve(ROOT, 'frontend/src', request.slice(2))
            : request;
      return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
    };

    const runtimeMocks: Record<string, unknown> = {
      react: {
        ...ReactRuntime,
        useState: (init: unknown) => {
          const idx = stateCallIdx++;
          if (idx >= stateSlots.length) {
            stateSlots[idx] =
              idx in stateOverrides
                ? stateOverrides[idx]
                : typeof init === 'function'
                  ? (init as () => unknown)()
                  : init;
          }
          const setState = (next: unknown) => {
            stateSlots[idx] =
              typeof next === 'function'
                ? (next as (prev: unknown) => unknown)(stateSlots[idx])
                : next;
          };
          return [stateSlots[idx], setState];
        },
        useEffect: (fn: () => void | (() => void)) => {
          fn();
        },
        useRef: (init: unknown) => ({ current: init }),
        useMemo: (fn: () => unknown) => fn(),
      },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      'react-hot-toast': {
        __esModule: true,
        default: {
          error: (msg: string) => toastErrors.push(msg),
          success: () => undefined,
        },
      },
      'use-intl': {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) =>
          params ? `${ns}.${key}:${JSON.stringify(params)}` : `${ns}.${key}`,
      },
      '@/store/auth': {
        useAuthStore: (selector?: (s: Record<string, unknown>) => unknown) => {
          const state = { currentTenant: { country: 'IN', currency: 'INR' } };
          return selector ? selector(state) : state;
        },
      },
      '@/store/cart': {
        useCartStore: (selector?: (s: typeof cartState) => unknown) =>
          selector ? selector(cartState) : cartState,
      },
      '@/store/charges': {
        chargesForOrderType: () => [],
        useChargesStore: (selector?: (s: Record<string, unknown>) => unknown) => {
          const state = { charges: [], load: async () => undefined };
          return selector ? selector(state) : state;
        },
      },
      '@/components/layout/Ltr': {
        Ltr: ({ children }: { children: unknown }) => children,
      },
      '@/components/ui/button': {
        Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
      },
      '@/components/pos/TaxBreakdown': {
        __esModule: true,
        default: () => null,
      },
      '@/components/pos/TouchNumberPad': {
        CurrencyTouchNumberPad: () => null,
      },
      '@/components/ApproverSelect': {
        ApproverSelect: () => null,
      },
      '@/hooks/useFormatCurrency': {
        useFormatCurrency: () => (n: number) => String(n),
      },
      '@/hooks/useFormatNumber': {
        useFormatNumber: () => (n: number) => String(n),
      },
      '@/hooks/useCurrencyUnitAdapter': {
        useCurrencyUnitAdapter: () => ({
          toDisplay: (n: number) => n,
          toStored: (n: number) => n,
          label: 'INR',
          step: '1',
          maxDecimals: 2,
          formatInput: (n: number) => String(n),
        }),
      },
      '@/hooks/use-tax-preview': {
        useTaxPreview: () => ({
          tax: {
            subtotal: 100,
            discount_amount: 0,
            discounted_subtotal: 100,
            tax_amount: 0,
            tax_breakdown: [],
            packaging_charge: 0,
            charges_breakdown: [],
            round_off: 0,
            total: 100,
          },
          loading: false,
        }),
      },
      '@/hooks/useManagerApprovers': {
        useManagerApprovers: () => ({
          approvers: [],
          selectedApproverId: null,
          setSelectedApproverId: () => undefined,
          loading: false,
          loadFailed: false,
        }),
      },
      '@/lib/api': {
        __esModule: true,
        default: {
          get: async () => ({ data: {} }),
          post: async () => ({ data: {} }),
          put: async () => ({ data: {} }),
        },
      },
    };

    moduleApi._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request in runtimeMocks) return runtimeMocks[request];
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[require.resolve('../frontend/src/components/pos/CreateCustomerModal')];
    delete require.cache[require.resolve('../frontend/src/components/pos/EditCustomerModal')];
    delete require.cache[require.resolve('../frontend/src/components/pos/CustomerSearch')];
    delete require.cache[require.resolve('../frontend/src/components/pos/AddonModal')];
    delete require.cache[require.resolve('../frontend/src/components/pos/PrepaidCheckoutModal')];

    const CreateCustomerModal =
      require('../frontend/src/components/pos/CreateCustomerModal').default;
    const EditCustomerModal = require('../frontend/src/components/pos/EditCustomerModal').default;
    const CustomerSearch = require('../frontend/src/components/pos/CustomerSearch').default;
    const AddonModal = require('../frontend/src/components/pos/AddonModal').default;
    const PrepaidCheckoutModal =
      require('../frontend/src/components/pos/PrepaidCheckoutModal').default;

    function findElementByTestId(
      node: unknown,
      testId: string,
    ): { props: Record<string, unknown> } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findElementByTestId(child, testId);
          if (found) return found;
        }
        return null;
      }
      if (!node || typeof node !== 'object') return null;
      const el = node as { props?: Record<string, unknown> };
      if (el.props?.['data-testid'] === testId) return el as { props: Record<string, unknown> };
      if (el.props?.children) return findElementByTestId(el.props.children, testId);
      return null;
    }

    // 1. CreateCustomerModal Escape closes modal when not saving, and ignores Escape while saving
    modalListeners.clear();
    resetState();
    let createClosed = 0;
    CreateCustomerModal({
      initialSearch: 'Alice',
      onClose: () => {
        createClosed += 1;
      },
      onCreated: () => undefined,
    });
    assert.strictEqual(modalListeners.size, 1, 'CreateCustomerModal registers keydown listener');
    let escPrevented = false;
    for (const fn of modalListeners) {
      fn({
        key: 'Escape',
        preventDefault: () => {
          escPrevented = true;
        },
      });
    }
    assert.strictEqual(createClosed, 1, 'Escape closes CreateCustomerModal when not saving');
    assert.strictEqual(escPrevented, true, 'Escape prevents default in CreateCustomerModal');

    modalListeners.clear();
    resetState({ 3: true });
    CreateCustomerModal({
      initialSearch: 'Alice',
      onClose: () => {
        createClosed += 1;
      },
      onCreated: () => undefined,
    });
    for (const fn of modalListeners) {
      fn({ key: 'Escape', preventDefault: () => undefined });
    }
    assert.strictEqual(createClosed, 1, 'Escape does not close CreateCustomerModal while saving');

    // 2. EditCustomerModal Escape closes modal & invalidPhone uses countryName('IN') -> 'India'
    modalListeners.clear();
    resetState();
    let editClosed = 0;
    const editTree = EditCustomerModal({
      customer: {
        id: 'cust-1',
        name: 'Bob',
        phone: '123',
        email: null,
        visits_count: 1,
        total_spent: 10,
        last_visit_at: null,
        country_code: 'IN',
      },
      onClose: () => {
        editClosed += 1;
      },
      onSaved: () => undefined,
    });
    for (const fn of modalListeners) {
      fn({ key: 'Escape', preventDefault: () => undefined });
    }
    assert.strictEqual(editClosed, 1, 'Escape closes EditCustomerModal when not saving');

    // Trigger Save button on EditCustomerModal with invalid phone '123' for country 'IN'
    function findButtons(node: unknown, out: Array<{ props: Record<string, unknown> }> = []) {
      if (Array.isArray(node)) {
        for (const c of node) findButtons(c, out);
        return out;
      }
      if (!node || typeof node !== 'object') return out;
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (el.type === 'button' || typeof el.type === 'function') {
        out.push(el as { props: Record<string, unknown> });
      }
      if (el.props?.children) findButtons(el.props.children, out);
      return out;
    }
    const editButtons = findButtons(editTree);
    const saveBtn = editButtons.find((b) => b.props.children === 'common.save');
    assert.ok(saveBtn, 'EditCustomerModal renders Save button');
    toastErrors.length = 0;
    void (saveBtn.props.onClick as () => Promise<void>)();
    assert.strictEqual(
      toastErrors[0],
      'pos.invalidPhone:{"country":"India"}',
      'EditCustomerModal passes resolved country name ("India") instead of raw ISO code ("IN")',
    );

    // 3. CustomerSearch exposes search/select testids and notifies onModalOpenChange for Create & Edit modals
    cartState.setCustomer(null);
    resetState({ 0: 'Alice', 3: true, 5: true, 6: 0 });
    const modalOpenHistory: boolean[] = [];
    const csSearchTree = CustomerSearch({
      onModalOpenChange: (open: boolean) => modalOpenHistory.push(open),
    });
    const csSearchInput = findElementByTestId(csSearchTree, 'pos-customer-search-input');
    assert.ok(
      csSearchInput,
      'CustomerSearch renders pos-customer-search-input when no customer is selected',
    );
    assert.strictEqual(
      findElementByTestId(csSearchTree, 'pos-customer-select-btn'),
      null,
      'CustomerSearch does not render pos-customer-select-btn when no customer is selected',
    );
    assert.strictEqual(
      modalOpenHistory.at(-1),
      false,
      'CustomerSearch reports modal closed before CreateCustomerModal opens',
    );
    (csSearchInput.props.onKeyDown as (e: Record<string, unknown>) => void)({
      key: 'Enter',
      preventDefault: () => undefined,
    });
    stateCallIdx = 0;
    CustomerSearch({
      onModalOpenChange: (open: boolean) => modalOpenHistory.push(open),
    });
    assert.strictEqual(
      modalOpenHistory.at(-1),
      true,
      'CustomerSearch notifies onModalOpenChange(true) when CreateCustomerModal opens',
    );

    cartState.setCustomer({
      id: 'cust-1',
      name: 'Bob',
      phone: '+919876543210',
      email: null,
      visits_count: 1,
      total_spent: 100,
      last_visit_at: null,
      country_code: 'IN',
    });
    resetState();
    modalOpenHistory.length = 0;
    const csSelectedTree = CustomerSearch({
      variant: 'topbar',
      onModalOpenChange: (open: boolean) => modalOpenHistory.push(open),
    });
    const csSelectBtn = findElementByTestId(csSelectedTree, 'pos-customer-select-btn');
    assert.ok(
      csSelectBtn,
      'CustomerSearch renders pos-customer-select-btn when a customer is selected',
    );
    assert.strictEqual(
      findElementByTestId(csSelectedTree, 'pos-customer-search-input'),
      null,
      'CustomerSearch does not render pos-customer-search-input when a customer is selected',
    );
    assert.strictEqual(
      modalOpenHistory.at(-1),
      false,
      'CustomerSearch reports modal closed before EditCustomerModal opens',
    );
    (csSelectBtn.props.onClick as () => void)();
    stateCallIdx = 0;
    CustomerSearch({
      variant: 'topbar',
      onModalOpenChange: (open: boolean) => modalOpenHistory.push(open),
    });
    assert.strictEqual(
      modalOpenHistory.at(-1),
      true,
      'CustomerSearch notifies onModalOpenChange(true) when EditCustomerModal opens',
    );
    cartState.setCustomer(null);

    // 4. AddonModal disables + buttons when group max_selection is reached
    resetState();
    const addonA = {
      id: 'addon-a',
      addon_group_id: 'grp-1',
      name: 'Syrup A',
      price: 1,
      is_active: true,
    };
    const addonB = {
      id: 'addon-b',
      addon_group_id: 'grp-1',
      name: 'Syrup B',
      price: 1,
      is_active: true,
    };
    const addonTree = AddonModal({
      product: {
        id: 'prod-1',
        name: 'Latte',
        price: 5,
        category_id: 'cat-1',
        is_active: true,
        variants: [],
        addon_groups: [
          {
            id: 'grp-1',
            name: 'Syrups',
            is_required: false,
            min_selection: 0,
            max_selection: 1,
            allow_multiple_quantities: true,
            addons: [addonA, addonB],
          },
        ],
      },
      currency: 'INR',
      initialQuantity: 1,
      initialAddons: [{ ...addonA, quantity: 1 }],
      onAdd: () => undefined,
      onClose: () => undefined,
    });
    const addonButtons = findButtons(addonTree);
    // Both the selected addon's + button and the unselected addon's + button must be disabled at cap
    const disabledPlusButtons = addonButtons.filter((b) => b.props.disabled === true);
    assert.ok(
      disabledPlusButtons.length >= 2,
      'AddonModal disables + buttons for both selected and unselected addons when group max_selection is reached',
    );

    // 5. PrepaidCheckoutModal skips global Space/Enter confirm when a button, select, or interactive control is focused
    modalListeners.clear();
    resetState();
    let prepaidClosed = 0;
    const prepaidConfirms: Array<{
      payments: unknown;
      walletAmount: number;
      discount: unknown;
    }> = [];
    class MockDomNode {}
    const prevNode = (globalThis as Record<string, unknown>).Node;
    (globalThis as Record<string, unknown>).Node = MockDomNode;
    const makeDomTarget = (props: Record<string, unknown>) =>
      Object.assign(new MockDomNode(), props);

    const prepaidTree = PrepaidCheckoutModal({
      currency: 'INR',
      onClose: () => {
        prepaidClosed += 1;
      },
      onConfirm: (payments: unknown, walletAmount: number, discount: unknown) => {
        prepaidConfirms.push({ payments, walletAmount, discount });
      },
    }) as { props?: { ref?: { current: unknown } } };
    if (prepaidTree?.props?.ref) {
      prepaidTree.props.ref.current = {
        contains: (candidate: unknown) => {
          if (!(candidate instanceof MockDomNode)) {
            throw new TypeError(
              "Failed to execute 'contains' on 'Node': parameter 1 is not of type 'Node'.",
            );
          }
          return true;
        },
      };
    }
    assert.strictEqual(modalListeners.size, 1, 'PrepaidCheckoutModal registers keydown listener');

    const dispatchPrepaidKey = (eventInit: Record<string, unknown>) => {
      let defaultPrevented = false;
      for (const fn of modalListeners) {
        fn({
          key: '',
          code: '',
          repeat: false,
          preventDefault: () => {
            defaultPrevented = true;
          },
          ...eventInit,
        });
      }
      return { defaultPrevented };
    };

    const interactiveTargets: Array<{ label: string; target: Record<string, unknown> }> = [
      { label: 'BUTTON', target: makeDomTarget({ tagName: 'BUTTON' }) },
      { label: 'SELECT', target: makeDomTarget({ tagName: 'SELECT' }) },
      { label: 'INPUT', target: makeDomTarget({ tagName: 'INPUT' }) },
      { label: 'A', target: makeDomTarget({ tagName: 'A' }) },
      {
        label: '[role="button"]',
        target: makeDomTarget({
          tagName: 'DIV',
          getAttribute: (attr: string) => (attr === 'role' ? 'button' : null),
        }),
      },
      {
        label: 'child inside button',
        target: makeDomTarget({
          tagName: 'SPAN',
          closest: (selector: string) => (selector.includes('button') ? {} : null),
        }),
      },
    ];

    for (const { label, target } of interactiveTargets) {
      for (const keyInit of [
        { key: ' ', code: 'Space' },
        { key: 'Enter', code: 'Enter' },
      ]) {
        const res = dispatchPrepaidKey({ ...keyInit, target });
        assert.strictEqual(
          res.defaultPrevented,
          false,
          `PrepaidCheckoutModal must not preventDefault on ${keyInit.code} when ${label} is focused`,
        );
        assert.strictEqual(
          prepaidConfirms.length,
          0,
          `PrepaidCheckoutModal must not confirm on ${keyInit.code} when ${label} is focused`,
        );
      }
    }

    const repeatWindowSpace = dispatchPrepaidKey({
      key: ' ',
      code: 'Space',
      repeat: true,
      target: (globalThis as Record<string, unknown>).window,
    });
    assert.strictEqual(
      repeatWindowSpace.defaultPrevented,
      true,
      'PrepaidCheckoutModal prevents default on repeat Space dispatched directly on window (non-Node target)',
    );
    assert.strictEqual(
      prepaidConfirms.length,
      0,
      'PrepaidCheckoutModal does not confirm on repeat Space dispatched on window',
    );

    const repeatSurfaceSpace = dispatchPrepaidKey({
      key: ' ',
      code: 'Space',
      repeat: true,
      target: makeDomTarget({ tagName: 'DIV' }),
    });
    assert.strictEqual(
      repeatSurfaceSpace.defaultPrevented,
      true,
      'PrepaidCheckoutModal prevents default on repeat Space on modal surface',
    );
    assert.strictEqual(
      prepaidConfirms.length,
      0,
      'PrepaidCheckoutModal does not confirm on repeat Space',
    );

    const surfaceSpace = dispatchPrepaidKey({
      key: ' ',
      code: 'Space',
      repeat: false,
      target: makeDomTarget({ tagName: 'DIV' }),
    });
    assert.strictEqual(
      surfaceSpace.defaultPrevented,
      true,
      'PrepaidCheckoutModal prevents default on non-repeat Space on modal surface',
    );
    assert.strictEqual(
      prepaidConfirms.length,
      1,
      'PrepaidCheckoutModal confirms order on non-repeat Space on modal surface',
    );
    assert.deepStrictEqual(
      prepaidConfirms[0],
      {
        payments: [{ method: 'cash', amount: 100 }],
        walletAmount: 0,
        discount: null,
      },
      'PrepaidCheckoutModal auto-allocates remaining balance to cash and confirms',
    );

    const escRes = dispatchPrepaidKey({
      key: 'Escape',
      code: 'Escape',
      target: makeDomTarget({ tagName: 'BUTTON' }),
    });
    assert.strictEqual(
      escRes.defaultPrevented,
      true,
      'PrepaidCheckoutModal Escape preventsDefault',
    );
    assert.strictEqual(prepaidClosed, 1, 'PrepaidCheckoutModal Escape closes modal');
    if (prevNode === undefined) delete (globalThis as Record<string, unknown>).Node;
    else (globalThis as Record<string, unknown>).Node = prevNode;
  } finally {
    moduleApi._load = originalLoad;
    moduleApi._resolveFilename = originalResolveFilename;
    if (prevWin === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWin;
    if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = prevDoc;
  }
}

console.log('All POS keyboard shortcuts unit tests passed successfully.');
