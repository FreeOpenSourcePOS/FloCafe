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
console.log('All POS keyboard shortcuts unit tests passed successfully.');
