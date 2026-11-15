/**
 * Every supported currency must print on a plain ASCII thermal printer.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/currency-print-fallback.test.ts
 */
import { resolveCurrencyPrefix } from '../main/printers/formatting-helpers';
import { getCurrencySymbol, COUNTRIES } from '../main/countries';
import { listSupportedCurrencyCodes } from '../shared/currencies';
import { GENERIC_THERMAL_CAPABILITIES, LATIN_THERMAL_CAPABILITIES } from '../shared/print/thermal-capabilities';
import {
  normalizeCurrencyToAscii,
  resolveAsciiCurrencyFallback,
  stripCurrencyTokens,
} from '../shared/print/currency';

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
for (const code of ['SYP', 'SSP', 'GIP', 'FKP', 'SHP'] as const) {
  assertEqualOrThrow(
    resolveAsciiCurrencyFallback('£', code),
    code,
    `shared pound fallback preserves ${code}`,
  );
  assertEqualOrThrow(
    resolveCurrencyPrefix('£', false, GENERIC_THERMAL_CAPABILITIES, false, code).trim(),
    code,
    `generic thermal prefix preserves ${code} instead of GBP`,
  );
}
assertEqualOrThrow(
  resolveCurrencyPrefix('£', false, GENERIC_THERMAL_CAPABILITIES, false, 'GBP').trim(),
  'GBP',
  'GBP still resolves to GBP on generic thermal printer',
);
assertEqualOrThrow(
  resolveAsciiCurrencyFallback('₩', 'KPW'),
  'KPW',
  'shared won fallback preserves KPW',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('₩', false, LATIN_THERMAL_CAPABILITIES, false, 'KPW').trim(),
  'KPW',
  'Latin thermal prefix preserves KPW instead of KRW',
);
assertEqualOrThrow(
  resolveCurrencyPrefix('₩', false, GENERIC_THERMAL_CAPABILITIES, false, 'KRW').trim(),
  'KRW',
  'KRW still resolves to KRW on generic thermal printer',
);

const { passed, failed } = getResults();
console.log(`${passed} counted, ${failed} failed; all throwing checks passed`);
