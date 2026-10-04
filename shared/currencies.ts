export const POPULAR_CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD', 'JPY'] as const;

const RESERVED_CURRENCY_CODES = new Set(['XXX', 'XTS']);

export function listSupportedCurrencyCodes(): string[] {
  try {
    return Intl.supportedValuesOf('currency')
      .map((code) => code.toUpperCase())
      .filter((code) => /^[A-Z]{3}$/.test(code) && !RESERVED_CURRENCY_CODES.has(code));
  } catch {
    return [...POPULAR_CURRENCY_CODES];
  }
}

export function normalizeSupportedCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return listSupportedCurrencyCodes().includes(normalized) ? normalized : null;
}

export function isSupportedCurrencyCode(value: unknown): value is string {
  return normalizeSupportedCurrencyCode(value) !== null;
}

export function getCurrencyDisplayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) || code;
  } catch {
    return code;
  }
}
