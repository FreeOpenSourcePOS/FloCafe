/**
 * PrintDocument v1 → compact thermal receipt renderer (#443, epic #438).
 *
 * Maps `shared/print` blocks onto the SAME ESC/POS token lines the legacy
 * compact layout (`formatCompactReceipt`) produces, byte for byte, so the
 * compact surface renders through `data → document → lines → bytes` without
 * changing printed semantics.
 *
 * Layering: this module lives in `main/` (transport token syntax + generated
 * label catalog); all SEMANTICS come from the document — no bill/order row
 * is read here beyond the caller's normalization step (`buildBillPrintData`,
 * reused from the classic pipeline).
 */

import { parseDbTimestamp } from '../db';
import { getCurrencyFractionDigits } from '../countries';
import type { PrinterCutMode } from './profiles';
import { isThermalTextRepresentable, type ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { RasterSemanticLineGroup } from '../../shared/print/raster';
import type { PrintWarning } from './thermal';
import {
  addonRows,
  appendPoweredByFooter,
  buildEscPos,
  financialRows,
  formatCurrency,
  itemAmountWidth,
  itemRows,
  itemNameWidth,
  normalizeThermalText,
  maskPhoneOnReceipt,
  pushCenteredWrapped,
  pushWrapped,
  resolveCurrencyPrefix,
  truncate,
  truncateShapedLine,
} from './thermal';
import { buildBillPrintContext, buildBillPrintData } from './document-classic';
import {
  buildBillDocument,
  getBlock,
  type BusinessHeaderBlock,
  type CustomerBlock,
  type DocumentMetaBlock,
  type ItemTableBlock,
  type MessageBlock,
  type PaymentsBlock,
  type PrintDocument,
  type SemanticLabel,
  type TaxBreakdownBlock,
  type TotalsBlock,
} from '../../shared/print';

// ---------------------------------------------------------------------------
// Document → compact ESC/POS token lines
// ---------------------------------------------------------------------------

/** Renderer options: physical/locale presentation only, no business data. */
export interface CompactDocumentRenderOptions {
  readonly columns: number;
  readonly language: string;
  readonly locale: string;
  readonly timezone?: string;
  /** Currency prefix preference (symbol + unicode mode). */
  readonly currencySymbol: string;
  readonly currency?: string;
  readonly trimDecimals: boolean;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly maskCustomerPhone?: boolean;
  readonly rasterGroups?: RasterSemanticLineGroup[];
}

function labelOf(label: SemanticLabel): string {
  return label.primary;
}

/** Literal payment methods keep the legacy capitalize fallback. */
function paymentLabel(label: SemanticLabel): string {
  return label.conceptId !== undefined ? label.primary : capitalize(label.primary);
}

function capitalize(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Column header row, composed from the document's own header labels. */
function compactItemHeader(block: ItemTableBlock, nameLen: number, amtLen: number, language: string, capabilities?: ThermalPrinterCapabilities): string {
  const qtyW = 4;
  const itemLabel = normalizeThermalText(labelOf(block.header.item), capabilities);
  const qtyLabel = normalizeThermalText(labelOf(block.header.quantity), capabilities);
  const amountLabel = normalizeThermalText(labelOf(block.header.amount), capabilities);
  const fit = (value: string, length: number): string => capabilities?.raster.enabled === true && !isThermalTextRepresentable(value, capabilities)
    ? value
    : value.slice(0, length);
  const item = fit(itemLabel, nameLen).padEnd(nameLen);
  const qty = fit(qtyLabel, qtyW).padEnd(qtyW);
  const amount = fit(amountLabel, Math.max(1, amtLen - 1));
  return item + qty + ' '.repeat(Math.max(0, amtLen - amount.length)) + amount;
}

/**
 * Map a PrintDocument onto the legacy compact token-line layout. Pure with
 * respect to business data: everything rendered comes from the document.
 */
export function renderBillDocumentToCompactLines(
  document: PrintDocument,
  options: CompactDocumentRenderOptions,
): string[] {
  const cols = options.columns;
  const lines: string[] = [];

  const header = getBlock(document, 'business-header') as BusinessHeaderBlock | undefined;
  const meta = getBlock(document, 'document-meta') as DocumentMetaBlock | undefined;
  const customer = getBlock(document, 'customer') as CustomerBlock | undefined;
  const items = getBlock(document, 'item-table') as ItemTableBlock | undefined;
  const breakdown = getBlock(document, 'tax-breakdown') as TaxBreakdownBlock | undefined;
  const totals = getBlock(document, 'totals') as TotalsBlock | undefined;
  const payments = getBlock(document, 'payments') as PaymentsBlock | undefined;
  const messages = getBlock(document, 'message') as MessageBlock | undefined;

  const prefix = resolveCurrencyPrefix(options.currencySymbol ?? '₹', options.useUnicode, options.capabilities);
  const fractionDigits = getCurrencyFractionDigits(options.currency || 'INR');
  const trimDecimals = options.trimDecimals === true;
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  const normalize = (text: string): string => normalizeThermalText(text, options.capabilities);
  const markGroup = (groupId: string, start: number): void => {
    if (options.rasterGroups && lines.length > start) options.rasterGroups.push({ groupId, lineIndex: start, lineCount: lines.length - start });
  };

  lines.push('{INIT}');

  // Reprint banner (MessageBlock).
  const messageStart = lines.length;
  if (messages?.reprintBanner) {
    lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(labelOf(messages.reprintBanner)) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  }

  // Online-order banner (#284, MessageBlock).
  if (messages?.onlineOrderBanner) {
    const banner = messages.onlineOrderBanner;
    lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(labelOf(banner.label)) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
    if (banner.platform.text) lines.push('{CENTER}' + normalize(banner.platform.text) + '{/CENTER}');
    if (banner.externalOrderId.text) lines.push('{CENTER}#' + normalize(banner.externalOrderId.text) + '{/CENTER}');
  }
  markGroup('message-pre', messageStart);

  // Business header (store name only — compact keeps contact facts in the footer).
  const headerStart = lines.length;
  if (header?.name) lines.push('{STORE_NAME}{CENTER}{BOLD}' + truncateShapedLine(header.name.text, cols, options.arabicShaping, options.language, options.capabilities) + '{/BOLD}{/CENTER}');
  markGroup('business-header', headerStart);
  lines.push(bar);

  // Document meta.
  const metaStart = lines.length;
  if (meta) {
    lines.push(normalize(labelOf(meta.billNumberLabel) + ': ' + meta.invoiceNumber.text));
    const date = parseDbTimestamp(meta.timestamp.text);
    lines.push(normalize(labelOf(meta.dateLabel) + ': ' + date.toLocaleDateString(options.locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(options.locale + '-u-nu-latn', tzOptions)));
    if (meta.table) {
      lines.push(truncateShapedLine(meta.table.label.primary.replace('{name}', meta.table.name.text), cols, options.arabicShaping, options.language, options.capabilities));
    }
  }
  markGroup('document-meta', metaStart);
  const customerStart = lines.length;
  if (customer?.name) lines.push(truncateShapedLine(labelOf(customer.nameLabel) + ': ' + customer.name.text, cols, options.arabicShaping, options.language, options.capabilities));
  if (customer?.phone) lines.push(normalize(labelOf(customer.phoneLabel) + ': ' + (options.maskCustomerPhone ? maskPhoneOnReceipt(customer.phone.text) : customer.phone.text)));
  if (options.rasterGroups && lines.length > customerStart) options.rasterGroups.push({ groupId: 'customer', lineIndex: customerStart, lineCount: lines.length - customerStart });
  lines.push(dash);

  // Item table.
  if (items) {
    const amtLen = itemAmountWidth(
      { items: items.rows.map((row) => ({ total: row.amount, addons: row.addons.map((addon) => ({ price: addon.price })) })) },
      prefix,
      options.locale,
      trimDecimals,
      cols,
      fractionDigits,
    );
    const nameLen = itemNameWidth(cols, amtLen);
    lines.push(compactItemHeader(items, nameLen, amtLen, options.language, options.capabilities));
    lines.push(dash);

    for (const [rowIndex, row] of items.rows.entries()) {
      const rowStart = lines.length;
      lines.push(...itemRows(
        { product_name: row.name.text, quantity: row.quantity, total: row.amount },
        nameLen,
        amtLen,
        cols,
        prefix,
        options.locale,
        trimDecimals,
        options.language,
        fractionDigits,
        options.capabilities,
      ));
      for (const addon of row.addons) {
        lines.push(...addonRows({ name: addon.name.text, price: addon.price, quantity: addon.quantity }, nameLen, amtLen, cols, prefix, options.locale, trimDecimals, options.language, fractionDigits, options.capabilities));
      }
      if (row.specialInstructions) {
        lines.push(normalize('  ' + labelOf(items.noteLabel) + ': ' + truncate(row.specialInstructions.text, cols - 8, options.language, options.capabilities)));
      }
      if (options.rasterGroups && lines.length > rowStart) options.rasterGroups.push({ groupId: `item-table-row-${rowIndex}`, lineIndex: rowStart, lineCount: lines.length - rowStart });
    }
  }

  lines.push(dash);

  // Totals (compact has no loyalty points section).
  const totalsStart = lines.length;
  if (totals) {
    lines.push(...financialRows(labelOf(totals.subtotal.label), formatCurrency(totals.subtotal.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    if (totals.discount) {
      lines.push(...financialRows(labelOf(totals.discount.label), '-' + formatCurrency(totals.discount.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    }
    if (breakdown && breakdown.lines.length > 0) {
      for (const line of breakdown.lines) {
        const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
        const label = truncate(labelOf(line.label) + rateSuffix, cols - 12, options.language, options.capabilities);
        lines.push(...financialRows(label, formatCurrency(line.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
      }
    } else if (totals.tax) {
      lines.push(...financialRows(labelOf(totals.tax.label), formatCurrency(totals.tax.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    }
    if (totals.serviceCharge) {
      lines.push(...financialRows(labelOf(totals.serviceCharge.label), formatCurrency(totals.serviceCharge.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    }
    if (totals.deliveryCharge) {
      lines.push(...financialRows(labelOf(totals.deliveryCharge.label), formatCurrency(totals.deliveryCharge.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    }
    if (totals.packagingCharge) {
      lines.push(...financialRows(labelOf(totals.packagingCharge.label), formatCurrency(totals.packagingCharge.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    }
    lines.push(...financialRows(labelOf(totals.grandTotal.label), formatCurrency(totals.grandTotal.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities).map((line) => `{BOLD}${line}{/BOLD}`));
  }
  markGroup('totals', totalsStart);

  // Payments.
  const paymentsStart = lines.length;
  if (payments && payments.lines.length > 0) {
    lines.push(dash);
    for (const line of payments.lines) {
      const methodLabel = truncate(paymentLabel(line.label), cols - 12, options.language, options.capabilities);
      lines.push(...financialRows(methodLabel, formatCurrency(line.amount, prefix, options.locale, trimDecimals, fractionDigits), cols, options.language, options.capabilities));
    }
  }
  markGroup('payments', paymentsStart);

  // Footer contact details.
  const footerStart = lines.length;
  lines.push(bar);
  if (header?.address) pushWrapped(lines, header.address.text, cols, options.language, options.capabilities);
  if (header?.phone && header.phoneLabel) pushWrapped(lines, labelOf(header.phoneLabel) + ': ' + header.phone.text, cols, options.language, options.capabilities);
  if (header?.taxId) pushWrapped(lines, labelOf(header.taxId.label) + ': ' + header.taxId.value.text, cols, options.language, options.capabilities);
  if (messages?.footerNote) pushCenteredWrapped(lines, messages.footerNote.text, cols, options.language, options.capabilities);
  else lines.push('{CENTER}' + normalize(labelOf(messages!.thankYou!)) + '{/CENTER}');
  markGroup('footer', footerStart);
  appendPoweredByFooter(lines);
  lines.push('{CUT}');

  return lines;
}

// ---------------------------------------------------------------------------
// Entry: data → document → lines → bytes
// ---------------------------------------------------------------------------

export interface CompactDocumentRenderResult {
  readonly document: PrintDocument;
  readonly lines: string[];
  readonly data: Buffer;
  readonly warnings: PrintWarning[];
  readonly rasterGroups: readonly RasterSemanticLineGroup[];
}

/**
 * Full document-driven compact pipeline: authoritative rows → PrintData /
 * PrintContext → buildBillDocument → compact token lines → buildEscPos.
 */
export function renderCompactReceiptViaDocument(
  order: any,
  bill: any,
  business: any,
  opts: {
    columns: number;
    language: string;
    additionalLanguage?: string;
    isReprint: boolean;
    useUnicode: boolean;
    arabicShaping: boolean;
    cutMode: PrinterCutMode;
    capabilities?: import('../../shared/print/thermal-capabilities').ThermalPrinterCapabilities;
    maskCustomerPhone?: boolean;
  },
): CompactDocumentRenderResult {
  const printData = buildBillPrintData(order, bill, business, opts.isReprint);
  const printContext = buildBillPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.additionalLanguage !== undefined ? { additionalLanguage: opts.additionalLanguage } : {}),
    business,
  });
  const document = buildBillDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const lines = renderBillDocumentToCompactLines(document, {
    columns: opts.columns,
    language: printContext.languages[0],
    locale: printContext.locale,
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    currencySymbol: printContext.currencySymbol,
    currency: String(business?.currency || 'INR'),
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
    capabilities: opts.capabilities,
    maskCustomerPhone: opts.maskCustomerPhone,
    rasterGroups,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns, language: opts.language, capabilities: opts.capabilities }, warnings);
  return { document, lines, data, warnings, rasterGroups };
}
