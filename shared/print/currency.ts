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
  'ل.س': 'SYP',
  'د.ت.': 'TND',
  'ر.ي.': 'YER',
  'د.إ.': 'AED',
  'лв.': 'BGN',
  'ден.': 'MKD',
  'руб.': 'RUB',
  'сом.': 'TJS',
  'грн.': 'UAH',
  Íkr: 'ISK',
  'රු.': 'LKR',
  ТМТ: 'TMT',
});

const CURRENCY_ASCII_ENTRIES = Object.entries(CURRENCY_ASCII_MAP).sort(
  ([left], [right]) => right.length - left.length,
);

const STARTS_WITH_LETTER_RE = /^\p{L}/u;
const ENDS_WITH_LETTER_RE = /\p{L}$/u;

function currencyTokenPatternFor(symbol: string): string {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = STARTS_WITH_LETTER_RE.test(symbol) ? '(?<!\\p{L})' : '';
  const suffix = ENDS_WITH_LETTER_RE.test(symbol) ? '(?!\\p{L})' : '';
  return `${prefix}${escaped}${suffix}`;
}

/** Regex source for matching known currency tokens in thermal safety checks. */
export const CURRENCY_TOKEN_PATTERN = CURRENCY_ASCII_ENTRIES.map(([symbol]) =>
  currencyTokenPatternFor(symbol),
).join('|');

const CURRENCY_TOKEN_RE = new RegExp(`(?:${CURRENCY_TOKEN_PATTERN})`, 'gu');

/** Replace known non-ASCII currency tokens without changing numeric values. */
export function normalizeCurrencyToAscii(text: string): string {
  return text.replace(CURRENCY_TOKEN_RE, (token) => CURRENCY_ASCII_MAP[token] ?? token);
}

/** Strip known currency tokens before checking whether remaining text is printer-representable. */
export function stripCurrencyTokens(text: string): string {
  return text.replace(CURRENCY_TOKEN_RE, '');
}

const AMBIGUOUS_CURRENCY_ASCII_OWNER: Readonly<Record<string, string>> = Object.freeze({
  '¥': 'JPY',
  '\uFFE5': 'JPY',
  '£': 'GBP',
  '₩': 'KRW',
});

/** True when a shared glyph (¥, £, ₩) must fall back to the ISO code rather than its default owner. */
export function isAmbiguousCurrencySymbol(symbol: string, currencyCode?: string): boolean {
  const owner = AMBIGUOUS_CURRENCY_ASCII_OWNER[symbol];
  return Boolean(owner && currencyCode && currencyCode !== owner);
}

/** Resolve a currency symbol's ASCII fallback, preferring `currencyCode` when a symbol is shared. */
export function resolveAsciiCurrencyFallback(
  symbol: string,
  currencyCode?: string,
): string | undefined {
  if (isAmbiguousCurrencySymbol(symbol, currencyCode)) {
    return currencyCode;
  }
  return CURRENCY_ASCII_MAP[symbol];
}

/** Canonical tenant currency storage contract. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function isSyntacticallyValidCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}
