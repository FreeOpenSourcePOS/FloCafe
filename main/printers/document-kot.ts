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
  truncate,
  truncateShapedLine,
} from './thermal';
import { detectPrintLanguageDirection } from './document-classic';
import {
  buildKotDocument,
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
  const ticketItems = Array.isArray(items) ? items : [];
  return {
    stationName: String(stationName ?? ''),
    order: {
      orderNumber: String(order?.order_number ?? ''),
      createdAt: String(order?.created_at ?? ''),
      tableName: String(order?.table?.name ?? ''),
      orderType: formatKotOrderType(order?.type),
    },
    items: ticketItems.map((item: any) => ({
      productName: String(item?.product_name ?? ''),
      quantity: Number(item?.quantity) || 0,
      addons: (Array.isArray(item?.addons) ? item.addons : []).map((addon: any) => ({
        name: String(addon?.name ?? ''),
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
}): PrintContext {
  return {
    columns: opts.columns,
    languages: [opts.language],
    baseDirection: detectPrintLanguageDirection(opts.language),
    locale: 'en-US',
    currencySymbol: '',
    trimDecimals: false,
    resolveLabel: (conceptId, language) => printLabel(language, conceptId as PrintConceptId),
  };
}

// ---------------------------------------------------------------------------
// Document → KOT ESC/POS token lines
// ---------------------------------------------------------------------------

/** Renderer options: physical/locale presentation only, no business data. */
export interface KotDocumentRenderOptions {
  readonly columns: number;
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

function formatKotOrderType(type: unknown): string {
  return String(type ?? '').replace(/_/g, ' ').trim().toUpperCase();
}

function kotHeaderLines(header: KotHeaderBlock, options: KotDocumentRenderOptions): string[] {
  const cols = options.columns;
  const lines: string[] = [];
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;

  lines.push('{INIT}');
  lines.push('{CENTER}{BOLD}' + labelOf(header.banner) + '{/BOLD}{/CENTER}');
  lines.push('');
  lines.push(truncateShapedLine(labelOf(header.stationLabel) + ': ' + header.stationName.text, cols, options.arabicShaping));
  // NOTE (#440/#441): keep this unaudited technical prefix verbatim; label
  // adoption remains outside this renderer change.
  lines.push(truncateShapedLine('Order: ' + header.orderNumber.text, cols, options.arabicShaping));
  if (header.table) {
    lines.push(truncateShapedLine(formatTableLabel(header.table.label, header.table.name.text), cols, options.arabicShaping));
  }
  if (header.orderType) {
    lines.push(truncateShapedLine(labelOf(header.orderType.label) + ': ' + header.orderType.value.text, cols, options.arabicShaping));
  }
  lines.push(labelOf(header.timeLabel) + ': ' + parseDbTimestamp(header.timestamp.text).toLocaleTimeString((options.locale ?? 'en-US') + '-u-nu-latn', tzOptions));
  return lines;
}

function kotItemLines(row: KotItemsBlock['rows'][number], cols: number, arabicShaping: boolean): string[] {
  const lines: string[] = [];
  const itemPrefix = row.quantity + 'x  ';
  lines.push('{DOUBLE_HEIGHT}{BOLD}' + itemPrefix + truncateShapedLine(row.name.text, Math.max(1, cols - itemPrefix.length), arabicShaping) + '{/BOLD}{/DOUBLE_HEIGHT}');
  for (const addon of row.addons) {
    lines.push('  + ' + truncate(addonName(addon), cols - 4));
  }
  if (row.specialInstructions) {
    lines.push('  ** ' + truncateShapedLine(row.specialInstructions.text, Math.max(1, cols - 8), arabicShaping) + ' **');
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
      lines.push(...kotItemLines(row, cols, options.arabicShaping));
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
  const printContext = buildKotPrintContext({ columns: opts.columns, language: opts.language });
  const document = buildKotDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const lines = renderKotDocumentToLines(document, {
    columns: opts.columns,
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns }, warnings);
  return { document, lines, data, warnings };
}
