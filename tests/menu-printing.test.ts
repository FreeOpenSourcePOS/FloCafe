import assert from 'node:assert/strict';
import test from 'node:test';
import { displayCellWidth } from '../shared/print/width';
import { buildMenuDocument, renderMenuViaDocument } from '../main/printers/document-menu';
import { escPosToText } from '../main/printers/thermal';
import { capabilitiesForPrinter, resolvePrinterProfile } from '../main/printers/profiles';

const categories = [
  { id: 'drinks', name: 'Drinks', isActive: true, sortOrder: 2 },
  { id: 'food', name: 'Food', isActive: true, sortOrder: 1 },
  { id: 'hidden', name: 'Hidden', isActive: false, sortOrder: 3 },
];

const products = [
  { categoryId: 'drinks', name: 'Cold Coffee', price: 5, isActive: true, trackInventory: true, stockQuantity: 4, sortOrder: 2 },
  { categoryId: 'food', name: 'Veg Sandwich', price: 8, isActive: true, trackInventory: false, stockQuantity: 0, sortOrder: 1 },
  { categoryId: 'food', name: 'Sold Out Wrap', price: 7, isActive: true, trackInventory: true, stockQuantity: 0, sortOrder: 2 },
  { categoryId: 'food', name: 'Inactive Salad', price: 6, isActive: false, trackInventory: false, stockQuantity: 0, sortOrder: 3 },
  { categoryId: 'hidden', name: 'Hidden Tea', price: 3, isActive: true, trackInventory: false, stockQuantity: 0, sortOrder: 1 },
];

function menuDocument(name = 'Seasonal beverage with a longer printed name') {
  return buildMenuDocument(
    [{ id: 'drinks', name: 'Drinks', isActive: true, sortOrder: 1 }],
    [{ categoryId: 'drinks', name, price: 12.5, isActive: true, trackInventory: false, stockQuantity: 0, sortOrder: 1 }],
    {
      businessName: 'Flo Cafe',
      printedAt: 'Sep 30, 2026, 10:00 AM',
      baseDirection: 'ltr',
      formatPrice: (price) => `$${price.toFixed(2)}`,
    },
  );
}

test('menu document sorts categories and excludes inactive, unavailable, and hidden items by default', () => {
  const menu = buildMenuDocument(categories, products, {
    businessName: 'Flo Cafe',
    printedAt: 'Sep 30, 2026, 10:00 AM',
    baseDirection: 'ltr',
    formatPrice: (price) => `$${price.toFixed(2)}`,
  });

  assert.deepEqual(menu.sections.map((section) => section.name?.text), ['Food', 'Drinks']);
  assert.deepEqual(menu.sections.flatMap((section) => section.products.map((product) => product.name.text)), ['Veg Sandwich', 'Cold Coffee']);
  assert.equal(menu.itemCount, 2);

  const allItems = buildMenuDocument(categories, products, {
    businessName: 'Flo Cafe',
    printedAt: 'Sep 30, 2026, 10:00 AM',
    baseDirection: 'ltr',
    formatPrice: (price) => `$${price.toFixed(2)}`,
    includeInactive: true,
    includeOutOfStock: true,
    includeHidden: true,
  });
  assert.equal(allItems.itemCount, 5);
  assert.ok(allItems.sections.some((section) => section.name?.text === 'Hidden'));
});

test('menu thermal rows and wrapped names stay within 32- and 42-column printer widths', () => {
  for (const columns of [32, 42]) {
    const profile = resolvePrinterProfile({ paper_width: `cols-${columns}` });
    const capabilities = capabilitiesForPrinter(profile, `cols-${columns}`, false);
    const rendered = renderMenuViaDocument(menuDocument(), {
      columns,
      language: 'en',
      cutMode: profile.cutMode,
      capabilities,
    });
    const lines = escPosToText(rendered.data).split(/\r?\n/).filter((line) => line.length > 0);
    assert.ok(lines.some((line) => line.includes('$12.50')), `${columns}-column output includes the price`);
    assert.ok(lines.every((line) => displayCellWidth(line) <= columns), `${columns}-column output stays within width`);
  }
});

test('menu text cannot inject ESC/POS commands through control bytes or token-shaped names', () => {
  const hostileName = 'Tea {CUT} {INIT} {BOLD}\x1Bp\x00\x19';
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-42', false);
  const rendered = renderMenuViaDocument(menuDocument(hostileName), {
    columns: 42,
    language: 'en',
    cutMode: profile.cutMode,
    capabilities,
  });
  const text = escPosToText(rendered.data);
  const cutCommands = rendered.data.reduce((count, byte, index, bytes) =>
    count + (byte === 0x1d && bytes[index + 1] === 0x56 ? 1 : 0), 0);

  assert.equal(cutCommands, 1, 'only the renderer emits its final cut command');
  assert.equal(rendered.data.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19])), false);
  assert.ok(text.includes('{ CUT }'));
  assert.ok(text.includes('{ BOLD }'));
  const curlyText = renderMenuViaDocument(menuDocument('Tea {tag}'), {
    columns: 42,
    language: 'en',
    cutMode: profile.cutMode,
    capabilities,
  });
  assert.ok(escPosToText(curlyText.data).includes('{tag}'));

  const cashDrawerPayload = renderMenuViaDocument(menuDocument('Tea \x1Bp\x00\x19\xfa'), {
    columns: 42,
    language: 'en',
    cutMode: profile.cutMode,
    capabilities,
  });
  assert.equal(cashDrawerPayload.data.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])), false);
});
