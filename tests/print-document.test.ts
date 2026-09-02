/**
 * PrintDocument v1 unit tests (#442, epic #438).
 *
 * Covers:
 *   1. Block construction from a fixture bill (kernel-level, stub resolver).
 *   2. Bilingual label resolution into TotalsBlock (semantic pairs, never
 *      pre-concatenated "A / B" strings).
 *   3. Direction annotations: RTL base for fa primary, LTR islands for
 *      invoice numbers / phones, RTL for Persian item names.
 *   4. Builder purity: printed truth passes through untouched (no
 *      financial recomputation) and no IO imports in the kernel modules.
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/print-document.test.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildBillDocument,
  bilingualLabel,
  directionalText,
  getBlock,
  type PrintContext,
  type PrintData,
} from '../shared/print';
import {
  buildBillPrintContext,
  buildBillPrintData,
  detectPrintLanguageDirection,
  renderBillDocumentToClassicLines,
} from '../main/printers/document-classic';
import { renderBillDocumentToCompactLines } from '../main/printers/document-compact';
import { buildParityFixtures } from './print-parity.test';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERSIAN_ITEM = 'چای زعفرانی مخصوص';

function stubResolver(conceptId: string, language: string): string {
  return `${conceptId}[${language}]`;
}

function makeContext(overrides: Partial<PrintContext> = {}): PrintContext {
  return {
    columns: 42,
    languages: ['en'],
    baseDirection: 'ltr',
    locale: 'en-IN',
    currencySymbol: '₹',
    trimDecimals: false,
    resolveLabel: stubResolver,
    ...overrides,
  };
}

function makePrintData(overrides: {
  bill?: Partial<PrintData['bill']>;
  business?: Partial<PrintData['business']>;
  isReprint?: boolean;
} = {}): PrintData {
  const { order, bill, business } = buildParityFixtures();
  const base = buildBillPrintData(order, bill, business, overrides.isReprint ?? false);
  return {
    ...base,
    bill: { ...base.bill, ...overrides.bill },
    business: { ...base.business, ...overrides.business },
  };
}

function blockOf(document: ReturnType<typeof buildBillDocument>, kind: Parameters<typeof getBlock>[1]) {
  const block = getBlock(document, kind);
  assert(block, `document carries a ${kind} block`);
  return block;
}

let passed = 0;
function ok(message: string): void {
  passed++;
  console.log(`  ✓ ${message}`);
}

// ---------------------------------------------------------------------------
// 1. Block construction from the fixture bill
// ---------------------------------------------------------------------------

console.log('\n▶ Block construction (fixture bill)');
{
  const document = buildBillDocument(makePrintData(), makeContext());

  assert.equal(document.version, 1, 'document version is 1');
  assert.deepEqual(
    document.blocks.map((block) => block.kind),
    ['business-header', 'customer', 'document-meta', 'item-table', 'totals', 'tax-breakdown', 'payments', 'message'],
    'canonical block order',
  );
  ok('canonical ordered blocks');

  const header = blockOf(document, 'business-header');
  assert.equal(header.name?.text, 'Flo Parity Cafe');
  assert.equal(header.address?.text, '12 Marina Boulevard');
  assert.equal(header.taxId?.value.text, 'GSTIN123456');
  assert.equal(header.taxId?.label.primary, 'GSTIN', 'tax id label comes from the country profile');
  ok('business header block carries identity + tax id');

  const meta = blockOf(document, 'document-meta');
  assert.equal(meta.invoiceNumber.text, 'INV-PARITY-001');
  assert.equal(meta.invoiceNumberLabel.conceptId, 'print.invoiceNumber');
  assert.equal(meta.timestamp.text, '2026-08-21 18:42:00');
  assert.equal(meta.table?.name.text, '4');
  assert.equal(meta.table?.label.conceptId, 'pos.tableLabel');
  assert.equal(meta.title.conceptId, 'print.invoiceTitle', 'zero-tax bill resolves the plain invoice title');
  ok('document meta block carries invoice identity');

  const taxed = buildBillDocument(
    makePrintData({ bill: { taxAmount: 90 } }),
    makeContext(),
  );
  assert.equal(blockOf(taxed, 'document-meta').title.conceptId, 'print.taxInvoiceTitle', 'tax-applicable bill resolves the tax invoice title');

  const items = blockOf(document, 'item-table');
  assert.equal(items.rows.length, 3);
  assert.equal(items.rows[0].name.text, 'Espresso Doppio');
  assert.equal(items.rows[0].quantity, 2);
  assert.equal(items.rows[0].amount, 500);
  assert.deepEqual(items.rows[0].addons.map((addon) => addon.name.text), ['Oat milk']);
  assert.equal(items.rows[0].specialInstructions?.text, 'Less sugar');
  assert.equal(items.rows[1].name.text, PERSIAN_ITEM);
  assert.equal(items.rows[2].addons[0].price, 0, 'unpriced addon keeps price 0');
  assert.equal(items.header.item.conceptId, 'receipt.item');
  ok('item table block carries rows, addons, and special instructions');

  const totals = blockOf(document, 'totals');
  assert.equal(totals.subtotal.amount, 1220);
  assert.equal(totals.discount?.amount, 120);
  assert.equal(totals.serviceCharge, null, 'backend fixture does not invent a service-charge bill field');
  assert.equal(totals.deliveryCharge?.amount, 8);
  assert.equal(totals.packagingCharge?.amount, 9);
  assert.equal(totals.grandTotal.amount, 1117);
  assert.equal(totals.tax, null, 'no flat tax line when tax amount is zero');
  assert.equal(blockOf(document, 'tax-breakdown').lines.length, 0, 'no breakdown lines when merchant hides them');
  const payments = blockOf(document, 'payments');
  assert.deepEqual(payments.lines.map((line) => line.method), ['cash', 'card']);
  assert.equal(payments.lines[0].label.conceptId, 'pos.methodCash');
  ok('totals/payments blocks copy printed truth verbatim');

  const serviceDocument = buildBillDocument(
    makePrintData({ bill: { serviceCharge: 12, total: 1129 } }),
    makeContext(),
  );
  const serviceTotals = blockOf(serviceDocument, 'totals');
  assert.equal(serviceTotals.serviceCharge?.amount, 12, 'server-persisted service charge is rendered once');
  assert.equal(serviceTotals.grandTotal.amount, 1129, 'receipt uses the authoritative total alongside service charge');
  ok('service charge is present on the shared receipt surface when persisted');

  const { order, bill, business } = buildParityFixtures();
  const serviceData = buildBillPrintData(order, { ...bill, service_charge: 12, total: 1129 }, business, false);
  assert.equal(serviceData.bill.serviceCharge, 12, 'persisted service charge crosses the backend normalization boundary');
  const serviceContext = buildBillPrintContext({ columns: 42, language: 'en', business });
  const persistedServiceDocument = buildBillDocument(serviceData, serviceContext);
  const serviceOptions = {
    columns: 42,
    language: 'en',
    locale: serviceContext.locale,
    currencySymbol: '₹',
    trimDecimals: false,
    useUnicode: true,
    arabicShaping: false,
    cutMode: 'full' as const,
  };
  for (const [renderer, lines] of [
    ['classic', renderBillDocumentToClassicLines(persistedServiceDocument, serviceOptions)],
    ['compact', renderBillDocumentToCompactLines(persistedServiceDocument, serviceOptions)],
  ] as const) {
    assert(lines.some((line) => line.includes('Service Charge') && line.includes('₹12.00')),
      `${renderer} renders the persisted service charge`);
  }

  assert.equal(blockOf(document, 'message').reprintBanner, null, 'no reprint banner on first print');
}

console.log('\n▶ Show-flag and tax-presence decisions');
{
  const hidden = buildBillDocument(
    makePrintData({ business: { showName: false, showAddress: false, showTaxId: 'never' } }),
    makeContext(),
  );
  const hiddenHeader = blockOf(hidden, 'business-header');
  assert.equal(hiddenHeader.name, null);
  assert.equal(hiddenHeader.address, null);
  assert.equal(hiddenHeader.taxId, null, 'showTaxId never suppresses the tax id line');
  ok('merchant show-flags applied by the builder');

  const forced = buildBillDocument(
    makePrintData({ bill: { taxAmount: 0, taxComponents: [] }, business: { showTaxId: 'force' } }),
    makeContext(),
  );
  assert(blockOf(forced, 'business-header').taxId, 'showTaxId force keeps the line even without tax');

  const breakdown = buildBillDocument(
    makePrintData({
      bill: {
        taxAmount: 90,
        taxComponents: [
          { title: 'GST', rate: 5, amount: 61 },
          { title: 'VAT', rate: 2.5, amount: 29 },
          { title: 'Zero', rate: 0, amount: 0 },
        ],
      },
      business: { showTaxBreakdown: true },
    }),
    makeContext(),
  );
  const breakdownBlock = blockOf(breakdown, 'tax-breakdown');
  assert.deepEqual(breakdownBlock.lines.map((line) => line.label.primary), ['GST', 'VAT'], 'zero-amount components filtered');
  assert.equal(blockOf(breakdown, 'totals').tax, null, 'flat tax line suppressed when breakdown shown');

  const chargedBreakdown = buildBillDocument(
    makePrintData({
      bill: {
        taxAmount: 90,
        taxComponents: [{ title: 'GST', rate: 5, amount: 90 }],
        deliveryCharge: 8,
        packagingCharge: 9,
      },
      business: { showTaxBreakdown: true },
    }),
    makeContext(),
  );
  const chargedOptions = {
    columns: 48,
    language: 'en',
    locale: 'en-IN',
    currencySymbol: '₹',
    trimDecimals: false,
    useUnicode: true,
    arabicShaping: false,
    cutMode: 'full' as const,
  };
  for (const [renderer, lines] of [
    ['classic', renderBillDocumentToClassicLines(chargedBreakdown, chargedOptions)],
    ['compact', renderBillDocumentToCompactLines(chargedBreakdown, chargedOptions)],
  ] as const) {
    const taxIndex = lines.findIndex((line) => line.includes('GST'));
    const deliveryIndex = lines.findIndex((line) => line.includes('pos.delivery[en]'));
    const packagingIndex = lines.findIndex((line) => line.includes('pos.packaging[en]'));
    const totalIndex = lines.findIndex((line) => line.includes('print.grandTotal[en]'));
    assert(taxIndex >= 0 && taxIndex < deliveryIndex && deliveryIndex < packagingIndex && packagingIndex < totalIndex,
      `${renderer} places tax breakdown before charges and grand total`);
  }
  ok('tax breakdown vs flat tax line decision');

  const noBreakdown = buildBillDocument(
    makePrintData({
      bill: { taxAmount: 90, taxComponents: [{ title: 'GST', rate: 5, amount: 90 }] },
      business: { showTaxBreakdown: false },
    }),
    makeContext(),
  );
  assert.equal(blockOf(noBreakdown, 'totals').tax?.amount, 90, 'flat tax line present when breakdown hidden');
}

console.log('\n▶ Printed truth is never recomputed');
{
  const odd = buildBillDocument(
    makePrintData({ bill: { subtotal: 1220.456, total: 999999.99 } }),
    makeContext(),
  );
  const totals = blockOf(odd, 'totals');
  assert.equal(totals.subtotal.amount, 1220.456);
  assert.equal(totals.grandTotal.amount, 999999.99);
  assert.equal(blockOf(odd, 'payments').lines[1].amount, 517);
  ok('amounts pass through verbatim');
}

// ---------------------------------------------------------------------------
// 2. Bilingual labels (semantic pairs, never concatenated)
// ---------------------------------------------------------------------------

console.log('\n▶ Bilingual label resolution into TotalsBlock');
{
  const document = buildBillDocument(makePrintData(), makeContext({
    languages: ['en', 'fa'],
  }));
  const totals = blockOf(document, 'totals');
  assert.equal(totals.subtotal.label.primary, 'pos.subtotal[en]');
  assert.equal(totals.subtotal.label.secondary, 'pos.subtotal[fa]');
  assert.equal(totals.grandTotal.label.primary, 'print.grandTotal[en]');
  assert.equal(totals.grandTotal.label.secondary, 'print.grandTotal[fa]');
  ok('totals labels carry concept + primary + secondary variants');

  const renderedLabels: Array<{ primary: string; secondary?: string }> = [];
  const totalsRecord: Record<string, unknown> = totals;
  for (const value of Object.values(totalsRecord)) {
    if (value && typeof value === 'object' && 'label' in value) {
      renderedLabels.push((value as { label: { primary: string; secondary?: string } }).label);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object' && 'label' in entry) {
          renderedLabels.push((entry as { label: { primary: string; secondary?: string } }).label);
        }
      }
    }
  }
  assert(renderedLabels.length >= 2, 'collected totals labels');
  for (const label of renderedLabels) {
    assert(!label.primary.includes(' / '), 'no pre-concatenated "A / B" strings in primary');
  }
  ok('no pre-concatenated bilingual strings anywhere in totals');

  const single = buildBillDocument(makePrintData(), makeContext({ languages: ['en'] }));
  const singleTotals = blockOf(single, 'totals');
  assert.equal(singleTotals.subtotal.label.secondary, undefined, 'single-language documents carry no secondary');
  ok('secondary absent for single-language documents');

  const explicit = bilingualLabel({ primary: 'Total', secondary: 'مجموع' }, 'print.grandTotal');
  assert.deepEqual(
    { primary: explicit.primary, secondary: explicit.secondary, conceptId: explicit.conceptId },
    { primary: 'Total', secondary: 'مجموع', conceptId: 'print.grandTotal' },
  );
  ok('explicit BilingualLabel pairs are carried semantically');
}

// ---------------------------------------------------------------------------
// 3. Direction annotations
// ---------------------------------------------------------------------------

console.log('\n▶ Direction annotations (fa primary → RTL base, LTR islands)');
{
  const document = buildBillDocument(
    makePrintData({ business: { customerName: 'Asha Kumar', customerPhone: '+91 98765 43210' } }),
    makeContext({
      languages: ['fa'],
      baseDirection: 'rtl',
    }),
  );

  assert.equal(document.direction.base, 'rtl');
  assert.equal(document.direction.document, 'rtl');
  for (const block of document.blocks) {
    assert.equal((block as { direction: string }).direction, 'rtl', `${block.kind} carries rtl direction`);
  }
  ok('every block carries the rtl base direction');

  const meta = blockOf(document, 'document-meta');
  assert.equal(meta.invoiceNumber.direction, 'ltr', 'invoice number is an LTR island');
  assert.equal(meta.timestamp.direction, 'ltr', 'stored timestamp is an LTR island');
  const customer = blockOf(document, 'customer');
  assert.equal(customer.phone?.direction, 'ltr', 'customer phone is an LTR island');
  ok('LTR islands annotated for invoice number, timestamp, phone');

  const items = blockOf(document, 'item-table');
  assert.equal(items.rows[1].name.direction, 'rtl', 'Persian item name follows base direction');
  assert.equal(items.rows[0].name.direction, 'rtl', 'digitless latin item name follows base direction');
  ok('item names annotated per direction kernel');

  const ltrDoc = buildBillDocument(makePrintData(), makeContext({ languages: ['en'], baseDirection: 'ltr' }));
  assert.equal(blockOf(ltrDoc, 'document-meta').invoiceNumber.direction, 'ltr');
  ok('ltr base keeps values ltr');

  assert.deepEqual(directionalText('ORD-2026-001', 'rtl'), { text: 'ORD-2026-001', direction: 'ltr' });
  ok('directionalText helper annotates islands');
}

// ---------------------------------------------------------------------------
// 4. Backend normalization & direction facts
// ---------------------------------------------------------------------------

console.log('\n▶ Backend PrintData normalization (main layer)');
{
  const { order, bill, business } = buildParityFixtures();
  const rawBill = { ...bill, payment_details: JSON.stringify(bill.payment_details) };
  const printData = buildBillPrintData(order, rawBill, business, false);
  assert.deepEqual(printData.bill.payments, [{ method: 'cash', amount: 600 }, { method: 'card', amount: 517 }]);
  assert.equal(printData.bill.pointsEarned, 0);
  assert.equal(printData.business.showTaxId, 'force', 'fixture show_tax_id true maps to force');
  const unsetFlags = buildBillPrintData(order, rawBill, { ...business, show_tax_id: undefined }, false);
  assert.equal(unsetFlags.business.showTaxId, 'auto', 'unset show_tax_id maps to auto');
  ok('payment_details JSON string parsed; flags mapped');

  assert.equal(detectPrintLanguageDirection('en'), 'ltr');
  assert.equal(detectPrintLanguageDirection('fa'), 'rtl', 'fa labels carry RTL script');
  assert.equal(detectPrintLanguageDirection('unknown-lang'), 'ltr', 'unregistered languages default ltr');
  ok('registry-derived language directions');

  const context = buildBillPrintContext({ columns: 48, language: 'en', business });
  assert.equal(context.columns, 48);
  assert.deepEqual(context.languages, ['en']);
  assert.equal(context.locale, 'en-IN');
  assert.equal(context.currencySymbol, '₹');
  assert.equal(context.trimDecimals, false);
  assert.equal(context.baseDirection, 'ltr');
  ok('print context derived from business snapshot');
}

console.log('\n▶ Add-on quantity and charge financial parity');
{
  const cases = [
    { itemQuantity: 1, addonQuantity: 1, addonPrice: 5, expected: 5 },
    { itemQuantity: 2, addonQuantity: 3, addonPrice: 5, expected: 30 },
    { itemQuantity: 3, addonQuantity: 2, addonPrice: 7.5, expected: 45 },
  ];

  for (const testCase of cases) {
    const order = {
      order_number: 'ORD-ADDON-PARITY',
      created_at: '2026-08-21 18:42:00',
      items: [{
        product_name: 'Tea',
        quantity: testCase.itemQuantity,
        unit_price: 10,
        total: 20,
        addons: [
          { name: 'Extra shot', price: testCase.addonPrice, quantity: testCase.addonQuantity },
          { name: 'Vanilla syrup', price: 2, quantity: 2 },
        ],
      }],
    };
    const bill = {
      bill_number: 'INV-ADDON-PARITY',
      subtotal: 50,
      discount_amount: 0,
      tax_amount: 0,
      delivery_charge: 8,
      packaging_charge: 9,
      total: 67,
    };
    const business = { country: 'IN', currency_symbol: '₹' };
    const printData = buildBillPrintData(order, bill, business, false);
    assert.equal(printData.order.items[0].quantity, testCase.itemQuantity);
    assert.equal(printData.order.items[0].addons[0].quantity, testCase.addonQuantity);
    assert.equal(printData.order.items[0].addons[0].price, testCase.expected,
      `addon extension ${testCase.itemQuantity}x item × ${testCase.addonQuantity}x addon`);
    assert.equal(printData.order.items[0].addons[1].price, testCase.itemQuantity * 2 * 2,
      'multiple add-ons retain independent extensions');
    assert.equal(printData.bill.serviceCharge, undefined, 'backend normalization does not invent service-charge storage');
    assert.equal(printData.bill.deliveryCharge, 8);
    assert.equal(printData.bill.packagingCharge, 9);

    const context = buildBillPrintContext({ columns: 48, language: 'en', business });
    const document = buildBillDocument(printData, context);
    const options = {
      columns: 48,
      language: 'en',
      locale: context.locale,
      currencySymbol: '₹',
      trimDecimals: false,
      useUnicode: true,
      arabicShaping: false,
      cutMode: 'full' as const,
    };
    for (const [renderer, lines] of [
      ['classic', renderBillDocumentToClassicLines(document, options)],
      ['compact', renderBillDocumentToCompactLines(document, options)],
    ] as const) {
      assert(lines.some((line) => line.includes('Extra shot') && line.includes(`₹${testCase.expected.toFixed(2)}`)),
        `${renderer} renders extended add-on amount`);
      assert(lines.some((line) => line.includes('Delivery') && line.includes('₹8.00')),
        `${renderer} renders delivery charge`);
      assert(lines.some((line) => line.includes('Packaging') && line.includes('₹9.00')),
        `${renderer} renders packaging charge`);
    }
  }

  const malformedOrder = {
    order_number: 'ORD-ADDON-MALFORMED',
    created_at: '2026-08-21 18:42:00',
    items: [{
      product_name: 'Tea',
      quantity: 2,
      unit_price: 10,
      total: 20,
      addons: [null, 'legacy-addon', { name: 'Safe extra', price: 4, quantity: 2 }],
    }],
  };
  const malformedData = buildBillPrintData(malformedOrder, {
    bill_number: 'INV-ADDON-MALFORMED',
    subtotal: 20,
    discount_amount: 0,
    tax_amount: 0,
    total: 20,
  }, { country: 'IN', currency_symbol: '₹' }, false);
  assert.equal(malformedData.order.items[0].addons[0].price, 0);
  assert.equal(malformedData.order.items[0].addons[1].price, 0);
  assert.equal(malformedData.order.items[0].addons[2].price, 16,
    'object add-on quantity still uses the extended amount after malformed entries');
  ok('malformed add-on entries do not break normalization');
}

// ---------------------------------------------------------------------------
// 5. KOT document variant (#443)
// ---------------------------------------------------------------------------

import {
  buildKotDocument,
  type KotPrintData,
} from '../shared/print';

console.log('\n▶ KOT document builder (#443)');
{
  const kotData: KotPrintData = {
    stationName: 'Main Kitchen',
    order: {
      orderNumber: 'ORD-PARITY-001',
      createdAt: '2026-08-21 18:42:00',
      tableName: '4',
      orderType: 'DINE IN',
    },
    items: [
      {
        productName: 'Espresso Doppio',
        quantity: 2,
        addons: [{ name: 'Oat milk' }, { name: '' }],
        specialInstructions: 'Less sugar',
      },
      {
        productName: PERSIAN_ITEM,
        quantity: 1,
        addons: [],
        specialInstructions: '',
      },
    ],
  };

  const document = buildKotDocument(kotData, makeContext({ languages: ['en'], baseDirection: 'ltr' }));
  assert.equal(document.version, 1, 'KOT document version is 1');
  assert.deepEqual(
    document.blocks.map((block) => block.kind),
    ['kot-header', 'kot-items'],
    'KOT canonical block order',
  );

  const header = getBlock(document as any, 'kot-header' as any) as ReturnType<typeof document.blocks.find> | undefined;
  assert(header, 'kot-header block present');
  assert.equal(header.banner.conceptId, 'print.kot.banner');
  assert.equal(header.stationName.text, 'Main Kitchen');
  assert.equal(header.orderNumber.text, 'ORD-PARITY-001');
  assert.equal(header.orderNumber.direction, 'ltr', 'order number is an LTR island under rtl base');
  assert.equal(header.table?.label.conceptId, 'pos.tableLabel');
  assert.equal(header.table?.name.text, '4');
  assert.equal(header.orderType?.label.conceptId, 'print.kot.type');
  assert.equal(header.orderType?.value.text, 'DINE IN');
  assert.equal(header.timestamp.text, '2026-08-21 18:42:00');
  ok('KOT header carries banner/station/order/table/type/time semantics');

  const noTable = buildKotDocument(
    { ...kotData, order: { ...kotData.order, tableName: '' } },
    makeContext(),
  );
  assert.equal((getBlock(noTable as any, 'kot-header' as any) as any)?.table, null, 'empty table name omits the table reference');
  ok('table block presence follows snapshot data');

  const items = getBlock(document as any, 'kot-items' as any) as any;
  assert(items, 'kot-items block present');
  assert.equal(items.rows.length, 2);
  assert.equal(items.rows[0].quantity, 2);
  assert.equal(items.rows[0].name.text, 'Espresso Doppio');
  assert.deepEqual(items.rows[0].addons.map((addon) => addon.text), ['Oat milk'], 'blank addon names are dropped');
  assert.equal(items.rows[0].specialInstructions?.text, 'Less sugar');
  assert.equal(items.rows[1].specialInstructions, null);
  ok('KOT item rows carry quantity/name/addons/instructions');

  // Direction annotations follow the injected base direction.
  const rtlDoc = buildKotDocument(kotData, makeContext({ languages: ['fa'], baseDirection: 'rtl' }));
  assert.equal(rtlDoc.direction.base, 'rtl');
  const rtlItems = getBlock(rtlDoc as any, 'kot-items' as any) as any;
  assert.equal(rtlItems?.rows[1].name.direction, 'rtl', 'Persian item name follows rtl base');
  assert.equal((getBlock(rtlDoc as any, 'kot-header' as any) as any)?.orderNumber.direction, 'ltr', 'order number stays an LTR island in rtl tickets');
  ok('direction-aware annotations for RTL-primary kitchen tickets');

  // Single-language policy shape (kernel kot_language_policy).
  assert.equal(document.languages.length, 1, 'KOT documents carry exactly one language in v1');
  ok('single-language policy reflected in resolved languages');
}

// ---------------------------------------------------------------------------
// 6. Purity: no IO imports in kernel document modules
// ---------------------------------------------------------------------------

console.log('\n▶ Kernel purity (static import audit)');
{
  const kernelDir = path.resolve(__dirname, '../shared/print');
  const allowedPrefixes = ['./', '../'];
  const forbidden = /\b(node:|require\(|electron|better-sqlite3|express|\.\.\/\.\.\/(main|frontend))/;
  for (const file of ['document.ts', 'direction.ts', 'bilingual.ts', 'types.ts', 'policy.ts']) {
    const source = fs.readFileSync(path.join(kernelDir, file), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const importPath of imports) {
      assert(
        allowedPrefixes.some((prefix) => importPath.startsWith(prefix)) && !forbidden.test(importPath),
        `${file} imports only kernel-relative modules (found "${importPath}")`,
      );
    }
    assert(!/\b(fetch|XMLHttpRequest|localStorage|process\.)/.test(source), `${file} has no IO calls`);
  }
  ok('shared/print/document.ts imports only kernel-relative modules');
}

console.log(`\nPrintDocument unit tests: ${passed} checks passed.`);
