/**
 * Every supported currency must print on a plain ASCII thermal printer.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/currency-print-fallback.test.ts
 */
import { resolveCurrencyPrefix } from '../main/printers/formatting-helpers';
import { getCurrencySymbol, COUNTRIES } from '../main/countries';
import { listSupportedCurrencyCodes } from '../shared/currencies';
import { GENERIC_THERMAL_CAPABILITIES } from '../shared/print/thermal-capabilities';
import { normalizeCurrencyToAscii } from '../shared/print/currency';

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');

const ASCII = /^[\x00-\x7F]+$/;
const locales = [...new Set(COUNTRIES.map((c) => c.locale)), 'en-US'];
const currencies = listSupportedCurrencyCodes();

console.log(`Currency print fallback: ${currencies.length} currencies x ${locales.length} locales`);

const failures: string[] = [];
for (const code of currencies) {
  for (const locale of locales) {
    const symbol = getCurrencySymbol(code, locale);
    for (const [label, prefix] of [
      ['plain', resolveCurrencyPrefix(symbol, false, undefined, false, code)],
      [
        'generic-caps',
        resolveCurrencyPrefix(symbol, false, GENERIC_THERMAL_CAPABILITIES, false, code),
      ],
    ] as const) {
      if (!ASCII.test(prefix))
        failures.push(`${code}/${locale}/${label}: ${JSON.stringify(prefix)}`);
    }
    if (!ASCII.test(normalizeCurrencyToAscii(symbol)) && !ASCII.test(code))
      failures.push(`${code}: bad code`);
  }
}
assertEqualOrThrow(
  failures.slice(0, 10).join('; '),
  '',
  'every currency x locale resolves to an ASCII prefix',
);

assertEqualOrThrow(
  resolveCurrencyPrefix('₼', false, undefined, false, 'AZN').trim(),
  'AZN',
  'AZN with code',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('₼', false).trim().length > 0 &&
    ASCII.test(resolveCurrencyPrefix('₼', false)),
  true,
  'AZN without code is still ASCII',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('￥', false, undefined, false, 'JPY').trim(),
  'JPY',
  'JPY fullwidth yen',
);
assertOrThrow(
  ASCII.test(resolveCurrencyPrefix('\u{1F4B0}', false, undefined, false, 'XYZ')),
  'unknown symbol falls back to ISO code',
);

// Non-sterling pound currencies and SYP Arabic symbol thermal fallback
assertEqualOrThrow(
  resolveCurrencyPrefix(getCurrencySymbol('SYP', 'ar-SY'), false, undefined, false, 'SYP').trim(),
  'SYP',
  'SYP in ar-SY resolves to ASCII SYP on non-Unicode thermal printers',
);
assertEqualOrThrow(
  resolveCurrencyPrefix(getCurrencySymbol('SYP', 'en-US'), false, undefined, false, 'SYP').trim(),
  'SYP',
  'SYP in en-US resolves to ASCII SYP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('ل.س.', true, undefined, false, 'SYP').trim(),
  'ل.س.',
  'SYP preserves Arabic symbol on Unicode thermal printers',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('ل.س', false, undefined, false, 'SYP').trim(),
  'SYP',
  'SYP Arabic symbol without trailing period falls back to SYP',
);
assertEqualOrThrow(
  normalizeCurrencyToAscii('١٬٥٠٠ ل.س.'),
  '١٬٥٠٠ SYP',
  'normalizeCurrencyToAscii maps ل.س. to SYP',
);
assertEqualOrThrow(
  normalizeCurrencyToAscii('1500 ل.س'),
  '1500 SYP',
  'normalizeCurrencyToAscii maps ل.س without period to SYP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('£', false, undefined, false, 'SYP').trim(),
  'SYP',
  'bare £ with SYP currency code falls back to SYP instead of GBP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('£', false, undefined, false, 'SSP').trim(),
  'SSP',
  'bare £ with SSP currency code falls back to SSP instead of GBP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('£', false, undefined, false, 'FKP').trim(),
  'FKP',
  'bare £ with FKP currency code falls back to FKP instead of GBP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('£', false, undefined, false, 'GBP').trim(),
  'GBP',
  'bare £ with GBP currency code still falls back to GBP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix(getCurrencySymbol('SSP', 'ar-SY'), false, undefined, false, 'SSP').trim(),
  'SSP',
  'SSP in ar-SY resolves to ASCII SSP',
);
assertEqualOrThrow(
  resolveCurrencyPrefix(getCurrencySymbol('SSP', 'en-US'), false, undefined, false, 'SSP').trim(),
  'SSP',
  'SSP in en-US resolves to ASCII SSP',
);

const { passed, failed } = getResults();
console.log(`${passed} counted, ${failed} failed; all throwing checks passed`);
