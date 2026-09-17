/** Thermal receipt formatting helpers and ESC/POS builder. Pure leaf module with no dependencies on document formatters. */

import CodepageEncoder from '@point-of-sale/codepage-encoder';
import { CURRENCY_ASCII_MAP, normalizeCurrencyToAscii } from '../../shared/print/currency';
import { fitThermalLine, wrapToDisplayCells } from '../../shared/print/width';
import {
  escPosCodePageId,
  GENERIC_THERMAL_CAPABILITIES,
  isThermalTextRepresentable,
  mergeThermalCapabilities,
  normalizeThermalText as normalizeThermalTextByCapabilities,
  selectThermalCodePage,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';
import {
  thermalDisplayWidth,
  type PrintWarning,
} from '../../shared/print';
import {
  encodeRasterUnits,
  rasterCapabilityEnabled,
  type RasterSemanticUnit,
} from '../../shared/print/raster';
import { isGeneratedPrintLanguage } from '../print/print-labels.generated';
import type { PrinterCutMode } from './profiles';

export type { PrintWarning };

const RECEIPT_BRANDING = 'Powered by FloPOS (flopos.com)';

const CURRENCY_TOKEN_RE = new RegExp(
  Object.keys(CURRENCY_ASCII_MAP)
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

const ESC_POS_CONTROL_TOKEN_RE = /\{\/?(?:CENTER|BOLD|DOUBLE_HEIGHT|DOUBLE_WIDTH|FONT_B)\}|\{(?:CUT|FEED|INIT|STORE_NAME|FINANCIAL)\}/g;
const ARABIC_SCRIPT_GLOBAL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_SHAPING_ALLOWED_GLOBAL_RE = /[\u200C\u200D\u200F\u2026]/g;
const ESCPOS_TEXT_CONTROL_RE = /[\x00-\x1F\x7F]/g;

function hasArabicScript(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

function makeUnsupportedLineWarning(isStoreName: boolean, text: string): string {
  const label = isStoreName ? 'Store name' : 'Receipt line';
  const why = hasArabicScript(text)
    ? 'it contains Persian/Arabic script and the printer does not declare Arabic shaping support'
    : 'it contains unsupported characters';
  return `${label} was not printed because ${why}: ${text}`;
}

export function itemNameWidth(cols: number, amtLen: number): number {
  return Math.max(1, cols - 4 - amtLen);
}

export function itemAmountWidth(
  order: { items?: Array<{ total?: number; addons?: unknown }> } | null | undefined,
  prefix: string,
  locale: string,
  trimDecimals: boolean,
  cols: number,
  fractionDigits: number = 2,
): number {
  let width = 10;
  for (const item of order?.items ?? []) {
    width = Math.max(width, formatCurrency(item.total ?? 0, prefix, locale, trimDecimals, fractionDigits).length + 1);
    for (const addon of parseAddons(item.addons)) {
      if (addon?.price) {
        width = Math.max(width, formatCurrency(addon.price, prefix, locale, trimDecimals, fractionDigits).length + 1);
      }
    }
  }
  return Math.min(width, Math.max(1, cols - 5));
}

export function itemRows(item: any, nameLen: number, amtLen: number, cols: number, prefix: string, locale: string = 'en-US', trimDecimals: boolean = false, _language: string = 'en', fractionDigits: number = 2, capabilities?: ThermalPrinterCapabilities): string[] {
  const qtyW = 4;
  const productName = normalizeThermalText(item.product_name, capabilities);
  const amount = formatCurrency(item.total, prefix, locale, trimDecimals, fractionDigits);
  const qty = String(item.quantity).padEnd(qtyW);
  const maxLine1Name = Math.max(1, nameLen - 1);

  if (productName.length <= maxLine1Name) {
    const label = productName.padEnd(nameLen) + qty;
    return [label + rightAlign(amount, cols - label.length)];
  }

  const nameLines = wrapText(productName, maxLine1Name);
  const firstLineName = (nameLines[0] || '').padEnd(nameLen);
  const firstRowLabel = firstLineName + qty;
  const firstRow = firstRowLabel + rightAlign(amount, cols - firstRowLabel.length);

  const result = [firstRow];
  for (let i = 1; i < nameLines.length; i++) {
    result.push(nameLines[i]);
  }
  return result;
}

export function addonRows(addon: any, nameLen: number, amtLen: number, cols: number, prefix: string, locale: string = 'en-US', trimDecimals: boolean = false, _language: string = 'en', fractionDigits: number = 2, capabilities?: ThermalPrinterCapabilities): string[] {
  const addonName = normalizeThermalText(addon.name, capabilities);
  const quantity = typeof addon.quantity === 'number' && addon.quantity > 1 ? ` x${addon.quantity}` : '';
  const fullName = '  + ' + addonName + quantity;

  if (!addon.price) {
    const lines = wrapText(fullName, cols);
    return lines.map((l) => l + ' '.repeat(Math.max(0, cols - l.length)));
  }

  const price = formatCurrency(addon.price, prefix, locale, trimDecimals, fractionDigits);

  if (fullName.length <= nameLen) {
    const label = fullName.padEnd(nameLen);
    return [label + rightAlign(price, cols - label.length)];
  }

  const nameLines = wrapText(fullName, nameLen);
  const firstLine = (nameLines[0] || '').padEnd(nameLen);
  const firstRow = firstLine + rightAlign(price, cols - firstLine.length);

  const result = [firstRow];
  for (let i = 1; i < nameLines.length; i++) {
    result.push('    ' + nameLines[i]);
  }
  return result;
}

export function financialRows(label: string, value: string, cols: number, _language: string = 'en', capabilities?: ThermalPrinterCapabilities): string[] {
  const normalizedLabel = normalizeThermalText(label, capabilities);
  const safeLabel = capabilities?.raster.enabled === true && !isThermalTextRepresentable(normalizedLabel, capabilities)
    ? normalizedLabel
    : normalizedLabel.slice(0, Math.max(1, cols - 1));
  const inlineWidth = Math.max(1, cols - safeLabel.length - 1);
  if (value.length <= inlineWidth) {
    return [safeLabel + rightAlign(value, cols - safeLabel.length)];
  }
  return [safeLabel, ...wrapValue(value, cols)];
}

function wrapValue(value: string, cols: number): string[] {
  const width = Math.max(1, cols);
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(value.slice(offset, offset + width));
  }
  return lines.length > 0 ? lines : [''];
}

export function parseAddons(addons: any): any[] {
  return Array.isArray(addons) ? addons : [];
}

function getSafeLatnLocale(locale: string | undefined): string {
  if (!locale) return 'en-US-u-nu-latn';
  if (/-nu-[a-z0-9]+/i.test(locale)) {
    return locale.replace(/-nu-[a-z0-9]+/i, '-nu-latn');
  }
  if (locale.includes('-u-')) {
    return `${locale}-nu-latn`;
  }
  return `${locale}-u-nu-latn`;
}

export function formatCurrency(amount: number, prefix: string, locale: string = 'en-US', trimDecimals: boolean = false, fractionDigits: number = 2): string {
  const numeric = Number(amount) || 0;
  const factor = 10 ** fractionDigits;
  const hasDecimals = Math.round(numeric * factor) % factor !== 0;
  const safeLocale = getSafeLatnLocale(locale);
  const formattedNum = numeric.toLocaleString(safeLocale, {
    minimumFractionDigits: trimDecimals && !hasDecimals ? 0 : fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).replace(/[\u00A0\u202F]/g, ' ');
  return prefix + formattedNum;
}

export function rightAlign(text: string, width: number = 24): string {
  return ' '.repeat(Math.max(1, width - text.length)) + text;
}

export function truncate(text: string, length: number, _language: string = 'en', capabilities?: ThermalPrinterCapabilities): string {
  const normalizedText = normalizeThermalText(text, capabilities);
  if (capabilities?.raster.enabled === true && !isThermalTextRepresentable(normalizedText, capabilities)) return normalizedText;
  return normalizedText.length > length ? normalizedText.substring(0, length - 2) + '..' : normalizedText;
}

export function truncateShapedLine(text: string, length: number, arabicShaping: boolean, language: string = 'en', capabilities?: ThermalPrinterCapabilities): string {
  const normalizedText = normalizeThermalText(text, capabilities);
  return arabicShaping && hasArabicScript(normalizedText) ? truncate(normalizedText, Math.max(1, length), language, capabilities) : normalizedText;
}

export function normalizePrintLanguage(language?: string): string {
  return language && isGeneratedPrintLanguage(language) ? language : 'en';
}

export function wrapText(text: string, cols: number): string[] {
  return wrapToDisplayCells(text, cols);
}

export function pushWrapped(lines: string[], text: string, cols: number, _language: string = 'en', capabilities?: ThermalPrinterCapabilities): void {
  const normalized = normalizeThermalText(text, capabilities);
  if (capabilities?.raster.enabled === true && !isThermalTextRepresentable(normalized, capabilities)) {
    lines.push(normalized);
    return;
  }
  for (const line of wrapText(normalized, cols)) lines.push(line);
}

export function pushCenteredWrapped(lines: string[], text: string, cols: number, _language: string = 'en', capabilities?: ThermalPrinterCapabilities): void {
  const normalized = normalizeThermalText(text, capabilities);
  if (capabilities?.raster.enabled === true && !isThermalTextRepresentable(normalized, capabilities)) {
    lines.push('{CENTER}' + normalized + '{/CENTER}');
    return;
  }
  for (const line of wrapText(normalized, cols)) lines.push('{CENTER}' + line + '{/CENTER}');
}

export function appendPoweredByFooter(lines: string[], cols: number = 48): void {
  lines.push('', '');
  for (const line of wrapText(RECEIPT_BRANDING, cols)) {
    lines.push('{CENTER}{FONT_B}' + line + '{/FONT_B}{/CENTER}');
  }
}

export function normalizeThermalText(text: string, capabilities: ThermalPrinterCapabilities = GENERIC_THERMAL_CAPABILITIES): string {
  if (capabilities.raster.enabled === true && !isThermalTextRepresentable(text, capabilities)) return text;
  return normalizeThermalTextByCapabilities(text, capabilities);
}

export function maskPhoneOnReceipt(phone: string): string {
  if (!phone || phone.length < 4) return phone;
  return 'x'.repeat(phone.length - 4) + phone.slice(-4);
}

export function resolveCurrencyPrefix(symbol: string, useUnicode: boolean, capabilities?: ThermalPrinterCapabilities, preserveConfiguredSymbol = false, currencyCode?: string): string {
  const normalizedSymbol = preserveConfiguredSymbol ? symbol : (symbol === 'ریال' ? 'IRR' : symbol);
  if (preserveConfiguredSymbol) return normalizedSymbol;
  const isAsciiSafe = /^[\x00-\x7F]+$/.test(normalizedSymbol);
  const normalizedForCapabilities = capabilities
    ? normalizeThermalTextByCapabilities(normalizedSymbol, capabilities)
    : normalizedSymbol;
  const fallbackCurrency = currencyCode || normalizedSymbol.slice(0, 3).toUpperCase() || 'Rs';
  const mappedFallback = normalizedSymbol === '¥' && currencyCode && currencyCode !== 'JPY'
    ? fallbackCurrency
    : (CURRENCY_ASCII_MAP[normalizedSymbol] || fallbackCurrency);
  const rawPrefix = capabilities
    ? (normalizedSymbol.trim().length > 0 && selectThermalCodePage(normalizedForCapabilities, capabilities) !== null
      ? normalizedForCapabilities
      : mappedFallback)
    : (normalizedSymbol.trim().length > 0 && (useUnicode || isAsciiSafe))
      ? normalizedSymbol
      : mappedFallback;
  const prefix = rawPrefix;
  return prefix.length >= 3 ? prefix : ' '.repeat(3 - prefix.length) + prefix;
}

export function appendCashDrawerPulse(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA])]);
}

export interface RasterLineUnit {
  readonly lineIndex: number;
  readonly lineCount?: number;
  readonly unit: RasterSemanticUnit;
}

export function buildEscPos(lines: string[], _useUnicode: boolean = false, options: { cutMode?: PrinterCutMode; arabicShaping?: boolean; columns?: number; language?: string; capabilities?: ThermalPrinterCapabilities; rasterUnits?: readonly RasterLineUnit[]; rasterFailures?: readonly { lineIndex: number; lineCount: number; financial: boolean }[]; financialLineRanges?: readonly { lineIndex: number; lineCount: number }[] } = {}, warnings?: PrintWarning[]): Buffer<ArrayBuffer> {
  const buf: number[] = [];
  const useLegacyUnicode = options.capabilities === undefined && _useUnicode;
  const capabilities = mergeThermalCapabilities(options.capabilities, options.arabicShaping);
  const hasNativeCodePage = capabilities.encoding.codePages.some((codePage) => codePage !== 'ascii');
  let activeCodePage = capabilities.encoding.preferredCodePage;
  const rasterEntries = options.rasterUnits ?? [];
  const rasterFailures = options.rasterFailures ?? [];
  const financialLineRanges = options.financialLineRanges ?? [];
  const rasterByLine = new Map<number, typeof rasterEntries[number]['unit']>();
  const rasterLineCounts = new Map<number, number>();
  const rasterRanges: Array<{ start: number; end: number }> = [];
  const failedRasterRanges: Array<{ start: number; end: number }> = [];
  for (const entry of rasterEntries) rasterLineCounts.set(entry.lineIndex, (rasterLineCounts.get(entry.lineIndex) ?? 0) + 1);
  const encodedRasterByLine = new Map<number, Uint8Array>();
  let financialRasterFailure = rasterFailures.some((failure) => failure.financial);
  let financialTextFailure = false;
  for (const entry of rasterEntries) {
    const lineCount = entry.lineCount ?? 1;
    const lineIndexValid = Number.isSafeInteger(entry.lineIndex) && entry.lineIndex >= 0
      && Number.isSafeInteger(lineCount) && lineCount > 0 && entry.lineIndex + lineCount <= lines.length;
    const financial = entry.unit.financial === true;
    const overlaps = lineIndexValid && rasterRanges.some((range) => entry.lineIndex < range.end && entry.lineIndex + lineCount > range.start);
    const bindingError = !lineIndexValid
      ? 'Raster unit line range is outside the print document'
      : (rasterLineCounts.get(entry.lineIndex) ?? 0) > 1 || overlaps
        ? 'Multiple raster units share one line index'
        : null;
    if (bindingError) {
      if (financial) financialRasterFailure = true;
      if (warnings) warnings.push({
        field: financial ? 'financial row' : 'receipt line',
        text: entry.unit.unitId,
        message: bindingError,
        kind: financial ? 'financial' : 'line',
      });
      continue;
    }
    try {
      if (!rasterCapabilityEnabled(capabilities)) throw new Error('Raster output is not enabled for this printer profile');
      encodedRasterByLine.set(entry.lineIndex, encodeRasterUnits([entry.unit], capabilities));
      rasterByLine.set(entry.lineIndex, entry.unit);
      rasterRanges.push({ start: entry.lineIndex, end: entry.lineIndex + lineCount });
    } catch (error) {
      failedRasterRanges.push({ start: entry.lineIndex, end: entry.lineIndex + lineCount });
      if (financial) financialRasterFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      if (!warnings) throw new Error(message);
      warnings.push({
        field: financial ? 'financial row' : 'receipt line',
        text: entry.unit.unitId,
        message,
        kind: financial ? 'financial' : 'line',
      });
    }
  }
  if (financialRasterFailure) return Buffer.alloc(0);

  const resetAllStyles = () => {
    buf.push(0x1B, 0x45, 0x00);
    buf.push(0x1B, 0x21, 0x00);
    buf.push(0x1B, 0x61, 0x00);
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (rasterFailures.some((failure) => Number.isSafeInteger(failure.lineIndex)
      && Number.isSafeInteger(failure.lineCount)
      && failure.lineIndex <= lineIndex
      && lineIndex < failure.lineIndex + failure.lineCount)) continue;
    if (failedRasterRanges.some((range) => range.start <= lineIndex && lineIndex < range.end)) continue;
    let line = lines[lineIndex];
    const rasterUnit = rasterByLine.get(lineIndex);
    if (rasterUnit) {
      const rasterBytes = encodedRasterByLine.get(lineIndex);
      if (rasterBytes) {
        resetAllStyles();
        buf.push(...rasterBytes);
        resetAllStyles();
      }
      continue;
    }
    if (rasterRanges.some((range) => range.start < lineIndex && lineIndex < range.end)) continue;
    if (line.includes('{INIT}')) {
      buf.push(0x1B, 0x40);
      resetAllStyles();
      if (!useLegacyUnicode && activeCodePage !== 'ascii') {
        buf.push(0x1B, 0x74, escPosCodePageId(activeCodePage));
      }
      continue;
    }

    if (line.includes('{FEED}')) {
      buf.push(0x1B, 0x64, 0x05);
      continue;
    }

    if (line.includes('{CUT}')) {
      buf.push(0x1B, 0x64, 0x05);
      if (options.cutMode === 'partial') {
        buf.push(0x1D, 0x56, 0x42, 0x00);
      } else {
        buf.push(0x1D, 0x56, 0x00);
      }
      continue;
    }

    if (!useLegacyUnicode && !hasNativeCodePage) line = normalizeCurrencyToAscii(line);
    line = normalizeThermalTextByCapabilities(line, capabilities);

    const isStoreName = line.includes('{STORE_NAME}');
    const isFinancial = line.includes('{FINANCIAL}') || financialLineRanges.some((range) => Number.isSafeInteger(range.lineIndex)
      && Number.isSafeInteger(range.lineCount)
      && range.lineIndex <= lineIndex
      && lineIndex < range.lineIndex + range.lineCount);
    line = line.replace(/\{STORE_NAME\}/g, '');
    let printableLine = line.replace(ESC_POS_CONTROL_TOKEN_RE, '');
    const lineBold = line.includes('{BOLD}');
    const lineDH = line.includes('{DOUBLE_HEIGHT}');
    let lineDW = line.includes('{DOUBLE_WIDTH}');
    const lineFontB = line.includes('{FONT_B}');
    const center = line.startsWith('{CENTER}') && line.includes('{/CENTER}');
    if (lineDW && Number.isInteger(options.columns) && (options.columns as number) > 0) {
      const styleText = printableLine.replace(CURRENCY_TOKEN_RE, '');
      const columns = options.columns as number;
      if (thermalDisplayWidth(styleText) > Math.floor(columns / 2) && thermalDisplayWidth(styleText) <= columns) {
        line = line.replace(/\{DOUBLE_WIDTH\}|\{\/DOUBLE_WIDTH\}/g, '');
        lineDW = false;
        printableLine = line.replace(ESC_POS_CONTROL_TOKEN_RE, '');
      }
    }
    const textWithoutSupportedCurrency = printableLine.replace(CURRENCY_TOKEN_RE, '');
    const selectedCodePage = selectThermalCodePage(textWithoutSupportedCurrency, capabilities);
    if (/[^\x00-\x7F]/.test(textWithoutSupportedCurrency)) {
      const arabicOnly = capabilities.shaping.arabic
        && hasArabicScript(printableLine)
        && !/[^\x00-\x7F]/.test(
          textWithoutSupportedCurrency
            .replace(ARABIC_SCRIPT_GLOBAL_RE, '')
            .replace(ARABIC_SHAPING_ALLOWED_GLOBAL_RE, '')
        );
      const codePageRepresentable = isThermalTextRepresentable(textWithoutSupportedCurrency, capabilities);
      if (!arabicOnly && !codePageRepresentable) {
        if (isFinancial) financialTextFailure = true;
        if (warnings) {
          const text = printableLine.trim();
          warnings.push({
            field: isFinancial ? 'financial row' : isStoreName ? 'store name' : 'receipt line',
            text,
            message: makeUnsupportedLineWarning(isStoreName, text),
            kind: isFinancial ? 'financial' : 'line',
          });
        }
        continue;
      }
      line = line.replace(ESCPOS_TEXT_CONTROL_RE, '');
      printableLine = line.replace(ESC_POS_CONTROL_TOKEN_RE, '');
      if (Number.isInteger(options.columns) && (options.columns as number) > 0) {
        const maxCols = lineDW ? Math.floor((options.columns as number) / 2) : (options.columns as number);
        line = truncate(printableLine, Math.max(1, maxCols), options.language, capabilities);
      }
    }

    line = line.replace(ESC_POS_CONTROL_TOKEN_RE, '');
    if (Number.isInteger(options.columns) && (options.columns as number) > 0) {
      line = fitThermalLine(line, options.columns as number, lineDW);
    }

    buf.push(0x1B, 0x61, center ? 0x01 : 0x00);

    let mode = 0;
    if (lineDH) mode |= 0x10;
    if (lineDW) mode |= 0x20;
    if (lineBold) mode |= 0x08;
    if (lineFontB) mode |= 0x01;
    buf.push(0x1B, 0x21, mode);
    if (selectedCodePage && selectedCodePage !== activeCodePage && !useLegacyUnicode) {
      buf.push(0x1B, 0x74, escPosCodePageId(selectedCodePage));
      activeCodePage = selectedCodePage;
    }

    if (lineBold) {
      buf.push(0x1B, 0x45, 0x01);
    }

    const encodedText = !useLegacyUnicode && selectedCodePage
      ? CodepageEncoder.encode(line, selectedCodePage)
      : Buffer.from(line, 'utf8');
    buf.push(...encodedText);
    buf.push(0x0A);
  }

  return financialTextFailure ? Buffer.alloc(0) : Buffer.from(buf);
}
