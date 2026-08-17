import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatCurrencyForTenant,
  formatNumber,
  formatNumberForTenant,
  getCountryByCode,
} from '../main/countries';

/**
 * Batch G (Refs #241) — Iran locale/number/currency/calendar policy.
 *
 * Storage contract: monetary values are stored as raw numbers in the tenant's
 * currency code (IRR for Iran) and are NEVER converted to Toman. Display uses
 * `Intl` with the tenant locale (`fa-IR`), which renders the Rial symbol
 * (`ریال`), Persian digits (arabext), and the Shamsi calendar. Persian digits
 * and Shamsi calendar are the accepted defaults; Toman display and digit/calendar
 * configurability are intentionally deferred until an explicit product decision.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Maps Persian digits to Latin, then strips non-digits, for value assertions. */
function latinDigits(value: string): string {
  return value
    .split('')
    .map((ch) => {
      const i = PERSIAN_DIGITS.indexOf(ch);
      return i >= 0 ? String(i) : ch;
    })
    .join('')
    .replace(/\D/g, '');
}

test('IR profile resolves fa-IR / IRR / Asia/Tehran', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir);
  assert.equal(ir.locale, 'fa-IR');
  assert.equal(ir.currency, 'IRR');
  assert.equal(ir.timezone, 'Asia/Tehran');
});

test('formatCurrency: IR renders Rial with Persian digits and no decimals', () => {
  const out = formatCurrency(6000000, 'IRR', 'fa-IR');
  assert.ok(out.includes('ریال'), `expected the Rial token, got: ${out}`);
  assert.ok(!/\d/.test(out), `expected no Latin digits, got: ${out}`);
  assert.ok(!/[.,]/.test(out.replace('٬', '')), `expected no decimal separator, got: ${out}`);
  // 6,000,000 stored IRR renders as six million (no Toman conversion).
  assert.equal(latinDigits(out), '6000000');
});

test('formatCurrency: IR zero renders رial 0', () => {
  const out = formatCurrency(0, 'IRR', 'fa-IR');
  assert.ok(out.includes('ریال'), `expected the Rial token, got: ${out}`);
  assert.equal(latinDigits(out), '0');
});

test('formatCurrency: IR negative amount keeps sign and Persian digits', () => {
  const out = formatCurrency(-1234, 'IRR', 'fa-IR');
  assert.ok(/[-−]/.test(out), `expected a minus sign, got: ${out}`);
  assert.equal(latinDigits(out), '1234');
});

test('formatCurrency: IR large value groups correctly without overflow', () => {
  const out = formatCurrency(9876543210, 'IRR', 'fa-IR');
  assert.equal(latinDigits(out), '9876543210');
});

test('formatCurrencyForTenant: IR tenant uses fa-IR (Persian digits)', () => {
  const out = formatCurrencyForTenant(1234, 'IR', 'IRR');
  assert.ok(out.includes('ریال'), `expected the Rial token, got: ${out}`);
  assert.ok(!/\d/.test(out), `expected no Latin digits, got: ${out}`);
  assert.equal(latinDigits(out), '1234');
});

test('formatNumber: fa-IR uses Persian digits and grouping', () => {
  const out = formatNumber(1234567.89, 'fa-IR');
  assert.ok(!/\d/.test(out), `expected no Latin digits, got: ${out}`);
  assert.ok(out.includes('٫'), `expected Persian decimal separator, got: ${out}`);
  assert.ok(out.includes('٬'), `expected Persian grouping separator, got: ${out}`);
});

test('formatNumber: en-US stays Latin', () => {
  assert.equal(formatNumber(1234567.89, 'en-US'), '1,234,567.89');
});

test('formatNumberForTenant: IR uses Persian digits, IN stays Latin', () => {
  const ir = formatNumberForTenant(1234, 'IR');
  assert.ok(!/\d/.test(ir), `expected no Latin digits for IR, got: ${ir}`);
  assert.equal(latinDigits(ir), '1234');

  assert.equal(formatNumberForTenant(1234, 'IN'), '1,234');
});

test('formatNumberForTenant: unknown/missing country falls back to en-US', () => {
  assert.equal(formatNumberForTenant(1234, 'ZZ'), '1,234');
  assert.equal(formatNumberForTenant(1234, undefined), '1,234');
});

test('fa-IR dates use the Shamsi calendar by default', () => {
  const date = new Date(Date.UTC(2026, 7, 17, 12, 30, 0)); // 2026-08-17T12:30Z
  const out = new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
  assert.ok(out.includes('۱۴۰۵'), `expected Shamsi year ۱۴۰۵, got: ${out}`);
  assert.ok(out.includes('مرداد'), `expected Mordad month, got: ${out}`);
});

test('Asia/Tehran timezone crosses midnight correctly (UTC+3:30)', () => {
  // 21:30 UTC on 2026-01-01 is 01:00 on 2026-01-02 in Tehran.
  const date = new Date(Date.UTC(2026, 0, 1, 21, 30, 0));
  const tehranLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  assert.equal(tehranLocal, '2026-01-02');
});

test('non-Iran tenants keep existing currency behavior', () => {
  assert.equal(formatCurrency(1234.5, 'USD', 'en-US'), '$1,234.50');
  assert.match(formatCurrency(1234.5, 'INR', 'en-IN'), /1,234\.50/);
  assert.match(formatCurrency(1234.5, 'ARS', 'es-AR'), /1\.234,50/);
});
