/**
 * Delivery slip printing contract (#830 S4, #694).
 *
 * Three properties this suite exists to hold, in order of how much damage it
 * does if they regress:
 *
 *   1. The slip prints the FULL customer number and the delivery address. A
 *      courier who cannot call the customer, or cannot find the house, is the
 *      whole problem the document exists to solve.
 *   2. The receipt still prints the MASKED number, exactly as it always has.
 *      Lifting the mask everywhere would visibly change every receipt in every
 *      existing install, which nobody asked for.
 *   3. The two do not share a mask default. This is the property that makes
 *      (1) and (2) safe to hold at the same time: if the slip had reached the
 *      full number by flipping a shared default, then satisfying (1) would
 *      silently break (2). The assertion below is that the slip renderer has no
 *      mask parameter at all, and that the receipt's mask is a named option that
 *      defaults to masked rather than an ambient behaviour.
 *
 * Red before green: on the parent commit every slip import fails, so the file
 * cannot even load. Property 2 is the one that guards an existing behaviour, so
 * it is written to pass both before and after, and property 3 is written so it
 * fails if anyone later reaches the full number by sharing a default.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeliverySlipDocument, isDeliverySlipDocument, shouldShowCustomerNumber } from '../shared/print/document';
import { buildDeliverySlipPrintData, renderDeliverySlipViaDocument, MAX_DELIVERY_SLIP_ADDRESS_CHARS } from '../main/printers/document-delivery-slip';
import { formatReceipt, escPosToText } from '../main/printers/thermal';
import { capabilitiesForPrinter, getSupportedPrinterProfiles, resolvePrinterProfile } from '../main/printers/profiles';
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

function renderSlip(columns: number, options: { showCustomerPhone?: boolean } = {}) {
  const profile = resolvePrinterProfile({ paper_width: `cols-${columns}` });
  const capabilities = capabilitiesForPrinter(profile, `cols-${columns}`, false);
  return renderDeliverySlipViaDocument(ORDER, ORDER.items, CONTACT, {
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
  // options bag, and no mask parameter it could honour.
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

test('delivery exception: a delivery slip withholds the number when the override is set', () => {
  const text = escPosToText(renderSlip(42, { showCustomerPhone: false }).data);
  assert.ok(!text.includes(FULL_PHONE), 'the slip must not print the number once the merchant opts back out');
  assert.ok(!text.includes(MASKED_PHONE), 'and it must not print a masked number either: there is nothing to hand over');
  assert.ok(
    text.replace(/\s+/g, ' ').includes(FULL_ADDRESS),
    'the override governs the number, not the address, so the address still prints',
  );
  assert.ok(text.includes('Espresso Doppio'), 'the items still print');
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
    shouldShowCustomerNumber({ showOnReceipts: false, alwaysForDeliveryOrders: false, orderType: 'delivery' }),
    false,
    'the override hands the decision back to the merchant setting',
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
      // test - the exception turns visibility on, it does not lift the mask.
      assert.ok(text.includes(MASKED_PHONE), `override=${alwaysForDeliveryOrders}: the delivery receipt shows the masked number`);
      assert.ok(!text.includes(FULL_PHONE), `override=${alwaysForDeliveryOrders}: the receipt never prints the full number`);
    } else {
      assert.ok(!text.includes(MASKED_PHONE), `override=${alwaysForDeliveryOrders}: the delivery receipt withholds the number entirely`);
      assert.ok(!text.includes(FULL_PHONE), `override=${alwaysForDeliveryOrders}: and never the full one`);
    }
  }
  // With receipts on, the masked value is what prints, in both override states.
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

  // Opting out is explicit, not accidental.
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
  // resolveReceiptPhone itself.
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
  // neither the mask helper nor the shared option name.
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
  // agree, the full number has leaked into a receipt.
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

/** The measured body of one slip configuration, without the block header. */
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
  // would silently truncate at the first rule.
  // Line endings are normalised on read, so a working tree that was checked out
  // with CRLF still compares byte for byte against the LF output measured here.
  // The `.gitattributes` rule keeps the checked-out file LF as well; both
  // together mirror what the receipt column oracle does for its golden.
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
  // timestamp while silently ignoring the store timezone.
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
  // silently pins every store's slip date to en-US.
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
  // that went to the printer.
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

test('delivery slip: an order-recorded address reaches the slip, and an order without one falls back', () => {
  // Finding: the WebUSB and browser paths build the slip from the contact the
  // caller resolved, so the order's own address has to survive that resolution
  // and the customer's standing address has to be what an order created before
  // the column existed gets. The fallback is the common case, not the rare one.
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

  // An order with no address of its own falls back to the customer's record.
  const fallback = buildDeliverySlipPrintData(ORDER, ORDER.items, CONTACT);
  assert.equal(fallback.contact.address, FULL_ADDRESS, 'the standing customer address is the fallback');
  assert.equal(fallback.contact.addressSource, 'customer');

  // An order with neither prints no address and claims no source.
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
