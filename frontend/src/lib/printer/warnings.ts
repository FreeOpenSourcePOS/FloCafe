/**
 * warnings.ts
 *
 * Shared "skip unsupported characters, keep printing" logic for the browser
 * ESC/POS encoders (receipt-encoder.ts, kot-encoder.ts, gst-bill-encoder.ts).
 * Mirrors the equivalent check in the desktop path (main/printers/thermal.ts)
 * so both printing paths degrade the same way: a line with characters a
 * generic thermal printer can't render (Arabic, CJK, emoji, etc.) is skipped
 * rather than sent as garbage bytes, and the caller is told which line and
 * why.
 */

import { CURRENCY_ASCII_MAP } from './unicode';

export interface PrintWarning {
  field: string;
  text: string;
  message: string;
}

const SUPPORTED_CURRENCY_SYMBOLS = new RegExp(`[${Object.keys(CURRENCY_ASCII_MAP).join('')}]`, 'g');

export function hasUnsupportedPrinterChars(text: string): boolean {
  return /[^\x00-\x7F]/.test(text.replace(SUPPORTED_CURRENCY_SYMBOLS, ''));
}

export function makePrintWarning(text: string, isStoreName = false): PrintWarning {
  const field = isStoreName ? 'store name' : 'receipt line';
  const label = isStoreName ? 'Store name' : 'Receipt line';
  return { field, text, message: `${label} was not printed because it contains unsupported characters: ${text}` };
}

/**
 * Writes `value` to an ESC/POS encoder only if a generic thermal printer can
 * render every character; otherwise records a warning and skips it entirely
 * so the rest of the receipt/ticket still prints and cuts normally.
 */
export function safePrinterText<T extends { text(value: string): T }>(
  enc: T,
  value: string,
  warnings: PrintWarning[] | undefined,
  isStoreName = false
): T {
  if (!value) return enc;
  if (hasUnsupportedPrinterChars(value)) {
    warnings?.push(makePrintWarning(value, isStoreName));
    return enc;
  }
  return enc.text(value);
}
