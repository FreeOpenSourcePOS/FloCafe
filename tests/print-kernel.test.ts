/**
 * Shared print kernel unit tests (#441, epic #438).
 *
 * Covers the pure kernel in shared/print/:
 *   1. Policy resolution — inherit/fixed primaries, ordered output, dedupe,
 *      max-2 receipts, single-primary KOT.
 *   2. Policy validation — unknown keys, invalid modes, unregistered
 *      languages (injected registry facts), duplicate additional entries.
 *   3. Direction semantics — per-scope spec and LTR-island classification
 *      (IDs, phones, URLs, SKUs, tax IDs, invoice numbers, amounts).
 *   4. Bilingual fit strategies at 32/36/42/48 columns.
 *
 * Run: npm run test:print-kernel
 */

import assert from 'node:assert/strict';

import {
  MAX_RECEIPT_LANGUAGES,
  bilingualLabelLines,
  defaultPrintLanguagePolicy,
  isLtrIsland,
  labelWidth,
  parseKotLanguagePolicy,
  parsePrintLanguagePolicy,
  resolveDirectionSpec,
  resolveKotLanguage,
  resolvePrimaryLanguage,
  resolveReceiptLanguages,
  resolveScopeDirection,
  resolveValueDirection,
  selectBilingualFit,
  buildZReportDocument,
  displayCellWidth,
  fitThermalLine,
  layoutStyledUnit,
  wrapToDisplayCells,
  type ThermalLayoutContext,
} from '../shared/print';
import type { LanguageRegistryFacts } from '../shared/print';

// Test registry: mirrors what a call site injects from the central registry.
const SELECTABLE = new Set(['en', 'es', 'fr', 'pt', 'fa']);
const FACTS: LanguageRegistryFacts = {
  isSelectableLanguage: (code) => SELECTABLE.has(code),
};

// ── Policy resolution ──────────────────────────────────────────────────────

function inherit(): { mode: 'inherit' } {
  return { mode: 'inherit' };
}

console.log('Testing policy resolution...');

assert.deepEqual(
  resolveReceiptLanguages({ primary: inherit(), additional: [] }, 'en'),
  ['en'],
  'inherit with no additional resolves to the store language alone',
);
assert.deepEqual(
  resolveReceiptLanguages({ primary: { mode: 'fixed', language: 'fa' }, additional: [] }, 'en'),
  ['fa'],
  'fixed primary overrides the store language',
);
assert.deepEqual(
  resolveReceiptLanguages({ primary: inherit(), additional: ['fa'] as const }, 'en'),
  ['en', 'fa'],
  'additional language follows the resolved primary',
);
assert.deepEqual(
  resolveReceiptLanguages({ primary: { mode: 'fixed', language: 'fa' }, additional: ['fa'] as const }, 'en'),
  ['fa'],
  'additional equal to the fixed primary collapses (dedupe)',
);
assert.deepEqual(
  resolveReceiptLanguages({ primary: inherit(), additional: ['es'] as const }, 'es'),
  ['es'],
  'additional equal to the inherited store language collapses',
);
assert.ok(
  resolveReceiptLanguages({ primary: inherit(), additional: [] }, 'en').length <= MAX_RECEIPT_LANGUAGES,
);

assert.equal(resolveKotLanguage({ primary: inherit(), additional: [] }, 'fa'), 'fa');
assert.equal(resolveKotLanguage({ primary: { mode: 'fixed', language: 'en' }, additional: [] }, 'fa'), 'en');
assert.equal(resolvePrimaryLanguage({ mode: 'inherit' }, 'pt'), 'pt');

// Type-level max-2 for v1: these shapes must compile; the runtime parser also
// enforces ≤1 additional entry (see validation tests below).

console.log('✓ policy resolution');

// ── Policy validation ──────────────────────────────────────────────────────

console.log('Testing policy validation...');

const valid = parsePrintLanguagePolicy(
  { primary: { mode: 'inherit' }, additional: [] },
  FACTS,
);
assert.ok(valid.ok);
assert.deepEqual(valid.policy, { primary: { mode: 'inherit' }, additional: [] });

const fixedWithAdditional = parsePrintLanguagePolicy(
  { primary: { mode: 'fixed', language: 'fa' }, additional: ['es'] },
  FACTS,
);
assert.ok(fixedWithAdditional.ok);
if (fixedWithAdditional.ok) {
  assert.deepEqual(resolveReceiptLanguages(fixedWithAdditional.policy, 'en'), ['fa', 'es']);
}

const badCases: Array<[unknown, RegExp]> = [
  [null, /JSON object/],
  ['inherit', /JSON object/],
  [{}, /primary is required/],
  [{ primary: { mode: 'auto' } }, /mode must be "inherit" or "fixed"/],
  [{ primary: { mode: 'fixed' } }, /non-empty string/],
  [{ primary: { mode: 'fixed', language: '' } }, /non-empty string/],
  [{ primary: { mode: 'fixed', language: 'de' } }, /not a registered selectable language/],
  [
    { primary: { mode: 'inherit' }, additional: ['de'] },
    /not a registered selectable language/,
  ],
  [
    { primary: { mode: 'inherit' }, additional: ['fa', 'es'] },
    /at most 1 entry/,
  ],
  [
    { primary: { mode: 'inherit' }, additional: ['fa', 'fa'] },
    /at most 1 entry/,
  ],
  [
    { primary: { mode: 'fixed', language: 'fa' }, additional: ['fa'] },
    /duplicates the fixed primary/,
  ],
  [{ primary: { mode: 'inherit' }, extra: true }, /unknown policy key "extra"/],
  [{ primary: { mode: 'inherit' }, additional: null }, /additional must be an array/],
];
for (const [payload, pattern] of badCases) {
  const result = parsePrintLanguagePolicy(payload, FACTS);
  assert.ok(!result.ok, `expected rejection of ${JSON.stringify(payload)}`);
  if (!result.ok) assert.match(result.error, pattern);
}

// KOT policies are single-primary: any additional entry is rejected.
const kotValid = parseKotLanguagePolicy({ primary: { mode: 'fixed', language: 'fa' }, additional: [] }, FACTS);
assert.ok(kotValid.ok);
const kotBad = parseKotLanguagePolicy({ primary: inherit(), additional: ['es'] }, FACTS);
assert.ok(!kotBad.ok);
assert.match(kotBad.ok ? '' : kotBad.error, /at most 0 entries/);

// Defaults preserve current behavior: inherit / none.
assert.deepEqual(defaultPrintLanguagePolicy(), { primary: { mode: 'inherit' }, additional: [] });
assert.deepEqual(
  resolveReceiptLanguages(defaultPrintLanguagePolicy(), 'en'),
  ['en'],
);

console.log('✓ policy validation');

// ── Direction semantics ────────────────────────────────────────────────────

console.log('Testing direction semantics...');

const rtlSpec = resolveDirectionSpec('rtl');
assert.equal(rtlSpec.document, 'rtl');
assert.equal(rtlSpec.block, 'rtl');
assert.equal(rtlSpec.value, 'rtl');
assert.equal(resolveDirectionSpec('ltr').document, 'ltr');

assert.equal(resolveValueDirection('چای زعفرانی', 'rtl'), 'rtl', 'natural RTL text keeps base direction');
assert.equal(resolveValueDirection('+91 98765 43210', 'rtl'), 'ltr', 'phone numbers are LTR islands');
assert.equal(resolveScopeDirection('value', 'rtl', 'ORD-2026-001'), 'ltr');
assert.equal(resolveScopeDirection('document', 'rtl'), 'rtl');

// LTR-island classifier: confident yes-cases.
for (const island of [
  '+1 (555) 010-2030',
  'https://example.com/receipt/123',
  'www.example.com',
  'billing@example.com',
  'ORD-PARITY-001',
  'SKU 0042',
  'GSTIN22AAAAA0000A1Z5',
  '$1,234.56',
  '₹ 5,00,000',
  '1234.56',
  '18%',
]) {
  assert.ok(isLtrIsland(island), `expected LTR island: ${island}`);
}

// Confident no-cases: natural language (any script), empty, long mixed text.
for (const notIsland of [
  '',
  '   ',
  'Espresso Doppio',
  'چای زعفرانی مخصوص',
  'Factura # para el cliente',
  'Table 4 order for Maria Gonzalez and friends',
]) {
  assert.equal(isLtrIsland(notIsland), false, `expected NOT an LTR island: "${notIsland}"`);
}
// RTL script anywhere → never an island, even with digits present.
assert.equal(isLtrIsland('فاکتور ۱۲۳'), false);

console.log('✓ direction semantics');

// ── Bilingual fit strategies ───────────────────────────────────────────────

console.log('Testing bilingual fit strategies at 32/36/42/48 columns...');

const COLUMNS = [32, 36, 42, 48] as const;

// Single-language labels are trivially inline at every width.
for (const columns of COLUMNS) {
  assert.equal(selectBilingualFit({ primary: 'Total' }, columns), 'inline');
}

// Short pair fits inline even at the narrowest width ("Total" + "مجموع").
assert.equal(selectBilingualFit({ primary: 'Total', secondary: 'مجموع' }, 32), 'inline');
assert.deepEqual(bilingualLabelLines({ primary: 'Total', secondary: 'مجموع' }, 'inline'), ['Total  مجموع']);

// Long pairs stack at every realistic width...
const longPair = { primary: 'Subtotal before taxes', secondary: 'جمع کل اقلام پیش از احتساب مالیات' };
assert.ok(
  labelWidth(longPair.primary) + 2 + labelWidth(longPair.secondary) > 48,
  'fixture must exceed the widest tested width',
);
for (const columns of COLUMNS) {
  assert.equal(selectBilingualFit(longPair, columns), 'stacked');
}
assert.deepEqual(bilingualLabelLines(longPair, 'stacked'), [longPair.primary, longPair.secondary]);

// Boundary math: inline exactly when primary+separator+secondary ≤ columns.
const primary = 'Amount';
const secondary = 'مقدار';
const needed = labelWidth(primary) + 2 + labelWidth(secondary);
assert.equal(needed, 13);
assert.equal(selectBilingualFit({ primary, secondary }, needed), 'inline');
assert.equal(selectBilingualFit({ primary, secondary }, needed - 1), 'stacked');

// Degenerate column counts force stacked; missing secondary stays inline.
assert.equal(selectBilingualFit({ primary: 'A', secondary: 'B' }, 0), 'stacked');
assert.equal(selectBilingualFit({ primary: 'A', secondary: 'B' }, -5), 'stacked');
assert.equal(selectBilingualFit({ primary: 'A' }, Number.NaN), 'inline');

console.log('✓ bilingual fit strategies');

console.log('Testing semantic thermal overflow and Z-report contracts...');
const layoutContext = (columns: number): ThermalLayoutContext => ({
  logicalColumns: columns,
  direction: 'ltr',
  languages: ['en'],
});
for (const columns of [32, 42, 48]) {
  const banner = layoutStyledUnit({
    text: '** receipt.reprint[en] **',
    widthMultiplier: 2,
    field: 'reprint banner',
  }, layoutContext(columns));
  assert.equal(banner.lines.join(''), '** receipt.reprint[en] **', `complete banner survives ${columns} columns`);
  assert.equal(banner.widthMultiplier, 1, `banner downgrades style at ${columns} columns`);
}
const financial = layoutStyledUnit({
  text: 'Credit Card (Mastercard) 1234567890',
  field: 'payment row',
  financial: true,
}, layoutContext(32));
assert.ok(financial.lines.every((line) => displayCellWidth(line) <= 32), 'financial text fits within 32 columns');
assert.equal(financial.lines.join(' '), 'Credit Card (Mastercard) 1234567890', 'financial text wraps without truncation');

const bidiControlled = `\u200f${'A'.repeat(32)}`;
assert.equal(displayCellWidth(bidiControlled), 32, 'RTL formatting controls consume no display cells');
assert.equal(fitThermalLine(bidiControlled, 32), bidiControlled, 'final fitting preserves 32 visible cells plus an RTL control');
const fullWidthText = '商品商品';
assert.equal(displayCellWidth(fullWidthText), 8, 'full-width glyphs consume two display cells');
assert.equal(fitThermalLine(fullWidthText, 6), '商品商', 'final fitting truncates full-width glyphs by display cells');
const fullWidthLayout = layoutStyledUnit({ text: fullWidthText, field: 'full-width text' }, layoutContext(6));
assert.ok(fullWidthLayout.lines.every((line) => displayCellWidth(line) <= 6), 'semantic layout uses the same display-cell budget');
assert.equal(fullWidthLayout.lines.join(''), fullWidthText, 'semantic layout wraps full-width glyphs without loss');
const fullWidthHeader = wrapToDisplayCells('商品商品商品商品商品商品商品商品商', 32);
assert.ok(fullWidthHeader.every((line) => displayCellWidth(line) <= 32), 'full-width header wrapping respects thermal display cells');
assert.equal(fullWidthHeader.join(''), '商品商品商品商品商品商品商品商品商', 'full-width header wrapping preserves text');

const zDocument = buildZReportDocument({
  zNumber: 7,
  businessDate: '2026-09-07',
  periodStart: '07/09/2026 09:00',
  periodEnd: '07/09/2026 23:00',
  openingFloatCents: 1000,
  paymentMethods: [{ method: 'cash', count: 2, totalCents: 5000 }],
  refundCount: 1,
  refundedCents: 500,
  taxComponents: [{ title: 'GST', amount: 10 }],
  staffSales: [{ name: 'Amina', orderCount: 2, revenueCents: 5000 }],
  expectedCashCents: 5500,
  countedCashCents: 5400,
  varianceCents: -100,
  closedByName: 'Amina',
  businessName: 'Cafe',
  businessAddress: '',
  taxRegistrationNumber: '',
  isReprint: true,
}, {
  languages: ['fa', 'en'],
  baseDirection: 'rtl',
  resolveLabel: (concept, language) => `${concept}[${language}]`,
});
assert.equal(zDocument.version, 1);
assert.equal(zDocument.header.reprintMarker?.conceptId, 'receipt.reprint');
assert.equal(zDocument.payments.rows[0].label.conceptId, 'pos.methodCash');
assert.equal(zDocument.payments.rows[0].countLabel.conceptId, 'print.zReport.paymentCount');
assert.equal(zDocument.cash.variance.cents, -100, 'Z financial truth passes through the semantic document');
for (const [row, property, replacement] of [
  [zDocument.period[0], 'value', null],
  [zDocument.payments.rows[0], 'totalCents', 999],
  [zDocument.tax.rows[0], 'amount', 999],
  [zDocument.staff.rows[0], 'totalCents', 999],
] as const) {
  const before = (row as Record<string, unknown>)[property];
  assert.throws(() => {
    (row as Record<string, unknown>)[property] = replacement;
  }, TypeError, `frozen Z-report ${property} rejects mutation`);
  assert.equal((row as Record<string, unknown>)[property], before, `frozen Z-report ${property} remains unchanged`);
}

console.log('✓ semantic thermal overflow and Z-report contracts');

console.log('\nAll print kernel tests passed.');
