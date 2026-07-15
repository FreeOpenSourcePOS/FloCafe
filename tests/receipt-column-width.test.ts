import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency } from '../main/countries';

/**
 * Fakes the receipt-encoder padRow math to assert that locale-aware
 * currency formatting does not blow past typical thermal column budgets.
 * If `right.length > cols`, the left side gets truncated; if it gets
 * close, the row stops reading cleanly. We assert a soft ceiling so
 * the column never goes wider than what fits alongside a typical label
 * like "TOTAL" (5 chars) plus a single space.
 */

function fits(leftBudget: number, right: string, cols: number): boolean {
  const gap = cols - leftBudget - right.length;
  return gap >= 0;
}

test('receipt column width: en-IN amounts fit in 32-col with TOTAL label', () => {
  const samples = [0, 1, 12.5, 123.45, 1234.5, 12345.67, 123456.78, 9999999.99];
  for (const amount of samples) {
    const right = formatCurrency(amount, 'INR', 'en-IN');
    assert.ok(fits(6, right, 32), `amount=${amount} -> "${right}" overflows 32-col row`);
  }
});

test('receipt column width: es-AR amounts fit in 32-col with TOTAL label', () => {
  const samples = [0, 1, 12.5, 123.45, 1234.5, 12345.67, 123456.78, 9999999.99];
  for (const amount of samples) {
    const right = formatCurrency(amount, 'ARS', 'es-AR');
    assert.ok(fits(6, right, 32), `amount=${amount} -> "${right}" overflows 32-col row`);
  }
});

test('receipt column width: en-US amounts fit in 32-col with TOTAL label', () => {
  const samples = [0, 1, 12.5, 123.45, 1234.5, 12345.67, 123456.78, 9999999.99];
  for (const amount of samples) {
    const right = formatCurrency(amount, 'USD', 'en-US');
    assert.ok(fits(6, right, 32), `amount=${amount} -> "${right}" overflows 32-col row`);
  }
});

test('receipt column width: en-IN lakh grouping is bounded', () => {
  // Indian numbering: 1,23,45,678.90 (lakhs/crores). 14 chars including symbol.
  const out = formatCurrency(12345678.9, 'INR', 'en-IN');
  // Worst case is around 16-18 chars for symbol + 1,23,45,67,890.12
  assert.ok(out.length <= 20, `expected <=20 chars, got ${out.length}: "${out}"`);
});
