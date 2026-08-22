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
} from '../main/printers/document-classic';
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
    ['business-header', 'document-meta', 'customer', 'item-table', 'tax-breakdown', 'totals', 'payments', 'message'],
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
  assert.equal(totals.grandTotal.amount, 1100);
  assert.equal(totals.tax, null, 'no flat tax line when tax amount is zero');
  assert.equal(blockOf(document, 'tax-breakdown').lines.length, 0, 'no breakdown lines when merchant hides them');
  const payments = blockOf(document, 'payments');
  assert.deepEqual(payments.lines.map((line) => line.method), ['cash', 'card']);
  assert.equal(payments.lines[0].label.conceptId, 'pos.methodCash');
  ok('totals/payments blocks copy printed truth verbatim');

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
  assert.equal(blockOf(odd, 'payments').lines[1].amount, 500);
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
  assert.deepEqual(printData.bill.payments, [{ method: 'cash', amount: 600 }, { method: 'card', amount: 500 }]);
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

// ---------------------------------------------------------------------------
// 5. Purity: no IO imports in kernel document modules
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
