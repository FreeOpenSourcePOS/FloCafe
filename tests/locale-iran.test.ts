import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatCurrencyForTenant,
  formatMoney,
  formatNumber,
  formatNumberForTenant,
  formatDateForTenant,
  getCountryByCode,
  getCurrencyUnitAdapter,
} from '../main/countries';

/**
 * Batch G (Refs #241) — Iran locale/number/currency/calendar policy.
 *
 * Storage contract: monetary values are stored as raw numbers in the tenant's
 * currency code (IRR for Iran) and are NEVER converted to Toman. Display uses
 * `Intl` with the tenant locale (`fa-IR`), which renders the Rial symbol
 * (`ریال`), Persian digits (arabext), and the Shamsi calendar by default, with
 * display-only configurability for Toman, Latin digits, and Gregorian calendar.
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

test('IR profile exposes locale display options (data-driven UI)', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir?.localeOptions, 'expected IR to declare localeOptions');
  assert.deepEqual(ir.localeOptions.currencyDisplay, ['rial', 'toman', 'toman_short']);
  assert.deepEqual(ir.localeOptions.digits, ['locale', 'latin']);
  assert.deepEqual(ir.localeOptions.calendar, ['locale', 'persian', 'gregorian']);
});

test('non-IR profiles expose no localeOptions (no Settings UI bloat)', () => {
  for (const code of ['IN', 'US', 'BR', 'AR', 'EG', 'TR', 'ZZ']) {
    const profile = getCountryByCode(code);
    if (profile) {
      assert.equal(
        profile.localeOptions,
        undefined,
        `expected no localeOptions for ${code}, got: ${JSON.stringify(profile.localeOptions)}`,
      );
    }
  }
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

test('formatMoney: IR Toman divides by 10 and suffixes تومان (display-only)', () => {
  const out = formatMoney(6000000, 'IRR', 'fa-IR', { currencyDisplay: 'toman' });
  assert.ok(out.includes('تومان'), `expected تومان, got: ${out}`);
  // 6,000,000 stored Rial → 600,000 displayed Toman (never a stored mutation).
  assert.equal(latinDigits(out), '600000');
});

test('formatMoney: IR Toman short uses Persian suffix by default', () => {
  const out = formatMoney(6000000, 'IRR', 'fa-IR', { currencyDisplay: 'toman_short' });
  assert.ok(out.endsWith('ت'), `expected Persian shorthand suffix, got: ${out}`);
  assert.ok(!out.includes('تومان'), `expected no تومان word, got: ${out}`);
  assert.equal(latinDigits(out), '600000');
});

test('formatMoney: IR Toman short uses Latin suffix with Latin digits', () => {
  const out = formatMoney(6000000, 'IRR', 'fa-IR', { currencyDisplay: 'toman_short', digits: 'latin' });
  assert.equal(out, '600,000T');
});

test('formatMoney: IR Rial mode with Latin digits keeps the Rial label', () => {
  const out = formatMoney(6000000, 'IRR', 'fa-IR', { digits: 'latin' });
  assert.ok(out.includes('ریال'), `expected ریال, got: ${out}`);
  assert.match(out, /6,000,000/);
});

test('formatMoney: non-IRR currencies ignore currencyDisplay preferences', () => {
  assert.equal(formatMoney(1234.5, 'USD', 'en-US', { currencyDisplay: 'toman' }), '$1,234.50');
  const ars = formatMoney(1234.5, 'ARS', 'es-AR', { currencyDisplay: 'toman_short' });
  assert.match(ars, /1\.234,50/);
  assert.ok(!ars.includes('ت') && !ars.includes('تومان'), `expected no Toman token, got: ${ars}`);
});

test('formatNumberForTenant: IR Latin digits', () => {
  assert.equal(formatNumberForTenant(1234, 'IR', { digits: 'latin' }), '1,234');
  assert.equal(formatNumberForTenant(1234, 'IR'), formatNumberForTenant(1234, 'IR', { digits: 'locale' }));
});

test('formatDateForTenant: IR Gregorian calendar', () => {
  const date = new Date(Date.UTC(2026, 7, 17, 12, 30, 0));
  const out = formatDateForTenant(date, 'IR', 'Asia/Tehran', { calendar: 'gregorian' }, { year: 'numeric', month: 'short', day: 'numeric' });
  assert.ok(out.includes('۲۰۲۶'), `expected Gregorian year 2026, got: ${out}`);
});

test('formatDateForTenant: IR Persian calendar with Latin digits', () => {
  const date = new Date(Date.UTC(2026, 7, 17, 12, 30, 0));
  const out = formatDateForTenant(date, 'IR', 'Asia/Tehran', { calendar: 'persian', digits: 'latin' }, { year: 'numeric', month: 'short', day: 'numeric' });
  assert.ok(out.includes('1405'), `expected Shamsi year 1405, got: ${out}`);
  assert.ok(out.includes('مرداد'), `expected Mordad month, got: ${out}`);
});

test('formatDateForTenant: locale defaults remain tenant-authoritative under a UI locale override', () => {
  const date = new Date(Date.UTC(2026, 7, 17, 12, 30, 0));
  const out = formatDateForTenant(
    date,
    'IR',
    'Asia/Tehran',
    { calendar: 'locale', digits: 'locale' },
    { year: 'numeric', month: 'short', day: 'numeric' },
    'en-US',
  );
  assert.ok(out.includes('مرداد') || out.includes('Mordad'), `expected tenant Persian calendar month, got: ${out}`);
  assert.ok(!out.includes('2026'), `expected tenant Persian calendar year, got: ${out}`);
  assert.match(out, /[۰-۹]/, `expected tenant Persian digits, got: ${out}`);
});

test('formatDateForTenant: non-Iran tenants stay Gregorian', () => {
  const date = new Date(Date.UTC(2026, 7, 17, 12, 30, 0));
  const out = formatDateForTenant(date, 'IN', 'Asia/Kolkata', {}, { year: 'numeric', month: 'short', day: 'numeric' });
  assert.ok(out.includes('2026'), `expected Gregorian year 2026, got: ${out}`);
});

test('formatDateForTenant: UI locale override decouples display language from tenant country', () => {
  const date = new Date(Date.UTC(2026, 7, 20, 15, 30, 0));
  // Argentina store (America/Argentina/Buenos_Aires) with English UI
  const enOut = formatDateForTenant(
    date,
    'AR',
    'America/Argentina/Buenos_Aires',
    {},
    { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    'en-US',
  );
  assert.ok(enOut.includes('Aug') || enOut.includes('August'), `expected English month in en-US output, got: ${enOut}`);
  assert.ok(enOut.includes('PM') || enOut.includes('pm'), `expected English 12-hour period in en-US output, got: ${enOut}`);
  assert.ok(!enOut.includes('de ago'), `unexpected Spanish preposition in en-US output: ${enOut}`);

  // Argentina store with Spanish UI
  const esOut = formatDateForTenant(
    date,
    'AR',
    'America/Argentina/Buenos_Aires',
    {},
    { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    'es-AR',
  );
  assert.ok(esOut.includes('ago'), `expected Spanish month in es-AR output, got: ${esOut}`);
});

test('getCurrencyUnitAdapter: IR with toman display scales amounts and labels correctly', () => {
  const adapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
  assert.equal(adapter.scale, 0.1);
  assert.equal(adapter.label, 'تومان');
  assert.equal(adapter.step, '0.001');
  assert.equal(adapter.maxDecimals, 3);
  assert.equal(adapter.toDisplay(6000000), 600000);
  assert.equal(adapter.toStored(600000), 6000000);
  assert.equal(adapter.formatInput(600000), '600000');
  assert.equal(adapter.formatInput(12.3456), '12.346');
});

test('getCurrencyUnitAdapter: IR with toman_short latin and locale digits', () => {
  const latinAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman_short', digits: 'latin' });
  assert.equal(latinAdapter.label, 'T');
  assert.equal(latinAdapter.scale, 0.1);

  const localeAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman_short', digits: 'locale' });
  assert.equal(localeAdapter.label, 'ت');
  assert.equal(localeAdapter.scale, 0.1);
});

test('getCurrencyUnitAdapter: IR with rial display keeps 1:1 scale and IRR label', () => {
  const adapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'rial' });
  assert.equal(adapter.scale, 1);
  assert.equal(adapter.label, 'IRR');
  assert.equal(adapter.step, '0.01');
  assert.equal(adapter.maxDecimals, 2);
  assert.equal(adapter.toDisplay(6000000), 6000000);
  assert.equal(adapter.toStored(6000000), 6000000);
});

test('getCurrencyUnitAdapter: non-IR currencies default to 1:1 scale', () => {
  const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
  assert.equal(usdAdapter.scale, 1);
  assert.equal(usdAdapter.label, 'USD');
  assert.equal(usdAdapter.step, '0.01');
  assert.equal(usdAdapter.toDisplay(12.34), 12.34);
  assert.equal(usdAdapter.toStored(12.34), 12.34);
  assert.equal(usdAdapter.formatInput(12.34), '12.34');

  const inrAdapter = getCurrencyUnitAdapter('INR', 'IN');
  assert.equal(inrAdapter.scale, 1);
  assert.equal(inrAdapter.label, 'INR');
  assert.equal(inrAdapter.step, '0.01');
  assert.equal(inrAdapter.toDisplay(500), 500);
  assert.equal(inrAdapter.toStored(500), 500);
});
