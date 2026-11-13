/**
 * Shared ASCII currency fallback policy for thermal text paths.
 *
 * Financial values stay numeric and unchanged. This map only replaces a
 * display token when a native ESC/POS path cannot represent it.
 */

/** Currency display tokens that have stable, bounded ASCII fallbacks. */
export const CURRENCY_ASCII_MAP: Readonly<Record<string, string>> = Object.freeze({
  '₹': 'Rs',
  '₨': 'Rs',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'Yen',
  '\uFFE5': 'JPY',
  '₩': 'KRW',
  '₺': 'TRY',
  '₫': 'VND',
  '₪': 'ILS',
  '₽': 'RUB',
  '฿': 'THB',
  '₱': 'PHP',
  '₴': 'UAH',
  '₦': 'NGN',
  '₵': 'GHS',
  '₡': 'CRC',
  '₲': 'PYG',
  'د.إ': 'AED',
  '﷼': 'SAR',
  ریال: 'IRR',
  '৳': 'BDT',
  'E£': 'EGP',
  'L£': 'LBP',
  'GH₵': 'GHS',
  '₼': 'AZN',
  '₾': 'GEL',
  '₸': 'KZT',
  '₭': 'LAK',
  '₮': 'MNT',
  '៛': 'KHR',
  '֏': 'AMD',
  '؋': 'AFN',
  '⃀': 'KGS',
  'F\u202fCFA': 'XOF',
  'CN¥': 'CNY',
  '¥CN': 'CNY',
  'JP¥': 'JPY',
  'UK£': 'GBP',
  '£GB': 'GBP',
  '£E': 'EGP',
  '£L': 'LBP',
  '£LB': 'LBP',
  '£GI': 'GIP',
  '£FK': 'FKP',
  'FK£': 'FKP',
  'Fl£': 'FKP',
  'S£': 'SYP',
  'د.ب.': 'BHD',
  'د.ج.': 'DZD',
  'ج.م.': 'EGP',
  'د.ع.': 'IQD',
  'ر.إ.': 'IRR',
  'د.أ.': 'JOD',
  'د.ك.': 'KWD',
  'ل.ل.': 'LBP',
  'د.ل.': 'LYD',
  'د.م.': 'MAD',
  'أ.م.': 'MRU',
  'ر.ع.': 'OMR',
  'ر.ق.': 'QAR',
  'ر.س.': 'SAR',
  'ج.س.': 'SDG',
  'ل.س.': 'SYP',
  'د.ت.': 'TND',
  'ر.ي.': 'YER',
  'د.إ.': 'AED',
  'лв.': 'BGN',
  'ден.': 'MKD',
  'руб.': 'RUB',
  'රු.': 'LKR',
  ТМТ: 'TMT',
});

const CURRENCY_ASCII_ENTRIES = Object.entries(CURRENCY_ASCII_MAP).sort(
  ([left], [right]) => right.length - left.length,
);

/** Replace known non-ASCII currency tokens without changing numeric values. */
export function normalizeCurrencyToAscii(text: string): string {
  return CURRENCY_ASCII_ENTRIES.reduce(
    (value, [symbol, fallback]) => value.split(symbol).join(fallback),
    text,
  );
}

/** Regex source for matching known currency tokens in thermal safety checks. */
export const CURRENCY_TOKEN_PATTERN = CURRENCY_ASCII_ENTRIES.map(([symbol]) =>
  symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('|');

/** Canonical tenant currency storage contract. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function isSyntacticallyValidCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}
