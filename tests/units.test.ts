/**
 * Supply unit conversion and rounding invariants.
 *
 * Usage: npx ts-node --transpile-only -P tests/tsconfig.json tests/units.test.ts
 */
import {
  QUANTITY_PRECISION,
  SUPPLY_UNITS,
  UnitConversionError,
  assertSupplyUnit,
  convertQuantity,
  isSupplyUnit,
  roundQuantity,
} from '../main/services/units';

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string): void {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertThrows(fn: () => void, statusCode: number, messageIncludes: string, label: string): void {
  total++;
  try {
    fn();
    failed++;
    console.error(`  ✗ ${label} — expected throw`);
  } catch (error) {
    const err = error as { statusCode?: number; message?: string };
    if (err.statusCode === statusCode && String(err.message).includes(messageIncludes)) {
      passed++;
      console.log(`  ✓ ${label}`);
    } else {
      failed++;
      console.error(`  ✗ ${label} — got statusCode=${err.statusCode} message=${err.message}`);
    }
  }
}

console.log('Supply units test');
console.log('='.repeat(50));

assertEqual(QUANTITY_PRECISION, 8, 'quantity precision is 8');
assertEqual(SUPPLY_UNITS.length, 5, 'five supply units');
assert(isSupplyUnit('kg'), 'kg is a supply unit');
assert(!isSupplyUnit('lb'), 'lb is not a supply unit');

assertThrows(() => assertSupplyUnit('lb'), 400, 'must be one of', 'assertSupplyUnit rejects unknown unit');
assertThrows(() => assertSupplyUnit('lb', 'unit'), 400, 'unit must be one of', 'assertSupplyUnit uses provided field name');

assertEqual(convertQuantity(1, 'kg', 'g'), 1000, '1 kg = 1000 g');
assertEqual(convertQuantity(1000, 'g', 'kg'), 1, '1000 g = 1 kg');
assertEqual(convertQuantity(1, 'l', 'ml'), 1000, '1 l = 1000 ml');
assertEqual(convertQuantity(1000, 'ml', 'l'), 1, '1000 ml = 1 l');
assertEqual(convertQuantity(2.5, 'each', 'each'), 2.5, 'each to each is identity');
assertEqual(convertQuantity(1, 'kg', 'kg'), 1, 'same unit is identity');

assertThrows(() => convertQuantity(1, 'g', 'ml'), 400, 'different dimensions', 'g → ml is rejected');
assertThrows(() => convertQuantity(1, 'each', 'kg'), 400, 'different dimensions', 'each → kg is rejected');
assertThrows(() => convertQuantity(1, 'ml', 'g'), 400, 'different dimensions', 'ml → g is rejected');
assertThrows(() => convertQuantity(Number.NaN, 'g', 'kg'), 400, 'finite', 'NaN quantity is rejected');

assertEqual(roundQuantity(1.1234567891), 1.12345679, 'rounds to 8 decimal places');
assertEqual(roundQuantity(1e-9), 0, 'sub-precision epsilon snaps to 0');
assertEqual(roundQuantity(-1e-9), 0, 'negative sub-precision epsilon snaps to 0');
assertThrows(() => roundQuantity(Number.POSITIVE_INFINITY), 400, 'finite', 'Infinity is rejected');

assertEqual(convertQuantity(1, 'l', 'ml') + convertQuantity(2, 'kg', 'g'), 3000, 'mixed-dimension sums stay in base units');

console.log('='.repeat(50));
console.log(`${passed}/${total} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
