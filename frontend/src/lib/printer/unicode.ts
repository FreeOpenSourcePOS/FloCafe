/** Fallback map and normalizer for Unicode currency symbols on ESC/POS thermal printers. */
import {
  GENERIC_THERMAL_CAPABILITIES,
  normalizeThermalText as normalizeThermalTextByCapabilities,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';

export { CURRENCY_ASCII_MAP, normalizeCurrencyToAscii } from '@print/currency';

export function normalizeThermalText(text: string, capabilities: ThermalPrinterCapabilities = GENERIC_THERMAL_CAPABILITIES): string {
  return normalizeThermalTextByCapabilities(text, capabilities);
}

/** Pads a resolved currency symbol to a fixed 2-character slot when shorter than 2 chars. */
export function padCurrencyPrefix(prefix: string): string {
  return prefix.length >= 2 ? prefix : ' '.repeat(2 - prefix.length) + prefix;
}
