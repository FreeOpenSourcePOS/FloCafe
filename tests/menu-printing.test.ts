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

test('menu includes optional descriptions and effective modifier prices only when requested', () => {
  const product = { ...products[0], description: 'Fresh {CUT} coffee', modifiers: [{ name: 'Milk', options: [{ name: 'Oat', price: 2 }] }] };
  const options = { businessName: 'Cafe', printedAt: '', baseDirection: 'ltr' as const, formatPrice: (value: number) => `$${value.toFixed(2)}` };
  const omitted = buildMenuDocument(categories, [product], options);
  assert.deepEqual(omitted.sections[0].products[0].details, []);
  const included = buildMenuDocument(categories, [product], { ...options, includeDescriptions: true, includeModifiers: true });
  assert.deepEqual(included.sections[0].products[0].details.map((detail) => detail.text), ['Fresh { CUT } coffee', 'Milk: Oat ($2.00)']);
  const rendered = renderMenuViaDocument(included, { columns: 42, language: 'en' });
  assert.match(escPosToText(rendered.data), /Milk: Oat \(\$2.00\)/);
});

test('menu thermal labels use the requested print language', () => {
  const profile = resolvePrinterProfile({ profile_id: 'epson-tm-series' });
  const rendered = renderMenuViaDocument(menuDocument(), { columns: 42, language: 'es', capabilities: capabilitiesForPrinter(profile, 'cols-42', false) });
  assert.match(escPosToText(rendered.data), /Total de artículos: 1/);
  assert.doesNotMatch(escPosToText(rendered.data), /Total items/);
});

test('browser menu supports A4 and Letter and escapes descriptions, modifiers, and labels', () => {
  const { buildMenuWebPrintHtml } = require('../frontend/src/lib/printer/menu-web-print');
  for (const pageSize of ['A4', 'Letter']) {
    const html = buildMenuWebPrintHtml({ businessName: 'Cafe', printedAt: '', pageSize, menuTitle: 'Menú', totalItemsLabel: 'Total de artículos', itemCount: 1,
      sections: [{ name: 'Tea', products: [{ name: 'Tea', price: '$1', details: ['Fresh <script>alert(1)</script>', 'Milk: Oat ($2)'] }] }],
    });
    assert.ok(html.includes(`size: ${pageSize} portrait`));
    assert.match(html, /Milk: Oat \(\$2\)/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, /Total de artículos: 1/);
  }
  const invalidPage = buildMenuWebPrintHtml({ businessName: 'Cafe', printedAt: '',
    pageSize: 'A4}</style><SCRIPT>alert(1)</SCRIPT>', menuTitle: 'Menu', totalItemsLabel: 'Total items', itemCount: 0, sections: [],
  });
  assert.ok(invalidPage.includes('size: A4 portrait'));
  assert.doesNotMatch(invalidPage, /<script\b/i);
});

test('Unicode menu printing uses raster-capable WebUSB output and refuses raster failure', async () => {
  const raster = require('../main/printers/raster-renderer');
  const originalRenderer = raster.getSharedRasterRenderer;
  const requests: Array<{ text: string }> = [];
  const printer = { connection_type: 'webusb', profile_id: 'epson-tm-series', paper_width: 'cols-48' };
  const { printMenuDocument } = require('../main/printers/thermal');
  raster.getSharedRasterRenderer = () => ({ render: async (request: { requestId: string; text: string; widthDots: number }) => {
    requests.push(request);
    return { version: 1, requestId: request.requestId, ok: true, unit: { unitId: request.requestId, complete: true, financial: false,
      bands: [{ widthDots: request.widthDots, heightDots: 1, pixels: new Uint8Array(request.widthDots).fill(1) }] } };
  } });
  try {
    const result = await printMenuDocument(menuDocument('抹茶'), undefined, printer);
    assert.equal(result.ok, true, JSON.stringify({detail: result.detail, warnings: result.warnings}));
    assert.ok(requests.some((request) => request.text.includes('抹茶')));
    assert.ok(result.bytes?.includes(Buffer.from([0x1d, 0x76, 0x30])));
    raster.getSharedRasterRenderer = () => ({ render: async (request: { requestId: string }) => ({ version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: 'Unavailable' }) });
    const failed = await printMenuDocument(menuDocument('抹茶'), undefined, printer);
    assert.equal(failed.ok, false);
    assert.equal(failed.bytes, undefined);
  } finally {
    raster.getSharedRasterRenderer = originalRenderer;
    raster.destroySharedRasterRenderer();
  }
});

test('menu route preserves regional conflicts, validates filters, and honors the default WebUSB printer', async () => {
  const express = require('express');
  const request = require('supertest');
  const database = require('../main/db');
  const authorization = require('../main/services/authorization');
  const thermal = require('../main/printers/thermal');
  const originals = { getDatabase: database.getDatabase, requirePermission: authorization.requirePermission, printMenuDocument: thermal.printMenuDocument };
  let configured = false;
  let printed: any;
  database.getDatabase = () => ({ prepare: (sql: string) => ({
    all: () => {
      if (sql.includes('FROM settings')) return configured ? [{ key: 'country', value: 'US' }, { key: 'currency', value: 'USD' }] : [];
      if (sql.includes('FROM categories')) return [{ id: 'drinks', name: 'Drinks', is_active: 1, sort_order: 0 }];
      if (sql.includes('FROM products p')) return [{ id: 'tea', category_id: 'drinks', name: 'Tea', description: 'Fresh tea', price: 5, is_active: 1, track_inventory: 0, stock_quantity: 0, sort_order: 0 }];
      if (sql.includes('FROM addon_group_product')) return [{ product_id: 'tea', addon_group_id: 'milk' }];
      if (sql.includes('FROM category_addon_groups')) return [];
      if (sql.includes('FROM addon_groups')) return [{ id: 'milk', name: 'Milk', is_active: 1, sort_order: 0 }];
      if (sql.includes('FROM addons')) return [{ id: 'oat', addon_group_id: 'milk', name: 'Oat', price: 2, is_active: 1 }];
      // The menu route reuses the catalog's shared relation loader, which also
      // loads product variants. A menu has no variant rows to print.
      if (sql.includes('FROM product_variants')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    get: () => {
      if (sql.includes('WHERE is_default = 1')) return { name: 'Default WebUSB', connection_type: 'webusb', paper_width: '80mm' };
      throw new Error(`Unexpected query: ${sql}`);
    },
  }) });
  authorization.requirePermission = () => (_req: unknown, _res: unknown, next: () => void) => next();
  thermal.printMenuDocument = async (document: unknown, _signal: unknown, printer: unknown) => {
    printed = { document, printer };
    return { ok: true, connection_type: 'webusb', bytes: Buffer.from([1, 2]) };
  };
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/printers', require('../main/routes/printers').printerRoutes);
    const missing = await request(app).post('/api/printers/print-menu').send({});
    assert.equal(missing.status, 409);
    configured = true;
    const malformed = await request(app).post('/api/printers/print-menu').send({ includeModifiers: 'true' });
    assert.equal(malformed.status, 400);
    const success = await request(app).post('/api/printers/print-menu').send({ includeDescriptions: true, includeModifiers: true });
    assert.equal(success.status, 200, JSON.stringify(success.body));
    assert.equal(success.body.webusb, true);
    assert.equal(printed.printer.name, 'Default WebUSB');
    assert.deepEqual(printed.document.sections[0].products[0].details.map((detail: { text: string }) => detail.text), ['Fresh tea', 'Milk: Oat ($2.00)']);
  } finally {
    Object.assign(database, { getDatabase: originals.getDatabase });
    Object.assign(authorization, { requirePermission: originals.requirePermission });
    Object.assign(thermal, { printMenuDocument: originals.printMenuDocument });
  }
});
