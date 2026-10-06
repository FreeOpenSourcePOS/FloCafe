/**
 * Unit Test: back-office variants table row mapping and payload builder.
 *
 * Guards the contract the products API depends on: the submitted `variants`
 * array is authoritative, so every field the backend manages must survive a
 * round-trip through the edit form untouched — including on a save that changes
 * nothing but the product name.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/product-variants-screen.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module') as {
  _resolveFilename: (...args: any[]) => string;
};
// Same `@/` and `@countries` resolution shim the sibling frontend suites use so
// the lib module imports as it does inside Next.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  const resolvedRequest = request === '@countries'
    ? path.resolve(ROOT, 'main/countries.ts')
    : request.startsWith('@/')
      ? path.resolve(ROOT, 'frontend/src', request.slice(2))
      : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const {
  buildVariantsPayload,
  hasInvalidVariantRow,
  moveVariantRow,
  newVariantRow,
  removeVariantRow,
  toVariantRows,
} = require('../frontend/src/lib/product-variants');

type Row = ReturnType<typeof newVariantRow>;

function variantFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v-1',
    product_id: 'p-1',
    name: 'Large',
    sku: 'CAP-LG',
    barcode: 'CAP-LG',
    price: 5,
    online_price: null,
    cost_price: 2.25,
    track_inventory: true,
    stock_quantity: 12,
    low_stock_threshold: 3,
    inventory_product_id: 'p-beans',
    inventory_deduction_quantity: 2,
    is_active: true,
    sort_order: 1,
    ...overrides,
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return { ...newVariantRow(), ...overrides };
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

console.log('\nproduct variant screen — row mapping and payload\n');

// ── Row mapping ──────────────────────────────────────────────────────────────
console.log('row mapping');

check('toVariantRows projects every column onto an editable row', () => {
  const [mapped] = toVariantRows([variantFixture()]);
  assert.deepEqual(mapped, {
    id: 'v-1',
    name: 'Large',
    price: '5',
    online_price: '',
    sku: 'CAP-LG',
    barcode: 'CAP-LG',
    stock_quantity: '12',
    loaded_stock_quantity: '12',
    touched: false,
    is_active: true,
    cost_price: 2.25,
    track_inventory: true,
    low_stock_threshold: 3,
    inventory_product_id: 'p-beans',
    inventory_deduction_quantity: 2,
  });
});

check('toVariantRows tolerates a product with no variants', () => {
  assert.deepEqual(toVariantRows(null), []);
  assert.deepEqual(toVariantRows(undefined), []);
  assert.deepEqual(toVariantRows([]), []);
});

check('toVariantRows keeps a zero online price distinct from an absent one', () => {
  const [zero] = toVariantRows([variantFixture({ online_price: 0 })]);
  const [absent] = toVariantRows([variantFixture({ online_price: null })]);
  assert.equal(zero.online_price, '0');
  assert.equal(absent.online_price, '');
});

check('toVariantRows normalises the 0/1 integer columns', () => {
  const [fromDb] = toVariantRows([variantFixture({ track_inventory: 1, is_active: 0 })]);
  assert.equal(fromDb.track_inventory, true);
  assert.equal(fromDb.is_active, false);
});

check('toVariantRows applies the backend defaults to absent managed fields', () => {
  const [sparse] = toVariantRows([variantFixture({
    cost_price: null,
    low_stock_threshold: null,
    inventory_product_id: null,
    inventory_deduction_quantity: null,
  })]);
  assert.equal(sparse.cost_price, null);
  assert.equal(sparse.low_stock_threshold, null);
  assert.equal(sparse.inventory_product_id, null);
  assert.equal(sparse.inventory_deduction_quantity, 1);
});

check('a loaded row survives load -> payload unchanged', () => {
  const rows = toVariantRows([variantFixture()]);
  const [payload] = buildVariantsPayload(rows, 2);
  const { product_id, stock_quantity, ...expected } = variantFixture();
  assert.equal(payload.id, 'v-1');
  assert.equal(payload.sort_order, 0);
  assert.deepEqual(payload, { id: 'v-1', ...expected, sort_order: 0 });
  assert.ok(
    !('stock_quantity' in payload),
    'an untouched stock field is not resubmitted, so a sale between load and save survives',
  );
});

// ── Payload builder ──────────────────────────────────────────────────────────
console.log('\npayload builder');

check('every backend-managed field reaches the payload', () => {
  const [payload] = buildVariantsPayload(toVariantRows([variantFixture()]), 2);
  const carried = {
    cost_price: payload.cost_price,
    track_inventory: payload.track_inventory,
    low_stock_threshold: payload.low_stock_threshold,
    inventory_product_id: payload.inventory_product_id,
    inventory_deduction_quantity: payload.inventory_deduction_quantity,
  };
  assert.deepEqual(carried, {
    cost_price: 2.25,
    track_inventory: true,
    low_stock_threshold: 3,
    inventory_product_id: 'p-beans',
    inventory_deduction_quantity: 2,
  });
});

check('the payload carries exactly the fields the products API normalises', () => {
  const [newPayload] = buildVariantsPayload([row({ name: 'Small', price: '3' })], 2);
  assert.deepEqual(Object.keys(newPayload).sort(), [
    'barcode',
    'cost_price',
    'inventory_deduction_quantity',
    'inventory_product_id',
    'is_active',
    'low_stock_threshold',
    'name',
    'online_price',
    'price',
    'sku',
    'sort_order',
    'stock_quantity',
    'track_inventory',
  ]);
  const [existing] = buildVariantsPayload(toVariantRows([variantFixture()]), 2);
  assert.deepEqual(
    Object.keys(existing).sort(),
    [...Object.keys(newPayload).filter((key) => key !== 'stock_quantity'), 'id'].sort(),
  );
});

check('an unchanged stock field is not resubmitted; a changed one is', () => {
  const [loaded] = toVariantRows([variantFixture({ stock_quantity: 10 })]);

  const [unchanged] = buildVariantsPayload([{ ...loaded, name: 'Large renamed' }], 2);
  assert.ok(!('stock_quantity' in unchanged), 'an unrelated edit leaves the stock field out of the payload');

  const [formatted] = buildVariantsPayload([{ ...loaded, stock_quantity: '10.0' }], 2);
  assert.ok(!('stock_quantity' in formatted), 'a formatting-only stock edit is not resubmitted');

  const [edited] = buildVariantsPayload([{ ...loaded, stock_quantity: '12' }], 2);
  assert.equal(edited.stock_quantity, 12, 'a changed stock field is submitted as the new absolute value');

  const [newRow] = buildVariantsPayload([row({ name: 'Small', price: '3', stock_quantity: '4' })], 2);
  assert.equal(newRow.stock_quantity, 4, 'a new row submits its opening stock');
});

check('untouched inactive history stays out of the payload', () => {
  const rows = toVariantRows([
    variantFixture(),
    variantFixture({ id: 'v-retired', name: 'Retired', is_active: false }),
  ]);
  assert.deepEqual(
    buildVariantsPayload(rows, 2).map((entry) => entry.id),
    ['v-1'],
    'an untouched inactive row is not resubmitted',
  );
});

check('an edited inactive row travels so the edit is not dropped', () => {
  const rows = toVariantRows([
    variantFixture(),
    variantFixture({ id: 'v-retired', name: 'Retired', is_active: false }),
  ]);
  const edited = rows.map((r) => (r.id === 'v-retired' ? { ...r, name: 'Retired v2', touched: true } : r));
  const payload = buildVariantsPayload(edited, 2);
  assert.deepEqual(payload.map((entry) => entry.id), ['v-1', 'v-retired']);
  assert.equal(payload[1].name, 'Retired v2');
});

check('a reactivated row travels and a skipped row keeps the order around it', () => {
  const rows = toVariantRows([
    variantFixture({ id: 'v-first', name: 'First' }),
    variantFixture({ id: 'v-retired', name: 'Retired', is_active: false }),
    variantFixture({ id: 'v-last', name: 'Last' }),
  ]);
  const payload = buildVariantsPayload(rows, 2);
  assert.deepEqual(payload.map((entry) => entry.id), ['v-first', 'v-last']);
  assert.deepEqual(payload.map((entry) => entry.sort_order), [0, 2], 'the skipped row keeps its slot');

  const reactivated = rows.map((r) => (r.id === 'v-retired' ? { ...r, is_active: true } : r));
  assert.deepEqual(
    buildVariantsPayload(reactivated, 2).map((entry) => entry.id),
    ['v-first', 'v-retired', 'v-last'],
  );
});

check('a new row omits its id', () => {
  const [payload] = buildVariantsPayload([row({ name: 'Small', price: '3' })], 2);
  assert.ok(!('id' in payload));
});

check('blank optional text is sent as null, not an empty string', () => {
  const [payload] = buildVariantsPayload([row({ name: '  ', sku: '  ', barcode: '' })], 2);
  assert.equal(payload.sku, null);
  assert.equal(payload.barcode, null);
});

check('blank online price is sent as null so the base price applies', () => {
  const [blank] = buildVariantsPayload([row({ name: 'S', price: '3', online_price: '' })], 2);
  const [zero] = buildVariantsPayload([row({ name: 'S', price: '3', online_price: '0' })], 2);
  assert.equal(blank.online_price, null);
  assert.equal(zero.online_price, 0);
});

check('prices are rounded to the tenant currency precision', () => {
  const [twoDp] = buildVariantsPayload([row({ name: 'S', price: '3.456' })], 2);
  const [zeroDp] = buildVariantsPayload([row({ name: 'S', price: '3.456' })], 0);
  assert.equal(twoDp.price, 3.46);
  assert.equal(zeroDp.price, 3);
});

check('negative stock is clamped so no ledger credit can be posted', () => {
  const [negative] = buildVariantsPayload([row({ name: 'S', price: '3', stock_quantity: '-5' })], 2);
  const [blank] = buildVariantsPayload([row({ name: 'S', price: '3', stock_quantity: '' })], 2);
  assert.equal(negative.stock_quantity, 0);
  assert.equal(blank.stock_quantity, 0);
});

check('sort_order follows the row order after a reorder', () => {
  const rows = [
    row({ id: 'a', name: 'A', price: '1' }),
    row({ id: 'b', name: 'B', price: '2' }),
    row({ id: 'c', name: 'C', price: '3' }),
  ];
  // C moves up past B, then B's old slot moves up past A: [A,B,C] -> [A,C,B] -> [C,A,B].
  const reordered = moveVariantRow(moveVariantRow(rows, 2, -1), 0, 1);
  assert.deepEqual(reordered.map((r: Row) => r.name), ['C', 'A', 'B']);
  const payload = buildVariantsPayload(reordered, 2);
  assert.deepEqual(payload.map((entry: { name: string; sort_order: number }) => [entry.name, entry.sort_order]), [
    ['C', 0],
    ['A', 1],
    ['B', 2],
  ]);
});

check('an emptied variants table sends an empty array, deactivating them all', () => {
  assert.deepEqual(buildVariantsPayload([], 2), []);
});

check('a removed row is simply absent, so the API soft-deactivates it', () => {
  const rows = toVariantRows([variantFixture(), variantFixture({ id: 'v-2', name: 'Small', price: 3 })]);
  const payload = buildVariantsPayload(removeVariantRow(rows, 0), 2);
  assert.deepEqual(payload.map((entry: { id: string }) => entry.id), ['v-2']);
  assert.equal(payload[0].sort_order, 0);
});

check('drop-in rows built without the loaded snapshot still send stock', () => {
  const [payload] = buildVariantsPayload([row({ name: 'Free sample', price: '0', stock_quantity: '0' })], 2);
  assert.equal(payload.stock_quantity, 0, 'a row with no loaded snapshot is treated as new');
});

// ── Row editing ──────────────────────────────────────────────────────────────
console.log('\nrow editing');

check('moveVariantRow swaps neighbours', () => {
  const rows = [row({ name: 'A' }), row({ name: 'B' }), row({ name: 'C' })];
  assert.deepEqual(moveVariantRow(rows, 0, 1).map((r: Row) => r.name), ['B', 'A', 'C']);
  assert.deepEqual(moveVariantRow(rows, 2, -1).map((r: Row) => r.name), ['A', 'C', 'B']);
});

check('a no-op reorder at either edge returns the same rows', () => {
  const rows = [row({ name: 'A' }), row({ name: 'B' })];
  assert.equal(moveVariantRow(rows, 0, -1), rows);
  assert.equal(moveVariantRow(rows, 1, 1), rows);
});

check('removeVariantRow drops only the targeted row', () => {
  const rows = [row({ name: 'A' }), row({ name: 'B' }), row({ name: 'C' })];
  assert.deepEqual(removeVariantRow(rows, 1).map((r: Row) => r.name), ['A', 'C']);
});

// ── Pre-submit validation ────────────────────────────────────────────────────
console.log('\npre-submit validation');

const invalidCases: [string, Partial<Row>, boolean][] = [
  ['a blank name', { name: '   ' }, true],
  ['a blank price', { price: '' }, true],
  ['a non-numeric price', { price: 'abc' }, true],
  ['a complete row', { name: 'Large', price: '5' }, false],
  ['a zero price is a real price', { name: 'Free sample', price: '0' }, false],
  ['a blank online price is fine', { name: 'Large', price: '5', online_price: '' }, false],
];

for (const [label, overrides, expected] of invalidCases) {
  check(`${label} is ${expected ? 'rejected' : 'accepted'}`, () => {
    assert.equal(hasInvalidVariantRow([row(overrides)]), expected);
  });
}

check('one bad row rejects the whole table', () => {
  assert.equal(hasInvalidVariantRow([row({ name: 'A', price: '1' }), row({ name: '' })]), true);
});

check('an empty table has nothing invalid', () => {
  assert.equal(hasInvalidVariantRow([]), false);
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll product variant screen checks passed.');