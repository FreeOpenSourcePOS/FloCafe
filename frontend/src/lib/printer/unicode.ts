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

export { CURRENCY_ASCII_MAP, normalizeCurrencyToAscii } from '@print/currency';

export function normalizeThermalText(text: string, capabilities: ThermalPrinterCapabilities = GENERIC_THERMAL_CAPABILITIES): string {
  return normalizeThermalTextByCapabilities(text, capabilities);
}

/**
 * Pads a resolved currency symbol to a fixed 2-character slot when it is
 * shorter than two characters. Three-character fallbacks such as IRR remain
 * unchanged.
 */
export function padCurrencyPrefix(prefix: string): string {
  return prefix.length >= 2 ? prefix : ' '.repeat(2 - prefix.length) + prefix;
}
