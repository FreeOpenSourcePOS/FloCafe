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
const { cartLineUnitPrice } = require('../frontend/src/lib/cart-price');
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

console.log('✓ cart price override checks passed');
