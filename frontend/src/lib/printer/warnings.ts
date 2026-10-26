/** Shared logic to skip unsupported characters and preserve printing on ESC/POS encoders. */
import { createTranslator } from 'use-intl/core';
import { CURRENCY_ASCII_MAP, normalizeCurrencyToAscii, normalizeThermalText } from './unicode';
import {
  isArabicShapingSafeLine as isCapabilityArabicShapingSafeLine,
  isThermalTextRepresentable,
  mergeThermalCapabilities,
  selectThermalCodePage,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';
import { containsRtlScript } from '@print/direction';
import {
  encodeRasterUnits,
  rasterCapabilityEnabled,
  type RasterStyle,
  type RasterTextLayout,
} from '@print/raster';
import { paintRasterRequest, type RasterCanvas } from '@print/raster-canvas';
import type { PrintWarning } from '@print/warnings';
import { displayCellWidth, wrapToDisplayCells } from '@print/width';
import { getCachedMessages } from '@/lib/i18n/loader';
import { LANGUAGES } from '@/lib/i18n/languages';
import { usePosSettingsStore } from '@/store/pos-settings';

export type { PrintWarning } from '@print/warnings';

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
      try {
        selection = JSON.parse(trimmed);
      } catch {
        selection = trimmed;
      }
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

export { hasFinancialPrintWarning, makeFinancialPrintRefusalMessage } from '@print/warnings';

export function makeBillTemplateFallbackWarning(value: unknown): PrintWarning | null {
  if (billTemplateSource(value) === 'core') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    field: 'bill_template',
    text: text || 'unknown',
    message:
      'The selected bill template is not supported on this print path, so the built-in receipt layout was used.',
    kind: 'configuration',
  };
}

/** C0 controls and DEL must never reach raw ESC/POS output (#437 review). */
const ESCPOS_TEXT_CONTROL_RE = /[\x00-\x1F\x7F]/g;

type BrowserRasterCanvasFactory = (() => RasterCanvas) | null;
let customBrowserRasterCanvasFactory: BrowserRasterCanvasFactory | undefined;

export function setBrowserRasterCanvasFactory(
  factory: BrowserRasterCanvasFactory | undefined,
): void {
  customBrowserRasterCanvasFactory = factory;
}

function resolveBrowserRasterCanvasFactory(): BrowserRasterCanvasFactory {
  if (customBrowserRasterCanvasFactory !== undefined) return customBrowserRasterCanvasFactory;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const probe = document.createElement('canvas') as unknown as Partial<RasterCanvas> | null;
    if (probe && typeof probe.getContext === 'function') {
      return () => document.createElement('canvas') as unknown as RasterCanvas;
    }
  }
  const GlobalOffscreenCanvas = (
    globalThis as { OffscreenCanvas?: new (width: number, height: number) => RasterCanvas }
  ).OffscreenCanvas;
  if (typeof GlobalOffscreenCanvas === 'function') {
    return () => new GlobalOffscreenCanvas(1, 1);
  }
  return null;
}

function resolveFinancialRasterLayout(sanitized: string): RasterTextLayout | undefined {
  const multiSpaceMatch = sanitized.match(/^(\s*\S+(?:\s\S+)*?)\s{2,}(\S.*)$/);
  if (multiSpaceMatch) {
    return {
      kind: 'financial-summary',
      columns: [
        { text: multiSpaceMatch[1], align: 'left' },
        { text: multiSpaceMatch[2].trim(), align: 'right' },
      ],
    };
  }
  const singleSpaceAmountMatch = sanitized.match(/^(.*\S)\s+(\S*\d\S*)$/);
  if (singleSpaceAmountMatch) {
    return {
      kind: 'financial-summary',
      columns: [
        { text: singleSpaceAmountMatch[1], align: 'left' },
        { text: singleSpaceAmountMatch[2], align: 'right' },
      ],
    };
  }
  return undefined;
}

function boundShapedText(text: string, maxCols?: number): string {
  if (!maxCols || maxCols <= 0 || displayCellWidth(text) <= maxCols) return text;

  const ellipsis = '…';
  const targetCols = Math.max(0, maxCols - displayCellWidth(ellipsis));
  let bounded = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = displayCellWidth(character);
    if (width + characterWidth > targetCols) break;
    bounded += character;
    width += characterWidth;
  }
  return bounded + ellipsis;
}

/**
 * Rows of at most `maxCols` display cells. A shaped printer never wraps
 * its own raw bytes, so an over-wide line must become rows here or be cut.
 */
export function wrapPrinterText(text: string, maxCols: number): string[] {
  if (maxCols <= 0) return [text];
  return wrapToDisplayCells(text, maxCols);
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
  const hasNativeCodePage = thermalCapabilities.encoding.codePages.some(
    (codePage) => codePage !== 'ascii',
  );
  const printerValue = (
    !useLegacyUnicode && !hasNativeCodePage
      ? normalizeCurrencyToAscii(printableValue)
      : printableValue
  ).replace(/\u2026/g, useUnicode && arabicShaping ? '\u2026' : '.');
  const hasUnsupported = hasUnsupportedPrinterChars(printerValue);
  const shapingSafe =
    thermalCapabilities.shaping.arabic && isCapabilityArabicShapingSafeLine(printerValue);
  const representable =
    !hasUnsupported ||
    (isThermalTextRepresentable(printerValue, thermalCapabilities) && !shapingSafe);
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
        const centerRawLine =
          centerCols !== undefined && centerCols > 0 && typeof alignableEnc.align === 'function';
        if (centerRawLine) {
          const pad = Math.max(0, Math.floor((centerCols - displayCellWidth(payloadText)) / 2));
          payloadText = ' '.repeat(pad) + payloadText;
          alignableEnc.align?.('left');
        }
        try {
          return (enc as { raw: (data: Uint8Array) => T }).raw(
            new TextEncoder().encode(payloadText),
          );
        } finally {
          if (centerRawLine) alignableEnc.align?.('center');
        }
      }
      return enc.text(boundShapedText(sanitized, maxCols));
    }
    if (!representable) {
      const sanitized = value.replace(ESCPOS_TEXT_CONTROL_RE, '');
      const canvasFactory = resolveBrowserRasterCanvasFactory();
      if (
        sanitized &&
        rasterCapabilityEnabled(thermalCapabilities, 'mixed') &&
        canvasFactory &&
        'raw' in enc &&
        typeof (enc as { raw?: (data: Uint8Array) => T }).raw === 'function'
      ) {
        const align: 'left' | 'center' =
          centerCols !== undefined && centerCols > 0 ? 'center' : 'left';
        const styles: RasterStyle[] = isStoreName
          ? ['bold', 'double-height', 'double-width']
          : ['normal'];
        const layout = financial ? resolveFinancialRasterLayout(sanitized) : undefined;
        const rasterResult = paintRasterRequest(
          {
            version: 1,
            requestId: 'webusb-line',
            text: sanitized,
            widthDots: thermalCapabilities.raster.widthDots,
            maxBandHeight: thermalCapabilities.raster.maxBandHeight,
            direction: containsRtlScript(sanitized) ? 'rtl' : 'ltr',
            align,
            ...(layout ? { layout } : {}),
            style: styles[0],
            styles,
            financial,
            maxLines: 16,
            ...(thermalCapabilities.raster.font
              ? { bundledFont: thermalCapabilities.raster.font }
              : {}),
          },
          canvasFactory,
        );
        if (rasterResult.ok) {
          try {
            const rasterBytes = encodeRasterUnits([rasterResult.unit], thermalCapabilities);
            return (enc as { raw: (data: Uint8Array) => T }).raw(rasterBytes);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            warnings?.push({
              field: financial ? 'financial row' : isStoreName ? 'store name' : 'receipt line',
              text: value.trim(),
              message: `Raster rendering failed: ${detail}`,
              kind: financial ? 'financial' : 'line',
            });
            return enc;
          }
        }
        warnings?.push({
          field: financial ? 'financial row' : isStoreName ? 'store name' : 'receipt line',
          text: value.trim(),
          message: `Raster rendering failed (${rasterResult.code}): ${rasterResult.detail}`,
          kind: financial ? 'financial' : 'line',
        });
        return enc;
      }
      const warning = makePrintWarning(value, isStoreName);
      if (financial) warning.kind = 'financial';
      warnings?.push(warning);
      return enc;
    }
  }
  const codePage = selectThermalCodePage(printerValue, thermalCapabilities);
  if (
    thermalCapabilities.shaping.arabic &&
    !hasNativeCodePage &&
    'raw' in enc &&
    typeof (enc as { raw?: (data: Uint8Array) => T }).raw === 'function'
  ) {
    const sanitized = printerValue.replace(ESCPOS_TEXT_CONTROL_RE, '');
    return (enc as { raw: (data: Uint8Array) => T }).raw(new TextEncoder().encode(sanitized));
  }
  if (
    codePage &&
    codePage !== 'ascii' &&
    'codepage' in enc &&
    typeof (enc as { codepage?: (value: string) => T }).codepage === 'function'
  ) {
    (enc as { codepage: (value: string) => T }).codepage(codePage);
  }
  return enc.text(printerValue);
}

/** Extracts error string from an unknown error or API Axios response. */
export function extractPrinterErrorMessage(err: unknown): string {
  if (!err) return '';
  const maybeAxios = err as {
    response?: { data?: { detail?: unknown; error?: unknown } };
    message?: unknown;
  };
  const detail = maybeAxios.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  const error = maybeAxios.response?.data?.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  return typeof err === 'string' ? err.trim() : '';
}

/** Matches only the Windows PRINTER_ATTRIBUTE_WORK_OFFLINE message (main/printers/thermal.ts), not generic offline/disconnected statuses. */
const PRINTER_OFFLINE_DETAIL_RE = /\buse printer offline\b/i;

/** Translator bootstrap outside React, matching the pattern in warnings-toast.ts / kot-web-print.ts. */
function printerOfflineFixHint(): string {
  try {
    const lang = usePosSettingsStore.getState().language ?? 'en';
    const locale = LANGUAGES[lang]?.locale ?? 'en';
    const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? {};
    const t = createTranslator({ locale, messages }) as unknown as (key: string) => string;
    return t('printWarnings.printerOfflineHint');
  } catch {
    return "Printer isn't responding. Make sure it's powered on and connected, then check Windows: open the printer's queue and turn off \"Use Printer Offline\" if it's checked.";
  }
}

/** Formats a user-facing receipt print error message with operational detail when available. */
export function formatReceiptErrorToast(
  detail?: string,
  fallbackTranslation = 'Receipt print failed',
): string {
  const msg = String(detail || '').trim();
  if (PRINTER_OFFLINE_DETAIL_RE.test(msg)) return printerOfflineFixHint();
  if (msg.startsWith('Receipt not printed:')) return msg;
  if (msg && msg !== 'print failed' && msg !== 'Print failed') {
    return `${fallbackTranslation} (${msg})`;
  }
  return fallbackTranslation;
}

/** Formats a user-facing KOT print error message with operational detail when available. */
export function formatKotErrorToast(
  detail?: string,
  fallbackTranslation = 'KOT print failed',
): string {
  const msg = String(detail || '').trim();
  if (PRINTER_OFFLINE_DETAIL_RE.test(msg)) return printerOfflineFixHint();
  if (msg && msg !== 'print failed' && msg !== 'KOT print failed') {
    return `${fallbackTranslation}: ${msg}`;
  }
  return fallbackTranslation;
}
