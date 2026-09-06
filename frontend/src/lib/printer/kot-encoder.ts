/** Converts a Flo POS Order into a Kitchen Order Ticket (KOT) ESC/POS byte array. */
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Order } from '@/lib/types';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';
import { formatTime } from './format-date';
import { normalizeThermalText } from './unicode';
import {
  GENERIC_THERMAL_CAPABILITIES,
  mergeThermalCapabilities,
  shouldUseOrderTypeFallback,
  thermalTextFallback,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';
import { safePrinterText as writeSafePrinterText, type PrintWarning } from './warnings';
import { printLabelResolver } from './print-document';
import { isKotItemPending } from '@print/document';

export interface KotOptions {
  /** 58 mm (42 chars) or 80 mm (48 chars). Default: 58 */
  paperWidth?: 58 | 80;
  /** Kitchen station name to print on KOT */
  stationName?: string;
  /** Printer firmware performs Arabic/Persian contextual shaping. Default: false. */
  arabicShaping?: boolean;
  /** Print language resolved from the KOT language policy. */
  language?: string;
  /** Locale used for localized time formatting. */
  locale?: string;
  /** Store timezone used for business-local time formatting. */
  timezone?: string;
  /** Selected thermal text capabilities; defaults to generic ESC/POS safety. */
  capabilities?: ThermalPrinterCapabilities;
}

// Must match main/printers/profiles.ts generic-escpos-58/80 fontAColumns.
const CHARS: Record<58 | 80, number> = { 58: 42, 80: 48 };

function safePrinterTextForLanguage(language: string, columns: number, capabilities?: ThermalPrinterCapabilities) {
  return <T extends { text(value: string): T }>(
    enc: T,
    value: string,
    warnings: PrintWarning[] | undefined,
    isStoreName = false,
    arabicShaping = false,
    centerCols?: number,
    maxCols?: number,
    _language?: string,
  ): T => {
    void _language;
    return writeSafePrinterText(enc, value, warnings, isStoreName, arabicShaping, centerCols, maxCols, language, false, true, capabilities);
  };
}

/** Build a KOT byte array from an Order object with items populated. */
export function buildKotBytes(
  order: Order,
  opts: KotOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const { paperWidth = 58, arabicShaping = false, language = 'en' } = opts;
  const cols = CHARS[paperWidth];
  const label = (key: string): string => printLabelResolver(key, language);
  const locale = opts.locale ?? LANGUAGES[language as Language]?.locale ?? 'en-US';
  const safePrinterText = safePrinterTextForLanguage(language, cols, opts.capabilities);
  const truncateText = (text: string, max: number): string => truncate(text, max, opts.capabilities);
  const thermalCapabilities = mergeThermalCapabilities(opts.capabilities, arabicShaping);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  // ── KOT Header ───────────────────────────────────────────────────────────────
  enc.initialize();

  // KOT Banner
  const bannerText = thermalSafeHeaderText(label('print.kot.banner'), 'KITCHEN ORDER TICKET', language, arabicShaping, opts.capabilities);
  const bannerWidth = bannerText.length * 2 <= cols ? 2 : 1;
  enc.align('center').bold(true).width(bannerWidth).height(2);
  safePrinterText(enc, bannerText, warnings, false, arabicShaping, undefined, cols, language).width(1).height(1).bold(false).newline();

  // Order details
  enc.align('left').bold(true);
  if (opts.stationName) {
    const stationName = String(opts.stationName);
    safePrinterText(enc, thermalSafeHeaderText(`${label('print.kot.station')}: ${stationName}`, `Station: ${thermalSafeMetadataValue(stationName, language, arabicShaping, opts.capabilities)}`, language, arabicShaping, opts.capabilities), warnings, false, arabicShaping, undefined, cols, language).newline();
  }
  const orderNumber = String(order.order_number);
  safePrinterText(enc, thermalSafeHeaderText(formatOrderNumber(label('pos.orderNumber'), orderNumber), `Order #${thermalSafeMetadataValue(orderNumber, language, arabicShaping, opts.capabilities)}`, language, arabicShaping, opts.capabilities), warnings, false, arabicShaping, undefined, cols, language).newline();

  if (order.table) {
    const tableName = String(order.table.name);
    safePrinterText(enc, thermalSafeHeaderText(label('pos.tableLabel').replace('{name}', tableName), `Table: ${thermalSafeMetadataValue(tableName, language, arabicShaping, opts.capabilities)}`, language, arabicShaping, opts.capabilities), warnings, false, arabicShaping, undefined, cols, language).newline();
  }

  const orderType = resolveOrderType(order.type, language);
  const localizedOrderType = `${label('print.kot.type')}: ${orderType}`;
  const fallbackOrderType = `Type: ${String(order.type).replace(/_/g, ' ').toUpperCase()}`;
  const thermalOrderType = shouldUseOrderTypeFallback(localizedOrderType, thermalCapabilities)
    ? fallbackOrderType
    : thermalSafeHeaderText(localizedOrderType, fallbackOrderType, language, arabicShaping, opts.capabilities);
  safePrinterText(enc, thermalOrderType, warnings, false, arabicShaping, undefined, cols, language).newline();

  if (order.customer) {
    const customerName = String(order.customer.name);
    safePrinterText(enc, thermalSafeHeaderText(`${label('pos.customer')}: ${customerName}`, `Customer: ${thermalSafeMetadataValue(customerName, language, arabicShaping, opts.capabilities)}`, language, arabicShaping, opts.capabilities), warnings, false, arabicShaping, undefined, cols, language).newline();
  }

  enc.bold(false);
  const time = formatTime(order.created_at, locale, opts.timezone ? { timeZone: opts.timezone } : undefined);
  const fallbackTime = formatTime(order.created_at, 'en-US', opts.timezone ? { timeZone: opts.timezone } : undefined);
  safePrinterText(enc, thermalSafeHeaderText(`${label('print.time')}: ${time}`, `Time: ${fallbackTime}`, language, arabicShaping, opts.capabilities), warnings, false, arabicShaping, undefined, cols, language).newline();
  thermalRule(enc, 'double', cols, thermalCapabilities);

  // ── Items ────────────────────────────────────────────────────────────────────
  const items = order.items ?? [];
  let hasItems = false;

  for (const item of items) {
    // Skip items that are already served or ready.
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
  thermalRule(enc, 'single', cols, thermalCapabilities);
  enc.align('center');
  safePrinterText(enc, `--- ${label('print.kot.end')} ---`, warnings, false, arabicShaping, undefined, cols, language).newline();

  enc.newline().newline().newline().cut();

  return enc.encode();
}

function thermalRule(
  enc: ReceiptPrinterEncoder,
  style: 'single' | 'double',
  columns: number,
  capabilities: ThermalPrinterCapabilities,
): void {
  const character = style === 'double' ? '═' : '─';
  if (capabilities.shaping.arabic && capabilities.encoding.codePages.every((codePage) => codePage === 'ascii')) {
    (enc as ReceiptPrinterEncoder & { raw: (data: Uint8Array) => ReceiptPrinterEncoder })
      .raw(new TextEncoder().encode(character.repeat(columns))).newline();
    return;
  }
  enc.rule({ style });
}

// Helpers
function truncate(str: string, max: number, capabilities?: ThermalPrinterCapabilities): string {
  const normalized = normalizeThermalText(str, capabilities);
  return normalized.length > max ? normalized.slice(0, max - 1) + '…' : normalized;
}

// Fallback label when thermal capabilities cannot represent metadata.
const UNSUPPORTED_METADATA_PLACEHOLDER = '[UNSUPPORTED]';

function thermalSafeMetadataValue(value: string, language: string, arabicShaping: boolean, capabilities?: ThermalPrinterCapabilities): string {
  return thermalSafeHeaderText(value, UNSUPPORTED_METADATA_PLACEHOLDER, language, arabicShaping, capabilities);
}

function thermalSafeHeaderText(value: string, fallback: string, language: string, arabicShaping: boolean, capabilities?: ThermalPrinterCapabilities): string {
  return thermalTextFallback(value, fallback, mergeThermalCapabilities(capabilities ?? GENERIC_THERMAL_CAPABILITIES, arabicShaping));
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
