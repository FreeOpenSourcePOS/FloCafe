/**
 * PrintDocument v1 → kitchen order ticket renderer (#443, epic #438).
 *
 * Maps a `buildKotDocument` KOT document onto the SAME ESC/POS token lines
 * the legacy `formatKOT` layout produces, so kitchen tickets flow through
 * `data → document → lines → bytes` without changing printed semantics.
 *
 * Layering: this module lives in `main/` (transport token syntax + generated
 * label catalog); all SEMANTICS come from the document — no order row is
 * read here beyond the caller's normalization step. The KOT language policy
 * is single-primary (kernel `kot_language_policy`) and is resolved by the
 * caller before reaching this renderer.
 */

import { parseDbTimestamp } from '../db';
import { printLabel, type PrintConceptId } from '../print/print-labels.generated';
import type { PrinterCutMode } from './profiles';
import type { PrintWarning } from './thermal';
import {
  buildEscPos,
  normalizeGermanThermalText,
  truncate,
  truncateShapedLine,
} from './thermal';
import { detectPrintLanguageDirection } from './document-classic';
import {
  buildKotDocument,
  isKotItemPending,
  type DirectionalText,
  type KotDocument,
  type KotDocumentBlock,
  type KotHeaderBlock,
  type KotItemsBlock,
  type KotPrintData,
  type PrintContext,
  type SemanticLabel,
} from '../../shared/print';

// ---------------------------------------------------------------------------
// Normalization (caller-side, main-process layer)
// ---------------------------------------------------------------------------

/**
 * Normalize raw order/items/station rows into an authoritative KOT snapshot.
 * This is the ONLY step allowed to touch raw rows so the builder stays pure.
 */
export function buildKotPrintData(order: any, items: any[], stationName: string): KotPrintData {
  const ticketItems = Array.isArray(items)
    ? items.filter((item: any) => isKotItemPending(item?.status))
    : [];
  return {
    stationName: String(stationName ?? ''),
    order: {
      orderNumber: String(order?.order_number ?? ''),
      createdAt: String(order?.created_at ?? ''),
      tableName: String(order?.table?.name ?? ''),
      orderType: String(order?.type ?? '').trim(),
      customerName: String(order?.customer?.name ?? order?.customer_name ?? '').trim(),
    },
    items: ticketItems.map((item: any) => ({
      productName: String(item?.product_name ?? ''),
      quantity: Number(item?.quantity) || 0,
      addons: (Array.isArray(item?.addons) ? item.addons : []).map((addon: any) => ({
        name: String(addon?.name ?? ''),
        ...(typeof addon?.quantity === 'number' && Number.isFinite(addon.quantity) && addon.quantity > 0
          ? { quantity: addon.quantity }
          : {}),
      })),
      specialInstructions: String(item?.special_instructions ?? ''),
    })),
  };
}

/**
 * Build the PrintContext for a kitchen ticket. The language arrives already
 * resolved from `kot_language_policy` through the kernel by the caller.
 */
export function buildKotPrintContext(opts: {
  columns: number;
  /** KOT label language (already resolved from the kitchen policy). */
  language: string;
  /** Store timezone for business-local ticket time formatting. */
  timezone?: string;
}): PrintContext {
  return {
    columns: opts.columns,
    languages: [opts.language],
    baseDirection: detectPrintLanguageDirection(opts.language),
    locale: 'en-US',
    currencySymbol: '',
    trimDecimals: false,
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
    resolveLabel: (conceptId, language) => printLabel(language, conceptId as PrintConceptId),
  };
}

// ---------------------------------------------------------------------------
// Document → KOT ESC/POS token lines
// ---------------------------------------------------------------------------

/** Renderer options: physical/locale presentation only, no business data. */
export interface KotDocumentRenderOptions {
  readonly columns: number;
  readonly language: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
}

/** Typed accessor for one block kind within a KOT document. */
function kotBlock<K extends KotDocumentBlock['kind']>(
  document: KotDocument,
  kind: K,
): Extract<KotDocumentBlock, { kind: K }> | undefined {
  return document.blocks.find((block): block is Extract<KotDocumentBlock, { kind: K }> => block.kind === kind);
}

function labelOf(label: SemanticLabel): string {
  return label.primary;
}

/** Interpolate the ICU {name} placeholder of pos.tableLabel inline (#440). */
function formatTableLabel(label: SemanticLabel, tableName: string): string {
  return labelOf(label).replace('{name}', tableName);
}

// Header metadata must stay visible on generic ESC/POS. Keep the localized
// value when the selected capability can represent it; otherwise use the
// existing ASCII labels rather than silently losing ticket identity.
const UNSUPPORTED_METADATA_PLACEHOLDER = '[UNSUPPORTED]';
const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_SCRIPT_GLOBAL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_SHAPING_ALLOWED_GLOBAL_RE = /[\u200C\u200D\u200F\u2026]/g;

function isArabicShapingSafeLine(value: string): boolean {
  if (!ARABIC_SCRIPT_RE.test(value)) return false;
  return !/[^\x00-\x7F]/.test(
    value.replace(ARABIC_SCRIPT_GLOBAL_RE, '').replace(ARABIC_SHAPING_ALLOWED_GLOBAL_RE, ''),
  );
}

function thermalSafeText(value: string, fallback: string, language: string, arabicShaping: boolean): string {
  const normalized = language === 'de' ? normalizeGermanThermalText(value) : value;
  const shapingSafe = arabicShaping && isArabicShapingSafeLine(normalized);
  return /[^\x00-\x7F]/.test(normalized) && !shapingSafe ? fallback : normalized;
}

function thermalSafeMetadataValue(value: string, language: string, arabicShaping: boolean): string {
  return thermalSafeText(value, UNSUPPORTED_METADATA_PLACEHOLDER, language, arabicShaping);
}

function formatOrderNumberLabel(label: SemanticLabel, orderNumber: string, language: string, arabicShaping: boolean): string {
  const localized = labelOf(label).replace('{number}', orderNumber);
  const fallbackOrderNumber = thermalSafeMetadataValue(orderNumber, language, arabicShaping);
  return thermalSafeText(localized, `Order #${fallbackOrderNumber}`, language, arabicShaping);
}

function kotHeaderLines(header: KotHeaderBlock, options: KotDocumentRenderOptions): string[] {
  const cols = options.columns;
  const lines: string[] = [];
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;

  lines.push('{INIT}');
  const banner = thermalSafeText(labelOf(header.banner), 'KITCHEN ORDER TICKET', options.language, options.arabicShaping);
  const station = thermalSafeText(
    `${labelOf(header.stationLabel)}: ${header.stationName.text}`,
    `Station: ${thermalSafeMetadataValue(header.stationName.text, options.language, options.arabicShaping)}`,
    options.language,
    options.arabicShaping,
  );
  const table = header.table
    ? thermalSafeText(
      formatTableLabel(header.table.label, header.table.name.text),
      `Table: ${thermalSafeMetadataValue(header.table.name.text, options.language, options.arabicShaping)}`,
      options.language,
      options.arabicShaping,
    )
    : null;
  const orderType = header.orderType
    ? thermalSafeText(
      `${labelOf(header.orderType.label)}: ${header.orderType.value.text}`,
      `Type: ${header.orderType.code.replace(/_/g, ' ').trim().toUpperCase()}`,
      options.language,
      options.arabicShaping,
    )
    : null;
  const time = parseDbTimestamp(header.timestamp.text).toLocaleTimeString((options.locale ?? 'en-US') + '-u-nu-latn', tzOptions);
  const timeLine = thermalSafeText(
    `${labelOf(header.timeLabel)}: ${time}`,
    `Time: ${parseDbTimestamp(header.timestamp.text).toLocaleTimeString('en-US-u-nu-latn', tzOptions)}`,
    options.language,
    options.arabicShaping,
  );

  lines.push('{CENTER}{BOLD}' + truncateShapedLine(banner, cols, options.arabicShaping, options.language) + '{/BOLD}{/CENTER}');
  lines.push('');
  lines.push(truncateShapedLine(station, cols, options.arabicShaping, options.language));
  lines.push(truncateShapedLine(formatOrderNumberLabel(header.orderNumberLabel, header.orderNumber.text, options.language, options.arabicShaping), cols, options.arabicShaping, options.language));
  if (table) lines.push(truncateShapedLine(table, cols, options.arabicShaping, options.language));
  if (orderType) lines.push(truncateShapedLine(orderType, cols, options.arabicShaping, options.language));
  if (header.customer) {
    const customer = thermalSafeText(
      `${labelOf(header.customer.label)}: ${header.customer.name.text}`,
      `Customer: ${thermalSafeMetadataValue(header.customer.name.text, options.language, options.arabicShaping)}`,
      options.language,
      options.arabicShaping,
    );
    lines.push(truncateShapedLine(customer, cols, options.arabicShaping, options.language));
  }
  lines.push(truncateShapedLine(timeLine, cols, options.arabicShaping, options.language));
  return lines;
}

function kotItemLines(row: KotItemsBlock['rows'][number], cols: number, arabicShaping: boolean, language: string): string[] {
  const lines: string[] = [];
  const itemPrefix = row.quantity + 'x  ';
  lines.push('{DOUBLE_HEIGHT}{BOLD}' + itemPrefix + truncateShapedLine(row.name.text, Math.max(1, cols - itemPrefix.length), arabicShaping, language) + '{/BOLD}{/DOUBLE_HEIGHT}');
  for (const addon of row.addons) {
    const quantity = addon.quantity ?? 1;
    const quantitySuffix = quantity > 1 ? ` x${quantity}` : '';
    const name = truncate(addonName(addon), Math.max(1, cols - 4 - quantitySuffix.length), language);
    lines.push('  + ' + name + quantitySuffix);
  }
  if (row.specialInstructions) {
    lines.push('  >> ' + truncateShapedLine(row.specialInstructions.text, Math.max(1, cols - 8), arabicShaping, language));
  }
  return lines;
}

function addonName(addon: DirectionalText): string {
  return addon.text;
}

/**
 * Map a KotDocument onto the legacy KOT token-line layout. Pure with
 * respect to business data: everything rendered comes from the document.
 */
export function renderKotDocumentToLines(document: KotDocument, options: KotDocumentRenderOptions): string[] {
  const lines: string[] = [];

  const header = kotBlock(document, 'kot-header');
  const items = kotBlock(document, 'kot-items');
  const cols = options.columns;
  const bar = '='.repeat(cols);

  if (header) lines.push(...kotHeaderLines(header, options));
  lines.push(bar);
  lines.push('');

  if (items) {
    for (const row of items.rows) {
      lines.push(...kotItemLines(row, cols, options.arabicShaping, options.language));
    }
  }

  lines.push('');
  lines.push(bar);
  lines.push('{CUT}');

  return lines;
}

// ---------------------------------------------------------------------------
// Entry: data → document → lines → bytes
// ---------------------------------------------------------------------------

export interface KotDocumentRenderResult {
  readonly document: KotDocument;
  readonly lines: string[];
  readonly data: Buffer;
  readonly warnings: PrintWarning[];
}

/**
 * Full document-driven KOT pipeline: authoritative rows → KotPrintData /
 * PrintContext → buildKotDocument → KOT token lines → buildEscPos.
 */
export function renderKotViaDocument(
  order: any,
  items: any[],
  stationName: string,
  opts: {
    columns: number;
    /** KOT label language, resolved from `kot_language_policy` by the caller. */
    language: string;
    locale?: string;
    timezone?: string;
    useUnicode: boolean;
    arabicShaping: boolean;
    cutMode: PrinterCutMode;
  },
): KotDocumentRenderResult {
  const printData = buildKotPrintData(order, items, stationName);
  const printContext = buildKotPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
  });
  const document = buildKotDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const lines = renderKotDocumentToLines(document, {
    columns: opts.columns,
    language: opts.language,
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns, language: opts.language }, warnings);
  return { document, lines, data, warnings };
}
