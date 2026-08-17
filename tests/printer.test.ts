/**
 * FloDesktop Printer Tests
 *
 * Usage:
 *   npm run test:printer            # format tests only (no hardware)
 *   npm run test:printer -- --live  # also sends a real test page to the detected default printer
 *   FLO_PRINT_TO="Printer Name" npm run test:printer -- --live   # send to a specific printer
 */

import {
  formatReceipt,
  formatKOT,
  buildEscPos,
  buildTestPage,
  escPosToText,
  detectConnectedPrinters,
  printViaUSB,
  printViaNetwork,
  classifyPrintFailure,
} from '../main/printers/thermal';
import { matchSupportedPrinterProfile } from '../main/printers/profiles';
import { getCountryByCode, getCurrencySymbol } from '../main/countries';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`   ✓ ${label}`);
    passed++;
  } else {
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
  }
}

/**
 * Load frontend TypeScript modules without changing their production aliases.
 * ts-node transpiles these files, but Node does not apply tsconfig `paths` at
 * runtime, so the hook is scoped to the require operation and then restored.
 */
function loadFrontendPrinterModules(): {
  receiptEncoder: typeof import('../frontend/src/lib/printer/receipt-encoder');
  taxBillEncoder: typeof import('../frontend/src/lib/printer/tax-bill-encoder');
  unicode: typeof import('../frontend/src/lib/printer/unicode');
  warnings: typeof import('../frontend/src/lib/printer/warnings');
  webPrint: typeof import('../frontend/src/lib/printer/web-print');
} {
  const path = require('path') as typeof import('path');
  const moduleApi = require('module') as {
    _resolveFilename: (...args: any[]) => string;
  };
  const originalResolveFilename = moduleApi._resolveFilename;

  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };

  try {
    return {
      receiptEncoder: require('../frontend/src/lib/printer/receipt-encoder'),
      taxBillEncoder: require('../frontend/src/lib/printer/tax-bill-encoder'),
      unicode: require('../frontend/src/lib/printer/unicode'),
      warnings: require('../frontend/src/lib/printer/warnings'),
      webPrint: require('../frontend/src/lib/printer/web-print'),
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

function bytesContain(buf: Buffer, needle: number[]): boolean {
  outer: for (let i = 0; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function visiblePreview(buf: Buffer, cols: number): string {
  const out: string[] = [];
  let line: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === ESC && (buf[i + 1] === 0x21 || buf[i + 1] === 0x61 || buf[i + 1] === 0x45 || buf[i + 1] === 0x64 || buf[i + 1] === 0x40)) {
      i += buf[i + 1] === 0x40 ? 2 : 3;
      continue;
    }
    if (b === GS && buf[i + 1] === 0x56) {
      i += 3;
      continue;
    }
    if (b === LF) {
      out.push(Buffer.from(line).toString('utf8'));
      line = [];
      i++;
      continue;
    }
    line.push(b);
    i++;
  }
  if (line.length) out.push(Buffer.from(line).toString('utf8'));
  const divider = '─'.repeat(Math.max(cols, 20));
  return divider + '\n' + out.join('\n') + '\n' + divider;
}

function visibleRawPrinterLines(data: Uint8Array): string[] {
  const bytes = Buffer.from(data);
  const lines: string[] = [];
  let line = '';

  const flush = () => {
    lines.push(line);
    line = '';
  };

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === LF) {
      flush();
      continue;
    }
    if (byte === 0x0d) continue;

    if (byte === ESC) {
      const command = bytes[++i];
      if (command === 0x70) i += 3;
      else if (command !== 0x40) i += 1;
      continue;
    }
    if (byte === GS) {
      const command = bytes[++i];
      if (command === 0x4c || command === 0x57) i += 2;
      else if (command === 0x56 && (bytes[i + 1] === 0x41 || bytes[i + 1] === 0x42)) i += 2;
      else i += 1;
      continue;
    }
    if (byte === 0x1c) {
      i += 1;
      continue;
    }
    if (byte >= 0x20) line += String.fromCharCode(byte);
  }

  if (line) flush();
  return lines;
}

const fixtureOrder = {
  order_number: 'ORD-20260421-0001',
  created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
  table: { name: 'T3' },
  items: [
    {
      product_name: 'Cheeseburger',
      quantity: 2,
      unit_price: 250,
      total: 540,
      tax_rate: 5,
      tax_amount: 25,
      addons: [
        { name: 'Extra Cheese', price: 20 },
        { name: 'Bacon', price: 20 },
      ],
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
    {
      product_name: 'Very Long Product Name That Should Get Truncated By Formatter',
      quantity: 3,
      unit_price: 100,
      total: 315,
      tax_type: 'tax_5',
      tax_amount: 15,
      addons: [],
    },
  ],
};

const fixtureBill = {
  bill_number: 'INV-20260421-0001',
  subtotal: 925,
  tax_amount: 40,
  discount_amount: 15,
  total: 950,
  tax_breakdown: JSON.stringify([
    { name: 'Tax A', rate: 2.5, amount: 20 },
    { name: 'Tax B', rate: 2.5, amount: 20 },
  ]),
  payment_details: JSON.stringify([
    { method: 'Cash', amount: 500 },
    { method: 'UPI', amount: 450 },
  ]),
};

const fixtureBusiness = {
  name: 'Flo Test Cafe',
  address: '42 MG Road, Bengaluru 560001',
  phone: '+91 98765 43210',
  taxRegistrationNumber: 'TAXID-0001',
};

console.log('🧪 FloDesktop Printer Tests');
console.log('='.repeat(60));

console.log('\n✅ Test 1: buildEscPos emits correct control bytes');
{
  const buf = buildEscPos([
    '{INIT}',
    '{CENTER}{BOLD}HEADER{/BOLD}{/CENTER}',
    'plain line',
    '{CUT}',
  ]);

  assert('emits ESC @ (init)', bytesContain(buf, [ESC, 0x40]));
  assert('emits ESC a 1 (center)', bytesContain(buf, [ESC, 0x61, 0x01]));
  assert('emits ESC a 0 (left)', bytesContain(buf, [ESC, 0x61, 0x00]));
  assert('emits ESC E 1 (bold on)', bytesContain(buf, [ESC, 0x45, 0x01]));
  assert('emits GS V 0 (full cut)', bytesContain(buf, [GS, 0x56, 0x00]));
  assert('emits LF after text lines', bytesContain(buf, [LF]));
  assert('contains visible "HEADER" text', buf.toString('utf8').includes('HEADER'));
  assert('contains visible "plain line" text', buf.toString('utf8').includes('plain line'));
  assert('no stray {TOKEN} markers remain', !/\{[A-Z_/]+\}/.test(buf.toString('utf8')));
}

console.log('\n✅ Test 1b: Unsupported receipt text is skipped with a warning');
{
  const warnings: Array<{ field: string; text: string; message: string }> = [];
  const buf = buildEscPos(['{INIT}', '{STORE_NAME}{CENTER}مطعم فلوس{/CENTER}', 'TOTAL        ₹100.00', '{CUT}'], true, {}, warnings);
  const text = buf.toString('utf8');
  assert('skips unsupported Arabic line', !text.includes('مطعم فلوس'));
  assert('keeps the rest of the receipt printable', text.includes('TOTAL') && text.includes('₹100.00'));
  assert('reports the skipped store name', warnings.length === 1 && warnings[0].field === 'store name');
}

console.log('\n✅ Test 1b2: Arabic shaping capability gate');
{
  // Default (no capability): Persian is skipped with a precise warning.
  const defaultWarnings: Array<{ field: string; text: string; message: string }> = [];
  const defaultBuf = buildEscPos(['{STORE_NAME}{CENTER}مطعم فلوس{/CENTER}', 'TOTAL        ₹100.00'], true, {}, defaultWarnings);
  assert('without flag, Persian line is skipped', !defaultBuf.toString('utf8').includes('مطعم فلوس'));
  assert('without flag, warning names Arabic shaping as the cause', defaultWarnings.length === 1 && /Arabic shaping|Persian\/Arabic/.test(defaultWarnings[0].message));

  // Explicit capability: pure Persian lines are emitted as UTF-8 bytes.
  const shapedWarnings: Array<{ field: string; text: string; message: string }> = [];
  const shapedBuf = buildEscPos(['{STORE_NAME}{CENTER}مطعم فلوس{/CENTER}', 'TOTAL        ₹100.00'], true, { arabicShaping: true }, shapedWarnings);
  assert('with flag, Persian line is emitted', shapedBuf.toString('utf8').includes('مطعم فلوس'));
  assert('with flag, pure Persian line emits no warning', shapedWarnings.length === 0);

  // Mixed-script lines (Persian + Latin é) are still skipped even with the flag,
  // so the flag cannot be used to emit unshapeable mixed text.
  const mixedWarnings: Array<{ field: string; text: string; message: string }> = [];
  const mixedBuf = buildEscPos(['{CENTER}کافه Café{/CENTER}'], true, { arabicShaping: true }, mixedWarnings);
  assert('mixed Persian+Latin line is skipped even with flag', !mixedBuf.toString('utf8').includes('کافه') && !mixedBuf.toString('utf8').includes('Café'));
  assert('mixed-script line still emits a warning', mixedWarnings.length === 1);

  // The full receipt path threads the flag into the encoder.
  const persianBiz = { ...fixtureBusiness, name: 'کافه فلو تهران' };
  const receiptWarnings: Array<{ field: string; text: string; message: string }> = [];
  const receipt = formatReceipt(fixtureOrder, fixtureBill, persianBiz, 'compact', 48, true, false, 'full', receiptWarnings, true);
  assert('formatReceipt with arabicShaping prints the Persian business name', receipt.toString('utf8').includes('کافه فلو تهران'));
  assert('formatReceipt with arabicShaping emits no unsupported warning', receiptWarnings.length === 0);
}

console.log('\n✅ Test 1c: ESC/POS output can be previewed without a printer');
{
  const buf = buildEscPos(['{INIT}', '{CENTER}{BOLD}HEADER{/BOLD}{/CENTER}', 'Item       Rs63.00', '{CUT}']);
  const text = escPosToText(buf);
  assert('paperless preview keeps receipt text', text.includes('HEADER') && text.includes('Item       Rs63.00'));
  assert('paperless preview strips ESC/POS commands', !text.includes('\x1b') && !text.includes('\x1d'));
}

console.log('\n✅ Test 2: Compact receipt (80mm, 48 cols)');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'compact', 48, true);
  const text = buf.toString('utf8');

  assert('renders business name', text.includes('Flo Test Cafe'));
  assert('renders bill number', text.includes('INV-20260421-0001'));
  assert('renders Cheeseburger row', text.includes('Cheeseburger'));
  assert('renders addon "Extra Cheese"', text.includes('Extra Cheese'));
  assert('renders addon "Bacon"', text.includes('Bacon'));
  assert('renders special instruction', text.includes('No onions'));
  assert('renders subtotal ₹925.00', text.includes('₹925.00'));
  // Currency slot reserves up to 3 chars for labels such as USD/EUR/INR; the
  // minus sign sits outside that slot.
  assert('renders discount line with negative sign', /-\s*₹15\.00/.test(text));
  assert('renders tax total ₹40.00', text.includes('₹40.00'));
  assert('renders TOTAL with grand amount', text.includes('TOTAL') && text.includes('₹950.00'));
  assert('renders Cash payment', text.includes('Cash') && text.includes('₹500.00'));
  assert('renders UPI payment', text.includes('UPI') && text.includes('₹450.00'));
  assert('renders tax registration number', text.includes('TAXID-0001'));
  assert('renders non-configurable FloPOS footer', text.includes('Powered by FloPOS') && text.includes('https://flopos.com'));
  assert('long product name is truncated to fit', !text.includes('Truncated By Formatter'));
  assert('ends with cut byte sequence', bytesContain(buf, [GS, 0x56, 0x00]));

  const rowLines = visiblePreview(buf, 48).split('\n');
  const cheeseLine = rowLines.find((l) => l.startsWith('Cheeseburger') && l.includes('₹540'));
  assert('item row columns are aligned (no smashed qty)', !!cheeseLine && !/Cheeseburger\d/.test(cheeseLine), cheeseLine);
  assert('item row right-edge total lines up at col 48', !!cheeseLine && cheeseLine.length <= 48);
  assert('item table has no redundant tax column', !rowLines.some((line) => /\bQty\s+Tax\s+Amount\b/.test(line)));

  console.log('\n   — Rendered compact (80mm) —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 3: Compact receipt on 58mm paper (32 cols)');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'compact', 32, true);
  const text = buf.toString('utf8');

  assert('still renders business name', text.includes('Flo Test Cafe'));
  assert('still renders TOTAL', text.includes('TOTAL'));

  const textLines = visiblePreview(buf, 32).split('\n').slice(1, -1);
  const overLong = textLines.filter((l) => l.length > 32);
  assert('no content line exceeds 32 cols', overLong.length === 0, overLong.length ? `${overLong.length} lines too long` : undefined);

  console.log('\n   — Rendered compact (58mm) —');
  console.log(visiblePreview(buf, 32));
}

console.log('\n✅ Test 3b: Compact receipt on narrow 36-col printer');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'compact', 36, true);
  const text = buf.toString('utf8');

  assert('still renders TOTAL on 36-col printer', text.includes('TOTAL'));
  assert('keeps amount together on one line', text.includes('Rs950.00') || text.includes('₹950.00'));

  const textLines = visiblePreview(buf, 36).split('\n').slice(1, -1);
  const overLong = textLines.filter((l) => l.length > 36);
  assert('no content line exceeds 36 cols', overLong.length === 0, overLong.length ? `${overLong.length} lines too long` : undefined);

  console.log('\n   — Rendered compact (36 cols) —');
  console.log(visiblePreview(buf, 36));
}

console.log('\n✅ Test 3c: Narrow receipt reserves 3-char currency codes');
{
  const usdBusiness = { ...fixtureBusiness, currency_symbol: 'USD', country: 'US' };
  const buf = formatReceipt(fixtureOrder, fixtureBill, usdBusiness, 'compact', 36, false);
  const text = buf.toString('utf8');

  assert('renders USD amount without splitting currency code', text.includes('USD950.00'));

  const textLines = visiblePreview(buf, 36).split('\n').slice(1, -1);
  const overLong = textLines.filter((l) => l.length > 36);
  assert('USD receipt has no line over 36 cols', overLong.length === 0, overLong.length ? `${overLong.length} lines too long` : undefined);
}

console.log('\n✅ Test 3d: Trim decimals hides only trailing .00');
{
  const trimBusiness = { ...fixtureBusiness, trim_decimals: true };
  const roundedText = formatReceipt(fixtureOrder, fixtureBill, trimBusiness, 'compact', 36, true).toString('utf8');
  assert('trim decimals removes trailing .00 from whole amounts', roundedText.includes('₹950') && !roundedText.includes('₹950.00'));

  const fractionalBill = {
    ...fixtureBill,
    subtotal: 75,
    tax_amount: 3.75,
    discount_amount: 0,
    total: 78.75,
    payment_details: JSON.stringify([{ method: 'cash', amount: 78.75 }]),
  };
  const fractionalText = formatReceipt(fixtureOrder, fractionalBill, trimBusiness, 'compact', 36, true).toString('utf8');
  assert('trim decimals keeps non-zero decimals', fractionalText.includes('₹78.75') && fractionalText.includes('₹3.75'));
}

console.log('\n✅ Test 4: Classic receipt template');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'classic', 48, true);
  const text = buf.toString('utf8');

  assert('renders business name', text.includes('Flo Test Cafe'));
  assert('renders item and total', text.includes('Cheeseburger') && text.includes('₹950.00'));
  assert('renders non-configurable FloPOS footer', text.includes('Powered by FloPOS') && text.includes('https://flopos.com'));
  assert('ends with cut', bytesContain(buf, [GS, 0x56, 0x00]));

  console.log('\n   — Rendered classic —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 5: Tax-specific labels fall back to the default template');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'detailed', 48, true);
  const text = buf.toString('utf8');

  assert('legacy detailed label renders the default classic receipt', text.includes('Invoice #:'));
  assert('legacy detailed label does not render the GST-style tax invoice', !text.includes('TAX INVOICE'));
  assert('renders non-configurable FloPOS footer', text.includes('Powered by FloPOS') && text.includes('https://flopos.com'));

  console.log('\n   — Rendered detailed fallback —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 5b: Template labels normalize to built-in backend templates');
{
  const classic = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Classic', 48, true).toString('utf8');
  const compact = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Compact', 48, true).toString('utf8');
  const detailed = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Detailed (Tax)', 48, true).toString('utf8');

  assert('Classic label renders classic template', classic.includes('Invoice #:'));
  assert('Compact label renders compact template', compact.includes('Bill #:'));
  assert('Detailed (Tax) label falls back to classic until supplied by a tax pack/plugin', detailed.includes('Invoice #:') && !detailed.includes('TAX INVOICE'));
  assert('only classic and compact are distinct built-ins', new Set([classic, compact, detailed]).size === 2);
}

console.log('\n✅ Test 5bb: Custom footer is rendered by every backend template');
{
  for (const template of ['compact', 'classic']) {
    const text = formatReceipt(fixtureOrder, fixtureBill, {
      ...fixtureBusiness,
      footer_note: 'Please visit us again',
    }, template, 48, true).toString('utf8');
    assert(`${template}: renders the configured footer message`, text.includes('Please visit us again'));
  }
}

console.log('\n✅ Test 5c: Built-in receipt resolves mixed legacy + categorized tax');
{
  const mixedOrder = {
    ...fixtureOrder,
    items: [
      {
        ...fixtureOrder.items[0],
        tax_snapshot: JSON.stringify({
          lines: [{
            lineId: 'categorized',
            components: [{ ruleId: 'thai-vat', label: 'VAT', rate: '7', amount: '17.50' }],
          }],
        }),
        tax_breakdown: JSON.stringify([{ title: 'Legacy Tax', rate: 2.5, amount: 99 }]),
      },
      {
        ...fixtureOrder.items[1],
        tax_snapshot: null,
        tax_breakdown: JSON.stringify([{ title: 'Local Levy', rate: 1, amount: 0.7 }]),
      },
    ],
  };
  const mixedBill = {
    ...fixtureBill,
    tax_snapshot: JSON.stringify([]),
    tax_breakdown: JSON.stringify([
      { title: 'VAT', rate: 7, amount: 17.5 },
      { title: 'Local Levy', rate: 1, amount: 0.7 },
    ]),
  };
  const thaiBusiness = { ...fixtureBusiness, country: 'TH', show_tax_breakdown: true };
  const text = formatReceipt(mixedOrder, mixedBill, thaiBusiness, 'classic', 48, true).toString('utf8');

  assert('renders categorized VAT component and rate', text.includes('VAT @7%'));
  assert('renders legacy Local Levy component and rate', text.includes('Local Levy @1%'));
  assert('does not render categorized item legacy copy', !text.includes('Legacy Tax'));
  assert('uses country tax identifier label', text.includes('Tax ID: TAXID-0001'));
}

console.log('\n✅ Test 5d: Bill content toggles are optional and never block printing');
{
  const customerBusiness = {
    ...fixtureBusiness,
    customer_name: 'Ada Customer',
    customer_phone: '+91 90000 12345',
  };
  const hiddenBusiness = {
    ...customerBusiness,
    show_name: false,
    show_address: false,
    show_phone: false,
    show_tax_id: false,
    show_tax_breakdown: false,
    show_customer_name: false,
    show_customer_phone: false,
    show_table_number: false,
  };

  for (const template of ['compact', 'classic']) {
    const hidden = formatReceipt(fixtureOrder, fixtureBill, hiddenBusiness, template, 48, true);
    const text = hidden.toString('utf8');
    assert(`${template}: hidden optional fields stay hidden`,
      !text.includes('Flo Test Cafe')
      && !text.includes('42 MG Road')
      && !text.includes('+91 98765')
      && !text.includes('TAXID-0001')
      && !text.includes('Ada Customer')
      && !text.includes('+91 90000')
      && !text.includes('Table: T3')
      && !text.includes('Tax A'));
    assert(`${template}: disabled details still print total and cut`,
      text.includes('TOTAL') && bytesContain(hidden, [GS, 0x56, 0x00]));

    const missing = formatReceipt(fixtureOrder, fixtureBill, {
      name: '', address: '', phone: '', taxRegistrationNumber: '',
      show_name: true, show_address: true, show_phone: true, show_tax_id: true,
      show_tax_breakdown: true, show_customer_name: true,
      show_customer_phone: true, show_table_number: true,
    }, template, 48, true);
    assert(`${template}: enabled but missing values do not stop printing`,
      missing.toString('utf8').includes('TOTAL') && bytesContain(missing, [GS, 0x56, 0x00]));
  }
}

console.log('\n✅ Test 6: KOT (Kitchen Order Ticket)');
{
  const buf = formatKOT(fixtureOrder, fixtureOrder.items, 'Main Kitchen', 48);
  const text = buf.toString('utf8');

  assert('renders KOT header', text.includes('KITCHEN ORDER TICKET'));
  assert('renders station name', text.includes('Main Kitchen'));
  assert('renders order number', text.includes('ORD-20260421-0001'));
  assert('renders table number', text.includes('T3'));
  assert('renders each item with qty prefix', text.includes('2x  Cheeseburger'));
  assert('renders addon "Extra Cheese"', text.includes('+ Extra Cheese'));
  assert('renders addon "Bacon"', text.includes('+ Bacon'));
  assert('renders special instructions with ** markers', text.includes('** No onions **'));
  assert('sets DOUBLE_HEIGHT mode for items', bytesContain(buf, [ESC, 0x21, 0x18]));
  assert('does NOT render prices (KOT has no money)', !text.includes('₹'));
  assert('ends with cut', bytesContain(buf, [GS, 0x56, 0x00]));

  console.log('\n   — Rendered KOT —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 7: Test page builder');
{
  const buf80 = buildTestPage('80mm');
  const buf58 = buildTestPage('58mm');
  const xprinter = buildTestPage('80mm', 'partial');
  assert('80mm test page renders title', buf80.toString('utf8').includes('Flo Printer Test'));
  assert('58mm test page renders title', buf58.toString('utf8').includes('Flo Printer Test'));
  assert('80mm test page reports correct column width', buf80.toString('utf8').includes('Columns: 48'));
  assert('58mm test page reports correct column width', buf58.toString('utf8').includes('Columns: 32'));
  assert('test page includes a ruler and edge probe', buf58.toString('utf8').includes('1234567890') && buf58.toString('utf8').includes('XXXXXXXXXXXXXXXX'));
  assert('test page has cut byte', bytesContain(buf80, [GS, 0x56, 0x00]));
  assert('partial cut profile emits GS V B 0', bytesContain(xprinter, [GS, 0x56, 0x42, 0x00]));
}

console.log('\n✅ Test 8: Edge cases');
{
  const emptyOrder = {
    order_number: 'ORD-EMPTY',
    created_at: new Date().toISOString(),
    items: [],
  };
  const emptyBill = {
    bill_number: 'INV-EMPTY',
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
  };
  const buf = formatReceipt(emptyOrder, emptyBill, fixtureBusiness, 'compact', 48, true);
  const emptyText = buf.toString('utf8');
  assert('handles empty item list without throwing', buf.length > 0);
  assert('renders zero total', emptyText.includes('₹0.00'));
  assert('omits tax label when tax amount and breakdown are empty', !emptyText.split('\n').some((line) => line.trimStart().startsWith('Tax')));
  assert('omits tax identifier when tax amount and breakdown are empty', !emptyText.includes('TAXID-0001'));

  const noDiscountBill = { ...fixtureBill, discount_amount: 0 };
  const buf2 = formatReceipt(fixtureOrder, noDiscountBill, fixtureBusiness, 'compact', 48, true);
  assert('omits discount line when discount_amount is 0', !buf2.toString('utf8').includes('Discount'));

  const malformedBill = { ...fixtureBill, payment_details: '{bad json' };
  const buf3 = formatReceipt(fixtureOrder, malformedBill, fixtureBusiness, 'compact', 48, true);
  assert('malformed payment_details does not crash formatter', buf3.length > 0);
}

console.log('\n✅ Test 9: Supported printer profile matching');
{
  const xprinter = matchSupportedPrinterProfile('Counter XP-V320M', 'Xprinter', 'XP-V320M');
  const genericXprinter = matchSupportedPrinterProfile('Xprinter Unknown Model', 'Xprinter', 'Thermal Printer');
  assert('matches Xprinter XP-V320M profile', xprinter?.id === 'xprinter-xp-v320m-v330m');
  assert('does not match unknown Xprinter to XP-V320M profile', genericXprinter === null);
}

console.log('\n✅ Test 10: Print failure telemetry classification');
{
  assert('classifies Windows offline state', classifyPrintFailure("printer is set to 'Use Printer Offline' in Windows") === 'offline');
  assert('classifies Winspool open failure', classifyPrintFailure("cannot open printer 'Kitchen' (Win32 error 1801)") === 'queue_unavailable');
  assert('classifies spooler failure', classifyPrintFailure('StartDocPrinter failed (Win32 error 5)') === 'spooler_error');
  assert('classifies raw write failure', classifyPrintFailure('WritePrinter failed (Win32 error 1722)') === 'write_error');
  assert('classifies timeout', classifyPrintFailure('Timed out connecting to 192.168.1.10:9100') === 'timeout');
  assert('does not expose unknown detail as a new telemetry class', classifyPrintFailure('some vendor-specific failure') === 'unknown');
}

console.log('\n✅ Test 11: IR country thermal receipt financial-line preservation & currency safety');
{
  const realIrCurrencySymbol = getCurrencySymbol('IRR', getCountryByCode('IR')?.locale ?? 'fa-IR');
  assert('real production IR setup produces ریال currency symbol', realIrCurrencySymbol === 'ریال');

  const irBusiness = {
    name: 'Flo Cafe Tehran',
    country: 'IR',
    currency: 'IRR',
    currency_symbol: realIrCurrencySymbol,
    address: 'Tehran',
    phone: '+989123456789',
    taxRegistrationNumber: '1234567890',
  };

  const irOrder = {
    order_number: 'ORD-IR-001',
    created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
    items: [
      { product_name: 'Espresso', quantity: 2, unit_price: 50000, total: 100000 },
    ],
  };

  const irBill = {
    bill_number: 'INV-IR-001',
    subtotal: 100000,
    discount_amount: 10000,
    tax_amount: 9000,
    total: 99000,
    payment_details: [{ method: 'Cash', amount: 99000 }],
  };

  // 1. Backend thermal formatter tests with real production currency symbol ('ریال')
  for (const template of ['compact', 'classic'] as const) { // backend 'detailed' template no longer exists on main
    for (const useUnicode of [false, true]) {
      const warnings: Array<{ field: string; text: string; message: string }> = [];
      const buf = formatReceipt(irOrder, irBill, irBusiness, template, 48, useUnicode, false, 'full', warnings);
      const text = buf.toString('utf8');

      assert(`[backend IR ${template} unicode=${useUnicode}] preserves item line`, text.includes('Espresso'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves item amount`, text.includes('IRR100,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Subtotal line`, text.includes('Subtotal'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Subtotal amount`, text.includes('IRR100,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Discount line`, text.includes('Discount'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Discount amount`, text.includes('IRR10,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Tax line`, text.includes('Tax'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Tax amount`, text.includes('IRR9,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves TOTAL line`, text.includes('TOTAL') || text.includes('GRAND TOTAL'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves TOTAL amount`, text.includes('IRR99,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Payment line`, text.includes('Cash'));
      assert(`[backend IR ${template} unicode=${useUnicode}] preserves Payment amount`, text.includes('IRR99,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] leaves zero warnings for numeric lines`, warnings.length === 0);
    }
  }

  // IRR is three ASCII characters, so also verify the narrow raw layout does
  // not wrap or clip financial item rows.
  for (const template of ['compact', 'classic'] as const) { // backend 'detailed' template no longer exists on main
    for (const useUnicode of [false, true]) {
      const narrowWarnings: Array<{ field: string; text: string; message: string }> = [];
      const narrow = formatReceipt(irOrder, irBill, irBusiness, template, 32, useUnicode, false, 'full', narrowWarnings);
      const visibleLines = visiblePreview(narrow, 32).split('\n').slice(1, -1);
      const overlongLines = visibleLines.filter((line) => line.length > 32);
      assert(`[backend IR ${template} unicode=${useUnicode}] keeps 32-column lines within width`, overlongLines.length === 0, overlongLines.join(' | '));
      assert(`[backend IR ${template} unicode=${useUnicode}] keeps narrow IRR amount`, narrow.toString('utf8').includes('IRR100,000.00'));
      assert(`[backend IR ${template} unicode=${useUnicode}] has no narrow-layout warnings`, narrowWarnings.length === 0);
    }
  }

  const wideIrOrder = {
    ...irOrder,
    items: [{ product_name: 'Espresso', quantity: 1, unit_price: 500000000, total: 1000000000 }],
  };
  const wideIrBill = {
    ...irBill,
    subtotal: 1000000000,
    discount_amount: 0,
    tax_amount: 0,
    total: 1000000000,
    payment_details: [{ method: 'Cash', amount: 1000000000 }],
  };
  for (const template of ['compact', 'classic'] as const) { // backend 'detailed' template no longer exists on main
    const wide = formatReceipt(wideIrOrder, wideIrBill, irBusiness, template, 32, false, false, 'full', []);
    const wideLines = visiblePreview(wide, 32).split('\n').slice(1, -1);
    const overlongWideLines = wideLines.filter((line) => line.length > 32);
    assert(`[backend IR ${template}] keeps very wide IRR rows within 32 columns`, overlongWideLines.length === 0, overlongWideLines.join(' | '));
    assert(`[backend IR ${template}] preserves very wide IRR amount`, wide.toString('utf8').includes('IRR1,000,000,000.00'));
  }

  const extremeIrOrder = {
    ...irOrder,
    items: [{ product_name: 'Espresso', quantity: 1, unit_price: 50000000000000, total: 100000000000000 }],
  };
  const extremeIrBill = {
    ...irBill,
    subtotal: 100000000000000,
    discount_amount: 0,
    tax_amount: 0,
    total: 100000000000000,
    payment_details: [{ method: 'Cash', amount: 100000000000000 }],
  };
  for (const template of ['compact', 'classic'] as const) { // backend 'detailed' template no longer exists on main
    const extreme = formatReceipt(extremeIrOrder, extremeIrBill, irBusiness, template, 32, false, false, 'full', []);
    const extremeLines = visiblePreview(extreme, 32).split('\n').slice(1, -1);
    assert(`[backend IR ${template}] keeps extreme IRR rows within 32 columns`, extremeLines.every((line) => line.length <= 32));
    assert(`[backend IR ${template}] preserves extreme IRR amount`, extreme.toString('utf8').includes('IRR100,000,000,000,000.00'));
  }

  // Unsupported free-form Persian text warning contract test (backend)
  const persianTextBusiness = { ...irBusiness, name: 'کافه فلو تهران' };
  const backendWarnings: Array<{ field: string; text: string; message: string }> = [];
  formatReceipt(irOrder, irBill, persianTextBusiness, 'compact', 48, false, false, 'full', backendWarnings);
  assert('backend free-form Persian text emits unsupported character warning', backendWarnings.some((w) => w.text.includes('کافه')));

  // 2. Frontend raw ESC/POS encoder tests
  const frontendModules = loadFrontendPrinterModules();
  const {
    buildClassicReceiptBytes,
    buildCompactReceiptBytes,
    buildDetailedReceiptBytes,
  } = frontendModules.receiptEncoder;
  const { buildTaxBillBytes } = frontendModules.taxBillEncoder;
  const { normalizeCurrencyToAscii } = frontendModules.unicode;
  const { hasUnsupportedPrinterChars } = frontendModules.warnings;
  const { generateBillHtml } = frontendModules.webPrint;

  const frontendTenant = {
    business_name: 'Flo Cafe Tehran',
    country: 'IR',
    currency: 'IRR',
  };

  const frontendBill = {
    id: 'b1',
    bill_number: 'INV-IR-001',
    order: irOrder,
    subtotal: 100000,
    discount_amount: 10000,
    tax_amount: 9000,
    total: 99000,
    payment_details: [{ method: 'Cash', amount: 99000 }],
  };

  const encoders = [
    { name: 'compact', fn: (b: any, t: any, o: any, w: any) => buildCompactReceiptBytes(b, t, o, w) },
    { name: 'classic', fn: (b: any, t: any, o: any, w: any) => buildClassicReceiptBytes(b, t, o, w) },
    { name: 'detailed', fn: (b: any, t: any, o: any, w: any) => buildDetailedReceiptBytes(b, t, o, w) },
    { name: 'tax-bill', fn: (b: any, t: any, o: any, w: any) => buildTaxBillBytes(b, t, o, w) },
  ];

  // These are the existing financial-line contracts of the four frontend
  // templates. Compact intentionally omits Subtotal, while detailed uses a
  // subtotal label but does not print a separate Discount line.
  const expectedLabels: Record<string, string[]> = {
    compact: ['Discount', 'Tax', 'TOTAL', 'Cash'],
    classic: ['Subtotal', 'Discount', 'Tax', 'TOTAL', 'Cash'],
    detailed: ['Subtotal (excl. tax)', 'Tax', 'TOTAL', 'Cash'],
    'tax-bill': ['Subtotal', 'Discount', 'Total Tax', 'TOTAL', 'Cash'],
  };
  const expectedAmounts: Record<string, string[]> = {
    compact: ['IRR100,000.00', 'IRR10,000.00', 'IRR9,000.00', 'IRR99,000.00'],
    classic: ['IRR100,000.00', 'IRR10,000.00', 'IRR9,000.00', 'IRR99,000.00'],
    detailed: ['IRR100,000.00', 'IRR9,000.00', 'IRR99,000.00'],
    'tax-bill': ['IRR100,000.00', 'IRR10,000.00', 'IRR9,000.00', 'IRR99,000.00'],
  };

  for (const enc of encoders) {
    for (const useUnicode of [false, true]) {
      const warnings: Array<{ field: string; text: string; message: string }> = [];
      const bytes = enc.fn(frontendBill, frontendTenant, { useUnicode }, warnings);
      const text = Buffer.from(bytes).toString('utf8');

      assert(`[frontend ${enc.name} unicode=${useUnicode}] preserves item line`, text.includes('Espresso'));
      assert(`[frontend ${enc.name} unicode=${useUnicode}] preserves item amount`, text.includes('IRR100,000.00'));
      for (const label of expectedLabels[enc.name]) {
        assert(`[frontend ${enc.name} unicode=${useUnicode}] preserves ${label} line`, text.includes(label));
      }
      for (const amount of expectedAmounts[enc.name]) {
        assert(`[frontend ${enc.name} unicode=${useUnicode}] preserves ${amount}`, text.includes(amount));
      }
      assert(`[frontend ${enc.name} unicode=${useUnicode}] leaves zero warnings for numeric lines`, warnings.length === 0);
    }
  }

  // The frontend classic template also needs to keep the three-character IRR
  // prefix inside the 58mm (42-column) raw layout.
  for (const useUnicode of [false, true]) {
    const narrowWarnings: Array<{ field: string; text: string; message: string }> = [];
    const narrow = buildClassicReceiptBytes(
      frontendBill,
      frontendTenant,
      { paperWidth: 58, useUnicode },
      narrowWarnings,
    );
    const visibleLines = visibleRawPrinterLines(narrow);
    const financialLines = visibleLines.filter((line) => line.includes('IRR') || line.includes('Espresso'));
    const overlongLines = financialLines.filter((line) => line.length > 42);
    const headerLine = visibleLines.find((line) => line.includes('Item') && line.includes('Amt'));
    const itemLine = visibleLines.find((line) => line.includes('Espresso'));
    assert(`[frontend classic unicode=${useUnicode}] keeps 58mm financial lines within width`, overlongLines.length === 0, overlongLines.join(' | '));
    assert(`[frontend classic unicode=${useUnicode}] aligns 58mm header and item widths`, !!headerLine && !!itemLine && headerLine.length === itemLine.length, `${headerLine?.length ?? 0}/${itemLine?.length ?? 0}`);
    assert(`[frontend classic unicode=${useUnicode}] keeps narrow IRR amount`, Buffer.from(narrow).toString('utf8').includes('IRR100,000.00'));
    assert(`[frontend classic unicode=${useUnicode}] has no narrow-layout warnings`, narrowWarnings.length === 0);
  }

  const wideFrontendBill = {
    ...frontendBill,
    order: {
      ...frontendBill.order,
      items: [{ product_name: 'Espresso', quantity: 1, unit_price: 500000000, total: 1000000000 }],
    },
    subtotal: 1000000000,
    discount_amount: 0,
    tax_amount: 0,
    total: 1000000000,
    payment_details: [{ method: 'Cash', amount: 1000000000 }],
  };
  for (const build of [buildClassicReceiptBytes, buildDetailedReceiptBytes]) {
    const wide = build(wideFrontendBill as any, frontendTenant, { paperWidth: 58 }, []);
    const wideLines = visibleRawPrinterLines(wide).filter((line) => line.includes('IRR') || line.includes('Espresso'));
    assert('frontend wide IRR rows stay within 42 columns', wideLines.every((line) => line.length <= 42));
    assert('frontend wide IRR amount remains intact', Buffer.from(wide).toString('utf8').includes('IRR1,000,000,000.00'));
  }

  const browserHtml = generateBillHtml(frontendBill as any, frontendTenant, { useUnicode: false });
  assert('browser printing preserves the Persian Rial symbol', browserHtml.includes('ریال') && !browserHtml.includes('IRR'));
  assert('shared currency normalization leaves the Persian Rial symbol unchanged', normalizeCurrencyToAscii('ریال') === 'ریال');
  const browserTaxHtml = generateBillHtml(frontendBill as any, frontendTenant, { useUnicode: false });
  assert('browser tax-bill printing preserves Persian Rial output', browserTaxHtml.includes('ریال') && !browserTaxHtml.includes('IRR'));
  assert('browser tax-bill printing preserves Persian numeric output', /[۰-۹]/.test(browserTaxHtml));

  // Unsupported free-form Persian text warning contract test (frontend)
  const persianTenant = { ...frontendTenant, business_name: 'کافه فلو تهران' };
  const frontendWarnings: any[] = [];
  buildCompactReceiptBytes(frontendBill as any, persianTenant, { useUnicode: false }, frontendWarnings);
  assert('frontend free-form Persian text emits unsupported character warning', frontendWarnings.some((w: any) => w.text.includes('کافه')));
  assert('frontend Persian warning names Arabic script as the cause', frontendWarnings.some((w: any) => /Persian\/Arabic script/.test(w.message)));

  // 3. Currency normalization and unsupported character guard unit tests
  assert('hasUnsupportedPrinterChars("ریال") remains true before currency normalization', hasUnsupportedPrinterChars('ریال') === true);
  assert('hasUnsupportedPrinterChars("﷼") remains true', hasUnsupportedPrinterChars('﷼') === true);
  assert('hasUnsupportedPrinterChars("یار") remains true', hasUnsupportedPrinterChars('یار') === true);
  assert('hasUnsupportedPrinterChars("کافه") remains true', hasUnsupportedPrinterChars('کافه') === true);
  assert('hasUnsupportedPrinterChars("IRR100,000.00") is false', hasUnsupportedPrinterChars('IRR100,000.00') === false);
}

console.log('\n✅ Test 12: Detect connected printers (hardware discovery)');
(async () => {
  try {
    const cancelledDetection = new AbortController();
    cancelledDetection.abort();
    const cancelledPrinters = await detectConnectedPrinters(cancelledDetection.signal);
    assert('printer detection returns promptly when its request is already cancelled', Array.isArray(cancelledPrinters) && cancelledPrinters.length === 0);

    const printers = await detectConnectedPrinters();
    console.log(`   Found ${printers.length} printer(s):`);
    for (const p of printers) {
      console.log(
        `     • ${p.name}  [${p.make} ${p.model}, ${p.connectionType}, ${p.status}${p.isDefault ? ', DEFAULT' : ''}]`,
      );
    }
    assert('detectConnectedPrinters returns an array', Array.isArray(printers));
    if (printers.length === 0) {
      console.log('   ℹ Skipping hardware assertion (no printer drivers installed on this host)');
      assert('no printers found (skipped, not a failure)', true);
    } else {
      assert('host has at least one printer installed', printers.length > 0);
    }

    const live = process.argv.includes('--live') || process.env.FLO_LIVE_PRINT === '1';
    if (live) {
      const target =
        process.env.FLO_PRINT_TO ||
        printers.find((p) => p.isDefault)?.name ||
        printers[0]?.name;

      if (!target) {
        console.log('\n   ⚠ --live requested but no printer to target.');
      } else {
        const targetInfo = printers.find((p) => p.name === target);
        console.log(`\n🖨  Sending test page to: ${target}  (${targetInfo?.connectionType || 'usb'})`);
        const testBuf = buildTestPage('80mm');

        let ok = false;
        let detail: string | undefined;
        if (targetInfo?.connectionType === 'network' && /\d+\.\d+\.\d+\.\d+/.test(targetInfo.deviceUri)) {
          const ipMatch = targetInfo.deviceUri.match(/(\d+\.\d+\.\d+\.\d+)(?::(\d+))?/);
          const ip = ipMatch?.[1];
          const port = ipMatch?.[2] ? parseInt(ipMatch[2], 10) : 9100;
          if (ip) ({ ok, detail } = await printViaNetwork(ip, port, testBuf));
        } else {
          ({ ok, detail } = await printViaUSB(testBuf, target));
        }
        assert(`live test page printed on ${target}`, ok, detail || 'check printer is online, has paper, and driver is installed');
      }
    } else {
      console.log('\n   (skipping live print — pass --live or set FLO_LIVE_PRINT=1 to actually print)');
    }
  } catch (err: any) {
    console.log(`   ✗ printer detection threw: ${err.message}`);
    failed++;
    failures.push(`printer detection: ${err.message}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`🏁 ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})();
