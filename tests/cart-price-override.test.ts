/**
 * Unit Test: an owner-set price override on a cart line stays a distinct line, drives the
 * subtotal, survives hold/restore, and travels in the order payload.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/cart-price-override.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
};
const originalResolveFilename = moduleApi._resolveFilename;
const zustandPath = frontendRequire.resolve('zustand');
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
  const resolvedRequest =
    request === 'zustand'
      ? zustandPath
      : request.startsWith('@/')
        ? path.resolve(ROOT, 'frontend/src', request.slice(2))
        : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const { generateCartItemId, normalizeCartItems } = require('../frontend/src/lib/cart-identity');
const {
  cartLineUnitPrice,
  clampCartPriceOverride,
  resolveActiveCurrencyDecimals,
  roundCartMoney,
} = require('../frontend/src/lib/cart-price');
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { useCartStore } = require('../frontend/src/store/cart');

const steak: any = { id: 'steak', name: 'Steak', price: 500, sale_unit: 'each' };
const cart = () => useCartStore.getState();
const OVERRIDE = { price: 350, reason: 'Regular customer' };

// Identity: an override changes the line identity, an equal override is stable.
const plainId = generateCartItemId('steak', null, [], '');
const overrideId = generateCartItemId('steak', null, [], '', OVERRIDE);
assert.notEqual(plainId, overrideId, 'an overridden line is distinct from the menu-price line');
assert.equal(
  overrideId,
  generateCartItemId('steak', null, [], '', { ...OVERRIDE }),
  'the same override gives the same id',
);
assert.notEqual(
  overrideId,
  generateCartItemId('steak', null, [], '', { price: 0, reason: 'Comp' }),
  'different overrides stay distinct',
);
assert.equal(
  plainId,
  generateCartItemId('steak', null, [], '', null),
  'a null override keeps the legacy identity',
);

// Price helper.
assert.equal(cartLineUnitPrice({ product: steak }, false), 500, 'menu price without an override');
assert.equal(
  cartLineUnitPrice({ product: steak, price_override: OVERRIDE }, false),
  350,
  'override price wins',
);
assert.equal(
  cartLineUnitPrice({ product: steak, price_override: { price: 0, reason: 'Comp' } }, false),
  0,
  'zero is a valid override',
);

// Store: set, subtotal, no merge into the menu-price line.
cart().clearCart();
cart().addItem(steak, 2);
const [line] = cart().items;
cart().setItemPriceOverride(line.id, OVERRIDE);
assert.equal(cart().items.length, 1, 'overriding does not duplicate the line');
assert.equal(cart().items[0].price_override?.price, 350, 'the override is stored on the line');
assert.equal(cart().subtotal(), 700, 'subtotal uses the override price');
cart().addItem(steak, 1);
assert.equal(cart().items.length, 2, 'adding the product again starts a new menu-price line');
assert.equal(cart().subtotal(), 1200, 'the new line is priced at the menu price');

// Payload carries the override only for overridden lines.
const [overridden, menu] = cart().items;
assert.deepEqual(
  cartItemToOrderItem(overridden).price_override,
  OVERRIDE,
  'payload includes the override',
);
assert.equal(
  'price_override' in cartItemToOrderItem(menu),
  false,
  'payload omits it for menu-price lines',
);

// Hold/restore keeps the override and does not merge it with the menu-price line.
const snapshot = JSON.parse(JSON.stringify(cart().items));
cart().loadItems(snapshot, null, null, 1);
assert.equal(cart().items.length, 2, 'restore keeps both lines');
assert.equal(cart().subtotal(), 1200, 'restore keeps the override price');
assert.equal(
  normalizeCartItems(snapshot).length,
  2,
  'normalization keeps overridden and menu lines apart',
);

// Quantity and detail edits keep the override.
cart().updateQuantity(cart().items.find((i: any) => i.price_override).id, 3);
assert.equal(cart().subtotal(), 3 * 350 + 500, 'quantity edits keep the override');
const edited = cart().items.find((i: any) => i.price_override);
cart().updateItemDetails(edited.id, 3, [], 'medium rare');
const afterDetail = cart().items.find((i: any) => i.price_override);
assert.equal(afterDetail.special_instructions, 'medium rare', 'details update');
assert.equal(afterDetail.price_override.price, 350, 'a detail edit keeps the override');
assert.equal(
  afterDetail.id,
  generateCartItemId('steak', null, [], 'medium rare', OVERRIDE),
  'the id tracks the new details and override',
);

// Clearing returns to the menu price and merges back into the menu-price line.
cart().setItemPriceOverride(afterDetail.id, null);
assert.ok(
  cart().items.every((i: any) => !i.price_override),
  'the override is cleared',
);
cart().clearCart();
cart().addItem(steak, 1);
cart().addItem(steak, 1);
cart().setItemPriceOverride(cart().items[0].id, OVERRIDE);
cart().setItemPriceOverride(cart().items[0].id, null);
assert.equal(
  cart().items.length,
  1,
  'clearing an override merges the line back with its menu-price twin',
);
assert.equal(cart().items[0].quantity, 2, 'merged quantity is preserved');
cart().clearCart();

// Fractional override unit prices normalize half-up to currency precision before multiplying by quantity.
for (const [rawPrice, expectedUnitPrice, expectedSubtotal] of [
  [10.005, 10.01, 30.03],
  [3.333, 3.33, 9.99],
  [0.015, 0.02, 0.06],
] as const) {
  cart().clearCart();
  cart().addItem(steak, 3);
  cart().setItemPriceOverride(cart().items[0].id, { price: rawPrice, reason: 'Precision check' });
  assert.equal(
    cartLineUnitPrice(cart().items[0], false),
    expectedUnitPrice,
    `cartLineUnitPrice normalizes ${rawPrice} -> ${expectedUnitPrice}`,
  );
  assert.equal(
    cart().items[0].price_override?.price,
    expectedUnitPrice,
    `stored override price normalizes ${rawPrice} -> ${expectedUnitPrice}`,
  );
  assert.equal(
    cart().subtotal(),
    expectedSubtotal,
    `cart subtotal at qty 3 uses normalized unit price for ${rawPrice}`,
  );
  assert.equal(
    cartItemToOrderItem(cart().items[0]).price_override?.price,
    expectedUnitPrice,
    `order payload carries normalized override price for ${rawPrice}`,
  );
}
cart().clearCart();

// Currency fraction digits resolver and clampCartPriceOverride for 3-decimal and 0-decimal currencies.
for (const code of ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'KW', 'BH', 'OM', 'JO', 'TN']) {
  assert.equal(resolveActiveCurrencyDecimals(code), 3, `${code} resolves to 3 fraction digits`);
}
for (const code of ['JPY', 'KRW', 'VND', 'COP', 'JP', 'KR', 'VN', 'CO']) {
  assert.equal(resolveActiveCurrencyDecimals(code), 0, `${code} resolves to 0 fraction digits`);
}
assert.equal(clampCartPriceOverride(1.234, 2.5, 'KWD'), 1.234, 'KWD preserves 1.234');
assert.equal(clampCartPriceOverride(0.004, 2.5, 'KWD'), 0.004, 'KWD preserves 0.004 (four fils)');
assert.equal(clampCartPriceOverride(1.2345, 2.5, 'KWD'), 1.235, 'KWD rounds half-up at 3dp');
assert.equal(clampCartPriceOverride(1080, 1200, 'JPY'), 1080, 'JPY preserves integer 1080');
assert.equal(clampCartPriceOverride(1080.7, 1200, 'JPY'), 1081, 'JPY rounds 1080.7 -> 1081');
assert.equal(clampCartPriceOverride(1080.4, 1200, 'JPY'), 1080, 'JPY rounds 1080.4 -> 1080');
assert.equal(clampCartPriceOverride('', 10, 'KWD'), null, 'blank override clamps to null');
assert.equal(clampCartPriceOverride(-0.001, 10, 'KWD'), null, 'negative override clamps to null');

const previousLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const mockStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key),
  },
  configurable: true,
  writable: true,
});
try {
  // Active 3-decimal currency (KWD): cart store, line identity, subtotal, and payload keep 3dp.
  mockStorage.set(
    'pos-auth',
    JSON.stringify({ state: { tenant: { country: 'KW', currency: 'KWD' } } }),
  );
  assert.equal(resolveActiveCurrencyDecimals(), 3, 'active KWD tenant resolves to 3 decimals');
  assert.equal(roundCartMoney(1.234), 1.234, 'roundCartMoney preserves 1.234 under KWD');

  const kwdItem: any = { id: 'kwd-item', name: 'Arabic Coffee', price: 2.5, sale_unit: 'each' };
  cart().clearCart();
  cart().addItem(kwdItem, 1);
  cart().setItemPriceOverride(cart().items[0].id, {
    price: 1.234,
    reason: 'KWD 3-decimal override',
  });
  assert.equal(cart().items[0].price_override?.price, 1.234, 'KWD cart override keeps 1.234');
  assert.equal(cart().subtotal(), 1.234, 'KWD cart subtotal keeps 1.234');
  assert.equal(
    cartItemToOrderItem(cart().items[0]).price_override?.price,
    1.234,
    'KWD order payload keeps 1.234',
  );

  cart().setItemPriceOverride(cart().items[0].id, {
    price: 0.004,
    reason: 'Four fils override',
  });
  assert.equal(
    cart().items[0].price_override?.price,
    0.004,
    'KWD cart override keeps 0.004 instead of rounding to 0',
  );
  assert.equal(cart().subtotal(), 0.004, 'KWD cart subtotal keeps 0.004');
  assert.equal(
    cartItemToOrderItem(cart().items[0]).price_override?.price,
    0.004,
    'KWD order payload keeps 0.004',
  );
  assert.notEqual(
    generateCartItemId('kwd-item', null, [], '', { price: 1.234, reason: 'KWD' }),
    generateCartItemId('kwd-item', null, [], '', { price: 1.23, reason: 'KWD' }),
    '1.234 and 1.230 KWD overrides produce distinct cart line ids',
  );

  // Active 0-decimal currency (JPY): fractional overrides round to whole yen.
  mockStorage.set(
    'pos-auth',
    JSON.stringify({ state: { tenant: { country: 'JP', currency: 'JPY' } } }),
  );
  assert.equal(resolveActiveCurrencyDecimals(), 0, 'active JPY tenant resolves to 0 decimals');
  const jpyItem: any = { id: 'jpy-item', name: 'Matcha Latte', price: 1200, sale_unit: 'each' };
  cart().clearCart();
  cart().addItem(jpyItem, 2);
  cart().setItemPriceOverride(cart().items[0].id, {
    price: 1080.7,
    reason: 'JPY integer override',
  });
  assert.equal(cart().items[0].price_override?.price, 1081, 'JPY override rounds 1080.7 -> 1081');
  assert.equal(cart().subtotal(), 2162, 'JPY subtotal at qty 2 uses 1081');
  assert.equal(
    cartItemToOrderItem(cart().items[0]).price_override?.price,
    1081,
    'JPY order payload carries 1081',
  );
  cart().clearCart();
} finally {
  if (previousLocalStorageDesc) {
    Object.defineProperty(globalThis, 'localStorage', previousLocalStorageDesc);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

console.log('✓ cart price override checks passed');
