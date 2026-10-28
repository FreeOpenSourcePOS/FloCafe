/**
 * Per-printer text size: ESC/POS and raster output for normal, large and extra large,
 * and the guarantee that normal output is byte-identical to a printer with no setting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addonRows,
  escPosToText,
  financialRows,
  formatKOT,
  formatReceipt,
  itemRows,
  pluginReceiptLines,
  renderPluginReceipt,
  resolvePrinterContext,
  selectTemplateRenderProfile,
} from '../main/printers/thermal';
import {
  applyTextSizeToRasterInput,
  renderUnsupportedRasterLines,
} from '../main/printers/raster-renderer';
import { paintRasterRequest, type RasterCanvas } from '../shared/print/raster-canvas';
import { measureEscPos } from './helpers/receipt-column-measure';
import {
  applyTextSizeToLine,
  layoutColumnsForTextSize,
  normalizePrinterTextSize,
} from '../shared/print/text-size';

const order = {
  order_number: 'ORD-20260421-0001',
  type: 'dine_in',
  created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
  table: { name: 'T3' },
  items: [
    {
      product_name: 'Cheeseburger with a very long descriptive name',
      quantity: 2,
      unit_price: 250,
      total: 540,
      tax_rate: 5,
      tax_amount: 25,
      addons: [{ name: 'Extra Cheese', price: 20 }],
      special_instructions: 'No onions',
    },
    {
      product_name: 'Fresh Lime Soda',
      quantity: 1,
      unit_price: 70,
      total: 70,
      tax_rate: 0,
      tax_amount: 0,
      addons: [],
    },
  ],
};
const bill = {
  bill_number: 'INV-20260421-0001',
  subtotal: 610,
  tax_amount: 25,
  discount_amount: 0,
  total: 635,
  payment_details: JSON.stringify([{ method: 'Cash', amount: 635 }]),
};
const business = {
  name: 'Flo Test Cafe',
  address: '42 MG Road, Bengaluru 560001',
  phone: '+91 98765 43210',
  taxRegistrationNumber: 'TAXID-0001',
  country: 'IN',
  currency: 'INR',
};

const SIZES = ['normal', 'large', 'extra_large'] as const;

function printer(textSize?: string) {
  return {
    id: 'p',
    name: 'Generic',
    connection_type: 'network',
    paper_width: 'cols-48',
    text_size: textSize,
  };
}

function render(kind: 'kot' | 'classic' | 'compact', textSize?: string): Buffer {
  const { columns, capabilities } = resolvePrinterContext(printer(textSize));
  if (kind === 'kot') {
    return formatKOT(
      order,
      order.items,
      'Main Kitchen',
      columns,
      false,
      'full',
      'en-US',
      undefined,
      [],
      false,
      'en',
      capabilities,
    );
  }
  return formatReceipt(
    order,
    bill,
    business,
    kind,
    columns,
    false,
    false,
    'full',
    [],
    false,
    'en',
    undefined,
    capabilities,
  );
}

/** ESC ! mode bytes written before text lines. */
function modes(data: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length - 2; i += 1) {
    if (data[i] === 0x1b && data[i + 1] === 0x21) out.push(data[i + 2]);
  }
  return out;
}

test('normalizePrinterTextSize falls back to normal', () => {
  assert.equal(normalizePrinterTextSize(undefined), 'normal');
  assert.equal(normalizePrinterTextSize('huge'), 'normal');
  assert.equal(normalizePrinterTextSize('large'), 'large');
  assert.equal(normalizePrinterTextSize('extra_large'), 'extra_large');
});

test('layout columns halve only for extra large', () => {
  assert.equal(layoutColumnsForTextSize(48, 'normal'), 48);
  assert.equal(layoutColumnsForTextSize(48, 'large'), 48);
  assert.equal(layoutColumnsForTextSize(48, 'extra_large'), 24);
  assert.equal(layoutColumnsForTextSize(33, 'extra_large'), 16);
});

test('normal and unset text size leave the printer context and output untouched', () => {
  for (const unset of [undefined, 'normal', 'bogus']) {
    const context = resolvePrinterContext(printer(unset));
    assert.equal(context.columns, 48);
    assert.equal(context.capabilities.textSize, undefined);
  }
  for (const kind of ['kot', 'classic', 'compact'] as const) {
    assert.deepEqual(render(kind, 'normal'), render(kind, undefined), `${kind} normal output`);
  }
});

test('applyTextSizeToLine is idempotent and skips control and blank lines', () => {
  for (const size of ['large', 'extra_large'] as const) {
    const once = applyTextSizeToLine('{CENTER}{BOLD}Hello{/BOLD}{/CENTER}', size);
    assert.equal(applyTextSizeToLine(once, size), once);
    assert.ok(once.startsWith('{CENTER}'));
    assert.ok(once.includes('{DOUBLE_HEIGHT}'));
    assert.equal(once.includes('{DOUBLE_WIDTH}'), size === 'extra_large');
    for (const passthrough of ['', '   ', '{CUT}', '{FEED}', '{INIT}', '{RAW_BYTES:AAAA}']) {
      assert.equal(applyTextSizeToLine(passthrough, size), passthrough);
    }
    assert.ok(!applyTextSizeToLine('{FONT_B}small{/FONT_B}', size).includes('{FONT_B}'));
  }
});

test('large doubles height without changing the column count', () => {
  for (const kind of ['kot', 'classic', 'compact'] as const) {
    const normal = measureEscPos(render(kind, 'normal'));
    const large = measureEscPos(render(kind, 'large'));
    assert.equal(large.unconsumedControlBytes, 0);
    assert.deepEqual(large.measuredRuleWidths, normal.measuredRuleWidths, `${kind} rule width`);
    assert.ok(large.maxCells <= 48, `${kind} large stays within 48 cells`);
    const heights = modes(render(kind, 'large')).filter((mode) => mode !== 0);
    assert.ok(
      heights.length > 0 && heights.every((mode) => (mode & 0x10) !== 0),
      `${kind} text lines are double height`,
    );
  }
});

test('extra large doubles both axes and still fits the physical paper width', () => {
  for (const kind of ['kot', 'classic', 'compact'] as const) {
    const data = render(kind, 'extra_large');
    const measured = measureEscPos(data);
    assert.equal(measured.unconsumedControlBytes, 0);
    assert.ok(
      measured.maxCells <= 48,
      `${kind} extra large stays within 48 cells (got ${measured.maxCells})`,
    );
    assert.deepEqual(measured.measuredRuleWidths, [48], `${kind} rule spans the paper`);
    const textModes = modes(data).filter((mode) => mode !== 0);
    assert.ok(
      textModes.every((mode) => (mode & 0x10) !== 0),
      `${kind} text lines are double height`,
    );
    // A layout line wider than the halved column count drops the width doubling instead of overflowing.
    const doubled = textModes.filter((mode) => (mode & 0x20) !== 0).length;
    assert.ok(doubled >= textModes.length * 0.9, `${kind} text lines are double width`);
    const normalLineCount = measureEscPos(render(kind, 'normal')).lines.length;
    assert.ok(measured.lines.length >= normalLineCount, `${kind} never loses lines`);
  }
});

test('text size also holds on 58mm paper', () => {
  const small = { ...printer('extra_large'), paper_width: 'cols-32' };
  const { columns, capabilities } = resolvePrinterContext(small);
  assert.equal(columns, 16);
  const data = formatKOT(
    order,
    order.items,
    'Main Kitchen',
    columns,
    false,
    'full',
    'en-US',
    undefined,
    [],
    false,
    'en',
    capabilities,
  );
  assert.ok(measureEscPos(data).maxCells <= 32);
});

test('raster requests carry the enlarged styles and keep groups aligned', async () => {
  const lines = ['{CENTER}{BOLD}Kitchen{/BOLD}{/CENTER}', 'Item', '', '{CUT}'];
  const groups = [
    {
      groupId: 'g0',
      lineIndex: 0,
      lineCount: 1,
      sourceLines: ['Kitchen'],
      sourceControlLines: [lines[0]],
    },
    { groupId: 'g1', lineIndex: 1, lineCount: 1 },
  ];
  assert.deepEqual(applyTextSizeToRasterInput(lines, groups, 'normal'), { lines, groups });
  for (const size of ['large', 'extra_large'] as const) {
    const enlarged = applyTextSizeToRasterInput(lines, groups, size);
    assert.equal(enlarged.lines.length, lines.length);
    assert.equal(enlarged.lines[2], '');
    assert.equal(enlarged.lines[3], '{CUT}');
    assert.equal(enlarged.groups?.[0].sourceControlLines?.[0], enlarged.lines[0]);

    const requests: any[] = [];
    const caps: any = {
      ...resolvePrinterContext({ ...printer(size), name: 'Generic' }).capabilities,
      raster: { enabled: true, widthDots: 576, maxBandHeight: 200, modes: ['mixed'] },
      representability: { scripts: ['ascii'] },
    };
    await renderUnsupportedRasterLines(
      {
        render: async (request: any) => {
          requests.push(request);
          return {
            version: 1 as const,
            requestId: request.requestId,
            ok: true as const,
            unit: { unitId: request.requestId, financial: false, complete: true, bands: [] },
          };
        },
      },
      ['{CENTER}{BOLD}مطبخ{/BOLD}{/CENTER}'].map(
        (line) => applyTextSizeToRasterInput([line], undefined, size).lines[0],
      ),
      caps,
      'text-size',
    );
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.styles?.includes('double-height')));
    assert.equal(
      requests.every((request) => request.styles?.includes('double-width')),
      size === 'extra_large',
    );
  }
});

test('pack width profiles are chosen by physical width and reflowed for extra large text', () => {
  const layout48 = {
    lineItems: {
      gap: 1,
      columns: [
        { key: 'item', label: 'ITEM', width: 24, align: 'left', wrap: true, maxLines: 2 },
        { key: 'quantity', label: 'QTY', width: 4, align: 'right' },
        { key: 'rate', label: 'RATE', width: 7, align: 'right' },
        { key: 'amount', label: 'AMOUNT', width: 10, align: 'right' },
      ],
    },
    taxSummary: {
      labelWidth: 38,
      amountWidth: 9,
    },
  };
  const payload = {
    format: 'escpos-line-template-v1',
    widthProfiles: [
      { columns: 32, layout: {} },
      { columns: 48, layout: layout48 },
    ],
  };
  const template = {
    template_id: 'pack-48-test',
    pack_id: 'pack-test',
    pack_version_id: 'pack-test-v1',
    country: 'US',
    jurisdiction: '*',
    display_name: 'Pack 48 Test',
    paper_widths_json: '[32,48]',
    renderer_json: JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
    template_payload_json: JSON.stringify(payload),
    status: 'active',
    created_at: '2026-04-21T10:30:00Z',
  };
  const packOrder = {
    order_number: 'ORD-20260421-0002',
    type: 'dine_in',
    created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
    items: [
      {
        product_name: 'Coffee',
        quantity: 2,
        unit_price: 12.34,
        total: 24.68,
        tax_breakdown: [{ title: 'VAT', rate: 5, amount: 1.23 }],
      },
    ],
  };
  const packBill = {
    bill_number: 'INV-20260421-0002',
    subtotal: 30,
    tax_amount: 1.23,
    discount_amount: 0,
    total: 31.23,
    payment_details: JSON.stringify([{ method: 'Cash', amount: 31.23 }]),
  };
  const packBusiness = {
    name: 'Flo Test Cafe',
    country: 'US',
    currency: 'USD',
    show_tax_breakdown: true,
  };

  for (const size of SIZES) {
    const { columns, capabilities } = resolvePrinterContext(printer(size));
    const warnings: any[] = [];
    const profile = selectTemplateRenderProfile(payload, columns, size, warnings);
    assert.equal(profile.columns, layoutColumnsForTextSize(48, size));
    assert.equal(warnings.length, 0, `${size} raises no width warning`);
    if (size === 'extra_large') {
      const gap = profile.layout.lineItems.gap ?? 0;
      const lineCols = profile.layout.lineItems.columns;
      const totalWidth =
        lineCols.reduce((sum: number, col: any) => sum + col.width, 0) +
        gap * Math.max(0, lineCols.length - 1);
      assert.equal(totalWidth, profile.columns, 'extra_large line-item columns fit halved width');
      assert.ok(
        profile.layout.taxSummary.labelWidth + profile.layout.taxSummary.amountWidth <=
          profile.columns,
        'extra_large taxSummary fits halved width',
      );
    } else {
      assert.equal(profile.layout, layout48, `${size} keeps the 48-column pack layout`);
    }

    const renderWarnings: any[] = [];
    const data = renderPluginReceipt(
      template,
      packOrder,
      packBill,
      packBusiness,
      columns,
      false,
      false,
      'full',
      renderWarnings,
      false,
      'en',
      capabilities,
    );
    assert.equal(renderWarnings.length, 0, `${size} renders pack receipt with no warnings`);
    const measured = measureEscPos(data);
    assert.ok(measured.maxCells <= 48, `${size} pack receipt stays within 48 cells`);
    const text = escPosToText(data);
    const lines = text.split(/\r?\n/);
    const itemLine = lines.find((line) => line.includes('Coffee'));
    assert.ok(itemLine, `${size} renders item row`);
    assert.match(itemLine, /\b2\b/, `${size} renders quantity 2 on item row`);
    assert.ok(itemLine.includes('$12.34'), `${size} renders rate $12.34 on item row`);
    assert.ok(itemLine.includes('$24.68'), `${size} renders item amount $24.68 on item row`);
    assert.ok(!itemLine.includes('..'), `${size} does not truncate item row columns`);
    const vatLine = lines.find((line) => line.includes('VAT'));
    assert.ok(vatLine, `${size} renders VAT row`);
    assert.ok(vatLine.includes('$1.23'), `${size} renders VAT $1.23 on tax summary row`);
    assert.ok(!vatLine.includes('..'), `${size} does not truncate tax summary row`);
  }
});

test('pack and standard receipts never truncate financial values across 32 and 48 columns and all text sizes', () => {
  const layout32 = {
    lineItems: {
      gap: 1,
      columns: [
        { key: 'item', label: 'ITEM', width: 12, align: 'left', wrap: true, maxLines: 2 },
        { key: 'quantity', label: 'QTY', width: 3, align: 'right' },
        { key: 'rate', label: 'RATE', width: 6, align: 'right' },
        { key: 'amount', label: 'AMOUNT', width: 8, align: 'right' },
      ],
    },
    taxSummary: {
      labelWidth: 20,
      amountWidth: 11,
    },
  };
  const layout48 = {
    lineItems: {
      gap: 1,
      columns: [
        { key: 'item', label: 'ITEM', width: 18, align: 'left', wrap: true, maxLines: 2 },
        { key: 'quantity', label: 'QTY', width: 4, align: 'right' },
        { key: 'rate', label: 'RATE', width: 8, align: 'right' },
        { key: 'taxRate', label: 'TAX%', width: 5, align: 'right' },
        { key: 'amount', label: 'AMOUNT', width: 9, align: 'right' },
      ],
    },
    taxSummary: {
      labelWidth: 34,
      amountWidth: 13,
    },
  };
  const payload = {
    format: 'escpos-line-template-v1',
    widthProfiles: [
      { columns: 32, layout: layout32 },
      { columns: 48, layout: layout48 },
    ],
  };
  const template = {
    template_id: 'pack-overflow-test',
    pack_id: 'pack-test',
    pack_version_id: 'pack-test-v1',
    country: 'US',
    jurisdiction: '*',
    display_name: 'Pack Overflow Test',
    paper_widths_json: '[32,48]',
    renderer_json: JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
    template_payload_json: JSON.stringify(payload),
    status: 'active',
    created_at: '2026-04-21T10:30:00Z',
  };
  const highValueOrder = {
    order_number: 'ORD-20260421-0003',
    type: 'dine_in',
    created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
    items: [
      {
        product_name: 'Coffee',
        quantity: 2,
        unit_price: 617.28,
        total: 1234.56,
        tax_breakdown: [{ title: 'VAT', rate: 5, amount: 61.73 }],
        addons: [{ name: 'Artisan Syrup', price: 125.5, quantity: 1 }],
      },
      {
        product_name: 'Wholesale Banquet Package',
        quantity: 1250,
        unit_price: 19.99,
        total: 24987.5,
        tax_breakdown: [
          { title: 'CGST', rate: 9, amount: 1124.44 },
          { title: 'SGST', rate: 2.5, amount: 312.34 },
        ],
        addons: [],
      },
      {
        product_name: 'Promo Adjustment',
        quantity: 1,
        unit_price: -45.5,
        total: -45.5,
        tax_breakdown: [],
        addons: [],
      },
    ],
  };
  const highValueBill = {
    bill_number: 'INV-20260421-0003',
    subtotal: 26176.56,
    tax_amount: 1498.51,
    discount_amount: 1234.56,
    total: 27252.61,
    payment_details: JSON.stringify([{ method: 'Card', amount: 27252.61 }]),
  };
  const highValueBusiness = {
    name: 'Flo Test Cafe',
    country: 'US',
    currency: 'USD',
    show_tax_breakdown: true,
  };

  for (const physicalCols of [32, 48] as const) {
    for (const size of SIZES) {
      const targetPrinter = { ...printer(size), paper_width: `cols-${physicalCols}` };
      const { columns, capabilities } = resolvePrinterContext(targetPrinter);
      const packWarnings: any[] = [];
      const packData = renderPluginReceipt(
        template,
        highValueOrder,
        highValueBill,
        highValueBusiness,
        columns,
        false,
        false,
        'full',
        packWarnings,
        false,
        'en',
        capabilities,
      );
      assert.equal(
        packWarnings.length,
        0,
        `pack ${physicalCols} cols ${size} emits no warnings`,
      );
      const measuredPack = measureEscPos(packData);
      assert.equal(measuredPack.unconsumedControlBytes, 0);
      assert.ok(
        measuredPack.maxCells <= physicalCols,
        `pack ${physicalCols} cols ${size} stays within ${physicalCols} cells (got ${measuredPack.maxCells})`,
      );
      const packText = escPosToText(packData);
      for (const expectedToken of [
        '$617.28',
        '$1,234.56',
        '1250',
        '$19.99',
        '$24,987.50',
        '$-45.50',
        'VAT @5%',
        '$61.73',
        'CGST @9%',
        'SGST @2.5%',
        '$1,124.44',
        '$312.34',
        '$26,176.56',
        '-$1,234.56',
        '$27,252.61',
      ]) {
        assert.ok(
          packText.replace(/-\s+\$/g, '-$').includes(expectedToken),
          `pack ${physicalCols} cols ${size} preserves ${expectedToken} intact`,
        );
      }
      if (physicalCols === 48) {
        assert.ok(
          packText.includes('9+2.5'),
          `pack 48 cols ${size} preserves combined taxRate 9+2.5`,
        );
      }
      const packLines = packText.split(/\r?\n/);
      for (const line of packLines) {
        if (/\$|\d+\.\d{2}/.test(line)) {
          assert.ok(
            !line.includes('..'),
            `pack ${physicalCols} cols ${size} financial line must not ellipsize: "${line}"`,
          );
        }
      }

      for (const stdKind of ['classic', 'compact'] as const) {
        const stdWarnings: any[] = [];
        const stdData = formatReceipt(
          highValueOrder,
          highValueBill,
          highValueBusiness,
          stdKind,
          columns,
          false,
          false,
          'full',
          stdWarnings,
          false,
          'en',
          undefined,
          capabilities,
        );
        assert.equal(stdWarnings.length, 0, `${stdKind} ${physicalCols} cols ${size} warnings`);
        const measuredStd = measureEscPos(stdData);
        assert.equal(measuredStd.unconsumedControlBytes, 0);
        assert.ok(
          measuredStd.maxCells <= physicalCols,
          `${stdKind} ${physicalCols} cols ${size} stays within ${physicalCols} cells (got ${measuredStd.maxCells})`,
        );
        const stdText = escPosToText(stdData);
        for (const expectedToken of [
          '$1,234.56',
          '1250',
          '$24,987.50',
          '$-45.50',
          '$251.00',
          'VAT @5%',
          '$61.73',
          'CGST @9%',
          '$1,124.44',
          '$26,176.56',
          '-$1,234.56',
          '$27,252.61',
        ]) {
          assert.ok(
            stdText.replace(/-\s+\$/g, '-$').includes(expectedToken),
            `${stdKind} ${physicalCols} cols ${size} preserves ${expectedToken} intact`,
          );
        }
      }
    }
  }
});

test('overflowing unbreakable financial values throw an explicit error before emitting bytes', () => {
  const layout32 = {
    lineItems: {
      gap: 1,
      columns: [
        { key: 'item', label: 'ITEM', width: 12, align: 'left', wrap: true, maxLines: 2 },
        { key: 'quantity', label: 'QTY', width: 3, align: 'right' },
        { key: 'rate', label: 'RATE', width: 6, align: 'right' },
        { key: 'amount', label: 'AMOUNT', width: 8, align: 'right' },
      ],
    },
    taxSummary: { labelWidth: 20, amountWidth: 11 },
  };
  const template = {
    template_id: 'pack-unbreakable-test',
    pack_id: 'pack-test',
    pack_version_id: 'pack-test-v1',
    country: 'US',
    jurisdiction: '*',
    display_name: 'Pack Unbreakable Test',
    paper_widths_json: '[32]',
    renderer_json: JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
    template_payload_json: JSON.stringify({
      format: 'escpos-line-template-v1',
      widthProfiles: [{ columns: 32, layout: layout32 }],
    }),
    status: 'active',
    created_at: '2026-04-21T10:30:00Z',
  };
  const { columns, capabilities } = resolvePrinterContext({
    ...printer('extra_large'),
    paper_width: 'cols-32',
  });
  assert.equal(columns, 16);

  const impossibleOrder = {
    order_number: 'ORD-OVERFLOW',
    type: 'dine_in',
    created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
    items: [
      {
        product_name: 'Impossible Item',
        quantity: 1,
        unit_price: 100_000_000_000.99,
        total: 100_000_000_000.99,
        addons: [],
      },
    ],
  };
  const impossibleBill = {
    bill_number: 'INV-OVERFLOW',
    subtotal: 100_000_000_000.99,
    tax_amount: 0,
    discount_amount: 0,
    total: 100_000_000_000.99,
  };
  const biz = { name: 'Flo Test Cafe', country: 'US', currency: 'USD' };

  assert.throws(
    () =>
      renderPluginReceipt(
        template,
        impossibleOrder,
        impossibleBill,
        biz,
        columns,
        false,
        false,
        'full',
        [],
        false,
        'en',
        capabilities,
      ),
    /overflows available line width/i,
  );
  assert.throws(
    () =>
      formatReceipt(
        impossibleOrder,
        impossibleBill,
        biz,
        'classic',
        columns,
        false,
        false,
        'full',
        [],
        false,
        'en',
        undefined,
        capabilities,
      ),
    /overflows available line width/i,
  );
  assert.throws(
    () => itemRows({ product_name: 'Item', quantity: 1234567890, total: 10 }, 4, 4, 8, '$'),
    /overflows available line width/i,
  );
  assert.throws(
    () => addonRows({ name: 'Addon', price: 10_000_000 }, 4, 4, 8, '$'),
    /overflows available line width/i,
  );
  assert.throws(
    () => financialRows('Total', '$123,456,789.00', 10),
    /overflows available line width/i,
  );
});

test('raster 4-column pack rows rebalance spare pixel width so large financial numbers stay on one line', async () => {
  const layout32 = {
    lineItems: {
      gap: 1,
      columns: [
        { key: 'item', label: 'ITEM', width: 12, align: 'left', wrap: true, maxLines: 2 },
        { key: 'quantity', label: 'QTY', width: 3, align: 'right' },
        { key: 'rate', label: 'RATE', width: 6, align: 'right' },
        { key: 'amount', label: 'AMOUNT', width: 8, align: 'right' },
      ],
    },
    taxSummary: { labelWidth: 20, amountWidth: 11 },
  };
  const template = {
    template_id: 'pack-raster-4col',
    pack_id: 'pack-test',
    pack_version_id: 'pack-test-v1',
    country: 'US',
    jurisdiction: '*',
    display_name: 'Pack Raster 4Col',
    paper_widths_json: '[32]',
    renderer_json: JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
    template_payload_json: JSON.stringify({
      format: 'escpos-line-template-v1',
      widthProfiles: [{ columns: 32, layout: layout32 }],
    }),
    status: 'active',
    created_at: '2026-04-21T10:30:00Z',
  };
  const { columns, capabilities } = resolvePrinterContext({
    ...printer('normal'),
    paper_width: 'cols-32',
  });
  const rasterCaps: any = {
    ...capabilities,
    raster: { enabled: true, widthDots: 384, maxBandHeight: 200, modes: ['mixed'] },
    representability: { scripts: ['ascii'] },
  };
  const packDoc = pluginReceiptLines(
    template,
    {
      order_number: 'ORD-RASTER-4COL',
      type: 'dine_in',
      created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
      items: [
        {
          product_name: 'Café',
          quantity: 2,
          unit_price: 617.28,
          total: 1234.56,
          addons: [],
        },
      ],
    },
    {
      bill_number: 'INV-RASTER-4COL',
      subtotal: 1234.56,
      tax_amount: 0,
      discount_amount: 0,
      total: 1234.56,
    },
    { name: 'Flo Test Cafe', country: 'US', currency: 'USD' },
    columns,
    false,
    false,
    [],
    false,
    'en',
    rasterCaps,
  );
  const drawnTexts: string[] = [];
  const createMockCanvas = (): RasterCanvas => ({
    width: 1,
    height: 1,
    getContext: () => ({
      font: '',
      textBaseline: 'top',
      direction: 'ltr',
      textAlign: 'left',
      fillStyle: '#000',
      measureText: (text: string) => ({ width: text.length * 12 }),
      setTransform: () => undefined,
      fillRect: () => undefined,
      fillText: (text: string) => {
        if (text) drawnTexts.push(text);
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    }),
  });
  const enlarged = applyTextSizeToRasterInput(packDoc.lines, packDoc.rasterGroups, 'normal');
  const rendered = await renderUnsupportedRasterLines(
    {
      render: async (request: any) => paintRasterRequest(request, createMockCanvas),
    },
    enlarged.lines,
    rasterCaps,
    'pack-raster',
    enlarged.groups,
  );
  assert.equal(rendered.failures.length, 0);
  assert.ok(drawnTexts.includes('$617.28'), 'raster draws full rate $617.28 without splitting');
  assert.ok(drawnTexts.includes('$1,234.56'), 'raster draws full amount $1,234.56 without splitting');

  const drawnExtraLarge: string[] = [];
  const createExtraLargeCanvas = (): RasterCanvas => ({
    width: 1,
    height: 1,
    getContext: () => ({
      font: '',
      textBaseline: 'top',
      direction: 'ltr',
      textAlign: 'left',
      fillStyle: '#000',
      measureText: (text: string) => ({ width: text.length * 12 }),
      setTransform: () => undefined,
      fillRect: () => undefined,
      fillText: (text: string) => {
        if (text) drawnExtraLarge.push(text);
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    }),
  });
  const enlargedXL = applyTextSizeToRasterInput(packDoc.lines, packDoc.rasterGroups, 'extra_large');
  const renderedXL = await renderUnsupportedRasterLines(
    {
      render: async (request: any) => paintRasterRequest(request, createExtraLargeCanvas),
    },
    enlargedXL.lines,
    rasterCaps,
    'pack-raster-xl',
    enlargedXL.groups,
  );
  assert.equal(renderedXL.failures.length, 0);
  assert.ok(drawnExtraLarge.includes('$617.28'), 'extra_large raster stacks full rate $617.28');
  assert.ok(drawnExtraLarge.includes('$1,234.56'), 'extra_large raster stacks full amount $1,234.56');

  const summaryRes = paintRasterRequest(
    {
      version: 1,
      requestId: 'summary-rebalance',
      text: 'Total $27,252.61',
      widthDots: 384,
      maxBandHeight: 200,
      direction: 'ltr',
      style: 'double-width',
      styles: ['double-height', 'double-width'],
      financial: true,
      maxLines: 8,
      layout: {
        kind: 'financial-summary',
        columns: [
          { text: 'Total', align: 'left' },
          { text: '$27,252.61', align: 'right' },
        ],
      },
    },
    createExtraLargeCanvas,
  );
  assert.equal(summaryRes.ok, true);
  assert.ok(drawnExtraLarge.includes('$27,252.61'), 'summary without widthRatio preserves $27,252.61');

  const overflowRaster = paintRasterRequest(
    {
      version: 1,
      requestId: 'summary-overflow',
      text: 'Total $100,000,000,000.99',
      widthDots: 384,
      maxBandHeight: 200,
      direction: 'ltr',
      style: 'double-width',
      styles: ['double-height', 'double-width'],
      financial: true,
      maxLines: 8,
      layout: {
        kind: 'financial-summary',
        columns: [
          { text: 'Total', align: 'left' },
          { text: '$100,000,000,000.99', align: 'right' },
        ],
      },
    },
    createExtraLargeCanvas,
  );
  assert.equal(overflowRaster.ok, false);
});

test('tax breakdown rates, space-grouped addon prices, and zero-gap/wrapped financial columns stay intact', () => {
  const zeroGapTemplate = {
    template_id: 'pack-zero-gap-wrap',
    pack_id: 'pack-test',
    pack_version_id: 'pack-test-v1',
    country: 'FR',
    jurisdiction: '*',
    display_name: 'Pack Zero Gap Wrap',
    paper_widths_json: '[32]',
    renderer_json: JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
    template_payload_json: JSON.stringify({
      format: 'escpos-line-template-v1',
      widthProfiles: [
        {
          columns: 32,
          layout: {
            lineItems: {
              gap: 0,
              columns: [
                { key: 'item', label: 'ITEM', width: 14, align: 'left', wrap: true, maxLines: 2 },
                { key: 'quantity', label: 'QTY', width: 4, align: 'right', wrap: true },
                { key: 'rate', label: 'RATE', width: 6, align: 'right', wrap: true },
                { key: 'amount', label: 'AMOUNT', width: 8, align: 'right', wrap: true },
              ],
            },
          },
        },
      ],
    }),
    status: 'active',
    created_at: '2026-04-21T10:30:00Z',
  };
  const emptyLayoutTemplate = {
    ...zeroGapTemplate,
    template_id: 'pack-empty-layout',
    template_payload_json: JSON.stringify({
      format: 'escpos-line-template-v1',
      widthProfiles: [{ columns: 32, layout: {} }],
    }),
  };
  const frOrder = {
    order_number: 'ORD-FR-1',
    type: 'dine_in',
    created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
    items: [
      {
        product_name: 'Wholesale Banquet Package',
        quantity: 1250,
        unit_price: 19.99,
        total: 24987.5,
        tax_breakdown: [{ title: 'State Goods and Services Tax', rate: 12.3456789, amount: 312.34 }],
        addons: [{ name: 'Artisan Syrup Extra', price: 1234.56, quantity: 1 }],
      },
    ],
  };
  const frBill = {
    bill_number: 'INV-FR-1',
    subtotal: 26222.06,
    tax_amount: 312.34,
    discount_amount: 0,
    total: 26534.4,
  };
  const frBiz = {
    name: 'Flo Test Cafe',
    country: 'FR',
    currency: 'EUR',
    show_tax_breakdown: true,
  };

  for (const size of SIZES) {
    const { columns, capabilities } = resolvePrinterContext({
      ...printer(size),
      paper_width: 'cols-32',
    });
    for (const tmpl of [zeroGapTemplate, emptyLayoutTemplate]) {
      const data = renderPluginReceipt(
        tmpl,
        frOrder,
        frBill,
        frBiz,
        columns,
        false,
        false,
        'full',
        [],
        false,
        'en',
        capabilities,
      );
      const measured = measureEscPos(data);
      assert.ok(measured.maxCells <= 32, `${tmpl.template_id} ${size} fits 32 cells`);
      const text = escPosToText(data);
      assert.ok(text.includes('@12.3456789%'), `${tmpl.template_id} ${size} preserves @12.3456789%`);
      assert.ok(text.includes('EUR1 234,56'), `${tmpl.template_id} ${size} preserves addon EUR1 234,56 on one line`);
      assert.ok(text.includes('EUR24 987,50'), `${tmpl.template_id} ${size} preserves item EUR24 987,50`);
      assert.ok(!text.includes('1250EUR'), `${tmpl.template_id} ${size} separates quantity and amount`);
    }
    for (const stdKind of ['classic', 'compact'] as const) {
      const stdData = formatReceipt(
        frOrder,
        frBill,
        frBiz,
        stdKind,
        columns,
        false,
        false,
        'full',
        [],
        false,
        'en',
        undefined,
        capabilities,
      );
      const measuredStd = measureEscPos(stdData);
      assert.ok(measuredStd.maxCells <= 32, `${stdKind} ${size} fits 32 cells`);
      const stdText = escPosToText(stdData);
      assert.ok(stdText.includes('@12.3456789%'), `${stdKind} ${size} preserves @12.3456789%`);
      assert.ok(stdText.includes('EUR1 234,56'), `${stdKind} ${size} preserves addon EUR1 234,56`);
    }
  }

  const xlCtx = resolvePrinterContext({ ...printer('extra_large'), paper_width: 'cols-32' });
  const impossibleTaxOrder = {
    ...frOrder,
    items: [
      {
        ...frOrder.items[0],
        tax_breakdown: [{ title: 'Tax', rate: '12.345678901234567', amount: 1 }],
      },
    ],
  };
  assert.throws(
    () =>
      formatReceipt(
        impossibleTaxOrder,
        frBill,
        frBiz,
        'classic',
        xlCtx.columns,
        false,
        false,
        'full',
        [],
        false,
        'en',
        undefined,
        xlCtx.capabilities,
      ),
    /overflows available line width/i,
  );
  assert.throws(
    () =>
      renderPluginReceipt(
        zeroGapTemplate,
        impossibleTaxOrder,
        frBill,
        frBiz,
        xlCtx.columns,
        false,
        false,
        'full',
        [],
        false,
        'en',
        xlCtx.capabilities,
      ),
    /overflows available line width/i,
  );
});
