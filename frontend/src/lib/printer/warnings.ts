/**
 * warnings.ts
 *
 * Shared "skip unsupported characters, keep printing" logic for the browser
 * ESC/POS encoders (receipt-encoder.ts, kot-encoder.ts, tax-bill-encoder.ts).
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

const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const ARABIC_SCRIPT_GLOBAL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_SHAPING_ALLOWED_GLOBAL_RE = /[\u200C\u200D\u200F\u2026]/g;

export function hasArabicScript(text: string): boolean {
  return ARABIC_SCRIPT_RE.test(text);
}

/**
 * True when a line contains nothing but ASCII plus Arabic/Persian script, so
 * a printer whose firmware shapes Arabic can render it (#437). Mirrors the
 * backend buildEscPos arabic-only rule: any other non-ASCII script on the
 * same line still blocks it, even with shaping enabled.
 */
export function isArabicShapingSafeLine(text: string): boolean {
  if (!hasArabicScript(text)) return false;
  return !/[^\x00-\x7F]/.test(
    text.replace(SUPPORTED_CURRENCY_SYMBOLS, '')
      .replace(ARABIC_SCRIPT_GLOBAL_RE, '')
      .replace(ARABIC_SHAPING_ALLOWED_GLOBAL_RE, '')
  );
}

export function makePrintWarning(text: string, isStoreName = false): PrintWarning {
  const field = isStoreName ? 'store name' : 'receipt line';
  const label = isStoreName ? 'Store name' : 'Receipt line';
  const why = ARABIC_SCRIPT_RE.test(text)
    ? 'it contains Persian/Arabic script and the printer cannot shape it'
    : 'it contains unsupported characters';
  return { field, text, message: `${label} was not printed because ${why}: ${text}` };
}

/**
 * Writes `value` to an ESC/POS encoder only if a generic thermal printer can
 * render every character; otherwise records a warning and skips it entirely
 * so the rest of the receipt/ticket still prints and cuts normally.
 *
 * When `arabicShaping` is true (printer firmware shapes Arabic/Persian,
 * #437), pure ASCII+Arabic lines pass through instead of being skipped —
 * mirroring the desktop path's profile/request override.
 */
export function safePrinterText<T extends { text(value: string): T }>(
  enc: T,
  value: string,
  warnings: PrintWarning[] | undefined,
  isStoreName = false,
  arabicShaping = false
): T {
  if (!value) return enc;
  if (hasUnsupportedPrinterChars(value)) {
    if (arabicShaping && isArabicShapingSafeLine(value)) {
      return enc.text(value);
    }
    warnings?.push(makePrintWarning(value, isStoreName));
    return enc;
  }
  return enc.text(value);
}
