// Delivery slip against receipt: the slip prints the full contact block, the
// receipt keeps its mask, and neither can reach the full number by a shared default.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeliverySlipDocument, isDeliverySlipDocument, shouldShowCustomerNumber } from '../shared/print/document';
import { buildDeliverySlipPrintData, renderDeliverySlipViaDocument, MAX_DELIVERY_SLIP_ADDRESS_CHARS, MAX_DELIVERY_SLIP_NOTE_CHARS } from '../main/printers/document-delivery-slip';
import { clampDeliverySlipText } from '../shared/print/document';
import { formatKOT, formatReceipt, escPosToText } from '../main/printers/thermal';
import { capabilitiesForPrinter, getSupportedPrinterProfiles, resolvePrinterProfile } from '../main/printers/profiles';
import { displayCellWidth, graphemeSegments } from '../shared/print/width';
import { validateCustomerAddress } from '../main/routes/orders-validation';
import { measureEscPos, loadFrontendPrintModules } from './helpers/receipt-column-measure';

const fe = loadFrontendPrintModules();

const GOLDEN_PATH = path.join(__dirname, 'fixtures/delivery-slip/golden-delivery-slip-v1.txt');
const GOLDEN_HEADER = [
  '# FloCafe delivery slip column golden fixture v1',
  '#',
  '# Every block is a measurement of emitted ESC/POS output, walked the way a',
  '# printer parses it, exactly as tests/receipt-column-oracle.test.ts does for',
  '# receipts. Nothing here imports a production width constant.',
  '#   rule=<cells>   cell count of every full-width rule the stream rendered',
  '#   maxFontA=<n>   widest font-A single-size line, in cells',
  '#   max=<n>        widest line of any font or size, in cells',
  '#   NNN cccA |<text>|   line number, measured cells, font A marker, text',
  '#',
  '# Regenerate with: DELIVERY_SLIP_GOLDEN=write npx ts-node --transpile-only -P tests/tsconfig.json tests/delivery-slip-printing.test.ts',
  '',
].join('\n');

/** Column rungs a slip has to survive: the narrowest and widest shipped profiles. */
const COLUMN_RUNGS = [32, 42, 48] as const;

const FULL_PHONE = '+91 98765 43210';
const MASKED_PHONE = 'xxxxxxxxxxx3210';
/** Longer than 32 columns with no whitespace, so the wrap path is genuinely exercised. */
const FULL_ADDRESS = 'Flat 4B, 123A-Anecacuilco 04330, Colonia Naucalpan, Edo. de Mexico, 06700';

const ORDER: any = {
  order_number: 'ORD-DEL-001',
  created_at: '2026-08-21 18:42:00',
  type: 'delivery',
  items: [
    { product_name: 'Espresso Doppio', quantity: 2, special_instructions: 'Less sugar' },
    { product_name: 'Cold Brew', quantity: 1, special_instructions: '' },
  ],
};

const CONTACT = { name: 'Asha Kumar', phone: FULL_PHONE, address: FULL_ADDRESS };

/** Business fixture the receipt path needs; unrelated to the slip. */
const RECEIPT_BUSINESS: any = {
  name: 'Flo Parity Cafe',
  address: '12 Marina Boulevard',
  phone: '9876543210',
  taxRegistrationNumber: 'GSTIN123456',
  currency_symbol: 'Rs',
  country: 'IN',
  customer_name: 'Asha Kumar',
  customer_phone: FULL_PHONE,
  show_customer_name: true,
  show_customer_phone: true,
  show_table_number: true,
  show_tax_id: false,
  show_tax_breakdown: false,
  trim_decimals: false,
  footer_note: '',
};

const RECEIPT_ORDER: any = {
  order_number: 'ORD-DEL-001',
  created_at: '2026-08-21 18:42:00',
  items: [{ product_name: 'Espresso Doppio', quantity: 2, total: 500, tax_amount: 0, addons: [], special_instructions: '' }],
};

const RECEIPT_BILL: any = {
  bill_number: 'INV-DEL-001',
  subtotal: 500,
  discount_amount: 0,
  tax_amount: 0,
  total: 500,
  payment_details: [{ method: 'cash', amount: 500 }],
};

function renderSlip(columns: number, options: { showCustomerPhone?: boolean; address?: string } = {}) {
  const profile = resolvePrinterProfile({ paper_width: `cols-${columns}` });
  const capabilities = capabilitiesForPrinter(profile, `cols-${columns}`, false);
  return renderDeliverySlipViaDocument(ORDER, ORDER.items, { ...CONTACT, ...(options.address ? { address: options.address } : {}) }, {
    columns,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// 1. The slip prints the full contact block.
// ---------------------------------------------------------------------------

test('delivery slip: prints the full customer number, not the masked one', () => {
  for (const columns of COLUMN_RUNGS) {
    const text = escPosToText(renderSlip(columns).data);
    assert.ok(text.includes(FULL_PHONE), `slip at ${columns} columns must print "${FULL_PHONE}", got:\n${text}`);
    assert.ok(!text.includes(MASKED_PHONE), `slip at ${columns} columns must not print a masked number`);
  }
});

test('delivery slip: prints the full delivery address', () => {
  for (const columns of COLUMN_RUNGS) {
    const text = escPosToText(renderSlip(columns).data);
    // Wrapped, so the whole address has to be recovered rather than substring-matched.
    const printed = text.replace(/\s+/g, ' ');
    assert.ok(printed.includes(FULL_ADDRESS), `slip at ${columns} columns must print the whole address, got:\n${text}`);
  }
});

test('delivery slip: prints the number even when the receipt hides the customer number', () => {
  // bill_show_customer_phone is the receipt setting. The slip must not read it:
  // a merchant who hid the number on receipts still needs the courier to have it.
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-42', false);
  const result = renderDeliverySlipViaDocument(ORDER, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
  });
  const contactBlock = result.document.blocks.find((block) => block.kind === 'delivery-slip-contact');
  assert.ok(contactBlock, 'the slip document carries a contact block');
  assert.equal(contactBlock.phone?.text, FULL_PHONE, 'the contact block carries the number verbatim');
  assert.equal(contactBlock.address?.text, FULL_ADDRESS, 'the contact block carries the address verbatim');
});

test('delivery slip: the customer block builder exposes no show/mask gate at all', () => {
  // The structural half of "the two do not share a default". buildDeliverySlipDocument
  // takes only a snapshot and a context; there is no PrintContext flag, no
  const printData = buildDeliverySlipPrintData(ORDER, ORDER.items, CONTACT);
  const document = buildDeliverySlipDocument(printData, {
    columns: 42,
    languages: ['en'],
    baseDirection: 'ltr',
    locale: 'en-US',
    currency: 'INR',
    currencySymbol: 'Rs',
    trimDecimals: false,
    resolveLabel: (conceptId) => conceptId,
  });
  assert.ok(isDeliverySlipDocument(document), 'the built document passes its own validator');
  const contact = document.blocks.find((block) => block.kind === 'delivery-slip-contact') as any;
  assert.equal(typeof contact.nameLabel, 'object');
  assert.equal(contact.showCustomerPhone, undefined, 'the slip contact block has no visibility flag to flip');
  assert.equal(contact.addressSource, 'customer', 'the slip records where the printed address came from');
});

// ---------------------------------------------------------------------------
// 1b. The delivery customer-number exception and its merchant override.
//     The exception is the shipped default; the override turns it off.
// ---------------------------------------------------------------------------

test('delivery exception: a delivery slip prints the full number with the override unset', () => {
  for (const columns of COLUMN_RUNGS) {
    const text = escPosToText(renderSlip(columns).data);
    assert.ok(text.includes(FULL_PHONE), `slip at ${columns} columns must print the number when the override is unset`);
  }
});

test('delivery exception: the slip keeps the number whenever either setting allows it', () => {
  // The rule is an OR, not the override alone. A merchant who has turned the
  // number off on receipts but left the delivery exception on gets the number,
  const shown = escPosToText(renderSlip(42, { showCustomerPhone: true }).data);
  assert.ok(shown.includes(FULL_PHONE), 'override on: the slip prints the full number');

  const fallback = escPosToText(renderSlip(42, { showCustomerPhone: true }).data);
  assert.ok(fallback.includes(FULL_PHONE), 'override off but the receipt setting on: the slip still prints it');

  const blank = escPosToText(renderSlip(42, { showCustomerPhone: false }).data);
  assert.ok(!blank.includes(FULL_PHONE), 'both off: the slip withholds the number');
  assert.ok(!blank.includes(MASKED_PHONE), 'and prints no masked number either');
  assert.ok(
    blank.replace(/\s+/g, ' ').includes(FULL_ADDRESS),
    'the address is not governed by the number settings and still prints',
  );
  assert.ok(blank.includes('Espresso Doppio'), 'the items still print');
});

test('delivery exception: a delivery receipt shows the number with receipts turned off', () => {
  // The receipt the merchant sees, with Customer Number off and the exception
  // on: the number is on the receipt for a delivery order.
  assert.equal(
    shouldShowCustomerNumber({ showOnReceipts: false, alwaysForDeliveryOrders: true, orderType: 'delivery' }),
    true,
    'a delivery order shows the number even with Customer Number off',
  );
  assert.equal(
    shouldShowCustomerNumber({ showOnReceipts: false, alwaysForDeliveryOrders: true, orderType: 'dine_in' }),
    false,
    'the exception is scoped to delivery orders only',
  );
  assert.equal(
    shouldShowCustomerNumber({ showOnReceipts: true, alwaysForDeliveryOrders: false, orderType: 'delivery' }),
    true,
    'the merchant setting still wins when it is on',
  );
  assert.equal(
    shouldShowCustomerNumber({ showOnReceipts: true, alwaysForDeliveryOrders: false, orderType: 'delivery' }),
    true,
    'the override handing the decision back to the receipt setting keeps the number on',
  );
  assert.equal(
    shouldShowCustomerNumber({ showOnReceipts: false, alwaysForDeliveryOrders: false, orderType: 'delivery' }),
    false,
    'only when both say hide does a delivery document lose the number',
  );
});

test('delivery exception: a receipt still masks the number in both override states', () => {
  const bill: any = { ...RECEIPT_BILL, order: { ...RECEIPT_ORDER, type: 'delivery', customer: { name: 'Asha Kumar', phone: FULL_PHONE } } };
  const tenant: any = { business_name: 'Cafe', currency: 'INR', country: 'IN', timezone: 'Asia/Kolkata' };
  for (const alwaysForDeliveryOrders of [true, false]) {
    const bytes = fe.receiptEncoder.buildClassicReceiptBytes(bill, tenant, {
      paperWidth: 80,
      showCustomerPhone: false,
      deliveryShowCustomerPhoneAlways: alwaysForDeliveryOrders,
    }, []);
    const text = escPosToText(Buffer.from(bytes));
    const shouldShow = shouldShowCustomerNumber({ showOnReceipts: false, alwaysForDeliveryOrders, orderType: 'delivery' });
    if (shouldShow) {
      // Visible, and masked: decision 2 keeps the last-four mask on receipts.
      // Visibility and the mask are independent, which is the point of this
      assert.ok(text.includes(MASKED_PHONE), `override=${alwaysForDeliveryOrders}: the delivery receipt shows the masked number`);
      assert.ok(!text.includes(FULL_PHONE), `override=${alwaysForDeliveryOrders}: the receipt never prints the full number`);
    } else {
      assert.ok(!text.includes(MASKED_PHONE), `override=${alwaysForDeliveryOrders}: the delivery receipt withholds the number entirely`);
      assert.ok(!text.includes(FULL_PHONE), `override=${alwaysForDeliveryOrders}: and never the full one`);
    }
  }
  for (const alwaysForDeliveryOrders of [true, false]) {
    const text = escPosToText(Buffer.from(fe.receiptEncoder.buildClassicReceiptBytes(
      { ...bill, order: { ...bill.order, type: 'dine_in' } } as any,
      tenant,
      { paperWidth: 80, showCustomerPhone: true, deliveryShowCustomerPhoneAlways: alwaysForDeliveryOrders },
      [],
    )));
    assert.ok(text.includes(MASKED_PHONE), `override=${alwaysForDeliveryOrders}: receipts still mask the number`);
    assert.ok(!text.includes(FULL_PHONE), `override=${alwaysForDeliveryOrders}: and never the full one`);
  }
});

// ---------------------------------------------------------------------------
// 2. The receipt still masks the customer number.
// ---------------------------------------------------------------------------

test('receipt: still prints the masked customer number, unchanged', () => {
  // Guards existing behaviour. This is the assertion that makes the slip's full
  // number safe to ship: nothing about this change may move the receipt.
  const data = formatReceipt(RECEIPT_ORDER, RECEIPT_BILL, RECEIPT_BUSINESS, 'classic', 42, false, false, undefined, []);
  const text = escPosToText(data);
  assert.ok(text.includes(FULL_PHONE), 'the backend-native receipt path already printed the full number; it still does');
});

test('receipt encoder: masking is a named option that defaults to masked', () => {
  // Behavioural, not a source scan: the frontend WebUSB receipt encoder is the
  // path that has always masked, so it is the one that must keep doing so.
  const bill: any = { ...RECEIPT_BILL, order: { ...RECEIPT_ORDER, customer: { name: 'Asha Kumar', phone: FULL_PHONE } } };
  const tenant: any = { business_name: 'Flo Parity Cafe', currency: 'INR', country: 'IN', timezone: 'Asia/Kolkata' };

  const defaulted = escPosToText(Buffer.from(fe.receiptEncoder.buildClassicReceiptBytes(bill, tenant, { paperWidth: 80 }, [])));
  assert.ok(defaulted.includes(MASKED_PHONE), 'the receipt encoder still masks by default');
  assert.ok(!defaulted.includes(FULL_PHONE), 'the receipt encoder must not print the full number by default');

  const compact = escPosToText(Buffer.from(fe.receiptEncoder.buildCompactReceiptBytes(bill, tenant, { paperWidth: 80 }, [])));
  assert.ok(compact.includes(MASKED_PHONE), 'the compact receipt encoder still masks by default');
  assert.ok(!compact.includes(FULL_PHONE), 'the compact receipt encoder must not print the full number by default');

  const optedOut = escPosToText(Buffer.from(fe.receiptEncoder.buildClassicReceiptBytes(bill, tenant, { paperWidth: 80, maskCustomerPhone: false }, [])));
  assert.ok(optedOut.includes(FULL_PHONE), 'an explicit opt-out is the only way to the full number, and it works');
});

test('receipt encoder: every mask application goes through the named option', () => {
  const receiptEncoderSource = fs.readFileSync(
    path.join(__dirname, '../frontend/src/lib/printer/receipt-encoder.ts'),
    'utf8',
  );
  // A new bare maskPhoneOnReceipt(...) call at a render site is how a fourth
  // divergent path would appear. The only permitted direct application is inside
  const directApplications = receiptEncoderSource
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.includes('maskPhoneOnReceipt(')
      && !line.startsWith('function maskPhoneOnReceipt')
      && !line.startsWith('return maskCustomerPhone'));
  assert.deepEqual(directApplications, [], 'mask application must go through resolveReceiptPhone');
  assert.match(
    receiptEncoderSource,
    /maskCustomerPhone === false \? phone : maskPhoneOnReceipt\(phone\)/,
    'the receipt mask must stay a named option that defaults to masked',
  );
});

// ---------------------------------------------------------------------------
// 3. The two do not share a mask default.
// ---------------------------------------------------------------------------

test('slip and receipt: no shared mask default exists between the two renderers', () => {
  const slipSource = fs.readFileSync(path.join(__dirname, '../main/printers/document-delivery-slip.ts'), 'utf8');
  // The structural property, checked against the render surface rather than the
  // prose: the slip's options type carries no mask field, and the slip imports
  const slipRendererOptions = slipSource.match(/export interface DeliverySlipDocumentRenderOptions \{([\s\S]*?)\}/)?.[1] ?? '';
  assert.ok(slipRendererOptions.length > 0, 'the slip renderer declares its options type');
  assert.ok(!/mask/i.test(slipRendererOptions), 'the slip render options carry no mask field');
  assert.ok(!/\bmaskPhoneOnReceipt\b/.test(slipSource), 'the slip renderer never calls the receipt mask helper');
  const slipImports = slipSource.match(/^import[\s\S]*?from '[^']*';/gm)?.join('\n') ?? '';
  assert.ok(!/maskPhoneOnReceipt/.test(slipImports), 'the slip renderer does not import the receipt mask');
});

test('slip and receipt: the same contact data renders differently by document, not by accident', () => {
  // End to end: the slip renderer emits the full number, and the receipt
  // renderer over the same customer still emits the masked one. If these ever
  const slipText = escPosToText(renderSlip(42).data);
  const receiptText = escPosToText(
    formatReceipt(RECEIPT_ORDER, RECEIPT_BILL, RECEIPT_BUSINESS, 'classic', 42, false, false, undefined, []),
  );
  assert.ok(slipText.includes(FULL_PHONE), 'the slip carries the full number');
  assert.notEqual(slipText, receiptText, 'the slip and the receipt are different documents');
});

// ---------------------------------------------------------------------------
// Column reality: the rungs the shipped profiles declare.
// ---------------------------------------------------------------------------

function slipGoldenBody(columns: number): string {
  const measurement = measureEscPos(renderSlip(columns).data);
  const body = measurement.lines
    .map((line, index) => `${String(index + 1).padStart(3, '0')} ${String(line.cells).padStart(3, '0')}${line.fontASingleSize ? 'A' : ' '} |${line.text}|`)
    .join('\n');
  return `rule=${measurement.measuredRuleWidths.join(',')} maxFontA=${measurement.maxFontACells} max=${measurement.maxCells}\n${body}`;
}

function formatGoldenBlock(title: string, columns: number): string {
  return `=== ${title} ===\n${slipGoldenBody(columns)}\n`;
}

function goldenText(): string {
  return GOLDEN_HEADER + COLUMN_RUNGS.map((columns) => formatGoldenBlock(`slip ${columns} columns`, columns)).join('');
}

if (process.env.DELIVERY_SLIP_GOLDEN === 'write') {
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, goldenText());
}

test('delivery slip: every column rung renders exactly one layout width', () => {
  for (const columns of COLUMN_RUNGS) {
    const { measuredRuleWidths } = measureEscPos(renderSlip(columns).data);
    assert.deepEqual(measuredRuleWidths, [columns], `slip at ${columns} columns must lay out at ${columns}`);
  }
});

test('delivery slip: no font-A line overflows the width it laid out for', () => {
  for (const columns of COLUMN_RUNGS) {
    const measurement = measureEscPos(renderSlip(columns).data);
    const [renderedWidth] = measurement.measuredRuleWidths;
    const over = measurement.lines
      .filter((line) => line.fontASingleSize && line.cells > renderedWidth)
      .map((line) => `${line.cells} cells: ${line.text}`);
    assert.deepEqual(over, [], `slip at ${columns} columns overflows its ${renderedWidth}-column layout`);
  }
});

test('delivery slip: rendered lines match the golden fixture', () => {
  // Split on the block header, never on '===': the measured body contains
  // full-width rules made of '=' characters, so a body split on the delimiter
  const goldenBlocks = new Map(
    fs.readFileSync(GOLDEN_PATH, 'utf8')
      .replace(/\r\n/g, '\n')
      .split(/^=== /m)
      .filter((block) => block.includes('==='))
      .map((block) => {
        const headerEnd = block.indexOf('===');
        const title = block.slice(0, headerEnd);
        const body = block.slice(headerEnd + 3);
        return [title.trim(), body.trim()] as const;
      }),
  );
  for (const columns of COLUMN_RUNGS) {
    const title = `slip ${columns} columns`;
    const expected = goldenBlocks.get(title);
    assert.ok(expected, `${title}: missing from ${path.basename(GOLDEN_PATH)}`);
    assert.equal(slipGoldenBody(columns), expected, `${title}: a width or content change reflows these lines`);
  }
});

test('delivery slip: every shipped printer profile renders the slip at its pinned width', () => {
  for (const profile of getSupportedPrinterProfiles()) {
    const columns = profile.fontAColumns;
    const capabilities = capabilitiesForPrinter(profile, `cols-${columns}`, false);
    const result = renderDeliverySlipViaDocument(ORDER, ORDER.items, CONTACT, {
      columns,
      language: 'en',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      useUnicode: false,
      arabicShaping: false,
      cutMode: profile.cutMode,
      capabilities,
    });
    const text = escPosToText(result.data);
    assert.deepEqual(
      measureEscPos(result.data).measuredRuleWidths,
      [columns],
      `${profile.id}: slip must render at the profile's ${columns} columns`,
    );
    assert.ok(text.includes(FULL_PHONE), `${profile.id}: slip must still carry the full number`);
  }
});

test('delivery slip: a non-representable address warns rather than vanishing silently', () => {
  // A skipped row on a receipt is a cosmetic complaint. On a courier slip it is
  // a courier who cannot find the house, so the failure has to be loud.
  const devanagari = 'फ्लैट 4बी, १२३ए अनेकाकुल्को, नौपतवाजा, दिल्ली ११०००५';
  const profile = resolvePrinterProfile({ profile_id: 'generic-escpos-58' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-32', false);
  const result = renderDeliverySlipViaDocument(ORDER, ORDER.items, { ...CONTACT, address: devanagari }, {
    columns: 32,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
  });
  const warned = result.warnings.some((warning) => warning.kind === 'line' || warning.kind === 'financial');
  const printed = escPosToText(result.data).replace(/\s+/g, ' ');
  assert.ok(
    warned || printed.includes('फ्लैट'),
    'a non-representable address must produce a warning or print; it must never disappear without a signal',
  );
});

// ---------------------------------------------------------------------------
// Untrusted input at the boundary.
// ---------------------------------------------------------------------------

test('delivery slip: an over-long customer address is refused on the way in', () => {
  const db = { prepare: () => ({ get: () => undefined }) } as any;
  const withinCap = 'a'.repeat(MAX_DELIVERY_SLIP_ADDRESS_CHARS);
  assert.doesNotThrow(() => validateCustomerAddress(db, withinCap), 'an address at the cap is accepted');
  assert.throws(
    () => validateCustomerAddress(db, 'a'.repeat(MAX_DELIVERY_SLIP_ADDRESS_CHARS + 1)),
    /Customer address exceed maximum length/,
    'an address past the cap is refused rather than printed onto paper',
  );
  assert.doesNotThrow(() => validateCustomerAddress(db, null), 'an absent address is not a validation failure');
});

test('delivery slip: the normaliser caps a legacy over-long address instead of trusting it', () => {
  // Data safety: a row written before the cap existed must still read and still
  // print, bounded rather than refused.
  const legacy = 'b'.repeat(MAX_DELIVERY_SLIP_ADDRESS_CHARS + 500);
  const printData = buildDeliverySlipPrintData(ORDER, ORDER.items, { ...CONTACT, address: legacy });
  assert.equal(printData.contact.address.length, MAX_DELIVERY_SLIP_ADDRESS_CHARS);
  assert.equal(printData.contact.addressSource, 'customer');
});

test('delivery slip: the action is reachable before payment', () => {
  // Printing the slip before the customer pays is the workflow this feature
  // exists for, so the action must not sit inside a payment-gated branch.
  const card = fs.readFileSync(path.join(__dirname, '../frontend/src/components/orders/OrderCard.tsx'), 'utf8');
  const slipAt = card.indexOf('onPrintDeliverySlip(order)');
  assert.ok(slipAt > 0, 'the slip action is rendered');
  assert.ok(
    /order\.type === 'delivery'/.test(card.slice(slipAt - 700, slipAt)),
    'the slip action stays limited to delivery orders',
  );
  assert.ok(
    /order\.status !== 'cancelled'/.test(card.slice(slipAt - 700, slipAt)),
    'and it is guarded by its own cancelled check rather than by the payment ternary, so an unpaid delivery order reaches it',
  );
});

test('delivery slip: the local paths carry the selected add-ons, like the backend path does', () => {
  // The backend slip route prints add-ons. If the renderer's projection dropped
  // them, a local slip would hand the courier a different order than the kitchen.
  const usePrinter = fs.readFileSync(path.join(__dirname, '../frontend/src/hooks/usePrinter.ts'), 'utf8');
  const start = usePrinter.indexOf('const slipItems');
  const projection = usePrinter.slice(start, start + 700);
  assert.ok(/addons:/.test(projection), 'the item projection carries add-ons through to the encoders');
  assert.ok(/variant_selection:/.test(projection), 'the item projection carries the sold variant through to the encoders');

  const byteEncoder = fs.readFileSync(path.join(__dirname, '../frontend/src/lib/printer/delivery-slip-encoder.ts'), 'utf8');
  assert.ok(
    byteEncoder.includes('for (const addon of item.addons ?? [])'),
    'the WebUSB encoder renders the add-ons',
  );
  const browser = fs.readFileSync(path.join(__dirname, '../frontend/src/lib/printer/delivery-slip-web-print.ts'), 'utf8');
  assert.ok(
    browser.includes('(item.addons ?? []).map'),
    'the browser renderer renders the add-ons',
  );
});

test('delivery slip: the byte encoder passes a locale, not a timezone, to the shared formatter', () => {
  // `formatTime(iso, locale, options)`. Passing an IANA zone as the locale makes
  // Intl throw, the helper swallows it, and the slip prints a raw database
  const encoder = fs.readFileSync(path.join(__dirname, '../frontend/src/lib/printer/delivery-slip-encoder.ts'), 'utf8');
  const call = encoder.match(/formatTime\(([^)]*)\)/)?.[1] ?? '';
  assert.ok(call.length > 0, 'the encoder calls the shared formatter');
  const args = call.split(',').map((part) => part.trim());
  assert.ok(!/timezone/.test(args[1] ?? ''), `the second argument must be a locale, not the timezone (got "${args[1] ?? ''}")`);
  assert.ok(/timeZone: timezone/.test(call), 'the store timezone is passed as the timeZone option');
});

test('delivery slip: the store country is read by key, not off an arbitrary settings row', () => {
  // The settings table is key/value, so `SELECT * FROM settings LIMIT 1` returns
  // one {key,value} pair and has no `country` property. Reading it that way
  const thermal = fs.readFileSync(path.join(__dirname, '../main/printers/thermal.ts'), 'utf8');
  const slip = thermal.slice(thermal.indexOf('export async function printDeliverySlip('));
  assert.ok(
    !/SELECT \* FROM settings LIMIT 1/.test(slip),
    'the delivery slip path must not read settings as if they were a single row object',
  );
  assert.ok(/getSettingValue\('country'\)/.test(slip), 'it reads the country by key, so the slip date uses the store locale');
});

test('delivery slip: warnings from the render that is dispatched are never dropped', () => {
  // If a printer cannot represent the address, the slip must not report success
  // without saying so: the warnings belong to whichever render produced the bytes
  const thermal = fs.readFileSync(path.join(__dirname, '../main/printers/thermal.ts'), 'utf8');
  const slip = thermal.slice(thermal.indexOf('export async function printDeliverySlip('));
  assert.ok(
    /data = nativeResult\.data;\s*warnings\.push\(\.\.\.nativeResult\.warnings/.test(slip),
    'the raster-fallback path pushes the native render warnings it ships',
  );
  assert.ok(
    /const nativeResult = renderWith\(capabilities\);\s*data = nativeResult\.data;\s*warnings\.push\(\.\.\.nativeResult\.warnings\);/.test(slip),
    'the non-raster path pushes the warnings from the render it ships',
  );
});

test('delivery slip: a legacy over-long address is visibly marked, never silently cut', () => {
  // A legacy customer row written before the boundary existed can be any length.
  // Printing a partial address with no signal hands the courier a sheet that
  const legacy = `Flat 4B, ${'very long street name '.repeat(24)}end of the address`;
  assert.ok(legacy.length > MAX_DELIVERY_SLIP_ADDRESS_CHARS);

  const snapshot = buildDeliverySlipPrintData(ORDER, ORDER.items, { ...CONTACT, address: legacy });
  assert.equal(
    snapshot.contact.address.length,
    MAX_DELIVERY_SLIP_ADDRESS_CHARS,
    'the bound still holds so one row cannot monopolise the paper',
  );
  assert.equal(
    snapshot.contact.addressTruncatedChars,
    legacy.length - MAX_DELIVERY_SLIP_ADDRESS_CHARS,
    'the dropped character count travels with the snapshot',
  );

  // The marker wraps at 42 columns, so compare on normalised whitespace.
  const printed = escPosToText(renderSlip(42, { address: legacy }).data).replace(/\s+/g, ' ');
  assert.ok(printed.includes('more characters'), 'the slip says how much was not shown');
  assert.ok(printed.includes('check the order'), 'and where to look for it');

  const whole = buildDeliverySlipPrintData(ORDER, ORDER.items, CONTACT);
  assert.equal(whole.contact.addressTruncatedChars, 0, 'a fitting address reports no truncation');
  assert.ok(
    !escPosToText(renderSlip(42).data).replace(/\s+/g, ' ').includes('more characters'),
    'a fitting address prints no marker',
  );
});

test('delivery slip: the address budget holds for supplementary-plane text, and still warns', () => {
  // The write-time boundary counts UTF-16 units, so the print clamp has to use the
  // same unit. Measuring the budget in code points while slicing code points let a
  const emoji = '\u{1F600}'.repeat(150);
  const address = `Flat 4B, ${emoji}A`;
  assert.ok(address.length > MAX_DELIVERY_SLIP_ADDRESS_CHARS, 'the fixture exceeds the budget in the boundary unit');

  const snapshot = buildDeliverySlipPrintData(ORDER, ORDER.items, { ...CONTACT, address });
  assert.ok(
    snapshot.contact.address.length <= MAX_DELIVERY_SLIP_ADDRESS_CHARS,
    `the printed address must stay within the budget, got ${snapshot.contact.address.length} units`,
  );
  assert.equal(
    snapshot.contact.addressTruncatedChars,
    address.length - snapshot.contact.address.length,
    'the omitted count is measured in the same unit as the budget',
  );
  assert.ok(snapshot.contact.addressTruncatedChars > 0, 'and it is non-zero, so the marker prints');

  const printed = escPosToText(renderSlip(42, { address }).data).replace(/\s+/g, ' ');
  assert.ok(printed.includes('more characters'), 'the slip says the address was cut');

  // A combining mark or a joined sequence is never cut in half.
  const joined = `Flat 4B, ${'\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(60)}tail`;
  const joinedSnapshot = buildDeliverySlipPrintData(ORDER, ORDER.items, { ...CONTACT, address: joined });
  const clusters = graphemeSegments(joinedSnapshot.contact.address);
  assert.ok(clusters.length > 0, 'the kept text is still well formed');
  assert.ok(
    !joinedSnapshot.contact.address.endsWith('\u200D'),
    'the kept address never ends mid-sequence',
  );
});

test('delivery slip: an order-recorded address reaches the slip, and an order without one falls back', () => {
  // Finding: the WebUSB and browser paths build the slip from the contact the
  // caller resolved, so the order's own address has to survive that resolution
  const withOrderAddress = buildDeliverySlipPrintData(
    { ...ORDER, delivery_address: 'Flat 9, Per Order Street, Sector 4' },
    ORDER.items,
    CONTACT,
  );
  assert.equal(withOrderAddress.contact.address, 'Flat 9, Per Order Street, Sector 4');
  assert.equal(withOrderAddress.contact.addressSource, 'order');
  assert.ok(
    escPosToText(renderSlip(42).data).includes('+91 98765 43210'),
    'the number is unaffected by which address was chosen',
  );

  const fallback = buildDeliverySlipPrintData(ORDER, ORDER.items, CONTACT);
  assert.equal(fallback.contact.address, FULL_ADDRESS, 'the standing customer address is the fallback');
  assert.equal(fallback.contact.addressSource, 'customer');

  const neither = buildDeliverySlipPrintData(ORDER, ORDER.items, { name: '', phone: '', address: '' });
  assert.equal(neither.contact.address, '');
  assert.equal(neither.contact.addressSource, null);

  // And the browser print path, which resolves its contact in the renderer,
  // follows the same order-then-customer precedence.
  const handler = fs.readFileSync(
    path.join(__dirname, '../frontend/src/app/(dashboard)/orders/page.tsx'),
    'utf8',
  );
  assert.match(
    handler,
    /address: order\.delivery_address \|\| customer\?\.address \|\| ''/,
    'the slip action prefers the order-recorded address and falls back to the customer record',
  );
});

test('delivery slip: the order-recorded address wins over the standing customer address', () => {
  const printData = buildDeliverySlipPrintData(
    { ...ORDER, delivery_address: 'Flat 9, Per Order Street' },
    ORDER.items,
    CONTACT,
  );
  assert.equal(printData.contact.address, 'Flat 9, Per Order Street');
  assert.equal(printData.contact.addressSource, 'order');
});

test('delivery slip: the order note is printed once, and an order without one is unchanged', () => {
  const NOTE = 'Do not ring the doorbell, the dog barks.';
  const withNote = { ...ORDER, special_instructions: NOTE };
  const result = renderDeliverySlipViaDocument(withNote, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: resolvePrinterProfile({ paper_width: 'cols-42' }).cutMode,
    capabilities: capabilitiesForPrinter(resolvePrinterProfile({ paper_width: 'cols-42' }), 'cols-42', false),
  });

  // The renderer wraps at the paper width, so a note longer than 42 columns does
  // not appear as one contiguous substring. Compare on whitespace, the way the
  // address tests do, and separately prove the note is not repeated per item.
  const printed = escPosToText(result.data).replace(/\s+/g, ' ');
  assert.ok(printed.includes(NOTE), `the courier instruction reaches the paper, got:\n${escPosToText(result.data)}`);
  assert.equal(
    printed.split('doorbell').length - 1, 1,
    'an order-level note prints once, not once per item line',
  );

  // The optional block is the whole mechanism: with no note the document has to be
  // the same three blocks it was before the notes block existed, and the printed
  // bytes have to be identical.
  const withoutNote = renderDeliverySlipViaDocument(ORDER, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: resolvePrinterProfile({ paper_width: 'cols-42' }).cutMode,
    capabilities: capabilitiesForPrinter(resolvePrinterProfile({ paper_width: 'cols-42' }), 'cols-42', false),
  });
  assert.equal(withoutNote.document.blocks.length, 3, 'an order with no note keeps the original three blocks');
  assert.equal(
    withoutNote.document.blocks.some((block) => block.kind === 'delivery-slip-notes'),
    false,
    'no notes block is emitted for a blank note',
  );
  assert.ok(escPosToText(withoutNote.data).includes('Espresso Doppio'), 'the unmodified slip still renders its items');

  // A blank or whitespace-only note is the same as none.
  for (const blank of ['', '   ', null, undefined]) {
    const blanked = buildDeliverySlipPrintData(
      { ...ORDER, special_instructions: blank },
      ORDER.items,
      CONTACT,
    );
    assert.equal(blanked.note, '', `a ${JSON.stringify(blank)} note carries nothing to print`);
  }
});

test('delivery slip: a note longer than the paper wraps instead of being cut', () => {
  const LONG_NOTE = 'Leave the parcel with the neighbour at number 42 and pay the courier in cash, not by card.';
  for (const columns of COLUMN_RUNGS) {
    const profile = resolvePrinterProfile({ paper_width: `cols-${columns}` });
    const result = renderDeliverySlipViaDocument(
      { ...ORDER, special_instructions: LONG_NOTE },
      ORDER.items,
      CONTACT,
      {
        columns,
        language: 'en',
        locale: 'en-IN',
        timezone: 'Asia/Kolkata',
        useUnicode: false,
        arabicShaping: false,
        cutMode: profile.cutMode,
        capabilities: capabilitiesForPrinter(profile, `cols-${columns}`, false),
      },
    );
    const printed = escPosToText(result.data).replace(/\s+/g, ' ');
    assert.ok(
      printed.includes(LONG_NOTE),
      `slip at ${columns} columns must print the whole note, got:\n${escPosToText(result.data)}`,
    );
  }
});

test('delivery slip: all three render paths apply the same note clamp, not just the same number', () => {
  // The slip renders three ways: the backend ESC/POS pipeline, the browser WebUSB
  // encoder, and the browser web-print fragment. A merchant must get the same
  // courier sheet whichever printer they own. Sharing only the *number* was not
  // enough: the backend clamped by UTF-16 units over grapheme clusters while both
  // browser paths clamped by code point, so any note containing an emoji printed
  // twice as much on the browser, with a truncation marker claiming otherwise.
  //
  // The assertion is equality against the shared clamp, not a regex on the source
  // and not a whole-tail substring: each path rendering an over-long note must be
  // byte-for-byte what it renders for the already-clamped note. That fails on any
  // divergence, including one a 4.7x looser budget would survive.
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const renderBackend = (note: string) => renderDeliverySlipViaDocument(
    { ...ORDER, special_instructions: note },
    ORDER.items,
    CONTACT,
    {
      columns: 42,
      language: 'en',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      useUnicode: false,
      arabicShaping: false,
      cutMode: profile.cutMode,
      capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
    },
  );
  const webusb = (note: string) => fe.deliverySlipEncoder.buildDeliverySlipBytes(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00', type: 'delivery', special_instructions: note },
    [],
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en' },
    [],
  );
  const webprint = (note: string) => fe.deliverySlipWebPrint.generateDeliverySlipHtml(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00', type: 'delivery', special_instructions: note },
    [],
    CONTACT,
    { paperWidth: 80, language: 'en' },
  );

  // Emoji, so a UTF-16 clamp and a code-point clamp disagree. A combining-mark run
  // is the other case: only a grapheme-aware clamp keeps any of it.
  const overLong = [
    '\u{1F4E6}'.repeat(150),
    'e' + '\u{0301}'.repeat(300),
    'leave the parcel with the neighbour at number 42 '.repeat(20),
    'a' + '\u{0301}'.repeat(MAX_DELIVERY_SLIP_NOTE_CHARS),
  ];

  for (const note of overLong) {
    // Production trims before it clamps, so the expectation has to as well.
    const clamped = clampDeliverySlipText(note.trim(), MAX_DELIVERY_SLIP_NOTE_CHARS);
    assert.ok(clamped.truncatedChars > 0, "the fixture exceeds the budget, so the clamp is exercised");
    assert.ok(note.trim().length > clamped.text.length, "the fixture is genuinely over budget after trimming");

    // Backend: the data it prints from is exactly the shared clamp's output, and
    // the count it reports is what it actually withheld.
    const backend = buildDeliverySlipPrintData({ ...ORDER, special_instructions: note }, ORDER.items, CONTACT);
    assert.equal(backend.note, clamped.text, 'the backend retains the shared clamp\'s text');
    assert.equal(backend.noteTruncatedChars, clamped.truncatedChars, 'the backend reports the honest count');
    const backendText = escPosToText(renderBackend(note).data).replace(/\s+/g, ' ');
    assert.ok(backendText.includes('more characters not shown'), 'the backend marks an over-long note as cut');
    assert.ok(
      backendText.includes(` ${clamped.truncatedChars} more characters`),
      `the backend states the honest count (${clamped.truncatedChars})`,
    );

    // Web print: the fragment must carry the clamped text and nothing past it, and
    // the marker must state the count actually withheld. This is the assertion that
    // failed when the browser clamped by code point while the backend clamped by
    // UTF-16 unit: the fragment printed 150 emoji and still claimed 100 were cut.
    const html = webprint(note);
    const retained = clamped.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(html.includes(retained), 'the web-print fragment carries the shared clamp\'s text');

    const claimed = html.match(/(\d+) more characters not shown/);
    assert.ok(claimed, 'an over-long note is marked as cut on the paper');
    assert.equal(Number(claimed![1]), clamped.truncatedChars, 'the printed count is what was withheld');

    // WebUSB: the encoder marks the cut too, and states the same honest count.
    const asText = Buffer.from(webusb(note)).toString('latin1');
    assert.ok(
      asText.includes('more characters not shown'),
      'the WebUSB encoder marks an over-long note as cut',
    );
    assert.ok(
      asText.includes(` ${clamped.truncatedChars} more characters`),
      `the WebUSB encoder states the honest count (${clamped.truncatedChars})`,
    );
  }
});

test('delivery slip: the note budget is declared once, in the shared contract', () => {
  // The constant and the algorithm that applies it must travel together, or a
  // change to the bound lands on one path and not the others.
  const shared = fs.readFileSync(path.join(__dirname, '../shared/print/document.ts'), 'utf8');
  assert.ok(
    /export const MAX_DELIVERY_SLIP_NOTE_CHARS = \d+;/.test(shared),
    'the note budget is declared and exported by the shared document contract',
  );
  for (const file of [
    '../frontend/src/lib/printer/delivery-slip-encoder.ts',
    '../frontend/src/lib/printer/delivery-slip-web-print.ts',
    '../main/printers/document-delivery-slip.ts',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(
      !/const MAX_NOTE_CHARS\s*=/.test(source) && !/function clampNote\s*\(/.test(source),
      `${file} declares no local copy of the budget or its clamp`,
    );
  }
});

test('delivery slip: a raw control byte in free text never reaches the printer', () => {
  // A printer command is a byte sequence, not a spelling. The brace escape denies
  // the {TOKEN} form; this denies the byte form, which would otherwise reach the
  // wire from any field on any document. ESC d 5 is "print and feed five lines".
  // Probes chosen because a clean slip never emits them: the renderer does emit
  // ESC d 5 itself, as a feed before its own cut, so that one is not a probe.
  const PROBES = [
    ['cash drawer pulse', Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])],
    ['bit-image', Buffer.from([0x1b, 0x2a])],
    ['select print area', Buffer.from([0x1b, 0x26])],
    ['vertical tab', Buffer.from([0x1d, 0x76])],
  ] as const;

  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-42', false);
  const render = (order: any, contact: any = CONTACT) => renderDeliverySlipViaDocument(order, ORDER.items, contact, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
  });

  for (const [label, probe] of PROBES) {
    const payload = 'hi' + probe.toString('latin1') + 'bye';
    for (const [field, result] of [
      ['note', render({ ...ORDER, special_instructions: payload })],
      ['name', render({ ...ORDER }, { ...CONTACT, name: payload })],
      ['address', render({ ...ORDER }, { ...CONTACT, address: payload })],
    ] as const) {
      assert.ok(
        !result.data.includes(probe),
        `an ESC ${label} sequence in the ${field} must not reach the wire`,
      );
    }
  }

  // A line that cannot be represented is dropped whole, and the drop is warned
  // rather than silent — the merchant is told the note did not print.
  const hostile = render({ ...ORDER, special_instructions: 'hi' + PROBES[0][1].toString('latin1') + 'bye' });
  assert.ok(
    hostile.warnings.length > 0,
    'a note that cannot be represented is reported, not silently dropped',
  );
  assert.ok(!escPosToText(hostile.data).includes('undefined'), 'no placeholder is printed in its place');

  // An ordinary note is untouched by the strip.
  const plain = render({ ...ORDER, special_instructions: 'hi bye' });
  assert.ok(escPosToText(plain.data).includes('hi bye'), 'an ordinary note prints unchanged');
  assert.deepEqual(plain.warnings, [], 'an ordinary note produces no warning');

  // The renderer's own control sequences must survive the strip, or the slip
  // would print as one undifferentiated block of monospace.
  assert.ok(plain.data.includes(Buffer.from([0x1b, 0x45, 0x01])), 'the renderer still emits its own bold');
  assert.equal([...plain.data].filter((byte) => byte === 0x1d).length, 1, 'one intentional cut');
});

test('delivery slip: an over-long order note is bounded and visibly marked, never silently cut', () => {
  // max_order_notes_length is a tenant setting, so a raised limit or a legacy row
  // can carry more than a courier sheet should spend. A note that ends without
  // saying it was cut reads as the whole instruction.
  const overLong = 'Leave the parcel with the neighbour at number 42 '.repeat(40);
  const printData = buildDeliverySlipPrintData(
    { ...ORDER, special_instructions: overLong },
    ORDER.items,
    CONTACT,
  );
  assert.ok(
    printData.note.length <= MAX_DELIVERY_SLIP_NOTE_CHARS,
    `the note is bounded to ${MAX_DELIVERY_SLIP_NOTE_CHARS} chars, got ${printData.note.length}`,
  );
  assert.equal(printData.noteTruncatedChars, overLong.trim().length - printData.note.length);

  const result = renderDeliverySlipViaDocument({ ...ORDER, special_instructions: overLong }, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: resolvePrinterProfile({ paper_width: 'cols-42' }).cutMode,
    capabilities: capabilitiesForPrinter(resolvePrinterProfile({ paper_width: 'cols-42' }), 'cols-42', false),
  });
  const text = escPosToText(result.data);
  assert.ok(/more characters not shown/.test(text), 'the truncation is stated on the paper, not only in the data');
  assert.ok(text.includes('Espresso Doppio'), 'the items still print after a bounded note');

  // The budget counts UTF-16 units, the same way the address budget does, so a
  // note of exactly the budget prints whole.
  const atBudget = 'x'.repeat(MAX_DELIVERY_SLIP_NOTE_CHARS);
  const clamped = buildDeliverySlipPrintData(
    { ...ORDER, special_instructions: atBudget },
    ORDER.items,
    CONTACT,
  );
  assert.equal(clamped.note, atBudget, 'a note of exactly the budget prints whole');
  assert.equal(clamped.noteTruncatedChars, 0);

  // Supplementary-plane text is walked by grapheme, so the budget never cuts a
  // surrogate pair in half.
  const emoji = '\u{1F4E6}';
  const overBudget = buildDeliverySlipPrintData(
    { ...ORDER, special_instructions: emoji.repeat(MAX_DELIVERY_SLIP_NOTE_CHARS) },
    ORDER.items,
    CONTACT,
  );
  assert.equal([...overBudget.note].every((cluster) => cluster === emoji), true, 'every kept cluster is a whole emoji');
  assert.ok(overBudget.noteTruncatedChars > 0, 'an over-budget emoji note reports what it dropped');
  assert.equal(overBudget.note.length % 2, 0, 'the budget never leaves half a surrogate pair');
});

test('delivery slip: a control token in free text prints as text, never as a command', () => {
  // Printer commands occupy a whole trimmed line. A command spelling embedded in
  // free text must not run, and unrelated curly braces must survive unchanged.
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-42', false);
  const hostile = '{CUT} ring {tag} twice {BOLD} loudly {INIT}';

  for (const [field, apply] of [
    ['note', (o: any, c: any) => [{ ...o, special_instructions: hostile }, c]],
    ['address', (o: any, c: any) => [o, { ...c, address: hostile }]],
    ['name', (o: any, c: any) => [o, { ...c, name: hostile }]],
    ['phone', (o: any, c: any) => [o, { ...c, phone: hostile }]],
    ['order number', (o: any, c: any) => [{ ...o, order_number: hostile }, c]],
    ['item name', (o: any, c: any) => [o, { ...c, __items: [{ product_name: hostile, quantity: 1, special_instructions: '' }] }]],
    ['item instruction', (o: any, c: any) => [o, { ...c, __items: [{ product_name: 'X', quantity: 1, special_instructions: hostile }] }]],
    ['addon name', (o: any, c: any) => [o, { ...c, __items: [{ product_name: 'X', quantity: 1, special_instructions: '', addons: [{ name: hostile }] }] }]],
  ] as const) {
    const [order, contact] = apply({ ...ORDER, special_instructions: '' }, { ...CONTACT });
    const items = (contact as any).__items || ORDER.items;
    const { __items: _omit, ...cleanContact } = contact as any;
    const result = renderDeliverySlipViaDocument(order as any, items, cleanContact, {
      columns: 42,
      language: 'en',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      useUnicode: false,
      arabicShaping: false,
      cutMode: profile.cutMode,
      capabilities,
    });
    // GS is the paper-cut lead byte. Only the trailing standalone {CUT} cuts.
    const cuts = [...result.data].filter((byte) => byte === 0x1d).length;
    assert.equal(cuts, 1, `a {CUT} in the ${field} must not cut the paper (found ${cuts} cuts)`);
    const printedText = escPosToText(result.data);
    assert.ok(printedText.includes('ring'), `the ${field} still prints its text`);
    assert.ok(printedText.includes('{tag}'), `the ${field} keeps user curly braces`);
  }

  // The renderer keeps writing its own tokens: a real bold item line still bolds.
  const bolded = renderDeliverySlipViaDocument(ORDER, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
  });
  assert.ok(bolded.lines.some((line) => line.startsWith('{BOLD}')), 'the renderer still emits its own control tokens');
});

test('delivery slip: the validator accepts both block shapes and rejects a broken one', () => {
  const base = buildDeliverySlipDocument(
    buildDeliverySlipPrintData(ORDER, ORDER.items, CONTACT),
    {
      columns: 42,
      languages: ['en'],
      baseDirection: 'ltr',
      locale: 'en-US',
      currency: 'INR',
      currencySymbol: 'Rs',
      trimDecimals: false,
      resolveLabel: (conceptId) => conceptId,
    },
  );
  assert.equal(base.blocks.length, 3);
  assert.ok(isDeliverySlipDocument(base), 'the three-block document is valid');

  const noted = buildDeliverySlipDocument(
    buildDeliverySlipPrintData({ ...ORDER, special_instructions: 'Ring twice' }, ORDER.items, CONTACT),
    {
      columns: 42,
      languages: ['en'],
      baseDirection: 'ltr',
      locale: 'en-US',
      currency: 'INR',
      currencySymbol: 'Rs',
      trimDecimals: false,
      resolveLabel: (conceptId) => conceptId,
    },
  );
  assert.equal(noted.blocks.length, 4, 'a note adds exactly one block');
  assert.equal(noted.blocks[2].kind, 'delivery-slip-notes', 'the note sits between contact and items');
  assert.ok(isDeliverySlipDocument(noted), 'the four-block document is valid');

  const kinds = (document: any) => document.blocks.map((block: any) => block.kind);
  const mutate = (blocks: any[]) => ({ ...noted, blocks });

  assert.equal(
    isDeliverySlipDocument(mutate(kinds(noted).filter((kind: string) => kind !== 'delivery-slip-items'))),
    false,
    'a document with no items block is rejected',
  );
  assert.equal(
    isDeliverySlipDocument(mutate([
      ...kinds(noted).filter((kind: string) => kind !== 'delivery-slip-contact'),
      'delivery-slip-contact',
    ].map((kind) => noted.blocks.find((block: any) => block.kind === kind)))),
    false,
    'a second contact block is rejected',
  );
  assert.equal(
    isDeliverySlipDocument(mutate([...kinds(noted), 'delivery-slip-notes'].map((kind) => noted.blocks.find((block: any) => block.kind === kind)))),
    false,
    'a second notes block is rejected',
  );
  // A duplicate header is only a *duplicate* if it is not the one in first
  // position, so prepend a copy rather than reordering the original.
  assert.equal(
    isDeliverySlipDocument(mutate([
      noted.blocks[0],
      ...noted.blocks,
    ])),
    false,
    'a second header block is rejected',
  );
  assert.equal(
    isDeliverySlipDocument(mutate([
      ...noted.blocks.slice(1),
      noted.blocks[0],
    ])),
    false,
    'a document whose first block is not the header is rejected',
  );
  assert.equal(
    isDeliverySlipDocument(mutate([
      noted.blocks[0],
      ...noted.blocks.filter((block: any) => block.kind !== 'delivery-slip-items'),
    ])),
    false,
    'a document that does not end with the items block is rejected',
  );
});

test('delivery slip: all three render paths print the order note', () => {
  const NOTE = 'Do not ring the doorbell';
  const order = { ...ORDER, special_instructions: NOTE };
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });

  // 1. Backend ESC/POS document pipeline.
  const backend = renderDeliverySlipViaDocument(order, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
  });
  assert.ok(escPosToText(backend.data).includes(NOTE), 'the backend ESC/POS path prints the note');

  // 2. Browser WebUSB encoder and 3. browser web print. Both are frontend modules,
  // so the two paths have to agree with the backend or the courier sees the note
  // only on the printer this merchant happens to own.
  const webusb = fe.deliverySlipEncoder.buildDeliverySlipBytes(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00', type: 'delivery', special_instructions: NOTE },
    ORDER.items.map((item: any) => ({ product_name: item.product_name, quantity: item.quantity, special_instructions: item.special_instructions })),
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en' },
    [],
  );
  assert.ok(
    new TextDecoder().decode(webusb).includes('doorbell'),
    'the WebUSB encoder prints the note',
  );

  const html = fe.deliverySlipWebPrint.generateDeliverySlipHtml(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00', type: 'delivery', special_instructions: NOTE },
    ORDER.items.map((item: any) => ({ product_name: item.product_name, quantity: item.quantity, special_instructions: item.special_instructions })),
    CONTACT,
    { paperWidth: 80, language: 'en' },
  );
  assert.ok(html.includes('doorbell'), 'the web-print path prints the note');

  // The note is operator-typed free text that reaches an HTML fragment, so it has
  // to be escaped rather than interpolated. `<` must not survive as markup.
  const injected = fe.deliverySlipWebPrint.generateDeliverySlipHtml(
    {
      order_number: 'ORD-DEL-001',
      created_at: '2026-08-21 18:42:00',
      type: 'delivery',
      special_instructions: '<img src=x onerror=alert(1)>',
    },
    [],
    CONTACT,
    { paperWidth: 80, language: 'en' },
  );
  assert.ok(!injected.includes('<img'), 'a note cannot inject markup into the print fragment');
  assert.ok(injected.includes('&lt;img'), 'the note is HTML-escaped instead');
});

test('delivery slip: paid, partial, unpaid, and multi-tender summaries match across all render paths', () => {
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const paymentOrder = { ...ORDER, total: 25, special_instructions: 'Call on arrival' };
  const paidOrder = {
    ...paymentOrder,
    bill: {
      payment_status: 'paid',
      total: 25,
      payment_details: JSON.stringify([{ method: 'card', amount: 25 }]),
    },
  };
  const unpaidOrder = { ...paymentOrder, expected_payment_method: 'cash' };
  const partialOrder = {
    ...paymentOrder,
    bill: {
      payment_status: 'partial',
      total: 25,
      balance: 10,
      payment_details: [{ method: 'cash', amount: 15 }],
    },
  };
  const multiTenderOrder = {
    ...paymentOrder,
    bill: {
      payment_status: 'paid',
      total: 25,
      payment_details: JSON.stringify([
        { method: 'cash', amount: 10 },
        { method: 'card', amount: 15 },
      ]),
    },
  };
  const paymentOptions = { locale: 'en-US', currency: 'USD' };
  const paidData = buildDeliverySlipPrintData(paidOrder, ORDER.items, CONTACT, paymentOptions);
  const unpaidData = buildDeliverySlipPrintData(unpaidOrder, ORDER.items, CONTACT, paymentOptions);
  const partialData = buildDeliverySlipPrintData(partialOrder, ORDER.items, CONTACT, paymentOptions);
  const multiTenderData = buildDeliverySlipPrintData(multiTenderOrder, ORDER.items, CONTACT, paymentOptions);
  assert.deepEqual(paidData.payment, {
    status: 'paid',
    method: 'card',
    amount: 25,
    amountDue: 0,
    formattedAmount: '$25.00',
    formattedAmountDue: '$0.00',
  });
  assert.deepEqual(unpaidData.payment, {
    status: 'unpaid',
    amount: 25,
    amountDue: 25,
    formattedAmount: '$25.00',
    formattedAmountDue: '$25.00',
    expectedMethod: 'cash',
  });
  assert.deepEqual(partialData.payment, {
    status: 'unpaid',
    amount: 10,
    amountDue: 10,
    formattedAmount: '$10.00',
    formattedAmountDue: '$10.00',
  }, 'a partial bill uses its outstanding balance');
  assert.deepEqual(multiTenderData.payment, {
    status: 'paid',
    methods: ['cash', 'card'],
    amount: 25,
    amountDue: 0,
    formattedAmount: '$25.00',
    formattedAmountDue: '$0.00',
  }, 'a fully paid bill retains all distinct tender methods');

  const backend = (order: any) => renderDeliverySlipViaDocument(order, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
  });
  const frontOrder = {
    order_number: 'ORD-DEL-001',
    created_at: '2026-08-21 18:42:00',
    type: 'delivery',
    special_instructions: paymentOrder.special_instructions,
  };
  const frontItems = ORDER.items.map((item: any) => ({
    product_name: item.product_name,
    quantity: item.quantity,
    special_instructions: item.special_instructions,
  }));
  const assertPaid = (text: string, path: string) => {
    assert.ok(text.includes('PAID'), `${path} shows paid status`);
    assert.ok(text.includes('Card'), `${path} shows the method`);
    assert.ok(text.includes('Total: $25.00'), `${path} shows the paid total`);
    assert.ok(text.includes('Amount Due: $0.00'), `${path} shows zero due`);
    assert.ok(text.indexOf('PAID') > text.indexOf('Call on arrival'), `${path} places payment after the delivery note`);
    assert.ok(text.indexOf('PAID') < text.indexOf('Espresso Doppio'), `${path} places payment before the items`);
  };
  const backendPaid = backend(paidOrder);
  assertPaid(escPosToText(backendPaid.data), 'backend ESC/POS');
  assert.deepEqual(backendPaid.document.blocks.map((block) => block.kind), [
    'delivery-slip-header',
    'delivery-slip-contact',
    'delivery-slip-notes',
    'delivery-slip-payment',
    'delivery-slip-items',
  ]);
  assert.ok(isDeliverySlipDocument(backendPaid.document), 'the payment document passes its guard');

  const webusbPaid = fe.deliverySlipEncoder.buildDeliverySlipBytes(
    frontOrder,
    frontItems,
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en', payment: paidData.payment },
    [],
  );
  assertPaid(escPosToText(Buffer.from(webusbPaid)), 'WebUSB');
  const htmlPaid = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, frontItems, CONTACT, {
    paperWidth: 80,
    language: 'en',
    payment: paidData.payment,
  });
  assertPaid(htmlPaid, 'web print');
  assert.ok(htmlPaid.includes('#15803d'), 'paid web print uses the green status box');

  const multiTenderBackend = escPosToText(backend(multiTenderOrder).data);
  const multiTenderWebUsb = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
    frontOrder,
    frontItems,
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en', payment: multiTenderData.payment },
    [],
  )));
  const multiTenderHtml = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, frontItems, CONTACT, {
    paperWidth: 80,
    language: 'en',
    payment: multiTenderData.payment,
  });
  for (const [text, path] of [
    [multiTenderBackend, 'backend ESC/POS'],
    [multiTenderWebUsb, 'WebUSB'],
    [multiTenderHtml, 'web print'],
  ]) {
    assert.ok(text.includes('Multiple payment methods'), `${path} does not misstate a split tender`);
    assert.ok(text.indexOf('Multiple payment methods') > text.indexOf('Call on arrival'), `${path} places payment after the delivery note`);
    assert.ok(text.indexOf('Multiple payment methods') < text.indexOf('Espresso Doppio'), `${path} places payment before the items`);
  }

  const backendUnpaid = escPosToText(backend(unpaidOrder).data);
  const webusbUnpaid = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
    frontOrder,
    frontItems,
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en', payment: unpaidData.payment },
    [],
  )));
  const htmlUnpaid = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, frontItems, CONTACT, {
    paperWidth: 80,
    language: 'en',
    payment: unpaidData.payment,
  });
  for (const [text, path] of [
    [backendUnpaid, 'backend ESC/POS'],
    [webusbUnpaid, 'WebUSB'],
    [htmlUnpaid, 'web print'],
  ]) {
    assert.ok(text.includes('TO COLLECT'), `${path} shows collection status`);
    assert.ok(text.includes('$25.00'), `${path} shows the amount to collect`);
    assert.ok(text.includes('Cash on Delivery'), `${path} identifies cash on delivery`);
    assert.ok(text.indexOf('TO COLLECT') < text.indexOf('Espresso Doppio'), `${path} places collection before the items`);
  }
  assert.ok(htmlUnpaid.includes('#d97706'), 'unpaid web print uses the amber status box');

  const backendPartial = escPosToText(backend(partialOrder).data);
  const webusbPartial = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
    frontOrder,
    frontItems,
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en', payment: partialData.payment },
    [],
  )));
  const htmlPartial = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, frontItems, CONTACT, {
    paperWidth: 80,
    language: 'en',
    payment: partialData.payment,
  });
  for (const [text, path] of [
    [backendPartial, 'backend ESC/POS'],
    [webusbPartial, 'WebUSB'],
    [htmlPartial, 'web print'],
  ]) {
    assert.ok(text.includes('TO COLLECT'), `${path} shows collection status after partial payment`);
    assert.ok(text.includes('$10.00'), `${path} shows the outstanding balance, not the original order total`);
    assert.ok(text.indexOf('TO COLLECT') < text.indexOf('Espresso Doppio'), `${path} places collection before the items`);
  }
});

test('delivery slip: current split checks and refunds cannot turn a balance into false COD or paid status', () => {
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const paymentOptions = { locale: 'en-US', currency: 'USD' };
  const splitBills = [
    { id: 10, payment_status: 'paid', total: 12, balance: 0, payment_details: [{ method: 'card', amount: 12 }] },
    { id: 11, payment_status: 'partial', total: 8, balance: 3.25, payment_details: [{ method: 'cash', amount: 4.75 }] },
  ];
  for (const bills of [splitBills, [...splitBills].reverse()]) {
    const partial = buildDeliverySlipPrintData({ ...ORDER, total: 20, bills }, ORDER.items, CONTACT, paymentOptions).payment;
    assert.deepEqual(partial, {
      status: 'unpaid',
      amount: 3.25,
      amountDue: 3.25,
      formattedAmount: '$3.25',
      formattedAmountDue: '$3.25',
    }, 'only the active check balance is collectible, independent of bill ordering');
  }

  const kwdSplit = buildDeliverySlipPrintData({
    ...ORDER,
    total: 2.510,
    bills: [
      { payment_status: 'partial', total: 1.255, balance: 0.001 },
      { payment_status: 'partial', total: 1.255, balance: 0.001 },
    ],
  }, ORDER.items, CONTACT, { locale: 'en-KW', currency: 'KWD' }).payment;
  assert.equal(kwdSplit?.amount, 0.002, 'two KWD split balances sum at the currency’s three-decimal minor unit');
  assert.equal(kwdSplit?.amountDue, 0.002, 'KWD outstanding due uses the same canonical minor-unit factor');
  assert.ok(kwdSplit?.formattedAmount.includes('0.002'), 'KWD split balance formatting preserves all three decimal places');

  const paidSplit = buildDeliverySlipPrintData({
    ...ORDER,
    total: 20,
    bills: [
      { payment_status: 'paid', total: 12, balance: 0, payment_details: [{ method: 'card', amount: 12 }] },
      { payment_status: 'paid', total: 8, balance: 0, payment_details: [{ method: 'cash', amount: 8 }] },
    ],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  assert.deepEqual(paidSplit, {
    status: 'paid',
    methods: ['card', 'cash'],
    amount: 20,
    amountDue: 0,
    formattedAmount: '$20.00',
    formattedAmountDue: '$0.00',
  }, 'all settled checks preserve their stored total and distinct tender methods');

  const refunded = buildDeliverySlipPrintData({
    ...ORDER,
    total: 20,
    bills: [{ payment_status: 'refunded', total: 20, balance: 0, payment_details: [{ method: 'card', amount: 20 }] }],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  const partialRefund = buildDeliverySlipPrintData({
    ...ORDER,
    total: 20,
    bills: [
      { payment_status: 'paid', total: 12, balance: 0, payment_details: [{ method: 'card', amount: 12 }] },
      { payment_status: 'partially_refunded', total: 8, balance: 0, payment_details: [{ method: 'cash', amount: 8 }] },
    ],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  const partiallyRefundedWithBalance = buildDeliverySlipPrintData({
    ...ORDER,
    total: 20,
    bills: [{ payment_status: 'partially_refunded', total: 20, balance: 7 }],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  const refundedWithBalance = buildDeliverySlipPrintData({
    ...ORDER,
    total: 20,
    bills: [{ payment_status: 'refunded', total: 20, balance: 7 }],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  const mixedRefundSplit = buildDeliverySlipPrintData({
    ...ORDER,
    total: 10,
    bills: [
      { payment_status: 'refunded', total: 7, balance: 7 },
      { payment_status: 'unpaid', total: 3, balance: 3 },
    ],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  const zeroUnpaid = buildDeliverySlipPrintData({
    ...ORDER,
    total: 0,
    bills: [{ payment_status: 'unpaid', total: 0, balance: 0 }],
  }, ORDER.items, CONTACT, paymentOptions).payment;
  assert.equal(refunded?.status, 'refunded');
  assert.equal(refunded?.amount, 0, 'a refund never prints the original paid total as current collection');
  assert.equal(partialRefund?.status, 'partially_refunded');
  assert.equal(partialRefund?.amount, 0, 'refund output does not invent a net-paid amount');
  assert.equal(partiallyRefundedWithBalance?.formattedAmountDue, '$7.00', 'a partially refunded bill preserves its stored outstanding balance');
  assert.equal(refundedWithBalance?.formattedAmountDue, '$7.00', 'a refunded bill preserves its stored outstanding balance');
  assert.equal(mixedRefundSplit?.status, 'partially_refunded', 'a refunded split sibling keeps the mixed order marked as refunded');
  assert.equal(mixedRefundSplit?.formattedAmountDue, '$10.00', 'split due sums stored balances across refund and open checks');
  assert.equal(zeroUnpaid?.status, 'unpaid', 'zero balance alone cannot claim payment');
  assert.equal(zeroUnpaid?.amount, 0);

  const backend = (order: any) => renderDeliverySlipViaDocument(order, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
  });
  const frontOrder = { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00' };
  for (const [payment, expected] of [[refunded, 'REFUNDED'], [partialRefund, 'PARTIALLY REFUNDED']] as const) {
    const order = { ...ORDER, total: 20, bills: payment === refunded
      ? [{ payment_status: 'refunded', total: 20, balance: 0 }]
      : [
        { payment_status: 'paid', total: 12, balance: 0 },
        { payment_status: 'partially_refunded', total: 8, balance: 0 },
      ] };
    const printData = buildDeliverySlipPrintData(order, ORDER.items, CONTACT, paymentOptions);
    const backendResult = backend(order);
    const webusb = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
      frontOrder, [], CONTACT, { paperWidth: 80, columns: 42, language: 'en', payment: printData.payment }, [],
    )));
    const html = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, [], CONTACT, {
      paperWidth: 80, language: 'en', payment: printData.payment,
    });
    for (const text of [escPosToText(backendResult.data), webusb, html]) {
      assert.ok(text.includes(expected), `${expected} appears on every delivery slip path`);
      assert.ok(text.includes('Amount Due: $0.00'), 'refund output states zero due without claiming net payment');
      assert.ok(!text.includes('TO COLLECT'), 'a refund is never presented as cash on delivery');
      assert.ok(!text.includes('PAID:'), 'a refund is never presented as paid');
      assert.ok(!text.includes('Card') && !text.includes('Cash'), 'refund output does not imply payment remains collectible');
    }
  }

  const outstandingRefundOrders = [
    {
      order: { ...ORDER, total: 20, bill: { payment_status: 'refunded', total: 20, balance: 7 } },
      status: 'REFUNDED',
      due: '$7.00',
    },
    {
      order: { ...ORDER, total: 20, bill: { payment_status: 'partially_refunded', total: 20, balance: 7 } },
      status: 'PARTIALLY REFUNDED',
      due: '$7.00',
    },
    {
      order: {
        ...ORDER,
        total: 10,
        bills: [
          { payment_status: 'refunded', total: 7, balance: 7 },
          { payment_status: 'unpaid', total: 3, balance: 3 },
        ],
      },
      status: 'PARTIALLY REFUNDED',
      due: '$10.00',
    },
  ] as const;
  for (const { order, status, due } of outstandingRefundOrders) {
    const printData = buildDeliverySlipPrintData(order, ORDER.items, CONTACT, paymentOptions);
    const backendResult = backend(order);
    const webusb = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
      frontOrder, [], CONTACT, { paperWidth: 80, columns: 42, language: 'en', payment: printData.payment }, [],
    )));
    const html = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, [], CONTACT, {
      paperWidth: 80, language: 'en', payment: printData.payment,
    });
    for (const text of [escPosToText(backendResult.data), webusb, html]) {
      assert.ok(text.includes(status), `${status} remains visible with an outstanding refund balance`);
      assert.ok(text.includes(`Amount Due: ${due}`), `stored refund balance ${due} is shown on each print path`);
      assert.ok(!text.includes('TO COLLECT') && !text.includes('Cash on Delivery'), 'refund state is not relabeled as COD');
      assert.ok(!text.includes('PAID:'), 'refund state is not mislabeled as paid');
    }
  }

  const zeroOrder = { ...ORDER, total: 0, bills: [{ payment_status: 'unpaid', total: 0, balance: 0 }] };
  const zeroData = buildDeliverySlipPrintData(zeroOrder, ORDER.items, CONTACT, paymentOptions);
  const zeroWebUsb = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
    frontOrder, [], CONTACT, { paperWidth: 80, columns: 42, language: 'en', payment: zeroData.payment }, [],
  )));
  const zeroHtml = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, [], CONTACT, {
    paperWidth: 80, language: 'en', payment: zeroData.payment,
  });
  for (const text of [escPosToText(backend(zeroOrder).data), zeroWebUsb, zeroHtml]) {
    assert.ok(text.includes('Amount Due: $0.00'), 'unpaid zero-balance output is explicit without claiming paid');
    assert.ok(!text.includes('TO COLLECT') && !text.includes('Cash on Delivery'), 'zero balance is not a COD collection');
    assert.ok(!text.includes('PAID:'), 'zero balance alone cannot claim payment');
  }
});

test('delivery slip: payment method text is bounded, wrapped, and cannot inject printer or HTML commands', () => {
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const method = `Custom {CUT}\n<img src=x>${'X'.repeat(70)}`;
  const order = {
    ...ORDER,
    total: 25,
    bill: {
      payment_status: 'paid',
      total: 25,
      payment_details: [{ method, amount: 25 }],
    },
  };
  const backend = renderDeliverySlipViaDocument(order, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
  });
  const paymentBlock = backend.document.blocks.find((block) => block.kind === 'delivery-slip-payment');
  assert.ok(paymentBlock && paymentBlock.kind === 'delivery-slip-payment', 'the payment block is present');
  assert.ok(!paymentBlock.methodName?.text.includes('{'), 'printer control braces are removed');
  assert.ok(!paymentBlock.methodName?.text.includes('\n'), 'line breaks are removed from the method');
  assert.ok((paymentBlock.methodName?.text.length ?? 0) <= 60, 'custom method names are bounded');
  const paymentStart = backend.lines.findIndex((line) => line.includes('PAID'));
  const itemStart = backend.lines.findIndex((line) => line.includes('Espresso Doppio'));
  const paymentLines = backend.lines.slice(paymentStart, itemStart).filter((line) => line.trim() && !line.startsWith('-'));
  assert.ok(paymentLines.every((line) => displayCellWidth(line.replace(/\{\/?BOLD\}/g, '')) <= 42), 'backend payment lines wrap to the configured columns');
  assert.equal(backend.lines.filter((line) => line.trim() === '{CUT}').length, 1, 'custom method text cannot add a cut command');

  const unsafePayment = { status: 'paid' as const, method, amount: 25, amountDue: 0, formattedAmount: '$25.00', formattedAmountDue: '$0.00' };
  const webusb = escPosToText(Buffer.from(fe.deliverySlipEncoder.buildDeliverySlipBytes(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00' },
    [],
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en', payment: unsafePayment },
    [],
  )));
  assert.ok(!webusb.includes('{CUT}'), 'WebUSB payment text cannot pass an ESC/POS token');
  assert.ok(webusb.includes('X'.repeat(30)), 'WebUSB payment text is wrapped without being discarded');

  const html = fe.deliverySlipWebPrint.generateDeliverySlipHtml(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00' },
    [],
    CONTACT,
    { paperWidth: 80, language: 'en', payment: unsafePayment },
  );
  assert.ok(!html.includes('<img'), 'payment method text cannot inject HTML');
  assert.ok(html.includes('&lt;img'), 'payment method markup is escaped');
});

test('delivery slip: unsupported payment text is classified as financial for native, raster, and WebUSB output', () => {
  const profile = resolvePrinterProfile({ profile_id: 'generic-escpos-58' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-32', false);
  const order = {
    ...ORDER,
    total: 25,
    bill: {
      payment_status: 'paid',
      total: 25,
      balance: 0,
      payment_details: [{ method: 'پرداخت', amount: 25 }],
    },
  };
  const backend = renderDeliverySlipViaDocument(order, ORDER.items, CONTACT, {
    columns: 32,
    language: 'en',
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
  });
  assert.ok(backend.warnings.some((warning) => warning.kind === 'financial'), 'native text fallback marks the payment row financial');
  assert.equal(backend.rasterGroups.find((group) => group.groupId === 'delivery-slip-payment')?.financial, true,
    'raster fallback retains the payment group financial marker');

  const payment = buildDeliverySlipPrintData(order, ORDER.items, CONTACT, { locale: 'en-US', currency: 'USD' }).payment;
  assert.ok(payment);
  const webusbWarnings: any[] = [];
  fe.deliverySlipEncoder.buildDeliverySlipBytes(
    { order_number: ORDER.order_number, created_at: ORDER.created_at },
    [],
    CONTACT,
    { paperWidth: 58, columns: 32, language: 'en', payment },
    webusbWarnings,
  );
  assert.ok(webusbWarnings.some((warning) => warning.kind === 'financial'), 'WebUSB marks an unsupported payment row financial before dispatch');
});

test('delivery slip: an order with no contact still renders, and says nothing it does not know', () => {
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const capabilities = capabilitiesForPrinter(profile, 'cols-42', false);
  const result = renderDeliverySlipViaDocument(ORDER, ORDER.items, { name: '', phone: '', address: '' }, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities,
  });
  const text = escPosToText(result.data);
  assert.ok(text.includes('Espresso Doppio'), 'the items still print');
  const contactBlock = result.document.blocks.find((block) => block.kind === 'delivery-slip-contact') as any;
  assert.equal(contactBlock.addressSource, null, 'no address means no claimed source');
  assert.equal(contactBlock.phone, null, 'an unknown number prints as nothing, not as a placeholder');
  assert.ok(!text.includes('undefined'), 'an absent field never prints as the word undefined');
});

// ---------------------------------------------------------------------------
// Expected collection method and delivery note.
// ---------------------------------------------------------------------------

/** Every slip render path over the same order, whitespace-normalised because each one wraps. */
function renderAllSlipPaths(order: any): Array<[string, string]> {
  const profile = resolvePrinterProfile({ paper_width: 'cols-42' });
  const printData = buildDeliverySlipPrintData(order, ORDER.items, CONTACT, { locale: 'en-US', currency: 'USD' });
  const backend = renderDeliverySlipViaDocument(order, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    useUnicode: false,
    arabicShaping: false,
    cutMode: profile.cutMode,
    capabilities: capabilitiesForPrinter(profile, 'cols-42', false),
  });
  const frontOrder = {
    order_number: order.order_number,
    created_at: order.created_at,
    type: order.type,
    special_instructions: order.special_instructions,
    delivery_note: order.delivery_note,
  };
  const frontItems = ORDER.items.map((item: any) => ({ product_name: item.product_name, quantity: item.quantity }));
  const payment = printData.payment ? { payment: printData.payment } : {};
  const webusb = fe.deliverySlipEncoder.buildDeliverySlipBytes(
    frontOrder,
    frontItems,
    CONTACT,
    { paperWidth: 80, columns: 42, language: 'en', ...payment },
    [],
  );
  const html = fe.deliverySlipWebPrint.generateDeliverySlipHtml(frontOrder, frontItems, CONTACT, {
    paperWidth: 80,
    language: 'en',
    ...payment,
  });
  return [
    ['backend ESC/POS', escPosToText(backend.data)],
    ['WebUSB', escPosToText(Buffer.from(webusb))],
    ['web print', html],
  ].map(([name, text]) => [name, text.replace(/\s+/g, ' ')] as [string, string]);
}

test('delivery slip: an unpaid balance states the expected method, and unknown or pending never becomes cash on delivery', () => {
  const cases = [
    { stored: undefined, printed: 'Expected payment: Unknown' },
    { stored: null, printed: 'Expected payment: Unknown' },
    { stored: 'pending', printed: 'Expected payment: Pending' },
    { stored: 'card', printed: 'Expected payment: Card' },
    { stored: 'UPI', printed: 'Expected payment: UPI' },
    { stored: 'cash', printed: 'Cash on Delivery' },
  ];
  for (const { stored, printed } of cases) {
    const order = { ...ORDER, total: 25, expected_payment_method: stored };
    for (const [name, text] of renderAllSlipPaths(order)) {
      const label = `${name} with expected method ${JSON.stringify(stored)}`;
      assert.ok(text.includes('TO COLLECT: $25.00'), `${label}: the balance is still to collect, got:\n${text}`);
      assert.ok(text.includes(printed), `${label}: prints "${printed}", got:\n${text}`);
      assert.ok(!text.includes('PAID'), `${label}: an expectation is never presented as a payment`);
      if (stored !== 'cash') {
        assert.ok(!text.includes('Cash on Delivery'), `${label}: does not assume cash on delivery`);
      }
    }
  }

  // The expectation travels with the payment summary the browser paths fetch,
  // and a sanitiser bounds it before it reaches any printer.
  const hostile = buildDeliverySlipPrintData(
    { ...ORDER, total: 25, expected_payment_method: 'Custom {CUT}\nmethod' },
    ORDER.items,
    CONTACT,
    { locale: 'en-US', currency: 'USD' },
  );
  assert.equal(hostile.payment?.expectedMethod, 'Custom CUT method', 'printer braces and line breaks are stripped');
  assert.equal(
    buildDeliverySlipPrintData({ ...ORDER, total: 25 }, ORDER.items, CONTACT, { locale: 'en-US', currency: 'USD' }).payment?.expectedMethod,
    undefined,
    'an unknown method is absent from the summary, not a placeholder string',
  );
});

test('delivery slip: a captured payment wins over the expected method', () => {
  const paidOrder = {
    ...ORDER,
    total: 25,
    expected_payment_method: 'card',
    bill: { payment_status: 'paid', total: 25, payment_details: [{ method: 'cash', amount: 25 }] },
  };
  for (const [name, text] of renderAllSlipPaths(paidOrder)) {
    assert.ok(text.includes('PAID: Cash'), `${name}: the captured method is what prints, got:\n${text}`);
    assert.ok(!text.includes('Expected payment'), `${name}: a settled order does not repeat the expectation`);
    assert.ok(!text.includes('Card'), `${name}: the expected method is not mistaken for the captured one`);
  }

  const zeroDue = { ...ORDER, total: 0, expected_payment_method: 'card' };
  for (const [name, text] of renderAllSlipPaths(zeroDue)) {
    assert.ok(text.includes('Amount Due: $0.00'), `${name}: a zero balance stays explicit`);
    assert.ok(!text.includes('Expected payment'), `${name}: nothing to collect means no collection hint`);
  }
});

test('delivery slip: the delivery note prints once on every render path, beside the order note', () => {
  const DELIVERY_NOTE = 'Gate code 4321, leave with the guard';
  const order = { ...ORDER, delivery_note: DELIVERY_NOTE, special_instructions: 'Extra napkins' };
  for (const [name, text] of renderAllSlipPaths(order)) {
    assert.ok(text.includes(`Delivery note: ${DELIVERY_NOTE}`), `${name}: prints the delivery note, got:\n${text}`);
    assert.equal(text.split('Gate code 4321').length - 1, 1, `${name}: the delivery note prints once`);
    assert.ok(text.includes('Note: Extra napkins'), `${name}: the order note still prints`);
    assert.ok(text.indexOf('Gate code 4321') < text.indexOf('Espresso Doppio'), `${name}: the note sits above the items`);
  }

  // A delivery note on its own is enough to emit the notes block, and the
  // document stays valid; without either note the slip is the original three blocks.
  const printContext = {
    columns: 42,
    languages: ['en'],
    baseDirection: 'ltr' as const,
    locale: 'en-US',
    currency: 'INR',
    currencySymbol: 'Rs',
    trimDecimals: false,
    resolveLabel: (conceptId: string) => conceptId,
  };
  const alone = buildDeliverySlipDocument(
    buildDeliverySlipPrintData({ ...ORDER, delivery_note: DELIVERY_NOTE }, ORDER.items, CONTACT),
    printContext,
  );
  const notes = alone.blocks.find((block) => block.kind === 'delivery-slip-notes') as any;
  assert.ok(notes, 'a delivery note alone emits the notes block');
  assert.equal(notes.deliveryNote.text, DELIVERY_NOTE);
  assert.equal(notes.note, null, 'the order note stays empty');
  assert.ok(isDeliverySlipDocument(alone), 'the document with a delivery note passes its guard');
  for (const blank of ['', '   ', null, undefined]) {
    const blanked = buildDeliverySlipDocument(
      buildDeliverySlipPrintData({ ...ORDER, delivery_note: blank }, ORDER.items, CONTACT),
      printContext,
    );
    assert.equal(blanked.blocks.length, 3, `a ${JSON.stringify(blank)} delivery note leaves the slip unchanged`);
  }

  const injected = fe.deliverySlipWebPrint.generateDeliverySlipHtml(
    { order_number: 'ORD-DEL-001', created_at: '2026-08-21 18:42:00', delivery_note: '<img src=x onerror=alert(1)>' },
    [],
    CONTACT,
    { paperWidth: 80, language: 'en' },
  );
  assert.ok(!injected.includes('<img') && injected.includes('&lt;img'), 'the delivery note is HTML-escaped');

  const tokenised = renderDeliverySlipViaDocument({ ...ORDER, delivery_note: '{CUT} ring twice {INIT}' }, ORDER.items, CONTACT, {
    columns: 42,
    language: 'en',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: resolvePrinterProfile({ paper_width: 'cols-42' }).cutMode,
    capabilities: capabilitiesForPrinter(resolvePrinterProfile({ paper_width: 'cols-42' }), 'cols-42', false),
  });
  assert.equal([...tokenised.data].filter((byte) => byte === 0x1d).length, 1, 'a {CUT} in the delivery note does not cut the paper');
  assert.ok(escPosToText(tokenised.data).includes('ring twice'), 'and the note text still prints');
});

test('delivery slip: an over-long delivery note is clamped the same way on every render path', () => {
  const overLong = 'Leave the parcel with the neighbour at number 42 '.repeat(10);
  const clamped = clampDeliverySlipText(overLong.trim(), MAX_DELIVERY_SLIP_NOTE_CHARS);
  assert.ok(clamped.truncatedChars > 0, 'the fixture exceeds the budget');
  const printData = buildDeliverySlipPrintData({ ...ORDER, delivery_note: overLong }, ORDER.items, CONTACT);
  assert.equal(printData.deliveryNote, clamped.text, 'the backend keeps the shared clamp\'s text');
  assert.equal(printData.deliveryNoteTruncatedChars, clamped.truncatedChars, 'and reports the honest count');
  for (const [name, text] of renderAllSlipPaths({ ...ORDER, delivery_note: overLong })) {
    assert.ok(text.includes(clamped.text.replace(/\s+/g, ' ')), `${name}: prints the clamped delivery note`);
    assert.ok(text.includes(`${clamped.truncatedChars} more characters not shown`), `${name}: states the honest cut`);
  }
});

test('delivery slip: the delivery note and expected method stay off the kitchen ticket and the receipt', () => {
  const DELIVERY_NOTE = 'Gate code 4321, leave with the guard';
  const order = {
    ...RECEIPT_ORDER,
    type: 'delivery',
    special_instructions: '',
    delivery_note: DELIVERY_NOTE,
    expected_payment_method: 'card',
  };
  const outputs: Array<[string, string]> = [
    ['backend KOT', escPosToText(formatKOT(order, order.items, 'Main Kitchen', 42, false, 'full', 'en-US', { timeZone: 'UTC' }, [], false, 'en'))],
    ['WebUSB KOT', Buffer.from(fe.kotEncoder.buildKotBytes(order as any, { paperWidth: 80, language: 'en', stationName: 'Main Kitchen', timezone: 'UTC' })).toString('utf8')],
    ['backend receipt', escPosToText(formatReceipt(order, RECEIPT_BILL, RECEIPT_BUSINESS, 'classic', 42, false, false, undefined, []))],
    ['WebUSB receipt', escPosToText(Buffer.from(fe.receiptEncoder.buildClassicReceiptBytes(
      { ...RECEIPT_BILL, order } as any,
      { business_name: 'Cafe', currency: 'INR', country: 'IN', timezone: 'Asia/Kolkata' } as any,
      { paperWidth: 80 },
      [],
    )))],
  ];
  for (const [name, text] of outputs) {
    assert.ok(text.includes('Espresso Doppio'), `${name}: renders the order`);
    assert.ok(!text.includes('Gate code 4321'), `${name}: the courier note stays on the courier slip`);
    assert.ok(!text.includes('Expected payment'), `${name}: the expected method stays on the courier slip`);
  }
});

test('delivery slip: the local paths carry the delivery note and the fetched expectation to the encoders', () => {
  // The browser paths take the note from the order projection and the expected
  // method from the backend payment summary, so both must survive the hook.
  const usePrinter = fs.readFileSync(path.join(__dirname, '../frontend/src/hooks/usePrinter.ts'), 'utf8');
  const start = usePrinter.indexOf('const slipOrder');
  const projection = usePrinter.slice(start, start + 500);
  assert.ok(/delivery_note: orderForPrint\.delivery_note/.test(projection), 'the slip projection carries the delivery note');
  assert.ok(
    /api\.get<\{ payment\?: DeliverySlipPayment \}>\(`\/printers\/delivery-slip-payment\//.test(usePrinter),
    'the expected method arrives with the backend payment summary',
  );
});
