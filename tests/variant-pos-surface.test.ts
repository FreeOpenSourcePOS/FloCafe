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
const { useCartStore } = require('../frontend/src/store/cart');
const { buildAppendItemsFingerprint } = require('../frontend/src/lib/append-attempt');

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