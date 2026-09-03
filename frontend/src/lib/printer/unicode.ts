/**
 * unicode.ts
 *
 * Fallback map for Unicode currency symbols on ESC/POS thermal printers.
 *
 * ESC/POS thermal printers render bytes against a fixed code page
 * (typically CP437 / CP850 / CP1252), none of which contain modern
 * currency symbols like ₹ (U+20B9, added to Unicode in 2010). When the
 * printer firmware cannot render a symbol, the 2–3 UTF-8 bytes that
 * encode it print as garbage glyphs.
 *
 * Legacy callers that do not supply profile capabilities can request this
 * ASCII fallback with the non-Unicode option. Capability-aware encoders use
 * the shared policy to select a declared code page before falling back.
 */

import {
  GENERIC_THERMAL_CAPABILITIES,
  normalizeThermalText as normalizeThermalTextByCapabilities,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';

// Currency fallbacks are kept to two or three ASCII characters so receipt
// amount columns remain bounded for common symbols and ISO-style tokens.
export const CURRENCY_ASCII_MAP: Record<string, string> = {
  '₹': 'Rs', // Indian Rupee
  '₨': 'Rs', // Rupee sign
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'Yen',
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
  'ریال': 'IRR',
  '৳': 'BDT',
  'E£': 'EGP',
};

export function normalizeThermalText(text: string, capabilities: ThermalPrinterCapabilities = GENERIC_THERMAL_CAPABILITIES): string {
  return normalizeThermalTextByCapabilities(text, capabilities);
}

export function normalizeCurrencyToAscii(text: string): string {
  return Object.entries(CURRENCY_ASCII_MAP)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((value, [sym, ascii]) => value.split(sym).join(ascii), text);
}

/**
 * Pads a resolved currency symbol to a fixed 2-character slot when it is
 * shorter than two characters. Three-character fallbacks such as IRR remain
 * unchanged.
 */
export function padCurrencyPrefix(prefix: string): string {
  return prefix.length >= 2 ? prefix : ' '.repeat(2 - prefix.length) + prefix;
}
