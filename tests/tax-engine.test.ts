import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
  TaxEngine,
  applyPayableRounding,
  resolveTaxCategory,
  type TaxEngineLine,
} from '../main/services/tax-engine';
import {
  allocateDocumentTaxRounding,
  calculateDocumentItemTaxes,
  calculateItemTax,
  computeDiscountTaxRatio,
  previewCategoryRate,
  scaleTaxSnapshots,
} from '../main/services/tax';
import type {
  CountryPack,
  PayableRounding,
  RoundingMethod,
  TaxRounding,
  TaxRule,
} from '../main/tax-packs/types';
import dualRatePackData from './fixtures/synthetic-dual-rate-pack.json';
import flatRatePackData from './fixtures/synthetic-flat-rate-pack.json';

const dualRatePack = dualRatePackData as CountryPack;
const flatRatePack = flatRatePackData as CountryPack;

function packWith(
  rules: TaxRule[],
  taxRounding: Partial<TaxRounding> = {},
  payableRounding: Partial<PayableRounding> = {},
): CountryPack {
  return {
    schemaVersion: 1,
    id: 'test-pack',
    publisher: 'local',
    version: '1',
    country: 'TS',
    jurisdiction: '*',
    currency: 'TST',
    effectiveFrom: '2026-01-01',
    publishedAt: '2026-01-01',
    minFloVersion: '2.4.0',
    taxPoint: 'finalized_at',
    inclusivePricingDefault: false,
    registrationNumberLabel: 'Tax ID',
    categories: [
      { id: 'explicit', label: 'Explicit', ruleIds: rules.map((rule) => rule.id) },
      { id: 'parent', label: 'Parent', ruleIds: rules.map((rule) => rule.id) },
      { id: 'addon-default', label: 'Add-on', ruleIds: rules.map((rule) => rule.id) },
      { id: 'standard', label: 'Standard', ruleIds: rules.map((rule) => rule.id) },
      { id: 'unclassified', label: 'Unclassified', ruleIds: [] },
    ],
    defaultCategories: {
      product: 'standard',
      packaging: 'standard',
      delivery: 'standard',
      service_charge: 'standard',
      addon: 'addon-default',
    },
    unclassifiedCategoryId: 'unclassified',
    rules,
    taxRounding: {
      scope: 'line',
      method: 'half_up',
      decimalPlaces: 2,
      remainderAllocation: 'largest_remainder',
      ...taxRounding,
    },
    payableRounding: {
      increment: '0.01',
      method: 'half_up',
      ...payableRounding,
    },
  };
}

function line(overrides: Partial<TaxEngineLine> = {}): TaxEngineLine {
  return {
    lineId: 'line-1',
    kind: 'product',
    quantity: '1',
    unitPrice: '100',
    productCategoryId: 'explicit',
    ...overrides,
  };
}

function calculate(
  pack: CountryPack,
  lines: TaxEngineLine[],
  context: Partial<Parameters<typeof TaxEngine.calculate>[0]> = {},
) {
  return TaxEngine.calculate({
    pack,
    country: pack.country,
    transactionDate: '2026-07-27',
    lines,
    ...context,
  });
}

test('category resolution follows all six precedence steps', () => {
  const pack = packWith([]);
  const full = line({
    kind: 'addon',
    transactionCategoryId: 'transaction',
    merchantCategoryId: 'merchant',
    productCategoryId: 'explicit',
    inheritParentCategory: true,
    parentProductCategoryId: 'parent',
  });
  assert.deepEqual(resolveTaxCategory(pack, full), {
    categoryId: 'transaction',
    source: 'transaction_override',
  });
  assert.equal(
    resolveTaxCategory(pack, { ...full, transactionCategoryId: undefined }).categoryId,
    'merchant',
  );
  assert.equal(
    resolveTaxCategory(pack, {
      ...full,
      transactionCategoryId: undefined,
      merchantCategoryId: undefined,
    }).categoryId,
    'explicit',
  );
  assert.equal(
    resolveTaxCategory(pack, {
      ...full,
      transactionCategoryId: undefined,
      merchantCategoryId: undefined,
      productCategoryId: undefined,
    }).categoryId,
    'parent',
  );
  assert.deepEqual(
    resolveTaxCategory(pack, {
      ...full,
      transactionCategoryId: undefined,
      merchantCategoryId: undefined,
      productCategoryId: undefined,
      parentProductCategoryId: undefined,
    }),
    { categoryId: 'addon-default', source: 'charge_default' },
  );

  const withoutDefault = {
    ...pack,
    defaultCategories: { ...pack.defaultCategories, addon: '' },
  };
  assert.deepEqual(
    resolveTaxCategory(withoutDefault, {
      ...full,
      transactionCategoryId: undefined,
      merchantCategoryId: undefined,
      productCategoryId: undefined,
      parentProductCategoryId: undefined,
    }),
    { categoryId: 'unclassified', source: 'unclassified' },
  );
  assert.deepEqual(resolveTaxCategory(pack, { ...full, transactionExempt: true }), {
    categoryId: null,
    source: 'transaction_exemption',
  });
});

test('compound percent tax uses acyclic line-local dependencies', () => {
  const pack = packWith([
    { id: 'base-tax', label: 'Base Tax', type: 'percent', categoryIds: ['explicit'], rate: '10' },
    {
      id: 'surcharge',
      label: 'Surcharge',
      type: 'percent',
      categoryIds: ['explicit'],
      rate: '5',
      baseRuleIds: ['base-tax'],
    },
  ]);
  const result = calculate(pack, [line()]);
  assert.deepEqual(
    result.lines[0].components.map((component) => component.amount),
    ['10.00', '5.50'],
  );
  assert.equal(result.lines[0].taxAmount, '15.50');

  const cyclic = packWith([
    {
      id: 'a',
      label: 'A',
      type: 'percent',
      categoryIds: ['explicit'],
      rate: '1',
      baseRuleIds: ['b'],
    },
    {
      id: 'b',
      label: 'B',
      type: 'percent',
      categoryIds: ['explicit'],
      rate: '1',
      baseRuleIds: ['a'],
    },
  ]);
  assert.throws(() => calculate(cyclic, [line()]), /dependency cycle/);
});

test('fixed inclusive tax is removed before solving percent taxes', () => {
  const pack = packWith([
    {
      id: 'fixed',
      label: 'Fixed',
      type: 'fixed',
      categoryIds: ['explicit'],
      amount: '10',
      appliesPer: 'line',
    },
    { id: 'vat', label: 'VAT', type: 'percent', categoryIds: ['explicit'], rate: '10' },
  ]);
  const result = calculate(pack, [line({ unitPrice: '120', taxBehavior: 'inclusive' })]);
  assert.equal(result.lines[0].taxableBase, '100.00');
  assert.deepEqual(
    result.lines[0].components.map((component) => component.amount),
    ['10.00', '10.00'],
  );
  assert.equal(result.payableTotal, '120');

  const fixedInBase = packWith([
    {
      id: 'fixed',
      label: 'Fixed',
      type: 'fixed',
      categoryIds: ['explicit'],
      amount: '10',
      appliesPer: 'line',
    },
    {
      id: 'vat',
      label: 'VAT',
      type: 'percent',
      categoryIds: ['explicit'],
      rate: '10',
      baseRuleIds: ['fixed'],
    },
  ]);
  const based = calculate(fixedInBase, [line({ unitPrice: '120', taxBehavior: 'inclusive' })]);
  assert.equal(based.lines[0].taxableBase, '99.09');
  assert.deepEqual(
    based.lines[0].components.map((component) => component.amount),
    ['10.00', '10.91'],
  );

  assert.throws(
    () => calculate(pack, [line({ unitPrice: '5', taxBehavior: 'inclusive' })]),
    /exceeds gross/,
  );
});

test('tax rounding implements all four methods', () => {
  const expected: Record<RoundingMethod, string> = {
    half_up: '0.1',
    half_even: '0.0',
    floor: '0.0',
    ceiling: '0.1',
  };
  for (const method of Object.keys(expected) as RoundingMethod[]) {
    const pack = packWith(
      [{ id: 'tax', label: 'Tax', type: 'percent', categoryIds: ['explicit'], rate: '5' }],
      { decimalPlaces: 1, method },
    );
    assert.equal(calculate(pack, [line({ unitPrice: '1' })]).lines[0].taxAmount, expected[method]);
  }
});

test('unit, line, and document scopes round at their declared boundaries', () => {
  const rule: TaxRule = {
    id: 'tax',
    label: 'Tax',
    type: 'percent',
    categoryIds: ['explicit'],
    rate: '5',
  };
  const unitPack = packWith([rule], { scope: 'unit' });
  assert.equal(
    calculate(unitPack, [line({ quantity: '3', unitPrice: '0.10' })]).lines[0].taxAmount,
    '0.03',
  );

  const linePack = packWith([rule], { scope: 'line' });
  assert.equal(
    calculate(linePack, [line({ quantity: '3', unitPrice: '0.10' })]).lines[0].taxAmount,
    '0.02',
  );

  const documentPack = packWith([rule], { scope: 'document' });
  const document = calculate(documentPack, [
    line({ lineId: 'line-b', unitPrice: '0.10' }),
    line({ lineId: 'line-a', unitPrice: '0.10' }),
  ]);
  assert.equal(document.taxAmount, '0.01');
  assert.deepEqual(
    document.lines.map((entry) => entry.taxAmount),
    ['0.00', '0.01'],
  );
});

test('largest remainder ties sort by ruleId, then lineId', () => {
  const ruleTie = packWith(
    [
      { id: 'b-rule', label: 'B', type: 'percent', categoryIds: ['explicit'], rate: '0.5' },
      { id: 'a-rule', label: 'A', type: 'percent', categoryIds: ['explicit'], rate: '0.5' },
    ],
    { scope: 'document' },
  );
  const byRule = calculate(ruleTie, [line({ unitPrice: '1' })]);
  assert.deepEqual(
    byRule.lines[0].components.map((component) => [component.ruleId, component.amount]),
    [
      ['b-rule', '0.00'],
      ['a-rule', '0.01'],
    ],
  );

  const lineTie = packWith(
    [{ id: 'tax', label: 'Tax', type: 'percent', categoryIds: ['explicit'], rate: '0.5' }],
    { scope: 'document' },
  );
  const byLine = calculate(lineTie, [
    line({ lineId: 'z-line', unitPrice: '1' }),
    line({ lineId: 'a-line', unitPrice: '1' }),
  ]);
  assert.deepEqual(
    byLine.lines.map((entry) => [entry.lineId, entry.taxAmount]),
    [
      ['z-line', '0.00'],
      ['a-line', '0.01'],
    ],
  );
});

test('payable rounding is independent and implements all four methods', () => {
  const expected: Record<RoundingMethod, string> = {
    half_up: '1.05',
    half_even: '1',
    floor: '1',
    ceiling: '1.05',
  };
  for (const method of Object.keys(expected) as RoundingMethod[]) {
    const pack = packWith([], {}, { increment: '0.05', method });
    const result = calculate(pack, [line({ unitPrice: '1.025', taxBehavior: 'exempt' })]);
    assert.equal(result.payableTotal, expected[method]);
  }
});

test('applyPayableRounding (#170): fractional totals are not force-rounded to a whole unit', () => {
  // Default bundled-pack-style increment (0.01) must leave an already-2dp total untouched —
  // this is the exact scenario issue #170 reports as broken (USD/GBP $12.47 becoming $12.00).
  const centsPack = packWith([], {}, { increment: '0.01', method: 'half_up' });
  const centsResult = applyPayableRounding(12.47, centsPack);
  assert.equal(centsResult.total, 12.47);
  assert.equal(centsResult.adjustment, 0);

  // A pack that explicitly configures whole-unit rounding still rounds correctly (and only
  // when actually configured to, not unconditionally) — proving parity with the old behavior
  // when that behavior is a deliberate business choice rather than a hardcoded assumption.
  const wholeUnitPack = packWith([], {}, { increment: '1', method: 'half_up' });
  const wholeUnitResult = applyPayableRounding(19.99, wholeUnitPack);
  assert.equal(wholeUnitResult.total, 20);
  assert.equal(wholeUnitResult.adjustment, 0.01);

  // A coarser increment (e.g. rounding to the nearest ₹1/$0.05) rounds correctly too, and the
  // adjustment always equals total - exactTotal.
  const nickelPack = packWith([], {}, { increment: '0.05', method: 'half_up' });
  const nickelResult = applyPayableRounding(19.97, nickelPack);
  assert.equal(nickelResult.total, 19.95);
  assert.equal(nickelResult.adjustment, -0.02);

  // JS float dust from upstream plain-number arithmetic (e.g. 0.1 + 0.2) must be absorbed
  // before the increment is applied, not leak into the stored total/adjustment.
  const dustyPack = packWith([], {}, { increment: '0.01', method: 'half_up' });
  const dustyResult = applyPayableRounding(0.1 + 0.2, dustyPack);
  assert.equal(dustyResult.total, 0.3);
  assert.equal(dustyResult.adjustment, 0);
});

test('dual-rate and flat-rate packs reproduce current fixed behavior as data', () => {
  const intra = TaxEngine.calculate({
    pack: dualRatePack,
    country: 'ZZ',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: '2026-07-27',
    lines: [line({ unitPrice: '10.1', productCategoryId: 'standard', taxBehavior: 'exclusive' })],
  });
  assert.deepEqual(
    intra.lines[0].components.map((component) => ({
      title: component.label,
      rate: Number(component.rate),
      amount: Number(component.amount),
    })),
    [
      { title: 'Tax A', rate: 2.5, amount: 0.26 },
      { title: 'Tax B', rate: 2.5, amount: 0.25 },
    ],
  );
  assert.equal(intra.lines[0].taxAmount, '0.51');

  const inter = TaxEngine.calculate({
    pack: dualRatePack,
    country: 'ZZ',
    businessType: 'salon',
    storeStateCode: 'KA',
    transactionDate: '2026-07-27',
    customer: { registrationNumber: 'TAXID-0001', stateCode: 'MH' },
    lines: [line({ unitPrice: '100', productCategoryId: 'standard', taxBehavior: 'exclusive' })],
  });
  assert.deepEqual(
    inter.lines[0].components.map((component) => ({
      title: component.label,
      rate: Number(component.rate),
      amount: Number(component.amount),
    })),
    [{ title: 'Tax C', rate: 5, amount: 5 }],
  );

  const flat = calculate(
    flatRatePack,
    [line({ unitPrice: '100', productCategoryId: 'standard', taxBehavior: 'exclusive' })],
    { businessType: 'restaurant' },
  );
  assert.deepEqual(
    flat.lines[0].components.map((component) => ({
      title: component.label,
      rate: Number(component.rate),
      amount: Number(component.amount),
    })),
    [{ title: 'Tax', rate: 7, amount: 7 }],
  );
  assert.equal(
    dualRatePack.rules.every((rule) => rule.rate !== undefined),
    true,
  );
  assert.equal(flatRatePack.rules[0].rate, '7');
});

test('unclassified products are taxed at the standard rate, never silently zero', () => {
  const dual = calculate(
    dualRatePack,
    [line({ unitPrice: '1000', productCategoryId: 'unclassified', taxBehavior: 'exclusive' })],
    { businessType: 'restaurant', storeStateCode: 'KA' },
  );
  assert.equal(dual.lines[0].taxAmount, '50.00');
  assert.deepEqual(
    dual.lines[0].components.map((component) => [component.label, component.amount]),
    [
      ['Tax A', '25.00'],
      ['Tax B', '25.00'],
    ],
  );

  const flat = calculate(
    flatRatePack,
    [line({ unitPrice: '100', productCategoryId: 'unclassified', taxBehavior: 'exclusive' })],
    { businessType: 'restaurant' },
  );
  assert.deepEqual(
    flat.lines[0].components.map((component) => [component.label, component.amount]),
    [['Tax', '7.00']],
  );

  const dualUnclassified = dualRatePack.categories.find(
    (category) => category.id === 'unclassified',
  )!;
  const flatUnclassified = flatRatePack.categories.find(
    (category) => category.id === 'unclassified',
  )!;
  assert.ok(
    dualUnclassified.ruleIds.length > 0,
    'dual-rate unclassified category must carry real tax rules',
  );
  assert.ok(
    flatUnclassified.ruleIds.length > 0,
    'flat-rate unclassified category must carry real tax rules',
  );
});

test('products without a resolved tax category charge no tax, regardless of legacy tax_type/tax_rate', () => {
  const uncategorizedIndia = calculateItemTax(
    { country: 'IN', business_type: 'restaurant', state_code: 'KA', taxes_enabled: true },
    { tax_type: 'exclusive', tax_rate: 18 },
    10.1,
    null,
  );
  assert.deepEqual(uncategorizedIndia, {
    tax_amount: 0,
    tax_breakdown: [],
    tax_type: 'none',
    tax_snapshot: null,
  });

  const uncategorizedFallback = calculateItemTax(
    { country: 'US', business_type: 'retail', state_code: '', taxes_enabled: true },
    { tax_type: 'inclusive', tax_rate: 10 },
    110,
    null,
  );
  assert.deepEqual(uncategorizedFallback, {
    tax_amount: 0,
    tax_breakdown: [],
    tax_type: 'none',
    tax_snapshot: null,
  });
});

test('previewCategoryRate only counts rules the category actually claims via ruleIds, matching checkout (issue #220 item 2)', () => {
  // A deliberately drifted/malformed pack: 'orphan' declares 'standard' in
  // its own categoryIds, but 'standard' never lists 'orphan' in its ruleIds.
  // calculateRawLine (tax-engine.ts) only ever selects rules a category
  // claims via ruleIds, so checkout silently excludes 'orphan'. Before this
  // fix, previewCategoryRate selected by rule.categoryIds alone and would
  // have shown the merchant a rate (14%) checkout never actually charges.
  const realRule: TaxRule = {
    id: 'real',
    label: 'Real Tax',
    type: 'percent',
    categoryIds: ['standard'],
    rate: '5',
  };
  const orphanRule: TaxRule = {
    id: 'orphan',
    label: 'Orphan Tax',
    type: 'percent',
    categoryIds: ['standard'],
    rate: '9',
  };
  const pack: CountryPack = {
    ...packWith([realRule, orphanRule]),
    categories: [
      { id: 'standard', label: 'Standard', ruleIds: ['real'] },
      { id: 'unclassified', label: 'Unclassified', ruleIds: [] },
    ],
  };

  const preview = previewCategoryRate(pack, 'restaurant', 'standard');
  assert.deepEqual(
    preview,
    { percent: 5, label: 'Real Tax 5%' },
    'preview only counts the rule the category actually claims via ruleIds, not every rule that merely names the category',
  );

  const result = calculate(
    pack,
    [line({ unitPrice: '100', productCategoryId: 'standard', taxBehavior: 'exclusive' })],
    { businessType: 'restaurant' },
  );
  assert.deepEqual(
    result.lines[0].components.map((component) => [component.label, component.amount]),
    [['Real Tax', '5.00']],
    'checkout applies the same single rule preview now reports — no more preview/checkout mismatch',
  );
});

test('signed official-india two-item document rounding allocates 10.01 tax across items', () => {
  const indiaPack = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/legacy-tax-packs/official-india.json'), 'utf8'),
  ) as CountryPack;
  const result = TaxEngine.calculate({
    pack: indiaPack,
    currency: 'INR',
    country: 'IN',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: new Date().toISOString(),
    customer: null,
    lines: [
      {
        lineId: 'line-0001',
        kind: 'product',
        quantity: '1',
        unitPrice: '100.10',
        productCategoryId: 'standard',
        taxBehavior: 'exclusive',
      },
      {
        lineId: 'line-0002',
        kind: 'product',
        quantity: '1',
        unitPrice: '100.10',
        productCategoryId: 'standard',
        taxBehavior: 'exclusive',
      },
    ],
  });
  assert.equal(result.taxAmount, '10.01');
  assert.equal(result.payableTotal, '210.21');
  assert.deepEqual(
    result.lines.map((l) => l.taxAmount),
    ['5.01', '5.00'],
  );
  const cgstTotal = result.lines
    .flatMap((l) => l.components)
    .filter((c) => c.ruleId === 'b-cgst')
    .reduce((sum, c) => sum + Number(c.amount), 0);
  const sgstTotal = result.lines
    .flatMap((l) => l.components)
    .filter((c) => c.ruleId === 'a-sgst')
    .reduce((sum, c) => sum + Number(c.amount), 0);
  assert.equal(cgstTotal.toFixed(2), '5.00');
  assert.equal(sgstTotal.toFixed(2), '5.01');
});

test('US document rounding allocates 0.01 tax across two 0.05 items at 8%', () => {
  const usPack = packWith(
    [
      {
        id: 'sales-tax',
        label: 'Sales Tax',
        type: 'percent',
        categoryIds: ['standard'],
        rate: '8',
      },
    ],
    {
      scope: 'document',
      method: 'half_up',
      decimalPlaces: 2,
      remainderAllocation: 'largest_remainder',
    },
  );
  const result = calculate(usPack, [
    line({
      lineId: 'line-0001',
      unitPrice: '0.05',
      productCategoryId: 'standard',
      taxBehavior: 'exclusive',
    }),
    line({
      lineId: 'line-0002',
      unitPrice: '0.05',
      productCategoryId: 'standard',
      taxBehavior: 'exclusive',
    }),
  ]);
  assert.equal(result.taxAmount, '0.01');
  assert.equal(result.payableTotal, '0.11');
  assert.deepEqual(
    result.lines.map((l) => l.taxAmount),
    ['0.01', '0.00'],
  );
});

test('calculateDocumentItemTaxes handles mixed categorized + uncategorized, scope line, and single-item wrapper', () => {
  const tenant = {
    country: 'IN',
    business_type: 'restaurant',
    state_code: 'KA',
    currency: 'INR',
    taxes_enabled: true,
  };

  // 1. Mixed categorized and uncategorized items (using exempt behavior to test without DB pack)
  const mixedResults = calculateDocumentItemTaxes(tenant, [
    { lineId: 'line-0001', product: { tax_type: 'none', tax_rate: 0 }, taxableAmount: 100 },
    {
      lineId: 'line-0002',
      product: {
        tax_type: 'none',
        tax_rate: 0,
        tax_category_id: 'standard',
        tax_behavior: 'exempt',
      },
      taxableAmount: 100,
    },
  ]);
  assert.equal(mixedResults[0].tax_amount, 0);
  assert.equal(mixedResults[0].tax_snapshot, null);
  assert.equal(mixedResults[1].tax_amount, 0);
  assert.ok(mixedResults[1].tax_snapshot);
  assert.equal(mixedResults[1].tax_type, 'none');

  // 2. Single-item calculateItemTax wrapper
  const single = calculateItemTax(
    tenant,
    { tax_type: 'none', tax_rate: 0, tax_category_id: 'standard', tax_behavior: 'exempt' },
    100,
    null,
  );
  assert.equal(single.tax_amount, 0);
  assert.ok(single.tax_snapshot);
  assert.equal(single.tax_snapshot.lines.length, 1);

  // 3. Scope line pack rounds lines independently
  const lineScopePack = packWith(
    [{ id: 'tax-5', label: 'Tax', type: 'percent', categoryIds: ['standard'], rate: '5' }],
    { scope: 'line', method: 'half_up', decimalPlaces: 2 },
  );
  const lineScopeResult = calculate(lineScopePack, [
    line({ lineId: 'line-0001', unitPrice: '10.05', productCategoryId: 'standard' }),
    line({ lineId: 'line-0002', unitPrice: '10.05', productCategoryId: 'standard' }),
  ]);
  // 10.05 * 0.05 = 0.5025 -> rounded per line to 0.50 each, total 1.00
  assert.deepEqual(
    lineScopeResult.lines.map((l) => l.taxAmount),
    ['0.50', '0.50'],
  );
  assert.equal(lineScopeResult.taxAmount, '1.00');
});

test('calculateDocumentItemTaxes does not skip zero-price categorized items', () => {
  const tenant = {
    country: 'IN',
    business_type: 'restaurant',
    state_code: 'KA',
    currency: 'INR',
    taxes_enabled: true,
  };

  const results = calculateDocumentItemTaxes(tenant, [
    {
      lineId: 'free-item',
      product: {
        tax_type: 'none',
        tax_rate: 0,
        tax_category_id: 'standard',
        tax_behavior: 'exempt',
      },
      taxableAmount: 0,
    },
  ]);
  assert.equal(results[0].tax_amount, 0);
  assert.ok(results[0].tax_snapshot, 'zero-price categorized item must receive a tax snapshot');
});

test('allocateDocumentTaxRounding applies order discount ratio before document largest_remainder rounding', () => {
  const officialIndiaPack = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/legacy-tax-packs/official-india.json'), 'utf8'),
  ) as CountryPack;
  for (const price of ['100.10', '100.05']) {
    const undiscounted = TaxEngine.calculate({
      pack: officialIndiaPack,
      currency: 'INR',
      country: 'IN',
      businessType: 'restaurant',
      storeStateCode: 'KA',
      transactionDate: '2026-06-01',
      lines: [
        line({
          lineId: 'line-0001',
          unitPrice: price,
          productCategoryId: 'standard',
          taxBehavior: 'exclusive',
        }),
        line({
          lineId: 'line-0002',
          unitPrice: price,
          productCategoryId: 'standard',
          taxBehavior: 'exclusive',
        }),
      ],
    });
    const oracle = TaxEngine.calculate({
      pack: officialIndiaPack,
      currency: 'INR',
      country: 'IN',
      businessType: 'restaurant',
      storeStateCode: 'KA',
      transactionDate: '2026-06-01',
      lines: [
        line({
          lineId: 'line-0001',
          unitPrice: price,
          discount: new Decimal(price).div(2).toString(),
          productCategoryId: 'standard',
          taxBehavior: 'exclusive',
        }),
        line({
          lineId: 'line-0002',
          unitPrice: price,
          discount: new Decimal(price).div(2).toString(),
          productCategoryId: 'standard',
          taxBehavior: 'exclusive',
        }),
      ],
    });

    const allocated = allocateDocumentTaxRounding({
      items: undiscounted.lines.map((l) => ({
        snapshot: { ...undiscounted.snapshot, lines: [l] },
        lineIdOverride: l.lineId,
      })),
      chargeTaxes: { taxAmount: 0, exclusiveTaxAmount: 0, breakdowns: [], snapshotJson: [] },
      currency: 'INR',
      itemTaxRatio: new Decimal('0.5'),
    });

    const totalAllocatedTax = allocated.itemOutputs
      .reduce((acc, out) => acc.plus(out.taxAmount), new Decimal(0))
      .toFixed(2);
    assert.equal(totalAllocatedTax, oracle.taxAmount);
  }

  // 100.20 item + 100.10 charge with 100% item discount (itemTaxRatio = 0)
  const undiscountedWithCharge = TaxEngine.calculate({
    pack: officialIndiaPack,
    currency: 'INR',
    country: 'IN',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: '2026-06-01',
    lines: [
      line({
        lineId: 'line-0001',
        unitPrice: '100.20',
        productCategoryId: 'standard',
        taxBehavior: 'exclusive',
      }),
      line({
        lineId: 'charge:packaging',
        kind: 'packaging',
        unitPrice: '100.10',
        merchantCategoryId: 'standard',
        taxBehavior: 'country_default',
      }),
    ],
  });
  const chargeOracle = TaxEngine.calculate({
    pack: officialIndiaPack,
    currency: 'INR',
    country: 'IN',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: '2026-06-01',
    lines: [
      line({
        lineId: 'line-0001',
        unitPrice: '100.20',
        discount: '100.20',
        productCategoryId: 'standard',
        taxBehavior: 'exclusive',
      }),
      line({
        lineId: 'charge:packaging',
        kind: 'packaging',
        unitPrice: '100.10',
        merchantCategoryId: 'standard',
        taxBehavior: 'country_default',
      }),
    ],
  });

  const allocatedWithCharge = allocateDocumentTaxRounding({
    items: [
      {
        snapshot: { ...undiscountedWithCharge.snapshot, lines: [undiscountedWithCharge.lines[0]] },
        lineIdOverride: 'line-0001',
      },
    ],
    chargeTaxes: {
      taxAmount: Number(undiscountedWithCharge.lines[1].taxAmount),
      exclusiveTaxAmount: Number(undiscountedWithCharge.lines[1].taxAmount),
      breakdowns: [[]],
      snapshotJson: [
        JSON.stringify({
          ...undiscountedWithCharge.snapshot,
          lines: [undiscountedWithCharge.lines[1]],
          chargeKind: 'packaging',
        }),
      ],
    },
    currency: 'INR',
    itemTaxRatio: new Decimal(0),
  });

  assert.equal(allocatedWithCharge.itemOutputs[0].taxAmount, 0);
  assert.equal(allocatedWithCharge.chargeTaxes.taxAmount.toFixed(2), chargeOracle.taxAmount);

  const single10010 = TaxEngine.calculate({
    pack: officialIndiaPack,
    currency: 'INR',
    country: 'IN',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: '2026-06-01',
    lines: [
      line({
        lineId: 'line-0001',
        unitPrice: '100.10',
        productCategoryId: 'standard',
        taxBehavior: 'exclusive',
      }),
    ],
  });
  const charge10010 = TaxEngine.calculate({
    pack: { ...officialIndiaPack, version: '2026.2.0' },
    currency: 'INR',
    country: 'IN',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: '2026-06-01',
    lines: [
      line({
        lineId: 'charge:packaging',
        kind: 'packaging',
        unitPrice: '100.10',
        merchantCategoryId: 'standard',
        taxBehavior: 'country_default',
      }),
    ],
  });
  const mixedVersionItemsAlloc = allocateDocumentTaxRounding({
    items: [
      {
        snapshot: { ...single10010.snapshot, lines: [single10010.lines[0]] },
        lineIdOverride: 'line-0001',
      },
      {
        snapshot: { ...charge10010.snapshot, lines: [single10010.lines[0]] },
        lineIdOverride: 'line-0002',
      },
    ],
    chargeTaxes: { taxAmount: 0, exclusiveTaxAmount: 0, breakdowns: [], snapshotJson: [] },
    currency: 'INR',
    itemTaxRatio: new Decimal('0.5'),
  });
  const mixedItemTax = mixedVersionItemsAlloc.itemOutputs
    .reduce((acc, out) => acc.plus(out.taxAmount), new Decimal(0))
    .toFixed(2);
  assert.equal(mixedItemTax, '5.01');

  const mixedVersionItemAndChargeAlloc = allocateDocumentTaxRounding({
    items: [
      {
        snapshot: { ...single10010.snapshot, lines: [single10010.lines[0]] },
        lineIdOverride: 'line-0001',
      },
    ],
    chargeTaxes: {
      taxAmount: Number(charge10010.lines[0].taxAmount),
      exclusiveTaxAmount: Number(charge10010.lines[0].taxAmount),
      breakdowns: [[]],
      snapshotJson: [
        JSON.stringify({
          ...charge10010.snapshot,
          lines: [charge10010.lines[0]],
          chargeKind: 'packaging',
        }),
      ],
    },
    currency: 'INR',
  });
  const mixedItemAndChargeTax = new Decimal(mixedVersionItemAndChargeAlloc.itemOutputs[0].taxAmount)
    .plus(mixedVersionItemAndChargeAlloc.chargeTaxes.taxAmount)
    .toFixed(2);
  assert.equal(mixedItemAndChargeTax, '10.01');

  // Repeating-decimal flat discount ratio: 104.00 item + 0.10 charge with 88.00 flat discount (16 / 104)
  const item104WithCharge = TaxEngine.calculate({
    pack: officialIndiaPack,
    currency: 'INR',
    country: 'IN',
    businessType: 'restaurant',
    storeStateCode: 'KA',
    transactionDate: '2026-06-01',
    lines: [
      line({
        lineId: 'line-0001',
        unitPrice: '104.00',
        productCategoryId: 'standard',
        taxBehavior: 'exclusive',
      }),
      line({
        lineId: 'charge:packaging',
        kind: 'packaging',
        unitPrice: '0.10',
        merchantCategoryId: 'standard',
        taxBehavior: 'country_default',
      }),
    ],
  });
  const repeatingRatio = computeDiscountTaxRatio('16.00', '104.00');
  const repeatingAlloc = allocateDocumentTaxRounding({
    items: [
      {
        snapshot: { ...item104WithCharge.snapshot, lines: [item104WithCharge.lines[0]] },
        lineIdOverride: 'line-0001',
      },
    ],
    chargeTaxes: {
      taxAmount: Number(item104WithCharge.lines[1].taxAmount),
      exclusiveTaxAmount: Number(item104WithCharge.lines[1].taxAmount),
      breakdowns: [[]],
      snapshotJson: [
        JSON.stringify({
          ...item104WithCharge.snapshot,
          lines: [item104WithCharge.lines[1]],
          chargeKind: 'packaging',
        }),
      ],
    },
    currency: 'INR',
    itemTaxRatio: repeatingRatio,
  });
  assert.equal(repeatingAlloc.itemOutputs[0].taxAmount.toFixed(2), '0.80');
  assert.equal(repeatingAlloc.chargeTaxes.taxAmount.toFixed(2), '0.01');

  // Line-scoped scaleTaxSnapshots keeps line-rounded amounts and does not sum discarded remainders
  const lineScopedScaled = scaleTaxSnapshots(
    [
      JSON.stringify({
        packId: 'line-pack',
        taxRounding: { scope: 'line', method: 'half_up' },
        lines: [
          {
            lineId: 'line-0001',
            grossAmount: '10.16',
            taxableBase: '10.16',
            taxAmount: '0.50',
            components: [
              {
                ruleId: 'a',
                name: 'Tax A',
                rate: '2.5',
                amount: '0.25',
                roundingRemainder: '0.004',
              },
              {
                ruleId: 'b',
                name: 'Tax B',
                rate: '2.5',
                amount: '0.25',
                roundingRemainder: '0.004',
              },
            ],
          },
        ],
      }),
    ],
    computeDiscountTaxRatio('10.14', '10.16'),
    100,
  );
  const parsedLineScoped = JSON.parse(lineScopedScaled[0]);
  assert.equal(parsedLineScoped.lines[0].taxAmount, '0.50');
});
