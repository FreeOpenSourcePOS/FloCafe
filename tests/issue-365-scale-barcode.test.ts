/**
 * Unit Test: Issue #365 — scale-generated weighted barcodes
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/issue-365-scale-barcode.test.ts
 */

import assert from 'assert';
import { parseScaleBarcode, resolveScannedProduct } from '../frontend/src/lib/scale-barcode';

const parsed = parseScaleBarcode('2101234012507');
assert.deepEqual(parsed, { plu: '01234', quantity: 1.25 }, 'default scale barcode parses prefix, PLU, and grams');

assert.equal(parseScaleBarcode('9901234012507'), null, 'non-scale prefix is ignored');
assert.equal(parseScaleBarcode('2101234000007'), null, 'zero-weight scale labels are ignored');
assert.equal(parseScaleBarcode('2101234ABCDE7'), null, 'non-numeric scale labels are ignored');

const products = [
  {
    id: 'prod-mango',
    category_id: 'cat',
    name: 'Mango',
    sku: null,
    barcode: '01234',
    sale_unit: 'kg',
    allow_fractional_quantity: true,
    weight_precision: 3,
    description: null,
    price: 120,
    cost_price: null,
    tax_type: 'none',
    tax_rate: 0,
    track_inventory: false,
    stock_quantity: 0,
    low_stock_threshold: null,
    is_active: true,
    available_online: false,
    has_image: false,
    updated_at: '',
    tags: null,
    variants: null,
    modifiers: null,
    sort_order: 0,
  },
  {
    id: 'prod-each',
    category_id: 'cat',
    name: 'Each Item',
    sku: null,
    barcode: '56789',
    sale_unit: 'each',
    allow_fractional_quantity: false,
    weight_precision: 3,
    description: null,
    price: 10,
    cost_price: null,
    tax_type: 'none',
    tax_rate: 0,
    track_inventory: false,
    stock_quantity: 0,
    low_stock_threshold: null,
    is_active: true,
    available_online: false,
    has_image: false,
    updated_at: '',
    tags: null,
    variants: null,
    modifiers: null,
    sort_order: 0,
  },
  {
    id: 'prod-rice-grams',
    category_id: 'cat',
    name: 'Rice',
    sku: null,
    barcode: '77777',
    sale_unit: 'g',
    allow_fractional_quantity: true,
    weight_precision: 0,
    description: null,
    price: 0.2,
    cost_price: null,
    tax_type: 'none',
    tax_rate: 0,
    track_inventory: false,
    stock_quantity: 0,
    low_stock_threshold: null,
    is_active: true,
    available_online: false,
    has_image: false,
    updated_at: '',
    tags: null,
    variants: null,
    modifiers: null,
    sort_order: 0,
  },
  {
    id: 'prod-cheese-lb',
    category_id: 'cat',
    name: 'Cheese',
    sku: null,
    barcode: '88888',
    sale_unit: 'lb',
    allow_fractional_quantity: true,
    weight_precision: 3,
    description: null,
    price: 8,
    cost_price: null,
    tax_type: 'none',
    tax_rate: 0,
    track_inventory: false,
    stock_quantity: 0,
    low_stock_threshold: null,
    is_active: true,
    available_online: false,
    has_image: false,
    updated_at: '',
    tags: null,
    variants: null,
    modifiers: null,
    sort_order: 0,
  },
] as any[];

assert.deepEqual(
  resolveScannedProduct('2101234012507', products),
  { product: products[0], quantity: 1.25, scaleBarcode: { plu: '01234', quantity: 1.25 } },
  'scale label resolves weighted product and decimal quantity',
);

assert.deepEqual(
  resolveScannedProduct('56789', products),
  { product: products[1], quantity: 1, scaleBarcode: null },
  'exact barcode keeps ordinary scan behavior',
);

assert.deepEqual(
  resolveScannedProduct('2177777012507', products),
  { product: products[2], quantity: 1250, scaleBarcode: { plu: '77777', quantity: 1.25 } },
  'grams sale units receive gram quantities',
);

assert.deepEqual(
  resolveScannedProduct('2188888012507', products),
  { product: products[3], quantity: 2.756, scaleBarcode: { plu: '88888', quantity: 1.25 } },
  'pound sale units convert from label grams',
);

assert.equal(resolveScannedProduct('2156789012507', products), null, 'non-fractional products do not resolve scale labels');

console.log('✓ Issue #365 scale barcode parser checks passed');
