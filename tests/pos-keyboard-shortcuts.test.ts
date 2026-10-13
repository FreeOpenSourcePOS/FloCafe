/**
 * Unit Test: POS Keyboard Shortcuts & Quantity Multiplier Parser
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/pos-keyboard-shortcuts.test.ts
 */

import assert from 'assert';
import Module from 'module';
import fs from 'fs';
import path from 'path';
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

// 5. Negative and invalid inputs should return null
assert.strictEqual(parseQuantitySearch('latte'), null, 'normal search query returns null');
assert.strictEqual(parseQuantitySearch('latte*3'), null, 'inverted syntax returns null');
assert.strictEqual(parseQuantitySearch('0*item'), null, 'zero quantity returns null');
assert.strictEqual(parseQuantitySearch('-5*item'), null, 'negative quantity returns null');
assert.strictEqual(parseQuantitySearch('3*'), null, 'empty target query returns null');
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

    // macOS Option+2 emits key '™' with physical code 'Digit2'
    const option2 = dispatch({ key: '™', code: 'Digit2', altKey: true });
    assert.strictEqual(calls.toggleTables, 1, 'Option+Digit2 (key="™") triggers onToggleTables');
    assert.strictEqual(option2.defaultPrevented, true);

    // macOS Option+4 emits key '¢' with physical code 'Digit4'
    const option4 = dispatch({ key: '¢', code: 'Digit4', altKey: true });
    assert.strictEqual(calls.openCheckout, 1, 'Option+Digit4 (key="¢") triggers onOpenCheckout');
    assert.strictEqual(option4.defaultPrevented, true);

    // Option+Digit combinations on other keys or with extra modifiers must not misfire
    dispatch({ key: '€', code: 'Digit2', altKey: true, shiftKey: true });
    dispatch({ key: '2', code: 'Digit2', altKey: true, ctrlKey: true });
    dispatch({ key: '2', code: 'KeyQ', altKey: true });
    dispatch({ key: '-', code: 'Digit6', altKey: true });
    dispatch({ key: '+', code: 'Digit1', altKey: true });
    dispatch({ key: '/', code: 'Digit7', altKey: true, shiftKey: true });
    dispatch({ key: '?', code: 'Slash', altKey: true, shiftKey: true });
    dispatch({ key: 'F4', code: 'F4', altKey: true });
    dispatch({ key: ' ', code: 'Space', ctrlKey: true });
    dispatch({ key: ' ', code: 'Space', metaKey: true });
    dispatch({ key: ' ', code: 'Space', altKey: true });

    assert.strictEqual(
      calls.toggleTables,
      1,
      'modified/non-Digit2 Alt combos do not misfire toggleTables',
    );
    assert.strictEqual(
      calls.openCheckout,
      1,
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

  // Also verify tablePickerOpen closes on macOS Option+Digit2
  {
    const { calls, dispatch } = createShortcutHarness({
      anyModalOpen: true,
      tablePickerOpen: true,
    });
    const option2Close = dispatch({ key: '™', code: 'Digit2', altKey: true });
    assert.strictEqual(calls.toggleTables, 1, 'Option+Digit2 closes open table picker');
    assert.strictEqual(option2Close.defaultPrevented, true);
  }
} finally {
  reactModule.useRef = origUseRef;
  reactModule.useEffect = origUseEffect;
  if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = origWindow;
  if (origHTMLElement === undefined) delete (globalThis as Record<string, unknown>).HTMLElement;
  else (globalThis as Record<string, unknown>).HTMLElement = origHTMLElement;
}

// (c) Help overlay closes before blurring a focused input when Escape is pressed
{
  const posPageSource = fs.readFileSync(
    path.resolve(__dirname, '../frontend/src/app/(dashboard)/pos/page.tsx'),
    'utf8',
  );
  const dismissIndex = posPageSource.indexOf('onDismissModalOrBlur:');
  assert.ok(dismissIndex !== -1, 'onDismissModalOrBlur handler exists in pos/page.tsx');
  const dismissBlock = posPageSource.slice(dismissIndex, dismissIndex + 800);
  const helpCheckPos = dismissBlock.indexOf('if (showKeyboardShortcutsModal)');
  const blurCheckPos = dismissBlock.indexOf('activeEl.blur()');
  assert.ok(helpCheckPos !== -1, 'showKeyboardShortcutsModal check exists in onDismissModalOrBlur');
  assert.ok(blurCheckPos !== -1, 'activeEl.blur() exists in onDismissModalOrBlur');
  assert.ok(
    helpCheckPos < blurCheckPos,
    'onDismissModalOrBlur must close showKeyboardShortcutsModal before blurring a focused input',
  );
}

console.log('✓ All modifier guard and Escape priority tests passed.');
console.log('All POS keyboard shortcuts unit tests passed successfully.');
