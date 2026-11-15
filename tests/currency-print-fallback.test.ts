/**
 * Every supported currency must print on a plain ASCII thermal printer.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/currency-print-fallback.test.ts
 */
import { resolveCurrencyPrefix } from '../main/printers/formatting-helpers';
import { getCurrencySymbol, COUNTRIES } from '../main/countries';
import { listSupportedCurrencyCodes } from '../shared/currencies';
import { GENERIC_THERMAL_CAPABILITIES } from '../shared/print/thermal-capabilities';
import { normalizeCurrencyToAscii, stripCurrencyTokens } from '../shared/print/currency';

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
assertEqualOrThrow(normalizeCurrencyToAscii('сом.'), 'TJS', 'Tajikistani somoni Cyrillic symbol');
assertEqualOrThrow(normalizeCurrencyToAscii('100 сом.'), '100 TJS', 'Tajikistani somoni price line');
assertEqualOrThrow(normalizeCurrencyToAscii('Íkr'), 'ISK', 'Icelandic krona Belarusian symbol');
assertEqualOrThrow(normalizeCurrencyToAscii('грн.'), 'UAH', 'Ukrainian hryvnia Cyrillic symbol');
assertEqualOrThrow(
  resolveCurrencyPrefix('р.', false, undefined, false, 'BYN').trim(),
  'BYN',
  'Belarusian ruble symbol falls back to BYN via currency code',
);
for (const cyrillicText of ['Сахар.', 'Товар.', 'стр.', 'пр.', '100 р.', 'соусом.', 'рисом.']) {
  assertEqualOrThrow(
    normalizeCurrencyToAscii(cyrillicText),
    cyrillicText,
    `Cyrillic text not corrupted by currency normalization: ${cyrillicText}`,
  );
  assertEqualOrThrow(
    stripCurrencyTokens(cyrillicText),
    cyrillicText,
    `Cyrillic text not stripped by currency token matcher: ${cyrillicText}`,
  );
}
assertEqualOrThrow(
  stripCurrencyTokens('100 сом.'),
  '100 ',
  'standalone Tajikistani somoni token is recognized as currency',
);

const { passed, failed } = getResults();
console.log(`${passed} counted, ${failed} failed; all throwing checks passed`);
