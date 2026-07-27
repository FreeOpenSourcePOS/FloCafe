import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaxEngine, applyPayableRounding, resolveTaxCategory, type TaxEngineLine } from '../main/services/tax-engine';
import { calculateItemTax } from '../main/services/tax';
import type {
  CountryPack,
  PayableRounding,
  RoundingMethod,
  TaxRounding,
  TaxRule,
} from '../main/tax-packs/types';
import indiaPackData from '../main/tax-packs/in.json';
import thailandPackData from '../main/tax-packs/th.json';

const indiaPack = indiaPackData as CountryPack;
const thailandPack = thailandPackData as CountryPack;

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

function calculate(pack: CountryPack, lines: TaxEngineLine[]) {
  return TaxEngine.calculate({
    pack,
    country: pack.country,
    transactionDate: '2026-07-27',
    lines,
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
  assert.equal(resolveTaxCategory(pack, { ...full, transactionCategoryId: undefined }).categoryId, 'merchant');
  assert.equal(resolveTaxCategory(pack, {
    ...full,
    transactionCategoryId: undefined,
    merchantCategoryId: undefined,
  }).categoryId, 'explicit');
  assert.equal(resolveTaxCategory(pack, {
    ...full,
    transactionCategoryId: undefined,
    merchantCategoryId: undefined,
    productCategoryId: undefined,
  }).categoryId, 'parent');
  assert.deepEqual(resolveTaxCategory(pack, {
    ...full,
    transactionCategoryId: undefined,
    merchantCategoryId: undefined,
    productCategoryId: undefined,
    parentProductCategoryId: undefined,
  }), { categoryId: 'addon-default', source: 'charge_default' });

  const withoutDefault = {
    ...pack,
    defaultCategories: { ...pack.defaultCategories, addon: '' },
  };
  assert.deepEqual(resolveTaxCategory(withoutDefault, {
    ...full,
    transactionCategoryId: undefined,
    merchantCategoryId: undefined,
    productCategoryId: undefined,
    parentProductCategoryId: undefined,
  }), { categoryId: 'unclassified', source: 'unclassified' });
  assert.deepEqual(resolveTaxCategory(pack, { ...full, transactionExempt: true }), {
    categoryId: null,
    source: 'transaction_exemption',
  });
});

test('compound percent tax uses acyclic line-local dependencies', () => {
  const pack = packWith([
    { id: 'gst', label: 'GST', type: 'percent', categoryIds: ['explicit'], rate: '10' },
    {
      id: 'cess',
      label: 'Cess',
      type: 'percent',
      categoryIds: ['explicit'],
      rate: '5',
      baseRuleIds: ['gst'],
    },
  ]);
  const result = calculate(pack, [line()]);
  assert.deepEqual(result.lines[0].components.map((component) => component.amount), ['10.00', '5.50']);
  assert.equal(result.lines[0].taxAmount, '15.50');

  const cyclic = packWith([
    {
      id: 'a', label: 'A', type: 'percent', categoryIds: ['explicit'], rate: '1', baseRuleIds: ['b'],
    },
    {
      id: 'b', label: 'B', type: 'percent', categoryIds: ['explicit'], rate: '1', baseRuleIds: ['a'],
    },
  ]);
  assert.throws(() => calculate(cyclic, [line()]), /dependency cycle/);
});

test('fixed inclusive tax is removed before solving percent taxes', () => {
  const pack = packWith([
    {
      id: 'fixed', label: 'Fixed', type: 'fixed', categoryIds: ['explicit'], amount: '10', appliesPer: 'line',
    },
    { id: 'vat', label: 'VAT', type: 'percent', categoryIds: ['explicit'], rate: '10' },
  ]);
  const result = calculate(pack, [line({ unitPrice: '120', taxBehavior: 'inclusive' })]);
  assert.equal(result.lines[0].taxableBase, '100.00');
  assert.deepEqual(result.lines[0].components.map((component) => component.amount), ['10.00', '10.00']);
  assert.equal(result.payableTotal, '120');

  const fixedInBase = packWith([
    {
      id: 'fixed', label: 'Fixed', type: 'fixed', categoryIds: ['explicit'], amount: '10', appliesPer: 'line',
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
  assert.deepEqual(based.lines[0].components.map((component) => component.amount), ['10.00', '10.91']);

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
    id: 'tax', label: 'Tax', type: 'percent', categoryIds: ['explicit'], rate: '5',
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
  assert.deepEqual(document.lines.map((entry) => entry.taxAmount), ['0.00', '0.01']);
});

test('largest remainder ties sort by ruleId, then lineId', () => {
  const ruleTie = packWith([
    { id: 'b-rule', label: 'B', type: 'percent', categoryIds: ['explicit'], rate: '0.5' },
    { id: 'a-rule', label: 'A', type: 'percent', categoryIds: ['explicit'], rate: '0.5' },
  ], { scope: 'document' });
  const byRule = calculate(ruleTie, [line({ unitPrice: '1' })]);
  assert.deepEqual(
    byRule.lines[0].components.map((component) => [component.ruleId, component.amount]),
    [['b-rule', '0.00'], ['a-rule', '0.01']],
  );

  const lineTie = packWith([
    { id: 'tax', label: 'Tax', type: 'percent', categoryIds: ['explicit'], rate: '0.5' },
  ], { scope: 'document' });
  const byLine = calculate(lineTie, [
    line({ lineId: 'z-line', unitPrice: '1' }),
    line({ lineId: 'a-line', unitPrice: '1' }),
  ]);
  assert.deepEqual(byLine.lines.map((entry) => [entry.lineId, entry.taxAmount]), [
    ['z-line', '0.00'],
    ['a-line', '0.01'],
  ]);
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

test('bundled India and Thailand packs reproduce current fixed behavior as data', () => {
  const intra = calculateItemTax(
    { country: 'IN', business_type: 'restaurant', state_code: 'KA' },
    {
      tax_type: 'exclusive', tax_rate: 99, tax_category_id: 'standard', tax_behavior: 'exclusive',
    },
    10.1,
    null,
  );
  assert.deepEqual(
    { tax_amount: intra.tax_amount, tax_breakdown: intra.tax_breakdown, tax_type: intra.tax_type },
    {
      tax_amount: 0.51,
      tax_breakdown: [
        { title: 'CGST', rate: 2.5, amount: 0.25 },
        { title: 'SGST', rate: 2.5, amount: 0.26 },
      ],
      tax_type: 'exclusive',
    },
  );
  assert.ok(intra.tax_snapshot, 'categorized items also carry the full engine snapshot');

  const inter = calculateItemTax(
    { country: 'IN', business_type: 'salon', state_code: 'KA' },
    {
      tax_type: 'exclusive', tax_rate: 99, tax_category_id: 'standard', tax_behavior: 'exclusive',
    },
    100,
    { gstin: 'GSTIN', customer_state_code: 'MH' },
  );
  assert.deepEqual(inter.tax_breakdown, [{ title: 'IGST', rate: 5, amount: 5 }]);

  const thai = calculateItemTax(
    { country: 'TH', business_type: 'restaurant', state_code: '' },
    {
      tax_type: 'exclusive', tax_rate: 99, tax_category_id: 'standard', tax_behavior: 'exclusive',
    },
    100,
    null,
  );
  assert.deepEqual(thai.tax_breakdown, [{ title: 'VAT', rate: 7, amount: 7 }]);
  assert.equal(indiaPack.rules.every((rule) => rule.rate !== undefined), true);
  assert.equal(thailandPack.rules[0].rate, '7');
});

test('unclassified products are taxed at the standard rate, never silently zero', () => {
  const india = calculateItemTax(
    { country: 'IN', business_type: 'restaurant', state_code: 'KA' },
    { tax_type: 'exclusive', tax_rate: 99, tax_category_id: 'unclassified', tax_behavior: 'exclusive' },
    1000,
    null,
  );
  assert.equal(india.tax_amount, 50);
  assert.deepEqual(india.tax_breakdown, [
    { title: 'CGST', rate: 2.5, amount: 25 },
    { title: 'SGST', rate: 2.5, amount: 25 },
  ]);

  const thailand = calculateItemTax(
    { country: 'TH', business_type: 'restaurant', state_code: '' },
    { tax_type: 'exclusive', tax_rate: 99, tax_category_id: 'unclassified', tax_behavior: 'exclusive' },
    100,
    null,
  );
  assert.deepEqual(thailand.tax_breakdown, [{ title: 'VAT', rate: 7, amount: 7 }]);

  const indiaUnclassified = indiaPack.categories.find((category) => category.id === 'unclassified')!;
  const thailandUnclassified = thailandPack.categories.find((category) => category.id === 'unclassified')!;
  assert.ok(indiaUnclassified.ruleIds.length > 0, 'India unclassified category must carry real tax rules');
  assert.ok(thailandUnclassified.ruleIds.length > 0, 'Thailand unclassified category must carry real tax rules');
});

test('products without a resolved tax category preserve legacy tax configuration', () => {
  const uncategorizedIndia = calculateItemTax(
    { country: 'IN', business_type: 'restaurant', state_code: 'KA' },
    { tax_type: 'exclusive', tax_rate: 18 },
    10.1,
    null,
  );
  assert.deepEqual(uncategorizedIndia, {
    tax_amount: 0.51,
    tax_breakdown: [
      { title: 'CGST', rate: 2.5, amount: 0.26 },
      { title: 'SGST', rate: 2.5, amount: 0.25 },
    ],
    tax_type: 'exclusive',
    tax_snapshot: null,
  });

  const uncategorizedFallback = calculateItemTax(
    { country: 'US', business_type: 'retail', state_code: '' },
    { tax_type: 'inclusive', tax_rate: 10 },
    110,
    null,
  );
  assert.deepEqual(uncategorizedFallback, {
    tax_amount: 10,
    tax_breakdown: [{ title: 'Sales Tax', rate: 10, amount: 10 }],
    tax_type: 'inclusive',
    tax_snapshot: null,
  });
});
