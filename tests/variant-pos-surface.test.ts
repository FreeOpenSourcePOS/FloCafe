/**
 * Variant POS surface: printed item headings, cart pricing, append fingerprint.
 *
 * Covers the cashier-facing half of product variants:
 *   - a receipt line and a KOT line always name the variant that was sold, and
 *     carry the variant SKU when one is defined;
 *   - a product with no variant prints byte-for-byte as it printed before;
 *   - the cart prices a variant line at the variant price, not the parent
 *     product price (a silent wrong-price sale otherwise);
 *   - the append fingerprint covers variant_id, so a variant append is a
 *     distinct logical append and gets its own idempotency key.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/variant-pos-surface.test.ts
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
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  const resolvedRequest = request === 'zustand'
    ? zustandPath
    : request.startsWith('@/')
      ? path.resolve(ROOT, 'frontend/src', request.slice(2))
      : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const { buildBillPrintData } = require('../main/printers/document-classic');
const { buildKotPrintData } = require('../main/printers/document-kot');
const { buildDeliverySlipPrintData } = require('../main/printers/document-delivery-slip');
const { useCartStore } = require('../frontend/src/store/cart');
const { buildAppendItemsFingerprint } = require('../frontend/src/lib/append-attempt');
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { formatItemHeading } = require('../frontend/src/lib/printer/item-heading');
const {
  activeVariants,
  isVariantSoldOut,
  selectDefaultVariant,
} = require('../frontend/src/lib/product-variants');

function variant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'var-large',
    product_id: 'prod-1',
    name: 'Large',
    sku: null,
    barcode: null,
    price: 5.5,
    online_price: null,
    cost_price: null,
    track_inventory: false,
    stock_quantity: 0,
    low_stock_threshold: null,
    inventory_product_id: null,
    inventory_deduction_quantity: null,
    is_active: true,
    sort_order: 0,
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return { id: 'prod-1', name: 'Cappuccino', price: 3, sku: null, barcode: null, ...overrides };
}

const business = { name: 'Flo Test Cafe', country: 'US', currency: 'USD' };
const bill = {
  bill_number: 'INV-1', subtotal: 11, discount_amount: 0, tax_amount: 0,
  total: 11, delivery_charge: 0, packaging_charge: 0, tax_components: [],
  payment_details: null,
};

function receiptItem(variantSelection: unknown) {
  return {
    product_name: 'Cappuccino',
    quantity: 2,
    unit_price: 5.5,
    total: 11,
    tax_amount: 0,
    addons: [{ name: 'Oat milk', price: 0, quantity: 1 }],
    special_instructions: '',
    ...(variantSelection === undefined ? {} : { variant_selection: variantSelection }),
  };
}

// ---------------------------------------------------------------------------
// Classic receipt heading
// ---------------------------------------------------------------------------
{
  const heading = (variantSelection: unknown) =>
    buildBillPrintData({ order_number: 'A1', items: [receiptItem(variantSelection)] }, bill, business, false)
      .order.items[0].productName;

  assert.equal(heading(JSON.stringify(variant())), 'Cappuccino (Large)', 'a receipt line names the variant sold');
  assert.equal(
    heading(JSON.stringify(variant({ sku: 'CAP-LG' }))),
    'Cappuccino (Large) [CAP-LG]',
    'a receipt line carries the variant SKU when one is defined',
  );
  assert.equal(
    heading(variant()),
    'Cappuccino (Large)',
    'a variant snapshot stored as an object prints the same heading as the JSON form',
  );
  assert.equal(heading(undefined), 'Cappuccino', 'an item with no variant prints exactly the product name');
  assert.equal(heading(null), 'Cappuccino', 'a null variant snapshot prints exactly the product name');
  assert.equal(heading('null'), 'Cappuccino', 'a JSON null variant snapshot prints exactly the product name');
  assert.equal(heading('not json'), 'Cappuccino', 'an unparseable variant snapshot prints exactly the product name');
  assert.equal(
    heading(JSON.stringify({ id: 'var-large', price: 5.5 })),
    'Cappuccino',
    'a variant snapshot without a name never renders empty parentheses',
  );
  assert.equal(
    heading(JSON.stringify({ name: 'Large', sku: '   ' })),
    'Cappuccino (Large)',
    'a blank variant SKU adds no bracket noise',
  );
}

// ---------------------------------------------------------------------------
// KOT heading
// ---------------------------------------------------------------------------
{
  const heading = (variantSelection: unknown) =>
    buildKotPrintData({ order_number: 'A1' }, [{
      product_name: 'Cappuccino',
      quantity: 1,
      status: 'pending',
      addons: [],
      special_instructions: '',
      ...(variantSelection === undefined ? {} : { variant_selection: variantSelection }),
    }], 'Grill').items[0].productName;

  assert.equal(heading(JSON.stringify(variant())), 'Cappuccino (Large)', 'a KOT line names the variant sold');
  assert.equal(
    heading(JSON.stringify(variant({ sku: 'CAP-LG' }))),
    'Cappuccino (Large) [CAP-LG]',
    'a KOT line carries the variant SKU when one is defined',
  );
  assert.equal(heading(undefined), 'Cappuccino', 'a KOT item with no variant prints exactly the product name');
}

// ---------------------------------------------------------------------------
// Cart prices the variant, not the parent product
// ---------------------------------------------------------------------------
{
  const cart = useCartStore.getState();
  cart.clearCart();
  cart.addItem(product(), 2, [], '', variant());
  cart.addItem(product({ id: 'prod-2', name: 'Cookie' }), 1);

  assert.equal(
    useCartStore.getState().subtotal(),
    2 * 5.5 + 3,
    'a variant line is subtotalled at the variant price, a plain line at the product price',
  );

  cart.clearCart();
  cart.addItem(product(), 1, [], '', variant({ price: 0 }));
  assert.equal(
    useCartStore.getState().subtotal(),
    0,
    'a free variant prices at zero rather than falling back to the parent product price',
  );
  useCartStore.getState().clearCart();
}

// ---------------------------------------------------------------------------
// Sold-out gating and default selection (table-driven)
// ---------------------------------------------------------------------------
{
  const tracked = variant({ id: 'tracked-zero', track_inventory: true, stock_quantity: 0 });
  const trackedStocked = variant({ id: 'tracked-stock', track_inventory: true, stock_quantity: 4 });
  const untrackedZero = variant({ id: 'untracked-zero', track_inventory: false, stock_quantity: 0 });
  const inactiveSoldOut = variant({ id: 'inactive', track_inventory: true, stock_quantity: 0, is_active: false });

  for (const [label, input, soldOut] of [
    ['tracked at zero', tracked, true],
    ['untracked at zero', untrackedZero, false],
    ['tracked with stock', trackedStocked, false],
    ['inactive at zero', inactiveSoldOut, true],
  ] as const) {
    assert.equal(isVariantSoldOut(input), soldOut, `${label}: sold-out gating`);
  }

  assert.deepEqual(
    activeVariants([tracked, inactiveSoldOut, untrackedZero]).map((v: any) => v.id),
    ['tracked-zero', 'untracked-zero'],
    'only active variants are offered for selection',
  );

  const lineup = [tracked, untrackedZero, trackedStocked];
  for (const [label, variants, initialId, expected] of [
    ['first in stock when nothing is chosen', lineup, undefined, 'untracked-zero'],
    ['a still-sellable line variant is kept', lineup, 'tracked-stock', 'tracked-stock'],
    ['a sold-out line variant is not kept', lineup, 'tracked-zero', 'untracked-zero'],
    ['the only sellable variant wins', [tracked, untrackedZero], undefined, 'untracked-zero'],
    ['every variant sold out', [tracked, variant({ id: 'z', track_inventory: true, stock_quantity: 0 })], undefined, null],
    ['no variants at all', [], 'anything', null],
  ] as const) {
    const chosen = selectDefaultVariant(variants, initialId);
    assert.equal(chosen?.id ?? null, expected, `default selection: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// One cart-item -> order-item projection
// ---------------------------------------------------------------------------
{
  const baseItem = {
    id: 'line-1',
    product: product(),
    quantity: 2,
    addons: [],
    special_instructions: 'no sugar',
    variant: null,
  };

  const plain = cartItemToOrderItem(baseItem);
  assert.equal(plain.product_id, 'prod-1', 'the mapper carries the product id');
  assert.equal(plain.variant_id, null, 'a line with no variant sends a null variant_id');
  assert.equal(plain.addons, null, 'a line with no add-ons sends null, not an empty array');

  const withVariant = cartItemToOrderItem({ ...baseItem, variant: variant({ sku: 'CAP-LG' }) });
  assert.equal(withVariant.variant_id, 'var-large', 'the mapper carries the selected variant id');

  const withAddons = cartItemToOrderItem({
    ...baseItem,
    addons: [{ id: 'addon-1', addon_group_id: 'g1', name: 'Oat milk', price: 40, is_active: true, sort_order: 0 }],
  });
  assert.deepEqual(
    withAddons.addons,
    [{ id: 'addon-1', name: 'Oat milk', price: 40, quantity: 1 }],
    'add-ons project to the order payload with a defaulted quantity',
  );

  assert.equal(
    cartItemToOrderItem({ ...baseItem, special_instructions: '' }).special_instructions,
    null,
    'an empty instruction note sends null',
  );
}

// ---------------------------------------------------------------------------
// The browser print mirror agrees with the backend helper
// ---------------------------------------------------------------------------
{
  for (const [label, input, expected] of [
    ['JSON text snapshot', JSON.stringify(variant()), 'Cappuccino (Large)'],
    ['object snapshot', variant(), 'Cappuccino (Large)'],
    ['snapshot with a SKU', JSON.stringify(variant({ sku: 'CAP-LG' })), 'Cappuccino (Large) [CAP-LG]'],
    ['no snapshot', undefined, 'Cappuccino'],
    ['null snapshot', null, 'Cappuccino'],
    ['JSON null snapshot', 'null', 'Cappuccino'],
    ['unparseable snapshot', 'not json', 'Cappuccino'],
    ['nameless snapshot', JSON.stringify({ id: 'var-large' }), 'Cappuccino'],
    ['blank SKU', JSON.stringify({ name: 'Large', sku: '  ' }), 'Cappuccino (Large)'],
  ] as const) {
    assert.equal(formatItemHeading('Cappuccino', input), expected, `browser heading: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Courier slip heading names the variant too
// ---------------------------------------------------------------------------
{
  const slipHeading = (variantSelection: unknown) =>
    buildDeliverySlipPrintData(
      { order_number: 'D1' },
      [{
        product_name: 'Cappuccino',
        quantity: 2,
        status: 'pending',
        addons: [],
        special_instructions: '',
        ...(variantSelection === undefined ? {} : { variant_selection: variantSelection }),
      }],
      {},
    ).items[0].productName;

  assert.equal(slipHeading(JSON.stringify(variant())), 'Cappuccino (Large)', 'a delivery slip line names the variant sold');
  assert.equal(slipHeading(undefined), 'Cappuccino', 'a delivery slip item with no variant prints exactly the product name');
}

// ---------------------------------------------------------------------------
// The append fingerprint distinguishes a variant append
// ---------------------------------------------------------------------------
{
  const base = { product_id: 'prod-1', quantity: 1, addons: null, special_instructions: null };
  const withVariant = { ...base, variant_id: 'var-large' };

  assert.notEqual(
    buildAppendItemsFingerprint(7, [withVariant]),
    buildAppendItemsFingerprint(7, [base]),
    'a variant append is a different logical append than the same items without one',
  );
  assert.notEqual(
    buildAppendItemsFingerprint(7, [{ ...withVariant, variant_id: 'var-small' }]),
    buildAppendItemsFingerprint(7, [withVariant]),
    'two different variants of one product are different logical appends',
  );
  assert.equal(
    buildAppendItemsFingerprint(7, [withVariant]),
    buildAppendItemsFingerprint(7, [{ ...withVariant }]),
    'an unchanged variant append keeps its fingerprint, so a retry replays the same idempotency key',
  );
}

console.log('✓ variant POS surface checks passed');