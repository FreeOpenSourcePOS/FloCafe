import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import { getCountries } from 'libphonenumber-js';
import {
  COUNTRIES,
  getCountryByCode,
  getCurrencyFractionDigits,
  isValidTimeZone,
  resolveRegionalSnapshot,
} from '../main/countries';
import { isSupportedCurrencyCode } from '../shared/currencies';
import { isSyntacticallyValidCurrencyCode } from '../shared/print/currency';
import { resolveActiveCurrencyDecimals } from '../frontend/src/lib/cart-price';
import { dialCodeFor } from '../frontend/src/lib/phone';

const moduleApi = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
};
const originalResolveFilename = moduleApi._resolveFilename;
let getLocalizedCountryName: (code: string, locale: string) => string;
try {
  moduleApi._resolveFilename = function (request, parent, isMain, options) {
    if (request === '@countries') {
      request = path.resolve(__dirname, '../main/countries');
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  ({ getLocalizedCountryName } = require('../frontend/src/lib/countries'));
} finally {
  moduleApi._resolveFilename = originalResolveFilename;
}

test('IR country profile properties', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir, 'IR country profile should exist');
  assert.equal(ir.code, 'IR');
  assert.equal(ir.locale, 'fa-IR');
  assert.equal(ir.currency, 'IRR');
  assert.equal(ir.timezone, 'Asia/Tehran');
  assert.equal(ir.dialCode, '+98');
  assert.equal(ir.taxIdLabel, 'Economic Code');
  assert.equal(ir.taxName, 'VAT');
  assert.equal(ir.taxIdFormat, undefined, 'No tax ID format should be enforced for IR');
});

test('SY country profile properties', () => {
  const sy = getCountryByCode('SY');
  assert.ok(sy, 'SY country profile should exist');
  assert.equal(sy.code, 'SY');
  assert.equal(sy.locale, 'ar-SY');
  assert.equal(sy.currency, 'SYP');
  assert.equal(sy.timezone, 'Asia/Damascus');
  assert.equal(sy.dialCode, '+963');
  assert.equal(getLocalizedCountryName('SY', 'en'), 'Syria');
});

test('SL, CW, and SX country profiles use current redenominated currencies', () => {
  const sl = getCountryByCode('SL');
  assert.ok(sl, 'SL country profile should exist');
  assert.equal(sl.currency, 'SLE');
  const slSnapshot = resolveRegionalSnapshot({ country: 'SL' });
  assert.equal(slSnapshot.currency, 'SLE');
  assert.equal(slSnapshot.currencyFractionDigits, 2);
  assert.ok(
    ['Le', 'SLE'].includes(slSnapshot.currencySymbol),
    `SL currency symbol resolves cleanly (${slSnapshot.currencySymbol})`,
  );

  const cw = getCountryByCode('CW');
  assert.ok(cw, 'CW country profile should exist');
  assert.equal(cw.currency, 'XCG');
  assert.equal(resolveRegionalSnapshot({ country: 'CW' }).currency, 'XCG');

  const sx = getCountryByCode('SX');
  assert.ok(sx, 'SX country profile should exist');
  assert.equal(sx.currency, 'XCG');
  assert.equal(resolveRegionalSnapshot({ country: 'SX' }).currency, 'XCG');
});

test('every country in COUNTRIES satisfies regional, currency, timezone, phone, and display invariants', () => {
  assert.equal(COUNTRIES[0]?.code, 'IN', 'IN remains pinned first');
  assert.equal(COUNTRIES[1]?.code, 'AR', 'AR remains pinned second');

  const seen = new Set<string>();
  const sampleDate = new Date('2026-06-15T12:00:00Z');
  const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });

  for (const c of COUNTRIES) {
    assert.ok(!seen.has(c.code), `duplicate country code ${c.code}`);
    seen.add(c.code);

    assert.match(c.code, /^[A-Z]{2}$/, `${c.code}: valid 2-letter uppercase ISO code`);
    assert.ok(c.locale.trim().length > 0, `${c.code}: non-empty locale`);
    assert.equal(
      new Intl.Locale(c.locale).toString(),
      c.locale,
      `${c.code}: canonical BCP-47 locale`,
    );
    assert.ok(
      sampleDate.toLocaleDateString(`${c.locale}-u-nu-latn`, { timeZone: c.timezone }).length > 0,
      `${c.code}: locale supports -u-nu-latn receipt date suffix`,
    );

    assert.ok(
      isSyntacticallyValidCurrencyCode(c.currency),
      `${c.code}: syntactically valid ISO 4217 currency (${c.currency})`,
    );
    assert.ok(
      isSupportedCurrencyCode(c.currency),
      `${c.code}: runtime-supported ISO 4217 currency (${c.currency})`,
    );
    const currencyDisplayName = currencyNames.of(c.currency) ?? c.currency;
    assert.doesNotMatch(
      currencyDisplayName,
      /\(\d{4}[—–-]\d{4}\)/,
      `${c.code}: currency ${c.currency} (${currencyDisplayName}) must not be a withdrawn historical currency`,
    );
    assert.ok(
      !['SLL', 'ANG'].includes(c.currency),
      `${c.code}: currency ${c.currency} must not be a withdrawn currency`,
    );
    assert.equal(
      resolveActiveCurrencyDecimals(c.code),
      getCurrencyFractionDigits(c.currency),
      `${c.code}: cart-price country decimal lookup matches ${c.currency}`,
    );
    assert.ok(isValidTimeZone(c.timezone), `${c.code}: valid IANA timezone (${c.timezone})`);

    assert.match(c.dialCode, /^\+\d+$/, `${c.code}: valid E.164 dial code (${c.dialCode})`);
    assert.equal(dialCodeFor(c.code), c.dialCode, `${c.code}: dialCode matches dialCodeFor()`);

    const enName = getLocalizedCountryName(c.code, 'en');
    assert.ok(
      enName.trim().length > 0 && enName !== c.code,
      `${c.code}: human-readable English display name (${enName})`,
    );

    const snapshot = resolveRegionalSnapshot({ country: c.code });
    assert.equal(snapshot.country, c.code, `${c.code}: snapshot country matches`);
    assert.ok(
      snapshot.currencySymbol.replace(/[\u200B-\u200F\uFEFF]/g, '').trim().length > 0,
      `${c.code}: snapshot currencySymbol is visible (${JSON.stringify(snapshot.currencySymbol)})`,
    );
  }
});

test('COUNTRIES covers 100% of libphonenumber-js getCountries()', () => {
  const catalogCodes = new Set(COUNTRIES.map((c) => c.code));
  const missing = getCountries().filter((code) => !catalogCodes.has(code));
  assert.deepEqual(
    missing,
    [],
    `missing ${missing.length} libphonenumber-js region codes: ${missing.join(', ')}`,
  );
});
