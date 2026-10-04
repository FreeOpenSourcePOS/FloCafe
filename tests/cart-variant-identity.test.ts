/**
 * Unit Test: cart identity and cart store carry the selected product variant.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/cart-variant-identity.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
  _load: (...args: any[]) => any;
};
const originalResolveFilename = moduleApi._resolveFilename;
const zustandPath = frontendRequire.resolve('zustand');
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  const resolvedRequest = request === 'zustand'
    ? zustandPath
    : request.startsWith('@/')
      ? path.resolve(ROOT, 'frontend/src', request.slice(2))
      : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const { generateCartItemId, normalizeCartItems } = require('../frontend/src/lib/cart-identity');
const { useCartStore } = require('../frontend/src/store/cart');

function variant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    product_id: 'prod-1',
    name: id,
    sku: null,
    barcode: null,
    price: 5,
    online_price: null,
    cost_price: null,
    track_inventory: true,
    stock_quantity: 10,
    low_stock_threshold: null,
    inventory_product_id: null,
    inventory_deduction_quantity: null,
    is_active: true,
    sort_order: 0,
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    category_id: null,
    name: 'Americano',
    sku: null,
    barcode: null,
    sale_unit: 'each',
    allow_fractional_quantity: false,
    weight_precision: 3,
    description: null,
    price: 3,
    cost_price: null,
    tax_type: 'none',
    tax_rate: 0,
    track_inventory: true,
    stock_quantity: 10,
    low_stock_threshold: null,
    is_active: true,
    available_online: false,
    has_image: false,
    updated_at: '',
    tags: null,
    variants: null,
    modifiers: null,
    sort_order: 0,
    ...overrides,
  };
}

const small = variant('var-small');
const large = variant('var-large');

assert.equal(
  generateCartItemId('prod-1', 'var-large', [], ''),
  generateCartItemId('prod-1', 'var-large', [], ''),
  'identical product, variant, add-ons and instructions share one cart identity',
);

assert.notEqual(
  generateCartItemId('prod-1', 'var-small', [], ''),
  generateCartItemId('prod-1', 'var-large', [], ''),
  'the same product with a different variant keeps distinct cart identities',
);

assert.notEqual(
  generateCartItemId('prod-1', null, [], ''),
  generateCartItemId('prod-1', 'var-large', [], ''),
  'an unselected variant is distinct from a selected one',
);

// Merge through the real store: same product, variant, add-ons, instructions.
const cart = () => useCartStore.getState();
cart().clearCart();
const coffee = product();
cart().addItem(coffee, 1, [], '', large);
cart().addItem(coffee, 2, [], '', large);

let items = cart().items;
assert.equal(items.length, 1, 'identical variant lines merge into a single cart line');
assert.equal(items[0].quantity, 3, 'the merged variant line sums the quantities');
assert.equal(items[0].variant?.id, 'var-large', 'the merged line keeps the chosen variant');

cart().addItem(coffee, 1, [], '', small);
items = cart().items;
assert.equal(items.length, 2, 'a differing variant stays a separate cart line');
assert.deepEqual(
  items.map((item: any) => item.variant?.id),
  ['var-large', 'var-small'],
  'both variants remain on their own lines',
);

// A cart reload keeps the variant on each line instead of collapsing them.
cart().loadItems(JSON.parse(JSON.stringify(items)), null, null, 1);
const reloaded = cart().items;
assert.equal(reloaded.length, 2, 'reloading a cart with two variants keeps both lines separate');
assert.deepEqual(
  reloaded.map((item: any) => item.variant?.id),
  ['var-large', 'var-small'],
  'reloaded lines keep their variant selection',
);
assert.deepEqual(
  reloaded.map((item: any) => item.id),
  items.map((item: any) => item.id),
  'reloaded lines receive the same canonical ids they were stored with',
);

// An edit that does not restate the variant keeps the one already on the line.
const editedId = generateCartItemId('prod-1', 'var-large', [], 'no sugar');
cart().updateItemDetails(reloaded[0].id, 5, [], 'no sugar');
const edited = cart().items.find((item: any) => item.id === editedId);
assert.ok(edited, 'the edited line is re-identified with its variant');
assert.equal(edited.variant?.id, 'var-large', 'editing instructions does not drop the variant');
assert.equal(edited.quantity, 5, 'the edited line keeps the updated quantity');

// Switching a line onto another line's variant merges the two.
const smallLineId = cart().items.find((item: any) => item.variant?.id === 'var-small').id;
cart().updateItemDetails(smallLineId, 1, [], 'no sugar', large);
const merged = cart().items;
assert.equal(merged.length, 1, 'switching a line onto an identical variant merges the two lines');
assert.equal(merged[0].quantity, 6, 'the merged line sums both quantities');
assert.equal(merged[0].variant?.id, 'var-large', 'the surviving line keeps the target variant');

// normalizeCartItems is the reload path used by held orders.
const normalized = normalizeCartItems([
  { id: 'stale-1', product: coffee, quantity: 1, addons: [], special_instructions: '', variant: large },
  { id: 'stale-2', product: coffee, quantity: 2, addons: [], special_instructions: '', variant: large },
  { id: 'stale-3', product: coffee, quantity: 4, addons: [], special_instructions: '', variant: small },
]);
assert.equal(normalized.length, 2, 'normalizeCartItems merges by variant and separates distinct variants');
assert.deepEqual(
  normalized.map((item: any) => [item.variant?.id, item.quantity]),
  [['var-large', 3], ['var-small', 4]],
  'normalizeCartItems groups and totals lines per variant',
);

console.log('✓ cart variant identity and cart store checks passed');