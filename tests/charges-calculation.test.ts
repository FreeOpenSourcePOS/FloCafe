/**
 * Unified charges & fees engine - calculation and validation invariants.
 *
 * These are the guardrails PR #829 got wrong: hardcoded 2-decimal rounding that
 * corrupts zero-decimal and three-decimal currencies, waivers inferred from a
 * zero amount, and validation that accepted out-of-range values.
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-charges-calc-'));
const originalLoad = Module._load;
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  ChargeValidationError,
  MAX_PERCENTAGE,
  calculateAppliedCharges,
  normalizeChargeDefinitions,
  parseAppliedCharges,
  parseStoredChargeDefinitions,
  toStandardChargeColumns,
  totalAppliedCharges,
} = require('../shared/charges');
const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } = require('../main/countries');
const {
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');

const assert = require('assert');

function assertDeepEqualOrThrow(actual: unknown, expected: unknown, message: string) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✓ ${message}`);
  } catch (error: any) {
    console.error(`  ✗ ${message} — ${error.message}`);
    throw error;
  }
}

const USD = 2;
const JPY = 0;
const KWD = 3;

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'service_charge',
    name: 'Service Charge',
    type: 'percentage',
    value: 10,
    calculation_basis: 'net',
    order_types: ['dine_in'],
    is_optional: true,
    is_default_active: true,
    is_active: true,
    ...overrides,
  };
}

function expectRejection(payload: unknown, reason: string) {
  let threw: unknown = null;
  try {
    normalizeChargeDefinitions(payload);
  } catch (error) {
    threw = error;
  }
  assertOrThrow(threw instanceof ChargeValidationError, `rejects ${reason}`);
}

function testValidation() {
  const normalized = normalizeChargeDefinitions([definition()]);
  assertEqualOrThrow(normalized.length, 1, 'accepts a well-formed definition');
  assertEqualOrThrow(normalized[0].id, 'service_charge', 'keeps the charge id');
  assertEqualOrThrow(normalized[0].is_optional, true, 'marks the charge optional');
  assertEqualOrThrow(normalized[0].tax_category_id, null, 'defaults tax_category_id to null');

  assertEqualOrThrow(
    normalizeChargeDefinitions(JSON.stringify([definition()])).length,
    1,
    'accepts the stored JSON string form',
  );

  expectRejection([definition({ id: 'Bad Id!' })], 'a non-slug charge id');
  expectRejection([definition({ name: '   ' })], 'a blank charge name');
  expectRejection([definition({ name: 'x'.repeat(81) })], 'an over-long charge name');
  expectRejection([definition({ type: 'per_order' })], 'an unsupported charge type');
  expectRejection([definition({ calculation_basis: 'discounted' })], 'an unsupported calculation basis');
  expectRejection([definition({ order_types: ['bar'] })], 'an unknown order type');
  expectRejection([definition({ order_types: [] })], 'an empty order type list');
  expectRejection([definition({ value: -1 })], 'a negative value');
  expectRejection([definition({ value: MAX_PERCENTAGE + 1 })], 'a percentage above 100');
  expectRejection([definition({ value: 'abc' })], 'a non-numeric value');
  expectRejection([definition({ type: 'fixed', value: Number.MAX_VALUE })], 'a fixed amount outside currency precision');
  expectRejection([definition(), definition()], 'duplicate charge ids');
  expectRejection({ charges: [] }, 'a non-array payload');
  expectRejection([definition({ id: 'a'.repeat(65) })], 'an oversized charge id');

  let rejectsOneBadEntry = false;
  try {
    normalizeChargeDefinitions([definition(), definition({ id: 'late_night', value: 500 })]);
  } catch {
    rejectsOneBadEntry = true;
  }
  assertOrThrow(rejectsOneBadEntry, 'one invalid entry rejects the whole array (no partial write)');

  assertDeepEqualOrThrow(
    parseStoredChargeDefinitions('{not json'),
    [],
    'malformed stored charges read as no charges rather than throwing',
  );
}

function testOverflowGuards() {
  let calculationRejected = false;
  try {
    calculateAppliedCharges({
      definitions: [{ ...definition({ type: 'fixed', value: Number.MAX_VALUE }) } as any],
      orderType: 'dine_in',
      subtotal: 100,
      discountAmount: 0,
      currencyDecimals: USD,
    });
  } catch (error) {
    calculationRejected = error instanceof ChargeValidationError;
  }
  assertOrThrow(calculationRejected, 'calculation rejects a fixed amount that overflows scaled minor units');

  const largestUsdAmount = Number.MAX_SAFE_INTEGER / 100;
  const largeCharges = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([
      definition({ id: 'large_a', type: 'fixed', value: largestUsdAmount }),
      definition({ id: 'large_b', type: 'fixed', value: largestUsdAmount }),
    ], USD),
    orderType: 'dine_in',
    subtotal: 0,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  let aggregateRejected = false;
  try {
    toStandardChargeColumns(largeCharges, USD);
  } catch (error) {
    aggregateRejected = error instanceof ChargeValidationError;
  }
  assertOrThrow(aggregateRejected, 'combined charge minor units must remain a safe integer');

  const largePercentage = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10.1 })], USD),
    orderType: 'dine_in',
    subtotal: largestUsdAmount,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(
    largePercentage[0].amount,
    Number((BigInt(Number.MAX_SAFE_INTEGER) * 101n + 500n) / 1000n) / 100,
    'an unsafe 10.1 percent product still yields an accurately rounded safe result',
  );

  const zeroAndFullPercentage = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([
      definition({ id: 'zero_fee', value: 0 }),
      definition({ id: 'full_fee', value: 100 }),
    ], USD),
    orderType: 'dine_in',
    subtotal: 12.34,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertDeepEqualOrThrow(
    zeroAndFullPercentage.map((charge: any) => charge.amount),
    [0, 12.34],
    'zero and 100 percent retain currency rounding at ordinary amounts',
  );
}

function testBasisAndTypes() {
  const netVsGross = normalizeChargeDefinitions([
    definition({ id: 'net_fee', value: 10, calculation_basis: 'net' }),
    definition({ id: 'gross_fee', value: 10, calculation_basis: 'gross' }),
  ]);
  const applied = calculateAppliedCharges({
    definitions: netVsGross,
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 20,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(applied[0].amount, 8, 'net basis applies to the discounted subtotal');
  assertEqualOrThrow(applied[1].amount, 10, 'gross basis applies to the raw subtotal');

  const fixed = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ type: 'fixed', value: 55 })]),
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(fixed[0].amount, 55, 'a fixed fee ignores the subtotal');
  assertEqualOrThrow(fixed[0].rate, undefined, 'a fixed fee carries no rate');

  const percentage = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 12.5 })]),
    orderType: 'dine_in',
    subtotal: 200,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(percentage[0].amount, 25, 'a percentage fee applies its rate');
  assertEqualOrThrow(percentage[0].rate, 12.5, 'a percentage fee records its rate');

  const takeAwayOnly = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ order_types: ['takeaway', 'delivery'] })]),
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(takeAwayOnly.length, 0, 'a charge does not apply to an unlisted order type');
}

function testCurrencyPrecision() {
  assertEqualOrThrow(getCurrencyFractionDigits('JPY'), 0, 'JPY has no minor units');
  assertEqualOrThrow(getCurrencyFractionDigits('VND'), 0, 'VND has no minor units');
  assertEqualOrThrow(getCurrencyFractionDigits('KWD'), 3, 'KWD has three minor unit digits');

  const jpy = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10 }), definition({ id: 'packaging_charge', name: 'Packaging', type: 'fixed', value: 50, order_types: ['dine_in'] })]),
    orderType: 'dine_in',
    subtotal: 1235,
    discountAmount: 0,
    currencyDecimals: getCurrencyFractionDigits('JPY'),
  });
  assertEqualOrThrow(jpy[0].amount, 124, 'a JPY percentage fee rounds to whole yen');
  assertOrThrow(Number.isInteger(jpy[0].amount), 'a JPY fee never persists a fractional yen');
  assertEqualOrThrow(jpy[1].amount, 50, 'a JPY fixed fee is stored as an integer');
  assertOrThrow(Number.isInteger(jpy[1].amount), 'a JPY fixed fee never persists a subunit');

  const vnd = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10 })]),
    orderType: 'dine_in',
    subtotal: 12345,
    discountAmount: 0,
    currencyDecimals: getCurrencyFractionDigits('VND'),
  });
  assertEqualOrThrow(vnd[0].amount, 1235, 'a VND fee rounds half-up to whole dong');

  const kwd = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10 })]),
    orderType: 'dine_in',
    subtotal: 10.005,
    discountAmount: 0,
    currencyDecimals: getCurrencyFractionDigits('KWD'),
  });
  assertEqualOrThrow(kwd[0].amount, 1.001, 'a KWD fee rounds to three decimal places');
  assertOrThrow(
    Math.abs(kwd[0].amount * getCurrencyMinorUnitFactor('KWD') - Math.round(kwd[0].amount * 1000)) < 1e-9,
    'a KWD fee lands on a whole fils',
  );

  const usd = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 33.33 })]),
    orderType: 'dine_in',
    subtotal: 9.99,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(usd[0].amount, 3.33, 'a USD fee rounds to two decimal places');

  const negativeSubtotal = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10 })]),
    orderType: 'dine_in',
    subtotal: -50,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(negativeSubtotal[0].amount, 0, 'a negative subtotal yields a zero fee, never a negative one');

  const overDiscounted = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10, calculation_basis: 'net' })]),
    orderType: 'dine_in',
    subtotal: 50,
    discountAmount: 500,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(overDiscounted[0].amount, 0, 'a discount exceeding the subtotal floors the net fee at zero');
}

function testWaiverState() {
  const definitions = normalizeChargeDefinitions([definition({ value: 10, is_optional: true })]);

  const waived = calculateAppliedCharges({
    definitions,
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 0,
    waivedIds: ['service_charge'],
    currencyDecimals: USD,
  });
  assertEqualOrThrow(waived[0].waived, true, 'a waived charge persists waived: true');
  assertEqualOrThrow(waived[0].amount, 0, 'a waived charge records amount 0');
  assertEqualOrThrow(totalAppliedCharges(waived), 0, 'a waived charge is excluded from the total');

  const zeroRate = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 0 })]),
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  assertEqualOrThrow(zeroRate[0].amount, 0, 'a zero-rate charge records amount 0');
  assertEqualOrThrow(
    zeroRate[0].waived,
    false,
    'a zero-rate charge is distinguishable from a waived charge',
  );

  const preserved = JSON.parse(JSON.stringify(waived));
  assertEqualOrThrow(preserved[0].waived, true, 'waiver state survives a persistence round trip');

  const mandatoryWaiverAttempt = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([definition({ value: 10, is_optional: false })]),
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 0,
    waivedIds: ['service_charge'],
    currencyDecimals: USD,
  });
  assertEqualOrThrow(
    mandatoryWaiverAttempt[0].amount,
    10,
    'a mandatory charge cannot be zeroed by a stray waiver id',
  );
  assertEqualOrThrow(mandatoryWaiverAttempt[0].waived, false, 'a mandatory charge never records waived: true');
}

function testStandardColumnMapping() {
  const charges = calculateAppliedCharges({
    definitions: normalizeChargeDefinitions([
      definition({ id: 'service_charge', value: 10 }),
      definition({ id: 'packaging_charge', name: 'Packaging', type: 'fixed', value: 2.5 }),
      definition({ id: 'late_night', name: 'Late Night', type: 'fixed', value: 7 }),
    ]),
    orderType: 'dine_in',
    subtotal: 100,
    discountAmount: 0,
    currencyDecimals: USD,
  });
  const columns = toStandardChargeColumns(charges, USD);
  assertEqualOrThrow(columns.service_charge, 10, 'service_charge maps onto the dedicated column');
  assertEqualOrThrow(columns.packaging_charge, 2.5, 'packaging_charge maps onto the dedicated column');
  assertEqualOrThrow(columns.other_charges, 7, 'non-standard charges are summed, not dropped');
  assertEqualOrThrow(
    columns.service_charge + columns.packaging_charge + columns.other_charges,
    totalAppliedCharges(charges),
    'the column mapping reconciles with the itemised total',
  );

  const jpyColumns = toStandardChargeColumns(
    calculateAppliedCharges({
      definitions: normalizeChargeDefinitions([
        definition({ id: 'service_charge', value: 10 }),
        definition({ id: 'packaging_charge', name: 'Packaging', type: 'fixed', value: 50 }),
      ]),
      orderType: 'dine_in',
      subtotal: 1235,
      discountAmount: 0,
      currencyDecimals: JPY,
    }),
    JPY,
  );
  assertOrThrow(Number.isInteger(jpyColumns.service_charge), 'a JPY column mapping stays integral');
  assertOrThrow(Number.isInteger(jpyColumns.packaging_charge), 'a JPY packaging column stays integral');
}

function testParsing() {
  const persisted = '[{"id":"service_charge","name":"Service Charge","type":"percentage","amount":10,'
    + '"calculation_basis":"net","waived":true},'
    + '{"id":"packaging_charge","name":"Packaging","type":"fixed","amount":2.5,'
    + '"calculation_basis":"gross","waived":false}]';
  const parsed = parseAppliedCharges(persisted);
  assertEqualOrThrow(parsed.length, 2, 'parses a persisted charges_breakdown payload');
  assertEqualOrThrow(parsed[0].waived, true, 'a persisted waiver is read as waived');
  assertDeepEqualOrThrow(parseAppliedCharges(null), [], 'a null breakdown reads as no charges');
  assertDeepEqualOrThrow(parseAppliedCharges('{not json'), [], 'an unparseable breakdown reads as no charges');
  assertDeepEqualOrThrow(
    parseAppliedCharges('[{"id":"x"}]'),
    [],
    'a malformed breakdown entry is dropped',
  );
}

function main() {
  resetCounters();
  testValidation();
  testOverflowGuards();
  testBasisAndTypes();
  testCurrencyPrecision();
  testWaiverState();
  testStandardColumnMapping();
  testParsing();

  fs.rmSync(testDir, { recursive: true, force: true });
  const results = getResults();
  console.log(`\nCharges calculation: ${results.passed}/${results.total} checks passed`);
  if (results.failed > 0) process.exit(1);
}

main();
