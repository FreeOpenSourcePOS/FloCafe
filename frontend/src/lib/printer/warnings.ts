/** Shared logic to skip unsupported characters and preserve printing on ESC/POS encoders. */
import { CURRENCY_ASCII_MAP, normalizeCurrencyToAscii, normalizeThermalText } from './unicode';
import {
  isArabicShapingSafeLine as isCapabilityArabicShapingSafeLine,
  isThermalTextRepresentable,
  mergeThermalCapabilities,
  selectThermalCodePage,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';

export interface PrintWarning {
  field: string;
  text: string;
  message: string;
  kind?: 'line' | 'financial' | 'configuration' | 'locale';
}

const SUPPORTED_CURRENCY_SYMBOLS = new RegExp(
  Object.keys(CURRENCY_ASCII_MAP)
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

export function hasUnsupportedPrinterChars(text: string): boolean {
  return /[^\x00-\x7F]/.test(text.replace(SUPPORTED_CURRENCY_SYMBOLS, ''));
}

const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function hasArabicScript(text: string): boolean {
  return ARABIC_SCRIPT_RE.test(text);
}

/** True when a line contains only ASCII plus Arabic/Persian script for shaping printers. */
export const isArabicShapingSafeLine = isCapabilityArabicShapingSafeLine;

export function makePrintWarning(text: string, isStoreName = false): PrintWarning {
  const field = isStoreName ? 'store name' : 'receipt line';
  const label = isStoreName ? 'Store name' : 'Receipt line';
  const why = ARABIC_SCRIPT_RE.test(text)
    ? 'it contains Persian/Arabic script and the printer cannot shape it'
    : 'it contains unsupported characters';
  return { field, text, message: `${label} was not printed because ${why}: ${text}`, kind: 'line' };
}

function billTemplateSource(value: unknown): 'core' | 'non-core' {
  let selection: unknown = value;
  if (typeof selection === 'string') {
    const trimmed = selection.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { selection = JSON.parse(trimmed); } catch { selection = trimmed; }
    } else {
      selection = trimmed.toLowerCase();
    }
  }
  if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
    const source = (selection as { source?: unknown }).source;
    return source === 'core' ? 'core' : 'non-core';
  }
  return selection === 'classic' || selection === 'compact' ? 'core' : 'non-core';
}

export function hasFinancialPrintWarning(warnings: readonly PrintWarning[]): boolean {
  return warnings.some((warning) => warning.kind === 'financial');
}

export function makeFinancialPrintRefusalMessage(warnings: readonly PrintWarning[]): string {
  const row = warnings.find((warning) => warning.kind === 'financial');
  return `Receipt not printed: a financial row contains unsupported printer text${row?.text ? `: ${row.text}` : '.'} Use a supported printer profile or system/browser printing.`;
}

export function makeBillTemplateFallbackWarning(value: unknown): PrintWarning | null {
  if (billTemplateSource(value) === 'core') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    field: 'bill_template',
    text: text || 'unknown',
    message: 'The selected bill template is not supported on this print path, so the built-in receipt layout was used.',
    kind: 'configuration',
  };
}

/** C0 controls and DEL must never reach raw ESC/POS output (#437 review). */
const ESCPOS_TEXT_CONTROL_RE = /[\x00-\x1F\x7F]/g;
/** Arabic combining marks and bidi/format controls consume no print column. */
const SHAPING_ZERO_WIDTH_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u200B-\u200F]/g;

function shapedDisplayWidth(text: string): number {
  return [...text.replace(SHAPING_ZERO_WIDTH_RE, '')].length;
}

function boundShapedText(text: string, maxCols?: number): string {
  if (!maxCols || maxCols <= 0 || shapedDisplayWidth(text) <= maxCols) return text;

  const ellipsis = '…';
  const targetCols = Math.max(0, maxCols - shapedDisplayWidth(ellipsis));
  let bounded = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = shapedDisplayWidth(character);
    if (width + characterWidth > targetCols) break;
    bounded += character;
    width += characterWidth;
  }
  return bounded + ellipsis;
}

/** Writes value to an encoder if characters are representable, recording a warning otherwise. */
export function safePrinterText<T extends { text(value: string): T }>(
  enc: T,
  value: string,
  warnings: PrintWarning[] | undefined,
  isStoreName = false,
  arabicShaping = false,
  centerCols?: number,
  maxCols?: number,
  language?: string,
  financial = false,
  useUnicode = true,
  capabilities?: ThermalPrinterCapabilities,
): T {
  if (!value) return enc;
  const thermalCapabilities = mergeThermalCapabilities(capabilities, arabicShaping);
  const useLegacyUnicode = capabilities === undefined && useUnicode;
  const printableValue = normalizeThermalText(value, thermalCapabilities);
  const hasNativeCodePage = thermalCapabilities.encoding.codePages.some((codePage) => codePage !== 'ascii');
  const printerValue = !useLegacyUnicode && !hasNativeCodePage
    ? normalizeCurrencyToAscii(printableValue)
    : printableValue;
  const hasUnsupported = hasUnsupportedPrinterChars(printerValue);
  const shapingSafe = thermalCapabilities.shaping.arabic && isCapabilityArabicShapingSafeLine(printerValue);
  const representable = !hasUnsupported || (isThermalTextRepresentable(printerValue, thermalCapabilities) && !shapingSafe);
  if (hasUnsupported) {
    if (shapingSafe) {
      const sanitized = printerValue.replace(ESCPOS_TEXT_CONTROL_RE, '');
      if (!sanitized) {
        const warning = makePrintWarning(value, isStoreName);
        if (financial) warning.kind = 'financial';
        warnings?.push(warning);
        return enc;
      }
      if ('raw' in enc && typeof (enc as { raw?: (data: Uint8Array) => T }).raw === 'function') {
        let payloadText = boundShapedText(sanitized, maxCols ?? centerCols);
        const alignableEnc = enc as T & { align?: (alignment: 'left' | 'center') => T };
        const centerRawLine = centerCols !== undefined && centerCols > 0 && typeof alignableEnc.align === 'function';
        if (centerRawLine) {
          const pad = Math.max(0, Math.floor((centerCols - shapedDisplayWidth(payloadText)) / 2));
          payloadText = ' '.repeat(pad) + payloadText;
          alignableEnc.align?.('left');
        }
        try {
          return (enc as { raw: (data: Uint8Array) => T }).raw(new TextEncoder().encode(payloadText));
        } finally {
          if (centerRawLine) alignableEnc.align?.('center');
        }
      }
      return enc.text(boundShapedText(sanitized, maxCols));
    }
    if (!representable) {
      const warning = makePrintWarning(value, isStoreName);
      if (financial) warning.kind = 'financial';
      warnings?.push(warning);
      return enc;
    }
  }
  const codePage = selectThermalCodePage(printerValue, thermalCapabilities);
  if (
    thermalCapabilities.shaping.arabic
    && !hasNativeCodePage
    && 'raw' in enc
    && typeof (enc as { raw?: (data: Uint8Array) => T }).raw === 'function'
  ) {
    const sanitized = printerValue.replace(ESCPOS_TEXT_CONTROL_RE, '');
    return (enc as { raw: (data: Uint8Array) => T }).raw(new TextEncoder().encode(sanitized));
  }
  if (codePage && codePage !== 'ascii' && 'codepage' in enc && typeof (enc as { codepage?: (value: string) => T }).codepage === 'function') {
    (enc as { codepage: (value: string) => T }).codepage(codePage);
  }
  return enc.text(printerValue);
}

/** Extracts error string from an unknown error or API Axios response. */
export function extractPrinterErrorMessage(err: unknown): string {
  if (!err) return '';
  const maybeAxios = err as { response?: { data?: { detail?: unknown; error?: unknown } }; message?: unknown };
  const detail = maybeAxios.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  const error = maybeAxios.response?.data?.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  return typeof err === 'string' ? err.trim() : '';
}

/** Formats a user-facing receipt print error message with operational detail when available. */
export function formatReceiptErrorToast(detail?: string, fallbackTranslation = 'Receipt print failed'): string {
  const msg = String(detail || '').trim();
  if (msg.startsWith('Receipt not printed:')) return msg;
  if (msg && msg !== 'print failed' && msg !== 'Print failed') {
    return `${fallbackTranslation} (${msg})`;
  }
  return fallbackTranslation;
}

/** Formats a user-facing KOT print error message with operational detail when available. */
export function formatKotErrorToast(detail?: string, fallbackTranslation = 'KOT print failed'): string {
  const msg = String(detail || '').trim();
  if (msg && msg !== 'print failed' && msg !== 'KOT print failed') {
    return `${fallbackTranslation}: ${msg}`;
  }
  return fallbackTranslation;
}

