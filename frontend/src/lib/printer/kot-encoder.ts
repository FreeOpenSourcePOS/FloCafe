/**
 * kot-encoder.ts
 *
 * Converts a Flo POS Order into a Kitchen Order Ticket (KOT) ESC/POS byte array.
 * KOTs are printed in the kitchen to show what items need to be prepared.
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Order } from '@/lib/types';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';
import { formatTime } from './format-date';
import { normalizeGermanThermalText } from './unicode';
import { hasUnsupportedPrinterChars, isArabicShapingSafeLine, safePrinterText as writeSafePrinterText, type PrintWarning } from './warnings';
import { printLabelResolver } from './print-document';
import { isKotItemPending } from '@print/document';

export interface KotOptions {
  /** 58 mm (42 chars) or 80 mm (48 chars). Default: 58 */
  paperWidth?: 58 | 80;
  /** Kitchen station name to print on KOT */
  stationName?: string;
  /**
   * Printer firmware performs Arabic/Persian contextual shaping (#437).
   * Lets pure ASCII+Arabic lines through the unsupported-character guard.
   * Default: false.
   */
  arabicShaping?: boolean;
  /** Print language resolved from the KOT language policy. */
  language?: string;
  /** Locale used for localized time formatting. */
  locale?: string;
  /** Store timezone used for business-local time formatting. */
  timezone?: string;
}

// Must match main/printers/profiles.ts generic-escpos-58/80 fontAColumns.
const CHARS: Record<58 | 80, number> = { 58: 42, 80: 48 };

function safePrinterTextForLanguage(language: string, columns: number) {
  return <T extends { text(value: string): T }>(
    enc: T,
    value: string,
    warnings: PrintWarning[] | undefined,
    isStoreName = false,
    arabicShaping = false,
    centerCols?: number,
    maxCols?: number,
    _language?: string,
  ): T => writeSafePrinterText(enc, value, warnings, isStoreName, arabicShaping, centerCols, language === 'de' ? maxCols ?? centerCols ?? columns : maxCols, language);
}

/**
 * Build a KOT byte array from an Order object.
 * The Order must have `items` populated.
 */
export function buildKotBytes(
  order: Order,
  opts: KotOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const { paperWidth = 58, arabicShaping = false, language = 'en' } = opts;
  const cols = CHARS[paperWidth];
  const label = (key: string): string => printLabelResolver(key, language);
  const locale = opts.locale ?? LANGUAGES[language as Language]?.locale ?? 'en-US';
  const safePrinterText = safePrinterTextForLanguage(language, cols);
  const truncateText = (text: string, max: number): string => truncate(text, max, language);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  // ── KOT Header ───────────────────────────────────────────────────────────────
  enc.initialize();

  // KOT Banner
  const bannerText = thermalSafeHeaderText(label('print.kot.banner'), 'KITCHEN ORDER TICKET', language, arabicShaping);
  const bannerWidth = bannerText.length * 2 <= cols ? 2 : 1;
  enc.align('center').bold(true).width(bannerWidth).height(2);
  safePrinterText(enc, bannerText, warnings, false, arabicShaping, undefined, cols, language).width(1).height(1).bold(false).newline();

  // Order details
  enc.align('left').bold(true);
  if (opts.stationName) {
    const stationName = String(opts.stationName);
    safePrinterText(enc, thermalSafeHeaderText(`${label('print.kot.station')}: ${stationName}`, `Station: ${thermalSafeMetadataValue(stationName, language, arabicShaping)}`, language, arabicShaping), warnings, false, arabicShaping, undefined, cols, language).newline();
  }
  const orderNumber = String(order.order_number);
  safePrinterText(enc, thermalSafeHeaderText(formatOrderNumber(label('pos.orderNumber'), orderNumber), `Order #${thermalSafeMetadataValue(orderNumber, language, arabicShaping)}`, language, arabicShaping), warnings, false, arabicShaping, undefined, cols, language).newline();

  if (order.table) {
    const tableName = String(order.table.name);
    safePrinterText(enc, thermalSafeHeaderText(label('pos.tableLabel').replace('{name}', tableName), `Table: ${thermalSafeMetadataValue(tableName, language, arabicShaping)}`, language, arabicShaping), warnings, false, arabicShaping, undefined, cols, language).newline();
  }

  const orderType = resolveOrderType(order.type, language);
  safePrinterText(enc, thermalSafeHeaderText(`${label('print.kot.type')}: ${orderType}`, `Type: ${String(order.type).replace(/_/g, ' ').toUpperCase()}`, language, arabicShaping), warnings, false, arabicShaping, undefined, cols, language).newline();

  if (order.customer) {
    const customerName = String(order.customer.name);
    safePrinterText(enc, thermalSafeHeaderText(`${label('pos.customer')}: ${customerName}`, `Customer: ${thermalSafeMetadataValue(customerName, language, arabicShaping)}`, language, arabicShaping), warnings, false, arabicShaping, undefined, cols, language).newline();
  }

  enc.bold(false);
  const time = formatTime(order.created_at, locale, opts.timezone ? { timeZone: opts.timezone } : undefined);
  const fallbackTime = formatTime(order.created_at, 'en-US', opts.timezone ? { timeZone: opts.timezone } : undefined);
  safePrinterText(enc, thermalSafeHeaderText(`${label('print.time')}: ${time}`, `Time: ${fallbackTime}`, language, arabicShaping), warnings, false, arabicShaping, undefined, cols, language).newline();
  enc.rule({ style: 'double' });

  // ── Items ────────────────────────────────────────────────────────────────────
  const items = order.items ?? [];
  let hasItems = false;

  for (const item of items) {
    // Skip items that are already served/completed
    if (!isKotItemPending(item.status)) {
      continue;
    }

    hasItems = true;

    // Item name with quantity
    const qtyName = `${item.quantity}x ${item.product_name}`;
    enc.bold(true);
    safePrinterText(enc, truncateText(qtyName, cols), warnings, false, arabicShaping, undefined, undefined, language).newline();
    enc.bold(false);

    // Addons can come from older/API paths as a JSON string. Normalize before
    // iterating so a stored string cannot abort KOT printing.
    const addons = parseAddons(item.addons);
    if (addons.length > 0) {
      for (const addon of addons) {
        if (addon.name) {
          const qty = ('quantity' in addon && typeof addon.quantity === 'number') ? addon.quantity : 1;
          const quantitySuffix = qty > 1 ? ` x${qty}` : '';
          const addonName = truncateText(addon.name, Math.max(1, cols - 5 - quantitySuffix.length));
          safePrinterText(enc, `   + ${addonName}${quantitySuffix}`, warnings, false, arabicShaping, undefined, undefined, language).newline();
        }
      }
    }

    // Special instructions
    if (item.special_instructions) {
      safePrinterText(enc, `   >> ${truncateText(item.special_instructions, cols - 6)}`, warnings, false, arabicShaping, undefined, undefined, language).newline();
    }

    enc.newline();
  }

  if (!hasItems) {
    safePrinterText(enc, `(${label('print.kot.noPendingItems')})`, warnings, false, arabicShaping, undefined, cols, language).newline();
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  enc.rule({ style: 'single' });
  enc.align('center');
  safePrinterText(enc, `--- ${label('print.kot.end')} ---`, warnings, false, arabicShaping, undefined, cols, language).newline();

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number, language: string = 'en'): string {
  const normalized = language === 'de' ? normalizeGermanThermalText(str) : str;
  return normalized.length > max ? normalized.slice(0, max - 1) + '…' : normalized;
}

// Keep nonfinancial KOT identity visible when generic ESC/POS cannot
// represent a localized header label; item text still follows safePrinterText.
const UNSUPPORTED_METADATA_PLACEHOLDER = '[UNSUPPORTED]';

function thermalSafeMetadataValue(value: string, language: string, arabicShaping: boolean): string {
  return thermalSafeHeaderText(value, UNSUPPORTED_METADATA_PLACEHOLDER, language, arabicShaping);
}

function thermalSafeHeaderText(value: string, fallback: string, language: string, arabicShaping: boolean): string {
  const normalized = language === 'de' ? normalizeGermanThermalText(value) : value;
  const shapingSafe = arabicShaping && isArabicShapingSafeLine(normalized);
  return hasUnsupportedPrinterChars(normalized) && !shapingSafe ? fallback : normalized;
}

function resolveOrderType(type: string, language: string): string {
  const keys: Record<string, string> = {
    dine_in: 'pos.orderTypeDineIn',
    delivery: 'pos.orderTypeDelivery',
    online: 'pos.orderTypeOnline',
    takeaway: 'pos.orderTypeTakeaway',
  };
  const key = keys[type];
  if (!key) return String(type).replace(/_/g, ' ').toUpperCase();
  return printLabelResolver(key, language);
}

function formatOrderNumber(label: string, orderNumber: string): string {
  return label.replace('{number}', orderNumber);
}

function parseAddons(addons: unknown): Array<{ name: string; quantity?: number }> {
  if (!addons) return [];
  if (typeof addons === 'string') {
    try {
      const parsed = JSON.parse(addons);
      return Array.isArray(parsed) ? parsed.filter(hasAddonName) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(addons) ? addons.filter(hasAddonName) : [];
}

function hasAddonName(addon: unknown): addon is { name: string } {
  return (
    typeof addon === 'object' &&
    addon !== null &&
    typeof (addon as { name?: unknown }).name === 'string'
  );
}
