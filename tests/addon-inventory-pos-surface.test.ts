/**
 * Add-on inventory POS gating: sold-out, low-stock and the quantity ceiling.
 *
 * There is no DOM harness for React components in this repo, so the cashier-facing
 * rules live in a pure module (frontend/src/lib/addon-inventory.ts) and are
 * pinned here table-driven. A product with no tracked add-ons must keep behaving
 * exactly as it did before this feature, which the untracked rows below pin.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/addon-inventory-pos-surface.test.ts
 */

import assert from 'node:assert/strict';

import { addonStockCeiling, isAddonLowStock, isAddonSoldOut } from '../frontend/src/lib/addon-inventory';
import type { Addon } from '../frontend/src/lib/types';

function addon(overrides: Partial<Addon> = {}): Addon {
  return {
    id: 'addon-oat',
    addon_group_id: 'grp-milk',
    name: 'Oat milk',
    price: 0.5,
    track_inventory: true,
    stock_quantity: 10,
    low_stock_threshold: 3,
    is_active: true,
    sort_order: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sold-out gating
// ---------------------------------------------------------------------------
const soldOutCases: Array<[string, Addon, boolean]> = [
  ['a tracked add-on at zero is sold out', addon({ stock_quantity: 0 }), true],
  ['a tracked add-on below zero is sold out', addon({ stock_quantity: -2 }), true],
  ['a tracked add-on with stock left still sells', addon({ stock_quantity: 1 }), false],
  ['an untracked add-on at zero still sells', addon({ track_inventory: false, stock_quantity: 0 }), false],
  ['an untracked add-on ignores its threshold', addon({ track_inventory: false, stock_quantity: 0, low_stock_threshold: 99 }), false],
  ['stock arriving as a numeric string still gates', addon({ stock_quantity: '0' as unknown as number }), true],
  ['an absent track flag does not gate on a zero default', addon({ track_inventory: undefined as unknown as boolean, stock_quantity: 0 }), false],
];

for (const [label, subject, expected] of soldOutCases) {
  assert.equal(isAddonSoldOut(subject), expected, label);
}

// ---------------------------------------------------------------------------
// Low-stock signalling: running low, never a second badge on a sold-out row
// ---------------------------------------------------------------------------
const lowStockCases: Array<[string, Addon, boolean]> = [
  ['stock exactly at the threshold is running low', addon({ stock_quantity: 3, low_stock_threshold: 3 }), true],
  ['stock below the threshold is running low', addon({ stock_quantity: 2, low_stock_threshold: 3 }), true],
  ['stock above the threshold is not low', addon({ stock_quantity: 4, low_stock_threshold: 3 }), false],
  ['a zero threshold means nothing is running low', addon({ stock_quantity: 1, low_stock_threshold: 0 }), false],
  ['a sold-out add-on is not also running low', addon({ stock_quantity: 0, low_stock_threshold: 3 }), false],
  ['an untracked add-on is never running low', addon({ track_inventory: false, stock_quantity: 1, low_stock_threshold: 99 }), false],
];

for (const [label, subject, expected] of lowStockCases) {
  assert.equal(isAddonLowStock(subject), expected, label);
}

// A zero-stock row carries the sold-out badge alone, as on the product grid.
assert.ok(
  !(isAddonSoldOut(addon({ stock_quantity: 0 })) && isAddonLowStock(addon({ stock_quantity: 0 }))),
  'a sold-out add-on never carries both the sold-out and running-low badges',
);

// ---------------------------------------------------------------------------
// The quantity ceiling a cashier may dial up to
// ---------------------------------------------------------------------------
assert.equal(addonStockCeiling(addon({ stock_quantity: 10 })), 10, 'a tracked add-on is capped at its stock');
assert.equal(addonStockCeiling(addon({ stock_quantity: 0 })), 0, 'a sold-out add-on has no headroom');
assert.equal(addonStockCeiling(addon({ stock_quantity: -5 })), 0, 'negative stock floors the ceiling at zero');
assert.equal(
  addonStockCeiling(addon({ track_inventory: false, stock_quantity: 0 })),
  null,
  'an untracked add-on has no ceiling, so quantity stays uncapped',
);

console.log('✓ add-on inventory POS surface checks passed');