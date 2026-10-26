/**
 * Per-printer text size: ESC/POS and raster output for normal, large and extra large,
 * and the guarantee that normal output is byte-identical to a printer with no setting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escPosToText,
  formatKOT,
  formatReceipt,
  renderPluginReceipt,
  resolvePrinterContext,
  selectTemplateRenderProfile,
} from '../main/printers/thermal';
import {
  applyTextSizeToRasterInput,
  renderUnsupportedRasterLines,
} from '../main/printers/raster-renderer';
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
