/** Converts a Flo POS Order into a Kitchen Order Ticket (KOT) ESC/POS byte array. */
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Order } from '@/lib/types';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';
import { columnsForReceiptPaperSize, displayCellWidth, truncateToDisplayCells } from '@print/width';
import {
  configureEncoderTextSize,
  layoutColumnsForTextSize,
  normalizePrinterTextSize,
} from '@print/text-size';
import { formatTime } from './format-date';
import { normalizeThermalText } from './unicode';
import {
  GENERIC_THERMAL_CAPABILITIES,
  isThermalTextRepresentable,
  mergeThermalCapabilities,
  shouldUseOrderTypeFallback,
  thermalTextFallback,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';
import {
  safePrinterText as writeSafePrinterText,
  wrapPrinterText,
  type PrintWarning,
} from './warnings';
import { printLabelResolver } from './print-document';
import { isKotItemPending } from '@print/document';
import { formatItemHeading } from './item-heading';

export interface KotOptions {
  /** 58 mm (32 cols) or 80 mm (42 cols). Default: 58 */
  paperWidth?: 58 | 80;
  /** Exact column count the configured printer declares; overrides `paperWidth`. */
  columns?: number;
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

// Paper-size fallback only. Callers that know the configured printer pass
// `columns`; the number itself lives in `columnsForReceiptPaperSize`.
const CHARS: Record<58 | 80, number> = {
  58: columnsForReceiptPaperSize(58),
  80: columnsForReceiptPaperSize(80),
};

function safePrinterTextForLanguage(
  language: string,
  columns: number,
  capabilities?: ThermalPrinterCapabilities,
) {
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
    return writeSafePrinterText(
      enc,
      value,
      warnings,
      isStoreName,
      arabicShaping,
      centerCols,
      maxCols,
      language,
      false,
      true,
      capabilities,
    );
  };
}

/** Build a KOT byte array from an Order object with items populated. */
export function buildKotBytes(
  order: Order,
  opts: KotOptions = {},
  warnings?: PrintWarning[],
): Uint8Array {
  const { paperWidth = 58, arabicShaping = false, language = 'en' } = opts;
  const textSize = normalizePrinterTextSize(opts.capabilities?.textSize);
  const physicalCols = opts.columns ?? CHARS[paperWidth];
  const cols = layoutColumnsForTextSize(physicalCols, textSize);
  const label = (key: string): string => printLabelResolver(key, language);
  const locale = opts.locale ?? LANGUAGES[language as Language]?.locale ?? 'en-US';
  const safePrinterText = safePrinterTextForLanguage(language, cols, opts.capabilities);
  const truncateText = (text: string, max: number): string =>
    truncate(text, max, opts.capabilities);
  const thermalCapabilities = mergeThermalCapabilities(opts.capabilities, arabicShaping);

  const enc = new ReceiptPrinterEncoder({ columns: physicalCols });

  const writeKotHeaderText = (
    value: string,
    fallback: string,
    options?: { isBanner?: boolean },
  ): void => {
    const printableFallback = thermalSafeHeaderText(
      value,
      fallback,
      language,
      arabicShaping,
      opts.capabilities,
    );
    if (
      thermalCapabilities.raster.enabled === true &&
      !isThermalTextRepresentable(value, thermalCapabilities)
    ) {
      if (options?.isBanner) {
        const bannerWidth = displayCellWidth(value) * 2 <= cols ? 2 : 1;
        enc.width(bannerWidth).height(2);
      }
      const attemptWarnings: PrintWarning[] = [];
      safePrinterText(
        enc,
        value,
        attemptWarnings,
        false,
        arabicShaping,
        options?.isBanner ? cols : undefined,
        cols,
        language,
      );
      if (attemptWarnings.length === 0) {
        enc.newline();
        return;
      }
      warnings?.push(...attemptWarnings);
    }
    if (options?.isBanner) {
      const bannerWidth = displayCellWidth(printableFallback) * 2 <= cols ? 2 : 1;
      enc.width(bannerWidth).height(2);
    }
    safePrinterText(
      enc,
      printableFallback,
      warnings,
      false,
      arabicShaping,
      undefined,
      cols,
      language,
    ).newline();
  };

  // ── KOT Header ───────────────────────────────────────────────────────────────
  enc.initialize();
  configureEncoderTextSize(enc, textSize);

  // KOT Banner
  enc.align('center').bold(true);
  writeKotHeaderText(label('print.kot.banner'), 'KITCHEN ORDER TICKET', { isBanner: true });
  enc.width(1).height(1).bold(false);

  // Order details
  enc.align('left').bold(true);
  if (opts.stationName) {
    const stationName = String(opts.stationName);
    writeKotHeaderText(
      `${label('print.kot.station')}: ${stationName}`,
      `Station: ${thermalSafeMetadataValue(stationName, language, arabicShaping, opts.capabilities)}`,
    );
  }
  const orderNumber = String(order.order_number);
  writeKotHeaderText(
    formatOrderNumber(label('pos.orderNumber'), orderNumber),
    `Order #${thermalSafeMetadataValue(orderNumber, language, arabicShaping, opts.capabilities)}`,
  );

  if (order.table) {
    const tableName = String(order.table.name);
    writeKotHeaderText(
      label('pos.tableLabel').replace('{name}', tableName),
      `Table: ${thermalSafeMetadataValue(tableName, language, arabicShaping, opts.capabilities)}`,
    );
  }

  const orderType = resolveOrderType(order.type, language);
  const localizedOrderType = `${label('print.kot.type')}: ${orderType}`;
  const fallbackOrderType = `Type: ${String(order.type).replace(/_/g, ' ').toUpperCase()}`;
  if (shouldUseOrderTypeFallback(localizedOrderType, thermalCapabilities)) {
    safePrinterText(
      enc,
      fallbackOrderType,
      warnings,
      false,
      arabicShaping,
      undefined,
      cols,
      language,
    ).newline();
  } else {
    writeKotHeaderText(localizedOrderType, fallbackOrderType);
  }

  if (order.customer) {
    const customerName = String(order.customer.name);
    writeKotHeaderText(
      `${label('pos.customer')}: ${customerName}`,
      `Customer: ${thermalSafeMetadataValue(customerName, language, arabicShaping, opts.capabilities)}`,
    );
  }

  enc.bold(false);
  const time = formatTime(
    order.created_at,
    locale,
    opts.timezone ? { timeZone: opts.timezone } : undefined,
  );
  const fallbackTime = formatTime(
    order.created_at,
    'en-US',
    opts.timezone ? { timeZone: opts.timezone } : undefined,
  );
  writeKotHeaderText(`${label('print.time')}: ${time}`, `Time: ${fallbackTime}`);

  const orderShape = order as Order & {
    order_notes?: unknown;
    orderNotes?: unknown;
    notes?: unknown;
  };
  const orderNotes =
    [order.special_instructions, orderShape.order_notes, orderShape.orderNotes, orderShape.notes]
      .find((val): val is string => typeof val === 'string' && val.trim().length > 0)
      ?.trim() ?? '';
  if (orderNotes) {
    const noteLabel = thermalSafeHeaderText(
      label('print.note'),
      'Note',
      language,
      arabicShaping,
      opts.capabilities,
    );
    const wrapped = wrapPrinterText(
      normalizeThermalText(`${noteLabel}: ${orderNotes}`, thermalCapabilities),
      Math.max(1, cols - 6),
    );
    enc.newline();
    enc.bold(true).height(2);
    wrapped.forEach((line, index) => {
      safePrinterText(
        enc,
        (index === 0 ? '!! ' : '   ') + line,
        warnings,
        false,
        arabicShaping,
        undefined,
        cols,
        language,
      ).newline();
    });
    enc.height(1).bold(false);
  }

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
    const itemPrefix = `${item.quantity}x `;
    const itemIndent = ' '.repeat(displayCellWidth(itemPrefix));
    const itemHeading = formatItemHeading(item.product_name, item.variant_selection);
    const normalizedHeading = normalizeThermalText(itemHeading, thermalCapabilities);
    enc.bold(true);
    if (
      arabicShaping &&
      /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(normalizedHeading)
    ) {
      safePrinterText(
        enc,
        truncateText(`${itemPrefix}${itemHeading}`, cols),
        warnings,
        false,
        arabicShaping,
        undefined,
        undefined,
        language,
      ).newline();
    } else {
      const wrappedHeading = wrapPrinterText(
        normalizedHeading,
        Math.max(1, cols - displayCellWidth(itemPrefix)),
      );
      wrappedHeading.forEach((line, index) => {
        safePrinterText(
          enc,
          `${index === 0 ? itemPrefix : itemIndent}${line}`,
          warnings,
          false,
          arabicShaping,
          undefined,
          undefined,
          language,
        ).newline();
      });
    }
    enc.bold(false);

    // Addons can come from older/API paths as a JSON string. Normalize before
    // iterating so a stored string cannot abort KOT printing.
    const addons = parseAddons(item.addons);
    if (addons.length > 0) {
      for (const addon of addons) {
        if (addon.name) {
          const qty =
            'quantity' in addon && typeof addon.quantity === 'number' ? addon.quantity : 1;
          const quantitySuffix = qty > 1 ? ` x${qty}` : '';
          const addonName = truncateText(
            addon.name,
            Math.max(1, cols - 5 - displayCellWidth(quantitySuffix)),
          );
          safePrinterText(
            enc,
            `   + ${addonName}${quantitySuffix}`,
            warnings,
            false,
            arabicShaping,
            undefined,
            undefined,
            language,
          ).newline();
        }
      }
    }

    // Special instructions
    if (item.special_instructions) {
      const normalizedComment = normalizeThermalText(
        item.special_instructions,
        thermalCapabilities,
      );
      if (
        arabicShaping &&
        /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(
          normalizedComment,
        )
      ) {
        safePrinterText(
          enc,
          `   >> ${truncateText(item.special_instructions, cols - 6)}`,
          warnings,
          false,
          arabicShaping,
          undefined,
          undefined,
          language,
        ).newline();
      } else {
        const wrappedComment = wrapPrinterText(normalizedComment, Math.max(1, cols - 6));
        wrappedComment.forEach((line, index) => {
          safePrinterText(
            enc,
            `${index === 0 ? '   >> ' : '      '}${line}`,
            warnings,
            false,
            arabicShaping,
            undefined,
            undefined,
            language,
          ).newline();
        });
      }
    }

    enc.newline();
  }

  if (!hasItems) {
    safePrinterText(
      enc,
      `(${label('print.kot.noPendingItems')})`,
      warnings,
      false,
      arabicShaping,
      undefined,
      cols,
      language,
    ).newline();
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  thermalRule(enc, 'single', cols, thermalCapabilities);
  enc.align('center');
  safePrinterText(
    enc,
    `--- ${label('print.kot.end')} ---`,
    warnings,
    false,
    arabicShaping,
    undefined,
    cols,
    language,
  ).newline();

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
  if (
    capabilities.shaping.arabic &&
    capabilities.encoding.codePages.every((codePage) => codePage === 'ascii')
  ) {
    (enc as ReceiptPrinterEncoder & { raw: (data: Uint8Array) => ReceiptPrinterEncoder })
      .raw(new TextEncoder().encode(character.repeat(columns)))
      .newline();
    return;
  }
  enc.rule({ style });
}

// Helpers
function truncate(str: string, max: number, capabilities?: ThermalPrinterCapabilities): string {
  const normalized = normalizeThermalText(str, capabilities);
  return displayCellWidth(normalized) > max
    ? truncateToDisplayCells(normalized, Math.max(1, max - 1)) + '…'
    : normalized;
}

// Fallback label when thermal capabilities cannot represent metadata.
const UNSUPPORTED_METADATA_PLACEHOLDER = '[UNSUPPORTED]';

function thermalSafeMetadataValue(
  value: string,
  language: string,
  arabicShaping: boolean,
  capabilities?: ThermalPrinterCapabilities,
): string {
  return thermalSafeHeaderText(
    value,
    UNSUPPORTED_METADATA_PLACEHOLDER,
    language,
    arabicShaping,
    capabilities,
  );
}

function thermalSafeHeaderText(
  value: string,
  fallback: string,
  language: string,
  arabicShaping: boolean,
  capabilities?: ThermalPrinterCapabilities,
): string {
  const merged = mergeThermalCapabilities(
    capabilities ?? GENERIC_THERMAL_CAPABILITIES,
    arabicShaping,
  );
  return thermalTextFallback(value, fallback, merged);
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
