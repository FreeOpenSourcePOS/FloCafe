import { canonicalizeLocalizedAmount } from '@countries';

export type CurrencyAmountTarget = 'payment' | 'wallet' | 'discount';
export type CurrencyDiscountType = 'percentage' | 'amount';

export interface AmountFormat {
  /** BCP-47 locale tag (e.g. 'en-IN') — grouping is derived from this via Intl, never assumed to be 3-digit Western groups. */
  locale: string;
  decimalSeparator: string;
  groupSeparator: string;
  currencyFractionDigits: number;
}

/** Keeps only digits and, when the currency has fraction digits, a single decimal separator with at most
 * currencyFractionDigits digits after it — as the user types. */
export function sanitizeAmountKeystrokes(raw: string, format: AmountFormat): string {
  const allowDecimal = format.currencyFractionDigits > 0;
  let out = '';
  let seenDecimal = false;
  let fractionDigits = 0;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      if (seenDecimal) {
        if (fractionDigits >= format.currencyFractionDigits) continue;
        fractionDigits++;
      }
      out += ch;
      continue;
    }
    if (allowDecimal && !seenDecimal && ch === format.decimalSeparator) {
      out += ch;
      seenDecimal = true;
    }
  }
  return out;
}

/** Groups a sanitized amount's integer part per the locale's own grouping pattern (via Intl — en-IN's
 * 2-3-3 groups, not just Western 3s), for live display as typed. */
export function groupAmountForDisplay(sanitized: string, format: AmountFormat): string {
  const [intPart, ...rest] = sanitized.split(format.decimalSeparator);
  if (!format.groupSeparator || !intPart) return sanitized;
  let grouped: string;
  try {
    grouped = new Intl.NumberFormat(format.locale, { useGrouping: true, numberingSystem: 'latn' }).format(BigInt(intPart));
  } catch {
    grouped = intPart;
  }
  return rest.length ? `${grouped}${format.decimalSeparator}${rest.join(format.decimalSeparator)}` : grouped;
}

/** Parses a grouped, locale-separated display string back into a plain number, or null when empty/invalid. */
export function parseAmountInput(display: string, format: AmountFormat): number | null {
  const canonical = canonicalizeLocalizedAmount(display, { ...format, currencySymbol: '' });
  if (canonical === null) return null;
  const value = Number(canonical);
  return Number.isFinite(value) ? value : null;
}

/** Formats a plain number as the grouped, locale-separated string a CurrencyAmountInput should display. */
export function formatAmountForDisplay(value: number, format: AmountFormat): string {
  const fixed = value.toFixed(format.currencyFractionDigits);
  const localized = format.decimalSeparator === '.' ? fixed : fixed.replace('.', format.decimalSeparator);
  return groupAmountForDisplay(localized, format);
}

export function getDiscountInputStep(maxDecimals: number, discountType: CurrencyDiscountType): string {
  return discountType === 'percentage' || maxDecimals === 0 ? '1' : '0.01';
}

export function normalizeFixedDiscountValue(value: number, maxDecimals: number): number {
  return roundCurrencyValue(value, maxDecimals === 0 ? 0 : 2);
}

export function roundCurrencyValue(value: number, maxDecimals: number): number {
  const decimals = Math.max(0, maxDecimals);
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(value));
  const adjustedValue = value < 0 ? value - epsilon : value + epsilon;
  return Number(adjustedValue.toFixed(decimals));
}

export function allowCurrencyDecimalKey(
  maxDecimals: number,
  amountTarget: CurrencyAmountTarget,
  discountType: CurrencyDiscountType,
): boolean {
  return (amountTarget === 'discount' && discountType === 'percentage') || maxDecimals > 0;
}
